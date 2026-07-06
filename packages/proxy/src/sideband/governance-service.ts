// ---------------------------------------------------------------------------
// GovernanceService — the engine behind the sideband governance endpoints
// (issue #12). Hook-based adapters (OpenClaw and future ones) drive Helio's
// policy engine over HTTP without an MCP transport to interpose on:
//
//   POST /evaluate  → decide a tool call, side-effect-free on limit counters
//   POST /audit     → record the outcome, consuming counters (idempotent)
//   POST /install-scan → evaluate an install (observational until #13)
//   /approval/:id/resolve → record a natively-handled approval
//
// This service owns the decision pipeline reuse (shared with the MCP path),
// the pending-evaluation registry with TTL + memory budgets, per-origin drift
// caches, idempotent finalize semantics, and the native-approval deadline
// rules. It deliberately holds NO HTTP concern; the route layer
// (governance-api.ts) validates and adapts.
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto'
import type {
  CompiledPolicy,
  PolicyAction,
  CompiledLimits,
  CompiledInstallRule,
} from '../policy/types.js'
import { decide } from '../policy/decision-pipeline.js'
import { ToolAnnotationCache } from '../policy/annotation-cache.js'
import type { ToolDriftChange } from '../policy/annotation-cache.js'
import { resolvePath, matchMetadata } from '../policy/matchers.js'
import { canonicalize } from '../util/canonical-json.js'
import type { EvidenceStore } from '../evidence/store.js'
import type { AuditWriter } from '../audit/writer.js'
import type { AuditRecord } from '../audit/types.js'
import type { ApprovalRouter, NativeResolution } from '../approval/router.js'
import type { ApprovalAuditContext, ApprovalTicket } from '../approval/types.js'
import type { RateLimiter } from '../policy/rate-limiter.js'
import type { SpendLimiter } from '../policy/spend-limiter.js'
import { GovernanceConfigError } from './errors.js'

// ---------------------------------------------------------------------------
// Memory budgets (issue #12) — constants in v1, tunable later without contract change
// ---------------------------------------------------------------------------

const MAX_ORIGINS = 32
const MAX_TOOLS_PER_ORIGIN = 1_024
const MAX_TOOL_INPUT_BYTES = 64 * 1_024
const MAX_PENDING_COUNT = 10_000
const MAX_PENDING_BYTES = 64 * 1_024 * 1_024
// Distinct sender_id (caller-controlled) limit keys held in the shared limiters.
// Capped here in the service (NOT in the limiters) so the evaluate/audit split can
// reserve pre-execution and the MCP door is never gated (issue #13).
const MAX_SENDER_KEYS = 50_000
// Optional /audit evidence payload (issue #11). Caps are enforced in
// populateEvidence (NOT route validation) so an over-cap entry soft-drops
// without discarding the audit row for a call that already ran.
const MAX_EVIDENCE_ENTRIES = 16
const MAX_EVIDENCE_BYTES = 64 * 1_024
// Version-sighting/change log lines per origin per boot (issue #126).
// adapter_version is caller-controlled, so unbounded change-logging would be
// a log-spam vector; after the cap one suppression summary is emitted.
const MAX_VERSION_LOG_LINES_PER_ORIGIN = 5

const SWEEP_INTERVAL_MS = 30_000

// ---------------------------------------------------------------------------
// Wire-facing types (snake_case crosses the boundary; the route layer maps)
// ---------------------------------------------------------------------------

/** The outcome vocabulary adapters branch on — never internal rule actions. */
export type WireDecision =
  | 'allow'
  | 'deny'
  | 'require_approval'
  | 'rate_limited'
  | 'spend_limited'
  | 'dry_run'

/** Tool definition carried by /evaluate (optional; enables the drift guard). */
export interface WireToolDefinition {
  readonly name: string
  readonly description?: string
  readonly input_schema?: unknown
  readonly output_schema?: unknown
  readonly title?: string
  readonly annotations?: Record<string, unknown>
}

export interface EvaluateInput {
  readonly origin: string
  readonly adapter_version?: string
  readonly agent_id: string | null
  readonly session_id: string | null
  readonly tool: WireToolDefinition
  readonly arguments: Record<string, unknown> | undefined
  readonly metadata: Record<string, unknown> | null
}

export interface InstallScanInput {
  readonly origin: string
  readonly agent_id: string | null
  readonly session_id: string | null
  readonly package: {
    readonly name: string
    readonly version?: string
    readonly source?: string
    readonly spec?: string
    readonly url?: string
  }
  readonly metadata: Record<string, unknown> | null
}

export interface AuditEvidenceInput {
  readonly evidence_key: string
  readonly evidence_data: unknown
  readonly ttl_seconds?: number
}

/** Per-entry outcome reported back for each submitted evidence entry. */
export interface AuditEvidenceOutcome {
  readonly evidence_key: string
  readonly stored: boolean
  readonly reason?: string
}

export interface AuditInput {
  readonly evaluation_id: string
  readonly status: 'success' | 'error' | 'not_executed'
  readonly error?: string
  readonly duration_ms?: number
  readonly result?: unknown
  readonly actual_amount?: number
  /**
   * Optional evidence to populate on a successfully-audited call (issue #11). Adapter-scoped, single-token evidence write: bound to the pending
   * evaluation's session/tool, success-only, first-finalize-only. Every
   * per-entry failure is soft (reported, never request-fatal) — see audit().
   */
  readonly evidence?: ReadonlyArray<AuditEvidenceInput>
}

export interface ResolveApprovalInput {
  readonly resolution: 'approved' | 'denied' | 'timeout' | 'cancelled'
  readonly resolved_by?: string
  readonly reason?: string
  readonly scope?: 'once' | 'always'
}

/** A service result: HTTP status + JSON body, adapted verbatim by the route. */
export interface ServiceResult {
  readonly status: number
  readonly body: Record<string, unknown>
}

/**
 * Per-origin adapter liveness, wire-ready for the dashboard's
 * `GET /api/adapters` (issue #126). ISO-8601 timestamps; `adapter_version`
 * stays null until an /evaluate supplies one.
 */
export interface AdapterLivenessEntry {
  readonly origin: string
  readonly adapter_version: string | null
  readonly first_seen: string
  readonly last_seen: string
}

// ---------------------------------------------------------------------------
// Internal registry types
// ---------------------------------------------------------------------------

interface LimitPlan {
  readonly kind: 'rate' | 'spend'
  readonly key: string
  readonly limits: CompiledLimits
  /** Resolved spend amount at evaluate time (spend only). */
  readonly amount?: number
  readonly currency?: string
}

