import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import {
  NEEDS_DASHBOARD_ENABLED_SENTENCE,
  NEEDS_DASHBOARD_SECRET_SENTENCE,
  buildGenerationEvidence,
  buildGenerationModel,
  frequencyWords,
} from './model.js'
import type { GenerationModel, GenerationPair } from './model.js'
import type { GenerationDefinition } from './classify.js'
import type { PersistedPair, PersistedSummary } from '../audit/types.js'
import { parseConfigSource } from '../config/loader.js'
import { compilePolicies } from '../policy/parser.js'
import { classifySurface } from '../policy/surface.js'
import type { SurfaceDoor } from '../policy/surface.js'
import { pickHints } from '../policy/tool-definitions.js'
import { demoGenerationInput } from './__fixtures__/demo-input.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SECRET = `sha256:${'ab'.repeat(32)}`

/** A singular-mode source whose dashboard passes the approval gate. */
function source(
  options: {
    readonly policies?: string
    readonly dashboard?: string
    readonly upstreams?: readonly string[]
  } = {},
) {
  const head =
    options.upstreams === undefined
      ? "version: '1'\nupstream:\n  url: 'http://localhost:8080/mcp'\n  transport: streamable-http\n"
      : `version: '1'\nupstreams:\n${options.upstreams
          .map(
            (name) =>
              `  - name: ${name}\n    url: 'http://localhost:8080/${name}'\n    transport: streamable-http\n`,
          )
          .join('')}`
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

const READ_FILE = def({ name: 'read_file' })
const WRITE_FILE = def({
  name: 'write_file',
  description: 'Write a file',
  annotations: { readOnlyHint: false },
})
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
    last_seen_in_window: calls === 0 ? null : '2026-10-02T10:00:00.000Z',
    pairs,
    first_seen: calls === 0 ? null : '2026-10-01T10:00:00.000Z',
  }
}

function run(args: {
  readonly source?: ReturnType<typeof source>
  readonly tools?: readonly GenerationDefinition[]
  readonly doors?: ReadonlyArray<{
    name: string | undefined
    tools: readonly GenerationDefinition[]
  }>
  readonly observed?: PersistedSummary
}): GenerationModel {
  const doors = args.doors ?? [{ name: undefined, tools: args.tools ?? [READ_FILE] }]
  LAST_DOORS = doors
  return buildGenerationModel({
    source: args.source ?? source(),
    doors,
    observed: args.observed ?? observed([{ tool_name: 'read_file', calls: 5 }]),
  })
}

/** The doors the last `run()` classified, for the surface the written FILE is classified over. */
let LAST_DOORS: ReadonlyArray<{
  name: string | undefined
  tools: readonly GenerationDefinition[]
}> = []

function lastSurfaceDoors(): SurfaceDoor[] {
  return LAST_DOORS.map((door) => ({
    kind: 'upstream',
    name: door.name,
    tools: door.tools.map((def) => {
      const hints = pickHints(def.annotations)
      return {
        name: def.name,
        annotations: hints,
        current_annotations: hints,
        drifted: def.baseline?.drifted ?? false,
      }
    }),
  }))
}

function pair(model: GenerationModel, tool: string, door?: string): GenerationPair {
  const found = model.pairs.find(
    (p) =>
      p.tool === tool &&
      (door === undefined || (p.door.kind === 'upstream' && p.door.name === door)),
  )
  if (found === undefined) throw new Error(`no pair ${tool}`)
  return found
}

function candidateText(model: GenerationModel): string {
  if (model.candidate === null || 'refused' in model.candidate) throw new Error('no candidate')
  return model.candidate.text
}

function candidateSurface(model: GenerationModel) {
  if (model.candidate === null || 'refused' in model.candidate) throw new Error('no candidate')
  return model.candidate.surface
}

