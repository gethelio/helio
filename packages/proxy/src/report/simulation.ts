// ---------------------------------------------------------------------------
// Policy simulation report: what `helio policy simulate` prints (issue
// #490). One pure builder makes ONE object from the harness's result and
// the facts the command adds (the candidate's name, the window it asked
// for, the epochs' reloads, the purge the open ran), and one renderer
// prints it as text; JSON is the object itself.
//
// The privacy set is the fidelity page's: tool, door, origin and rule
// names, counts and instants. No argument, session id, record id, path or
// full hash enters the object except the candidate's own hash, the
// provenance key; epoch and baseline hashes are prefixes. The three frozen
// fidelity sentences come from the harness untouched and nothing
// suppresses them.
//
// snake_case throughout: `--format json` serializes the report verbatim.
// ---------------------------------------------------------------------------

import { readPolicyReloadEvidence } from '../audit/policy-reload.js'
import type { EpochReloads } from '../audit/types.js'
import { DEMO_ANNOTATION_LINE } from '../demo/annotations.js'
import {
  formatBudgetCheckLine,
  formatConfigEpochNotice,
  subjectOf,
} from '../policy/simulate/fidelity.js'
import type {
  ConfigEpoch,
  FidelityMark,
  FidelityWarning,
  PolicySimulationResult,
  SimulatedOutcome,
  SimulatedRow,
  SkippedRows,
} from '../policy/simulate/types.js'
import { formatUtcDay, formatUtcMinute } from '../util/format-time.js'

// ---------------------------------------------------------------------------
// The artifact
// ---------------------------------------------------------------------------

export const SIMULATION_REPORT_SCHEMA_VERSION = 1

/** The last line of every run: the report changed nothing. */
export const SIMULATION_CLOSING_LINE = 'No live tools were called. Nothing was applied.'

/** The line the command appends under the harness's multi-epoch notice, which names no flag. */
export const EPOCH_FLAG_HINT =
  'Pass --across-configs to simulate every epoch in the window, or --config-sha <hash> to pick one.'

/** The six classes of a changed decision, in the order they are tested. */
export type DeltaClass =
  | 'unanswered'
  | 'blocked'
  | 'dry_run'
  | 'approval_recorded'
  | 'limited'
  | 'allowed'

export type SimulationEpochSelector = 'latest' | 'all' | 'config_sha'

export interface SimulationReportEpoch {
  /** The shortest prefix unique among the window's epochs, at least 8 characters; null for rows that carry no hash. */
  readonly config_sha256_prefix: string | null
  readonly rows: number
  readonly first_timestamp: string
  readonly last_timestamp: string
  readonly selected: boolean
}

export interface SimulationReportWindow {
  readonly from: string | null
  readonly to: string | null
  /** The retention cutoff the open deleted by insert time, only when it deleted something; never a replay bound. */
  readonly purged_before: string | null
  readonly purged_rows: number
  /** The deployed `audit.retention`, the horizon the open purged with. */
  readonly retention: string
  readonly upstream: string | null
  /** True when a session filter was given; the id itself stays on the command line. */
  readonly session_filtered: boolean
}

export interface SimulationReportBaseline {
  readonly config_sha256_prefix: string | null
  readonly first_policy: boolean
  /** True when every selected epoch has an applied reload that opened it. */
  readonly opening_reload: boolean
}

/** One changed decision, copied by name: no record id, no session id. */
export interface SimulationReportDelta {
  readonly timestamp: string
  readonly tool_name: string
  readonly upstream: string | null
  readonly origin: string
  readonly stored: SimulatedOutcome
  readonly simulated: SimulatedOutcome
  readonly matched_rule: string | null
  readonly matched_rule_index: number | null
  readonly ticket_answer: 'recorded' | 'unanswered' | null
  readonly class: DeltaClass
  readonly unverified: readonly FidelityMark[]
}

