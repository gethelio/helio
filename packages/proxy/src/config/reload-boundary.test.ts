import { describe, it, expect } from 'vitest'
import { helioConfigSchema, parseDuration, type HelioConfig } from './schema.js'
import { diffReloadBoundary } from './reload-boundary.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseConfig(config: Record<string, unknown>): HelioConfig {
  return helioConfigSchema.parse(config)
}

function minimalConfig(overrides: Record<string, unknown> = {}): HelioConfig {
  return parseConfig({
    version: '1',
    upstream: { url: 'http://localhost:8080/mcp' },
    dashboard: { enabled: false },
    ...overrides,
  })
}

// ---------------------------------------------------------------------------
// diffReloadBoundary
// ---------------------------------------------------------------------------

describe('diffReloadBoundary', () => {
  it('does not require restart when budgets change (they hot-reload)', () => {
    const previous = minimalConfig()
    const next = minimalConfig({
      budgets: [
        {
          name: 'cap',
          limit: 50,
          currency: 'USD',
          window: '24h',
          contributors: [{ match: { tool: 'stripe_*' }, field: '$.amount' }],
        },
      ],
    })

    const diff = diffReloadBoundary(previous, next)
    expect(diff.restartRequiredPaths).toEqual([])
  })

  it('does not require restart when only policy rules change', () => {
    const previous = minimalConfig()
    const next = minimalConfig({
      policies: {
        rules: [{ match: { tool: 'send_email' }, action: 'deny' }],
      },
    })

    const diff = diffReloadBoundary(previous, next)
    expect(diff.restartRequiredPaths).toEqual([])
  })

  it('does not require restart when only policy defaults/flags change', () => {
    const previous = minimalConfig()
    const next = minimalConfig({
      policies: {
        default: 'deny',
        flag_destructive: 'log',
        dry_run: true,
      },
    })

    const diff = diffReloadBoundary(previous, next)
    expect(diff.restartRequiredPaths).toEqual([])
  })

  it('treats policies.hot_reload undefined and true as equivalent', () => {
    const previous = minimalConfig()
    const next = minimalConfig({
      policies: {
        hot_reload: true,
      },
    })

    const diff = diffReloadBoundary(previous, next)
    expect(diff.restartRequiredPaths).toEqual([])
  })

  it('requires restart when policies.hot_reload effective value changes', () => {
    const previous = minimalConfig()
    const next = minimalConfig({
      policies: {
        hot_reload: false,
      },
    })

    const diff = diffReloadBoundary(previous, next)
    expect(diff.restartRequiredPaths).toEqual(['policies.hot_reload'])
  })

  it('requires restart when environment changes', () => {
    const previous = minimalConfig({
      environment: 'production',
    })
    const next = minimalConfig({
      environment: 'staging',
    })

    const diff = diffReloadBoundary(previous, next)
    expect(diff.restartRequiredPaths).toEqual(['environment'])
  })

  it('requires restart when upstream changes', () => {
    const previous = minimalConfig()
    const next = minimalConfig({
      upstream: { url: 'http://localhost:9090/mcp' },
    })

    const diff = diffReloadBoundary(previous, next)
    expect(diff.restartRequiredPaths).toEqual(['upstream'])
  })

  it('returns multiple paths in stable order', () => {
    const previous = minimalConfig()
    const next = minimalConfig({
      listen: { port: 4000, host: '127.0.0.1' },
      audit: { path: './other-audit.db' },
    })

    const diff = diffReloadBoundary(previous, next)
    expect(diff.restartRequiredPaths).toEqual(['listen', 'audit'])
  })
})

// ---------------------------------------------------------------------------
// findUnroutableApprovalReferences (issue #14 break-glass, hot-reload guard)
// ---------------------------------------------------------------------------

import { findUnroutableApprovalReferences } from './reload-boundary.js'
import { compilePolicies } from '../policy/parser.js'
import { compileBudgets } from '../budget/parser.js'
import type { BudgetConfig, PoliciesConfig } from './schema.js'

