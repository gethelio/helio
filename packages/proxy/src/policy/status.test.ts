import { describe, it, expect, vi } from 'vitest'
import {
  buildPolicyStatus,
  evaluateReadiness,
  formatReadinessLine,
  parseStatusWindow,
  renderPolicyStatusText,
  DEFAULT_STATUS_WINDOW,
  READINESS_MIN_CALLS,
  READINESS_MIN_TOOL_DOORS,
} from './status.js'
import { classifySurface } from './surface.js'
import type { SurfaceDoor, SurfaceTool } from './surface.js'
import { decide } from './decision-pipeline.js'
import type { DecideInput } from './decision-pipeline.js'
import { compilePolicies } from './parser.js'
import type { PoliciesConfig } from '../config/schema.js'
import type { CompiledPolicy } from './types.js'
import type { PersistedSummary } from '../audit/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function compile(config: Omit<PoliciesConfig, 'dry_run'> & { dry_run?: boolean }): CompiledPolicy {
  return compilePolicies({ dry_run: false, ...config }).policy
}

function tool(
  name: string,
  annotations?: Record<string, unknown>,
  extra: Partial<Pick<SurfaceTool, 'current_annotations' | 'drifted'>> = {},
): SurfaceTool {
  return {
    name,
    annotations: annotations as SurfaceTool['annotations'],
    current_annotations:
      'current_annotations' in extra
        ? extra.current_annotations
        : (annotations as SurfaceTool['annotations']),
    drifted: extra.drifted ?? false,
  }
}

const NOW = new Date('2026-09-21T12:00:00.000Z')

function persisted(overrides: Partial<PersistedSummary> = {}): PersistedSummary {
  return {
    since: '2026-09-21T08:00:00.000Z',
    calls: 0,
    sessions: 0,
    first_seen_in_window: null,
    pairs: [],
    first_seen: null,
    ...overrides,
  }
}

const surfaceDoors: SurfaceDoor[] = [
  {
    kind: 'upstream',
    name: 'crm',
    tools: [
      tool('get_weather', { readOnlyHint: true, destructiveHint: false }),
      tool('send_email', { destructiveHint: false }),
      tool('delete_record', { destructiveHint: true }),
      tool('transfer_funds'),
    ],
  },
]

const twoRules = compile({
  default: 'allow',
  rules: [
    {
      name: 'block-destructive',
      match: { annotations: { destructiveHint: true } },
      action: 'deny',
    },
    { name: 'gate-email', match: { tool: 'send_*' }, action: 'require_approval' },
  ],
})

function status(args: {
  policy?: CompiledPolicy
  doors?: SurfaceDoor[]
  persisted?: PersistedSummary
  window?: string
}) {
  const policy = args.policy ?? twoRules
  const surface = classifySurface({
    doors: args.doors ?? surfaceDoors,
    policy,
    environment: 'production',
  })
  return buildPolicyStatus({
    surface,
    policy,
    persisted: args.persisted ?? persisted(),
    window: args.window ?? DEFAULT_STATUS_WINDOW,
    now: NOW,
  })
}

/** The full DecideInput for one pair, as the forwarder builds it per call. */
function decideInputFor(policy: CompiledPolicy, door: SurfaceDoor, t: SurfaceTool): DecideInput {
  return {
    toolName: t.name,
    toolArguments: undefined,
    sessionId: undefined,
    policy,
    environment: 'production',
    evidenceStore: undefined,
    baselineAnnotations: t.annotations,
    currentAnnotations: t.current_annotations,
    driftEvent: t.drifted
      ? {
          toolName: t.name,
          changes: [
            { aspect: 'annotations', baseline: t.annotations, current: t.current_annotations },
          ],
        }
      : undefined,
    upstream: door.kind === 'upstream' ? door.name : undefined,
  }
}

// ---------------------------------------------------------------------------
// The effective-action fold agrees with decide() on every branch (D4)
// ---------------------------------------------------------------------------