interface PendingEvaluation {
  readonly evaluationId: string
  readonly origin: string
  readonly agentId: string | null
  readonly sessionId: string | null
  readonly toolName: string
  readonly toolInput: Record<string, unknown>
  readonly metadata: Record<string, unknown> | null
  readonly action: PolicyAction
  readonly matchedRuleName: string | null
  readonly matchedRuleIndex: number | null
  readonly flaggedDestructive: boolean
  readonly limitPlan: LimitPlan | undefined
  readonly approvalTicketId: string | undefined
  readonly timestampIso: string
  readonly createdAtMs: number
  readonly evaluationExpiresAtMs: number
  readonly ticketTimeoutAtMs: number | undefined
  readonly bytes: number
}

// adapterVersion/lastSeenMs/versionLogCount are mutated in place on every
// sighting (recordAdapterSeen/touchAdapter); firstSeenMs is set once.
interface AdapterLivenessState {
  adapterVersion: string | null
  readonly firstSeenMs: number
  lastSeenMs: number
  versionLogCount: number
}

type FinalizedBy = 'evaluate' | 'audit' | 'expired'

interface Tombstone {
  readonly auditRecordId: string
  /** null = any payload accepted idempotently (terminal-at-evaluate / expired). */
  readonly payloadHash: string | null
  readonly finalizedBy: FinalizedBy
  readonly expiresAtMs: number
}

export interface GovernanceServiceOptions {
  readonly policy: CompiledPolicy
  readonly environment?: string
  readonly evidenceStore?: EvidenceStore
  readonly approvalRouter?: ApprovalRouter
  readonly rateLimiter?: RateLimiter
  readonly spendLimiter?: SpendLimiter
  readonly auditWriter?: AuditWriter
  /** Default approval timeout (ms) when a rule sets none. */
  readonly approvalTimeoutMs?: number
  /** Pending-evaluation TTL (ms). Default 10 minutes. */
  readonly ttlMs?: number
  /** Clock for testable time. Defaults to Date.now. */
  readonly now?: () => number
  /** Sweep interval (ms). 0 disables the periodic GC backstop. Default 30s. */
  readonly sweepIntervalMs?: number
  /** Max pending evaluations (count). Default 10,000. Overridable for tests. */
  readonly maxPending?: number
  /** Max pending-evaluation footprint (serialized bytes). Default 64 MiB. */
  readonly maxPendingBytes?: number
  /** Max distinct sender_id limit keys (issue #13). Default 50,000. Overridable for tests. */
  readonly maxSenderKeys?: number
}

// ---------------------------------------------------------------------------
// GovernanceService
// ---------------------------------------------------------------------------

export class GovernanceService {
  private policy: CompiledPolicy
  private readonly environment: string | undefined
  private readonly evidenceStore: EvidenceStore | undefined
  private readonly approvalRouter: ApprovalRouter | undefined
  private readonly rateLimiter: RateLimiter | undefined
  private readonly spendLimiter: SpendLimiter | undefined
  private readonly auditWriter: AuditWriter | undefined
  private readonly approvalTimeoutMs: number
  private readonly ttlMs: number
  private readonly now: () => number
  private readonly maxPending: number
  private readonly maxPendingBytes: number
  private readonly maxSenderKeys: number

  /** Distinct sender_id limit keys with live state (reservation registry, issue #13). */
  private readonly senderKeys = new Set<string>()
  /**
   * Per-origin adapter liveness (issue #126). New origins are inserted ONLY on
   * the /evaluate path, which sits behind the MAX_ORIGINS cache gate — every
   * other path updates existing entries and skips unknown origins, so the
   * registry shares the origin cap instead of adding a second growth vector.
   */
  private readonly adapters = new Map<string, AdapterLivenessState>()
  private readonly pending = new Map<string, PendingEvaluation>()
  private readonly tombstones = new Map<string, Tombstone>()
  private readonly caches = new Map<string, ToolAnnotationCache>()
  /** Native approval ticket id → its pending evaluation id, for on-access
   * deadline enforcement on the resolve path. */
  private readonly ticketToEvaluation = new Map<string, string>()
  private pendingBytes = 0
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  private closed = false

  constructor(options: GovernanceServiceOptions) {
    this.policy = options.policy
    this.environment = options.environment
    this.evidenceStore = options.evidenceStore
    this.approvalRouter = options.approvalRouter
    this.rateLimiter = options.rateLimiter
    this.spendLimiter = options.spendLimiter
    this.auditWriter = options.auditWriter
    this.approvalTimeoutMs = options.approvalTimeoutMs ?? 300_000
    this.ttlMs = options.ttlMs ?? 600_000
    this.now = options.now ?? Date.now
    this.maxPending = options.maxPending ?? MAX_PENDING_COUNT
    this.maxPendingBytes = options.maxPendingBytes ?? MAX_PENDING_BYTES
    this.maxSenderKeys = options.maxSenderKeys ?? MAX_SENDER_KEYS
    this.assertApprovalRouter(this.policy)

    const sweepMs = options.sweepIntervalMs ?? SWEEP_INTERVAL_MS
    if (sweepMs > 0) {
      this.sweepTimer = setInterval(() => {
        this.sweep()
      }, sweepMs)
      this.sweepTimer.unref()
    }
  }

  /** Swap the compiled policy on hot-reload (mirrors GovernedForwarder). */
  updatePolicy(policy: CompiledPolicy): void {
    this.assertApprovalRouter(policy)
    this.policy = policy
  }

  // -------------------------------------------------------------------------
  // POST /evaluate
  // -------------------------------------------------------------------------