describe('findUnroutableApprovalReferences', () => {
  const runtime = (
    entries: Array<[string, string]> = [],
    dashboardEnabled = true,
  ): {
    channelTypes: ReadonlyMap<string, string>
    dashboardEnabled: boolean
    defaultApprovalTimeoutMs: number
  } => ({
    channelTypes: new Map<string, string>([['dashboard', 'dashboard'], ...entries]),
    dashboardEnabled,
    defaultApprovalTimeoutMs: 300_000,
  })
  const compileRules = (rules: PoliciesConfig['rules']) =>
    compilePolicies({ default: 'allow', dry_run: false, rules }).policy
  const bgBudget = (overrides: Partial<BudgetConfig> = {}): BudgetConfig => ({
    name: 'cap',
    limit: 10,
    currency: 'USD',
    window: '24h',
    key: 'global',
    on_exceed: 'require_approval',
    contributors: [{ match: { tool: 'stripe_*' }, field: '$.amount' }],
    ...overrides,
  })

  it('accepts references that resolve in the RUNNING registry', () => {
    const policy = compileRules([
      { match: { tool: '*' }, action: 'require_approval', approval: { channel: 'oncall' } },
    ])
    const budgets = compileBudgets([bgBudget({ approval: { channel: 'oncall' } })])
    expect(
      findUnroutableApprovalReferences(policy, budgets, runtime([['oncall', 'slack']])),
    ).toEqual([])
  })

  it('flags a rule channel the running process never registered', () => {
    // The new FILE may define the channel, but channels are startup-bound:
    // the running router would drop every notification for it.
    const policy = compileRules([
      { match: { tool: '*' }, action: 'require_approval', approval: { channel: 'new-chan' } },
    ])
    const found = findUnroutableApprovalReferences(policy, [], runtime())
    expect(found).toHaveLength(1)
    expect(found[0]).toContain('new-chan')
  })

  it('flags budget channels and escalation delegates missing from the registry', () => {
    const budgets = compileBudgets([
      bgBudget({
        approval: { channel: 'oncall', delegates: ['ghost'], escalation_after: '60s' },
      }),
    ])
    const found = findUnroutableApprovalReferences(
      compileRules([]),
      budgets,
      runtime([['oncall', 'slack']]),
    )
    expect(found).toHaveLength(1)
    expect(found[0]).toContain('ghost')
  })

  it('flags dashboard-routed budgets when the running dashboard is disabled', () => {
    const fallback = findUnroutableApprovalReferences(
      compileRules([]),
      compileBudgets([bgBudget()]),
      runtime([], false),
    )
    expect(fallback).toHaveLength(1)
    expect(fallback[0]).toContain('dashboard')
  })

  it('ignores dashboard delegates whose escalation can never fire', () => {
    const budgets = compileBudgets([
      // No escalation_after: the delegate list is dead config at runtime.
      bgBudget({ approval: { channel: 'oncall', delegates: ['dashboard'] } }),
    ])
    expect(
      findUnroutableApprovalReferences(
        compileRules([]),
        budgets,
        runtime([['oncall', 'slack']], false),
      ),
    ).toEqual([])
  })

  it('flags implicit dashboard routes when the running dashboard is disabled', () => {
    // A bare require_approval rule defaults to the dashboard channel; with
    // the dashboard off its MCP tickets could only time out. Same for the
    // flag_destructive / on_tool_drift escalations (always dashboard).
    const bareRule = compileRules([{ match: { tool: '*' }, action: 'require_approval' }])
    expect(findUnroutableApprovalReferences(bareRule, [], runtime([], false))).toHaveLength(1)

    const flagDestructive = compilePolicies({
      default: 'allow',
      dry_run: false,
      flag_destructive: 'require_approval',
      rules: [],
    }).policy
    expect(findUnroutableApprovalReferences(flagDestructive, [], runtime([], false))).toHaveLength(
      1,
    )

    const onDrift = compilePolicies({
      default: 'allow',
      dry_run: false,
      on_tool_drift: 'require_approval',
      rules: [],
    }).policy
    expect(findUnroutableApprovalReferences(onDrift, [], runtime([], false))).toHaveLength(1)

    // With the dashboard running, all three are fine.
    expect(findUnroutableApprovalReferences(bareRule, [], runtime())).toEqual([])
    expect(findUnroutableApprovalReferences(flagDestructive, [], runtime())).toEqual([])
    expect(findUnroutableApprovalReferences(onDrift, [], runtime())).toEqual([])
  })

  it('flags an explicit dashboard-type rule channel when the dashboard is disabled', () => {
    const policy = compileRules([
      { match: { tool: '*' }, action: 'require_approval', approval: { channel: 'ops' } },
    ])
    expect(
      findUnroutableApprovalReferences(policy, [], runtime([['ops', 'dashboard']], false)),
    ).toHaveLength(1)
  })

  it('treats non-viable escalation timers as inert for delegate checks', () => {
    // The router only escalates when 0 < escalation_after < the effective
    // timeout; anything else never fires, so its delegates must not reject
    // a reload.
    const zero = compileBudgets([
      bgBudget({
        approval: { channel: 'oncall', delegates: ['ghost'], escalation_after: '0s' },
      }),
    ])
    expect(
      findUnroutableApprovalReferences(compileRules([]), zero, runtime([['oncall', 'slack']])),
    ).toEqual([])

    const tooLate = compileBudgets([
      bgBudget({
        approval: {
          channel: 'oncall',
          timeout: '60s',
          delegates: ['ghost'],
          escalation_after: '60s',
        },
      }),
    ])
    expect(
      findUnroutableApprovalReferences(compileRules([]), tooLate, runtime([['oncall', 'slack']])),
    ).toEqual([])

    // Same timer against the ROUTER DEFAULT timeout when the budget sets none.
    const viaDefault = compileBudgets([
      bgBudget({
        approval: { channel: 'oncall', delegates: ['ghost'], escalation_after: '600s' },
      }),
    ])
    // default timeout 300s → 600s never fires → inert.
    expect(
      findUnroutableApprovalReferences(
        compileRules([]),
        viaDefault,
        runtime([['oncall', 'slack']]),
      ),
    ).toEqual([])
  })

  it('skips channel checks for metadata-bearing (sideband-only) rules', () => {
    // A rule with match.metadata never matches on the MCP path, and its
    // sideband tickets are native — no channel is ever notified. Requiring
    // runtime registry membership would spuriously reject the reload.
    const policy = compileRules([
      {
        match: { metadata: { channel_id: 'C1' } },
        action: 'require_approval',
        approval: { channel: 'new-chan' },
      },
    ])
    expect(findUnroutableApprovalReferences(policy, [], runtime([], false))).toEqual([])
  })

  it('ignores deny budgets and rules without approval config', () => {
    const policy = compileRules([{ match: { tool: '*' }, action: 'allow' }])
    const budgets = compileBudgets([bgBudget({ on_exceed: 'deny', approval: undefined })])
    expect(findUnroutableApprovalReferences(policy, budgets, runtime([], false))).toEqual([])
  })
})

