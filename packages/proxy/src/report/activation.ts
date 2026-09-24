// ---------------------------------------------------------------------------
// Activation report: the redacted, user-shared artifact `helio report
// activation` writes (issue #400). One pure builder makes ONE object from two
// sources, the audit database on disk and the running proxy's policy status,
// and one renderer prints it as text; JSON is the object itself.
//
// Redaction is a WHITELIST: every field is copied by name into the shapes
// below, never spread. The default output carries counts, ratios, dates,
// decision classes and enum values; `names_included` restores tool, door and
// rule names and nothing else. No path, host, port, hash, secret source,
// session id, tool input, upstream response or environment label ever
// enters the object, with or without names.
//
// snake_case throughout: `--format json` serializes the report verbatim.
// ---------------------------------------------------------------------------

import type { ActivationTimeline, ActivationWindow, PersistedSummary } from '../audit/types.js'
import type { BlockReason } from '../feedback/self-repair.js'
import type { PolicyStatusReport } from '../policy/status.js'
import type { SurfaceCoverage, SurfaceDoorRef, SurfacePair } from '../policy/surface.js'
import type { PolicyAction } from '../policy/types.js'
import { formatUtcDay, formatUtcMinute } from '../util/format-time.js'

// ---------------------------------------------------------------------------
// The artifact
// ---------------------------------------------------------------------------

export const ACTIVATION_REPORT_SCHEMA_VERSION = 1

/** Why the running proxy's snapshot is absent; a fixed sentence per code, never interpolated. */
export type SnapshotAbsentReason =
  | 'dashboard_disabled'
  | 'secret_is_digest'
  | 'no_proxy_answered'
  | 'secret_refused'
  | 'status_unavailable'
  | 'api_error'

/**
 * The config file's hash against the newest audit record of ANY kind (every
 * record is stamped with the hash in force when it was written): `no_record`
 * on an empty table, `no_hash` when that record carries no hash.
 */
export type ConfigFileVsLastPolicyWrite = 'match' | 'mismatch' | 'no_hash' | 'no_record'

export interface ActivationSources {
  readonly audit_database: 'read'
  readonly config_file_vs_last_policy_write: ConfigFileVsLastPolicyWrite
  readonly proxy_snapshot: 'present' | 'absent'
  readonly proxy_snapshot_absent_reason: SnapshotAbsentReason | null
  /** A constant: the command never verifies that the answering process wrote this database. */
  readonly proxy_snapshot_verified: false
}

export type FirstRuleSource = 'first_rule_decided_call' | 'first_applied_reload'

/** A stage this build does not have; never rendered as something the user did not do. */
export interface UnavailableStage {
  readonly available: false
  readonly reason: 'not in this version'
}

export interface ActivationReportTimeline {
  readonly first_call_observed: {
    readonly at: string | null
    readonly source: 'first_persisted_tool_call'
  }
  readonly first_rule: {
    readonly at: string | null
    readonly source: FirstRuleSource | null
    readonly rule_name?: string
  }
  readonly first_generation: UnavailableStage
  readonly first_simulation: UnavailableStage
  readonly first_apply: UnavailableStage
  readonly first_enforcement_decision: {
    readonly at: string | null
    readonly block_reason: string | null
    readonly tool?: string
  }
}

export interface ActivationCalledPair {
  readonly tool_name: string
  readonly upstream: string | null
  readonly origin: string
  readonly calls: number
}

export interface ActivationPersisted {
  readonly window: string
  readonly since: string
  readonly calls_in_window: number
  readonly sessions_in_window: number
  readonly anonymous_calls_in_window: number
  readonly tool_doors_called_in_window: number
  readonly decisions: {
    readonly permitted: number
    readonly blocked: number
    readonly dry_run: number
    readonly approvals_requested: number
  }
  /** Keyed by a known block reason, or `other` for any value outside the closed set. */
  readonly blocked_by_reason: Readonly<Record<string, number>>
  readonly config_versions_in_window: number
  readonly policy_reloads_in_window: { readonly recorded: number; readonly applied: number }
  readonly first_seen: string | null
  readonly pairs_called_in_window?: readonly ActivationCalledPair[]
}

