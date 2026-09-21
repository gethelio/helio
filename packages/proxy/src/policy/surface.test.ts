import { describe, it, expect } from 'vitest'
import { classifySurface, formatSurfaceLine, formatCoverageLine } from './surface.js'
import type { SurfaceDoor, SurfaceTool } from './surface.js'
import { compilePolicies } from './parser.js'
import type { PoliciesConfig } from '../config/schema.js'
import type { CompiledPolicy } from './types.js'

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
    current_annotations: extra.current_annotations ?? (annotations as SurfaceTool['annotations']),
    drifted: extra.drifted ?? false,
  }
}

/** The four probe tools of the planning coverage probe plus one uncovered read. */
function crmTools(): SurfaceTool[] {
  return [
    tool('get_weather', { readOnlyHint: true, destructiveHint: false }),
    tool('send_email', { readOnlyHint: false, destructiveHint: false }),
    tool('delete_record', { destructiveHint: true }),
    tool('transfer_funds'),
    tool('lookup_order', { readOnlyHint: true, destructiveHint: false }),
  ]
}

/** Three tools without an annotations object: destructive by MCP default. */
function filesTools(): SurfaceTool[] {
  return [tool('read_file'), tool('write_file'), tool('exec')]
}

const crm: SurfaceDoor = { kind: 'upstream', name: 'crm', tools: crmTools() }
const files: SurfaceDoor = { kind: 'upstream', name: 'files', tools: filesTools() }
const openclaw: SurfaceDoor = {
  kind: 'adapter',
  origin: 'openclaw',
  tools: [tool('post_message', { destructiveHint: false })],
}

/** The six rule shapes of the planning probe plus a seventh metadata rule. */
const probeRules: PoliciesConfig['rules'] = [
  { name: 'r1-name-only', match: { tool: 'delete_*' }, action: 'deny' },
  {
    name: 'r2-input-conditioned',
    match: { tool: 'transfer_funds', input: { '$.amount': { gt: 1000 } } },
    action: 'require_approval',
    approval: { channel: 'dashboard' },
  },
  {
    name: 'r3-environment-scoped',
    match: { tool: 'send_*', environment: 'production' },
    action: 'rate_limit',
    limits: { max_calls: 10, window: '1h' },
  },
  { name: 'r4-upstream-scoped', match: { tool: 'get_*', upstreams: ['crm'] }, action: 'allow' },
  {
    name: 'r5-deny-with-inert-evidence',
    match: { tool: 'transfer_funds' },
    action: 'deny',
    evidence: { requires: ['orders.lookup'] },
  },
  {
    name: 'r6-annotation-only',
    match: { annotations: { destructiveHint: true } },
    action: 'require_approval',
    approval: { channel: 'dashboard' },
  },
  {
    name: 'r7-metadata-only',
    match: { metadata: { channel_id: { eq: 'C_PROD' } } },
    action: 'deny',
  },
]

const probePolicy = compile({ default: 'allow', rules: probeRules })

function classify(doors: readonly SurfaceDoor[], policy: CompiledPolicy = probePolicy) {
  return classifySurface({ doors, policy, environment: 'production' })
}

function pairOf(
  report: ReturnType<typeof classifySurface>,
  door: { kind: 'upstream'; name: string | null } | { kind: 'adapter'; origin: string },
  toolName: string,
) {
  const found = report.coverage.pairs.find(
    (p) =>
      p.tool === toolName &&
      p.door.kind === door.kind &&
      (door.kind === 'upstream'
        ? p.door.kind === 'upstream' && p.door.name === door.name
        : p.door.kind === 'adapter' && p.door.origin === door.origin),
  )
  if (!found) throw new Error(`pair not found: ${toolName}`)
  return found
}

// ---------------------------------------------------------------------------
// classifySurface: the coverage table of the planning probe, row by row
// ---------------------------------------------------------------------------

