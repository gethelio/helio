import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import {
  CANDIDATE_SENSITIVITY_LINE,
  buildGenerationReport,
  renderGenerationText,
} from './report.js'
import type { GenerationReport } from './report.js'
import { buildGenerationModel } from './model.js'
import type { GenerationModel } from './model.js'
import type { GenerationDefinition } from './classify.js'
import type { PersistedPair, PersistedSummary } from '../audit/types.js'
import { parseConfigSource } from '../config/loader.js'

// ---------------------------------------------------------------------------
// Fixtures (the model suite's shapes, reused)
// ---------------------------------------------------------------------------

const SECRET = `sha256:${'ab'.repeat(32)}`
const NOW = new Date('2026-10-12T12:00:00.000Z')

function source(options: { readonly policies?: string; readonly dashboard?: string } = {}) {
  const head =
    "version: '1'\nupstream:\n  url: 'http://localhost:8080/mcp'\n  transport: streamable-http\n"
  const policies = options.policies ?? 'policies:\n  default: allow\n  rules: []\n'
  const dashboard = options.dashboard ?? `dashboard:\n  enabled: true\n  api_secret: '${SECRET}'\n`
  const raw = `${head}${policies}${dashboard}`
  const sha256 = createHash('sha256').update(raw).digest('hex')
  return { raw, sha256, config: parseConfigSource({ raw, sha256 }, 'x.yaml', {}).config }
}

function def(
  overrides: Partial<GenerationDefinition> & { readonly name: string },
): GenerationDefinition {
  return {
    description: 'Read the complete contents of a file',
    annotations: { readOnlyHint: true, destructiveHint: false },
    input_keys: ['$.path'],
    ...overrides,
  }
}

const DELETE_RECORD = def({
  name: 'delete_record',
  description: 'Delete a record',
  annotations: { destructiveHint: true },
  input_keys: ['$.id'],
})

function observed(
  rows: ReadonlyArray<Partial<PersistedPair> & { readonly tool_name: string }>,
): PersistedSummary {
  const pairs = rows.map((row) => ({ upstream: null, origin: 'mcp', calls: 1, ...row }))
  const calls = pairs.reduce((sum, p) => sum + p.calls, 0)
  return {
    since: '1970-01-01T00:00:00.000Z',
    calls,
    sessions: calls === 0 ? 0 : 1,
    first_seen_in_window: calls === 0 ? null : '2026-10-01T10:00:00.000Z',
    last_seen_in_window: calls === 0 ? null : '2026-10-02T10:30:00.000Z',
    pairs,
    first_seen: calls === 0 ? null : '2026-10-01T10:00:00.000Z',
  }
}

function model(args: {
  readonly source?: ReturnType<typeof source>
  readonly tools: readonly GenerationDefinition[]
  readonly observed?: PersistedSummary
}): GenerationModel {
  return buildGenerationModel({
    source: args.source ?? source(),
    doors: [{ name: undefined, tools: args.tools }],
    observed: args.observed ?? observed([]),
  })
}

function report(m: GenerationModel): GenerationReport {
  return buildGenerationReport(m, {
    window: { since: null, label: 'whole trail within retention' },
    annotationSource: 'proxy',
    now: NOW,
    helioVersion: '0.16.0',
  })
}

function text(m: GenerationModel): string {
  return renderGenerationText(report(m))
}

function headings(rendered: string): string[] {
  return rendered.split('\n').filter((line) => line !== '' && !line.startsWith(' '))
}

/** One model with six of the dispositions: written, needs_dashboard_secret, needs_decision, eligible_unobserved, kept, unmatchable. */
function everything(): GenerationModel {
  const long = 'a'.repeat(65537)
  return model({
    source: source({
      policies:
        'policies:\n  default: allow\n  rules:\n    - name: block-destructive\n      match:\n        annotations:\n          destructiveHint: true\n      action: deny\n',
      dashboard: 'dashboard:\n  enabled: true\n  allow_open_mode: true\n',
    }),
    tools: [
      def({ name: 'read_a' }),
      def({ name: 'read_unseen' }),
      def({
        name: 'write_b',
        description: 'Write b',
        annotations: { readOnlyHint: false, destructiveHint: false },
      }),
      def({ name: 'purge_c', description: 'Purge c', annotations: { destructiveHint: false } }),
      DELETE_RECORD,
      def({ name: long }),
    ],
    observed: observed([
      { tool_name: 'read_a', calls: 4 },
      { tool_name: 'write_b', calls: 1 },
      { tool_name: 'purge_c', calls: 2 },
      { tool_name: 'delete_record', calls: 3 },
      { tool_name: long, calls: 1 },
    ]),
  })
}

