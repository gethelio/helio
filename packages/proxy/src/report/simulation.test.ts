import { describe, it, expect } from 'vitest'
import type { EpochReloads, AuditRecord } from '../audit/types.js'
import { FIDELITY_SENTENCES, renderFidelityLines } from '../policy/simulate/fidelity.js'
import type {
  ConfigEpoch,
  FidelityWarning,
  PolicySimulationResult,
  SimulatedOutcome,
  SimulatedRow,
} from '../policy/simulate/types.js'
import { at, mcpRow } from '../__tests__/helpers/simulation-rows.js'
import {
  EPOCH_FLAG_HINT,
  SIMULATION_CLOSING_LINE,
  SIMULATION_REPORT_SCHEMA_VERSION,
  buildSimulationReport,
  classifyDelta,
  isFirstPolicyBaseline,
  renderSimulationText,
} from './simulation.js'
import type { SimulationReport, SimulationReportInput } from './simulation.js'

// ---------------------------------------------------------------------------
// Fixtures: hand-built harness results, no store
// ---------------------------------------------------------------------------

const CANDIDATE = 'c'.repeat(64)
const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const PLAIN: SimulatedOutcome = {
  policy_decision: 'allow',
  block_reason: null,
  dry_run: false,
  ticket: 'none',
}

function outcome(
  policy_decision: string,
  block_reason: string | null,
  dry_run = false,
  ticket: SimulatedOutcome['ticket'] = 'none',
): SimulatedOutcome {
  return { policy_decision, block_reason, dry_run, ticket }
}

function row(overrides: Partial<SimulatedRow> = {}): SimulatedRow {
  return {
    record_id: 'r-1',
    timestamp: at(0),
    tool_name: 'send_email',
    upstream: 'crm',
    origin: 'mcp',
    session_id: 's-1',
    stored: PLAIN,
    simulated: PLAIN,
    matched_rule: null,
    matched_rule_index: null,
    ticket_answer: null,
    unverified: [],
    ...overrides,
  }
}

function epoch(
  hash: string | null,
  rows: number,
  first: string,
  last: string,
  selected: boolean,
): ConfigEpoch {
  return {
    config_sha256: hash,
    rows,
    first_timestamp: first,
    last_timestamp: last,
    first_rowid: 1,
    last_rowid: rows,
    selected,
  }
}

function isDelta(r: SimulatedRow): boolean {
  return (
    r.stored.policy_decision !== r.simulated.policy_decision ||
    r.stored.block_reason !== r.simulated.block_reason ||
    r.stored.dry_run !== r.simulated.dry_run ||
    r.stored.ticket !== r.simulated.ticket
  )
}

function result(overrides: Partial<PolicySimulationResult> = {}): PolicySimulationResult {
  const rows = overrides.rows ?? [row()]
  const warnings = overrides.fidelity?.warnings ?? []
  const skipped = overrides.skipped ?? { rejected: 0, kill_switch: 0 }
  const unreported = overrides.unreported ?? 0
  return {
    candidate_sha256: CANDIDATE,
    epochs: [epoch(HASH_A, rows.length, at(0), at(10), true)],
    replayed: rows.length,
    skipped,
    unreported,
    rows,
    deltas: rows.filter(isDelta),
    fidelity: {
      lines: renderFidelityLines({ warnings, skipped, unreported }),
      warnings,
      skipped,
      unreported,
    },
    budget_checks: [],
    warnings_suppressed: 0,
    ...overrides,
  }
}

function reloadRecord(
  counts: { rules: number; budgets: number; defaultAction: 'allow' | 'deny' },
  hash = HASH_A,
): AuditRecord {
  return mcpRow({
    tool_name: 'helio.yaml',
    policy_decision: 'policy_reload',
    record_kind: 'policy_reload',
    origin: 'config',
    config_sha256: hash,
    evidence_chain: {
      policy_reload: {
        outcome: 'applied',
        config_path: '/etc/helio/helio.yaml',
        sha256_before: 'f'.repeat(64),
        sha256_after: hash,
        rule_count_before: 0,
        rule_count_after: counts.rules,
        default_action_before: 'allow',
        default_action_after: counts.defaultAction,
        budget_count_before: 0,
        budget_count_after: counts.budgets,
        rules_removed: [],
        restart_required_paths: [],
        error: null,
      },
    },
  })
}

const ZERO_RELOAD = reloadRecord({ rules: 0, budgets: 0, defaultAction: 'allow' })

function reloads(opener: AuditRecord | undefined, within: readonly AuditRecord[]): EpochReloads {
  return { opener, within }
}