/** The insertion proof: the generated rule decides the written pairs and no other pair's deciding rule moved. */
function expectInsertion(model: GenerationModel): void {
  const after = candidateSurface(model).coverage.pairs
  const before = model.source.surface.coverage.pairs
  expect(after).toHaveLength(before.length)
  for (const [i, pairBefore] of before.entries()) {
    const pairAfter = after[i]
    if (pairAfter === undefined) throw new Error('missing pair')
    const generated = model.pairs.find(
      (p) =>
        p.tool === pairBefore.tool &&
        JSON.stringify(p.door) === JSON.stringify(pairBefore.door) &&
        p.disposition === 'written',
    )
    if (generated?.rule) {
      expect(pairAfter.matched_rule?.name).toBe(generated.rule.name)
    } else {
      expect(pairAfter.matched_rule).toEqual(pairBefore.matched_rule)
    }
  }
  // The candidate passes the real schema, with every placeholder of the source left as it was,
  // and the policy the FILE parses back to classifies every pair as the in-memory surface does.
  const text = candidateText(model)
  const parsed = parseConfigSource(
    { raw: text, sha256: createHash('sha256').update(text).digest('hex') },
    'candidate.yaml',
    {},
  ).config
  expect(parsed.policies.rules.length).toBe(
    model.source.policy.rules.length +
      model.pairs.filter((p) => p.disposition === 'written').length,
  )
  const fromFile = classifySurface({
    doors: lastSurfaceDoors(),
    policy: compilePolicies(parsed.policies).policy,
    environment: parsed.environment,
  }).coverage.pairs
  expect(fromFile).toHaveLength(after.length)
  for (const [i, pairAfter] of after.entries()) {
    const fromFilePair = fromFile[i]
    expect(fromFilePair?.tool, pairAfter.tool).toBe(pairAfter.tool)
    expect(fromFilePair?.matched_rule, pairAfter.tool).toEqual(pairAfter.matched_rule)
    expect(fromFilePair?.effective_action, pairAfter.tool).toBe(pairAfter.effective_action)
    expect(fromFilePair?.effective_source, pairAfter.tool).toBe(pairAfter.effective_source)
  }
}

// ---------------------------------------------------------------------------
// The dispositions
// ---------------------------------------------------------------------------