// ---------------------------------------------------------------------------
// Sections and their order
// ---------------------------------------------------------------------------

describe('renderGenerationText sections', () => {
  it('prints every section in class-first order when every disposition is present', () => {
    const rendered = text(everything())
    expect(headings(rendered)).toEqual([
      'Policy coverage',
      'Generated candidate',
      'Policy coverage (candidate)',
      'Needs dashboard.api_secret',
      'Needs your decision',
      'Eligible, not yet observed',
      'Kept',
      'Could not be written',
      'Observed (whole trail within retention)',
    ])
    expect(rendered).toContain(
      'Generated candidate\n  1 rule\n  read_a  upstream  allow  confident read  name, hint and description agree  observed 4 times\n',
    )
    expect(rendered).toContain(`\n  ${CANDIDATE_SENSITIVITY_LINE}\n`)
    expect(rendered).toContain(
      'Needs dashboard.api_secret\n  dashboard.api_secret is required when any rule uses require_approval. Run helio secret and set the printed digest under dashboard.api_secret.\n  purge_c  upstream  confident restrict  destroy-class name  observed 2 times\n',
    )
    expect(rendered).toContain(
      'Needs your decision\n  write_b  upstream  observed once  write-class name\n',
    )
    expect(rendered).toContain(
      'Eligible, not yet observed\n  read_unseen  upstream  confident read  name, hint and description agree\n',
    )
    expect(rendered).toContain(
      'Kept\n  delete_record  upstream  kept (source rule "block-destructive")  confident restrict  destructiveHint: true  observed 3 times\n',
    )
    expect(rendered).toContain(
      `Could not be written\n  ${'a'.repeat(60)}... (65537 characters) cannot be named by a match.tool pattern: the glob engine refuses it; write its rule by hand\n`,
    )
    expect(rendered).toContain(
      'Observed (whole trail within retention)\n  11 calls across 5 tool-door pairs\n  first call 2026-10-01 10:00 UTC, last call 2026-10-02 10:30 UTC',
    )
    expect(rendered.endsWith('\n')).toBe(false)
  })

  it('names the enabled heading when the dashboard is disabled with a secret', () => {
    const m = model({
      source: source({ dashboard: `dashboard:\n  enabled: false\n  api_secret: '${SECRET}'\n` }),
      tools: [DELETE_RECORD],
      observed: observed([{ tool_name: 'delete_record' }]),
    })
    const rendered = text(m)
    expect(headings(rendered)).toContain('Needs dashboard.enabled')
    expect(rendered).toContain(
      'Needs dashboard.enabled\n  This rule would route approvals to the dashboard channel, but dashboard.enabled is false. Enable the dashboard or route approval.channel to a Slack channel.\n  delete_record  upstream  confident restrict  destructiveHint: true  observed once\n',
    )
    expect(rendered).not.toContain('Needs dashboard.api_secret')
  })

  it('omits empty sections, the candidate block and the sensitivity line when nothing was written', () => {
    const m = model({
      tools: [
        def({ name: 'write_b', description: 'Write b', annotations: { readOnlyHint: false } }),
      ],
      observed: observed([{ tool_name: 'write_b', calls: 2 }]),
    })
    const rendered = text(m)
    expect(headings(rendered)).toEqual([
      'Policy coverage',
      'Needs your decision',
      'Observed (whole trail within retention)',
    ])
    expect(rendered).not.toContain('Generated candidate')
    expect(rendered).not.toContain('(candidate)')
    expect(rendered).not.toContain(CANDIDATE_SENSITIVITY_LINE)
    expect(report(m).candidate).toBeNull()
  })

  it('words the calls column as never observed, once, 2 times and 3 times, never 1 times', () => {
    const tools = [0, 1, 2, 3].map((n) =>
      def({
        name: `write_${String(n)}`,
        description: 'Write it',
        annotations: { readOnlyHint: false },
      }),
    )
    const rendered = text(
      model({
        tools,
        observed: observed([
          { tool_name: 'write_1', calls: 1 },
          { tool_name: 'write_2', calls: 2 },
          { tool_name: 'write_3', calls: 3 },
        ]),
      }),
    )
    expect(rendered).toMatch(/\n {2}write_0 {2}upstream {2}never observed {4}write-class name\n/)
    expect(rendered).toMatch(/\n {2}write_1 {2}upstream {2}observed once {5}write-class name\n/)
    expect(rendered).toMatch(/\n {2}write_2 {2}upstream {2}observed 2 times {2}write-class name\n/)
    expect(rendered).toMatch(/\n {2}write_3 {2}upstream {2}observed 3 times {2}write-class name\n/)
    expect(rendered).not.toContain('1 times')
  })

  it('reads the deny default in the coverage block of a default: deny source', () => {
    const rendered = text(
      model({
        source: source({ policies: 'policies:\n  default: deny\n  rules: []\n' }),
        tools: [def({ name: 'read_a' })],
        observed: observed([{ tool_name: 'read_a' }]),
      }),
    )
    expect(rendered).toContain(
      'Policy coverage\n  0 of 1 have a rule that can match them\n  1 fall through to the default: deny\n  Effective action: deny 1\n  on_tool_drift: block\n',
    )
    expect(rendered).toContain(
      'Policy coverage (candidate)\n  1 of 1 have a rule that can match them\n  0 fall through to the default: deny\n  Effective action: allow 1\n  on_tool_drift: block\n',
    )
  })

  it('prints forty needs-decision pairs in full, none truncated', () => {
    const tools = Array.from({ length: 40 }, (_, i) =>
      def({
        name: `write_${String(i).padStart(2, '0')}`,
        description: 'Write it',
        annotations: { readOnlyHint: false },
      }),
    )
    const rendered = text(
      model({
        tools,
        observed: observed(tools.map((t, i) => ({ tool_name: t.name, calls: i + 1 }))),
      }),
    )
    const section = rendered.slice(
      rendered.indexOf('Needs your decision'),
      rendered.indexOf('\n\nObserved'),
    )
    expect(section.split('\n').filter((line) => line.startsWith('  write_'))).toHaveLength(40)
    for (const t of tools) expect(section).toContain(`  ${t.name}  `)
  })

  it('orders a section by class and reason, then door, then tool, and never by calls', () => {
    const rendered = text(
      model({
        tools: [
          def({ name: 'read_q', description: 'Returns q', input_keys: ['$.q.sql'] }),
          def({ name: 'zebra_x', description: 'Zebra' }),
          def({ name: 'alpha_x', description: 'Alpha' }),
          def({ name: 'write_w', description: 'Write w', annotations: { readOnlyHint: false } }),
        ],
        observed: observed([
          { tool_name: 'read_q', calls: 1 },
          { tool_name: 'zebra_x', calls: 500 },
          { tool_name: 'alpha_x', calls: 2 },
          { tool_name: 'write_w', calls: 90 },
        ]),
      }),
    )
    const names = rendered
      .split('\n')
      .filter((line) => /^ {2}(read_q|zebra_x|alpha_x|write_w)\s/.test(line))
      .map((line) => line.trim().split(/\s+/)[0])
    expect(names).toEqual(['read_q', 'write_w', 'alpha_x', 'zebra_x'])
  })
})

