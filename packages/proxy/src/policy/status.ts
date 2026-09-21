// ---------------------------------------------------------------------------
// Policy status: the authority report `GET /api/policy/status` serves and
// `helio policy status` prints (issue #396): the classified surface, the
// policy's coverage of it, what the audit store holds for a window, and the
// readiness nudge. One assembler for the endpoint, the CLI and, later,
// `helio report activation` (#400).
//
// snake_case throughout: the endpoint serializes the report verbatim.
// ---------------------------------------------------------------------------

import type { SurfaceCoverage, SurfaceDoorRef, SurfaceReport } from './surface.js'
import { conditionalWhenClause } from './surface.js'
import type { CompiledPolicy, PolicyAction } from './types.js'
import type { PersistedSummary } from '../audit/types.js'
import { durationSchema, parseDuration } from '../config/schema.js'
import { enforcesNothing } from '../startup-warnings.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The report's schema version; bumped only for a breaking change. */
export const POLICY_STATUS_SCHEMA_VERSION = 1

/** The persisted window when none is asked for. */
export const DEFAULT_STATUS_WINDOW = '4h'

/** The shortest and longest window the endpoint and the CLI accept. */
const STATUS_WINDOW_MIN_MS = 60_000
const STATUS_WINDOW_MAX_MS = 30 * 86_400_000

/**
 * The readiness floor: recent activity in the window, not a lifetime corpus
 * (a retention-wide COUNT scans every row on every boot). The first reader's
 * surface is four to seven tools, so the pair floor stays at three; the
 * call floor alone rejects a twenty-call smoke test.
 */
export const READINESS_MIN_CALLS = 100
export const READINESS_MIN_TOOL_DOORS = 3

// ---------------------------------------------------------------------------
// Report shape (D11)
// ---------------------------------------------------------------------------

export interface PolicyStatusPolicy {
  readonly rule_count: number
  readonly default_action: 'allow' | 'deny'
  readonly dry_run: boolean
  readonly flag_destructive: 'log' | 'require_approval' | null
  readonly on_tool_drift: 'block' | 'require_approval' | 'log'
  readonly enforces_nothing: boolean
}

export type PolicyStatusSurface = Omit<SurfaceReport, 'coverage'>

export interface PolicyStatusCalledPair {
  readonly door: SurfaceDoorRef
  readonly tool: string
  readonly calls: number
}

export interface PolicyStatusPersisted {
  readonly window: string
  readonly since: string
  readonly calls_in_window: number
  readonly sessions_in_window: number
  readonly tool_doors_called_in_window: number
  readonly pairs_called_in_window: readonly PolicyStatusCalledPair[]
  /** Surface pairs whose effective action is allow and that no persisted call names. */
  readonly reachable_permitted_never_called_in_window: number
  /** Called pairs on no primed door (a door not primed, a tool that left the list, an adapter). */
  readonly called_not_reachable_in_window: number
  /** The earliest persisted tool call within retention; null on an empty store. */
  readonly first_seen: string | null
}

export interface PolicyStatusReadiness {
  readonly ready: boolean
  /** True when the policy enforces something, so no nudge is printed or shown. */
  readonly suppressed: boolean
  readonly calls_in_window: number
  readonly tool_doors_called_in_window: number
  readonly first_seen: string | null
  readonly thresholds: { readonly min_calls: number; readonly min_tool_doors: number }
}

export interface PolicyStatusReport {
  readonly schema_version: number
  readonly generated_at: string
  readonly window: string
  readonly policy: PolicyStatusPolicy
  readonly surface: PolicyStatusSurface
  readonly coverage: SurfaceCoverage
  readonly persisted: PolicyStatusPersisted
  readonly readiness: PolicyStatusReadiness
}

export interface PolicyStatusInput {
  readonly surface: SurfaceReport
  readonly policy: CompiledPolicy
  readonly persisted: PersistedSummary
  /** The window as the caller asked for it, echoed as given. */
  readonly window: string
  readonly now: Date
}

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

const WINDOW_ERROR = 'window must be a duration between 1m and 30d (for example 4h, 240m or 7d)'