describe('buildGenerationModel dispositions', () => {
  it('writes an allow rule for an observed confident-read tool (the ticket example)', () => {
    const model = run({})
    const p = pair(model, 'read_file')
    expect(p.class).toBe('confident_read')
    expect(p.reason).toBe('name, hint and description agree')
    expect(p.disposition).toBe('written')
    expect(p.calls).toBe(5)
    expect(p.rule?.action).toBe('allow')
    expect(p.rule?.name).toBe('allow-read_file')
    expect(p.candidate_effective_source).toBe('rule')
    expect(candidateText(model)).toContain(
      '  rules:\n' +
        '    # generated: confident read, name, hint and description agree; observed 5 times\n' +
        '    - name: "allow-read_file"\n' +
        '      match:\n' +
        '        tool: "read_file"\n' +
        '      action: allow\n',
    )
    expect(candidateText(model)).not.toContain('upstreams:')
    expect(model.counts).toEqual({
      written: 1,
      kept: 0,
      needs_decision: 0,
      eligible_unobserved: 0,
      needs_dashboard: 0,
      unmatchable: 0,
    })
    expectInsertion(model)
  })

  it('lists a write-class name as needs-decision and never writes it, observed or not', () => {
    const model = run({
      tools: [WRITE_FILE],
      observed: observed([{ tool_name: 'write_file', calls: 40 }]),
    })
    const p = pair(model, 'write_file')
    expect(p.disposition).toBe('needs_decision')
    expect(p.reason).toBe('write-class name')
    expect(p.calls).toBe(40)
    expect(p.rule).toBeNull()
    expect(model.candidate).toBeNull()
    expect(run({ tools: [WRITE_FILE], observed: observed([]) }).pairs[0]?.disposition).toBe(
      'needs_decision',
    )
  })

  it('writes a require_approval rule for an observed annotated-destructive tool on a passing gate', () => {
    const model = run({
      tools: [DELETE_RECORD],
      observed: observed([{ tool_name: 'delete_record', calls: 2 }]),
    })
    const p = pair(model, 'delete_record')
    expect(p.disposition).toBe('written')
    expect(p.rule?.action).toBe('require_approval')
    expect(p.rule?.name).toBe('approve-delete_record')
    expect(candidateText(model)).toContain(
      '    # generated: confident restrict, destructiveHint: true; observed 2 times\n' +
        '    - name: "approve-delete_record"\n' +
        '      match:\n' +
        '        tool: "delete_record"\n' +
        '      action: require_approval\n' +
        '      approval:\n' +
        '        channel: dashboard\n',
    )
    expectInsertion(model)
  })

  it('reports a restrict tool under the secret heading on a secret-less source and writes nothing', () => {
    const model = run({
      source: source({ dashboard: 'dashboard:\n  enabled: true\n  allow_open_mode: true\n' }),
      tools: [DELETE_RECORD, READ_FILE],
      observed: observed([{ tool_name: 'delete_record' }, { tool_name: 'read_file' }]),
    })
    expect(pair(model, 'delete_record').disposition).toBe('needs_dashboard_secret')
    expect(pair(model, 'delete_record').rule).toBeNull()
    // The allow rule needs no secret: the read tool is still written.
    expect(pair(model, 'read_file').disposition).toBe('written')
    expect(candidateText(model)).not.toContain('require_approval')
    expect(model.counts.needs_dashboard).toBe(1)
    expect(NEEDS_DASHBOARD_SECRET_SENTENCE).toContain('helio secret')
    expectInsertion(model)
  })

  it('reports a restrict tool under the enabled heading when the dashboard is disabled', () => {
    const model = run({
      source: source({ dashboard: `dashboard:\n  enabled: false\n  api_secret: '${SECRET}'\n` }),
      tools: [DELETE_RECORD],
      observed: observed([{ tool_name: 'delete_record' }]),
    })
    expect(pair(model, 'delete_record').disposition).toBe('needs_dashboard_enabled')
    expect(model.candidate).toBeNull()
    expect(NEEDS_DASHBOARD_ENABLED_SENTENCE).toContain('dashboard.enabled is false')
    // Neither half present: the secret heading comes first, as the schema reports it.
    const neither = run({
      source: source({ dashboard: 'dashboard:\n  enabled: false\n' }),
      tools: [DELETE_RECORD],
      observed: observed([{ tool_name: 'delete_record' }]),
    })
    expect(pair(neither, 'delete_record').disposition).toBe('needs_dashboard_secret')
  })

  it('lists a tool without hints as needs-decision', () => {
    const model = run({ tools: [def({ name: 'read_file', annotations: undefined })] })
    expect(pair(model, 'read_file').disposition).toBe('needs_decision')
    expect(pair(model, 'read_file').reason).toBe('hints absent')
  })

  it('lists an eligible tool with no row in the window under eligible_unobserved', () => {
    const model = run({ tools: [READ_FILE, DELETE_RECORD], observed: observed([]) })
    expect(pair(model, 'read_file').disposition).toBe('eligible_unobserved')
    expect(pair(model, 'delete_record').disposition).toBe('eligible_unobserved')
    expect(pair(model, 'read_file').calls).toBe(0)
    expect(model.candidate).toBeNull()
    expect(model.counts.eligible_unobserved).toBe(2)
  })

  it('writes a rarely observed tool at one, two and three calls alike, the count as a number', () => {
    const tools = [
      def({ name: 'read_one' }),
      def({ name: 'read_two' }),
      def({ name: 'read_three' }),
    ]
    const model = run({
      tools,
      observed: observed([
        { tool_name: 'read_one', calls: 1 },
        { tool_name: 'read_two', calls: 2 },
        { tool_name: 'read_three', calls: 3 },
      ]),
    })
    expect(pair(model, 'read_one').disposition).toBe('written')
    expect(pair(model, 'read_two').disposition).toBe('written')
    expect(pair(model, 'read_three').disposition).toBe('written')
    expect([
      pair(model, 'read_one').calls,
      pair(model, 'read_two').calls,
      pair(model, 'read_three').calls,
    ]).toEqual([1, 2, 3])
    expect(candidateText(model)).toContain('observed once\n')
    expect(candidateText(model)).toContain('observed 2 times\n')
    expect(model.counts.written).toBe(3)
    expectInsertion(model)
  })

  it('keeps a pair a source rule matches by name, whatever its class, and reports the rule', () => {
    const model = run({
      source: source({
        policies:
          'policies:\n  default: allow\n  rules:\n    - name: gate-read\n      match:\n        tool: read_file\n      action: require_approval\n',
      }),
    })
    const p = pair(model, 'read_file')
    expect(p.disposition).toBe('kept')
    expect(p.kept_by).toEqual({ kind: 'rule', name: 'gate-read', index: 0 })
    expect(p.class).toBe('confident_read')
    expect(model.candidate).toBeNull()
  })

  it('keeps a pair a source rule matches by annotation, and an eligible unobserved kept pair is kept only', () => {
    const model = run({
      source: source({
        policies:
          'policies:\n  default: allow\n  rules:\n    - name: block-destructive\n      match:\n        annotations:\n          destructiveHint: true\n      action: deny\n',
      }),
      tools: [DELETE_RECORD],
      observed: observed([]),
    })
    const p = pair(model, 'delete_record')
    expect(p.disposition).toBe('kept')
    expect(p.kept_by).toEqual({ kind: 'rule', name: 'block-destructive', index: 0 })
    expect(p.calls).toBe(0)
    expect(model.counts.eligible_unobserved).toBe(0)
    expect(model.counts.kept).toBe(1)
  })

  it('keeps a pair the flag_destructive: require_approval gate decides', () => {
    const model = run({
      source: source({
        policies:
          'policies:\n  default: allow\n  flag_destructive: require_approval\n  rules: []\n',
      }),
      tools: [def({ name: 'read_file', annotations: { readOnlyHint: true } })],
    })
    const p = pair(model, 'read_file')
    expect(p.class).toBe('confident_read')
    expect(p.source_effective_source).toBe('flag_destructive')
    expect(p.disposition).toBe('kept')
    expect(p.kept_by).toEqual({ kind: 'flag_destructive' })
    expect(model.candidate).toBeNull()
  })

  it('does not keep a flag_destructive: log pair: the source decides it by the default, so it is written per its class', () => {
    const model = run({
      source: source({
        policies: 'policies:\n  default: allow\n  flag_destructive: log\n  rules: []\n',
      }),
      tools: [def({ name: 'read_file', annotations: { readOnlyHint: true } }), DELETE_RECORD],
      observed: observed([{ tool_name: 'read_file' }, { tool_name: 'delete_record' }]),
    })
    const read = pair(model, 'read_file')
    expect(read.source_effective_source).toBe('default')
    expect(
      model.source.surface.coverage.pairs.find((p) => p.tool === 'read_file')?.flagged_destructive,
    ).toBe(true)
    expect(read.disposition).toBe('written')
    expect(read.rule?.action).toBe('allow')
    expect(pair(model, 'delete_record').disposition).toBe('written')
    expect(pair(model, 'delete_record').rule?.action).toBe('require_approval')
    expectInsertion(model)
  })

  it('demotes a drifted read tool to needs-decision and writes nothing for it', () => {
    const model = run({
      tools: [
        def({ name: 'read_file', baseline: { drifted: true, restored: false, present: true } }),
      ],
    })
    const p = pair(model, 'read_file')
    expect(p.disposition).toBe('needs_decision')
    expect(p.reason).toBe('baseline demoted')
    expect(p.drifted).toBe(true)
    expect(model.candidate).toBeNull()
  })

  it('writes a drifted observed restrict tool; under the default on_tool_drift the drift gate still decides the candidate pair', () => {
    const model = run({
      tools: [{ ...DELETE_RECORD, baseline: { drifted: true, restored: false, present: true } }],
      observed: observed([{ tool_name: 'delete_record', calls: 7 }]),
    })
    const p = pair(model, 'delete_record')
    expect(p.disposition).toBe('written')
    expect(p.drifted).toBe(true)
    expect(p.rule?.action).toBe('require_approval')
    expect(p.candidate_effective_source).toBe('drift')
    expect(p.candidate_effective_action).toBe('deny')
    const after = candidateSurface(model).coverage.pairs[0]
    expect(after?.matched_rule?.name).toBe('approve-delete_record')
    expect(after?.effective_source).toBe('drift')
    expect(after?.effective_action).toBe('deny')
    expectInsertion(model)
  })

  it('under on_tool_drift: require_approval the drift gate names the action the rule also names', () => {
    const model = run({
      source: source({
        policies: 'policies:\n  default: allow\n  on_tool_drift: require_approval\n  rules: []\n',
      }),
      tools: [{ ...DELETE_RECORD, baseline: { drifted: true, restored: false, present: true } }],
      observed: observed([{ tool_name: 'delete_record' }]),
    })
    const p = pair(model, 'delete_record')
    expect(p.disposition).toBe('written')
    expect(p.candidate_effective_source).toBe('drift')
    expect(p.candidate_effective_action).toBe('require_approval')
  })

  it("under on_tool_drift: log the generated rule is the candidate pair's effective action", () => {
    const model = run({
      source: source({
        policies: 'policies:\n  default: allow\n  on_tool_drift: log\n  rules: []\n',
      }),
      tools: [{ ...DELETE_RECORD, baseline: { drifted: true, restored: false, present: true } }],
      observed: observed([{ tool_name: 'delete_record' }]),
    })
    const p = pair(model, 'delete_record')
    expect(p.disposition).toBe('written')
    expect(p.candidate_effective_source).toBe('rule')
    expect(p.candidate_effective_action).toBe('require_approval')
  })

  it('scopes a rule to its door in multi-upstream mode and leaves the unobserved twin eligible', () => {
    const model = run({
      source: source({ upstreams: ['files', 'docs'] }),
      doors: [
        { name: 'files', tools: [READ_FILE] },
        { name: 'docs', tools: [READ_FILE] },
      ],
      observed: observed([{ tool_name: 'read_file', upstream: 'files', calls: 9 }]),
    })
    expect(pair(model, 'read_file', 'files').disposition).toBe('written')
    expect(pair(model, 'read_file', 'docs').disposition).toBe('eligible_unobserved')
    expect(candidateText(model)).toContain(
      '    - name: "allow-read_file"\n' +
        '      match:\n' +
        '        tool: "read_file"\n' +
        '        upstreams: ["files"]\n' +
        '      action: allow\n',
    )
    expect(model.multi_upstream).toBe(true)
    expectInsertion(model)
    const after = candidateSurface(model).coverage.pairs
    expect(
      after.find((p) => p.door.kind === 'upstream' && p.door.name === 'docs')?.matched_rule,
    ).toBeNull()
  })

  it('lists an execute-shaped argument and an open-world read as needs-decision', () => {
    const model = run({
      tools: [
        def({ name: 'query_db', description: 'Returns rows', input_keys: ['$.query.sql'] }),
        def({ name: 'read_page', annotations: { readOnlyHint: true, openWorldHint: true } }),
      ],
      observed: observed([{ tool_name: 'query_db' }, { tool_name: 'read_page' }]),
    })
    expect(pair(model, 'query_db').reason).toBe('execute-shaped argument')
    expect(pair(model, 'read_page').reason).toBe('open-world read')
    expect(model.candidate).toBeNull()
  })

  it('reports the source default on allow and deny sources', () => {
    const allow = run({})
    expect(allow.source.surface.coverage.default_action).toBe('allow')
    expect(allow.source.surface.coverage.matched).toBe(0)
    expect(allow.source.surface.coverage.uncovered).toBe(1)
    const deny = run({ source: source({ policies: 'policies:\n  default: deny\n  rules: []\n' }) })
    expect(deny.source.surface.coverage.default_action).toBe('deny')
    expect(candidateSurface(deny).coverage.default_action).toBe('deny')
    expect(candidateSurface(deny).coverage.matched).toBe(1)
    const evidence = buildGenerationEvidence(deny, {
      helioVersion: '0.0.0',
      annotationSource: 'proxy',
    })
    expect(evidence.default_action).toEqual({ source: 'deny', candidate: 'deny' })
  })

  it('names an unmatchable tool as such and writes no rule for it', () => {
    const long = 'a'.repeat(65537)
    const model = run({
      tools: [def({ name: long }), READ_FILE],
      observed: observed([{ tool_name: long }, { tool_name: 'read_file' }]),
    })
    expect(pair(model, long).disposition).toBe('unmatchable')
    expect(pair(model, long).calls).toBe(1)
    expect(pair(model, 'read_file').disposition).toBe('written')
    expect(model.counts.unmatchable).toBe(1)
    expectInsertion(model)
  })

  it('suffixes -generated when the source already names the rule without matching the pair', () => {
    const model = run({
      source: source({
        policies:
          "policies:\n  default: allow\n  rules:\n    - name: allow-read_file\n      match:\n        tool: read_file\n        input:\n          '$.path': { eq: '/etc/hosts' }\n      action: deny\n",
      }),
    })
    const p = pair(model, 'read_file')
    expect(p.disposition).toBe('written')
    expect(p.rule?.name).toBe('allow-read_file-generated')
    expect(candidateText(model)).toContain('- name: "allow-read_file-generated"\n')
    expectInsertion(model)
    const after = candidateSurface(model).coverage.pairs[0]
    expect(after?.conditional_rules.map((r) => r.name)).toEqual(['allow-read_file'])
  })

  it('compiles the candidate policy from the exact pattern the file carries, so a glob sibling is not swallowed', () => {
    // read_file* is a confident read (the first token is read); read_file is its unwritten sibling
    // on a deny default. The raw name as a glob would allow the sibling in memory while the file,
    // which carries the escaped pattern, denies it.
    const model = run({
      source: source({ policies: 'policies:\n  default: deny\n  rules: []\n' }),
      tools: [
        def({ name: 'read_file*' }),
        def({ name: 'read_file' }),
        def({ name: 'read_file[id]' }),
      ],
      observed: observed([
        { tool_name: 'read_file*', calls: 2 },
        { tool_name: 'read_file[id]', calls: 1 },
      ]),
    })
    expect(pair(model, 'read_file*').disposition).toBe('written')
    expect(pair(model, 'read_file[id]').disposition).toBe('written')
    expect(pair(model, 'read_file').disposition).toBe('eligible_unobserved')
    const after = candidateSurface(model).coverage.pairs
    const sibling = after.find((p) => p.tool === 'read_file')
    expect(sibling?.matched_rule).toBeNull()
    expect(sibling?.effective_action).toBe('deny')
    expect(candidateSurface(model).coverage.matched).toBe(2)
    expect(candidateText(model)).toContain('tool: "read_file\\\\*"\n')
    expect(candidateText(model)).toContain('tool: "read_file\\\\[id\\\\]"\n')
    expectInsertion(model)
  })

  it('keeps a dollar sign in a colliding name literal when the -generated suffix is applied', () => {
    const collide = (tool: string) =>
      source({
        policies: `policies:\n  default: allow\n  rules:\n    - name: ${JSON.stringify(`allow-${tool}`)}\n      match:\n        tool: other_tool\n      action: deny\n`,
      })
    for (const tool of ['get_$$amount', 'get_$&file', "get_$'tail", 'get_$`head', 'get_$1']) {
      const model = run({
        source: collide(tool),
        tools: [def({ name: tool })],
        observed: observed([{ tool_name: tool, calls: 1 }]),
      })
      const p = pair(model, tool)
      expect(p.disposition, tool).toBe('written')
      expect(p.rule?.name, tool).toBe(`allow-${tool}-generated`)
      const text = candidateText(model)
      expect(text, tool).toContain(`- name: ${JSON.stringify(`allow-${tool}-generated`)}\n`)
      const parsed = parseConfigSource(
        { raw: text, sha256: createHash('sha256').update(text).digest('hex') },
        'candidate.yaml',
        {},
      ).config
      expect(
        parsed.policies.rules.map((r) => r.name),
        tool,
      ).toEqual([`allow-${tool}`, `allow-${tool}-generated`])
      expectInsertion(model)
    }
  })

  it('counts observed rows on no listed door and never classifies them', () => {
    const model = run({
      observed: observed([
        { tool_name: 'read_file', calls: 3 },
        { tool_name: 'ghost_tool', calls: 2 },
        { tool_name: 'read_file', origin: 'openclaw', calls: 1 },
      ]),
    })
    expect(model.observed.observed_not_listed).toBe(2)
    expect(model.observed.pairs_observed).toBe(3)
    expect(model.observed.pairs_exposed).toBe(1)
    expect(model.observed.calls).toBe(6)
    expect(model.pairs).toHaveLength(1)
    expect(pair(model, 'read_file').calls).toBe(3)
  })

  it('orders pairs by class (restrict, needs-decision in reason order, read), then door, then tool, never by calls', () => {
    const model = run({
      source: source({ upstreams: ['b', 'a'] }),
      doors: [
        {
          name: 'b',
          tools: [
            def({ name: 'read_z' }),
            def({ name: 'export_x', description: 'Export it' }),
            DELETE_RECORD,
            WRITE_FILE,
          ],
        },
        {
          name: 'a',
          tools: [def({ name: 'read_y' }), def({ name: 'drop_t', description: 'Drop it' })],
        },
      ],
      observed: observed([
        { tool_name: 'read_z', upstream: 'b', calls: 900 },
        { tool_name: 'export_x', upstream: 'b', calls: 1 },
      ]),
    })
    expect(
      model.pairs.map((p) => `${p.door.kind === 'upstream' ? (p.door.name ?? '') : ''}/${p.tool}`),
    ).toEqual(['a/drop_t', 'b/delete_record', 'b/write_file', 'b/export_x', 'a/read_y', 'b/read_z'])
  })
})

