// ---------------------------------------------------------------------------
// Reconstruction (issue #488): one audit record back into the DecideInput
// the door built, field by field as the matrix in docs/policy-fidelity.md
// states it, plus the row-level facts the replay reads beside it: the skip
// predicate, the stored outcome and ticket kind, the two recorded human
// answers, whether the call executed, what its dependency outcome was, and
// the evidence it classified. Everything here is pure over the row except
// the evidence seed, which writes the simulation's own store.
// ---------------------------------------------------------------------------

import type { AuditStore } from '../../audit/store.js'
import type { AuditRecord } from '../../audit/types.js'
import { ToolBaselineStore } from '../../baseline/store.js'
import type { ToolBaselineRow } from '../../baseline/store.js'
import { compileBudgets } from '../../budget/parser.js'
import type { CompiledBudget } from '../../budget/types.js'
import type { ConfigSource } from '../../config/loader.js'
import type { EvidenceStore } from '../../evidence/store.js'
import { compileSessionIdentity } from '../../mcp/session-resolver.js'
import type { CompiledSessionIdentity } from '../../mcp/session-resolver.js'
import type { ToolDriftChange, ToolDriftEvent } from '../annotation-cache.js'
import type { DecideInput } from '../decision-pipeline.js'
import { compilePolicies } from '../parser.js'
import { isWellFormedSessionId } from '../session-gate.js'
import { extractAnnotations } from '../tool-definitions.js'
import type { CompiledPolicy, ToolAnnotationHints } from '../types.js'
import type {
  AnnotationSource,
  PolicySimulationCandidate,
  SimulatedOutcome,
  TicketKind,
} from './types.js'

// ---------------------------------------------------------------------------
// The candidate
// ---------------------------------------------------------------------------

/** The candidate config compiled once for a run, with the bytes it came from. */
export interface CandidateContext {
  readonly policy: CompiledPolicy
  readonly budgets: readonly CompiledBudget[]
  readonly session: CompiledSessionIdentity
  /** The SHA-256 of the candidate file's bytes. */
  readonly sha256: string
  readonly source: ConfigSource
}

/** Compile the three sections a replay evaluates: the policy, the budgets and the session identity. */
export function compileCandidate(candidate: PolicySimulationCandidate): CandidateContext {
  return {
    policy: compilePolicies(candidate.config.policies).policy,
    budgets: compileBudgets(candidate.config.budgets),
    session: compileSessionIdentity(candidate.config.session),
    sha256: candidate.source.sha256,
    source: candidate.source,
  }
}

// ---------------------------------------------------------------------------
// Row readers
// ---------------------------------------------------------------------------

/** The MCP door wrote the row; every other origin is the sideband door. */
function isMcpRow(row: AuditRecord): boolean {
  return row.origin === 'mcp'
}

