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
// the pending-evaluation registry with TTL + memory budgets (D4/D15), per-
// origin drift caches (D6), idempotent finalize semantics (D5), and the
// native-approval deadline rules (D10). It deliberately holds NO HTTP concern;
// the route layer (governance-api.ts) validates and adapts.
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto'
import type { CompiledPolicy, PolicyAction, CompiledLimits } from '../policy/types.js'
import { decide } from '../policy/decision-pipeline.js'
import { ToolAnnotationCache } from '../policy/annotation-cache.js'
import type { ToolDriftChange } from '../policy/annotation-cache.js'
import { resolvePath } from '../policy/matchers.js'
import { canonicalize } from '../util/canonical-json.js'
import type { EvidenceStore } from '../evidence/store.js'
import type { AuditWriter } from '../audit/writer.js'
import type { AuditRecord } from '../audit/types.js'
import type { ApprovalRouter, NativeResolution } from '../approval/router.js'
import type { ApprovalTicket } from '../approval/types.js'
import type { RateLimiter } from '../policy/rate-limiter.js'
import type { SpendLimiter } from '../policy/spend-limiter.js'
import { GovernanceConfigError } from './errors.js'

// ---------------------------------------------------------------------------
// Memory budgets (D15) — constants in v1, tunable later without contract change
// ---------------------------------------------------------------------------

const MAX_ORIGINS = 32
const MAX_TOOLS_PER_ORIGIN = 1_024
const MAX_TOOL_INPUT_BYTES = 64 * 1_024
const MAX_PENDING_COUNT = 10_000
const MAX_PENDING_BYTES = 64 * 1_024 * 1_024

const SWEEP_INTERVAL_MS = 30_000

// ---------------------------------------------------------------------------
// Wire-facing types (snake_case crosses the boundary; the route layer maps)
// ---------------------------------------------------------------------------

/** The outcome vocabulary adapters branch on (D8) — never internal rule actions. */
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

export interface AuditInput {
  readonly evaluation_id: string
  readonly status: 'success' | 'error' | 'not_executed'
  readonly error?: string
  readonly duration_ms?: number
  readonly result?: unknown
  readonly actual_amount?: number
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
  /** Max pending evaluations (count). Default 10,000 (D15). Overridable for tests. */
  readonly maxPending?: number
  /** Max pending-evaluation footprint (serialized bytes). Default 64 MiB (D15). */
  readonly maxPendingBytes?: number
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

  private readonly pending = new Map<string, PendingEvaluation>()
  private readonly tombstones = new Map<string, Tombstone>()
  private readonly caches = new Map<string, ToolAnnotationCache>()
  /** Native approval ticket id → its pending evaluation id, for on-access
   * deadline enforcement on the resolve path (R4-1). */
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
    // D15 budgets: tool_input size, origin cardinality, pending pressure.
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
    const toolName = req.tool.name

