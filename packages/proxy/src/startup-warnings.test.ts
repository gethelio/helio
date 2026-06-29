import { describe, it, expect } from 'vitest'
import {
  warnIfWebhookChannelUnreachable,
  warnIfSdkSidebandExposed,
  warnIfDashboardOpenMode,
  warnIfNoEnforcement,
} from './startup-warnings.js'

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