describe('effective action agrees with decide()', () => {
  const cases: Array<{
    label: string
    policy: CompiledPolicy
    tools: SurfaceTool[]
    expected: string
  }> = [
    {
      label: 'default allow, no rule',
      policy: compile({ default: 'allow', rules: [] }),
      tools: [tool('plain')],
      expected: 'allow',
    },
    {
      label: 'default deny, no rule',
      policy: compile({ default: 'deny', rules: [] }),
      tools: [tool('plain')],
      expected: 'deny',
    },
    {
      label: 'flag_destructive: require_approval on an unannotated tool',
      policy: compile({ default: 'allow', flag_destructive: 'require_approval', rules: [] }),
      tools: [tool('plain')],
      expected: 'require_approval',
    },
    {
      label: 'flag_destructive: log on the same tool changes nothing',
      policy: compile({ default: 'allow', flag_destructive: 'log', rules: [] }),
      tools: [tool('plain')],
      expected: 'allow',
    },
    {
      label: 'on_tool_drift: log takes the stricter of baseline and current',
      policy: compile({
        default: 'allow',
        on_tool_drift: 'log',
        rules: [{ match: { annotations: { destructiveHint: true } }, action: 'deny' }],
      }),
      tools: [
        tool(
          'flip',
          { destructiveHint: false },
          { drifted: true, current_annotations: { destructiveHint: true } },
        ),
      ],
      expected: 'deny',
    },
    {
      label: 'on_tool_drift: log, baseline non-destructive, current undefined, flag_destructive',
      policy: compile({
        default: 'allow',
        on_tool_drift: 'log',
        flag_destructive: 'require_approval',
        rules: [],
      }),
      tools: [
        tool('lost', { destructiveHint: false }, { drifted: true, current_annotations: undefined }),
      ],
      expected: 'require_approval',
    },
    {
      label: 'on_tool_drift: log, baseline non-destructive, current destructive, flag_destructive',
      policy: compile({
        default: 'allow',
        on_tool_drift: 'log',
        flag_destructive: 'require_approval',
        rules: [],
      }),
      tools: [
        tool(
          'turned',
          { destructiveHint: false },
          { drifted: true, current_annotations: { destructiveHint: true } },
        ),
      ],
      expected: 'require_approval',
    },
    {
      label: 'on_tool_drift: block (the default) overrides a matched allow',
      policy: compile({ default: 'deny', rules: [{ match: { tool: 'x' }, action: 'allow' }] }),
      tools: [tool('x', { destructiveHint: false }, { drifted: true })],
      expected: 'deny',
    },
    {
      label: 'on_tool_drift: require_approval overrides a matched allow',
      policy: compile({
        default: 'deny',
        on_tool_drift: 'require_approval',
        rules: [{ match: { tool: 'x' }, action: 'allow' }],
      }),
      tools: [tool('x', { destructiveHint: false }, { drifted: true })],
      expected: 'require_approval',
    },
    {
      label: 'policies.dry_run: true keeps a deny rule as deny',
      policy: compile({
        default: 'allow',
        dry_run: true,
        rules: [{ match: { tool: 'x' }, action: 'deny' }],
      }),
      tools: [tool('x')],
      expected: 'deny',
    },
    {
      label: 'a per-rule dry_run action is reported as dry_run',
      policy: compile({ default: 'allow', rules: [{ match: { tool: 'x' }, action: 'dry_run' }] }),
      tools: [tool('x')],
      expected: 'dry_run',
    },
  ]

  for (const c of cases) {
    it(c.label, () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const door: SurfaceDoor = { kind: 'upstream', name: 'crm', tools: c.tools }
        const report = classifySurface({
          doors: [door],
          policy: c.policy,
          environment: 'production',
        })
        for (const t of c.tools) {
          const pair = report.coverage.pairs.find((p) => p.tool === t.name)
          const pipeline = decide(decideInputFor(c.policy, door, t))
          expect(pair?.effective_action, t.name).toBe(pipeline.decision.action)
          expect(pair?.effective_action, t.name).toBe(c.expected)
          expect(pair?.flagged_destructive, t.name).toBe(pipeline.flaggedDestructive)
        }
      } finally {
        errorSpy.mockRestore()
      }
    })
  }

  it('a grounded rule shows its own action while decide() denies a sessionless call', () => {
    const policy = compile({
      default: 'deny',
      rules: [{ match: { tool: 'x' }, action: 'allow', evidence: { requires: ['orders.lookup'] } }],
    })
    const door: SurfaceDoor = { kind: 'upstream', name: 'crm', tools: [tool('x')] }
    const report = classifySurface({ doors: [door], policy, environment: 'production' })
    const pair = report.coverage.pairs[0]
    expect(pair?.effective_action).toBe('allow')
    expect(pair?.effective_source).toBe('rule')
    const pipeline = decide(decideInputFor(policy, door, tool('x')))
    expect(pipeline.decision.action).toBe('deny')
    expect(pipeline.sessionBlocked).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// buildPolicyStatus: the D11 object
// ---------------------------------------------------------------------------

describe('buildPolicyStatus', () => {
  it('assembles the versioned report with the window echoed and the policy block', () => {
    const report = status({ window: '240m' })
    expect(report.schema_version).toBe(1)
    expect(report.generated_at).toBe(NOW.toISOString())
    expect(report.window).toBe('240m')
    expect(report.policy).toEqual({
      rule_count: 2,
      default_action: 'allow',
      dry_run: false,
      flag_destructive: null,
      on_tool_drift: 'block',
      enforces_nothing: false,
    })
    expect(report.surface.pairs).toBe(4)
    expect(report.surface.upstream_count).toBe(1)
    expect(report.coverage.matched).toBe(3)
    expect(report.coverage.by_effective_action.deny).toBe(2)
    expect(report.persisted.window).toBe('240m')
  })

  it('joins the persisted pairs to the surface on door and tool', () => {
    const report = status({
      persisted: persisted({
        calls: 7,
        sessions: 2,
        first_seen_in_window: '2026-09-21T09:00:00.000Z',
        first_seen: '2026-06-23T10:00:00.000Z',
        pairs: [
          { tool_name: 'get_weather', upstream: 'crm', origin: 'mcp', calls: 4 },
          { tool_name: 'send_email', upstream: 'crm', origin: 'mcp', calls: 2 },
          { tool_name: 'post_message', upstream: null, origin: 'openclaw', calls: 1 },
        ],
      }),
    })
    expect(report.persisted).toEqual({
      window: '4h',
      since: '2026-09-21T08:00:00.000Z',
      calls_in_window: 7,
      sessions_in_window: 2,
      tool_doors_called_in_window: 3,
      pairs_called_in_window: [
        { door: { kind: 'upstream', name: 'crm' }, tool: 'get_weather', calls: 4 },
        { door: { kind: 'upstream', name: 'crm' }, tool: 'send_email', calls: 2 },
        { door: { kind: 'adapter', origin: 'openclaw' }, tool: 'post_message', calls: 1 },
      ],
      // get_weather is the only reachable-and-permitted pair and it was called.
      reachable_permitted_never_called_in_window: 0,
      called_not_reachable_in_window: 1,
      first_seen: '2026-06-23T10:00:00.000Z',
    })
  })

  it('counts reachable and permitted pairs never called in the window', () => {
    const report = status({ policy: compile({ default: 'allow', rules: [] }) })
    expect(report.persisted.reachable_permitted_never_called_in_window).toBe(4)
    expect(report.persisted.called_not_reachable_in_window).toBe(0)
  })

  it('maps a singular MCP row to the singular door and an adapter row to its origin', () => {
    const singular: SurfaceDoor[] = [
      {
        kind: 'upstream',
        name: undefined,
        tools: [tool('get_weather', { destructiveHint: false })],
      },
    ]
    const report = status({
      doors: singular,
      policy: compile({ default: 'allow', rules: [] }),
      persisted: persisted({
        calls: 2,
        pairs: [
          { tool_name: 'get_weather', upstream: null, origin: 'mcp', calls: 1 },
          { tool_name: 'get_weather', upstream: null, origin: 'openclaw', calls: 1 },
        ],
      }),
    })
    expect(report.persisted.reachable_permitted_never_called_in_window).toBe(0)
    expect(report.persisted.called_not_reachable_in_window).toBe(1)
    expect(report.persisted.pairs_called_in_window[0]?.door).toEqual({
      kind: 'upstream',
      name: null,
    })
  })
})

// ---------------------------------------------------------------------------
// Readiness (D8)
// ---------------------------------------------------------------------------

describe('evaluateReadiness', () => {
  const nothing = compile({ default: 'allow', rules: [] })
  const calls = (n: number, doors: number) =>
    persisted({
      calls: n,
      pairs: Array.from({ length: doors }, (_, i) => ({
        tool_name: `t${String(i)}`,
        upstream: null,
        origin: 'mcp',
        calls: 1,
      })),
      first_seen: '2026-06-23T10:00:00.000Z',
    })

  it('exports the thresholds the plan settled', () => {
    expect(READINESS_MIN_CALLS).toBe(100)
    expect(READINESS_MIN_TOOL_DOORS).toBe(3)
  })

  it('is not ready at 99 calls across 3 pairs', () => {
    expect(evaluateReadiness(calls(99, 3), nothing).ready).toBe(false)
  })

  it('is not ready at 100 calls across 2 pairs', () => {
    expect(evaluateReadiness(calls(100, 2), nothing).ready).toBe(false)
  })

  it('is ready at 100 calls across 3 pairs', () => {
    const r = evaluateReadiness(calls(100, 3), nothing)
    expect(r).toEqual({
      ready: true,
      suppressed: false,
      calls_in_window: 100,
      tool_doors_called_in_window: 3,
      first_seen: '2026-06-23T10:00:00.000Z',
      thresholds: { min_calls: 100, min_tool_doors: 3 },
    })
  })

  it('is ready at 100 calls across the seven getting-started tools', () => {
    expect(evaluateReadiness(calls(100, 7), nothing).ready).toBe(true)
  })

  it('is suppressed under an allow-only rule, a deny default and dry-run', () => {
    const allowOnly = compile({
      default: 'allow',
      rules: [{ match: { tool: '*' }, action: 'allow' }],
    })
    expect(evaluateReadiness(calls(100, 3), allowOnly).suppressed).toBe(true)
    expect(
      evaluateReadiness(calls(100, 3), compile({ default: 'deny', rules: [] })).suppressed,
    ).toBe(true)
    expect(
      evaluateReadiness(calls(100, 3), compile({ default: 'allow', dry_run: true, rules: [] }))
        .suppressed,
    ).toBe(true)
    expect(evaluateReadiness(calls(100, 3), nothing).suppressed).toBe(false)
  })

  it('formats the once-per-boot line naming helio policy status', () => {
    const r = evaluateReadiness(calls(1851, 600), nothing)
    expect(formatReadinessLine(r, '4h')).toBe(
      'Persisted: 1,851 calls across 600 tool-door pairs in the last 4h (audit rows since 23 Jun 2026). helio policy status lists which tools are called and which have no rule.',
    )
    expect(formatReadinessLine(r, '4h')).not.toContain('generate')
  })
})

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

describe('parseStatusWindow', () => {
  it('defaults to 4h and accepts the config duration grammar between 1m and 30d', () => {
    expect(DEFAULT_STATUS_WINDOW).toBe('4h')
    expect(parseStatusWindow('4h')).toEqual({ ok: true, ms: 4 * 60 * 60 * 1000 })
    expect(parseStatusWindow('240m')).toEqual({ ok: true, ms: 4 * 60 * 60 * 1000 })
    expect(parseStatusWindow('1m')).toEqual({ ok: true, ms: 60_000 })
    expect(parseStatusWindow('30d')).toEqual({ ok: true, ms: 30 * 86_400_000 })
  })

  it('refuses a window under a minute, over thirty days, or not a duration', () => {
    expect(parseStatusWindow('30s').ok).toBe(false)
    expect(parseStatusWindow('31d').ok).toBe(false)
    expect(parseStatusWindow('x').ok).toBe(false)
    expect(parseStatusWindow('')).toEqual({
      ok: false,
      error: 'window must be a duration between 1m and 30d (for example 4h, 240m or 7d)',
    })
  })
})

// ---------------------------------------------------------------------------
// The text report
// ---------------------------------------------------------------------------

describe('renderPolicyStatusText', () => {
  const rich = status({
    doors: [
      ...surfaceDoors,
      { kind: 'upstream', name: 'files', tools: [tool('read_file'), tool('exec')] },
      { kind: 'upstream', name: 'slow', unavailable: 'priming did not complete within 1500ms' },
      {
        kind: 'adapter',
        origin: 'openclaw',
        tools: [tool('post_message', { destructiveHint: false })],
      },
    ],
    persisted: persisted({
      calls: 12,
      sessions: 2,
      first_seen: '2026-06-23T10:00:00.000Z',
      pairs: [
        { tool_name: 'get_weather', upstream: 'crm', origin: 'mcp', calls: 9 },
        { tool_name: 'lookup', upstream: null, origin: 'other', calls: 3 },
      ],
    }),
  })
  const text = renderPolicyStatusText(rich)

  it('carries the surface block in the shared vocabulary', () => {
    expect(text).toContain('Authority surface')
    expect(text).toContain('7 tool-door pairs across 2 upstreams and 1 adapter origin')
    expect(text).toContain('1 annotated destructive')
    expect(text).toContain('3 destructive by MCP default (no destructiveHint set)')
    expect(text).toContain('files: 2 tools, none annotated')
    expect(text).toContain('not primed on slow (priming did not complete within 1500ms)')
  })

  it('carries the coverage block with the effective default and the histogram', () => {
    expect(text).toContain('Policy coverage')
    expect(text).toContain('5 of 7 have a rule that can match them')
    expect(text).toContain('2 fall through to the default: allow')
    expect(text).toMatch(/Effective action: .*deny 4/)
  })

  it('prints the window next to every persisted count', () => {
    const block = text.slice(text.indexOf('Persisted'))
    expect(block).toContain('Persisted (last 4h)')
    expect(block).toContain(
      '12 calls across 2 tool-door pairs, 2 sessions (denied and dry-run calls included)',
    )
    expect(block).toContain('1 reachable and permitted, never called in the last 4h')
    expect(block).toContain('1 called in the last 4h on no primed door')
    expect(block).toContain('audit rows since 23 Jun 2026')
  })

  it('lists which tools are called and which have no rule', () => {
    expect(text).toContain('Tool-door pairs (calls in the last 4h)')
    expect(text).toMatch(/read_file\s+files\s+deny\s+rule "block-destructive"/)
    expect(text).toMatch(/post_message\s+openclaw\s+allow\s+no rule, default allow/)
    expect(text).toMatch(/get_weather\s+crm\s+allow\s+no rule, default allow\s+9/)
  })

  it('states readiness and never uses the words flagged, used or occurred', () => {
    expect(text).toContain('Readiness:')
    expect(text).not.toMatch(/\bflagged\b|\bused\b|\boccurred\b/)
  })

  it('names the conditional dimension the way the startup line does', () => {
    const inputOnly = compile({
      default: 'allow',
      rules: [
        {
          name: 'big-transfer',
          match: { tool: 'transfer_funds', input: { '$.amount': { gt: 1000 } } },
          action: 'require_approval',
        },
      ],
    })
    const text = renderPolicyStatusText(
      status({
        policy: inputOnly,
        doors: [{ kind: 'upstream', name: 'crm', tools: [tool('transfer_funds')] }],
      }),
    )
    expect(text).toContain('1 covered only when arguments match')
    expect(text).not.toContain('arguments or metadata')

    const metadataOnly = compile({
      default: 'allow',
      rules: [
        { name: 'prod-channel', match: { metadata: { channel_id: { eq: 'C1' } } }, action: 'deny' },
      ],
    })
    const adapterText = renderPolicyStatusText(
      status({
        policy: metadataOnly,
        doors: [
          {
            kind: 'adapter',
            origin: 'openclaw',
            tools: [tool('post', { destructiveHint: false })],
          },
        ],
      }),
    )
    expect(adapterText).toContain('1 covered only when metadata matches')
  })

  it('reads usefully against an empty store and no rules', () => {
    const empty = renderPolicyStatusText(
      status({ policy: compile({ default: 'allow', rules: [] }) }),
    )
    expect(empty).toContain('0 of 4 have a rule that can match them')
    expect(empty).toContain('4 fall through to the default: allow')
    expect(empty).toContain('0 calls across 0 tool-door pairs, 0 sessions')
    expect(empty).toContain('4 reachable and permitted, never called in the last 4h')
    expect(empty).toContain('no tool calls persisted yet')
    expect(empty).toContain('Readiness: not yet')
  })
})