export interface SimulationReportDeltas {
  readonly total: number
  readonly blocked: number
  readonly unanswered: number
  readonly approval_recorded: number
  readonly limited: number
  readonly dry_run: number
  readonly allowed: number
  readonly blocked_by_reason: ReadonlyArray<{ readonly reason: string; readonly count: number }>
  readonly dry_run_by_decision: ReadonlyArray<{ readonly decision: string; readonly count: number }>
  readonly rows: readonly SimulationReportDelta[]
}

export interface SimulationReportFidelity {
  readonly lines: readonly string[]
  readonly warnings: readonly FidelityWarning[]
  readonly skipped: SkippedRows
  readonly unreported: number
}

export interface SimulationReport {
  readonly schema_version: number
  readonly helio_version: string
  readonly generated_at: string
  readonly candidate: { readonly name: string; readonly sha256: string }
  readonly annotation_source: 'trail' | 'demo'
  readonly window: SimulationReportWindow
  readonly epoch: {
    readonly selector: SimulationEpochSelector
    readonly epochs: readonly SimulationReportEpoch[]
  }
  readonly baseline: SimulationReportBaseline
  readonly replayed: number
  readonly skipped: SkippedRows
  readonly unreported: number
  readonly changed: boolean
  readonly deltas: SimulationReportDeltas
  readonly fidelity: SimulationReportFidelity
  /** The pot and the instant of each snapshot the rebuilt spend did not meet; the amounts stay in the database. */
  readonly budget_checks: ReadonlyArray<{ readonly budget: string; readonly timestamp: string }>
  readonly budget_check_line: string
  readonly epoch_notice: string
  readonly demo_line: string | null
  readonly warnings_suppressed: number
  readonly provenance: { readonly record_id: string | null }
}

/** What the builder takes beside the harness's result. */
export interface SimulationReportInput {
  readonly result: PolicySimulationResult
  /** The candidate file's basename. */
  readonly candidateName: string
  readonly annotationSource: 'trail' | 'demo'
  readonly window: {
    readonly from?: string
    readonly to?: string
    readonly upstream?: string
    readonly sessionFiltered: boolean
  }
  readonly epochSelector: SimulationEpochSelector
  /** One entry per selected epoch, from the store's `epochReloads`. */
  readonly reloads: readonly EpochReloads[]
  /** The deployed `audit.retention`. */
  readonly retention: string
  /** The cutoff and the count of the open's purge; null when it deleted nothing. */
  readonly purged: { readonly before: string; readonly rows: number } | null
  readonly helioVersion: string
  readonly generatedAt: string
  readonly recordId: string | null
}

// ---------------------------------------------------------------------------
// Classification and the first-policy predicate
// ---------------------------------------------------------------------------

/**
 * The class of a changed decision, over the simulated outcome, in this
 * order: a held call (unanswered ticket, whatever its decision), a block
 * (any `block_reason`), a decision made but not enforced (a dry run
 * carries no ticket and no reason, so it is tested before the two classes
 * that read the decision alone: a dry-run `require_approval` was never
 * answered and a dry-run limit consumed nothing), a recorded approval that
 * passed, a passing limit, a plain allow.
 */
export function classifyDelta(row: SimulatedRow): DeltaClass {
  const { simulated } = row
  if (row.ticket_answer === 'unanswered') return 'unanswered'
  if (simulated.block_reason !== null) return 'blocked'
  if (simulated.dry_run) return 'dry_run'
  if (simulated.policy_decision === 'require_approval') return 'approval_recorded'
  if (simulated.policy_decision === 'rate_limit' || simulated.policy_decision === 'spend_limit')
    return 'limited'
  return 'allowed'
}

function isPlainAllow(outcome: SimulatedOutcome): boolean {
  return (
    outcome.policy_decision === 'allow' &&
    outcome.block_reason === null &&
    !outcome.dry_run &&
    outcome.ticket === 'none'
  )
}

/** True when the reload recorded no rule, default allow and no budget; false for unreadable evidence. */
function reloadReadsEmpty(reload: EpochReloads['within'][number]): boolean {
  const evidence = readPolicyReloadEvidence(reload)
  return (
    evidence !== null &&
    evidence.rule_count_after === 0 &&
    evidence.default_action_after === 'allow' &&
    evidence.budget_count_after === 0
  )
}