// ---------------------------------------------------------------------------
// The drift clause
// ---------------------------------------------------------------------------

describe('renderGenerationText drift clause', () => {
  const drifted = { ...DELETE_RECORD, baseline: { drifted: true, restored: false, present: true } }
  const rows = observed([{ tool_name: 'delete_record', calls: 7 }])

  it('ends a written drifted pair with the block mode clause under the default on_tool_drift', () => {
    const rendered = text(model({ tools: [drifted], observed: rows }))
    expect(rendered).toContain(
      '  delete_record  upstream  require_approval  confident restrict  destructiveHint: true  observed 7 times  drifted: on_tool_drift block decides this pair until its baseline is accepted\n',
    )
    expect(rendered).not.toContain('(drifted)')
  })

  it('names the require_approval mode in the clause under on_tool_drift: require_approval', () => {
    const rendered = text(
      model({
        source: source({
          policies: 'policies:\n  default: allow\n  on_tool_drift: require_approval\n  rules: []\n',
        }),
        tools: [drifted],
        observed: rows,
      }),
    )
    expect(rendered).toContain(
      'observed 7 times  drifted: on_tool_drift require_approval decides this pair until its baseline is accepted\n',
    )
    expect(rendered).not.toContain('on_tool_drift block decides')
  })

  it('prints no clause under on_tool_drift: log, where the rule is the effective action', () => {
    const rendered = text(
      model({
        source: source({
          policies: 'policies:\n  default: allow\n  on_tool_drift: log\n  rules: []\n',
        }),
        tools: [drifted],
        observed: rows,
      }),
    )
    expect(rendered).toContain(
      '  delete_record  upstream  require_approval  confident restrict  destructiveHint: true  observed 7 times\n',
    )
    expect(rendered).not.toContain('decides this pair')
    expect(rendered).not.toContain('(drifted)')
  })
})