    // Drift guard (D6): merge the supplied definition into the per-origin
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
    })

    const { decision } = pipeline
    const evaluationId = randomUUID()
    const timestampIso = new Date(this.now()).toISOString()

    // Resolve the limit step (peek — never consume at /evaluate).
    let wire: WireDecision
    let limitPlan: LimitPlan | undefined
    let limitsBlock: Record<string, unknown> | undefined

    if (pipeline.isDryRun) {
      wire = 'dry_run'
    } else if (decision.action === 'deny') {
      wire = 'deny'
    } else if (decision.action === 'require_approval') {
      wire = 'require_approval'
    } else if (decision.action === 'rate_limit') {
      const planned = this.planRate(decision, toolName, req.session_id)
      limitPlan = planned?.plan
      limitsBlock = planned?.block ? { rate: planned.block } : undefined
      wire = planned?.allowed ? 'allow' : 'rate_limited'
    } else if (decision.action === 'spend_limit') {
      const planned = this.planSpend(decision, toolName, req.session_id, req.arguments)
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
    if (isBlocking(wire)) {
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

    // Terminal decisions (D5): audit immediately, tombstone, no pending entry.
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

    // Idempotency: a prior finalize leaves a tombstone (D5 response matrix).
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

    // On-access deadline enforcement (R4-1): apply any crossed deadline before
    // handling, so behavior is deterministic regardless of sweep timing.
    if (this.enforceDeadlines(entry) === 'expired') {
      return { status: 404, body: { error: 'evaluation_expired' } }
    }

    // require_approval must be resolved before auditing (D10). Retryable.
    let approvalStatus: string | null = null
    let approvedBy: string | null = null
    if (entry.approvalTicketId) {
      const ticket = this.getTicketStatus(entry.approvalTicketId)
      const status = ticket?.status
      if (!status || status === 'pending') {
        return { status: 409, body: { error: 'approval_unresolved' } }
      }
      approvalStatus = status
      approvedBy = ticket.resolved_by ?? null
    }

    // Validate the optional post-hoc spend override (§4 actual_amount policy).
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

    // Consume limit counters now (D3) — only when the call actually executed.
    let limitsChain: Record<string, unknown> | undefined
    if (callHappened && entry.limitPlan) {
      limitsChain = this.commitLimit(entry.limitPlan, req.actual_amount)
    }

    // Record the tool call for evidence/dependency tracking.
    if (callHappened && this.evidenceStore && entry.sessionId) {
      this.evidenceStore.recordToolCall(entry.sessionId, entry.toolName, req.status === 'success')
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
      recordKind: 'tool_call',
      limitsChain,
      approvalStatus,
      approvedBy,
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

    return { status: 201, body: { ok: true, audit_record_id: auditId } }
  }

  // -------------------------------------------------------------------------
  // POST /install-scan (observational until #13 — D9)
  // -------------------------------------------------------------------------

  installScan(req: InstallScanInput): ServiceResult {
    const evaluationId = randomUUID()
    const toolName = `install:${req.package.source ?? 'pkg'}:${req.package.name}`
    const auditId = this.writeAudit({
      timestampIso: new Date(this.now()).toISOString(),
      origin: req.origin,
      agentId: req.agent_id,
      sessionId: req.session_id,
      toolName,
      toolInput: { ...req.package },
      metadata: req.metadata,
      action: 'allow',
      wire: 'allow',
      matchedRuleName: null,
      matchedRuleIndex: null,
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
    return {
      status: 200,
      body: {
        evaluation_id: evaluationId,
        decision: 'allow',
        reason: 'no install-time rules defined',
        matched_rule: null,
        matched_rule_index: null,
      },
    }
  }

  // -------------------------------------------------------------------------
  // POST /approval/:id/resolve (D10)
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

    // On-access deadline enforcement (R4-1): a resolve arriving after the
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
  // Sweep — GC backstop for callers that never return (D4/D10/R4-1)
  // -------------------------------------------------------------------------

  sweep(): void {
    for (const entry of [...this.pending.values()]) {
      this.enforceDeadlines(entry)
    }
    const now = this.now()
    for (const [id, tomb] of this.tombstones) {
      if (tomb.expiresAtMs <= now) this.tombstones.delete(id)
    }
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
  ): { plan?: LimitPlan; block?: Record<string, unknown>; allowed: boolean } | undefined {
    const limits = decision.matchedRule?.limits
    if (!this.rateLimiter || !limits?.maxCalls || !limits.windowMs) {
      return { allowed: true }
    }
    const key = buildLimitKey(limits.key, toolName, sessionId)
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
  ): { plan?: LimitPlan; block?: Record<string, unknown>; allowed: boolean } | undefined {
    const maxSpend = decision.matchedRule?.limits?.maxSpend
    if (!this.spendLimiter || !maxSpend) return { allowed: true }

    const key = buildLimitKey(maxSpend.key, toolName, sessionId)
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
  upstreamError?: string | null
  upstreamResponse?: unknown
  upstreamLatencyMs?: number | null
  sidebandUnreported?: boolean
}

function deriveBlockReason(args: WriteAuditArgs): string | null {
  if (args.recordKind === 'evaluation_expired') return null // bypass signal, not a block (F4)
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
  keyType: 'tool' | 'agent' | 'session' | undefined,
  toolName: string,
  sessionId: string | null,
): string {
  switch (keyType) {
    case 'session':
      return `session:${sessionId ?? 'unknown'}`
    case 'agent':
    case 'tool':
    default:
      return `tool:${toolName}`
  }
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
