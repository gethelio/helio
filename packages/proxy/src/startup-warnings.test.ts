import { describe, it, expect } from 'vitest'
import {
  warnIfWebhookChannelUnreachable,
  warnIfSdkSidebandExposed,
  warnIfDashboardOpenMode,
  warnIfNoEnforcement,
  warnIfBudgetWindowExceedsRetention,
  warnIfManyUpstreams,
  warnIfStdioUrlIgnored,
  warnIfDashboardSecretLiteral,
} from './startup-warnings.js'

describe('warnIfManyUpstreams', () => {
  const upstreams = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      name: `up-${String(i)}`,
      url: `http://localhost:${String(9000 + i)}/mcp`,
    }))

  it('warns above 16 upstream entries', () => {
    const messages: string[] = []
    const warned = warnIfManyUpstreams({ upstreams: upstreams(17) }, (m) => messages.push(m))
    expect(warned).toBe(true)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toBe(
      '[helio] Warning: 17 upstreams configured. Each upstream runs its own upstream ' +
        'connection or child process plus an annotation prime loop; consider whether one ' +
        'proxy should govern this many.',
    )
  })

  it('does not warn at exactly 16 entries', () => {
    const messages: string[] = []
    const warned = warnIfManyUpstreams({ upstreams: upstreams(16) }, (m) => messages.push(m))
    expect(warned).toBe(false)
    expect(messages).toHaveLength(0)
  })
})

describe('warnIfStdioUrlIgnored', () => {
  it('warns when a singular stdio upstream carries a url', () => {
    const messages: string[] = []
    const warned = warnIfStdioUrlIgnored(
      { upstream: { transport: 'stdio', url: 'stdio://legacy' } },
      (m) => messages.push(m),
    )
    expect(warned).toBe(true)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toBe(
      '[helio] Warning: upstream.url is ignored when transport is "stdio" (the stdio ' +
        'forwarder spawns "command"). Remove the field to silence this warning.',
    )
  })

  it('warns on an empty-string url — the field is present even when falsy', () => {
    const messages: string[] = []
    const warned = warnIfStdioUrlIgnored({ upstream: { transport: 'stdio', url: '' } }, (m) =>
      messages.push(m),
    )
    expect(warned).toBe(true)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toBe(
      '[helio] Warning: upstream.url is ignored when transport is "stdio" (the stdio ' +
        'forwarder spawns "command"). Remove the field to silence this warning.',
    )
  })

  it('warns per offending named entry with the dotted index path', () => {
    const messages: string[] = []
    const warned = warnIfStdioUrlIgnored(
      {
        upstreams: [
          { transport: 'stdio', url: 'stdio://a' },
          { transport: 'streamable-http', url: 'http://localhost:9000/mcp' },
          { transport: 'stdio', url: 'stdio://c' },
        ],
      },
      (m) => messages.push(m),
    )
    expect(warned).toBe(true)
    expect(messages).toHaveLength(2)
    expect(messages[0]).toBe(
      '[helio] Warning: upstreams.0.url is ignored when transport is "stdio" (the stdio ' +
        'forwarder spawns "command"). Remove the field to silence this warning.',
    )
    expect(messages[1]).toBe(
      '[helio] Warning: upstreams.2.url is ignored when transport is "stdio" (the stdio ' +
        'forwarder spawns "command"). Remove the field to silence this warning.',
    )
  })

  it('does not warn for a singular stdio upstream without a url', () => {
    const messages: string[] = []
    const warned = warnIfStdioUrlIgnored({ upstream: { transport: 'stdio' } }, (m) =>
      messages.push(m),
    )
    expect(warned).toBe(false)
    expect(messages).toHaveLength(0)
  })

  it('does not warn for a singular streamable-http upstream with a url', () => {
    const messages: string[] = []
    const warned = warnIfStdioUrlIgnored(
      { upstream: { transport: 'streamable-http', url: 'http://localhost:9000/mcp' } },
      (m) => messages.push(m),
    )
    expect(warned).toBe(false)
    expect(messages).toHaveLength(0)
  })

  it('does not warn for a named stdio entry without a url', () => {
    const messages: string[] = []
    const warned = warnIfStdioUrlIgnored({ upstreams: [{ transport: 'stdio' }] }, (m) =>
      messages.push(m),
    )
    expect(warned).toBe(false)
    expect(messages).toHaveLength(0)
  })

  it('does not warn for named all-HTTP entries with urls', () => {
    const messages: string[] = []
    const warned = warnIfStdioUrlIgnored(
      {
        upstreams: [
          { transport: 'streamable-http', url: 'http://localhost:9000/mcp' },
          { transport: 'sse', url: 'http://localhost:9001/sse' },
        ],
      },
      (m) => messages.push(m),
    )
    expect(warned).toBe(false)
    expect(messages).toHaveLength(0)
  })

  it('does not warn for a singular sse upstream with a url — url is required there', () => {
    const messages: string[] = []
    const warned = warnIfStdioUrlIgnored(
      { upstream: { transport: 'sse', url: 'http://localhost:9001/sse' } },
      (m) => messages.push(m),
    )
    expect(warned).toBe(false)
    expect(messages).toHaveLength(0)
  })
})