// ---------------------------------------------------------------------------
// The evidence, the frequency words
// ---------------------------------------------------------------------------

describe('buildGenerationEvidence and frequencyWords', () => {
  it('packs the record fields from the model', () => {
    const model = run({})
    const evidence = buildGenerationEvidence(model, {
      helioVersion: '0.16.0',
      annotationSource: 'proxy',
    })
    expect(evidence).toEqual({
      candidate_sha256: (model.candidate as { sha256: string }).sha256,
      source_config_sha256: model.source.sha256,
      helio_version: '0.16.0',
      traffic_start: '2026-10-01T10:00:00.000Z',
      traffic_end: '2026-10-02T10:00:00.000Z',
      call_count: 5,
      pairs_observed: 1,
      pairs_exposed: 1,
      rules_generated: 1,
      rules_kept: 0,
      needs_decision: 0,
      eligible_unobserved: 0,
      needs_dashboard: 0,
      default_action: { source: 'allow', candidate: 'allow' },
      annotation_source: 'proxy',
    })
    expect((model.candidate as { sha256: string }).sha256).toBe(
      createHash('sha256')
        .update(Buffer.from(candidateText(model), 'utf-8'))
        .digest('hex'),
    )
  })

  it('words a count as never observed, once, or N times', () => {
    expect(frequencyWords(0)).toBe('never observed')
    expect(frequencyWords(1)).toBe('observed once')
    expect(frequencyWords(2)).toBe('observed 2 times')
    expect(frequencyWords(31)).toBe('observed 31 times')
  })
})