/** Validate a window against the config duration grammar and the bounds. */
export function parseStatusWindow(
  value: string,
): { readonly ok: true; readonly ms: number } | { readonly ok: false; readonly error: string } {
  if (!durationSchema.safeParse(value).success) return { ok: false, error: WINDOW_ERROR }
  const ms = parseDuration(value)
  if (ms < STATUS_WINDOW_MIN_MS || ms > STATUS_WINDOW_MAX_MS) {
    return { ok: false, error: WINDOW_ERROR }
  }
  return { ok: true, ms }
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/** The door a persisted row belongs to: `mcp` rows to the MCP door named by `upstream`, any other origin to that adapter. */
function doorOfRow(row: {
  readonly upstream: string | null
  readonly origin: string
}): SurfaceDoorRef {
  return row.origin === 'mcp'
    ? { kind: 'upstream', name: row.upstream }
    : { kind: 'adapter', origin: row.origin }
}

function pairKey(door: SurfaceDoorRef, tool: string): string {
  return JSON.stringify([door.kind, door.kind === 'upstream' ? door.name : door.origin, tool])
}

/** The readiness block: the window's activity against the floor, suppressed by any enforcement. */
export function evaluateReadiness(
  persisted: PersistedSummary,
  policy: CompiledPolicy,
): PolicyStatusReadiness {
  const toolDoors = persisted.pairs.length
  return {
    ready: persisted.calls >= READINESS_MIN_CALLS && toolDoors >= READINESS_MIN_TOOL_DOORS,
    suppressed: !enforcesNothing(policy),
    calls_in_window: persisted.calls,
    tool_doors_called_in_window: toolDoors,
    first_seen: persisted.first_seen,
    thresholds: { min_calls: READINESS_MIN_CALLS, min_tool_doors: READINESS_MIN_TOOL_DOORS },
  }
}

/** Assemble the report. Pure: no I/O, the same inputs give the same object. */
export function buildPolicyStatus(input: PolicyStatusInput): PolicyStatusReport {
  const { policy, persisted, window } = input
  const { coverage, ...surface } = input.surface

  const called = persisted.pairs.map((row) => ({
    door: doorOfRow(row),
    tool: row.tool_name,
    calls: row.calls,
  }))
  const calledKeys = new Set(called.map((c) => pairKey(c.door, c.tool)))
  const surfaceKeys = new Set(coverage.pairs.map((p) => pairKey(p.door, p.tool)))
  const neverCalled = coverage.pairs.filter(
    (p) => p.effective_action === 'allow' && !calledKeys.has(pairKey(p.door, p.tool)),
  ).length
  const notReachable = called.filter((c) => !surfaceKeys.has(pairKey(c.door, c.tool))).length

  return {
    schema_version: POLICY_STATUS_SCHEMA_VERSION,
    generated_at: input.now.toISOString(),
    window,
    policy: {
      rule_count: policy.rules.length,
      default_action: policy.defaultAction,
      dry_run: policy.dryRun === true,
      flag_destructive: policy.flagDestructive ?? null,
      on_tool_drift: policy.onToolDrift ?? 'block',
      enforces_nothing: enforcesNothing(policy),
    },
    surface,
    coverage,
    persisted: {
      window,
      since: persisted.since,
      calls_in_window: persisted.calls,
      sessions_in_window: persisted.sessions,
      tool_doors_called_in_window: called.length,
      pairs_called_in_window: called,
      reachable_permitted_never_called_in_window: neverCalled,
      called_not_reachable_in_window: notReachable,
      first_seen: persisted.first_seen,
    },
    readiness: evaluateReadiness(persisted, policy),
  }
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** `23 Jun 2026`, in UTC. */
function formatDay(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getUTCDate())} ${MONTHS[d.getUTCMonth()] ?? '?'} ${String(d.getUTCFullYear())}`
}

function n(value: number): string {
  return value.toLocaleString('en-US')
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n(count)} ${count === 1 ? singular : pluralForm}`
}

/** The once-per-boot line, printed only when the readiness block is ready and not suppressed. */
export function formatReadinessLine(readiness: PolicyStatusReadiness, window: string): string {
  const since = readiness.first_seen ? ` (audit rows since ${formatDay(readiness.first_seen)})` : ''
  return (
    `Persisted: ${plural(readiness.calls_in_window, 'call')} across ` +
    `${plural(readiness.tool_doors_called_in_window, 'tool-door pair')} in the last ${window}${since}. ` +
    'helio policy status lists which tools are called and which have no rule.'
  )
}

function doorName(door: SurfaceDoorRef): string {
  if (door.kind === 'adapter') return door.origin
  return door.name ?? 'upstream'
}

function ruleName(rule: { readonly name: string | null; readonly index: number }): string {
  return rule.name !== null ? `"${rule.name}"` : `rule[${String(rule.index)}]`
}

function conditionalClause(pair: SurfaceCoverage['pairs'][number]): string {
  if (pair.conditional_rules.length === 0) return ''
  const parts = pair.conditional_rules.map(
    (r) =>
      `${ruleName(r)} only when ${r.on === 'arguments' ? 'arguments match' : 'metadata matches'}`,
  )
  return `; ${parts.join('; ')}`
}

function pairRule(report: PolicyStatusReport, pair: SurfaceCoverage['pairs'][number]): string {
  let head: string
  switch (pair.effective_source) {
    case 'rule':
      head = pair.matched_rule ? `rule ${ruleName(pair.matched_rule)}` : 'rule'
      break
    case 'default':
      head = `no rule, default ${report.policy.default_action}`
      break
    case 'flag_destructive':
      head = 'no rule, flag_destructive'
      break
    case 'drift':
      head = `drifted, on_tool_drift ${report.policy.on_tool_drift}`
      break
  }
  return `${head}${conditionalClause(pair)}`
}