describe('warnIfWebhookChannelUnreachable', () => {
  function makeConfig(
    channels: Array<{ type: string }>,
    dashboardHost: string,
    dashboardEnabled = true,
  ) {
    return {
      approval: { channels },
      dashboard: { host: dashboardHost, enabled: dashboardEnabled },
    }
  }

  it('warns when webhook channel + dashboard is bound to 127.0.0.1', () => {
    const messages: string[] = []
    const warned = warnIfWebhookChannelUnreachable(
      makeConfig([{ type: 'webhook' }], '127.0.0.1'),
      (m) => messages.push(m),
    )

    expect(warned).toBe(true)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('webhook approval channel')
    expect(messages[0]).toContain('/api/approvals')
  })

  it('warns when webhook channel + dashboard is bound to localhost', () => {
    const messages: string[] = []
    const warned = warnIfWebhookChannelUnreachable(
      makeConfig([{ type: 'webhook' }], 'localhost'),
      (m) => messages.push(m),
    )

    expect(warned).toBe(true)
    expect(messages).toHaveLength(1)
  })

  it('warns when webhook channel + dashboard is bound to IPv6 loopback (::1)', () => {
    const messages: string[] = []
    const warned = warnIfWebhookChannelUnreachable(makeConfig([{ type: 'webhook' }], '::1'), (m) =>
      messages.push(m),
    )

    expect(warned).toBe(true)
    expect(messages).toHaveLength(1)
  })

  it('does not warn when dashboard is bound to a public address', () => {
    const messages: string[] = []
    const warned = warnIfWebhookChannelUnreachable(
      makeConfig([{ type: 'webhook' }], '0.0.0.0'),
      (m) => messages.push(m),
    )

    expect(warned).toBe(false)
    expect(messages).toHaveLength(0)
  })

  it('does not warn when no webhook channel is configured', () => {
    const messages: string[] = []
    const warned = warnIfWebhookChannelUnreachable(
      makeConfig([{ type: 'slack' }, { type: 'dashboard' }], '127.0.0.1'),
      (m) => messages.push(m),
    )

    expect(warned).toBe(false)
    expect(messages).toHaveLength(0)
  })

  it('does not warn when dashboard is disabled (webhook cannot be served)', () => {
    const messages: string[] = []
    const warned = warnIfWebhookChannelUnreachable(
      makeConfig([{ type: 'webhook' }], '127.0.0.1', false),
      (m) => messages.push(m),
    )

    expect(warned).toBe(false)
    expect(messages).toHaveLength(0)
  })

  it('warns when any of multiple channels is a webhook', () => {
    const messages: string[] = []
    const warned = warnIfWebhookChannelUnreachable(
      makeConfig([{ type: 'slack' }, { type: 'webhook' }], '127.0.0.1'),
      (m) => messages.push(m),
    )

    expect(warned).toBe(true)
    expect(messages).toHaveLength(1)
  })
})

describe('warnIfSdkSidebandExposed', () => {
  it('warns when sideband is enabled and bound to non-loopback host', () => {
    const messages: string[] = []
    const warned = warnIfSdkSidebandExposed({ sdk: { enabled: true, host: '0.0.0.0' } }, (m) =>
      messages.push(m),
    )
    expect(warned).toBe(true)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('SDK sideband is bound to a non-loopback host')
  })

  it('does not warn when sideband is disabled', () => {
    const messages: string[] = []
    const warned = warnIfSdkSidebandExposed({ sdk: { enabled: false, host: '0.0.0.0' } }, (m) =>
      messages.push(m),
    )
    expect(warned).toBe(false)
    expect(messages).toHaveLength(0)
  })

  it.each(['127.0.0.1', 'localhost', '::1'])('does not warn for loopback host %s', (host) => {
    const messages: string[] = []
    const warned = warnIfSdkSidebandExposed({ sdk: { enabled: true, host } }, (m) =>
      messages.push(m),
    )
    expect(warned).toBe(false)
    expect(messages).toHaveLength(0)
  })
})