describe('classifySurface', () => {
  const report = classify([crm, files, openclaw])

  it('counts pairs per door, upstreams, adapter origins and the two destructive classes', () => {
    expect(report.pairs).toBe(9)
    expect(report.upstream_count).toBe(2)
    expect(report.adapter_origin_count).toBe(1)
    expect(report.annotated_destructive).toBe(1)
    expect(report.default_destructive).toBe(4)
    expect(report.annotation_free_doors).toEqual(['files'])
    expect(report.unavailable).toEqual([])
  })

  it('reports each door with its tool, annotated and annotated-destructive counts', () => {
    expect(report.doors).toEqual([
      {
        kind: 'upstream',
        name: 'crm',
        available: true,
        unavailable_reason: null,
        tool_count: 5,
        annotated_count: 4,
        annotated_destructive: 1,
      },
      {
        kind: 'upstream',
        name: 'files',
        available: true,
        unavailable_reason: null,
        tool_count: 3,
        annotated_count: 0,
        annotated_destructive: 0,
      },
      {
        kind: 'adapter',
        origin: 'openclaw',
        available: true,
        unavailable_reason: null,
        tool_count: 1,
        annotated_count: 1,
        annotated_destructive: 0,
      },
    ])
  })

  it('get_weather on crm is matched by the upstream-scoped allow rule', () => {
    const pair = pairOf(report, { kind: 'upstream', name: 'crm' }, 'get_weather')
    expect(pair.status).toBe('matched')
    expect(pair.matched_rule).toEqual({ name: 'r4-upstream-scoped', index: 3, action: 'allow' })
    expect(pair.conditional_rules).toEqual([])
    expect(pair.effective_action).toBe('allow')
    expect(pair.effective_source).toBe('rule')
    expect(pair.destructive).toBe('no')
  })

  it('send_email is matched by the environment-scoped rate_limit rule', () => {
    const pair = pairOf(report, { kind: 'upstream', name: 'crm' }, 'send_email')
    expect(pair.status).toBe('matched')
    expect(pair.matched_rule?.name).toBe('r3-environment-scoped')
    expect(pair.effective_action).toBe('rate_limit')
    expect(pair.effective_source).toBe('rule')
  })

  it('delete_record is matched by the name-only deny rule and is annotated destructive', () => {
    const pair = pairOf(report, { kind: 'upstream', name: 'crm' }, 'delete_record')
    expect(pair.status).toBe('matched')
    expect(pair.matched_rule?.name).toBe('r1-name-only')
    expect(pair.effective_action).toBe('deny')
    expect(pair.destructive).toBe('annotated')
  })

  it('transfer_funds lists the input-conditioned rule ahead of the deciding deny', () => {
    const pair = pairOf(report, { kind: 'upstream', name: 'crm' }, 'transfer_funds')
    expect(pair.status).toBe('matched')
    expect(pair.matched_rule?.name).toBe('r5-deny-with-inert-evidence')
    expect(pair.conditional_rules).toEqual([
      { name: 'r2-input-conditioned', index: 1, action: 'require_approval', on: 'arguments' },
    ])
    expect(pair.effective_action).toBe('deny')
    expect(pair.destructive).toBe('default')
  })

  it('lookup_order on crm is uncovered and falls through to the default', () => {
    const pair = pairOf(report, { kind: 'upstream', name: 'crm' }, 'lookup_order')
    expect(pair.status).toBe('uncovered')
    expect(pair.matched_rule).toBeNull()
    expect(pair.conditional_rules).toEqual([])
    expect(pair.effective_action).toBe('allow')
    expect(pair.effective_source).toBe('default')
  })

  it('a metadata rule is inert on an MCP pair: never conditional', () => {
    const pair = pairOf(report, { kind: 'upstream', name: 'crm' }, 'lookup_order')
    expect(pair.conditional_rules.some((r) => r.on === 'metadata')).toBe(false)
    expect(pair.status).toBe('uncovered')
  })

  it('a metadata rule is conditional on an adapter pair', () => {
    const pair = pairOf(report, { kind: 'adapter', origin: 'openclaw' }, 'post_message')
    expect(pair.status).toBe('conditional')
    expect(pair.matched_rule).toBeNull()
    expect(pair.conditional_rules).toEqual([
      { name: 'r7-metadata-only', index: 6, action: 'deny', on: 'metadata' },
    ])
    expect(pair.effective_action).toBe('allow')
    expect(pair.effective_source).toBe('default')
  })

  it('unannotated tools on files match the annotation-only rule through the MCP default', () => {
    for (const name of ['read_file', 'write_file', 'exec']) {
      const pair = pairOf(report, { kind: 'upstream', name: 'files' }, name)
      expect(pair.status).toBe('matched')
      expect(pair.matched_rule?.name).toBe('r6-annotation-only')
      expect(pair.effective_action).toBe('require_approval')
      expect(pair.destructive).toBe('default')
    }
  })

  it('an upstream-scoped rule is inert on the other door', () => {
    const filesOnly = classify([{ kind: 'upstream', name: 'files', tools: crmTools() }])
    const pair = pairOf(filesOnly, { kind: 'upstream', name: 'files' }, 'get_weather')
    expect(pair.status).toBe('uncovered')
  })

  it('sums the coverage buckets and the effective-action histogram', () => {
    expect(report.coverage.matched).toBe(7)
    expect(report.coverage.conditional).toBe(1)
    expect(report.coverage.uncovered).toBe(1)
    expect(report.coverage.by_effective_action).toEqual({
      allow: 3,
      deny: 2,
      require_approval: 3,
      rate_limit: 1,
      spend_limit: 0,
      dry_run: 0,
    })
  })

  it('a drifted pair keeps its status while its effective action becomes deny from drift', () => {
    const drifted: SurfaceDoor = {
      kind: 'upstream',
      name: 'crm',
      tools: [
        tool(
          'get_weather',
          { readOnlyHint: true, destructiveHint: false },
          { drifted: true, current_annotations: { destructiveHint: true } },
        ),
      ],
    }
    const pair = pairOf(classify([drifted]), { kind: 'upstream', name: 'crm' }, 'get_weather')
    expect(pair.status).toBe('matched')
    expect(pair.matched_rule?.name).toBe('r4-upstream-scoped')
    expect(pair.drifted).toBe(true)
    expect(pair.effective_action).toBe('deny')
    expect(pair.effective_source).toBe('drift')
  })

  it('an unavailable door contributes no pairs and is listed with its reason', () => {
    const unavailable: SurfaceDoor = {
      kind: 'upstream',
      name: 'files',
      unavailable: 'upstream returned HTTP 500 to tools/list (session/initialize may be required)',
    }
    const partial = classify([crm, unavailable])
    expect(partial.pairs).toBe(5)
    expect(partial.upstream_count).toBe(1)
    expect(partial.unavailable).toEqual([
      {
        name: 'files',
        reason: 'upstream returned HTTP 500 to tools/list (session/initialize may be required)',
      },
    ])
    expect(partial.doors[1]).toEqual({
      kind: 'upstream',
      name: 'files',
      available: false,
      unavailable_reason:
        'upstream returned HTTP 500 to tools/list (session/initialize may be required)',
      tool_count: 0,
      annotated_count: 0,
      annotated_destructive: 0,
    })
  })

  it('a singular door reports a null name and carries its label into the unavailable list', () => {
    const singular = classify([
      { kind: 'upstream', name: undefined, label: 'http://127.0.0.1:1/mcp', unavailable: 'boom' },
    ])
    expect(singular.unavailable).toEqual([{ name: 'http://127.0.0.1:1/mcp', reason: 'boom' }])
    const primed = classify([
      { kind: 'upstream', name: undefined, label: 'http://127.0.0.1:1/mcp', tools: crmTools() },
    ])
    expect(primed.doors[0]?.kind === 'upstream' && primed.doors[0].name).toBeNull()
    const pair = pairOf(primed, { kind: 'upstream', name: null }, 'get_weather')
    // r4 is upstream-scoped and inert in singular mode.
    expect(pair.status).toBe('uncovered')
  })

  it('holds no reference to the input annotation objects', () => {
    const tools = crmTools()
    const report = classify([{ kind: 'upstream', name: 'crm', tools }])
    const before = JSON.stringify(report)
    const mutable = tools[0]?.annotations as Record<string, unknown>
    mutable['destructiveHint'] = true
    mutable['readOnlyHint'] = false
    expect(JSON.stringify(report)).toBe(before)
  })
})