export interface ActivationSnapshotDoor {
  readonly kind: 'upstream' | 'adapter'
  readonly available: boolean
  readonly tool_count: number
  readonly annotated_count: number
  readonly annotated_destructive: number
  readonly name?: string | null
  readonly origin?: string
  readonly unavailable_reason?: string | null
}

export interface ActivationSnapshot {
  readonly status_schema_version: number
  readonly generated_at: string
  readonly window: string
  readonly since: string
  readonly policy: PolicyStatusReport['policy']
  readonly surface: {
    readonly pairs: number
    readonly upstream_count: number
    readonly adapter_origin_count: number
    readonly annotated_destructive: number
    readonly default_destructive: number
    readonly annotation_free_door_count: number
    readonly unavailable_door_count: number
    readonly annotation_free_doors?: readonly string[]
    readonly unavailable?: readonly { readonly name: string; readonly reason: string }[]
    readonly doors: readonly ActivationSnapshotDoor[]
  }
  readonly coverage: {
    readonly matched: number
    readonly conditional: number
    readonly conditional_on: 'arguments' | 'metadata' | 'arguments or metadata' | null
    readonly uncovered: number
    readonly default_action: 'allow' | 'deny'
    readonly by_effective_action: Readonly<Record<PolicyAction, number>>
    readonly pairs?: readonly SurfacePair[]
  }
  /** The two join counts the proxy computes over ITS OWN database. */
  readonly persisted_join: {
    readonly reachable_permitted_never_called_in_window: number
    readonly called_not_reachable_in_window: number
  }
  readonly readiness: {
    readonly ready: boolean
    readonly suppressed: boolean
    readonly calls_in_window: number
    readonly tool_doors_called_in_window: number
    readonly thresholds: { readonly min_calls: number; readonly min_tool_doors: number }
  }
}