describe('warnIfDashboardOpenMode', () => {
  function makeConfig(args: {
    readonly enabled?: boolean
    readonly allowOpenMode?: boolean
    readonly apiSecret?: string
  }) {
    return {
      dashboard: {
        enabled: args.enabled ?? true,
        allow_open_mode: args.allowOpenMode ?? false,
        api_secret: args.apiSecret,
      },
    }
  }

  it('warns when dashboard runs in explicit open mode', () => {
    const messages: string[] = []
    const warned = warnIfDashboardOpenMode(
      makeConfig({ allowOpenMode: true, apiSecret: undefined }),
      (m) => messages.push(m),
    )

    expect(warned).toBe(true)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('dashboard sideband API')
    expect(messages[0]).toContain('OPEN MODE')
  })

  it('does not warn when dashboard secret is set', () => {
    const messages: string[] = []
    const warned = warnIfDashboardOpenMode(
      makeConfig({ allowOpenMode: true, apiSecret: 'test-secret' }),
      (m) => messages.push(m),
    )

    expect(warned).toBe(false)
    expect(messages).toHaveLength(0)
  })

  it('does not warn when dashboard is disabled', () => {
    const messages: string[] = []
    const warned = warnIfDashboardOpenMode(
      makeConfig({ enabled: false, allowOpenMode: true }),
      (m) => messages.push(m),
    )

    expect(warned).toBe(false)
    expect(messages).toHaveLength(0)
  })

  it('does not warn when allow_open_mode is false', () => {
    const messages: string[] = []
    const warned = warnIfDashboardOpenMode(makeConfig({ allowOpenMode: false }), (m) =>
      messages.push(m),
    )

    expect(warned).toBe(false)
    expect(messages).toHaveLength(0)
  })
})

describe('warnIfNoEnforcement', () => {
  function makePolicy(args: {
    readonly ruleCount?: number
    readonly defaultAction?: 'allow' | 'deny'
    readonly dryRun?: boolean
  }) {
    return {
      rules: Array.from({ length: args.ruleCount ?? 0 }, (_, i) => ({ name: `rule-${String(i)}` })),
      defaultAction: args.defaultAction ?? 'allow',
      dryRun: args.dryRun,
    }
  }

  it('warns when zero rules are loaded and the default action is allow', () => {
    const messages: string[] = []
    const warned = warnIfNoEnforcement(makePolicy({ ruleCount: 0, defaultAction: 'allow' }), (m) =>
      messages.push(m),
    )

    expect(warned).toBe(true)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('NOT blocking anything')
    expect(messages[0]).toContain('audit trail')
  })

  it('does not warn when at least one rule is loaded', () => {
    const messages: string[] = []
    const warned = warnIfNoEnforcement(makePolicy({ ruleCount: 1, defaultAction: 'allow' }), (m) =>
      messages.push(m),
    )

    expect(warned).toBe(false)
    expect(messages).toHaveLength(0)
  })

  it('does not warn when the default action is deny', () => {
    const messages: string[] = []
    const warned = warnIfNoEnforcement(makePolicy({ ruleCount: 0, defaultAction: 'deny' }), (m) =>
      messages.push(m),
    )

    expect(warned).toBe(false)
    expect(messages).toHaveLength(0)
  })

  it('does not warn in dry-run mode even with zero rules and default allow', () => {
    const messages: string[] = []
    const warned = warnIfNoEnforcement(
      makePolicy({ ruleCount: 0, defaultAction: 'allow', dryRun: true }),
      (m) => messages.push(m),
    )

    expect(warned).toBe(false)
    expect(messages).toHaveLength(0)
  })
})

