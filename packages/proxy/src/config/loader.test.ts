import { describe, it, expect, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { loadConfig, ConfigError, interpolateEnvVars } from './loader.js'

// ---------------------------------------------------------------------------
// interpolateEnvVars
// ---------------------------------------------------------------------------

describe('interpolateEnvVars', () => {
  const env = { MY_TOKEN: 'secret-123', HOST: 'example.com', PORT: '8080' }

  it('replaces a single variable in a string', () => {
    expect(interpolateEnvVars('token: ${MY_TOKEN}', env)).toBe('token: secret-123')
  })

  it('replaces multiple variables in one string', () => {
    expect(interpolateEnvVars('https://${HOST}:${PORT}/path', env)).toBe(
      'https://example.com:8080/path',
    )
  })

  it('walks nested objects', () => {
    const input = { a: { b: { c: '${MY_TOKEN}' } } }
    const result = interpolateEnvVars(input, env)
    expect(result).toEqual({ a: { b: { c: 'secret-123' } } })
  })

  it('walks arrays', () => {
    const input = ['${MY_TOKEN}', '${HOST}']
    const result = interpolateEnvVars(input, env)
    expect(result).toEqual(['secret-123', 'example.com'])
  })

  it('leaves non-string values unchanged', () => {
    expect(interpolateEnvVars(42, env)).toBe(42)
    expect(interpolateEnvVars(true, env)).toBe(true)
    expect(interpolateEnvVars(null, env)).toBe(null)
  })

  it('throws ConfigError for missing env var', () => {
    expect(() => interpolateEnvVars('${MISSING_VAR}', env)).toThrow(ConfigError)
    expect(() => interpolateEnvVars('${MISSING_VAR}', env)).toThrow(
      'Environment variable "MISSING_VAR" is not set',
    )
  })

  it('returns strings without variables unchanged', () => {
    expect(interpolateEnvVars('no variables here', env)).toBe('no variables here')
  })
})

// ---------------------------------------------------------------------------
// loadConfig — file-based tests using temp directory
// ---------------------------------------------------------------------------

describe('loadConfig', () => {
  let tmpDir: string

  async function writeTempYaml(filename: string, content: string): Promise<string> {
    tmpDir = await mkdtemp(join(tmpdir(), 'helio-test-'))
    const filePath = join(tmpDir, filename)
    await writeFile(filePath, content, 'utf-8')
    return filePath
  }

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('loads a valid minimal config', async () => {
    const yaml = `
version: "1"
upstream:
  url: "http://localhost:8080"
dashboard:
  enabled: false
`
    const filePath = await writeTempYaml('helio.yaml', yaml)
    const config = await loadConfig(filePath)

    expect(config.version).toBe('1')
    expect(config.upstream.url).toBe('http://localhost:8080')
    expect(config.upstream.transport).toBe('streamable-http')
    expect(config.listen.port).toBe(3000)
    expect(config.policies.default).toBe('allow')
  })

  it('loads a config with env var interpolation', async () => {
    const yaml = `
version: "1"
upstream:
  url: "http://localhost:8080"
dashboard:
  enabled: false
approval:
  channels:
    - type: slack
      bot_token: "\${SLACK_TOKEN}"
      signing_secret: "\${SLACK_SIGNING_SECRET}"
      channel: "#approvals"
`
    const filePath = await writeTempYaml('helio.yaml', yaml)
    const config = await loadConfig(filePath, {
      SLACK_TOKEN: 'xoxb-test-token',
      SLACK_SIGNING_SECRET: 'test-signing-secret',
    })

    expect(config.approval.channels[0]).toEqual({
      type: 'slack',
      bot_token: 'xoxb-test-token',
      signing_secret: 'test-signing-secret',
      channel: '#approvals',
    })
  })

  it('throws ConfigError for non-existent file', async () => {
    await expect(loadConfig('/tmp/nonexistent-helio.yaml')).rejects.toThrow(ConfigError)
    await expect(loadConfig('/tmp/nonexistent-helio.yaml')).rejects.toThrow(
      'Cannot read config file',
    )
  })

  it('throws ConfigError for invalid YAML syntax', async () => {
    const yaml = `
version: "1"
upstream:
  url: "http://localhost:8080"
  bad_indent:
    - [invalid yaml {{
`
    const filePath = await writeTempYaml('bad.yaml', yaml)
    await expect(loadConfig(filePath)).rejects.toThrow(ConfigError)
    await expect(loadConfig(filePath)).rejects.toThrow('YAML parse error')
  })

  it('throws ConfigError with details for schema validation errors', async () => {
    const yaml = `
version: "2"
upstream:
  transport: sse
`
    const filePath = await writeTempYaml('invalid.yaml', yaml)

    try {
      await loadConfig(filePath)
      expect.fail('Should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError)
      const configErr = err as ConfigError
      const details = configErr.details ?? []
      expect(details.length).toBeGreaterThan(0)

      // Should report version error
      const paths = details.map((d) => d.path)
      expect(paths).toContain('version')
    }
  })

  it('throws ConfigError for missing env var during interpolation', async () => {
    const yaml = `
version: "1"
upstream:
  url: "http://localhost:8080"
approval:
  channels:
    - type: slack
      bot_token: "\${UNDEFINED_TOKEN}"
      signing_secret: "some-secret"
      channel: "#approvals"
`
    const filePath = await writeTempYaml('env.yaml', yaml)
    await expect(loadConfig(filePath, {})).rejects.toThrow(ConfigError)
    await expect(loadConfig(filePath, {})).rejects.toThrow('UNDEFINED_TOKEN')
  })

  it('collects multiple validation errors', async () => {
    const yaml = `
upstream:
  transport: sse
`
    const filePath = await writeTempYaml('multi-error.yaml', yaml)

    try {
      await loadConfig(filePath)
      expect.fail('Should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError)
      const configErr = err as ConfigError
      const details = configErr.details ?? []
      expect(details.length).toBeGreaterThanOrEqual(2)
      expect(configErr.message).toMatch(/\d+ errors/)
    }
  })

  it('loads a full complex config', async () => {
    const yaml = `
version: "1"
upstream:
  url: "http://localhost:8080/mcp"
  transport: sse
listen:
  port: 4000
  host: "0.0.0.0"
dashboard:
  enabled: true
  port: 4100
  api_secret: "full-complex-test-secret"
policies:
  default: deny
  rules:
    - match:
        tool: "read_*"
      action: allow
    - name: approve-writes
      match:
        tool: "write_*"
        annotations:
          destructiveHint: true
      action: require_approval
      approval:
        channel: slack
        timeout: "600s"
      feedback:
        message: "Write operations require approval."
approval:
  timeout: "600s"
  default_on_timeout: deny
  channels:
    - type: slack
      bot_token: "xoxb-test"
      signing_secret: "signing-secret"
      channel: "#approvals"
    - type: dashboard
audit:
  storage: sqlite
  path: "/data/helio.db"
  retention: "365d"
  include_responses: false
sdk:
  enabled: true
  port: 4200
`
    const filePath = await writeTempYaml('full.yaml', yaml)
    const config = await loadConfig(filePath)

    expect(config.listen.port).toBe(4000)
    expect(config.policies.default).toBe('deny')
    expect(config.policies.rules).toHaveLength(2)
    expect(config.policies.rules[0]?.action).toBe('allow')
    expect(config.policies.rules[1]?.name).toBe('approve-writes')
    expect(config.approval.timeout).toBe('600s')
    expect(config.audit.retention).toBe('365d')
    expect(config.sdk.enabled).toBe(true)
  })

  // -------------------------------------------------------------------------
  // dashboard.api_secret is mandatory when require_approval is used
  // -------------------------------------------------------------------------

  describe('api_secret enforcement', () => {
    it('rejects a config with flag_destructive: require_approval and no secret', async () => {
      const yaml = `
version: "1"
upstream:
  url: "http://localhost:8080/mcp"
policies:
  flag_destructive: require_approval
`
      const filePath = await writeTempYaml('no-secret-flag.yaml', yaml)

      try {
        await loadConfig(filePath)
        expect.fail('Should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError)
        const details = (err as ConfigError).details ?? []
        const paths = details.map((d) => d.path)
        expect(paths).toContain('dashboard.api_secret')
        const msg = details.find((d) => d.path === 'dashboard.api_secret')?.message ?? ''
        expect(msg).toContain('openssl rand -hex 32')
      }
    })

    it('rejects a config with a require_approval rule and no secret', async () => {
      const yaml = `
version: "1"
upstream:
  url: "http://localhost:8080/mcp"
policies:
  rules:
    - name: approve-writes
      match:
        tool: "write_*"
      action: require_approval
      approval:
        channel: dashboard
`
      const filePath = await writeTempYaml('no-secret-rule.yaml', yaml)

      try {
        await loadConfig(filePath)
        expect.fail('Should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError)
        const details = (err as ConfigError).details ?? []
        const paths = details.map((d) => d.path)
        expect(paths).toContain('dashboard.api_secret')
      }
    })

    it('accepts a require_approval rule when dashboard.api_secret is set', async () => {
      const yaml = `
version: "1"
upstream:
  url: "http://localhost:8080/mcp"
dashboard:
  api_secret: "test-secret"
policies:
  rules:
    - match:
        tool: "write_*"
      action: require_approval
      approval:
        channel: dashboard
`
      const filePath = await writeTempYaml('has-dashboard-secret.yaml', yaml)
      const config = await loadConfig(filePath)
      expect(config.dashboard.api_secret).toBe('test-secret')
    })

    it('rejects approval.api_secret — the legacy alias was removed', async () => {
      const yaml = `
version: "1"
upstream:
  url: "http://localhost:8080/mcp"
approval:
  api_secret: "should-be-rejected"
policies:
  rules:
    - match:
        tool: "write_*"
      action: require_approval
      approval:
        channel: dashboard
`
      const filePath = await writeTempYaml('legacy-alias.yaml', yaml)

      try {
        await loadConfig(filePath)
        expect.fail('Should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError)
        const paths = ((err as ConfigError).details ?? []).map((d) => d.path)
        expect(paths).toContain('dashboard.api_secret')
      }
    })

    it('rejects an empty-string dashboard.api_secret as missing', async () => {
      const yaml = `
version: "1"
upstream:
  url: "http://localhost:8080/mcp"
dashboard:
  api_secret: ""
policies:
  flag_destructive: require_approval
`
      const filePath = await writeTempYaml('empty-secret.yaml', yaml)

      await expect(loadConfig(filePath)).rejects.toThrow(ConfigError)
    })

    it('rejects a config without any approval features and no secret unless open mode is explicit', async () => {
      const yaml = `
version: "1"
upstream:
  url: "http://localhost:8080/mcp"
policies:
  default: allow
  rules:
    - match:
        tool: "read_*"
      action: allow
`
      const filePath = await writeTempYaml('no-approval-no-secret.yaml', yaml)
      await expect(loadConfig(filePath)).rejects.toThrow(ConfigError)
    })

    it('accepts explicit local open mode without secret', async () => {
      const yaml = `
version: "1"
upstream:
  url: "http://localhost:8080/mcp"
dashboard:
  allow_open_mode: true
  host: "127.0.0.1"
policies:
  default: allow
`
      const filePath = await writeTempYaml('explicit-open-mode.yaml', yaml)
      const config = await loadConfig(filePath)
      expect(config.dashboard.allow_open_mode).toBe(true)
      expect(config.dashboard.api_secret).toBeUndefined()
    })

    it('rejects explicit open mode on non-loopback dashboard host', async () => {
      const yaml = `
version: "1"
upstream:
  url: "http://localhost:8080/mcp"
dashboard:
  allow_open_mode: true
  host: "0.0.0.0"
`
      const filePath = await writeTempYaml('explicit-open-mode-public-host.yaml', yaml)
      await expect(loadConfig(filePath)).rejects.toThrow(ConfigError)
    })
  })

  // -------------------------------------------------------------------------
  // limiter rules must be fully configured (fail-closed validation)
  // -------------------------------------------------------------------------

  describe('limiter config enforcement', () => {
    it('rejects rate_limit rule missing limits.max_calls', async () => {
      const yaml = `
version: "1"
upstream:
  url: "http://localhost:8080/mcp"
policies:
  rules:
    - match:
        tool: "search_*"
      action: rate_limit
      limits:
        window: "1m"
`
      const filePath = await writeTempYaml('missing-rate-max-calls.yaml', yaml)

      try {
        await loadConfig(filePath)
        expect.fail('Should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError)
        const paths = ((err as ConfigError).details ?? []).map((d) => d.path)
        expect(paths).toContain('policies.rules.0.limits.max_calls')
      }
    })

    it('rejects spend_limit rule missing limits.max_spend', async () => {
      const yaml = `
version: "1"
upstream:
  url: "http://localhost:8080/mcp"
policies:
  rules:
    - match:
        tool: "create_payment"
      action: spend_limit
      limits:
        key: session
`
      const filePath = await writeTempYaml('missing-spend-max-spend.yaml', yaml)

      try {
        await loadConfig(filePath)
        expect.fail('Should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError)
        const paths = ((err as ConfigError).details ?? []).map((d) => d.path)
        expect(paths).toContain('policies.rules.0.limits.max_spend')
      }
    })
  })
})