describe('startup validation and the reload guard agree (issue #152)', () => {
  // Same file, two judges: the schema's startup check, and the reload guard
  // run against the surface THIS file would boot. A verdict mismatch means
  // one side's routing semantics drifted from the other — exactly the
  // asymmetry issue #152 closed. (Direction is pinned too, so the matrix
  // cannot "agree" by both being wrong.)
  const slackChannel = {
    type: 'slack',
    bot_token: 'xoxb-123',
    signing_secret: 'abc123',
    channel: '#approvals',
  }

  interface AgreementCase {
    name: string
    accepted: boolean
    policies?: Partial<PoliciesConfig>
    budgets?: unknown[]
    approval?: Record<string, unknown>
    dashboard?: Record<string, unknown>
  }

  const cases: AgreementCase[] = [
    {
      name: 'bare require_approval rule (dashboard fallback)',
      accepted: false,
      policies: { rules: [{ match: { tool: '*' }, action: 'require_approval' }] },
    },
    {
      name: 'explicit dashboard channel',
      accepted: false,
      policies: {
        rules: [
          { match: { tool: '*' }, action: 'require_approval', approval: { channel: 'dashboard' } },
        ],
      },
    },
    {
      name: 'named dashboard-type channel',
      accepted: false,
      policies: {
        rules: [{ match: { tool: '*' }, action: 'require_approval', approval: { channel: 'ops' } }],
      },
      approval: { channels: [{ type: 'dashboard', name: 'ops' }] },
    },
    {
      name: 'slack-routed rule',
      accepted: true,
      policies: {
        rules: [
          { match: { tool: '*' }, action: 'require_approval', approval: { channel: 'slack' } },
        ],
      },
      approval: { channels: [slackChannel] },
    },
    {
      name: 'viable dashboard delegate behind slack',
      accepted: false,
      policies: {
        rules: [
          {
            match: { tool: '*' },
            action: 'require_approval',
            approval: { channel: 'slack', delegates: ['dashboard'], escalation_after: '60s' },
          },
        ],
      },
      approval: { channels: [slackChannel] },
    },
    {
      // Pins the timeout-RESOLUTION clause across both judges: 600s is
      // inert against the 300s global default but viable under the
      // rule-level 900s ticket. A one-sided bug in
      // `rule.approval?.timeout ?? cfg.approval.timeout` vs the guard's
      // compiled timeoutMs fails exactly here.
      name: 'viable dashboard delegate under a rule-level timeout',
      accepted: false,
      policies: {
        rules: [
          {
            match: { tool: '*' },
            action: 'require_approval',
            approval: {
              channel: 'slack',
              delegates: ['dashboard'],
              escalation_after: '600s',
              timeout: '900s',
            },
          },
        ],
      },
      approval: { channels: [slackChannel] },
    },
    {
      name: 'inert dashboard delegate (no escalation timer)',
      accepted: true,
      policies: {
        rules: [
          {
            match: { tool: '*' },
            action: 'require_approval',
            approval: { channel: 'slack', delegates: ['dashboard'] },
          },
        ],
      },
      approval: { channels: [slackChannel] },
    },
    {
      name: 'metadata-gated (sideband-only) rule',
      accepted: true,
      policies: {
        rules: [{ match: { metadata: { channel_id: 'C123' } }, action: 'require_approval' }],
      },
    },
    {
      name: 'flag_destructive escalation',
      accepted: false,
      policies: { flag_destructive: 'require_approval', rules: [] },
    },
    {
      name: 'on_tool_drift escalation',
      accepted: false,
      policies: { on_tool_drift: 'require_approval', rules: [] },
    },
    {
      name: 'budget break-glass dashboard fallback (existing check, same matrix)',
      accepted: false,
      budgets: [
        {
          name: 'cap',
          limit: 10,
          currency: 'USD',
          window: '24h',
          key: 'global',
          on_exceed: 'require_approval',
          contributors: [{ match: { tool: 'stripe_*' }, field: '$.amount' }],
        },
      ],
    },
    {
      name: 'everything accepted with the dashboard enabled',
      accepted: true,
      policies: {
        flag_destructive: 'require_approval',
        on_tool_drift: 'require_approval',
        rules: [{ match: { tool: '*' }, action: 'require_approval' }],
      },
      dashboard: { enabled: true, api_secret: 'unit-test-secret' },
    },
  ]

  it.each(cases)('$name', (c) => {
    const raw = {
      version: '1',
      upstream: { url: 'http://localhost:8080/mcp' },
      dashboard: c.dashboard ?? { enabled: false, api_secret: 'unit-test-secret' },
      policies: c.policies ?? {},
      budgets: c.budgets ?? [],
      approval: c.approval ?? {},
    }
    const startupAccepted = helioConfigSchema.safeParse(raw).success

    const compiled = compilePolicies({
      default: 'allow',
      dry_run: false,
      ...(c.policies ?? {}),
      rules: c.policies?.rules ?? [],
    }).policy
    const budgets = compileBudgets((c.budgets ?? []) as BudgetConfig[])
    const channelTypes = new Map<string, string>([['dashboard', 'dashboard']])
    for (const ch of (c.approval?.['channels'] as
      | Array<{ type: string; name?: string }>
      | undefined) ?? []) {
      channelTypes.set(ch.name ?? ch.type, ch.type)
    }
    const guardAccepted =
      findUnroutableApprovalReferences(compiled, budgets, {
        channelTypes,
        dashboardEnabled: (raw.dashboard as { enabled?: boolean }).enabled ?? true,
        defaultApprovalTimeoutMs: parseDuration('300s'),
      }).length === 0

    expect(startupAccepted).toBe(c.accepted)
    expect(guardAccepted).toBe(c.accepted)
  })
})