const ACTION_ORDER: readonly PolicyAction[] = [
  'allow',
  'deny',
  'require_approval',
  'rate_limit',
  'spend_limit',
  'dry_run',
]

/** The full report as text, for `helio policy status` without `--format json`. */
export function renderPolicyStatusText(report: PolicyStatusReport): string {
  const { surface, coverage, persisted, readiness, window } = report
  const lines: string[] = []

  // Authority surface
  lines.push('Authority surface')
  const across = [plural(surface.upstream_count, 'upstream')]
  if (surface.adapter_origin_count > 0) {
    across.push(plural(surface.adapter_origin_count, 'adapter origin'))
  }
  lines.push(`  ${plural(surface.pairs, 'tool-door pair')} across ${across.join(' and ')}`)
  const anyAnnotated = surface.doors.some((d) => d.annotated_count > 0)
  if (surface.pairs > 0) {
    if (anyAnnotated) lines.push(`  ${n(surface.annotated_destructive)} annotated destructive`)
    if (surface.default_destructive > 0) {
      lines.push(
        `  ${n(surface.default_destructive)} destructive by MCP default (no destructiveHint set)`,
      )
    }
  }
  for (const door of surface.doors) {
    if (door.available && door.tool_count > 0 && door.annotated_count === 0) {
      lines.push(
        `  ${door.kind === 'adapter' ? door.origin : (door.name ?? 'upstream')}: ${plural(door.tool_count, 'tool')}, none annotated`,
      )
    }
  }
  for (const door of surface.unavailable) {
    lines.push(`  not primed on ${door.name} (${door.reason})`)
  }

  // Policy coverage
  lines.push('')
  lines.push('Policy coverage')
  lines.push(`  ${n(coverage.matched)} of ${n(surface.pairs)} have a rule that can match them`)
  if (coverage.conditional > 0) {
    lines.push(`  ${n(coverage.conditional)} covered only when ${conditionalWhenClause(coverage)}`)
  }
  lines.push(`  ${n(coverage.uncovered)} fall through to the default: ${coverage.default_action}`)
  const histogram = ACTION_ORDER.filter((a) => coverage.by_effective_action[a] > 0).map(
    (a) => `${a} ${n(coverage.by_effective_action[a])}`,
  )
  if (histogram.length > 0) lines.push(`  Effective action: ${histogram.join(', ')}`)
  if (report.policy.flag_destructive !== null) {
    lines.push(`  flag_destructive: ${report.policy.flag_destructive}`)
  }
  lines.push(`  on_tool_drift: ${report.policy.on_tool_drift}`)
  if (report.policy.dry_run) lines.push('  Dry-run: enabled (no call is blocked)')

  // Persisted
  lines.push('')
  lines.push(`Persisted (last ${window})`)
  lines.push(
    `  ${plural(persisted.calls_in_window, 'call')} across ` +
      `${plural(persisted.tool_doors_called_in_window, 'tool-door pair')}, ` +
      `${plural(persisted.sessions_in_window, 'session')} (denied and dry-run calls included)`,
  )
  lines.push(
    `  ${n(persisted.reachable_permitted_never_called_in_window)} reachable and permitted, never called in the last ${window}`,
  )
  if (persisted.called_not_reachable_in_window > 0) {
    lines.push(
      `  ${n(persisted.called_not_reachable_in_window)} called in the last ${window} on no primed door`,
    )
  }
  lines.push(
    persisted.first_seen
      ? `  audit rows since ${formatDay(persisted.first_seen)}`
      : '  no tool calls persisted yet',
  )
  const floor = `${n(readiness.thresholds.min_calls)} across ${n(readiness.thresholds.min_tool_doors)}`
  const activity = `${plural(readiness.calls_in_window, 'call')} across ${plural(readiness.tool_doors_called_in_window, 'tool-door pair')} in the last ${window}`
  lines.push(
    readiness.suppressed
      ? `  Readiness: suppressed, the policy enforces something (${activity})`
      : readiness.ready
        ? `  Readiness: ready (${activity}; floor ${floor})`
        : `  Readiness: not yet (${activity}; floor ${floor})`,
  )

  // Per-pair list
  lines.push('')
  lines.push(`Tool-door pairs (calls in the last ${window})`)
  const callsByKey = new Map(
    persisted.pairs_called_in_window.map((c) => [pairKey(c.door, c.tool), c.calls]),
  )
  const rows = coverage.pairs.map((pair) => ({
    tool: pair.tool,
    door: doorName(pair.door),
    action: pair.effective_action,
    rule: pairRule(report, pair),
    calls: n(callsByKey.get(pairKey(pair.door, pair.tool)) ?? 0),
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