function input(overrides: Partial<SimulationReportInput> = {}): SimulationReportInput {
  return {
    result: result(),
    candidateName: 'helio.candidate.yaml',
    annotationSource: 'trail',
    window: { sessionFiltered: false },
    epochSelector: 'latest',
    reloads: [reloads(undefined, [])],
    retention: '90d',
    purged: null,
    helioVersion: '0.15.0',
    generatedAt: '2026-10-06T09:00:00.000Z',
    recordId: null,
    ...overrides,
  }
}

function build(overrides: Partial<SimulationReportInput> = {}): SimulationReport {
  return buildSimulationReport(input(overrides))
}

function render(overrides: Partial<SimulationReportInput> = {}): string {
  return renderSimulationText(build(overrides))
}

function lines(text: string): string[] {
  return text.split('\n')
}

// ---------------------------------------------------------------------------
// classifyDelta
// ---------------------------------------------------------------------------

describe('classifyDelta (issue #490)', () => {
  it('files an unanswered budget ticket as unanswered whatever its decision', () => {
    expect(
      classifyDelta(
        row({ simulated: outcome('allow', null, false, 'budget'), ticket_answer: 'unanswered' }),
      ),
    ).toBe('unanswered')
  })

  it('files a refused rate limit as blocked', () => {
    expect(classifyDelta(row({ simulated: outcome('rate_limit', 'rate_limited') }))).toBe('blocked')
  })

  it('files a budget breach on an allow as blocked', () => {
    expect(classifyDelta(row({ simulated: outcome('allow', 'budget_exceeded') }))).toBe('blocked')
  })

  it('files a recorded approval denial as blocked', () => {
    expect(
      classifyDelta(
        row({
          simulated: outcome('require_approval', 'approval_denied', false, 'rule'),
          ticket_answer: 'recorded',
        }),
      ),
    ).toBe('blocked')
  })

  it('files a recorded approval that passed as approval_recorded', () => {
    expect(
      classifyDelta(
        row({
          simulated: outcome('require_approval', null, false, 'rule'),
          ticket_answer: 'recorded',
        }),
      ),
    ).toBe('approval_recorded')
  })

  it('files a passing rate limit as limited', () => {
    expect(classifyDelta(row({ simulated: outcome('rate_limit', null) }))).toBe('limited')
  })

  it('files a dry-run deny as dry_run, never as allowed', () => {
    expect(classifyDelta(row({ simulated: outcome('deny', null, true) }))).toBe('dry_run')
  })

  it('files a dry-run approval or limit as dry_run: nothing was answered or consumed', () => {
    expect(classifyDelta(row({ simulated: outcome('require_approval', null, true) }))).toBe(
      'dry_run',
    )
    expect(classifyDelta(row({ simulated: outcome('rate_limit', null, true) }))).toBe('dry_run')
  })

  it('files a recorded budget ticket that passed as allowed', () => {
    expect(
      classifyDelta(
        row({ simulated: outcome('allow', null, false, 'budget'), ticket_answer: 'recorded' }),
      ),
    ).toBe('allowed')
  })

  it('sums the five record counts to the delta count on a mixed table', () => {
    const rows = [
      row({ record_id: 'r-1', simulated: outcome('deny', 'policy_denied') }),
      row({
        record_id: 'r-2',
        simulated: outcome('allow', null, false, 'budget'),
        ticket_answer: 'unanswered',
      }),
      row({
        record_id: 'r-3',
        simulated: outcome('require_approval', null, false, 'rule'),
        ticket_answer: 'recorded',
      }),
      row({ record_id: 'r-4', simulated: outcome('rate_limit', null) }),
      row({ record_id: 'r-5', simulated: outcome('deny', null, true) }),
      row({ record_id: 'r-6', stored: outcome('deny', 'policy_denied'), simulated: PLAIN }),
      row({ record_id: 'r-7' }),
    ]
    const report = build({ result: result({ rows }) })
    const d = report.deltas
    expect(d.total).toBe(6)
    expect(
      d.blocked + (d.unanswered + d.approval_recorded) + d.limited + d.dry_run + d.allowed,
    ).toBe(d.total)
    expect([d.blocked, d.unanswered, d.approval_recorded, d.limited, d.dry_run, d.allowed]).toEqual(
      [1, 1, 1, 1, 1, 1],
    )
  })
})

// ---------------------------------------------------------------------------
// isFirstPolicyBaseline
// ---------------------------------------------------------------------------