/**
 * Whether the replayed baseline was a no-restriction policy, so the report
 * frames every restriction as new. Two signals: every replayed row's stored
 * outcome is the plain allow (and there is at least one row), and every
 * applied reload of each selected epoch's hash between its neighbors reads
 * no rule, default allow and no budget. A rule or budget that never matched
 * a call in the window and a restriction outside the rule list (a
 * `flag_destructive`, an `on_tool_drift`) are invisible to both signals;
 * `matched_rule_index` on a row is the candidate's match and is not read.
 */
export function isFirstPolicyBaseline(
  rows: readonly SimulatedRow[],
  reloads: readonly EpochReloads[],
): boolean {
  if (rows.length === 0) return false
  if (!rows.every((row) => isPlainAllow(row.stored))) return false
  return reloads.every((entry) => entry.within.every(reloadReadsEmpty))
}

// ---------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------

const MIN_PREFIX = 8

/**
 * The shortest prefix of each hash that no other hash in the set shares, at
 * least 8 characters: what the JSON prints for epoch and baseline hashes
 * and what `--config-sha` takes back.
 */
export function shortestUniquePrefixes(hashes: readonly string[]): ReadonlyMap<string, string> {
  const distinct = [...new Set(hashes)]
  const prefixes = new Map<string, string>()
  for (const hash of distinct) {
    let length = MIN_PREFIX
    while (
      length < hash.length &&
      distinct.some((other) => other !== hash && other.startsWith(hash.slice(0, length)))
    ) {
      length += 1
    }
    prefixes.set(hash, hash.slice(0, length))
  }
  return prefixes
}

function countBy<T>(items: readonly T[], key: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const item of items) {
    const k = key(item)
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  return counts
}

/** Entries by count descending, then by name. */
function sortedCounts(counts: Map<string, number>): ReadonlyArray<readonly [string, number]> {
  return [...counts.entries()].sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
}

function projectDelta(row: SimulatedRow): SimulationReportDelta {
  return {
    timestamp: row.timestamp,
    tool_name: row.tool_name,
    upstream: row.upstream,
    origin: row.origin,
    stored: row.stored,
    simulated: row.simulated,
    matched_rule: row.matched_rule,
    matched_rule_index: row.matched_rule_index,
    ticket_answer: row.ticket_answer,
    class: classifyDelta(row),
    unverified: row.unverified,
  }
}