// ---------------------------------------------------------------------------
// The demo pin, part 1: the model over the shipped demo
// ---------------------------------------------------------------------------

describe('buildGenerationModel over the shipped demo', () => {
  const input = demoGenerationInput()
  const model = buildGenerationModel(input)
  const by = (tool: string) => pair(model, tool)

  it('keeps six pairs, lists four for decision, writes nothing and names no Needs heading', () => {
    expect(model.candidate).toBeNull()
    expect(model.counts).toEqual({
      written: 0,
      kept: 6,
      needs_decision: 4,
      eligible_unobserved: 0,
      needs_dashboard: 0,
      unmatchable: 0,
    })
    for (const [tool, rule, cls] of [
      ['get_customer', 'allow-reads', 'needs_decision'],
      ['get_invoice', 'allow-reads', 'needs_decision'],
      ['list_invoices', 'allow-reads', 'confident_read'],
      ['delete_customer', 'block-destructive', 'confident_restrict'],
      ['merge_customers', 'block-destructive', 'confident_restrict'],
      ['export_customers', 'block-destructive', 'needs_decision'],
    ] as const) {
      expect(by(tool).disposition, tool).toBe('kept')
      expect(by(tool).kept_by, tool).toMatchObject({ kind: 'rule', name: rule })
      expect(by(tool).class, tool).toBe(cls)
    }
    expect(by('get_customer').reason).toBe('description silent')
    expect(by('get_invoice').reason).toBe('description silent')
    expect(by('export_customers').reason).toBe('unknown name')
    for (const tool of ['update_customer', 'send_invoice', 'create_charge'] as const) {
      expect(by(tool).disposition, tool).toBe('needs_decision')
      expect(by(tool).reason, tool).toBe('write-class name')
    }
    expect(by('refund_charge').disposition).toBe('needs_decision')
    expect(by('refund_charge').reason).toBe('unknown name')
  })

  it('counts 352 calls on eight pairs as the multiset the corpus holds, and 0 on the two never called', () => {
    expect(model.observed.calls).toBe(352)
    expect(model.observed.pairs_observed).toBe(8)
    expect(model.observed.pairs_exposed).toBe(10)
    expect(model.observed.observed_not_listed).toBe(0)
    const counts = model.pairs
      .map((p) => p.calls)
      .filter((c) => c > 0)
      .sort((a, b) => b - a)
    expect(counts).toEqual([65, 64, 40, 40, 40, 39, 39, 25])
    expect(by('list_invoices').calls).toBe(0)
    expect(by('merge_customers').calls).toBe(0)
  })

  it('reports the source coverage as six matched, four uncovered, default allow', () => {
    expect(model.source.surface.coverage.matched).toBe(6)
    expect(model.source.surface.coverage.uncovered).toBe(4)
    expect(model.source.surface.coverage.default_action).toBe('allow')
  })

  it('packs the evidence with a null candidate hash and a null candidate default', () => {
    const evidence = buildGenerationEvidence(model, {
      helioVersion: '0.0.0',
      annotationSource: 'demo',
    })
    expect(evidence.candidate_sha256).toBeNull()
    expect(evidence.default_action).toEqual({ source: 'allow', candidate: null })
    expect(evidence.call_count).toBe(352)
    expect(evidence.pairs_observed).toBe(8)
    expect(evidence.pairs_exposed).toBe(10)
    expect(evidence.rules_generated).toBe(0)
    expect(evidence.rules_kept).toBe(6)
    expect(evidence.needs_decision).toBe(4)
    expect(evidence.eligible_unobserved).toBe(0)
    expect(evidence.needs_dashboard).toBe(0)
    expect(evidence.annotation_source).toBe('demo')
    expect(evidence.source_config_sha256).toBe(input.source.sha256)
    expect(evidence.traffic_start).not.toBeNull()
    expect(evidence.traffic_end).not.toBeNull()
  })
})