  evaluate(req: EvaluateInput): ServiceResult {
    // Reserved-key invariant: agent_id has its own first-class column, so a
    // metadata.agent_id would create a conflicting stored value vs the virtual
    // match-time key. Enforced HERE (service layer) so direct embedders are
    // covered, not just the HTTP route schema. (issue #13)
    const reserved = reservedMetadataKey(req.metadata)
    if (reserved) {
      return { status: 400, body: { error: 'reserved_metadata_key', key: reserved } }
    }

    // Memory budgets: tool_input size, origin cardinality, pending pressure.
    const inputBytes = byteLength(req.arguments ?? {})
    if (inputBytes > MAX_TOOL_INPUT_BYTES) {
      return { status: 413, body: { error: 'tool_input_too_large' } }
    }
    // Account for this entry's footprint up front so the global cap cannot be
    // overshot by the entry that crosses it.
    const entryBytes = inputBytes + byteLength(req.metadata ?? {})
    if (!this.caches.has(req.origin) && this.caches.size >= MAX_ORIGINS) {
      return { status: 400, body: { error: 'origin_limit_exceeded' } }
    }
    if (
      this.pending.size >= this.maxPending ||
      this.pendingBytes + entryBytes > this.maxPendingBytes
    ) {
      return { status: 503, body: { error: 'evaluation_backlog_full' } }
    }

    const cache = this.cacheFor(req.origin)
    // Liveness must not depend on the decision outcome, so record as soon as
    // the origin has passed its budget gate (issue #126).
    this.recordAdapterSeen(req.origin, req.adapter_version)
    const toolName = req.tool.name

    // Drift guard: merge the supplied definition into the per-origin
    // cache. A first-seen tool past the per-origin cap is refused fail-closed;
    // updates to already-baselined tools always proceed.
    const hasDefinition = definitionProvided(req.tool)
    if (hasDefinition) {
      if (!cache.has(toolName) && cache.size >= MAX_TOOLS_PER_ORIGIN) {
        return { status: 400, body: { error: 'tool_baseline_limit' } }
      }
      cache.updateSingle(toMcpToolDef(req.tool))
    }

    const pipeline = decide({
      toolName,
      toolArguments: req.arguments,
      sessionId: req.session_id ?? undefined,
      policy: this.policy,
      environment: this.environment,
      evidenceStore: this.evidenceStore,
      baselineAnnotations: cache.get(toolName),
      currentAnnotations: cache.getCurrent(toolName),
      driftEvent: cache.getDrift(toolName),
      metadata: req.metadata ?? undefined,
      agentId: req.agent_id ?? undefined,
    })

    const { decision } = pipeline
    const evaluationId = randomUUID()
    const timestampIso = new Date(this.now()).toISOString()

    // Resolve the limit step (peek — never consume at /evaluate).
    let wire: WireDecision
    let limitPlan: LimitPlan | undefined
    let limitsBlock: Record<string, unknown> | undefined

    // sender_id is sourced from adapter metadata (host-enforced path only).
    const senderId = senderIdOf(req.metadata)

    if (pipeline.isDryRun) {
      wire = 'dry_run'
    } else if (decision.action === 'deny') {
      wire = 'deny'
    } else if (decision.action === 'require_approval') {
      wire = 'require_approval'
    } else if (decision.action === 'rate_limit') {
      const planned = this.planRate(decision, toolName, req.session_id, senderId)
      if (planned?.plan && !this.reserveSenderKey(planned.plan.key)) {
        return { status: 503, body: { error: 'limit_capacity_exhausted' } }
      }
      limitPlan = planned?.plan
      limitsBlock = planned?.block ? { rate: planned.block } : undefined
      wire = planned?.allowed ? 'allow' : 'rate_limited'
    } else if (decision.action === 'spend_limit') {
      const planned = this.planSpend(decision, toolName, req.session_id, req.arguments, senderId)
      if (planned?.plan && !this.reserveSenderKey(planned.plan.key)) {
        return { status: 503, body: { error: 'limit_capacity_exhausted' } }
      }
      limitPlan = planned?.plan
      limitsBlock = planned?.block ? { spend: planned.block } : undefined
      wire = planned?.allowed ? 'allow' : 'spend_limited'
    } else {
      wire = 'allow'
    }

    const matchedRuleName = decision.matchedRule?.name ?? null
    const matchedRuleIndex = decision.matchedRule?.index ?? null

    const responseBody: Record<string, unknown> = {
      evaluation_id: evaluationId,
      decision: wire,
      reason: decision.reason,
      matched_rule: matchedRuleName,
      matched_rule_index: matchedRuleIndex,
    }
    if (shouldAttachFeedback(wire, decision)) {
      responseBody['feedback'] = buildFeedback(decision.matchedRule, decision.reason)
    }
    if (limitsBlock) responseBody['limits'] = limitsBlock
    if (wire === 'dry_run') {
      responseBody['dry_run'] = {
        would_forward: decision.action === 'allow' && !pipeline.evidenceBlocked,
        evidence_satisfied: !pipeline.evidenceBlocked,
        limits_ok: true,
      }
    }
    if (pipeline.driftEvent) {
      responseBody['tool_drift'] = { changes: pipeline.driftEvent.changes }
    }

    // Terminal decisions: audit immediately, tombstone, no pending entry.
    if (isTerminalAtEvaluate(wire)) {
      const auditId = this.writeAudit({
        timestampIso,
        origin: req.origin,
        agentId: req.agent_id,
        sessionId: req.session_id,
        toolName,
        toolInput: req.arguments ?? {},
        metadata: req.metadata,
        action: decision.action,
        wire,
        matchedRuleName,
        matchedRuleIndex,
        flaggedDestructive: pipeline.flaggedDestructive,
        dryRun: wire === 'dry_run',
        recordKind: 'tool_call',
        limitsChain: limitsBlock,
      })
      this.tombstones.set(evaluationId, {
        auditRecordId: auditId,
        payloadHash: null,
        finalizedBy: 'evaluate',
        expiresAtMs: this.now() + this.ttlMs,
      })
      return { status: 200, body: responseBody }
    }

    // allow / require_approval → pending entry awaiting /audit.
    let approvalTicketId: string | undefined
    let ticketTimeoutAtMs: number | undefined
    if (wire === 'require_approval') {
      // Invariant: a require_approval decision can only arise from an
      // approval-capable policy, and assertApprovalRouter() guarantees a router
      // exists for such policies at construct/reload time. Assert rather than
      // silently skip — a missing router here would otherwise fail open (a
      // require_approval response with no ticket the adapter could resolve).
      const router = this.approvalRouter
      if (!router) {
        throw new GovernanceConfigError(
          '[helio] invariant violation: require_approval decision without an approvalRouter',
        )
      }
      const timeoutMs = decision.matchedRule?.approval?.timeoutMs ?? this.approvalTimeoutMs
      const ticket = router.createNativeTicket({
        tool_name: toolName,
        tool_input: req.arguments ?? {},
        matched_rule: decision.matchedRule,
        session_id: req.session_id,
        origin: req.origin,
        timeout_ms: timeoutMs,
      })
      approvalTicketId = ticket.id
      ticketTimeoutAtMs = this.now() + timeoutMs
      responseBody['approval'] = {
        id: ticket.id,
        timeout_ms: timeoutMs,
        resolve_path: `/approval/${ticket.id}/resolve`,
      }
    }

    const entry: PendingEvaluation = {
      evaluationId,
      origin: req.origin,
      agentId: req.agent_id,
      sessionId: req.session_id,
      toolName,
      toolInput: req.arguments ?? {},
      metadata: req.metadata,
      action: decision.action,
      matchedRuleName,
      matchedRuleIndex,
      flaggedDestructive: pipeline.flaggedDestructive,
      limitPlan,
      approvalTicketId,
      timestampIso,
      createdAtMs: this.now(),
      evaluationExpiresAtMs: this.now() + this.ttlMs,
      ticketTimeoutAtMs,
      bytes: entryBytes,
    }
    this.pending.set(evaluationId, entry)
    this.pendingBytes += entryBytes
    if (approvalTicketId) this.ticketToEvaluation.set(approvalTicketId, evaluationId)

    return { status: 200, body: responseBody }
  }

