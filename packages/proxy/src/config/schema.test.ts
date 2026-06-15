import { describe, it, expect } from 'vitest'
import { helioConfigSchema, durationSchema, parseDuration } from './schema.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function minimalConfig(overrides: Record<string, unknown> = {}) {
  return {
    version: '1',
    upstream: { url: 'http://localhost:8080' },
    dashboard: { enabled: false },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Duration schema
// ---------------------------------------------------------------------------

describe('durationSchema', () => {
  it.each(['300s', '5m', '1h', '90d', '0s', '24h'])('accepts "%s"', (val) => {
    expect(durationSchema.safeParse(val).success).toBe(true)
  })

  it.each(['abc', '300', 's300', '', '300x', '1.5h', '-5s', '10 s'])('rejects "%s"', (val) => {
    expect(durationSchema.safeParse(val).success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// parseDuration
// ---------------------------------------------------------------------------

describe('parseDuration', () => {
  it('converts seconds to milliseconds', () => {
    expect(parseDuration('300s')).toBe(300_000)
  })

  it('converts minutes to milliseconds', () => {
    expect(parseDuration('5m')).toBe(300_000)
  })

  it('converts hours to milliseconds', () => {
    expect(parseDuration('1h')).toBe(3_600_000)
  })

  it('converts days to milliseconds', () => {
    expect(parseDuration('90d')).toBe(7_776_000_000)
  })

  it('throws on invalid input', () => {
    expect(() => parseDuration('abc')).toThrow('Invalid duration string')
  })
})

// ---------------------------------------------------------------------------
// Minimal valid config
// ---------------------------------------------------------------------------

describe('helioConfigSchema', () => {
  describe('sender_id limit key requires the sideband (issue #13)', () => {
    const senderRateRule = {
      match: { tool: 'send' },
      action: 'rate_limit',
      limits: { max_calls: 1, window: '1m', key: 'sender_id' },
    }
    const senderSpendRule = {
      match: { tool: 'pay' },
      action: 'spend_limit',
      limits: {
        max_spend: { field: '$.amt', limit: 5, currency: 'USD', window: '1h', key: 'sender_id' },
      },
    }

    it('rejects limits.key: sender_id when sdk.enabled is false (default)', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({ policies: { rules: [senderRateRule] } }),
      )
      expect(result.success).toBe(false)
    })

    it('rejects max_spend.key: sender_id when sdk.enabled is false', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({ policies: { rules: [senderSpendRule] } }),
      )
      expect(result.success).toBe(false)
    })

    it('accepts sender_id keys when sdk.enabled is true', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          sdk: { enabled: true },
          policies: { rules: [senderRateRule, senderSpendRule] },
        }),
      )
      expect(result.success).toBe(true)
    })

    it('still accepts session/tool keys with sdk disabled', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          policies: {
            rules: [
              {
                match: { tool: 'send' },
                action: 'rate_limit',
                limits: { max_calls: 1, window: '1m', key: 'session' },
              },
            ],
          },
        }),
      )
      expect(result.success).toBe(true)
    })
  })

  describe('minimal config', () => {
    it('parses with dashboard explicitly disabled', () => {
      const result = helioConfigSchema.safeParse(minimalConfig())
      expect(result.success).toBe(true)
    })

    it('applies all defaults', () => {
      const result = helioConfigSchema.safeParse(minimalConfig())
      expect(result.success).toBe(true)
      if (!result.success) return

      expect(result.data.upstream.transport).toBe('streamable-http')
      expect(result.data.upstream.connect_timeout).toBe('10s')
      expect(result.data.upstream.request_timeout).toBe('30s')
      expect(result.data.upstream.forward_headers).toEqual([])
      expect(result.data.upstream.headers).toEqual({})
      expect(result.data.listen.port).toBe(3000)
      expect(result.data.listen.host).toBe('127.0.0.1')
      expect(result.data.dashboard.enabled).toBe(false)
      expect(result.data.dashboard.port).toBe(3100)
      expect(result.data.dashboard.allow_open_mode).toBe(false)
      expect(result.data.policies.default).toBe('allow')
      expect(result.data.policies.rules).toEqual([])
      expect(result.data.approval.timeout).toBe('300s')
      expect(result.data.approval.default_on_timeout).toBe('deny')
      expect(result.data.approval.channels).toEqual([])
      expect(result.data.audit.storage).toBe('sqlite')
      expect(result.data.audit.path).toBe('./helio-audit.db')
      expect(result.data.audit.retention).toBe('90d')
      expect(result.data.audit.include_responses).toBe(true)
      expect(result.data.sdk.enabled).toBe(false)
      expect(result.data.sdk.port).toBe(3200)
      expect(result.data.dashboard.host).toBe('127.0.0.1')
      expect(result.data.dashboard.sse_heartbeat_interval).toBe('30s')
      expect(result.data.sdk.host).toBe('127.0.0.1')
    })
  })

  // -------------------------------------------------------------------------
  // Version
  // -------------------------------------------------------------------------

  describe('version', () => {
    it('rejects version "2"', () => {
      const result = helioConfigSchema.safeParse(minimalConfig({ version: '2' }))
      expect(result.success).toBe(false)
    })

    it('rejects missing version', () => {
      const { version: _, ...noVersion } = minimalConfig()
      const result = helioConfigSchema.safeParse(noVersion)
      expect(result.success).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // Upstream
  // -------------------------------------------------------------------------

  describe('upstream', () => {
    it('rejects missing url', () => {
      const result = helioConfigSchema.safeParse(minimalConfig({ upstream: { transport: 'sse' } }))
      expect(result.success).toBe(false)
    })

    it('rejects stdio transport without command', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          upstream: { url: 'http://localhost:8080', transport: 'stdio' },
        }),
      )
      expect(result.success).toBe(false)
    })

    it('accepts stdio transport with command', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          upstream: {
            url: 'http://localhost:8080',
            transport: 'stdio',
            command: 'node',
            args: ['server.js'],
          },
        }),
      )
      expect(result.success).toBe(true)
    })

    it('accepts allowlisted forwarded caller headers that start with x-', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          upstream: {
            url: 'http://localhost:8080',
            forward_headers: ['x-request-id', 'x-trace-id'],
          },
        }),
      )
      expect(result.success).toBe(true)
    })

    it('rejects forwarded caller headers that do not start with x-', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          upstream: {
            url: 'http://localhost:8080',
            forward_headers: ['authorization'],
          },
        }),
      )
      expect(result.success).toBe(false)
    })

    it('accepts a string-to-string headers map', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          upstream: {
            url: 'http://localhost:8080',
            headers: { Authorization: 'Bearer abc' },
          },
        }),
      )
      expect(result.success).toBe(true)
      if (!result.success) return
      expect(result.data.upstream.headers).toEqual({ Authorization: 'Bearer abc' })
    })

    it('rejects non-string header values', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          upstream: {
            url: 'http://localhost:8080',
            headers: { 'X-Count': 3 },
          },
        }),
      )
      expect(result.success).toBe(false)
    })

    it('rejects reserved protocol headers (case-insensitive)', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          upstream: {
            url: 'http://localhost:8080',
            headers: { 'Mcp-Session-Id': 'bad', 'content-type': 'text/plain' },
          },
        }),
      )
      expect(result.success).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // Port validation
  // -------------------------------------------------------------------------

  describe('port validation', () => {
    it('rejects port 0', () => {
      const result = helioConfigSchema.safeParse(minimalConfig({ listen: { port: 0 } }))
      expect(result.success).toBe(false)
    })

    it('rejects port 65536', () => {
      const result = helioConfigSchema.safeParse(minimalConfig({ listen: { port: 65536 } }))
      expect(result.success).toBe(false)
    })

    it('accepts port 3000', () => {
      const result = helioConfigSchema.safeParse(minimalConfig({ listen: { port: 3000 } }))
      expect(result.success).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // Dashboard — SSE heartbeat interval
  // -------------------------------------------------------------------------

  describe('dashboard.sse_heartbeat_interval', () => {
    it('accepts a custom interval', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          dashboard: { enabled: true, api_secret: 'test-secret', sse_heartbeat_interval: '10s' },
        }),
      )
      expect(result.success).toBe(true)
      if (!result.success) return
      expect(result.data.dashboard.sse_heartbeat_interval).toBe('10s')
    })

    it('rejects an invalid duration', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          dashboard: { enabled: true, api_secret: 'test-secret', sse_heartbeat_interval: 'fast' },
        }),
      )
      expect(result.success).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // Policies — dry_run
  // -------------------------------------------------------------------------

  describe('policies.dry_run', () => {
    it('defaults to false', () => {
      const result = helioConfigSchema.safeParse(minimalConfig())
      expect(result.success).toBe(true)
      if (!result.success) return
      expect(result.data.policies.dry_run).toBe(false)
    })

    it('accepts true', () => {
      const result = helioConfigSchema.safeParse(minimalConfig({ policies: { dry_run: true } }))
      expect(result.success).toBe(true)
      if (!result.success) return
      expect(result.data.policies.dry_run).toBe(true)
    })

    it('rejects non-boolean value', () => {
      const result = helioConfigSchema.safeParse(minimalConfig({ policies: { dry_run: 'yes' } }))
      expect(result.success).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // Policy rules
  // -------------------------------------------------------------------------

  describe('policy rules', () => {
    it('accepts a minimal rule', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          policies: {
            rules: [{ match: { tool: '*' }, action: 'allow' }],
          },
        }),
      )
      expect(result.success).toBe(true)
    })

    it('accepts a full rule with all fields including escalation_after', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          environment: 'production',
          dashboard: { api_secret: 'test-secret' },
          approval: {
            channels: [
              {
                type: 'slack',
                name: 'slack',
                bot_token: 'xoxb-123',
                signing_secret: 'secret',
                channel: '#approvals',
              },
              { type: 'webhook', name: 'webhook-fallback', url: 'https://example.com/hook' },
            ],
          },
          policies: {
            default: 'deny',
            flag_destructive: 'require_approval',
            rules: [
              {
                name: 'approve-writes',
                match: {
                  tool: 'send_*',
                  annotations: { destructiveHint: true },
                  input: { '$.amount': { gt: 1000 } },
                  environment: 'production',
                },
                action: 'require_approval',
                approval: {
                  channel: 'slack',
                  timeout: '300s',
                  delegates: ['webhook-fallback'],
                  escalation_after: '120s',
                },
                evidence: { requires: ['orders.lookup'] },
                requires: ['customer.verify'],
                limits: {
                  max_calls: 100,
                  window: '1h',
                  key: 'agent',
                  max_spend: {
                    field: 'input.amount',
                    limit: 5000,
                    currency: 'GBP',
                    window: '24h',
                  },
                },
                feedback: { message: 'Requires payments team approval.' },
              },
            ],
          },
        }),
      )
      expect(result.success).toBe(true)
    })

    it('rejects an invalid action', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          policies: {
            rules: [{ match: { tool: '*' }, action: 'invalid_action' }],
          },
        }),
      )
      expect(result.success).toBe(false)
    })

    it('rejects input condition with no operators', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          policies: {
            rules: [{ match: { tool: '*', input: { '$.x': {} } }, action: 'deny' }],
          },
        }),
      )
      expect(result.success).toBe(false)
    })

    it('rejects match.environment when top-level environment is unset', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          policies: {
            rules: [
              {
                name: 'prod-only-rule',
                match: { tool: 'create_payment', environment: 'production' },
                action: 'deny',
              },
            ],
          },
        }),
      )

      expect(result.success).toBe(false)
      if (result.success) return
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths).toContain('policies.rules.0.match.environment')
    })

    it('accepts match.environment when top-level environment is set', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          environment: 'production',
          policies: {
            rules: [
              {
                name: 'prod-only-rule',
                match: { tool: 'create_payment', environment: 'production' },
                action: 'deny',
              },
            ],
          },
        }),
      )

      expect(result.success).toBe(true)
    })

    it('accepts approval config without escalation_after (backwards compatible)', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          dashboard: { api_secret: 'test-secret' },
          approval: {
            channels: [
              {
                type: 'slack',
                name: 'slack',
                bot_token: 'xoxb-123',
                signing_secret: 'secret',
                channel: '#approvals',
              },
            ],
          },
          policies: {
            rules: [
              {
                match: { tool: '*' },
                action: 'require_approval',
                approval: { channel: 'slack', timeout: '300s' },
              },
            ],
          },
        }),
      )
      expect(result.success).toBe(true)
    })

    it('rejects rate_limit rules without limits.max_calls', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          policies: {
            rules: [{ match: { tool: '*' }, action: 'rate_limit', limits: { window: '1m' } }],
          },
        }),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths).toContain('policies.rules.0.limits.max_calls')
    })

    it('rejects rate_limit rules without limits.window', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          policies: {
            rules: [{ match: { tool: '*' }, action: 'rate_limit', limits: { max_calls: 5 } }],
          },
        }),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths).toContain('policies.rules.0.limits.window')
    })

    it('rejects spend_limit rules without limits.max_spend', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          policies: {
            rules: [{ match: { tool: '*' }, action: 'spend_limit', limits: {} }],
          },
        }),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths).toContain('policies.rules.0.limits.max_spend')
    })

    it('rejects unknown annotation keys', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          policies: {
            rules: [
              {
                match: { tool: '*', annotations: { unknownHint: true } },
                action: 'deny',
              },
            ],
          },
        }),
      )
      expect(result.success).toBe(false)
    })

    it('rejects unknown keys in match blocks', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          policies: {
            rules: [
              {
                match: { tool: '*', typo_field: true },
                action: 'deny',
              },
            ],
          },
        }),
      )
      expect(result.success).toBe(false)
    })

    it('rejects unknown keys in policy rule blocks', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          policies: {
            rules: [
              {
                match: { tool: '*' },
                action: 'deny',
                typo_field: true,
              },
            ],
          },
        }),
      )
      expect(result.success).toBe(false)
    })

    it('rejects unknown keys in policies block', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          policies: {
            default: 'allow',
            rules: [{ match: { tool: '*' }, action: 'allow' }],
            typo_field: true,
          },
        }),
      )
      expect(result.success).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // Approval channels
  // -------------------------------------------------------------------------

  describe('approval channels', () => {
    it('accepts a slack channel', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          approval: {
            channels: [
              {
                type: 'slack',
                bot_token: 'xoxb-123',
                signing_secret: 'abc123',
                channel: '#approvals',
              },
            ],
          },
        }),
      )
      expect(result.success).toBe(true)
    })

    it('accepts a webhook channel', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          dashboard: { enabled: true, api_secret: 'unit-test-secret' },
          approval: {
            channels: [{ type: 'webhook', url: 'https://example.com/hook' }],
          },
        }),
      )
      expect(result.success).toBe(true)
    })

    it('rejects webhook channel when dashboard is disabled', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          dashboard: { enabled: false },
          approval: {
            channels: [{ type: 'webhook', url: 'https://example.com/hook' }],
          },
        }),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths).toContain('dashboard.enabled')
    })

    it('accepts a dashboard channel', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          approval: { channels: [{ type: 'dashboard' }] },
        }),
      )
      expect(result.success).toBe(true)
    })

    it('rejects an unknown channel type', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          approval: { channels: [{ type: 'email' }] },
        }),
      )
      expect(result.success).toBe(false)
    })

    it('rejects slack channel missing bot_token', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          approval: {
            channels: [{ type: 'slack', channel: '#approvals' }],
          },
        }),
      )
      expect(result.success).toBe(false)
    })

    it('rejects policy rule approval channel references that are not configured', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          dashboard: { api_secret: 'unit-test-secret' },
          policies: {
            rules: [
              {
                match: { tool: 'write_*' },
                action: 'require_approval',
                approval: { channel: 'missing-channel' },
              },
            ],
          },
        }),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths).toContain('policies.rules.0.approval.channel')
    })

    it('rejects delegate references that are not configured channel names', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          dashboard: { api_secret: 'unit-test-secret' },
          approval: {
            channels: [
              {
                type: 'slack',
                name: 'primary',
                bot_token: 'xoxb-123',
                signing_secret: 'secret',
                channel: '#ops',
              },
              { type: 'webhook', name: 'fallback', url: 'https://example.com/hook' },
            ],
          },
          policies: {
            rules: [
              {
                match: { tool: 'write_*' },
                action: 'require_approval',
                approval: {
                  channel: 'primary',
                  delegates: ['unknown'],
                },
              },
            ],
          },
        }),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths).toContain('policies.rules.0.approval.delegates.0')
    })

    it('accepts approval channel and delegates that reference configured names', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          dashboard: { api_secret: 'unit-test-secret' },
          approval: {
            channels: [
              {
                type: 'slack',
                name: 'primary',
                bot_token: 'xoxb-123',
                signing_secret: 'secret',
                channel: '#ops',
              },
              { type: 'webhook', name: 'fallback', url: 'https://example.com/hook' },
            ],
          },
          policies: {
            rules: [
              {
                match: { tool: 'write_*' },
                action: 'require_approval',
                approval: {
                  channel: 'primary',
                  delegates: ['fallback'],
                },
              },
            ],
          },
        }),
      )
      expect(result.success).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // Full complex config
  // -------------------------------------------------------------------------

  describe('full complex config', () => {
    it('parses a complete configuration', () => {
      const config = {
        version: '1',
        upstream: { url: 'http://localhost:8080/mcp', transport: 'sse' },
        listen: { port: 4000, host: '0.0.0.0' },
        dashboard: {
          enabled: true,
          port: 4100,
          sse_heartbeat_interval: '10s',
          api_secret: 'test-secret',
        },
        policies: {
          default: 'deny',
          flag_destructive: 'log',
          rules: [
            { match: { tool: 'read_*' }, action: 'allow' },
            {
              match: { tool: 'write_*', annotations: { readOnlyHint: false } },
              action: 'require_approval',
              approval: { channel: 'slack' },
            },
          ],
        },
        approval: {
          timeout: '600s',
          default_on_timeout: 'deny',
          channels: [
            { type: 'slack', bot_token: 'xoxb-tok', signing_secret: 'sec123', channel: '#ops' },
            { type: 'webhook', url: 'https://hook.example.com', secret: 's3cret' },
            { type: 'dashboard' },
          ],
        },
        audit: {
          storage: 'sqlite',
          path: '/data/helio.db',
          retention: '365d',
          include_responses: false,
        },
        sdk: { enabled: true, port: 4200, host: '127.0.0.1' },
      }

      const result = helioConfigSchema.safeParse(config)
      expect(result.success).toBe(true)
      if (!result.success) return

      expect(result.data.listen.port).toBe(4000)
      expect(result.data.policies.rules).toHaveLength(2)
      expect(result.data.approval.channels).toHaveLength(3)
      expect(result.data.audit.retention).toBe('365d')
      expect(result.data.sdk.enabled).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // superRefine rejects require_approval without api_secret
  // -------------------------------------------------------------------------

  describe('api_secret enforcement', () => {
    it('rejects require_approval rule with no api_secret and paths to dashboard.api_secret', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          policies: {
            rules: [
              {
                match: { tool: 'write_*' },
                action: 'require_approval',
                approval: { channel: 'dashboard' },
              },
            ],
          },
        }),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths).toContain('dashboard.api_secret')
    })

    it('rejects flag_destructive: require_approval with no api_secret', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({ policies: { flag_destructive: 'require_approval' } }),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths).toContain('dashboard.api_secret')
    })

    it('accepts require_approval rule when dashboard.api_secret is set', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          dashboard: { api_secret: 'unit-test-secret' },
          policies: {
            rules: [
              {
                match: { tool: '*' },
                action: 'require_approval',
                approval: { channel: 'dashboard' },
              },
            ],
          },
        }),
      )
      expect(result.success).toBe(true)
    })

    it('rejects approval.api_secret — the legacy alias was removed', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          approval: { api_secret: 'should-be-rejected' },
          policies: {
            rules: [
              {
                match: { tool: '*' },
                action: 'require_approval',
                approval: { channel: 'dashboard' },
              },
            ],
          },
        }),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths).toContain('dashboard.api_secret')
    })

    it('rejects empty-string dashboard.api_secret when require_approval is used', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          dashboard: { api_secret: '' },
          policies: { flag_destructive: 'require_approval' },
        }),
      )
      expect(result.success).toBe(false)
    })

    it('does not fire when no approval features are used', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          policies: { rules: [{ match: { tool: '*' }, action: 'allow' }] },
        }),
      )
      expect(result.success).toBe(true)
    })

    it('error message mentions openssl rand -hex 32 hint', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({ policies: { flag_destructive: 'require_approval' } }),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      const msg = result.error.issues.find(
        (i) => i.path.join('.') === 'dashboard.api_secret',
      )?.message
      expect(msg).toContain('openssl rand -hex 32')
    })
  })

  // -------------------------------------------------------------------------
  // Policies — on_tool_drift
  // -------------------------------------------------------------------------

  describe('policies.on_tool_drift', () => {
    it.each(['block', 'log'] as const)('accepts %s', (mode) => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({ policies: { on_tool_drift: mode } }),
      )
      expect(result.success).toBe(true)
    })

    it('accepts require_approval when dashboard.api_secret is set', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          policies: { on_tool_drift: 'require_approval' },
          dashboard: { api_secret: 'a'.repeat(64) },
        }),
      )
      expect(result.success).toBe(true)
    })

    it('rejects require_approval without dashboard.api_secret', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({ policies: { on_tool_drift: 'require_approval' } }),
      )
      expect(result.success).toBe(false)
    })

    it('rejects unknown values', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({ policies: { on_tool_drift: 'ignore' } }),
      )
      expect(result.success).toBe(false)
    })

    it('is optional', () => {
      const result = helioConfigSchema.safeParse(minimalConfig())
      expect(result.success).toBe(true)
      if (result.success) expect(result.data.policies.on_tool_drift).toBeUndefined()
    })
  })

  describe('dashboard open mode enforcement', () => {
    it('rejects dashboard enabled without api_secret unless allow_open_mode is true', () => {
      const result = helioConfigSchema.safeParse({
        version: '1',
        upstream: { url: 'http://localhost:8080' },
      })
      expect(result.success).toBe(false)
      if (result.success) return
      const issue = result.error.issues.find((i) => i.path.join('.') === 'dashboard.api_secret')
      expect(issue?.message).toContain('dashboard.allow_open_mode')
    })

    it.each(['127.0.0.1', 'localhost', '::1'])(
      'accepts explicit open mode on loopback host %s',
      (host) => {
        const result = helioConfigSchema.safeParse(
          minimalConfig({
            dashboard: { enabled: true, host, allow_open_mode: true },
          }),
        )
        expect(result.success).toBe(true)
      },
    )

    it('rejects explicit open mode on non-loopback host', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          dashboard: { enabled: true, host: '0.0.0.0', allow_open_mode: true },
        }),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths).toContain('dashboard.host')
    })

    it('accepts dashboard enabled without allow_open_mode when api_secret is set', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          dashboard: { enabled: true, api_secret: 'test-secret' },
        }),
      )
      expect(result.success).toBe(true)
    })
  })
})