describe('isFirstPolicyBaseline (issue #490)', () => {
  const plain = [row({ record_id: 'r-1' }), row({ record_id: 'r-2', timestamp: at(1) })]

  it('is true on plain allows with no reload', () => {
    expect(isFirstPolicyBaseline(plain, [reloads(undefined, [])])).toBe(true)
  })

  it('is true with an opening reload saying no rule, default allow, no budget', () => {
    expect(isFirstPolicyBaseline(plain, [reloads(ZERO_RELOAD, [ZERO_RELOAD])])).toBe(true)
  })

  it('is false with an opening reload saying two rules though every row is a plain allow', () => {
    const two = reloadRecord({ rules: 2, budgets: 0, defaultAction: 'allow' })
    expect(isFirstPolicyBaseline(plain, [reloads(two, [two])])).toBe(false)
  })

  it('is false with an opening reload saying one rule: counts, not actions', () => {
    const one = reloadRecord({ rules: 1, budgets: 0, defaultAction: 'allow' })
    expect(isFirstPolicyBaseline(plain, [reloads(one, [one])])).toBe(false)
  })

  it('is false with an opening reload saying one budget', () => {
    const pot = reloadRecord({ rules: 0, budgets: 1, defaultAction: 'allow' })
    expect(isFirstPolicyBaseline(plain, [reloads(pot, [pot])])).toBe(false)
  })

  it('is false with a default deny in the opening reload', () => {
    const deny = reloadRecord({ rules: 0, budgets: 0, defaultAction: 'deny' })
    expect(isFirstPolicyBaseline(plain, [reloads(deny, [deny])])).toBe(false)
  })

  it('is false with a zero opener and a later reload within the run saying five rules', () => {
    const five = reloadRecord({ rules: 5, budgets: 0, defaultAction: 'allow' })
    expect(isFirstPolicyBaseline(plain, [reloads(ZERO_RELOAD, [ZERO_RELOAD, five])])).toBe(false)
  })

  it('is false with no opener and a reload within the run saying five rules', () => {
    const five = reloadRecord({ rules: 5, budgets: 0, defaultAction: 'allow' })
    expect(isFirstPolicyBaseline(plain, [reloads(undefined, [five])])).toBe(false)
  })

  it('is false when one stored row is a dry run', () => {
    expect(
      isFirstPolicyBaseline(
        [row({ stored: outcome('deny', null, true) }), ...plain],
        [reloads(undefined, [])],
      ),
    ).toBe(false)
  })

  it('is false when one stored row carries a ticket', () => {
    expect(
      isFirstPolicyBaseline(
        [row({ stored: outcome('allow', null, false, 'budget') }), ...plain],
        [reloads(undefined, [])],
      ),
    ).toBe(false)
  })

  it('is false when one stored row is blocked', () => {
    expect(
      isFirstPolicyBaseline(
        [row({ stored: outcome('deny', 'policy_denied') }), ...plain],
        [reloads(undefined, [])],
      ),
    ).toBe(false)
  })

  it('is false on zero rows', () => {
    expect(isFirstPolicyBaseline([], [reloads(undefined, [])])).toBe(false)
    expect(isFirstPolicyBaseline([], [])).toBe(false)
  })

  it('takes the reloads as given: a five-rule opener is false whatever the rows say', () => {
    const five = reloadRecord({ rules: 5, budgets: 0, defaultAction: 'allow' })
    expect(isFirstPolicyBaseline(plain, [reloads(five, [five])])).toBe(false)
  })

  it('reads every selected run of an across-configs run: one within reload saying one rule is false', () => {
    const one = reloadRecord({ rules: 1, budgets: 0, defaultAction: 'allow' }, HASH_B)
    expect(
      isFirstPolicyBaseline(plain, [
        reloads(ZERO_RELOAD, [ZERO_RELOAD]),
        reloads(undefined, [one]),
        reloads(undefined, []),
      ]),
    ).toBe(false)
  })

  it('is true across three runs whose reloads all read zero', () => {
    const zeroB = reloadRecord({ rules: 0, budgets: 0, defaultAction: 'allow' }, HASH_B)
    expect(
      isFirstPolicyBaseline(plain, [
        reloads(ZERO_RELOAD, [ZERO_RELOAD]),
        reloads(zeroB, [zeroB]),
        reloads(undefined, []),
      ]),
    ).toBe(true)
  })

  it('is false when a reload within the run carries evidence the builder did not write', () => {
    const broken = mcpRow({
      record_kind: 'policy_reload',
      policy_decision: 'policy_reload',
      evidence_chain: { policy_reload: { outcome: 'applied' } },
    })
    expect(isFirstPolicyBaseline(plain, [reloads(undefined, [broken])])).toBe(false)
  })

  it('ignores the candidate match on the rows (matched_rule_index is the candidate, not the baseline)', () => {
    const matched = plain.map((r, i) => ({
      ...r,
      matched_rule: 'block-email',
      matched_rule_index: i,
      simulated: outcome('deny', 'policy_denied'),
    }))
    expect(isFirstPolicyBaseline(matched, [reloads(undefined, [])])).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// buildSimulationReport
// ---------------------------------------------------------------------------

describe('buildSimulationReport (issue #490)', () => {
  it('carries the schema version, the candidate, the counts and changed', () => {
    const rows = [
      row({ record_id: 'r-1', simulated: outcome('deny', 'policy_denied') }),
      row({ record_id: 'r-2' }),
    ]
    const report = build({ result: result({ rows }) })
    expect(report.schema_version).toBe(SIMULATION_REPORT_SCHEMA_VERSION)
    expect(report.schema_version).toBe(1)
    expect(report.helio_version).toBe('0.15.0')
    expect(report.generated_at).toBe('2026-10-06T09:00:00.000Z')
    expect(report.candidate).toEqual({ name: 'helio.candidate.yaml', sha256: CANDIDATE })
    expect(report.annotation_source).toBe('trail')
    expect(report.replayed).toBe(2)
    expect(report.changed).toBe(true)
    expect(report.deltas.total).toBe(1)
    expect(report.deltas.blocked).toBe(1)
    expect(report.provenance).toEqual({ record_id: null })
    expect(build().changed).toBe(false)
  })

  it('marks the first-policy baseline from the rows and the reloads', () => {
    expect(build().baseline.first_policy).toBe(true)
    expect(build({ reloads: [reloads(ZERO_RELOAD, [ZERO_RELOAD])] }).baseline).toEqual({
      config_sha256_prefix: HASH_A.slice(0, 8),
      first_policy: true,
      opening_reload: true,
    })
    const five = reloadRecord({ rules: 5, budgets: 0, defaultAction: 'allow' })
    expect(build({ reloads: [reloads(five, [five])] }).baseline.first_policy).toBe(false)
  })

  it('prefixes epoch and baseline hashes with the shortest unique prefix of at least 8', () => {
    const shared = 'abcdefghi'
    const x = `${shared}${'0'.repeat(55)}`
    const y = `${shared}${'1'.repeat(55)}`
    const report = build({
      result: result({
        epochs: [epoch(x, 2, at(0), at(1), false), epoch(y, 1, at(2), at(2), true)],
      }),
    })
    expect(report.epoch.epochs.map((e) => e.config_sha256_prefix)).toEqual([
      `${shared}0`,
      `${shared}1`,
    ])
    expect(report.baseline.config_sha256_prefix).toBe(`${shared}1`)
    expect(report.epoch.epochs[0]).toEqual({
      config_sha256_prefix: `${shared}0`,
      rows: 2,
      first_timestamp: at(0),
      last_timestamp: at(1),
      selected: false,
    })
    expect(build().epoch.epochs[0]?.config_sha256_prefix).toBe(HASH_A.slice(0, 8))
  })

  it('names a null-hash epoch with a null prefix', () => {
    const report = build({ result: result({ epochs: [epoch(null, 1, at(0), at(0), true)] }) })
    expect(report.epoch.epochs[0]?.config_sha256_prefix).toBeNull()
    expect(report.baseline.config_sha256_prefix).toBeNull()
  })

  it('has a null baseline prefix and the selector all under across-configs', () => {
    const report = build({
      epochSelector: 'all',
      result: result({
        epochs: [epoch(HASH_A, 1, at(0), at(0), true), epoch(HASH_B, 1, at(1), at(1), true)],
      }),
    })
    expect(report.epoch.selector).toBe('all')
    expect(report.baseline.config_sha256_prefix).toBeNull()
  })

  it('carries the purge cutoff and count beside an untouched window start', () => {
    const report = build({
      window: { from: at(-100_000), sessionFiltered: false },
      purged: { before: at(-50_000), rows: 3 },
    })
    expect(report.window.from).toBe(at(-100_000))
    expect(report.window.purged_before).toBe(at(-50_000))
    expect(report.window.purged_rows).toBe(3)
    expect(report.window.retention).toBe('90d')
    const clean = build({ window: { from: at(-100_000), sessionFiltered: false } })
    expect(clean.window.purged_before).toBeNull()
    expect(clean.window.purged_rows).toBe(0)
  })

  it('copies the delta rows by name, without record_id or session_id', () => {
    const report = build({
      result: result({
        rows: [
          row({
            record_id: 'planted-record',
            session_id: 'planted-session',
            simulated: outcome('deny', 'policy_denied'),
            matched_rule: 'no-email',
            matched_rule_index: 0,
            unverified: [{ rule: 'no-email', dimension: 'evidence', subject: 'tool "send_email"' }],
          }),
        ],
      }),
    })
    expect(Object.keys(report.deltas.rows[0] ?? {}).sort()).toEqual(
      [
        'class',
        'matched_rule',
        'matched_rule_index',
        'origin',
        'simulated',
        'stored',
        'ticket_answer',
        'timestamp',
        'tool_name',
        'unverified',
        'upstream',
      ].sort(),
    )
    expect(report.deltas.rows[0]?.class).toBe('blocked')
  })

  it('sorts the blocked reasons and the dry-run decisions by count then name', () => {
    const rows = [
      row({ record_id: 'r-1', simulated: outcome('deny', 'policy_denied') }),
      row({ record_id: 'r-2', simulated: outcome('deny', 'policy_denied') }),
      row({ record_id: 'r-3', simulated: outcome('rate_limit', 'rate_limited') }),
      row({ record_id: 'r-4', simulated: outcome('allow', 'budget_exceeded') }),
      row({ record_id: 'r-5', simulated: outcome('deny', null, true) }),
      row({ record_id: 'r-6', simulated: outcome('require_approval', null, true) }),
      row({ record_id: 'r-7', simulated: outcome('require_approval', null, true) }),
    ]
    const report = build({ result: result({ rows }) })
    expect(report.deltas.blocked_by_reason).toEqual([
      { reason: 'policy_denied', count: 2 },
      { reason: 'budget_exceeded', count: 1 },
      { reason: 'rate_limited', count: 1 },
    ])
    expect(report.deltas.dry_run_by_decision).toEqual([
      { decision: 'require_approval', count: 2 },
      { decision: 'deny', count: 1 },
    ])
  })

  it('carries the harness lines, the pot line, the notice and the demo line', () => {
    const report = build({
      annotationSource: 'demo',
      result: result({
        epochs: [epoch(HASH_B, 4, at(-20), at(-10), false), epoch(HASH_A, 1, at(0), at(10), true)],
        budget_checks: [{ budget: 'pot', timestamp: at(0), stored_spent: 5, simulated_spent: 4 }],
      }),
    })
    expect(report.epoch_notice.startsWith('Simulated the most recent config epoch only')).toBe(true)
    expect(report.budget_check_line).toContain('"pot"')
    expect(report.demo_line).toBe(
      "Annotations for --demo came from the sample server's listed definitions, not from the audit trail.",
    )
    expect(build().demo_line).toBeNull()
    expect(build().epoch_notice).toBe('')
    expect(build().budget_check_line).toBe('')
  })
})

// ---------------------------------------------------------------------------
// renderSimulationText
// ---------------------------------------------------------------------------

describe('renderSimulationText (issue #490)', () => {
  it('prints the header with the candidate, the version, the day and the window forms', () => {
    const whole = lines(render())
    expect(whole[0]).toBe('Policy simulation')
    expect(whole[1]).toBe('  Candidate: helio.candidate.yaml')
    expect(whole[2]).toBe('  Written by Helio 0.15.0 on 2026-10-06 (UTC).')
    expect(whole[3]).toBe('  Window: the whole trail')
    expect(whole[4]).toBe(
      '  Epoch: the most recent config epoch, 1 call, 2026-07-10 12:00 UTC to 2026-07-10 12:10 UTC',
    )
    expect(whole[5]).toBe('  Annotations: the audit trail')
    expect(lines(render({ window: { from: at(0), sessionFiltered: false } }))[3]).toBe(
      '  Window: from 2026-07-10 12:00 UTC',
    )
    expect(lines(render({ window: { to: at(5), sessionFiltered: false } }))[3]).toBe(
      '  Window: to 2026-07-10 12:05 UTC',
    )
    expect(lines(render({ window: { from: at(0), to: at(5), sessionFiltered: false } }))[3]).toBe(
      '  Window: from 2026-07-10 12:00 UTC to 2026-07-10 12:05 UTC',
    )
    expect(lines(render({ annotationSource: 'demo' }))[5]).toBe(
      "  Annotations: the sample server's listed definitions (--demo)",
    )
  })

  it('names the epoch by selector: every epoch, one hash, or none', () => {
    const two = [epoch(HASH_B, 4, at(-20), at(-10), true), epoch(HASH_A, 1, at(0), at(10), true)]
    expect(lines(render({ epochSelector: 'all', result: result({ epochs: two }) }))[4]).toBe(
      '  Epoch: every config epoch in the window (2)',
    )
    const picked = [
      epoch(HASH_B, 4, at(-20), at(-10), true),
      epoch(HASH_A, 1, at(0), at(10), false),
    ]
    expect(
      lines(render({ epochSelector: 'config_sha', result: result({ epochs: picked }) }))[4],
    ).toBe(
      `  Epoch: config ${HASH_B.slice(0, 8)}..., 4 calls, 2026-07-10 11:40 UTC to 2026-07-10 11:50 UTC`,
    )
    expect(lines(render({ result: result({ rows: [], epochs: [] }) }))[4]).toBe(
      '  Epoch: no config epoch in the window',
    )
  })

  it('prints the retention line only when the open deleted rows, as a deletion by insert time', () => {
    const purged = lines(render({ purged: { before: at(-50_000), rows: 3 }, retention: '90d' }))
    expect(purged[4]).toBe(
      '  Retention: 3 row(s) inserted before 2026-06-05 18:40 UTC were deleted at open (audit.retention 90d).',
    )
    expect(render()).not.toContain('Retention:')
    expect(render({ purged: { before: at(-50_000), rows: 0 } })).not.toContain('Retention:')
  })

  it('prints the notice and the hint together, after the header and before any decision or fidelity line', () => {
    const text = render({
      result: result({
        epochs: [epoch(HASH_B, 4, at(-20), at(-10), false), epoch(HASH_A, 1, at(0), at(10), true)],
      }),
    })
    const all = lines(text)
    const notice = all.findIndex((l) => l.startsWith('Simulated the most recent config epoch only'))
    const hint = all.indexOf(EPOCH_FLAG_HINT)
    const decisions = all.findIndex((l) => l.startsWith('Baseline:') || l.startsWith('Decisions'))
    const fidelity = all.indexOf('Fidelity')
    expect(notice).toBeGreaterThan(5)
    expect(all.slice(6, notice).every((l) => l === '')).toBe(true)
    expect(hint).toBe(notice + 3)
    expect(decisions).toBeGreaterThan(hint)
    expect(fidelity).toBeGreaterThan(decisions)
    expect(EPOCH_FLAG_HINT).toBe(
      'Pass --across-configs to simulate every epoch in the window, or --config-sha <hash> to pick one.',
    )
    expect(render()).not.toContain(EPOCH_FLAG_HINT)
  })

  it('prints the standard decision block with right-aligned grouped counts and no zero line', () => {
    const rows: SimulatedRow[] = []
    for (let i = 0; i < 1200; i++)
      rows.push(
        row({
          record_id: `u-${String(i)}`,
          stored: outcome('rate_limit', null),
          simulated: outcome('rate_limit', null),
        }),
      )
    rows.push(
      row({
        record_id: 'd-1',
        stored: outcome('rate_limit', null),
        simulated: outcome('deny', 'policy_denied'),
      }),
      row({
        record_id: 'd-2',
        stored: outcome('rate_limit', null),
        simulated: outcome('rate_limit', 'rate_limited'),
      }),
      row({
        record_id: 'd-3',
        stored: outcome('rate_limit', null),
        simulated: outcome('allow', null, false, 'budget'),
        ticket_answer: 'unanswered',
      }),
      row({ record_id: 'd-4', stored: outcome('rate_limit', null), simulated: PLAIN }),
    )
    const text = render({ result: result({ rows }) })
    expect(text).toContain(
      [
        'Decisions (1,204 replayed)',
        '  1,200 unchanged',
        '      4 changed',
        '          2 would be blocked (policy_denied 1, rate_limited 1)',
        '          1 would be held for approval',
        '          1 would be allowed',
      ].join('\n'),
    )
    expect(text).not.toContain('would pass under a limit')
    expect(text).not.toContain('answered live')
    expect(text).not.toContain('not enforced')
  })

  it('prints every standard class when present', () => {
    const rows = [
      row({ record_id: 'd-1', stored: outcome('deny', 'policy_denied'), simulated: PLAIN }),
      row({
        record_id: 'd-2',
        stored: outcome('deny', 'policy_denied'),
        simulated: outcome('require_approval', null, false, 'rule'),
        ticket_answer: 'recorded',
      }),
      row({
        record_id: 'd-3',
        stored: outcome('deny', 'policy_denied'),
        simulated: outcome('rate_limit', null),
      }),
      row({
        record_id: 'd-4',
        stored: outcome('deny', 'policy_denied'),
        simulated: outcome('deny', null, true),
      }),
    ]
    const text = render({ result: result({ rows }) })
    expect(text).toContain(
      [
        'Decisions (4 replayed)',
        '  0 unchanged',
        '  4 changed',
        '      1 would require approval, answered live',
        '      1 would pass under a limit (rate_limit 1)',
        '      1 would be decided but not enforced (dry run: deny 1)',
        '      1 would be allowed',
      ].join('\n'),
    )
  })

  it('prints the first-policy block with the two sentences verbatim and the counts right-aligned', () => {
    const rows: SimulatedRow[] = []
    for (let i = 0; i < 1201; i++) rows.push(row({ record_id: `u-${String(i)}` }))
    for (let i = 0; i < 50; i++)
      rows.push(row({ record_id: `p-${String(i)}`, simulated: outcome('deny', 'policy_denied') }))
    for (let i = 0; i < 11; i++)
      rows.push(
        row({ record_id: `b-${String(i)}`, simulated: outcome('allow', 'budget_exceeded') }),
      )
    for (let i = 0; i < 9; i++)
      rows.push(
        row({
          record_id: `a-${String(i)}`,
          simulated: outcome('require_approval', null, false, 'rule'),
          ticket_answer: 'unanswered',
        }),
      )
    for (let i = 0; i < 3; i++)
      rows.push(row({ record_id: `l-${String(i)}`, simulated: outcome('rate_limit', null) }))
    for (let i = 0; i < 2; i++)
      rows.push(row({ record_id: `d-${String(i)}`, simulated: outcome('deny', null, true) }))
    const text = render({ result: result({ rows }) })
    expect(text).toContain(
      [
        'Baseline: no restrictive rules (default allow)',
        'This is your first policy, so every restriction is new.',
        '',
        '     61 calls would have been denied (policy_denied 50, budget_exceeded 11)',
        '      9 would have required approval',
        '      3 would have passed under a limit (rate_limit 3)',
        '      2 would have been decided but not enforced (dry run: deny 2)',
        '  1,201 unaffected',
      ].join('\n'),
    )
    expect(text).not.toContain('Decisions (')
  })

  it('groups the changed lines by tool, door, outcomes and rule in first-seen order with one or two instants', () => {
    const rows = [
      row({
        record_id: 'r-1',
        tool_name: 'pay',
        upstream: 'billing',
        timestamp: at(5),
        stored: outcome('spend_limit', null),
        simulated: outcome('require_approval', null, false, 'rule'),
        ticket_answer: 'unanswered',
        matched_rule: 'pay-gate',
        matched_rule_index: 1,
      }),
      row({
        record_id: 'r-2',
        tool_name: 'get_user',
        upstream: 'crm',
        timestamp: at(0),
        simulated: outcome('deny', 'policy_denied'),
        matched_rule: 'no-users',
        matched_rule_index: 0,
      }),
      row({
        record_id: 'r-3',
        tool_name: 'pay',
        upstream: 'billing',
        timestamp: at(6),
        stored: outcome('spend_limit', null),
        simulated: outcome('require_approval', null, false, 'rule'),
        ticket_answer: 'unanswered',
        matched_rule: 'pay-gate',
        matched_rule_index: 1,
      }),
      row({
        record_id: 'r-4',
        tool_name: 'ping',
        upstream: null,
        origin: 'lab-adapter',
        timestamp: at(7),
        simulated: outcome('deny', null, true),
        matched_rule: null,
        matched_rule_index: 2,
      }),
    ]
    const text = render({ result: result({ rows }) })
    expect(text).toContain(
      [
        'Changed decisions, by tool and rule',
        '  tool "pay" on door "billing": spend_limit -> require_approval (unanswered), rule "pay-gate": 2 calls, 2026-07-10 12:05 UTC to 2026-07-10 12:06 UTC',
        '  tool "get_user" on door "crm": allow -> deny (policy_denied), rule "no-users": 1 call, 2026-07-10 12:00 UTC',
        '  tool "ping" on origin "lab-adapter": allow -> deny (dry run), rule[2]: 1 call, 2026-07-10 12:07 UTC',
      ].join('\n'),
    )
    expect(render()).not.toContain('Changed decisions')
  })

  it('prints the fidelity lines verbatim and in order, filled from the frozen sentences', () => {
    const warnings: FidelityWarning[] = [
      {
        rule: 'block-email',
        dimension: 'tool annotations',
        subject: 'tool "send_email" on door "crm"',
        calls: 1,
        instants: [at(0)],
      },
      {
        rule: 'default',
        dimension: 'evidence',
        subject: 'tool "pay" on door "billing"',
        calls: 7,
        instants: [at(1), at(2), at(3), at(4), at(5), at(6), at(7)],
      },
    ]
    const skipped = { rejected: 1, kill_switch: 0 }
    const res = result({
      fidelity: {
        lines: renderFidelityLines({ warnings, skipped, unreported: 2 }),
        warnings,
        skipped,
        unreported: 2,
      },
      skipped,
      unreported: 2,
    })
    const text = renderSimulationText(buildSimulationReport(input({ result: res })))
    const all = lines(text)
    const head = all.indexOf('Fidelity')
    expect(head).toBeGreaterThan(0)
    expect(all.slice(head + 1, head + 6)).toEqual([
      `  ${res.fidelity.lines[0] ?? ''}`,
      '    at 2026-07-10 12:00 UTC',
      `  ${res.fidelity.lines[1] ?? ''}`,
      '    at 2026-07-10 12:01 UTC, 2026-07-10 12:02 UTC, 2026-07-10 12:03 UTC, 2026-07-10 12:04 UTC, 2026-07-10 12:05 UTC and 2 more',
      `  ${res.fidelity.lines[2] ?? ''}`,
    ])
    expect(all[head + 6]).toBe(`  ${res.fidelity.lines[3] ?? ''}`)
    expect(
      res.fidelity.lines[0]?.startsWith(FIDELITY_SENTENCES.unverified.split('<rule>')[0] ?? ''),
    ).toBe(true)
    expect(res.fidelity.lines[2]).toBe(
      FIDELITY_SENTENCES.skipped.replace('<n>', '1').replace('<a>', '1').replace('<b>', '0'),
    )
    expect(res.fidelity.lines[3]).toBe(FIDELITY_SENTENCES.unreported.replace('<n>', '2'))
    expect(text).not.toContain('and 0 more')
  })

  it('prints the budget line only when the harness has one, after the fidelity lines', () => {
    const text = render({
      result: result({
        budget_checks: [{ budget: 'pot', timestamp: at(0), stored_spent: 5, simulated_spent: 4 }],
      }),
    })
    const all = lines(text)
    const pot = all.findIndex((l) => l.startsWith('  The rebuilt budget spend did not meet'))
    expect(pot).toBeGreaterThan(all.indexOf('Fidelity'))
    expect(render()).not.toContain('rebuilt budget spend')
  })

  it('prints the demo line on every demo face and the closing sentence last on every face', () => {
    const demo = 'Annotations for --demo came from the sample server'
    const full = render({ annotationSource: 'demo' })
    const empty = render({ annotationSource: 'demo', result: result({ rows: [], epochs: [] }) })
    const trail = render()
    const trailEmpty = render({ result: result({ rows: [], epochs: [] }) })
    expect(full).toContain(demo)
    expect(empty).toContain(demo)
    expect(trail).not.toContain(demo)
    for (const text of [full, empty, trail, trailEmpty]) {
      const all = lines(text)
      expect(all[all.length - 1]).toBe(SIMULATION_CLOSING_LINE)
      expect(SIMULATION_CLOSING_LINE).toBe('No live tools were called. Nothing was applied.')
    }
    expect(lines(empty)[lines(empty).length - 2]).toContain(demo)
    expect(empty).toContain('No tool calls in the window.')
    expect(empty).not.toContain('Decisions (')
    expect(empty).not.toContain('Baseline:')
    expect(empty).toContain('Skipped 0 row(s)')
  })
})

// ---------------------------------------------------------------------------
// Privacy
// ---------------------------------------------------------------------------

describe('the simulation report privacy set (issue #490)', () => {
  it('carries no session id, record id, full epoch or baseline hash in text or JSON', () => {
    const SESSION = 'planted-session-id-7f3a'
    const RECORD = 'planted-record-id-9c1e'
    const EPOCH_HASH = 'd'.repeat(64)
    const OTHER_HASH = 'e'.repeat(64)
    const rows = [
      row({
        record_id: RECORD,
        session_id: SESSION,
        tool_name: 'send_email',
        simulated: outcome('deny', 'policy_denied'),
        matched_rule: 'no-email',
        unverified: [{ rule: 'x', dimension: 'evidence', subject: 'tool "send_email"' }],
      }),
    ]
    const report = buildSimulationReport(
      input({
        window: { sessionFiltered: true, upstream: 'crm' },
        result: result({
          rows,
          epochs: [
            epoch(OTHER_HASH, 2, at(-5), at(-4), false),
            epoch(EPOCH_HASH, 1, at(0), at(0), true),
          ],
          fidelity: {
            lines: [],
            warnings: [
              {
                rule: 'x',
                dimension: 'evidence',
                subject: 'tool "send_email"',
                calls: 1,
                instants: [at(0)],
              },
            ],
            skipped: { rejected: 0, kill_switch: 0 },
            unreported: 0,
          },
        }),
        recordId: RECORD,
      }),
    )
    const json = JSON.stringify(report)
    const text = renderSimulationText(report)
    for (const planted of [SESSION, EPOCH_HASH, OTHER_HASH]) {
      expect(json).not.toContain(planted)
      expect(text).not.toContain(planted)
    }
    expect(text).not.toContain(RECORD)
    expect(text).not.toContain(CANDIDATE)
    expect(json.split(RECORD)).toHaveLength(2)
    expect(json.split(CANDIDATE)).toHaveLength(2)
    expect(json).toContain(EPOCH_HASH.slice(0, 8))
    expect(json).toContain(OTHER_HASH.slice(0, 8))
    expect(report.window.session_filtered).toBe(true)
    expect(report.window.upstream).toBe('crm')
    expect('session_id' in report.window).toBe(false)
  })
})