// ---------------------------------------------------------------------------
// The splice refusal face
// ---------------------------------------------------------------------------

describe('renderGenerationText on a splice refusal', () => {
  it('lists the written set under Could not be written with the refusal and prints no candidate block', () => {
    const raw =
      "version: '1'\nupstream:\n  url: 'http://localhost:8080/mcp'\n  transport: streamable-http\npolicies :\n  default: allow\n  rules: []\ndashboard:\n  enabled: false\n"
    const sha256 = createHash('sha256').update(raw).digest('hex')
    const m = buildGenerationModel({
      source: { raw, sha256, config: parseConfigSource({ raw, sha256 }, 'x.yaml', {}).config },
      doors: [{ name: undefined, tools: [def({ name: 'read_a' })] }],
      observed: observed([{ tool_name: 'read_a', calls: 2 }]),
    })
    const r = report(m)
    expect(r.candidate).toEqual({ refused: 'policies_key_unlocatable' })
    const rendered = renderGenerationText(r)
    expect(headings(rendered)).toEqual([
      'Policy coverage',
      'Could not be written',
      'Observed (whole trail within retention)',
    ])
    expect(rendered).toContain(
      'Could not be written\n  could not write the candidate: policies_key_unlocatable; write the rule by hand\n  read_a  upstream  allow  confident read  name, hint and description agree  observed 2 times\n',
    )
    expect(rendered).not.toContain(CANDIDATE_SENSITIVITY_LINE)
  })
})

// ---------------------------------------------------------------------------
// The JSON
// ---------------------------------------------------------------------------

function keysOf(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) keysOf(item, out)
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      out.add(key)
      keysOf(item, out)
    }
  }
}

describe('buildGenerationReport JSON', () => {
  it('carries schema_version 1, the window, the source and candidate coverage, and snake_case keys only', () => {
    const r = report(everything())
    expect(r.schema_version).toBe(1)
    expect(r.generated_at).toBe('2026-10-12T12:00:00.000Z')
    expect(r.helio_version).toBe('0.16.0')
    expect(r.annotation_source).toBe('proxy')
    expect(r.window).toEqual({ since: null, label: 'whole trail within retention' })
    expect(r.source.coverage.default_action).toBe('allow')
    expect(r.source.surface_pairs).toBe(6)
    expect(r.source.policy.rule_count).toBe(1)
    if (r.candidate === null || 'refused' in r.candidate) throw new Error('no candidate')
    expect(r.candidate.rules).toBe(1)
    expect(r.candidate.policy.rule_count).toBe(2)
    expect(r.candidate.coverage.matched).toBe(2)
    expect(r.counts).toEqual({
      written: 1,
      kept: 1,
      needs_decision: 1,
      eligible_unobserved: 1,
      needs_dashboard: 1,
      unmatchable: 1,
    })
    expect(r.pairs).toHaveLength(6)
    expect(r.observed.observed_not_listed).toBe(0)
    const keys = new Set<string>()
    keysOf(JSON.parse(JSON.stringify(r)), keys)
    for (const key of keys) expect(key, key).toMatch(/^[a-z][a-z0-9_]*$/)
  })
})