function chainOf(row: AuditRecord): Record<string, unknown> {
  return row.evidence_chain ?? {}
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** A hints object used as hints, exactly as the drift event carried it. */
function asHints(value: unknown): ToolAnnotationHints | undefined {
  return asObject(value) as ToolAnnotationHints | undefined
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

/** The `budgets[]` blocks on the chain, objects only. */
function budgetBlocks(row: AuditRecord): readonly Record<string, unknown>[] {
  const blocks = chainOf(row)['budgets']
  if (!Array.isArray(blocks)) return []
  return blocks
    .map(asObject)
    .filter((block): block is Record<string, unknown> => block !== undefined)
}

/**
 * A `budgets[]` block that records a committed breach: `approved_overage`,
 * or a committed `kind` with the breach still showing (`allowed: false`).
 */
function isCommittedBreach(block: Record<string, unknown>): boolean {
  const kind = block['kind']
  return kind === 'approved_overage' || (typeof kind === 'string' && block['allowed'] === false)
}

// ---------------------------------------------------------------------------
// The skip predicate
// ---------------------------------------------------------------------------

/** Why a `tool_call` row never entered policy evaluation. */
export type SkipReason = 'rejected' | 'kill_switch'

/**
 * The rows written without a decision: the nameless call, the header
 * mismatch (`policy_decision: rejected`) and the kill switch's refusal on
 * either door. Every other `tool_call` row entered `decide()`.
 */
export function skipReasonOf(row: AuditRecord): SkipReason | null {
  if (row.record_kind !== 'tool_call') return null
  if (row.policy_decision === 'rejected') return 'rejected'
  if (row.block_reason === 'kill_switch') return 'kill_switch'
  return null
}

// ---------------------------------------------------------------------------
// The stored outcome, its ticket kind and the recorded answers
// ---------------------------------------------------------------------------

/**
 * Which human gates the row raised, from columns both doors always write:
 * `policy_decision` names a rule ticket; on the MCP door the
 * `budget_approval` block names a budget ticket (written for every
 * composite ticket, a merged one included); the sideband has one ticket,
 * so a non-rule row with an `approval_status` was a budget ticket and a row
 * is never `both` there. The `approval` block is never read: a clean
 * approval has none.
 */
export function storedTicketKind(row: AuditRecord): TicketKind {
  const rule = row.policy_decision === 'require_approval'
  if (isMcpRow(row)) {
    const budget = asObject(chainOf(row)['budget_approval']) !== undefined
    if (rule && budget) return 'both'
    if (rule) return 'rule'
    return budget ? 'budget' : 'none'
  }
  if (rule) return 'rule'
  return row.approval_status !== null ? 'budget' : 'none'
}

/** The human decisions a row recorded, per gate kind; null when nobody was asked at that gate. */
export interface RecordedAnswers {
  readonly rule: string | null
  readonly money: string | null
}

/**
 * The recorded answers, each applying only to the gate it belonged to. The
 * rule answer is `approval_status` on a `require_approval` row. The money
 * answer is the MCP `budget_approval.status`; with no such block it is
 * `approval_status` in two shapes only: a row whose `policy_decision` is not
 * `require_approval` (a budget-only ticket on either door), or a
 * `require_approval` row whose `budgets[]` carries a committed breach (a
 * merged sideband ticket). A clean or denied rule ticket answers no pot.
 */
export function recordedAnswers(row: AuditRecord): RecordedAnswers {
  const rule = row.policy_decision === 'require_approval' ? row.approval_status : null
  const block = asObject(chainOf(row)['budget_approval'])
  const blockStatus =
    block !== undefined && typeof block['status'] === 'string' ? block['status'] : null
  let money: string | null = blockStatus
  if (money === null && row.approval_status !== null) {
    if (row.policy_decision !== 'require_approval') money = row.approval_status
    else if (budgetBlocks(row).some(isCommittedBreach)) money = row.approval_status
  }
  return { rule, money }
}

/** The quadruple the row stored. */
export function storedOutcome(row: AuditRecord): SimulatedOutcome {
  return {
    policy_decision: row.policy_decision,
    block_reason: row.block_reason,
    dry_run: row.dry_run,
    ticket: storedTicketKind(row),
  }
}

// ---------------------------------------------------------------------------
// Did the call execute, and what did it do to the dependency store
// ---------------------------------------------------------------------------

/** Whether the recorded call ran against its tool, as far as the columns can say. */
export type ExecutionState = 'executed' | 'not_executed' | 'unsettled'

/**
 * The execution predicate the cumulative-state rule runs on. An MCP row
 * executed when `dry_run = 0` and `block_reason` is null. A sideband limit
 * row executed when its chain carries the commit block (`rate_limit` or
 * `spend_limit`); any other sideband row when `upstream_error` is set or a
 * `budgets[]` block carries a committed `kind`; the rest is unsettled, the
 * columns cannot split a `success` from a `not_executed` report. An expired
 * evaluation executed when its plans committed (`sideband.committed`).
 */
export function executionStateOf(row: AuditRecord): ExecutionState {
  if (row.record_kind === 'evaluation_expired') {
    const sideband = asObject(chainOf(row)['sideband'])
    return sideband?.['committed'] === true ? 'executed' : 'unsettled'
  }
  if (row.dry_run || row.block_reason !== null) return 'not_executed'
  if (isMcpRow(row)) return 'executed'
  const chain = chainOf(row)
  if (row.policy_decision === 'rate_limit' || row.policy_decision === 'spend_limit') {
    return chain['rate_limit'] !== undefined || chain['spend_limit'] !== undefined
      ? 'executed'
      : 'unsettled'
  }
  if (row.upstream_error !== null) return 'executed'
  if (budgetBlocks(row).some((block) => typeof block['kind'] === 'string')) return 'executed'
  return 'unsettled'
}

/** What `recordToolCall` should learn from the row: a bit, nothing settled, or nothing at all. */
export type DependencyFact = 'succeeded' | 'failed' | 'unsettled' | 'none'

/**
 * The dependency bit per door. MCP: a forwarded row (`dry_run = 0`, a null
 * `block_reason`, a session) succeeded unless its JSON-RPC envelope has an
 * `error` member; a stored summary settles through `success: true` or
 * `has_error: true` and is unsettled otherwise; a null response with
 * `upstream_error` set is a forwarding failure; any other object is
 * unsettled. Sideband: `upstream_error` set means executed and failed,
 * anything else is unsettled. A row that was blocked, dry-run or sessionless
 * fed nothing.
 */
export function dependencyFactOf(row: AuditRecord): DependencyFact {
  if (!isWellFormedSessionId(row.session_id)) return 'none'
  if (row.record_kind === 'evaluation_expired') return 'unsettled'
  if (row.dry_run || row.block_reason !== null) return 'none'
  if (!isMcpRow(row)) return row.upstream_error !== null ? 'failed' : 'unsettled'
  if (row.upstream_response === null) return row.upstream_error !== null ? 'failed' : 'unsettled'
  const body = asObject(row.upstream_response)
  if (body === undefined) return 'unsettled'
  if ('jsonrpc' in body) return 'error' in body ? 'failed' : 'succeeded'
  if (typeof body['success'] === 'boolean') {
    if (body['success']) return 'succeeded'
    if (body['has_error'] === true) return 'failed'
    return 'unsettled'
  }
  return 'unsettled'
}

// ---------------------------------------------------------------------------
// Annotations: the row's own drift, then the source, then unknown
// ---------------------------------------------------------------------------

/** Which step of the source order answered. */
export type AnnotationStep = 'drift' | 'source' | 'unknown'

/** The annotation inputs of one row and where they came from. */
export interface ResolvedAnnotations {
  readonly baseline: ToolAnnotationHints | undefined
  readonly current: ToolAnnotationHints | undefined
  readonly driftEvent: ToolDriftEvent | undefined
  readonly step: AnnotationStep
  /** The source's own name when it answered; null otherwise. */
  readonly source: string | null
}

/**
 * Resolve the row's annotations in the fidelity page's order. Step 1, the
 * row's own `tool_drift`: an `annotations` change carries both sides; an
 * `other` or `duplicate` change carries whole definitions (a duplicate has
 * no current side); a drift naming other aspects only keeps the event and
 * takes the hints of step 2. Step 2, the annotation source. Step 3,
 * unknown, evaluated through the MCP defaults and named in the report.
 */
export function resolveRowAnnotations(
  row: AuditRecord,
  annotations: AnnotationSource,
): ResolvedAnnotations {
  const drift = asObject(chainOf(row)['tool_drift'])
  const changes = Array.isArray(drift?.['changes'])
    ? (drift['changes'] as readonly ToolDriftChange[])
    : undefined
  const driftEvent = changes ? { toolName: row.tool_name, changes } : undefined
  if (changes) {
    const annotationChange = changes.find((change) => change.aspect === 'annotations')
    if (annotationChange) {
      return {
        baseline: asHints(annotationChange.baseline),
        current: asHints(annotationChange.current),
        driftEvent,
        step: 'drift',
        source: null,
      }
    }
    const whole = changes.find(
      (change) => change.aspect === 'other' || change.aspect === 'duplicate',
    )
    if (whole) {
      const baselineDefinition = asObject(whole.baseline)
      const currentDefinition = whole.aspect === 'other' ? asObject(whole.current) : undefined
      return {
        baseline: baselineDefinition ? extractAnnotations(baselineDefinition) : undefined,
        current: currentDefinition ? extractAnnotations(currentDefinition) : undefined,
        driftEvent,
        step: 'drift',
        source: null,
      }
    }
  }
  const resolution = annotations.resolve({
    upstream: row.upstream,
    tool: row.tool_name,
    origin: row.origin,
    timestamp: row.timestamp,
  })
  if (resolution.kind === 'known') {
    return {
      baseline: resolution.hints,
      current: resolution.hints,
      driftEvent,
      step: 'source',
      source: resolution.source,
    }
  }
  return { baseline: undefined, current: undefined, driftEvent, step: 'unknown', source: null }
}

/** One acceptance of a drifted baseline, as the unwind walks it. */
interface BaselineAcceptance {
  readonly timestamp: string
  readonly changes: readonly ToolDriftChange[]
}

function doorKey(upstream: string | null, tool: string): string {
  return `${upstream ?? ''}\u0000${tool}`
}

/**
 * The trail's annotation source: the `tool_baselines` row for the door and
 * tool, unwound through every acceptance later than the call to the hints
 * the call was judged on, and only when the row existed at the decision
 * (`first_seen` at or before the call's `timestamp`). A database without
 * the table answers unknown for every call and is never written; every
 * sideband row is unknown, adapter baselines being per process.
 */
export function trailAnnotationSource(store: AuditStore): AnnotationSource {
  const hasTable =
    store.database
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tool_baselines'")
      .get() !== undefined
  if (!hasTable) return { resolve: () => ({ kind: 'unknown' }) }

  const baselines = new ToolBaselineStore({ database: store.database })
  const doors = new Map<string, ReadonlyMap<string, ToolBaselineRow>>()
  const acceptances = new Map<string, BaselineAcceptance[]>()
  for (const record of store.listBaselineAcceptances()) {
    const drift = asObject(chainOf(record)['tool_drift'])
    const changes = Array.isArray(drift?.['changes'])
      ? (drift['changes'] as readonly ToolDriftChange[])
      : []
    const key = doorKey(record.upstream, record.tool_name)
    const list = acceptances.get(key) ?? []
    list.push({ timestamp: record.timestamp, changes })
    acceptances.set(key, list)
  }

  return {
    resolve(query) {
      if (query.origin !== 'mcp') return { kind: 'unknown' }
      const door = query.upstream ?? ''
      let rows = doors.get(door)
      if (!rows) {
        rows = new Map(baselines.load(query.upstream ?? undefined).map((row) => [row.tool, row]))
        doors.set(door, rows)
      }
      const row = rows.get(query.tool)
      if (!row || row.first_seen > query.timestamp) return { kind: 'unknown' }
      for (const acceptance of acceptances.get(doorKey(query.upstream, query.tool)) ?? []) {
        if (acceptance.timestamp <= query.timestamp) continue
        for (const change of acceptance.changes) {
          if (change.aspect === 'annotations') {
            return { kind: 'known', hints: asHints(change.baseline), source: 'baseline_accepted' }
          }
          if (change.aspect === 'other') {
            const definition = asObject(change.baseline)
            return {
              kind: 'known',
              hints: definition ? extractAnnotations(definition) : undefined,
              source: 'baseline_accepted',
            }
          }
        }
      }
      return { kind: 'known', hints: extractAnnotations(row.definition), source: 'tool_baselines' }
    },
  }
}

// ---------------------------------------------------------------------------
// Evidence seeding by classification
// ---------------------------------------------------------------------------

/** Ten years in seconds: a `found` key stays present however far the clock moves. */
export const PINNED_TTL_SECONDS = 10 * 365 * 86_400

/**
 * Seed the simulation's evidence store from an MCP row's snapshot: each
 * `found` key is written pinned, each `expired` key with a zero TTL so the
 * store evicts it on read and still remembers it as seen, and a `missing`
 * key writes nothing. The historical TTL is not on the row; a later snapshot
 * of the same session reclassifies a key by writing it again.
 */
export function seedEvidence(store: EvidenceStore, row: AuditRecord): void {
  if (!isMcpRow(row) || !isWellFormedSessionId(row.session_id)) return
  const evidence = asObject(chainOf(row)['evidence'])
  if (!evidence) return
  for (const key of stringList(evidence['found'])) {
    store.putEvidence(row.session_id, {
      evidence_key: key,
      data: null,
      tool_name: row.tool_name,
      ttl_seconds: PINNED_TTL_SECONDS,
    })
  }
  for (const key of stringList(evidence['expired'])) {
    store.putEvidence(row.session_id, {
      evidence_key: key,
      data: null,
      tool_name: row.tool_name,
      ttl_seconds: 0,
    })
  }
}

// ---------------------------------------------------------------------------
// The DecideInput
// ---------------------------------------------------------------------------

/**
 * Rebuild the `DecideInput` for one row: the row's own columns where the
 * matrix says they are full (`undefined`, never the SQL null, for an
 * absent `session_id`, `environment`, `metadata`, `agent_id` or
 * `upstream`), the candidate's compiled policy and strategy summary, the
 * simulation's evidence store, the resolved annotations and the collector
 * for the pipeline's one operational line.
 */
export function buildDecideInput(
  row: AuditRecord,
  candidate: CandidateContext,
  evidenceStore: EvidenceStore,
  annotations: ResolvedAnnotations,
  warn: (message: string) => void,
): DecideInput {
  return {
    toolName: row.tool_name,
    toolArguments: row.tool_input,
    sessionId: row.session_id ?? undefined,
    sessionStrategySummary: candidate.session.strategySummary,
    policy: candidate.policy,
    environment: row.environment ?? undefined,
    evidenceStore,
    baselineAnnotations: annotations.baseline,
    currentAnnotations: annotations.current,
    driftEvent: annotations.driftEvent,
    metadata: row.metadata ?? undefined,
    agentId: row.agent_id ?? undefined,
    upstream: row.upstream ?? undefined,
    warn,
  }
}
