import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { ConfigWatcher } from './watcher.js'
import { ConfigError, loadConfig } from './loader.js'
import type { CompiledPolicy, PolicyParseWarning } from '../policy/types.js'
import { GovernedForwarder } from '../policy/governed-forwarder.js'
import { RateLimiter } from '../policy/rate-limiter.js'
import { SpendLimiter } from '../policy/spend-limiter.js'
import { compilePolicies } from '../policy/parser.js'
import type { McpForwarder, McpRequest, ForwardResult, McpResponse } from '../mcp/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid helio.yaml content. */
function validConfig(overrides: { rules?: string; flagDestructive?: string } = {}): string {
  return `
version: "1"
upstream:
  url: "http://localhost:8080/mcp"
dashboard:
  enabled: false
policies:
  default: allow
${overrides.flagDestructive ? `  flag_destructive: ${overrides.flagDestructive}` : ''}
  rules:
${overrides.rules ?? '    []'}
`
}

/** A config with one deny rule. */
function configWithDenyRule(): string {
  return validConfig({
    rules: `
    - name: block-delete
      match:
        tool: "delete_*"
      action: deny`,
  })
}

/** Wait for a specified number of milliseconds. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ConfigWatcher', () => {
  let tmpDir: string
  let configPath: string
  let watcher: ConfigWatcher | null

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'helio-watcher-'))
    configPath = join(tmpDir, 'helio.yaml')
    watcher = null
  })

  afterEach(() => {
    if (watcher) watcher.close()
  })

  // -------------------------------------------------------------------------
  // Successful reload
  // -------------------------------------------------------------------------

  it('calls onPolicyReload when config file changes', async () => {
    // Start with a basic config
    await writeFile(configPath, validConfig())
    const initialConfig = await loadConfig(configPath)

    const reloads: Array<{ policy: CompiledPolicy; warnings: readonly PolicyParseWarning[] }> = []
    const restartRequiredPaths: string[][] = []

    watcher = new ConfigWatcher({
      configPath,
      initialConfig,
      onPolicyReload: (policy, warnings, paths) => {
        reloads.push({ policy, warnings })
        restartRequiredPaths.push([...paths])
      },
      onError: () => {},
      debounceMs: 50,
    })
    watcher.start()

    // Wait for watcher to settle
    await wait(100)

    // Modify the config — add a rule
    await writeFile(configPath, configWithDenyRule())

    // Wait for debounce + reload
    await wait(500)

    expect(reloads).toHaveLength(1)
    expect(reloads[0]?.policy.rules).toHaveLength(1)
    expect(reloads[0]?.policy.rules[0]?.name).toBe('block-delete')
    expect(reloads[0]?.policy.rules[0]?.action).toBe('deny')
    expect(restartRequiredPaths).toEqual([[]])
  })

  it('reloads with updated flag_destructive setting', async () => {
    await writeFile(configPath, validConfig())

    const reloads: CompiledPolicy[] = []

    watcher = new ConfigWatcher({
      configPath,
      onPolicyReload: (policy) => reloads.push(policy),
      onError: () => {},
      debounceMs: 50,
    })
    watcher.start()
    await wait(100)

    // Change config to enable flag_destructive
    await writeFile(configPath, validConfig({ flagDestructive: 'log' }))
    await wait(500)

    expect(reloads).toHaveLength(1)
    expect(reloads[0]?.flagDestructive).toBe('log')
  })

  // -------------------------------------------------------------------------
  // Invalid config keeps old policy
  // -------------------------------------------------------------------------

  it('calls onError and keeps old policy when config is invalid YAML', async () => {
    await writeFile(configPath, validConfig())

    const reloads: CompiledPolicy[] = []
    const errors: Error[] = []

    watcher = new ConfigWatcher({
      configPath,
      onPolicyReload: (policy) => reloads.push(policy),
      onError: (err) => errors.push(err),
      debounceMs: 50,
    })
    watcher.start()
    await wait(100)

    // Overwrite with invalid content (missing required fields)
    await writeFile(configPath, 'this: is not a valid helio config')
    await wait(500)

    expect(reloads).toHaveLength(0)
    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toBeTruthy()
  })

  it('calls onError when policy has invalid regex', async () => {
    await writeFile(configPath, validConfig())

    const reloads: CompiledPolicy[] = []
    const errors: Error[] = []

    watcher = new ConfigWatcher({
      configPath,
      onPolicyReload: (policy) => reloads.push(policy),
      onError: (err) => errors.push(err),
      debounceMs: 50,
    })
    watcher.start()
    await wait(100)

    // Write a config with an invalid regex in a rule
    await writeFile(
      configPath,
      `
version: "1"
upstream:
  url: "http://localhost:8080/mcp"
dashboard:
  enabled: false
policies:
  default: allow
  rules:
    - match:
        input:
          "$.name":
            regex: "[invalid("
      action: deny
`,
    )
    await wait(500)

    expect(reloads).toHaveLength(0)
    expect(errors).toHaveLength(1)
  })

  // -------------------------------------------------------------------------
  // Debouncing
  // -------------------------------------------------------------------------

  it('debounces rapid file changes', async () => {
    await writeFile(configPath, validConfig())

    const reloads: CompiledPolicy[] = []

    watcher = new ConfigWatcher({
      configPath,
      onPolicyReload: (policy) => reloads.push(policy),
      onError: () => {},
      debounceMs: 200,
    })
    watcher.start()
    await wait(100)

    // Write multiple times in rapid succession
    await writeFile(configPath, validConfig())
    await wait(20)
    await writeFile(configPath, validConfig())
    await wait(20)
    await writeFile(configPath, configWithDenyRule())

    // Wait for debounce to settle
    await wait(600)

    // Should only have reloaded once (with the final config)
    expect(reloads).toHaveLength(1)
    expect(reloads[0]?.rules).toHaveLength(1)
  })

  // -------------------------------------------------------------------------
  // close() stops watching
  // -------------------------------------------------------------------------

  it('stops watching after close()', async () => {
    await writeFile(configPath, validConfig())

    const reloads: CompiledPolicy[] = []

    watcher = new ConfigWatcher({
      configPath,
      onPolicyReload: (policy) => reloads.push(policy),
      onError: () => {},
      debounceMs: 50,
    })
    watcher.start()
    await wait(100)

    // Close the watcher
    watcher.close()
    watcher = null

    // Modify the file after closing
    await writeFile(configPath, configWithDenyRule())
    await wait(500)

    // No reload should have occurred
    expect(reloads).toHaveLength(0)
  })

  it('start() is idempotent — calling twice does not create duplicate watchers', async () => {
    await writeFile(configPath, validConfig())

    const reloads: CompiledPolicy[] = []

    watcher = new ConfigWatcher({
      configPath,
      onPolicyReload: (policy) => reloads.push(policy),
      onError: () => {},
      debounceMs: 50,
    })
    watcher.start()
    watcher.start() // Second call should be a no-op
    await wait(100)

    await writeFile(configPath, configWithDenyRule())
    await wait(500)

    // Should only reload once (not twice from two watchers)
    expect(reloads).toHaveLength(1)
  })

  it('close() is idempotent — calling twice does not throw', () => {
    watcher = new ConfigWatcher({
      configPath,
      onPolicyReload: () => {},
      onError: () => {},
    })
    watcher.start()
    watcher.close()
    const w = watcher
    expect(() => {
      w.close()
    }).not.toThrow()
    watcher = null
  })

  // -------------------------------------------------------------------------
  // Recovery after error
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // api_secret enforcement on hot-reload
  // -------------------------------------------------------------------------

  it('calls onError when hot-reload drops api_secret while require_approval is in use', async () => {
    // Initial: valid config with require_approval rule + api_secret
    const initialYaml = `
version: "1"
upstream:
  url: "http://localhost:8080/mcp"
dashboard:
  api_secret: "initial-secret"
policies:
  default: allow
  rules:
    - name: approve-writes
      match:
        tool: "write_*"
      action: require_approval
      approval:
        channel: dashboard
`
    await writeFile(configPath, initialYaml)

    const reloads: CompiledPolicy[] = []
    const errors: Error[] = []

    watcher = new ConfigWatcher({
      configPath,
      onPolicyReload: (policy) => reloads.push(policy),
      onError: (err) => errors.push(err),
      debounceMs: 50,
    })
    watcher.start()
    await wait(100)

    // Hot-reload: drop the api_secret while keeping require_approval
    const brokenYaml = `
version: "1"
upstream:
  url: "http://localhost:8080/mcp"
dashboard:
  enabled: false
policies:
  default: allow
  rules:
    - name: approve-writes
      match:
        tool: "write_*"
      action: require_approval
      approval:
        channel: dashboard
`
    await writeFile(configPath, brokenYaml)
    await wait(500)

    expect(reloads).toHaveLength(0)
    expect(errors).toHaveLength(1)
    const err = errors[0]
    expect(err).toBeInstanceOf(ConfigError)
    const details = (err as ConfigError).details ?? []
    expect(details.map((d) => d.path)).toContain('dashboard.api_secret')
  })

  it('calls onError when hot-reload adds match.environment without top-level environment', async () => {
    const initialYaml = `
version: "1"
upstream:
  url: "http://localhost:8080/mcp"
environment: "production"
policies:
  default: allow
  rules:
    - name: deny-prod-payments
      match:
        tool: "create_payment"
        environment: "production"
      action: deny
`
    await writeFile(configPath, initialYaml)

    const reloads: CompiledPolicy[] = []
    const errors: Error[] = []

    watcher = new ConfigWatcher({
      configPath,
      onPolicyReload: (policy) => reloads.push(policy),
      onError: (err) => errors.push(err),
      debounceMs: 50,
    })
    watcher.start()
    await wait(100)

    const brokenYaml = `
version: "1"
upstream:
  url: "http://localhost:8080/mcp"
dashboard:
  enabled: false
policies:
  default: allow
  rules:
    - name: deny-prod-payments
      match:
        tool: "create_payment"
        environment: "production"
      action: deny
`
    await writeFile(configPath, brokenYaml)
    await wait(500)

    expect(reloads).toHaveLength(0)
    expect(errors).toHaveLength(1)
    const err = errors[0]
    expect(err).toBeInstanceOf(ConfigError)
    const details = (err as ConfigError).details ?? []
    expect(details.map((d) => d.path)).toContain('policies.rules.0.match.environment')
  })

  it('reports restart-required paths when non-reloadable fields change', async () => {
    await writeFile(configPath, validConfig())
    const initialConfig = await loadConfig(configPath)

    const reloads: CompiledPolicy[] = []
    const restartRequiredPaths: string[][] = []

    watcher = new ConfigWatcher({
      configPath,
      initialConfig,
      onPolicyReload: (policy, _warnings, paths) => {
        reloads.push(policy)
        restartRequiredPaths.push([...paths])
      },
      onError: () => {},
      debounceMs: 50,
    })
    watcher.start()
    await wait(100)

    await writeFile(
      configPath,
      `
version: "1"
upstream:
  url: "http://localhost:8080/mcp"
dashboard:
  enabled: false
listen:
  port: 3010
  host: "127.0.0.1"
policies:
  default: allow
  rules:
    - name: block-delete
      match:
        tool: "delete_*"
      action: deny
`,
    )
    await wait(500)

    expect(reloads).toHaveLength(1)
    expect(restartRequiredPaths).toHaveLength(1)
    expect(restartRequiredPaths[0]).toContain('listen')
  })

  // -------------------------------------------------------------------------
  // hot-reload reconciles limit buckets instead of wiping them
  // -------------------------------------------------------------------------

  /**
   * Minimal in-memory forwarder used by the hot-reload + limit reconciliation
   * tests below. Returns a fixed JSON-RPC success body for every call so the
   * rate limiter sees a real forwarded request each time.
   */
  function makeInnerForwarder(): McpForwarder {
    return {
      forward(request: McpRequest): Promise<ForwardResult> {
        const body = {
          jsonrpc: '2.0' as const,
          id: request.id ?? null,
          result: { content: [{ type: 'text', text: 'ok' }] },
        }
        const response: McpResponse = {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body,
        }
        return Promise.resolve({ response, durationMs: 0 })
      },
    }
  }

  function toolsCall(name: string, id: number): McpRequest {
    return {
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: {} },
    }
  }

  function rateLimitYaml(maxCalls: number): string {
    return `
version: "1"
upstream:
  url: "http://127.0.0.1:1/mcp"
dashboard:
  enabled: false
policies:
  default: allow
  rules:
    - name: throttle-send-email
      match:
        tool: "send_email"
      action: rate_limit
      limits:
        max_calls: ${String(maxCalls)}
        window: 1m
        key: tool
`
  }

  it('preserves rate limit state when a benign hot-reload keeps the rule config unchanged', async () => {
    await writeFile(configPath, rateLimitYaml(2))

    // Build a governed forwarder wired through the same reconcile path
    // the CLI uses — this exercises the full ConfigWatcher → updatePolicy →
    // RateLimiter.reconcile chain.
    const { policy: initialPolicy } = compilePolicies({
      dry_run: false,
      default: 'allow',
      rules: [
        {
          name: 'throttle-send-email',
          match: { tool: 'send_email' },
          action: 'rate_limit',
          limits: { max_calls: 2, window: '1m', key: 'tool' },
        },
      ],
    })
    const rateLimiter = new RateLimiter({ cleanupIntervalMs: 0 })
    const governed = new GovernedForwarder(makeInnerForwarder(), initialPolicy, { rateLimiter })

    watcher = new ConfigWatcher({
      configPath,
      onPolicyReload: (newPolicy) => {
        governed.updatePolicy(newPolicy)
      },
      onError: () => {},
      debounceMs: 50,
    })
    watcher.start()
    await wait(100)

    // Exhaust the limit (max 2 calls / 60s)
    await governed.forward(toolsCall('send_email', 1))
    await governed.forward(toolsCall('send_email', 2))
    const blocked = await governed.forward(toolsCall('send_email', 3))
    const blockedError = (blocked.response.body as Record<string, unknown>)['error'] as {
      data: Record<string, unknown>
    }
    expect(blockedError.data['reason']).toBe('rate_limited')
    expect(rateLimiter.getKeyState('tool:send_email')?.current).toBe(2)

    // Simulate `vim :w` no-op — rewrite the same config byte-for-byte. The
    // watcher fires; reconcile sees the same (maxCalls=2, window=60s) tuple
    // and leaves the bucket intact.
    await writeFile(configPath, rateLimitYaml(2))
    await wait(500)

    expect(rateLimiter.getKeyState('tool:send_email')?.current).toBe(2)
    const stillBlocked = await governed.forward(toolsCall('send_email', 4))
    const stillBlockedError = (stillBlocked.response.body as Record<string, unknown>)['error'] as {
      data: Record<string, unknown>
    }
    expect(stillBlockedError.data['reason']).toBe('rate_limited')

    rateLimiter.close()
  })

  it('evicts the rate limit bucket when a hot-reload changes the rule config', async () => {
    await writeFile(configPath, rateLimitYaml(1))

    const { policy: initialPolicy } = compilePolicies({
      dry_run: false,
      default: 'allow',
      rules: [
        {
          name: 'throttle-send-email',
          match: { tool: 'send_email' },
          action: 'rate_limit',
          limits: { max_calls: 1, window: '1m', key: 'tool' },
        },
      ],
    })
    const rateLimiter = new RateLimiter({ cleanupIntervalMs: 0 })
    const governed = new GovernedForwarder(makeInnerForwarder(), initialPolicy, { rateLimiter })

    watcher = new ConfigWatcher({
      configPath,
      onPolicyReload: (newPolicy) => {
        governed.updatePolicy(newPolicy)
      },
      onError: () => {},
      debounceMs: 50,
    })
    watcher.start()
    await wait(100)

    // Exhaust the limit
    await governed.forward(toolsCall('send_email', 1))
    const blocked = await governed.forward(toolsCall('send_email', 2))
    const blockedError = (blocked.response.body as Record<string, unknown>)['error'] as {
      data: Record<string, unknown>
    }
    expect(blockedError.data['reason']).toBe('rate_limited')

    // Operator raises the limit — reconcile evicts the stale bucket and the
    // next request is allowed again.
    await writeFile(configPath, rateLimitYaml(5))
    await wait(500)

    expect(rateLimiter.getKeyState('tool:send_email')).toBeUndefined()
    const result = await governed.forward(toolsCall('send_email', 3))
    expect(result.response.status).toBe(200)

    rateLimiter.close()
  })

  it('preserves spend limit state across a benign hot-reload', async () => {
    const spendYaml = (limit: number) => `
version: "1"
upstream:
  url: "http://127.0.0.1:1/mcp"
dashboard:
  enabled: false
policies:
  default: allow
  rules:
    - name: cap-payments
      match:
        tool: "send_email"
      action: rate_limit
      limits:
        max_calls: 100
        window: 1h
        key: tool
    - name: budget-payments
      match:
        tool: "create_payment"
      action: spend_limit
      limits:
        max_spend:
          field: "$.amount"
          limit: ${String(limit)}
          currency: USD
          window: 1h
`

    await writeFile(configPath, spendYaml(1000))

    const { policy: initialPolicy } = compilePolicies({
      dry_run: false,
      default: 'allow',
      rules: [
        {
          name: 'cap-payments',
          match: { tool: 'send_email' },
          action: 'rate_limit',
          limits: { max_calls: 100, window: '1h', key: 'tool' },
        },
        {
          name: 'budget-payments',
          match: { tool: 'create_payment' },
          action: 'spend_limit',
          limits: {
            max_spend: { field: '$.amount', limit: 1000, currency: 'USD', window: '1h' },
          },
        },
      ],
    })
    const spendLimiter = new SpendLimiter({ cleanupIntervalMs: 0 })
    const rateLimiter = new RateLimiter({ cleanupIntervalMs: 0 })
    const governed = new GovernedForwarder(makeInnerForwarder(), initialPolicy, {
      rateLimiter,
      spendLimiter,
    })

    watcher = new ConfigWatcher({
      configPath,
      onPolicyReload: (newPolicy) => {
        governed.updatePolicy(newPolicy)
      },
      onError: () => {},
      debounceMs: 50,
    })
    watcher.start()
    await wait(100)

    // Spend 600 of the 1000 USD budget
    await governed.forward({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'create_payment', arguments: { amount: 600 } },
    })
    expect(spendLimiter.getKeyState('tool:create_payment:rule:1')?.current_spend).toBe(600)

    // Benign rewrite — same limit. Spend state preserved.
    await writeFile(configPath, spendYaml(1000))
    await wait(500)

    expect(spendLimiter.getKeyState('tool:create_payment:rule:1')?.current_spend).toBe(600)

    // A $500 follow-up would push us over 1000 → must be denied because we
    // remember the 600 we already spent.
    const result = await governed.forward({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'create_payment', arguments: { amount: 500 } },
    })
    const err = (result.response.body as Record<string, unknown>)['error'] as {
      data: Record<string, unknown>
    }
    expect(err.data['reason']).toBe('spend_limited')

    spendLimiter.close()
    rateLimiter.close()
  })

  it('recovers after invalid config is fixed', async () => {
    await writeFile(configPath, validConfig())

    const reloads: CompiledPolicy[] = []
    const errors: Error[] = []

    watcher = new ConfigWatcher({
      configPath,
      onPolicyReload: (policy) => reloads.push(policy),
      onError: (err) => errors.push(err),
      debounceMs: 50,
    })
    watcher.start()
    await wait(100)

    // Break the config
    await writeFile(configPath, 'not: valid')
    await wait(500)
    expect(errors).toHaveLength(1)
    expect(reloads).toHaveLength(0)

    // Fix the config
    await writeFile(configPath, configWithDenyRule())
    await wait(500)
    expect(reloads).toHaveLength(1)
    expect(reloads[0]?.rules).toHaveLength(1)
  })
})