  // -------------------------------------------------------------------------
  // POST /audit
  // -------------------------------------------------------------------------

  audit(req: AuditInput, payloadHash: string): ServiceResult {
    const id = req.evaluation_id

    // Idempotency: a prior finalize leaves a tombstone.
    const tomb = this.tombstones.get(id)
    if (tomb) {
      if (tomb.finalizedBy === 'expired') {
        return { status: 404, body: { error: 'evaluation_expired' } }
      }
      if (tomb.finalizedBy === 'evaluate') {
        return {
          status: 200,
          body: {
            ok: true,
            audit_record_id: tomb.auditRecordId,
            already_finalized: true,
            finalized_by: 'evaluate',
          },
        }
      }
      // finalizedBy 'audit' — identical replay is idempotent; a different
      // payload under the same id is an adapter bug.
      if (tomb.payloadHash === payloadHash) {
        return {
          status: 200,
          body: { ok: true, audit_record_id: tomb.auditRecordId, already_finalized: true },
        }
      }
      return { status: 409, body: { error: 'evaluation_conflict' } }
    }

    const entry = this.pending.get(id)
    if (!entry) {
      return { status: 404, body: { error: 'evaluation_unknown' } }
    }

    // On-access deadline enforcement: apply any crossed deadline before
    // handling, so behavior is deterministic regardless of sweep timing.
    if (this.enforceDeadlines(entry) === 'expired') {
      return { status: 404, body: { error: 'evaluation_expired' } }
    }

    // require_approval must be resolved before auditing. Retryable.
    let approvalStatus: string | null = null
    let approvedBy: string | null = null
    let approvalContext: ApprovalAuditContext | undefined
    if (entry.approvalTicketId) {
      const ticket = this.getTicketStatus(entry.approvalTicketId)
      const status = ticket?.status
      if (!status || status === 'pending') {
        return { status: 409, body: { error: 'approval_unresolved' } }
      }
      approvalStatus = status
      approvedBy = ticket.resolved_by ?? null
      // Same durable approval context the MCP path emits. Only denial reasons
      // apply here in practice — native tickets never start escalation timers.
      if (ticket.denial_reason || ticket.escalated_at) {
        approvalContext = {
          ticket_id: entry.approvalTicketId,
          ...(ticket.denial_reason ? { denial_reason: ticket.denial_reason } : {}),
          ...(ticket.escalated_at
            ? {
                escalated_at: ticket.escalated_at,
                escalated_to: [...(ticket.escalated_to ?? [])],
              }
            : {}),
        }
      }
    }

    // Validate the optional post-hoc spend override.
    // Done before any state mutation: a bad value is an adapter bug we reject
    // explicitly rather than letting it throw inside the limiter.
    if (req.actual_amount !== undefined) {
      if (!Number.isFinite(req.actual_amount) || req.actual_amount < 0) {
        return { status: 400, body: { error: 'invalid_actual_amount' } }
      }
      if (entry.limitPlan?.kind !== 'spend') {
        return { status: 400, body: { error: 'no_spend_rule' } }
      }
    }

    const callHappened = req.status === 'success' || req.status === 'error'

    // Consume limit counters now — only when the call actually executed.
    let limitsChain: Record<string, unknown> | undefined
    if (callHappened && entry.limitPlan) {
      limitsChain = this.commitLimit(entry.limitPlan, req.actual_amount)
    }

    // Record the tool call for evidence/dependency tracking.
    if (callHappened && this.evidenceStore && entry.sessionId) {
      this.evidenceStore.recordToolCall(entry.sessionId, entry.toolName, req.status === 'success')
    }

    // Populate evidence (issue #11). Success-only, and first-finalize
    // only — we are past every tombstone replay return above, so this never
    // re-writes on a replay. Every per-entry failure is soft (reported below,
    // never request-fatal): losing the audit row for a call that already ran
    // would be worse than a dropped evidence entry.
    const evidenceOutcomes = this.populateEvidence(req, entry)

    const auditId = this.writeAudit({
      timestampIso: entry.timestampIso,
      origin: entry.origin,
      agentId: entry.agentId,
      sessionId: entry.sessionId,
      toolName: entry.toolName,
      toolInput: entry.toolInput,
      metadata: entry.metadata,
      action: entry.action,
      wire: entry.action === 'require_approval' ? 'require_approval' : 'allow',
      matchedRuleName: entry.matchedRuleName,
      matchedRuleIndex: entry.matchedRuleIndex,
      flaggedDestructive: entry.flaggedDestructive,
      dryRun: false,
      recordKind: 'tool_call',
      limitsChain,
      approvalStatus,
      approvedBy,
      approvalContext,
      upstreamError: req.status === 'error' ? (req.error ?? 'tool call failed') : null,
      upstreamResponse: req.result ?? null,
      upstreamLatencyMs: req.duration_ms ?? null,
    })

    this.discardPending(entry)
    this.tombstones.set(id, {
      auditRecordId: auditId,
      payloadHash,
      finalizedBy: 'audit',
      expiresAtMs: this.now() + this.ttlMs,
    })

    // Only a SUCCESSFULLY finalized audit counts as adapter liveness: the
    // 409/400 exits above must not bump it, and neither may a write path that
    // throws (500, evaluation still pending) — hence after the tombstone
    // (issue #126).
    this.touchAdapter(entry.origin)

    const body: Record<string, unknown> = { ok: true, audit_record_id: auditId }
    if (evidenceOutcomes) body['evidence'] = evidenceOutcomes
    return { status: 201, body }
  }