/** Build the report object. Pure: the same input yields the same object. */
export function buildSimulationReport(input: SimulationReportInput): SimulationReport {
  const { result } = input
  const prefixes = shortestUniquePrefixes(
    result.epochs.flatMap((epoch) => (epoch.config_sha256 === null ? [] : [epoch.config_sha256])),
  )
  const prefixOf = (hash: string | null): string | null =>
    hash === null ? null : (prefixes.get(hash) ?? hash.slice(0, MIN_PREFIX))
  const epochs = result.epochs.map((epoch: ConfigEpoch) => ({
    config_sha256_prefix: prefixOf(epoch.config_sha256),
    rows: epoch.rows,
    first_timestamp: epoch.first_timestamp,
    last_timestamp: epoch.last_timestamp,
    selected: epoch.selected,
  }))
  const selected = result.epochs.filter((epoch) => epoch.selected)
  const baselineHash =
    input.epochSelector === 'all' || selected.length !== 1
      ? null
      : (selected[0]?.config_sha256 ?? null)

  const deltas = result.deltas.map(projectDelta)
  const classes = countBy(deltas, (delta) => delta.class)
  const count = (cls: DeltaClass): number => classes.get(cls) ?? 0
  const blockedByReason = sortedCounts(
    countBy(
      deltas.filter((delta) => delta.class === 'blocked'),
      (delta) => delta.simulated.block_reason ?? 'unknown',
    ),
  ).map(([reason, n]) => ({ reason, count: n }))
  const dryRunByDecision = sortedCounts(
    countBy(
      deltas.filter((delta) => delta.class === 'dry_run'),
      (delta) => delta.simulated.policy_decision,
    ),
  ).map(([decision, n]) => ({ decision, count: n }))

  return {
    schema_version: SIMULATION_REPORT_SCHEMA_VERSION,
    helio_version: input.helioVersion,
    generated_at: input.generatedAt,
    candidate: { name: input.candidateName, sha256: result.candidate_sha256 },
    annotation_source: input.annotationSource,
    window: {
      from: input.window.from ?? null,
      to: input.window.to ?? null,
      purged_before: input.purged !== null && input.purged.rows > 0 ? input.purged.before : null,
      purged_rows: input.purged?.rows ?? 0,
      retention: input.retention,
      upstream: input.window.upstream ?? null,
      session_filtered: input.window.sessionFiltered,
    },
    epoch: { selector: input.epochSelector, epochs },
    baseline: {
      config_sha256_prefix: prefixOf(baselineHash),
      first_policy: isFirstPolicyBaseline(result.rows, input.reloads),
      opening_reload:
        input.reloads.length > 0 && input.reloads.every((entry) => entry.opener !== undefined),
    },
    replayed: result.replayed,
    skipped: result.skipped,
    unreported: result.unreported,
    changed: deltas.length > 0,
    deltas: {
      total: deltas.length,
      blocked: count('blocked'),
      unanswered: count('unanswered'),
      approval_recorded: count('approval_recorded'),
      limited: count('limited'),
      dry_run: count('dry_run'),
      allowed: count('allowed'),
      blocked_by_reason: blockedByReason,
      dry_run_by_decision: dryRunByDecision,
      rows: deltas,
    },
    fidelity: {
      lines: result.fidelity.lines,
      warnings: result.fidelity.warnings,
      skipped: result.fidelity.skipped,
      unreported: result.fidelity.unreported,
    },
    budget_checks: result.budget_checks.map((check) => ({
      budget: check.budget,
      timestamp: check.timestamp,
    })),
    budget_check_line: formatBudgetCheckLine(result.budget_checks),
    epoch_notice: formatConfigEpochNotice(result.epochs),
    demo_line: input.annotationSource === 'demo' ? DEMO_ANNOTATION_LINE : null,
    warnings_suppressed: result.warnings_suppressed,
    provenance: { record_id: input.recordId },
  }
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

const INSTANTS_SHOWN = 5

/** The baseline line of a replay whose stored decisions were all plain allows under no rule and no budget. */
const FIRST_POLICY_BASELINE_LINE = 'Baseline: no restrictive rules (default allow)'

function n(value: number): string {
  return value.toLocaleString('en-US')
}

function calls(count: number): string {
  return `${n(count)} ${count === 1 ? 'call' : 'calls'}`
}

function versionLabel(version: string): string {
  return version === '0.0.0' ? 'Helio 0.0.0 (unreleased build)' : `Helio ${version}`
}

function windowLine(window: SimulationReportWindow): string {
  if (window.from === null && window.to === null) return 'the whole trail'
  const parts: string[] = []
  if (window.from !== null) parts.push(`from ${formatUtcMinute(window.from)}`)
  if (window.to !== null) parts.push(`to ${formatUtcMinute(window.to)}`)
  return parts.join(' ')
}

function span(epoch: SimulationReportEpoch): string {
  return `${formatUtcMinute(epoch.first_timestamp)} to ${formatUtcMinute(epoch.last_timestamp)}`
}

function epochLine(report: SimulationReport): string {
  const { selector, epochs } = report.epoch
  if (selector === 'all') return `every config epoch in the window (${String(epochs.length)})`
  const chosen = epochs.find((epoch) => epoch.selected)
  if (chosen === undefined) return 'no config epoch in the window'
  const name =
    selector === 'latest' && epochs[epochs.length - 1] === chosen
      ? 'the most recent config epoch'
      : chosen.config_sha256_prefix === null
        ? 'unknown config'
        : `config ${chosen.config_sha256_prefix}...`
  return `${name}, ${calls(chosen.rows)}, ${span(chosen)}`
}

/** A breakdown in parentheses: `(policy_denied 50, budget_exceeded 11)`. */
function breakdown(entries: ReadonlyArray<readonly [string, number]>): string {
  return entries.length === 0
    ? ''
    : ` (${entries.map(([name, count]) => `${name} ${n(count)}`).join(', ')})`
}

/** Right-align every count of a block to the widest, with `indent` leading spaces. */
function alignedLines(
  entries: ReadonlyArray<readonly [number, string, number]>,
): readonly string[] {
  const width = Math.max(...entries.map(([count]) => n(count).length))
  return entries.map(
    ([count, label, indent]) => `${' '.repeat(indent)}${n(count).padStart(width)} ${label}`,
  )
}

function standardBlock(report: SimulationReport): readonly string[] {
  const d = report.deltas
  const unchanged = report.replayed - d.total
  const entries: Array<readonly [number, string, number]> = [
    [unchanged, 'unchanged', 2],
    [d.total, 'changed', 2],
  ]
  const sub = (count: number, label: string): void => {
    if (count > 0) entries.push([count, label, 6])
  }
  sub(
    d.blocked,
    `would be blocked${breakdown(d.blocked_by_reason.map((e) => [e.reason, e.count] as const))}`,
  )
  sub(d.unanswered, 'would be held for approval')
  sub(d.approval_recorded, 'would require approval, answered live')
  sub(d.limited, `would pass under a limit${breakdown(limitBreakdown(d.rows))}`)
  sub(
    d.dry_run,
    `would be decided but not enforced${breakdown(d.dry_run_by_decision.map((e) => [`dry run: ${e.decision}`, e.count] as const))}`,
  )
  sub(d.allowed, 'would be allowed')
  return [`Decisions (${n(report.replayed)} replayed)`, ...alignedLines(entries)]
}

function limitBreakdown(
  rows: readonly SimulationReportDelta[],
): ReadonlyArray<readonly [string, number]> {
  return sortedCounts(
    countBy(
      rows.filter((row) => row.class === 'limited'),
      (row) => row.simulated.policy_decision,
    ),
  )
}

function firstPolicyBlock(report: SimulationReport): readonly string[] {
  const d = report.deltas
  const unaffected = report.replayed - d.total
  const entries: Array<readonly [number, string, number]> = []
  const line = (count: number, label: string): void => {
    if (count > 0) entries.push([count, label, 2])
  }
  line(
    d.blocked,
    `calls would have been denied${breakdown(d.blocked_by_reason.map((e) => [e.reason, e.count] as const))}`,
  )
  line(d.unanswered, 'would have required approval')
  line(d.approval_recorded, 'would have required approval, answered live')
  line(d.limited, `would have passed under a limit${breakdown(limitBreakdown(d.rows))}`)
  line(
    d.dry_run,
    `would have been decided but not enforced${breakdown(d.dry_run_by_decision.map((e) => [`dry run: ${e.decision}`, e.count] as const))}`,
  )
  line(d.allowed, 'would have been allowed')
  entries.push([unaffected, 'unaffected', 2])
  return [
    FIRST_POLICY_BASELINE_LINE,
    'This is your first policy, so every restriction is new.',
    '',
    ...alignedLines(entries),
  ]
}

/** `deny (policy_denied)`, `require_approval (unanswered)`, `deny (dry run)`: the decision and its qualifiers. */
function describeOutcome(
  outcome: SimulatedOutcome,
  answer: 'recorded' | 'unanswered' | null,
): string {
  const qualifiers: string[] = []
  if (outcome.block_reason !== null) qualifiers.push(outcome.block_reason)
  if (outcome.dry_run) qualifiers.push('dry run')
  if (answer === 'unanswered') qualifiers.push('unanswered')
  return qualifiers.length === 0
    ? outcome.policy_decision
    : `${outcome.policy_decision} (${qualifiers.join(', ')})`
}

function ruleLabelOf(delta: SimulationReportDelta): string {
  if (delta.matched_rule !== null) return `rule "${delta.matched_rule}"`
  if (delta.matched_rule_index !== null) return `rule[${String(delta.matched_rule_index)}]`
  return 'default'
}

function instantsOf(instants: readonly string[]): string {
  if (instants.length === 1) return formatUtcMinute(instants[0] ?? '')
  const first = instants[0] ?? ''
  const last = instants[instants.length - 1] ?? ''
  return `${formatUtcMinute(first)} to ${formatUtcMinute(last)}`
}

function changedLines(report: SimulationReport): readonly string[] {
  const groups = new Map<string, { readonly head: string; readonly instants: string[] }>()
  for (const delta of report.deltas.rows) {
    const subject = subjectOf(delta.tool_name, delta.upstream, delta.origin)
    const head =
      `${subject}: ${describeOutcome(delta.stored, null)} -> ` +
      `${describeOutcome(delta.simulated, delta.ticket_answer)}, ${ruleLabelOf(delta)}`
    const group = groups.get(head)
    if (group === undefined) groups.set(head, { head, instants: [delta.timestamp] })
    else group.instants.push(delta.timestamp)
  }
  if (groups.size === 0) return []
  return [
    'Changed decisions, by tool and rule',
    ...[...groups.values()].map(
      (group) => `  ${group.head}: ${calls(group.instants.length)}, ${instantsOf(group.instants)}`,
    ),
  ]
}

/** The instants of one warning: one for one call, up to five then `and N more`. */
function warningInstants(warning: FidelityWarning): string {
  const shown = warning.instants.slice(0, INSTANTS_SHOWN).map(formatUtcMinute)
  const more = warning.instants.length - shown.length
  return `    at ${shown.join(', ')}${more > 0 ? ` and ${n(more)} more` : ''}`
}

function fidelityLines(report: SimulationReport): readonly string[] {
  const out: string[] = ['Fidelity']
  const warnings = report.fidelity.warnings
  report.fidelity.lines.forEach((line, index) => {
    out.push(`  ${line}`)
    const warning = warnings[index]
    if (index < warnings.length && warning !== undefined && warning.instants.length > 0)
      out.push(warningInstants(warning))
  })
  if (report.budget_check_line !== '') out.push(`  ${report.budget_check_line}`)
  return out
}

/** Render the report as the terminal text. */
export function renderSimulationText(report: SimulationReport): string {
  const lines: string[] = []
  lines.push('Policy simulation')
  lines.push(`  Candidate: ${report.candidate.name}`)
  lines.push(
    `  Written by ${versionLabel(report.helio_version)} on ${formatUtcDay(report.generated_at)} (UTC).`,
  )
  lines.push(`  Window: ${windowLine(report.window)}`)
  if (report.window.purged_before !== null && report.window.purged_rows > 0) {
    lines.push(
      `  Retention: ${n(report.window.purged_rows)} row(s) inserted before ` +
        `${formatUtcMinute(report.window.purged_before)} were deleted at open ` +
        `(audit.retention ${report.window.retention}).`,
    )
  }
  lines.push(`  Epoch: ${epochLine(report)}`)
  lines.push(
    `  Annotations: ${
      report.annotation_source === 'demo'
        ? "the sample server's listed definitions (--demo)"
        : 'the audit trail'
    }`,
  )

  if (report.epoch_notice !== '') {
    lines.push('')
    lines.push(report.epoch_notice)
    lines.push(EPOCH_FLAG_HINT)
  }

  // The first-policy framing reads "every restriction is new"; a run that
  // changes nothing has no restriction to frame, so it names the baseline
  // on one line and prints the standard block under it.
  lines.push('')
  if (report.replayed === 0) {
    lines.push('No tool calls in the window.')
  } else if (report.baseline.first_policy && report.changed) {
    lines.push(...firstPolicyBlock(report))
  } else {
    if (report.baseline.first_policy) lines.push(FIRST_POLICY_BASELINE_LINE, '')
    lines.push(...standardBlock(report))
  }

  const changed = changedLines(report)
  if (changed.length > 0) {
    lines.push('')
    lines.push(...changed)
  }

  lines.push('')
  lines.push(...fidelityLines(report))

  lines.push('')
  if (report.demo_line !== null) lines.push(report.demo_line)
  lines.push(SIMULATION_CLOSING_LINE)
  return lines.join('\n')
}
