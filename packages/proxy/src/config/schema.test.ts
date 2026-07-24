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
  // Canonical key order
  // -------------------------------------------------------------------------

  describe('canonical key order', () => {
    it('emits top-level keys in the canonical section order', () => {
      // Input keys are deliberately reversed: the assertion holds only while
      // zod emits output in shape-declaration order, so both a re-misplaced
      // shape field and a zod that starts preserving input order fail loudly.
      const result = helioConfigSchema.safeParse({
        sdk: {},
        dashboard: { enabled: false },
        audit: {},
        approval: {},
        budgets: [],
        policies: {},
        environment: 'production',
        listen: {},
        upstream: { url: 'http://localhost:8080' },
        version: '1',
      })
      expect(result.success).toBe(true)
      if (!result.success) return
      expect(Object.keys(result.data)).toEqual([
        'version',
        'upstream',
        'listen',
        'environment',
        'policies',
        'budgets',
        'approval',
        'audit',
        'dashboard',
        'sdk',
      ])
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

  describe('approval channel registry hygiene (issue #14 riders)', () => {
    const slackChannel = (overrides: Record<string, unknown> = {}) => ({
      type: 'slack',
      bot_token: 'xoxb-123',
      signing_secret: 'abc123',
      channel: '#approvals',
      ...overrides,
    })

    it('rejects a non-dashboard channel that takes the reserved dashboard key', () => {
      // createChannels seeds the built-in dashboard fallback first; a slack
      // channel named "dashboard" would silently replace it.
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          approval: { channels: [slackChannel({ name: 'dashboard' })] },
        }),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths).toContain('approval.channels.0.name')
    })

    it('accepts a dashboard-type channel named dashboard (harmless re-registration)', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          approval: { channels: [{ type: 'dashboard', name: 'dashboard' }] },
        }),
      )
      expect(result.success).toBe(true)
    })

    it('rejects duplicate effective channel keys (last-write-wins is silent)', () => {
      const named = helioConfigSchema.safeParse(
        minimalConfig({
          approval: {
            channels: [
              slackChannel({ name: 'oncall' }),
              { type: 'webhook', name: 'oncall', url: 'https://example.com/hook' },
            ],
          },
          dashboard: { enabled: true, api_secret: 'unit-test-secret' },
        }),
      )
      expect(named.success).toBe(false)

      const unnamedPair = helioConfigSchema.safeParse(
        minimalConfig({
          approval: { channels: [slackChannel(), slackChannel({ channel: '#other' })] },
        }),
      )
      expect(unnamedPair.success).toBe(false)
    })

    it('rejects empty channel names and empty approval references', () => {
      const emptyName = helioConfigSchema.safeParse(
        minimalConfig({ approval: { channels: [slackChannel({ name: '' })] } }),
      )
      expect(emptyName.success).toBe(false)

      const emptyReference = helioConfigSchema.safeParse(
        minimalConfig({
          dashboard: { enabled: true, api_secret: 'unit-test-secret' },
          policies: {
            rules: [
              { match: { tool: '*' }, action: 'require_approval', approval: { channel: '' } },
            ],
          },
        }),
      )
      expect(emptyReference.success).toBe(false)

      const emptyDelegate = helioConfigSchema.safeParse(
        minimalConfig({
          dashboard: { enabled: true, api_secret: 'unit-test-secret' },
          policies: {
            rules: [
              {
                match: { tool: '*' },
                action: 'require_approval',
                approval: { channel: 'dashboard', delegates: [''], escalation_after: '60s' },
              },
            ],
          },
        }),
      )
      expect(emptyDelegate.success).toBe(false)
    })
  })

  describe('budgets (issue #14)', () => {
    const validBudget = {
      name: 'daily-cap',
      limit: 50,
      currency: 'USD',
      window: '24h',
      contributors: [{ match: { tool: 'stripe_*' }, field: '$.amount' }],
    }

    function withBudgets(budgets: unknown[], extra: Record<string, unknown> = {}) {
      return minimalConfig({ budgets, ...extra })
    }

    it('defaults to an empty list when absent', () => {
      const result = helioConfigSchema.safeParse(minimalConfig())
      expect(result.success).toBe(true)
      if (!result.success) return
      expect(result.data.budgets).toEqual([])
    })

    it('parses a duration-window budget and applies defaults', () => {
      const result = helioConfigSchema.safeParse(withBudgets([validBudget]))
      expect(result.success).toBe(true)
      if (!result.success) return
      const budget = result.data.budgets[0]
      expect(budget?.key).toBe('global')
      expect(budget?.on_exceed).toBe('deny')
    })

    it('accepts window: session with key: session', () => {
      const result = helioConfigSchema.safeParse(
        withBudgets([{ ...validBudget, window: 'session', key: 'session' }]),
      )
      expect(result.success).toBe(true)
    })

    it('accepts window: session with key: sender_id when the sideband is enabled', () => {
      const result = helioConfigSchema.safeParse(
        withBudgets([{ ...validBudget, window: 'session', key: 'sender_id' }], {
          sdk: { enabled: true },
        }),
      )
      expect(result.success).toBe(true)
    })

    it('rejects window: session with key: global (explicit)', () => {
      const result = helioConfigSchema.safeParse(
        withBudgets([{ ...validBudget, window: 'session', key: 'global' }]),
      )
      expect(result.success).toBe(false)
    })

    it('rejects window: session with the default key', () => {
      const result = helioConfigSchema.safeParse(
        withBudgets([{ ...validBudget, window: 'session' }]),
      )
      expect(result.success).toBe(false)
    })

    it('accepts idle_ttl on session windows', () => {
      const result = helioConfigSchema.safeParse(
        withBudgets([{ ...validBudget, window: 'session', key: 'session', idle_ttl: '12h' }]),
      )
      expect(result.success).toBe(true)
    })

    it('rejects idle_ttl on duration windows', () => {
      const result = helioConfigSchema.safeParse(withBudgets([{ ...validBudget, idle_ttl: '12h' }]))
      expect(result.success).toBe(false)
    })

    it('rejects key: sender_id when the sideband is disabled', () => {
      const result = helioConfigSchema.safeParse(
        withBudgets([{ ...validBudget, key: 'sender_id' }]),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths).toContain('budgets.0.key')
    })

    it('rejects duplicate budget names', () => {
      const result = helioConfigSchema.safeParse(
        withBudgets([validBudget, { ...validBudget, window: '1h' }]),
      )
      expect(result.success).toBe(false)
    })

    it('rejects an empty contributors list', () => {
      const result = helioConfigSchema.safeParse(
        withBudgets([{ ...validBudget, contributors: [] }]),
      )
      expect(result.success).toBe(false)
    })

    it('rejects unknown budget fields (strict)', () => {
      const result = helioConfigSchema.safeParse(withBudgets([{ ...validBudget, surprise: true }]))
      expect(result.success).toBe(false)
    })

    it('rejects unknown contributor fields (strict)', () => {
      const result = helioConfigSchema.safeParse(
        withBudgets([
          {
            ...validBudget,
            contributors: [{ match: { tool: 'a_*' }, field: '$.x', currency: 'USD' }],
          },
        ]),
      )
      expect(result.success).toBe(false)
    })

    it('accepts the match-nested contributor shape', () => {
      const result = helioConfigSchema.safeParse(
        withBudgets([
          { ...validBudget, contributors: [{ match: { tool: 'stripe_*' }, field: '$.amount' }] },
        ]),
      )
      expect(result.success).toBe(true)
    })

    it('accepts contributor input conditions with the rule operator set', () => {
      const result = helioConfigSchema.safeParse(
        withBudgets([
          {
            ...validBudget,
            contributors: [
              {
                match: {
                  tool: 'stripe_*',
                  input: { '$.category': { eq: 'content_distribution' } },
                },
                field: '$.amount',
              },
            ],
          },
        ]),
      )
      expect(result.success).toBe(true)
    })

    it('rejects a contributor input condition with no operators', () => {
      const result = helioConfigSchema.safeParse(
        withBudgets([
          {
            ...validBudget,
            contributors: [
              { match: { tool: 'stripe_*', input: { '$.category': {} } }, field: '$.a' },
            ],
          },
        ]),
      )
      expect(result.success).toBe(false)
      const messages = result.success ? [] : result.error.issues.map((issue) => issue.message)
      expect(messages).toContain('At least one condition operator is required')
    })

    it('rejects unknown keys under contributor match (strict)', () => {
      const result = helioConfigSchema.safeParse(
        withBudgets([
          {
            ...validBudget,
            contributors: [{ match: { tool: 'stripe_*', environment: 'prod' }, field: '$.a' }],
          },
        ]),
      )
      expect(result.success).toBe(false)
      const messages = result.success ? [] : result.error.issues.map((issue) => issue.message)
      expect(messages.some((m) => m.includes('environment'))).toBe(true)
    })

    it('rejects the legacy flat contributor shape with a migration message', () => {
      const result = helioConfigSchema.safeParse(
        withBudgets([{ ...validBudget, contributors: [{ tool: 'stripe_*', field: '$.amount' }] }]),
      )
      expect(result.success).toBe(false)
      const messages = result.success ? [] : result.error.issues.map((issue) => issue.message)
      expect(messages.some((m) => m.includes('moved under "match"'))).toBe(true)
    })

    it('rejects a half-migrated contributor (tool alongside match) with the migration message', () => {
      const result = helioConfigSchema.safeParse(
        withBudgets([
          {
            ...validBudget,
            contributors: [{ tool: 'stripe_*', match: { tool: 'stripe_*' }, field: '$.amount' }],
          },
        ]),
      )
      expect(result.success).toBe(false)
      const messages = result.success ? [] : result.error.issues.map((issue) => issue.message)
      expect(messages.some((m) => m.includes('moved under "match"'))).toBe(true)
    })

    it('accepts on_exceed: deny explicitly', () => {
      const result = helioConfigSchema.safeParse(
        withBudgets([{ ...validBudget, on_exceed: 'deny' }]),
      )
      expect(result.success).toBe(true)
    })

    it('rejects an approval block (only meaningful with require_approval)', () => {
      const result = helioConfigSchema.safeParse(
        withBudgets([{ ...validBudget, approval: { channel: 'dashboard' } }]),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths).toContain('budgets.0.approval')
    })

    describe('break-glass (on_exceed: require_approval)', () => {
      // Dashboard-routed budget tickets need the dashboard SERVER, not just
      // the secret — its approvals API is the only resolution surface.
      const secured = { dashboard: { enabled: true, api_secret: 'unit-test-secret' } }
      const breakGlassBudget = { ...validBudget, on_exceed: 'require_approval' }

      it('accepts require_approval with dashboard.api_secret set', () => {
        const result = helioConfigSchema.safeParse(withBudgets([breakGlassBudget], secured))
        expect(result.success).toBe(true)
      })

      it('rejects require_approval without dashboard.api_secret (requiresSecret join)', () => {
        const result = helioConfigSchema.safeParse(withBudgets([breakGlassBudget]))
        expect(result.success).toBe(false)
        if (result.success) return
        const paths = result.error.issues.map((i) => i.path.join('.'))
        expect(paths).toContain('dashboard.api_secret')
      })

      it('accepts require_approval without an approval block (dashboard fallback)', () => {
        const result = helioConfigSchema.safeParse(withBudgets([breakGlassBudget], secured))
        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.data.budgets[0]?.approval).toBeUndefined()
      })

      it('accepts an approval block referencing the built-in dashboard channel', () => {
        const result = helioConfigSchema.safeParse(
          withBudgets(
            [{ ...breakGlassBudget, approval: { channel: 'dashboard', timeout: '120s' } }],
            secured,
          ),
        )
        expect(result.success).toBe(true)
      })

      it('accepts an approval block referencing a configured named channel', () => {
        const result = helioConfigSchema.safeParse(
          withBudgets([{ ...breakGlassBudget, approval: { channel: 'oncall' } }], {
            ...secured,
            approval: {
              channels: [
                {
                  type: 'slack',
                  name: 'oncall',
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

      it('rejects an approval channel that references no configured channel', () => {
        const result = helioConfigSchema.safeParse(
          withBudgets([{ ...breakGlassBudget, approval: { channel: 'nowhere' } }], secured),
        )
        expect(result.success).toBe(false)
        if (result.success) return
        const paths = result.error.issues.map((i) => i.path.join('.'))
        expect(paths).toContain('budgets.0.approval.channel')
      })

      it('rejects a delegate that references no configured channel', () => {
        const result = helioConfigSchema.safeParse(
          withBudgets(
            [
              {
                ...breakGlassBudget,
                approval: {
                  channel: 'dashboard',
                  delegates: ['nowhere'],
                  escalation_after: '60s',
                },
              },
            ],
            secured,
          ),
        )
        expect(result.success).toBe(false)
        if (result.success) return
        const paths = result.error.issues.map((i) => i.path.join('.'))
        expect(paths).toContain('budgets.0.approval.delegates.0')
      })

      it('rejects unknown approval fields (strict, same schema as rules)', () => {
        const result = helioConfigSchema.safeParse(
          withBudgets(
            [{ ...breakGlassBudget, approval: { channel: 'dashboard', surprise: true } }],
            secured,
          ),
        )
        expect(result.success).toBe(false)
      })

      it('rejects a bare-type reference to a NAMED channel (runtime registers name only)', () => {
        // createChannels keys slack/webhook channels by `name ?? type`: a
        // named Slack channel is NOT reachable as "slack", so validating the
        // type would accept a channel that never gets a notification.
        const namedSlack = {
          approval: {
            channels: [
              {
                type: 'slack',
                name: 'oncall',
                bot_token: 'xoxb-123',
                signing_secret: 'abc123',
                channel: '#approvals',
              },
            ],
          },
        }
        const budget = helioConfigSchema.safeParse(
          withBudgets([{ ...breakGlassBudget, approval: { channel: 'slack' } }], {
            ...secured,
            ...namedSlack,
          }),
        )
        expect(budget.success).toBe(false)
        if (budget.success) return
        expect(budget.error.issues.map((i) => i.path.join('.'))).toContain(
          'budgets.0.approval.channel',
        )

        const rule = helioConfigSchema.safeParse(
          minimalConfig({
            ...secured,
            ...namedSlack,
            policies: {
              rules: [
                {
                  match: { tool: '*' },
                  action: 'require_approval',
                  approval: { channel: 'slack' },
                },
              ],
            },
          }),
        )
        expect(rule.success).toBe(false)
        if (rule.success) return
        expect(rule.error.issues.map((i) => i.path.join('.'))).toContain(
          'policies.rules.0.approval.channel',
        )
      })

      it('still accepts a bare-type reference to an UNNAMED channel', () => {
        const result = helioConfigSchema.safeParse(
          withBudgets([{ ...breakGlassBudget, approval: { channel: 'slack' } }], {
            dashboard: { enabled: false, api_secret: 'unit-test-secret' },
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

      it('a named dashboard-type channel stays reachable under both keys', () => {
        const result = helioConfigSchema.safeParse(
          withBudgets([{ ...breakGlassBudget, approval: { channel: 'ops' } }], {
            ...secured,
            approval: { channels: [{ type: 'dashboard', name: 'ops' }] },
          }),
        )
        expect(result.success).toBe(true)
      })

      it('rejects the dashboard fallback when the dashboard server is disabled', () => {
        // No approval block → channel defaults to dashboard; with the
        // dashboard disabled the ticket would have no resolution surface and
        // always time out (fail closed — dead config).
        const result = helioConfigSchema.safeParse(
          withBudgets([breakGlassBudget], {
            dashboard: { enabled: false, api_secret: 'unit-test-secret' },
          }),
        )
        expect(result.success).toBe(false)
        if (result.success) return
        const paths = result.error.issues.map((i) => i.path.join('.'))
        expect(paths).toContain('budgets.0.on_exceed')
      })

      it('rejects an explicit dashboard channel or delegate when the dashboard is disabled', () => {
        const noDashboard = { dashboard: { enabled: false, api_secret: 'unit-test-secret' } }
        const explicit = helioConfigSchema.safeParse(
          withBudgets([{ ...breakGlassBudget, approval: { channel: 'dashboard' } }], noDashboard),
        )
        expect(explicit.success).toBe(false)

        const viaDelegate = helioConfigSchema.safeParse(
          withBudgets(
            [
              {
                ...breakGlassBudget,
                approval: {
                  channel: 'slack',
                  delegates: ['dashboard'],
                  escalation_after: '60s',
                },
              },
            ],
            {
              ...noDashboard,
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
            },
          ),
        )
        expect(viaDelegate.success).toBe(false)
      })

      it('a dashboard delegate with no escalation timer is inert, not rejected', () => {
        // Without escalation_after the delegate list never fires at runtime,
        // so the dashboard-availability guard must not reject it.
        const result = helioConfigSchema.safeParse(
          withBudgets(
            [{ ...breakGlassBudget, approval: { channel: 'slack', delegates: ['dashboard'] } }],
            {
              dashboard: { enabled: false, api_secret: 'unit-test-secret' },
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
            },
          ),
        )
        expect(result.success).toBe(true)
      })

      it('non-viable escalation timers make dashboard delegates inert (router parity)', () => {
        // The router escalates only when 0 < escalation_after < the
        // effective timeout; a timer that can never fire must not trip the
        // dashboard-availability guard.
        const base = {
          dashboard: { enabled: false, api_secret: 'unit-test-secret' },
          approval: {
            timeout: '300s',
            channels: [
              {
                type: 'slack',
                bot_token: 'xoxb-123',
                signing_secret: 'abc123',
                channel: '#approvals',
              },
            ],
          },
        }
        const zero = helioConfigSchema.safeParse(
          withBudgets(
            [
              {
                ...breakGlassBudget,
                approval: { channel: 'slack', delegates: ['dashboard'], escalation_after: '0s' },
              },
            ],
            base,
          ),
        )
        expect(zero.success).toBe(true)

        const tooLate = helioConfigSchema.safeParse(
          withBudgets(
            [
              {
                ...breakGlassBudget,
                approval: {
                  channel: 'slack',
                  timeout: '60s',
                  delegates: ['dashboard'],
                  escalation_after: '60s',
                },
              },
            ],
            base,
          ),
        )
        expect(tooLate.success).toBe(true)

        // Past the GLOBAL default timeout when the budget sets none.
        const pastGlobal = helioConfigSchema.safeParse(
          withBudgets(
            [
              {
                ...breakGlassBudget,
                approval: {
                  channel: 'slack',
                  delegates: ['dashboard'],
                  escalation_after: '600s',
                },
              },
            ],
            base,
          ),
        )
        expect(pastGlobal.success).toBe(true)
      })

      it('accepts a slack-routed budget with the dashboard disabled', () => {
        // Slack tickets resolve through the Slack action callbacks on the
        // main proxy server; no dashboard needed.
        const result = helioConfigSchema.safeParse(
          withBudgets([{ ...breakGlassBudget, approval: { channel: 'slack' } }], {
            dashboard: { enabled: false, api_secret: 'unit-test-secret' },
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
    })

    it('rejects a non-positive limit', () => {
      const zero = helioConfigSchema.safeParse(withBudgets([{ ...validBudget, limit: 0 }]))
      const negative = helioConfigSchema.safeParse(withBudgets([{ ...validBudget, limit: -5 }]))
      expect(zero.success).toBe(false)
      expect(negative.success).toBe(false)
    })

    it('rejects a window that is neither a duration nor "session"', () => {
      const result = helioConfigSchema.safeParse(
        withBudgets([{ ...validBudget, window: 'monthly' }]),
      )
      expect(result.success).toBe(false)
    })

    it('rejects an empty budget name', () => {
      const result = helioConfigSchema.safeParse(withBudgets([{ ...validBudget, name: '' }]))
      expect(result.success).toBe(false)
    })

    it('rejects budget names with delimiter characters', () => {
      // Names are embedded in bucket keys; a ":" could forge scope segments.
      const result = helioConfigSchema.safeParse(
        withBudgets([{ ...validBudget, name: 'evil:sender:x' }]),
      )
      expect(result.success).toBe(false)
    })
  })

  describe('unknown top-level keys (issue #167)', () => {
    it('rejects a top-level rules: key, naming it', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({ rules: [{ match: { tool: 'delete_*' }, action: 'deny' }] }),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.issues).toHaveLength(1)
      expect(result.error.issues[0]?.code).toBe('unrecognized_keys')
      expect(result.error.issues[0]?.path).toEqual([])
      expect(result.error.issues[0]?.message).toBe('Unrecognized key: "rules"')
    })

    it('rejects policy: (singular typo for policies:)', () => {
      const result = helioConfigSchema.safeParse(minimalConfig({ policy: { default: 'allow' } }))
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.issues[0]?.message).toBe('Unrecognized key: "policy"')
    })

    it('rejects budget: (singular typo for budgets:)', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          budget: [
            {
              name: 'openai-daily',
              limit: 25,
              currency: 'USD',
              window: '1d',
              contributors: [{ match: { tool: 'openai_*' }, field: '$.usage.total_cost' }],
            },
          ],
        }),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.issues[0]?.message).toBe('Unrecognized key: "budget"')
    })

    it('names every unknown key in a single issue', () => {
      const result = helioConfigSchema.safeParse(minimalConfig({ rules: [], budget: [] }))
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.issues).toHaveLength(1)
      expect(result.error.issues[0]?.message).toBe('Unrecognized keys: "rules", "budget"')
    })

    it('allows top-level x- extension keys as anchor holders and drops them', () => {
      const result = helioConfigSchema.safeParse(minimalConfig({ 'x-defaults': { window: '1h' } }))
      expect(result.success).toBe(true)
      if (!result.success) return
      expect('x-defaults' in result.data).toBe(false)
    })

    it('does not strip x- keys inside sections (root-only escape hatch)', () => {
      // policies is a strict subtree, so the un-stripped key is rejected
      // there. Non-strict sections handle unknown keys their own way — the
      // pin here is only that the strip never descends past the root.
      const result = helioConfigSchema.safeParse(minimalConfig({ policies: { 'x-shared': true } }))
      expect(result.success).toBe(false)
    })

    it('still rejects unknown keys one level down with the section path', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({ policies: { default_action: 'allow' } }),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.issues[0]?.code).toBe('unrecognized_keys')
      expect(result.error.issues[0]?.path).toEqual(['policies'])
      expect(result.error.issues[0]?.message).toBe('Unrecognized key: "default_action"')
    })
  })
})