  /**
   * Write the optional `/audit` evidence entries for a successful call
   * (issue #11), returning a per-entry outcome list — or `undefined`
   * when there is nothing to report (non-success status, or no evidence
   * supplied). Caps are enforced here, NOT in route validation, so an over-cap
   * entry soft-drops without discarding the audit row: entries past
   * `MAX_EVIDENCE_ENTRIES` → `too_many`; oversized `evidence_data` →
   * `too_large`; no evidence store on the service → `evidence_unavailable`;
   * a sessionless evaluation → `no_session`; the store's own rejections
   * (`key_not_in_policy_allowlist`, `closed`) pass through as the per-entry
   * reason. None of these fail the audit.
   */
  private populateEvidence(
    req: AuditInput,
    entry: PendingEvaluation,
  ): AuditEvidenceOutcome[] | undefined {
    if (req.status !== 'success' || !req.evidence || req.evidence.length === 0) {
      return undefined
    }
    const outcomes: AuditEvidenceOutcome[] = []
    for (let i = 0; i < req.evidence.length; i++) {
      const e = req.evidence[i]
      if (!e) continue
      if (i >= MAX_EVIDENCE_ENTRIES) {
        outcomes.push({ evidence_key: e.evidence_key, stored: false, reason: 'too_many' })
        continue
      }
      const bytes = Buffer.byteLength(canonicalize(e.evidence_data ?? null), 'utf8')
      if (bytes > MAX_EVIDENCE_BYTES) {
        outcomes.push({ evidence_key: e.evidence_key, stored: false, reason: 'too_large' })
        continue
      }
      if (!this.evidenceStore) {
        // Governance enabled without an evidence store (evidence-only-disabled
        // deployment) — distinct from a call that simply has no session.
        outcomes.push({
          evidence_key: e.evidence_key,
          stored: false,
          reason: 'evidence_unavailable',
        })
        continue
      }
      if (!entry.sessionId) {
        outcomes.push({ evidence_key: e.evidence_key, stored: false, reason: 'no_session' })
        continue
      }
      const result = this.evidenceStore.putEvidence(entry.sessionId, {
        evidence_key: e.evidence_key,
        data: e.evidence_data,
        tool_name: entry.toolName,
        ttl_seconds: e.ttl_seconds,
      })
      outcomes.push(
        result.stored
          ? { evidence_key: e.evidence_key, stored: true }
          : { evidence_key: e.evidence_key, stored: false, reason: result.reason },
      )
    }
    return outcomes
  }

  // -------------------------------------------------------------------------
  // POST /install-scan — evaluates install-time policy (issue #13)
  // -------------------------------------------------------------------------

  installScan(req: InstallScanInput): ServiceResult {
    const reserved = reservedMetadataKey(req.metadata)
    if (reserved) {
      return { status: 400, body: { error: 'reserved_metadata_key', key: reserved } }
    }
    // Update-only: /install-scan has no origin budget gate, so it must never
    // insert a registry entry (issue #126, see the adapters field note).
    this.touchAdapter(req.origin)
    const evaluationId = randomUUID()
    const toolName = `install:${req.package.source ?? 'pkg'}:${req.package.name}`

    const verdict = this.evaluateInstall(req)
    const denied = verdict.decision === 'deny'

    const auditId = this.writeAudit({
      timestampIso: new Date(this.now()).toISOString(),
      origin: req.origin,
      agentId: req.agent_id,
      sessionId: req.session_id,
      toolName,
      toolInput: { ...req.package },
      metadata: req.metadata,
      // policy_decision is 'deny' (NOT 'deny_install') so the dashboard renders a
      // blocked install as a block, not an allow. The install context lives in
      // record_kind + block_reason.
      action: denied ? 'deny' : 'allow',
      wire: denied ? 'deny' : 'allow',
      matchedRuleName: verdict.matchedRule?.name ?? null,
      matchedRuleIndex: verdict.matchedRule?.index ?? null,
      flaggedDestructive: false,
      dryRun: false,
      recordKind: 'install_scan',
    })
    this.tombstones.set(evaluationId, {
      auditRecordId: auditId,
      payloadHash: null,
      finalizedBy: 'evaluate',
      expiresAtMs: this.now() + this.ttlMs,
    })

    const body: Record<string, unknown> = {
      evaluation_id: evaluationId,
      decision: verdict.decision,
      reason: verdict.reason,
      matched_rule: verdict.matchedRule?.name ?? null,
      matched_rule_index: verdict.matchedRule?.index ?? null,
    }
    if (denied) {
      body['feedback'] = buildFeedback(verdict.matchedRule, verdict.reason)
    }
    return { status: 200, body }
  }

  /** First-match-wins evaluation of the compiled install policy (issue #13). */
  private evaluateInstall(req: InstallScanInput): {
    decision: 'allow' | 'deny'
    matchedRule?: CompiledInstallRule
    reason: string
  } {
    const install = this.policy.install
    if (!install) {
      return { decision: 'allow', reason: 'no install-time rules defined' }
    }
    const metadataView =
      req.agent_id != null
        ? { ...(req.metadata ?? {}), agent_id: req.agent_id }
        : (req.metadata ?? undefined)

    for (const rule of install.rules) {
      if (matchInstallRule(rule, req.package, metadataView)) {
        const label = rule.name ? `"${rule.name}"` : `install_rule[${String(rule.index)}]`
        return {
          decision: rule.action === 'deny_install' ? 'deny' : 'allow',
          matchedRule: rule,
          reason: `Matched ${label} → ${rule.action}`,
        }
      }
    }
    return {
      decision: install.defaultAction,
      reason: `No matching install rule; default ${install.defaultAction}`,
    }
  }

  // -------------------------------------------------------------------------
  // Adapter liveness registry (issue #126)
  // -------------------------------------------------------------------------

  /** Wire-ready liveness entries, most recently seen first. */
  listAdapters(): AdapterLivenessEntry[] {
    return [...this.adapters.entries()]
      .sort(([oa, a], [ob, b]) => b.lastSeenMs - a.lastSeenMs || oa.localeCompare(ob))
      .map(([origin, state]) => ({
        origin,
        adapter_version: state.adapterVersion,
        first_seen: new Date(state.firstSeenMs).toISOString(),
        last_seen: new Date(state.lastSeenMs).toISOString(),
      }))
  }

  /** Insert-or-refresh on the /evaluate path (the only insert site). */
  private recordAdapterSeen(origin: string, version: string | undefined): void {
    // Re-enforce the route schema's version bounds here so direct embedders
    // are covered too (same rationale as reservedMetadataKey): an empty or
    // over-64-char version is treated as absent, never stored or logged.
    const normalized = version && version.length <= 64 ? version : undefined
    const now = this.now()
    const existing = this.adapters.get(origin)
    if (!existing) {
      const state: AdapterLivenessState = {
        adapterVersion: normalized ?? null,
        firstSeenMs: now,
        lastSeenMs: now,
        versionLogCount: 0,
      }
      this.adapters.set(origin, state)
      if (normalized !== undefined) this.logVersionEvent(origin, state, null, normalized)
      return
    }
    // The injectable clock is not guaranteed monotonic; last_seen must be.
    existing.lastSeenMs = Math.max(existing.lastSeenMs, now)
    if (normalized !== undefined && normalized !== existing.adapterVersion) {
      this.logVersionEvent(origin, existing, existing.adapterVersion, normalized)
      existing.adapterVersion = normalized
    }
  }

  /** Refresh-only for paths without an origin budget gate (install-scan, audit). */
  private touchAdapter(origin: string): void {
    const existing = this.adapters.get(origin)
    if (!existing) return
    existing.lastSeenMs = Math.max(existing.lastSeenMs, this.now())
  }