// ---------------------------------------------------------------------------
// The formatters are the vocabulary (D5 states 1 to 5)
// ---------------------------------------------------------------------------

describe('formatSurfaceLine and formatCoverageLine', () => {
  it('state 1: annotated surface, one upstream', () => {
    const report = classify([{ kind: 'upstream', name: 'crm', tools: crmTools() }])
    expect(formatSurfaceLine(report)).toBe(
      'Authority surface: 5 tool-door pairs across 1 upstream, 1 annotated destructive',
    )
    expect(formatCoverageLine(report)).toBe(
      'Policy coverage: 4 of 5 have a rule that can match them, default allow',
    )
  })

  it('state 1 with a conditional pair appends the argument-only count', () => {
    const inputRule = probeRules[1]
    if (!inputRule) throw new Error('fixture')
    const report = classify(
      [{ kind: 'upstream', name: 'crm', tools: [tool('transfer_funds')] }],
      compile({ default: 'deny', rules: [inputRule] }),
    )
    expect(formatCoverageLine(report)).toBe(
      'Policy coverage: 0 of 1 have a rule that can match them, 1 covered only when arguments match, default deny',
    )
  })

  it('state 2: no annotations on any door', () => {
    const report = classify([files])
    expect(formatSurfaceLine(report)).toBe(
      'Authority surface: 3 tool-door pairs across 1 upstream, none annotated',
    )
    expect(formatCoverageLine(report)).toBe(
      'Policy coverage: 3 of 3 have a rule that can match them, default allow',
    )
  })

  it('state 3: a mix counts only explicit destructiveHint: true baselines', () => {
    const report = classify([crm, files])
    expect(formatSurfaceLine(report)).toBe(
      'Authority surface: 8 tool-door pairs across 2 upstreams, 1 annotated destructive',
    )
    expect(formatCoverageLine(report)).toBe(
      'Policy coverage: 7 of 8 have a rule that can match them, default allow',
    )
  })

  it('names adapter origins on the surface line when any adapter has called', () => {
    const report = classify([crm, openclaw])
    expect(formatSurfaceLine(report)).toBe(
      'Authority surface: 6 tool-door pairs across 1 upstream and 1 adapter origin, 1 annotated destructive',
    )
    expect(formatCoverageLine(report)).toBe(
      'Policy coverage: 4 of 6 have a rule that can match them, 1 covered only when metadata matches, default allow',
    )
  })

  it('state 4: a door not primed at print time gets its own line and the counts cover the rest', () => {
    const report = classify([
      crm,
      {
        kind: 'upstream',
        name: 'files',
        unavailable:
          'upstream returned HTTP 500 to tools/list (session/initialize may be required)',
      },
    ])
    expect(formatSurfaceLine(report)).toBe(
      'Authority surface: 5 tool-door pairs across 1 upstream, 1 annotated destructive\n' +
        'Authority surface: not primed on files (upstream returned HTTP 500 to tools/list (session/initialize may be required)). helio policy status reports coverage once priming succeeds.',
    )
    expect(formatCoverageLine(report)).toBe(
      'Policy coverage: 4 of 5 have a rule that can match them, default allow',
    )
  })

  it('state 4 with zero primed doors prints only the not-primed line and no coverage line', () => {
    const report = classify([
      {
        kind: 'upstream',
        name: undefined,
        label: 'http://127.0.0.1:47003/mcp',
        unavailable: 'priming did not complete within 1500ms',
      },
    ])
    expect(formatSurfaceLine(report)).toBe(
      'Authority surface: not primed on http://127.0.0.1:47003/mcp (priming did not complete within 1500ms). helio policy status reports coverage once priming succeeds.',
    )
    expect(formatCoverageLine(report)).toBeUndefined()
  })

  it('state 5: zero tools on every primed door omits the coverage line', () => {
    const report = classify([{ kind: 'upstream', name: undefined, tools: [] }])
    expect(formatSurfaceLine(report)).toBe('Authority surface: 0 tool-door pairs across 1 upstream')
    expect(formatCoverageLine(report)).toBeUndefined()
  })

  it('never uses the words flagged, used or occurred', () => {
    const report = classify([crm, files, openclaw])
    const text = `${formatSurfaceLine(report)}\n${formatCoverageLine(report) ?? ''}`
    expect(text).not.toMatch(/flagged|used|occurred/)
  })
})