describe('warnIfBudgetWindowExceedsRetention', () => {
  function makeConfig(
    budgets: Array<{ name: string; window: string; idle_ttl?: string }>,
    retention = '90d',
  ) {
    return { budgets, audit: { retention } }
  }

  it('warns when a duration window is longer than the retention', () => {
    const messages: string[] = []
    const warned = warnIfBudgetWindowExceedsRetention(
      makeConfig([{ name: 'long-cap', window: '30d' }], '7d'),
      (m) => messages.push(m),
    )

    expect(warned).toBe(true)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('long-cap')
    expect(messages[0]).toContain('window 30d')
    expect(messages[0]).toContain('audit.retention 7d')
  })

  it('warns when a session idle_ttl is longer than the retention', () => {
    const messages: string[] = []
    const warned = warnIfBudgetWindowExceedsRetention(
      makeConfig([{ name: 'sc', window: 'session', idle_ttl: '14d' }], '7d'),
      (m) => messages.push(m),
    )

    expect(warned).toBe(true)
    expect(messages[0]).toContain('idle_ttl 14d')
  })

  it('uses the 24h default idle_ttl for session windows', () => {
    const messages: string[] = []
    const warned = warnIfBudgetWindowExceedsRetention(
      makeConfig([{ name: 'sc', window: 'session' }], '12h'),
      (m) => messages.push(m),
    )

    expect(warned).toBe(true)
    expect(messages[0]).toContain('idle_ttl 24h')
  })

  it('does not warn when every horizon fits inside the retention', () => {
    const messages: string[] = []
    const warned = warnIfBudgetWindowExceedsRetention(
      makeConfig([
        { name: 'daily', window: '24h' },
        { name: 'sc', window: 'session', idle_ttl: '48h' },
      ]),
      (m) => messages.push(m),
    )

    expect(warned).toBe(false)
    expect(messages).toHaveLength(0)
  })

  it('does not warn at exactly the retention bound', () => {
    const messages: string[] = []
    const warned = warnIfBudgetWindowExceedsRetention(
      makeConfig([{ name: 'edge', window: '90d' }], '90d'),
      (m) => messages.push(m),
    )

    expect(warned).toBe(false)
    expect(messages).toHaveLength(0)
  })

  it('warns once per offending budget', () => {
    const messages: string[] = []
    const warned = warnIfBudgetWindowExceedsRetention(
      makeConfig(
        [
          { name: 'a', window: '30d' },
          { name: 'b', window: '20d' },
          { name: 'ok', window: '1h' },
        ],
        '7d',
      ),
      (m) => messages.push(m),
    )

    expect(warned).toBe(true)
    expect(messages).toHaveLength(2)
  })
})

describe('warnIfDashboardSecretLiteral', () => {
  const source = { configPath: '/etc/helio/helio.yaml', interpolatedPaths: [] as readonly string[] }
  function makeConfig(apiSecret: string | undefined, enabled = true) {
    return { dashboard: { enabled, api_secret: apiSecret } }
  }

  it('warns when the secret is a plaintext literal in the file', () => {
    const messages: string[] = []
    const warned = warnIfDashboardSecretLiteral(makeConfig('plain-secret'), source, (m) =>
      messages.push(m),
    )
    expect(warned).toBe(true)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain(
      'dashboard.api_secret is stored as plaintext in /etc/helio/helio.yaml',
    )
    expect(messages[0]).toContain('helio secret')
  })

  it('does not warn for a stored digest', () => {
    const messages: string[] = []
    expect(
      warnIfDashboardSecretLiteral(makeConfig(`sha256:${'a'.repeat(64)}`), source, (m) =>
        messages.push(m),
      ),
    ).toBe(false)
    expect(messages).toHaveLength(0)
  })

  it('does not warn when the value came from the environment', () => {
    const messages: string[] = []
    const fromEnv = { ...source, interpolatedPaths: ['dashboard.api_secret'] }
    expect(
      warnIfDashboardSecretLiteral(makeConfig('plain-secret'), fromEnv, (m) => messages.push(m)),
    ).toBe(false)
    expect(messages).toHaveLength(0)
  })

  it('does not warn when the secret is unset or the dashboard is disabled', () => {
    const messages: string[] = []
    expect(
      warnIfDashboardSecretLiteral(makeConfig(undefined), source, (m) => messages.push(m)),
    ).toBe(false)
    expect(
      warnIfDashboardSecretLiteral(makeConfig('plain-secret', false), source, (m) =>
        messages.push(m),
      ),
    ).toBe(false)
    expect(messages).toHaveLength(0)
  })
})