  /**
   * Log a version sighting/change, capped per origin per boot. Both origin and
   * version are caller-controlled free text, so both are JSON-escaped — a
   * newline or control character must not be able to forge extra log lines
   * (the route's origin regex does not protect direct embedders).
   */
  private logVersionEvent(
    origin: string,
    state: AdapterLivenessState,
    from: string | null,
    to: string,
  ): void {
    if (state.versionLogCount > MAX_VERSION_LOG_LINES_PER_ORIGIN) return
    state.versionLogCount += 1
    if (state.versionLogCount > MAX_VERSION_LOG_LINES_PER_ORIGIN) {
      // eslint-disable-next-line no-console -- Intentional operational warning
      console.error(
        `[helio] adapter origin ${JSON.stringify(origin)}: suppressing further version logs after ${String(MAX_VERSION_LOG_LINES_PER_ORIGIN)}`,
      )
      return
    }
    // eslint-disable-next-line no-console -- Intentional operational log
    console.error(
      from === null
        ? `[helio] adapter origin ${JSON.stringify(origin)} reports version ${JSON.stringify(to)}`
        : `[helio] adapter origin ${JSON.stringify(origin)} version changed ${JSON.stringify(from)} -> ${JSON.stringify(to)}`,
    )
  }

  // -------------------------------------------------------------------------
  // POST /approval/:id/resolve
  // -------------------------------------------------------------------------

  resolveApproval(ticketId: string, req: ResolveApprovalInput): ServiceResult {
    if (!this.approvalRouter) {
      return { status: 503, body: { error: 'governance_unavailable' } }
    }
    const ticket = this.getTicketStatus(ticketId)
    if (!ticket) {
      return { status: 404, body: { error: 'ticket_not_found' } }
    }
    if (!ticket.channel_name.startsWith('native:')) {
      return { status: 409, body: { error: 'not_a_native_ticket' } }
    }

    // On-access deadline enforcement: a resolve arriving after the
    // ticket/evaluation deadline but before the sweep must not succeed. Apply
    // any crossed deadline to the linked evaluation first, then read the ticket
    // post-transition — exactly as the /audit path does.
    const evaluationId = this.ticketToEvaluation.get(ticketId)
    const entry = evaluationId ? this.pending.get(evaluationId) : undefined
    if (entry) this.enforceDeadlines(entry)

    const current = this.getTicketStatus(ticketId)
    if (!current || current.status !== 'pending') {
      return { status: 409, body: { error: 'already_resolved', status: current?.status } }
    }

    const resolved = this.approvalRouter.resolveNativeTicket(
      ticketId,
      req.resolution as NativeResolution,
      req.resolved_by,
      { denial_reason: req.resolution === 'denied' ? req.reason : undefined },
    )
    if (!resolved) {
      return { status: 409, body: { error: 'already_resolved' } }
    }
    return { status: 200, body: { ok: true } }
  }

  // -------------------------------------------------------------------------
  // Sweep — GC backstop for callers that never return
  // -------------------------------------------------------------------------

  sweep(): void {
    for (const entry of [...this.pending.values()]) {
      this.enforceDeadlines(entry)
    }
    const now = this.now()
    for (const [id, tomb] of this.tombstones) {
      if (tomb.expiresAtMs <= now) this.tombstones.delete(id)
    }
    this.pruneSenderKeys()
  }

  /**
   * Reserve a cardinality slot for a sender-keyed limit (issue #13).
   *
   * Only `sender:*` keys are gated — tool/session families are bounded by upstream
   * cardinality, and the MCP path never reaches here, so structural traffic cannot
   * be starved. A key already backed by live state (registry or a live limiter
   * bucket) costs no new slot. At capacity we lazily prune dead keys before failing
   * closed, so an emptied bucket frees its slot without waiting for the sweep.
   */
  private reserveSenderKey(key: string): boolean {
    if (!key.startsWith('sender:')) return true
    if (this.senderKeys.has(key)) return true
    if (this.hasLiveBucket(key)) {
      this.senderKeys.add(key)
      return true
    }
    if (this.senderKeys.size >= this.maxSenderKeys) {
      this.pruneSenderKeys()
      if (this.senderKeys.size >= this.maxSenderKeys) return false
    }
    this.senderKeys.add(key)
    return true
  }

  /** Drop registry keys with no pending evaluation AND no live limiter bucket. */
  private pruneSenderKeys(): void {
    if (this.senderKeys.size === 0) return
    const inUse = new Set<string>()
    for (const entry of this.pending.values()) {
      if (entry.limitPlan && entry.limitPlan.key.startsWith('sender:')) {
        inUse.add(entry.limitPlan.key)
      }
    }
    for (const key of this.senderKeys) {
      if (inUse.has(key)) continue
      if (this.hasLiveBucket(key)) continue
      this.senderKeys.delete(key)
    }
  }