export interface ActivationReport {
  readonly schema_version: number
  readonly generated_at: string
  readonly helio_version: string
  readonly names_included: boolean
  readonly window: string
  readonly since: string
  readonly retention: string
  readonly sources: ActivationSources
  readonly timeline: ActivationReportTimeline
  readonly persisted: ActivationPersisted
  readonly snapshot: ActivationSnapshot | null
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export type SnapshotInput =
  | { readonly ok: true; readonly report: PolicyStatusReport }
  | { readonly ok: false; readonly code: SnapshotAbsentReason }

export interface ActivationReportInput {
  /** The report's own clock; `generated_at`, `since` and `persisted.since` derive from it. */
  readonly now: Date
  readonly helioVersion: string
  /** The window as the caller asked for it, echoed as given. */
  readonly window: string
  readonly windowMs: number
  readonly retention: string
  readonly includeNames: boolean
  readonly configFileVsLastPolicyWrite: ConfigFileVsLastPolicyWrite
  readonly persisted: PersistedSummary
  readonly activationWindow: ActivationWindow
  readonly timeline: ActivationTimeline
  readonly snapshot: SnapshotInput
}

/** The window's start on the report's clock; the CLI queries the store with the same instant. */
export function windowSince(now: Date, windowMs: number): string {
  return new Date(now.getTime() - windowMs).toISOString()
}

// ---------------------------------------------------------------------------
// Closed sets
// ---------------------------------------------------------------------------

/**
 * Every block reason the artifact may carry by name: the self-repair union
 * plus the three the sideband and the budget gate write beside it. The
 * `block_reason` column is unconstrained, so anything else renders as
 * `other`. A `Record` keyed by the union keeps this list exhaustive at
 * compile time.
 */
const KNOWN_BLOCK_REASONS: Readonly<Record<BlockReason | 'cancelled' | 'install_denied', true>> = {
  policy_denied: true,
  evidence_missing: true,
  evidence_expired: true,
  dependency_missing: true,
  rate_limited: true,
  spend_limited: true,
  approval_denied: true,
  approval_timeout: true,
  client_disconnected: true,
  shutdown_cancelled: true,
  tool_definition_drift: true,
  budget_exceeded: true,
  session_unresolved: true,
  cancelled: true,
  install_denied: true,
}

function mapBlockReason(reason: string): string {
  return Object.hasOwn(KNOWN_BLOCK_REASONS, reason) ? reason : 'other'
}

const ACTION_KEYS: Readonly<Record<PolicyAction, true>> = {
  allow: true,
  deny: true,
  require_approval: true,
  rate_limit: true,
  spend_limit: true,
  dry_run: true,
}
const ACTION_ORDER = Object.keys(ACTION_KEYS) as readonly PolicyAction[]

const ABSENT_SNAPSHOT_SENTENCES: Readonly<Record<SnapshotAbsentReason, string>> = {
  no_proxy_answered: 'No proxy answered on the configured dashboard port',
  dashboard_disabled: 'The dashboard is disabled in the config file',
  secret_is_digest: 'The dashboard secret found is a sha256: digest, not the secret',
  secret_refused: 'The proxy refused the dashboard secret',
  status_unavailable:
    'A process answered but serves no policy status (a library embedding, not helio start)',
  api_error: 'The proxy answered with an error',
}

const SAME_FILE_SENTENCES: Readonly<Record<ConfigFileVsLastPolicyWrite, string>> = {
  match: 'this config file is the one that last wrote policy to it',
  mismatch: 'this config file is NOT the one that last wrote policy to it',
  no_hash: 'the newest record carries no config hash; the history predates v0.14',
  no_record: 'no record has been written yet',
}

const UNAVAILABLE_STAGE: UnavailableStage = { available: false, reason: 'not in this version' }

const FIRST_RULE_CAVEAT =
  'Rules present at the first start, or edited between runs, leave no reload record; ' +
  'a rule is visible here only once it decides a call or arrives by a live reload.'

// ---------------------------------------------------------------------------
// Builder (pure: no I/O, no clock but `input.now`)
// ---------------------------------------------------------------------------

/** Assemble the report. Pure: the same inputs and the same `now` give byte-identical JSON. */
export function buildActivationReport(input: ActivationReportInput): ActivationReport {
  const since = windowSince(input.now, input.windowMs)
  const names = input.includeNames
  return {
    schema_version: ACTIVATION_REPORT_SCHEMA_VERSION,
    generated_at: input.now.toISOString(),
    helio_version: input.helioVersion,
    names_included: names,
    window: input.window,
    since,
    retention: input.retention,
    sources: {
      audit_database: 'read',
      config_file_vs_last_policy_write: input.configFileVsLastPolicyWrite,
      proxy_snapshot: input.snapshot.ok ? 'present' : 'absent',
      proxy_snapshot_absent_reason: input.snapshot.ok ? null : input.snapshot.code,
      proxy_snapshot_verified: false,
    },
    timeline: buildTimeline(input.persisted, input.timeline, names),
    persisted: buildPersisted(input.window, since, input.persisted, input.activationWindow, names),
    snapshot: input.snapshot.ok ? projectSnapshot(input.snapshot.report, names) : null,
  }
}

function buildTimeline(
  persisted: PersistedSummary,
  timeline: ActivationTimeline,
  names: boolean,
): ActivationReportTimeline {
  const decided = timeline.first_rule_decided_call
  const reload = timeline.first_applied_reload
  // The earlier of the two dated facts wins; the source names which.
  const ruleFromCall =
    decided !== null && (reload === null || decided.created_at <= reload.created_at)
  const firstRule: ActivationReportTimeline['first_rule'] = ruleFromCall
    ? {
        at: decided.created_at,
        source: 'first_rule_decided_call',
        ...(names ? { rule_name: decided.matched_rule } : {}),
      }
    : reload !== null
      ? { at: reload.created_at, source: 'first_applied_reload' }
      : { at: null, source: null }
  const blocked = timeline.first_blocked_call
  return {
    first_call_observed: { at: persisted.first_seen, source: 'first_persisted_tool_call' },
    first_rule: firstRule,
    first_generation: UNAVAILABLE_STAGE,
    first_simulation: UNAVAILABLE_STAGE,
    first_apply: UNAVAILABLE_STAGE,
    first_enforcement_decision:
      blocked === null
        ? { at: null, block_reason: null }
        : {
            at: blocked.created_at,
            block_reason: mapBlockReason(blocked.block_reason),
            ...(names ? { tool: blocked.tool_name } : {}),
          },
  }
}

function buildPersisted(
  window: string,
  since: string,
  persisted: PersistedSummary,
  counts: ActivationWindow,
  names: boolean,
): ActivationPersisted {
  const byReason: Record<string, number> = {}
  for (const row of counts.blocked_by_reason) {
    const key = mapBlockReason(row.reason)
    byReason[key] = (byReason[key] ?? 0) + row.count
  }
  return {
    window,
    since,
    calls_in_window: persisted.calls,
    sessions_in_window: persisted.sessions,
    anonymous_calls_in_window: counts.anonymous_calls,
    tool_doors_called_in_window: persisted.pairs.length,
    decisions: {
      permitted: counts.permitted,
      blocked: counts.blocked,
      dry_run: counts.dry_run,
      approvals_requested: counts.approvals_requested,
    },
    blocked_by_reason: byReason,
    config_versions_in_window: counts.config_versions,
    policy_reloads_in_window: {
      recorded: counts.reloads_recorded,
      applied: counts.reloads_applied,
    },
    first_seen: persisted.first_seen,
    ...(names
      ? {
          pairs_called_in_window: persisted.pairs.map((pair) => ({
            tool_name: pair.tool_name,
            upstream: pair.upstream,
            origin: pair.origin,
            calls: pair.calls,
          })),
        }
      : {}),
  }
}

/** The dimension the conditional pairs wait on, from the pairs the default output never carries. */
function conditionalOn(
  coverage: SurfaceCoverage,
): ActivationSnapshot['coverage']['conditional_on'] {
  const conditionalPairs = coverage.pairs.filter((p) => p.status === 'conditional')
  if (conditionalPairs.length === 0) return null
  const every = (on: 'arguments' | 'metadata') =>
    conditionalPairs.every((p) => p.conditional_rules.every((r) => r.on === on))
  if (every('arguments')) return 'arguments'
  if (every('metadata')) return 'metadata'
  return 'arguments or metadata'
}

/** The whitelist projection of the proxy's status object: field by field, never a spread. */
function projectSnapshot(status: PolicyStatusReport, names: boolean): ActivationSnapshot {
  const { surface, coverage, persisted, readiness } = status
  const byAction = Object.fromEntries(
    ACTION_ORDER.map((action) => [action, coverage.by_effective_action[action]]),
  ) as Record<PolicyAction, number>
  return {
    status_schema_version: status.schema_version,
    generated_at: status.generated_at,
    window: status.window,
    since: persisted.since,
    policy: {
      rule_count: status.policy.rule_count,
      default_action: status.policy.default_action,
      dry_run: status.policy.dry_run,
      flag_destructive: status.policy.flag_destructive,
      on_tool_drift: status.policy.on_tool_drift,
      enforces_nothing: status.policy.enforces_nothing,
    },
    surface: {
      pairs: surface.pairs,
      upstream_count: surface.upstream_count,
      adapter_origin_count: surface.adapter_origin_count,
      annotated_destructive: surface.annotated_destructive,
      default_destructive: surface.default_destructive,
      annotation_free_door_count: surface.annotation_free_doors.length,
      unavailable_door_count: surface.unavailable.length,
      ...(names
        ? {
            annotation_free_doors: [...surface.annotation_free_doors],
            unavailable: surface.unavailable.map((d) => ({ name: d.name, reason: d.reason })),
          }
        : {}),
      doors: surface.doors.map((door) => ({
        kind: door.kind,
        available: door.available,
        tool_count: door.tool_count,
        annotated_count: door.annotated_count,
        annotated_destructive: door.annotated_destructive,
        ...(names
          ? {
              ...(door.kind === 'upstream' ? { name: door.name } : { origin: door.origin }),
              unavailable_reason: door.unavailable_reason,
            }
          : {}),
      })),
    },
    coverage: {
      matched: coverage.matched,
      conditional: coverage.conditional,
      conditional_on: conditionalOn(coverage),
      uncovered: coverage.uncovered,
      default_action: coverage.default_action,
      by_effective_action: byAction,
      ...(names ? { pairs: coverage.pairs } : {}),
    },
    persisted_join: {
      reachable_permitted_never_called_in_window:
        persisted.reachable_permitted_never_called_in_window,
      called_not_reachable_in_window: persisted.called_not_reachable_in_window,
    },
    readiness: {
      ready: readiness.ready,
      suppressed: readiness.suppressed,
      calls_in_window: readiness.calls_in_window,
      tool_doors_called_in_window: readiness.tool_doors_called_in_window,
      thresholds: {
        min_calls: readiness.thresholds.min_calls,
        min_tool_doors: readiness.thresholds.min_tool_doors,
      },
    },
  }
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

function n(value: number): string {
  return value.toLocaleString('en-US')
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n(count)} ${count === 1 ? singular : pluralForm}`
}

const STAGE_LABEL_WIDTH = 31
const DAY_COLUMN_WIDTH = 13

function stageLine(label: string, rest: string): string {
  return `  ${label.padEnd(STAGE_LABEL_WIDTH)}${rest}`
}

function datedStage(label: string, at: string, source: string): string {
  return stageLine(label, `${formatUtcDay(at).padEnd(DAY_COLUMN_WIDTH)}${source}`)
}

function versionLabel(version: string): string {
  return version === '0.0.0' ? 'Helio 0.0.0 (unreleased build)' : `Helio ${version}`
}

function doorName(door: SurfaceDoorRef): string {
  if (door.kind === 'adapter') return door.origin
  return door.name ?? 'upstream'
}

function ruleName(rule: { readonly name: string | null; readonly index: number }): string {
  return rule.name !== null ? `"${rule.name}"` : `rule[${String(rule.index)}]`
}

function pairRule(snapshot: ActivationSnapshot, pair: SurfacePair): string {
  let head: string
  switch (pair.effective_source) {
    case 'rule':
      head = pair.matched_rule ? `rule ${ruleName(pair.matched_rule)}` : 'rule'
      break
    case 'default':
      head = `no rule, default ${snapshot.policy.default_action}`
      break
    case 'flag_destructive':
      head = 'no rule, flag_destructive'
      break
    case 'drift':
      head = `drifted, on_tool_drift ${snapshot.policy.on_tool_drift}`
      break
  }
  if (pair.conditional_rules.length === 0) return head
  const parts = pair.conditional_rules.map(
    (r) =>
      `${ruleName(r)} only when ${r.on === 'arguments' ? 'arguments match' : 'metadata matches'}`,
  )
  return `${head}; ${parts.join('; ')}`
}

/** The local calls per (door, tool), keyed the way the coverage pairs are. */
function callsByPair(pairs: readonly ActivationCalledPair[]): Map<string, number> {
  const map = new Map<string, number>()
  for (const pair of pairs) {
    const door: SurfaceDoorRef =
      pair.origin === 'mcp'
        ? { kind: 'upstream', name: pair.upstream }
        : { kind: 'adapter', origin: pair.origin }
    map.set(pairKey(door, pair.tool_name), pair.calls)
  }
  return map
}

function pairKey(door: SurfaceDoorRef, tool: string): string {
  return JSON.stringify([door.kind, door.kind === 'upstream' ? door.name : door.origin, tool])
}

/** The report as text, for `helio report activation` without `--format json`. */
export function renderActivationText(report: ActivationReport): string {
  const lines: string[] = []
  const { window, timeline, persisted, snapshot } = report

  // Header
  lines.push('Helio activation report')
  lines.push(
    `  Written by ${versionLabel(report.helio_version)} on ${formatUtcDay(report.generated_at)} (UTC). ` +
      (report.names_included
        ? 'Names: INCLUDED (tool, door and rule names are in this file).'
        : 'Names: excluded (--include-names restores tool, door and rule names).'),
  )
  lines.push(
    `  Counts cover the last ${window}; dates are within the audit retention of ${report.retention}.`,
  )
  const sameFile = SAME_FILE_SENTENCES[report.sources.config_file_vs_last_policy_write]
  const snapshotClause =
    report.sources.proxy_snapshot_absent_reason === null
      ? 'The running proxy answered on the configured dashboard port (snapshot below); ' +
        'this command does not verify that it wrote this database.'
      : `${ABSENT_SNAPSHOT_SENTENCES[report.sources.proxy_snapshot_absent_reason]}, so the snapshot section is absent.`
  lines.push(`  Sources: the audit database (read; ${sameFile}). ${snapshotClause}`)

  // Timeline
  lines.push('')
  lines.push('Timeline (dates within retention)')
  const first = timeline.first_call_observed
  lines.push(
    first.at === null
      ? stageLine('First call observed', 'none: no tool call persisted within retention')
      : datedStage('First call observed', first.at, 'earliest persisted tool call'),
  )
  const rule = timeline.first_rule
  if (rule.at === null || rule.source === null) {
    lines.push(
      stageLine(
        'First rule',
        'none: no call decided by a rule and no applied reload within retention ' +
          '(a rule may be in the file and never have matched)',
      ),
    )
  } else {
    const source =
      rule.source === 'first_rule_decided_call'
        ? `first call a rule decided${rule.rule_name !== undefined ? ` (rule "${rule.rule_name}")` : ''}`
        : 'first applied config reload'
    lines.push(datedStage('First rule', rule.at, source))
  }
  lines.push(`${' '.repeat(STAGE_LABEL_WIDTH + 2)}${FIRST_RULE_CAVEAT}`)
  lines.push(stageLine('First generation', 'not available in this version'))
  lines.push(stageLine('First simulation', 'not available in this version'))
  lines.push(stageLine('First apply', 'not available in this version'))
  const enforcement = timeline.first_enforcement_decision
  lines.push(
    enforcement.at === null
      ? stageLine('First enforcement decision', 'none: no call blocked within retention')
      : datedStage(
          'First enforcement decision',
          enforcement.at,
          `first blocked call (${enforcement.block_reason ?? 'other'}${enforcement.tool !== undefined ? `, tool ${enforcement.tool}` : ''})`,
        ),
  )

  // Persisted
  lines.push('')
  lines.push(`Persisted (last ${window})`)
  const sessions =
    persisted.sessions_in_window === 0 && persisted.calls_in_window > 0
      ? 'no session ids recorded'
      : `${plural(persisted.sessions_in_window, 'session')}, ` +
        `${plural(persisted.anonymous_calls_in_window, 'call')} without a session id`
  lines.push(
    `  ${plural(persisted.calls_in_window, 'call')} across ` +
      `${plural(persisted.tool_doors_called_in_window, 'tool-door pair')}, ${sessions} ` +
      '(denied and dry-run calls included)',
  )
  const reasons = Object.entries(persisted.blocked_by_reason)
    .map(([reason, count]) => `${reason} ${n(count)}`)
    .join(', ')
  const blocked =
    persisted.decisions.blocked > 0 && reasons.length > 0
      ? `${n(persisted.decisions.blocked)} blocked (${reasons})`
      : `${n(persisted.decisions.blocked)} blocked`
  lines.push(
    `  Decisions: ${n(persisted.decisions.permitted)} permitted, ${blocked}, ` +
      `${n(persisted.decisions.dry_run)} dry-run, ${n(persisted.decisions.approvals_requested)} approvals requested`,
  )
  lines.push(`  Config versions seen: ${n(persisted.config_versions_in_window)}`)
  lines.push(
    `  Config reloads: ${n(persisted.policy_reloads_in_window.recorded)} (${n(persisted.policy_reloads_in_window.applied)} applied)`,
  )
  lines.push(
    persisted.first_seen !== null
      ? `  audit rows since ${formatUtcDay(persisted.first_seen)}`
      : '  no tool calls persisted yet',
  )

  // Snapshot
  if (snapshot === null) return lines.join('\n')
  const { surface, coverage, readiness } = snapshot
  lines.push('')
  lines.push(
    `Snapshot (running proxy, ${formatUtcMinute(snapshot.generated_at)}, window ${snapshot.window})`,
  )
  const across = [plural(surface.upstream_count, 'upstream')]
  if (surface.adapter_origin_count > 0) {
    across.push(plural(surface.adapter_origin_count, 'adapter origin'))
  }
  lines.push(
    `  Authority surface: ${plural(surface.pairs, 'tool-door pair')} across ${across.join(' and ')}; ` +
      `${n(surface.annotated_destructive)} annotated destructive; ` +
      `${n(surface.default_destructive)} destructive by MCP default`,
  )
  const policyParts = [
    plural(snapshot.policy.rule_count, 'rule'),
    `default ${snapshot.policy.default_action}`,
    `on_tool_drift ${snapshot.policy.on_tool_drift}`,
  ]
  if (snapshot.policy.flag_destructive !== null) {
    policyParts.push(`flag_destructive ${snapshot.policy.flag_destructive}`)
  }
  if (snapshot.policy.dry_run) policyParts.push('dry-run')
  lines.push(`  Policy: ${policyParts.join(', ')}`)
  const conditional =
    coverage.conditional > 0
      ? `; ${n(coverage.conditional)} covered only when ${
          coverage.conditional_on === 'metadata'
            ? 'metadata matches'
            : coverage.conditional_on === 'arguments or metadata'
              ? 'arguments or metadata match'
              : 'arguments match'
        }`
      : ''
  lines.push(
    `  Policy coverage: ${n(coverage.matched)} of ${n(surface.pairs)} have a rule that can match them${conditional}; ` +
      `${n(coverage.uncovered)} fall through to the default: ${coverage.default_action}`,
  )
  const histogram = ACTION_ORDER.filter((a) => coverage.by_effective_action[a] > 0).map(
    (a) => `${a} ${n(coverage.by_effective_action[a])}`,
  )
  if (histogram.length > 0) lines.push(`  Effective action: ${histogram.join(', ')}`)
  lines.push(
    `  Reachable and permitted, never called in the last ${snapshot.window}: ` +
      `${n(snapshot.persisted_join.reachable_permitted_never_called_in_window)} (from the proxy)`,
  )
  lines.push(
    `  Called on no primed door in the last ${snapshot.window}: ` +
      `${n(snapshot.persisted_join.called_not_reachable_in_window)} (from the proxy)`,
  )
  const floor = `${n(readiness.thresholds.min_calls)} across ${n(readiness.thresholds.min_tool_doors)}`
  const activity = `${plural(readiness.calls_in_window, 'call')} across ${plural(readiness.tool_doors_called_in_window, 'tool-door pair')} in the last ${snapshot.window}`
  lines.push(
    readiness.suppressed
      ? `  Readiness: suppressed, the policy enforces something (${activity})`
      : readiness.ready
        ? `  Readiness: ready (${activity}; floor ${floor})`
        : `  Readiness: not yet (${activity}; floor ${floor})`,
  )
  const primed = surface.doors.filter((d) => d.kind === 'upstream' && d.available).length
  const notPrimed = surface.doors.filter((d) => d.kind === 'upstream' && !d.available).length
  lines.push(
    `  Doors: ${n(primed)} upstream primed, ${n(notPrimed)} not primed, ` +
      `${n(surface.annotation_free_door_count)} without annotations, ` +
      plural(surface.adapter_origin_count, 'adapter origin'),
  )
  if (!report.names_included) return lines.join('\n')

  // Names only: the door labels, the failure texts and the per-pair table.
  for (const door of surface.unavailable ?? []) {
    lines.push(`    not primed: ${door.name} (${door.reason})`)
  }
  for (const label of surface.annotation_free_doors ?? []) {
    lines.push(`    no annotations: ${label}`)
  }
  lines.push('')
  lines.push(`Tool-door pairs (calls in the last ${window}, from the audit database)`)
  const calls = callsByPair(persisted.pairs_called_in_window ?? [])
  const rows = (coverage.pairs ?? []).map((pair) => ({
    tool: pair.tool,
    door: doorName(pair.door),
    action: pair.effective_action,
    rule: pairRule(snapshot, pair),
    calls: n(calls.get(pairKey(pair.door, pair.tool)) ?? 0),
  }))
  const width = (key: 'tool' | 'door' | 'action' | 'rule') =>
    rows.reduce((w, r) => Math.max(w, r[key].length), 0)
  const w = {
    tool: width('tool'),
    door: width('door'),
    action: width('action'),
    rule: width('rule'),
  }
  for (const r of rows) {
    lines.push(
      `  ${r.tool.padEnd(w.tool)}  ${r.door.padEnd(w.door)}  ${r.action.padEnd(w.action)}  ${r.rule.padEnd(w.rule)}  ${r.calls}`,
    )
  }
  if (rows.length === 0) lines.push('  (no primed door lists a tool)')
  return lines.join('\n')
}