  /**
   * Whether either limiter still holds a live bucket for `key`. Uses the public
   * `getKeyState()` — never the limiters' private maps — and its lazy eviction of
   * an emptied bucket IS the prune-on-touch mechanism.
   */
  private hasLiveBucket(key: string): boolean {
    return (
      this.rateLimiter?.getKeyState(key) !== undefined ||
      this.spendLimiter?.getKeyState(key) !== undefined
    )
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
    this.pending.clear()
    this.tombstones.clear()
    this.caches.clear()
    this.senderKeys.clear()
    this.adapters.clear()
    this.pendingBytes = 0
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Apply crossed deadlines to one pending entry. Returns its post-state. */
  private enforceDeadlines(entry: PendingEvaluation): 'active' | 'expired' {
    const now = this.now()

    // Evaluation TTL fires first → finalize expired (and time out a live ticket).
    if (now >= entry.evaluationExpiresAtMs) {
      if (entry.approvalTicketId) {
        this.approvalRouter?.resolveNativeTicket(entry.approvalTicketId, 'timeout')
      }
      const auditId = this.writeAudit({
        timestampIso: entry.timestampIso,
        origin: entry.origin,
        agentId: entry.agentId,
        sessionId: entry.sessionId,
        toolName: entry.toolName,
        toolInput: entry.toolInput,
        metadata: entry.metadata,
        action: entry.action,
        wire: entry.action === 'require_approval' ? 'require_approval' : 'allow',
        matchedRuleName: entry.matchedRuleName,
        matchedRuleIndex: entry.matchedRuleIndex,
        flaggedDestructive: entry.flaggedDestructive,
        dryRun: false,
        recordKind: 'evaluation_expired',
        sidebandUnreported: true,
      })
      this.discardPending(entry)
      this.tombstones.set(entry.evaluationId, {
        auditRecordId: auditId,
        payloadHash: null,
        finalizedBy: 'expired',
        expiresAtMs: now + this.ttlMs,
      })
      // eslint-disable-next-line no-console -- Operational bypass/tamper signal
      console.error(
        `[helio] Sideband evaluation ${entry.evaluationId} expired without /audit ` +
          `(origin=${entry.origin}, tool=${entry.toolName}) — recorded as evaluation_expired`,
      )
      return 'expired'
    }

    // Ticket timeout fires first → time out the ticket; evaluation stays pending.
    if (
      entry.approvalTicketId &&
      entry.ticketTimeoutAtMs !== undefined &&
      now >= entry.ticketTimeoutAtMs
    ) {
      this.approvalRouter?.resolveNativeTicket(entry.approvalTicketId, 'timeout')
    }
    return 'active'
  }

  private cacheFor(origin: string): ToolAnnotationCache {
    let cache = this.caches.get(origin)
    if (!cache) {
      cache = new ToolAnnotationCache()
      this.caches.set(origin, cache)
    }
    return cache
  }

  private discardPending(entry: PendingEvaluation): void {
    if (this.pending.delete(entry.evaluationId)) {
      this.pendingBytes -= entry.bytes
    }
    if (entry.approvalTicketId) this.ticketToEvaluation.delete(entry.approvalTicketId)
  }

  private getTicketStatus(ticketId: string): ApprovalTicket | undefined {
    return this.approvalRouter?.getTicket(ticketId)
  }

  private planRate(
    decision: ReturnType<typeof decide>['decision'],
    toolName: string,
    sessionId: string | null,
    senderId: string | null,
  ): { plan?: LimitPlan; block?: Record<string, unknown>; allowed: boolean } | undefined {
    const limits = decision.matchedRule?.limits
    if (!this.rateLimiter || !limits?.maxCalls || !limits.windowMs) {
      return { allowed: true }
    }
    const key = buildLimitKey(limits.key, toolName, sessionId, senderId)
    const peek = this.rateLimiter.peek({
      key,
      maxCalls: limits.maxCalls,
      windowMs: limits.windowMs,
    })
    return {
      plan: { kind: 'rate', key, limits },
      block: {
        current: peek.current,
        limit: peek.limit,
        window_ms: peek.windowMs,
        reset_at_ms: peek.resetAtMs,
      },
      allowed: peek.allowed,
    }
  }

  private planSpend(
    decision: ReturnType<typeof decide>['decision'],
    toolName: string,
    sessionId: string | null,
    args: Record<string, unknown> | undefined,
    senderId: string | null,
  ): { plan?: LimitPlan; block?: Record<string, unknown>; allowed: boolean } | undefined {
    const maxSpend = decision.matchedRule?.limits?.maxSpend
    if (!this.spendLimiter || !maxSpend) return { allowed: true }

    const key = buildLimitKey(maxSpend.key, toolName, sessionId, senderId)
    const rawAmount = resolvePath(maxSpend.field, args ?? {})
    if (typeof rawAmount !== 'number' || !Number.isFinite(rawAmount) || rawAmount < 0) {
      // Invalid amount — terminal block (mirrors the MCP invalid-amount deny).
      return { allowed: false, block: { reason: 'invalid_amount', limit: maxSpend.limit } }
    }
    const peek = this.spendLimiter.peek({
      key,
      amount: rawAmount,
      limit: maxSpend.limit,
      windowMs: maxSpend.windowMs,
    })
    return {
      plan: {
        kind: 'spend',
        key,
        limits: decision.matchedRule.limits,
        amount: rawAmount,
        currency: maxSpend.currency,
      },
      block: {
        current_spend: peek.currentSpend,
        limit: peek.limit,
        currency: maxSpend.currency,
        window_ms: peek.windowMs,
        reset_at_ms: peek.resetAtMs,
      },
      allowed: peek.allowed,
    }
  }

  /** Commit a limit plan at /audit time and return the evidence_chain block. */
  private commitLimit(
    plan: LimitPlan,
    actualAmount: number | undefined,
  ): Record<string, unknown> | undefined {
    if (plan.kind === 'rate' && this.rateLimiter && plan.limits.maxCalls && plan.limits.windowMs) {
      const r = this.rateLimiter.record({
        key: plan.key,
        maxCalls: plan.limits.maxCalls,
        windowMs: plan.limits.windowMs,
      })
      return {
        rate_limit: {
          allowed: r.allowed,
          current: r.current,
          limit: r.limit,
          window_ms: r.windowMs,
          reset_at_ms: r.resetAtMs,
        },
      }
    }
    if (plan.kind === 'spend' && this.spendLimiter && plan.limits.maxSpend) {
      const amount = actualAmount ?? plan.amount ?? 0
      const r = this.spendLimiter.record({
        key: plan.key,
        amount,
        limit: plan.limits.maxSpend.limit,
        windowMs: plan.limits.maxSpend.windowMs,
      })
      this.spendLimiter.setCurrency(plan.key, plan.limits.maxSpend.currency)
      return {
        spend_limit: {
          allowed: r.allowed,
          current_spend: r.currentSpend,
          limit: r.limit,
          window_ms: r.windowMs,
          reset_at_ms: r.resetAtMs,
        },
      }
    }
    return undefined
  }

  private writeAudit(args: WriteAuditArgs): string {
    const id = randomUUID()
    if (!this.auditWriter) return id

    const blockReason = deriveBlockReason(args)
    let evidenceChain: Record<string, unknown> | null = args.limitsChain ?? null
    if (args.sidebandUnreported) {
      evidenceChain = { ...(evidenceChain ?? {}), sideband: { unreported: true } }
    }
    if (args.approvalContext) {
      evidenceChain = { ...(evidenceChain ?? {}), approval: { ...args.approvalContext } }
    }

    const record: Omit<AuditRecord, 'id' | 'created_at'> = {
      timestamp: args.timestampIso,
      session_id: args.sessionId,
      agent_id: args.agentId,
      environment: this.environment ?? null,
      tool_name: args.toolName,
      tool_input: args.toolInput,
      policy_decision: args.action,
      block_reason: blockReason,
      matched_rule: args.matchedRuleName,
      matched_rule_index: args.matchedRuleIndex,
      evidence_chain: evidenceChain,
      approval_status: args.approvalStatus ?? null,
      approved_by: args.approvedBy ?? null,
      upstream_response: args.upstreamResponse ?? null,
      upstream_error: args.upstreamError ?? null,
      upstream_http_status: null,
      upstream_latency_ms: args.upstreamLatencyMs ?? null,
      total_duration_ms: 0,
      approval_wait_ms: 0,
      proxy_compute_ms: 0,
      flagged_destructive: args.flaggedDestructive,
      dry_run: args.dryRun,
      record_kind: args.recordKind,
      origin: args.origin,
      metadata: args.metadata,
    }

    // Enforcement decisions and approvals go on the priority flush queue; plain
    // allows stay buffered. Crash durability is the crash-drain hook's job.
    const isEnforcement =
      args.recordKind === 'evaluation_expired' ||
      blockReason !== null ||
      args.approvalStatus != null
    if (isEnforcement) this.auditWriter.pushImmediate(record, id)
    else this.auditWriter.push(record, id)
    return id
  }

  private assertApprovalRouter(policy: CompiledPolicy): void {
    if (!policyCanRequireApproval(policy) || this.approvalRouter) return
    throw new GovernanceConfigError(
      '[helio] GovernanceService misconfiguration: approval-capable policy ' +
        '(a require_approval rule, or flag_destructive/on_tool_drift set to require_approval) ' +
        'requires an approvalRouter',
    )
  }
}

// ---------------------------------------------------------------------------
// Free helpers
// ---------------------------------------------------------------------------

interface WriteAuditArgs {
  timestampIso: string
  origin: string
  agentId: string | null
  sessionId: string | null
  toolName: string
  toolInput: Record<string, unknown>
  metadata: Record<string, unknown> | null
  action: PolicyAction
  wire: WireDecision
  matchedRuleName: string | null
  matchedRuleIndex: number | null
  flaggedDestructive: boolean
  dryRun: boolean
  recordKind: AuditRecord['record_kind']
  limitsChain?: Record<string, unknown>
  approvalStatus?: string | null
  approvedBy?: string | null
  approvalContext?: ApprovalAuditContext
  upstreamError?: string | null
  upstreamResponse?: unknown
  upstreamLatencyMs?: number | null
  sidebandUnreported?: boolean
}

function deriveBlockReason(args: WriteAuditArgs): string | null {
  if (args.recordKind === 'evaluation_expired') return null // bypass signal, not a block
  // Install-time denials get their own block_reason so #16 can discriminate them
  // and so they count into blocked_total (issue #13).
  if (args.recordKind === 'install_scan') return args.wire === 'deny' ? 'install_denied' : null
  if (args.dryRun) return null
  if (args.approvalStatus === 'denied') return 'approval_denied'
  if (args.approvalStatus === 'timeout') return 'approval_timeout'
  if (args.approvalStatus === 'cancelled') return 'cancelled'
  switch (args.wire) {
    case 'deny':
      return 'policy_denied'
    case 'rate_limited':
      return 'rate_limited'
    case 'spend_limited':
      return 'spend_limited'
    default:
      return null
  }
}

function buildFeedback(
  rule: { feedback?: { message: string; suggestion?: string } } | undefined,
  reason: string,
): Record<string, unknown> {
  const message = rule?.feedback?.message ?? reason
  const suggestion = rule?.feedback?.suggestion
  return suggestion ? { message, suggestion } : { message }
}

function isBlocking(wire: WireDecision): boolean {
  return wire === 'deny' || wire === 'rate_limited' || wire === 'spend_limited'
}

/**
 * Blocking decisions always carry feedback (message falls back to the internal
 * reason). The gating decisions — require_approval and dry_run — carry it only
 * when the matched rule configures one and the underlying action gates: global
 * dry-run can shadow a plain allow rule, whose feedback is never surfaced.
 */
function shouldAttachFeedback(
  wire: WireDecision,
  decision: { action: string; matchedRule?: { feedback?: unknown } },
): boolean {
  if (isBlocking(wire)) return true
  const gating = wire === 'require_approval' || wire === 'dry_run'
  return gating && decision.action !== 'allow' && decision.matchedRule?.feedback != null
}

function isTerminalAtEvaluate(wire: WireDecision): boolean {
  return (
    wire === 'deny' || wire === 'rate_limited' || wire === 'spend_limited' || wire === 'dry_run'
  )
}

function policyCanRequireApproval(policy: CompiledPolicy): boolean {
  if (policy.flagDestructive === 'require_approval' || policy.onToolDrift === 'require_approval') {
    return true
  }
  return policy.rules.some((rule) => rule.action === 'require_approval')
}

function buildLimitKey(
  keyType: 'tool' | 'agent' | 'session' | 'sender_id' | undefined,
  toolName: string,
  sessionId: string | null,
  senderId: string | null,
): string {
  switch (keyType) {
    case 'session':
      return `session:${sessionId ?? 'unknown'}`
    case 'sender_id':
      return `sender:${senderId ?? 'unknown'}`
    case 'agent':
    case 'tool':
    default:
      return `tool:${toolName}`
  }
}

/** Read a string sender_id out of the adapter metadata, else null. */
function senderIdOf(metadata: Record<string, unknown> | null): string | null {
  const v = metadata?.['sender_id']
  return typeof v === 'string' ? v : null
}

/** Match one compiled install rule against a package + metadata view (issue #13). */
function matchInstallRule(
  rule: CompiledInstallRule,
  pkg: InstallScanInput['package'],
  metadataView: Readonly<Record<string, unknown>> | undefined,
): boolean {
  if (rule.match.name && !rule.match.name.test(pkg.name)) return false
  if (rule.match.source !== undefined && rule.match.source !== pkg.source) return false
  if (rule.match.metadata && !matchMetadata(rule.match.metadata, { metadata: metadataView })) {
    return false
  }
  return true
}

/**
 * Keys that have a first-class column and therefore must not be smuggled inside the
 * free-form metadata object (issue #13). Returns the offending key or null.
 */
function reservedMetadataKey(metadata: Record<string, unknown> | null): string | null {
  if (metadata && Object.prototype.hasOwnProperty.call(metadata, 'agent_id')) {
    return 'agent_id'
  }
  return null
}

function definitionProvided(tool: WireToolDefinition): boolean {
  return (
    tool.description !== undefined ||
    tool.input_schema !== undefined ||
    tool.output_schema !== undefined ||
    tool.title !== undefined ||
    tool.annotations !== undefined
  )
}

/** Map the wire tool object to an MCP-shaped definition for the cache. */
function toMcpToolDef(tool: WireToolDefinition): Record<string, unknown> {
  const def: Record<string, unknown> = { name: tool.name }
  if (tool.description !== undefined) def['description'] = tool.description
  if (tool.input_schema !== undefined) def['inputSchema'] = tool.input_schema
  if (tool.output_schema !== undefined) def['outputSchema'] = tool.output_schema
  if (tool.title !== undefined) def['title'] = tool.title
  if (tool.annotations !== undefined) def['annotations'] = tool.annotations
  return def
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(canonicalize(value), 'utf8')
}

/** Drift changes are re-exported for the route layer's response typing. */
export type { ToolDriftChange }
