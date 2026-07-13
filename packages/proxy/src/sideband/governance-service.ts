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
import type {
  ApprovalAuditContext,
  ApprovalTicket,
  BudgetBreachContext,
} from '../approval/types.js'
import type { RateLimiter } from '../policy/rate-limiter.js'
import type { SpendLimiter } from '../policy/spend-limiter.js'
import { spendBucketKey } from '../policy/spend-limiter.js'
import type { BudgetEngine, BudgetChargeFailure, BudgetPeekEntry } from '../budget/engine.js'
import type { CompiledBudget } from '../budget/types.js'
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
  | 'budget_exceeded'
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

/** A budget's share of a call, frozen at /evaluate and committed at /audit. */
interface BudgetPlan {
  readonly kind: 'budget'
  readonly budget: CompiledBudget
  readonly bucketKey: string
  readonly amount: number
  /** Config generation at evaluate time; stale charges are skipped at commit. */
  readonly generation: number
  /**
   * Whether this charge breached its budget at /evaluate (issue #14 break-
   * glass): a breached plan whose ticket was APPROVED commits as
   * `approved_overage`; every other executed plan commits as plain `spend`.
   */
  readonly breached: boolean
}

/** Everything /audit must commit once the call actually executed. */
type Plan = LimitPlan | BudgetPlan

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
  readonly plans: readonly Plan[]
  /**
   * Wire-ready per-budget peek blocks frozen at /evaluate (issue #14): the
   * numbers the decision — and any break-glass approver — actually saw.
   * Audited verbatim when the call never executes (`not_executed`, expiry),
   * because a re-peek at report time could show a pot other calls or a
   * reload mutated in the meantime. Counted into the entry's byte footprint.
   */
  readonly budgetsAtEvaluate?: readonly Record<string, unknown>[]
  /**
   * Set once the plans have been committed (mutable latch): a throw AFTER the
   * commit (evidence, audit write) surfaces as a 500 the adapter retries, and
   * the retry must reuse this state instead of committing a second time.
   */
  commitState?: {
    auditId: string
    limitsChain: Record<string, unknown> | undefined
    /** Hash of the payload that performed the commit — a retry with a
     * DIFFERENT payload must 409 rather than finalize audit data that
     * disagrees with the committed amounts. */
    payloadHash: string
  }
  readonly approvalTicketId: string | undefined
  /**
   * The native ticket's terminal resolution, snapshotted the moment it is
   * observed (mutable latch). The queue's resolved-ticket retention (1h) can
   * be SHORTER than the evaluation TTL: once cleanup drops the ticket, this
   * snapshot is the only place the human decision survives for /audit and
   * for the expiry record.
   */
  ticketResolution?: {
    readonly status: ApprovalTicket['status']
    readonly resolvedBy: string | null
    readonly denialReason?: string
    readonly escalatedAt?: string
    readonly escalatedTo?: readonly string[]
  }
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
  /** Budget engine for named cross-tool budgets (issue #14). */
  readonly budgetEngine?: BudgetEngine
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
  private readonly budgetEngine: BudgetEngine | undefined
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
    this.budgetEngine = options.budgetEngine
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
    // overshot by the entry that crosses it. Every stored caller-controlled
    // string counts — tool name, agent id, session id — not just the two
    // object payloads (the route also length-caps each of them).
    const entryBytes =
      inputBytes +
      byteLength(req.metadata ?? {}) +
      byteLength({
        tool: req.tool.name,
        agent_id: req.agent_id,
        session_id: req.session_id,
        origin: req.origin,
      })
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
    const plans: Plan[] = []
    let limitsBlock: Record<string, unknown> | undefined
    // Sender-key slots inserted by THIS call, released if a later gate 503s.
    const reservedThisCall: string[] = []
    const reserve = (key: string): boolean => {
      const preexisting = this.senderKeys.has(key)
      if (!this.reserveSenderKey(key)) return false
      if (!preexisting && this.senderKeys.has(key)) reservedThisCall.push(key)
      return true
    }
    const releaseReservations = (): void => {
      for (const key of reservedThisCall) this.senderKeys.delete(key)
    }

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
      if (planned?.plan && !reserve(planned.plan.key)) {
        return { status: 503, body: { error: 'limit_capacity_exhausted' } }
      }
      if (planned?.plan) plans.push(planned.plan)
      limitsBlock = planned?.block ? { rate: planned.block } : undefined
      wire = planned?.allowed ? 'allow' : 'rate_limited'
    } else if (decision.action === 'spend_limit') {
      const planned = this.planSpend(decision, toolName, req.session_id, req.arguments, senderId)
      if (planned?.plan && !reserve(planned.plan.key)) {
        return { status: 503, body: { error: 'limit_capacity_exhausted' } }
      }
      if (planned?.plan) plans.push(planned.plan)
      limitsBlock = planned?.block ? { spend: planned.block } : undefined
      wire = planned?.allowed ? 'allow' : 'spend_limited'
    } else {
      wire = 'allow'
    }

    // Budget gate (issue #14): peek every matching budget, all-or-nothing.
    // Runs for calls that could still execute (allow / require_approval) and
    // as a pure peek for dry-run. A deny-breach (or invalid amount) is
    // terminal even under a require_approval rule — the money gate forbids
    // what the approver would be asked to allow. Breaches that are all
    // `on_exceed: require_approval` merge into the call's SINGLE native
    // ticket instead (see D7): one decision resolves the rule gate and the
    // money gate together, because the one-round-trip /evaluate contract
    // cannot sequence them and the host executes after the one resolution.
    let budgetsBlock: Array<Record<string, unknown>> | undefined
    let budgetDryRunOk = true
    let budgetDenial: { breached: string[]; invalid: string[] } | undefined
    /** Set when require_approval breaches ride the call's native ticket. */
    let budgetBreachContexts: BudgetBreachContext[] | undefined
    /** Break-glass timeout for BUDGET-ONLY tickets (first-breached-wins). */
    let budgetTicketTimeoutMs: number | undefined
    /** True when budgets alone flipped an allow into require_approval. */
    let budgetTriggeredApproval = false
    if (
      this.budgetEngine &&
      (wire === 'allow' || wire === 'require_approval' || wire === 'dry_run')
    ) {
      const { charges, failures } = this.budgetEngine.resolveCharges({
        toolName,
        toolArguments: req.arguments,
        sessionId: req.session_id,
        senderId,
      })

      if (charges.length > 0 || failures.length > 0) {
        // Peek the valid charges even when failures deny the call: the
        // response must show every failure AND every simultaneous breach.
        const peek =
          charges.length > 0
            ? this.budgetEngine.peekAll(charges)
            : { allowed: true, entries: [] as BudgetPeekEntry[] }
        budgetsBlock = [
          ...peek.entries.map((entry) => budgetWireBlock(entry)),
          ...failures.map((failure) => budgetFailureBlock(failure)),
        ]
        const breaches = peek.entries.filter((entry) => !entry.allowed)
        // Without a router the money gate cannot ask anyone — fail closed
        // like a deny breach (config validation demands approval capability
        // for break-glass budgets; this guards direct embedders).
        const canBreakGlass =
          this.approvalRouter !== undefined &&
          breaches.every((entry) => entry.budget.onExceed === 'require_approval')

        if (failures.length > 0 || (breaches.length > 0 && !canBreakGlass)) {
          budgetDryRunOk = false
          if (wire !== 'dry_run') {
            releaseReservations()
            plans.length = 0
            wire = 'budget_exceeded'
            budgetDenial = {
              breached: breaches.map((entry) => entry.budget.name),
              invalid: failures.map((failure) => failure.budget.name),
            }
          }
        } else {
          if (breaches.length > 0) budgetDryRunOk = false
          if (wire !== 'dry_run') {
            for (const [index, charge] of charges.entries()) {
              if (!reserve(charge.bucketKey)) {
                releaseReservations()
                return { status: 503, body: { error: 'limit_capacity_exhausted' } }
              }
              plans.push({
                kind: 'budget',
                budget: charge.budget,
                bucketKey: charge.bucketKey,
                amount: charge.amount,
                generation: charge.generation,
                breached: peek.entries[index]?.allowed === false,
              })
            }
            if (breaches.length > 0) {
              budgetBreachContexts = breaches.map((entry) => ({
                name: entry.budget.name,
                limit: entry.budget.limit,
                spent: entry.spent,
                attempted_amount: entry.amount,
                currency: entry.budget.currency,
                window: entry.budget.windowRaw,
              }))
              budgetTicketTimeoutMs = breaches[0]?.budget.approval?.timeoutMs
              if (wire === 'allow') {
                budgetTriggeredApproval = true
                wire = 'require_approval'
              }
            }
          }
        }
      }
    }
    if (budgetsBlock) {
      limitsBlock = { ...(limitsBlock ?? {}), budgets: budgetsBlock }
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
    if (wire === 'require_approval' && budgetTriggeredApproval && budgetBreachContexts) {
      // Budgets alone flipped an allowed call into an approval: the matched
      // rule (if any) said allow, so its feedback never applies — tell the
      // host WHY a dialog is appearing. Merged tickets (a require_approval
      // rule plus breaches) keep the rule-feedback contract untouched.
      responseBody['feedback'] = {
        message: `Budget ${budgetBreachContexts.map((b) => `"${b.name}"`).join(', ')} would be exceeded by this call; break-glass approval required`,
        suggestion:
          'Await the approval decision, reduce the amount, or wait for the window to reset.',
      }
    }
    if (wire === 'budget_exceeded' && budgetDenial) {
      // Budget-specific by design: the matched rule's feedback (and the
      // decision reason, which may literally say the call was allowed)
      // describes the RULE, not the budget that denied the call.
      responseBody['feedback'] = {
        message:
          budgetDenial.invalid.length > 0
            ? `Budget ${budgetDenial.invalid.map((n) => `"${n}"`).join(', ')} could not read a valid spend amount from this call`
            : `Budget ${budgetDenial.breached.map((n) => `"${n}"`).join(', ')} would be exceeded by this call`,
        suggestion:
          budgetDenial.invalid.length > 0
            ? 'Retry with a non-negative finite amount in the expected field.'
            : 'Wait for the window to reset or reduce the amount.',
      }
    }
    if (limitsBlock) responseBody['limits'] = limitsBlock
    if (wire === 'dry_run') {
      responseBody['dry_run'] = {
        would_forward: decision.action === 'allow' && !pipeline.evidenceBlocked && budgetDryRunOk,
        evidence_satisfied: !pipeline.evidenceBlocked,
        limits_ok: budgetDryRunOk,
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

    // The admission check above ran before planning; the plans list (and its
    // caller-influenced bucket keys) is part of the entry's real footprint,
    // so re-check the byte cap with it counted BEFORE creating any approval
    // ticket — a late refusal must not leave an orphaned native ticket
    // (amended per implementation review). Over the cap → release this
    // call's sender reservations and refuse.
    // The frozen per-budget view for entries that carry budget plans — what
    // /audit reports if the call never executes. Snapshot, not a re-peek —
    // and a CLONE: budgetsBlock is also the response's limits.budgets, and a
    // direct embedder mutating the returned body must not rewrite evidence.
    const budgetsAtEvaluate = plans.some((plan) => plan.kind === 'budget')
      ? structuredClone(budgetsBlock)
      : undefined
    const totalBytes =
      entryBytes + planBytes(plans) + (budgetsAtEvaluate ? byteLength(budgetsAtEvaluate) : 0)
    if (this.pendingBytes + totalBytes > this.maxPendingBytes) {
      releaseReservations()
      return { status: 503, body: { error: 'evaluation_backlog_full' } }
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
      // One merged native ticket per call (D7). Its timeout comes from the
      // RULE's approval config when the rule gate itself requires approval
      // (the rule gate is first in the execution order); a budget-only
      // ticket takes the first breached budget's config. Channel/delegates
      // never apply here — native tickets are resolved by the adapter's own
      // UI, not notified through Helio channels.
      const timeoutMs =
        (decision.action === 'require_approval'
          ? decision.matchedRule?.approval?.timeoutMs
          : budgetTicketTimeoutMs) ?? this.approvalTimeoutMs
      const ticket = router.createNativeTicket({
        tool_name: toolName,
        // Cloned: the ticket is what the APPROVER sees, and a direct
        // embedder mutating its arguments object after /evaluate must not
        // rewrite it (same guard as the pending entry's evidence below).
        tool_input: structuredClone(req.arguments ?? {}),
        matched_rule: decision.matchedRule,
        session_id: req.session_id,
        origin: req.origin,
        timeout_ms: timeoutMs,
        breached_budgets: budgetBreachContexts,
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
      // Cloned: direct embedders share these references and could otherwise
      // mutate the audit evidence (and desync the byte accounting) after
      // admission. The HTTP route always builds fresh objects; this guards
      // the library surface.
      toolInput: structuredClone(req.arguments ?? {}),
      metadata: req.metadata === null ? null : structuredClone(req.metadata),
      action: decision.action,
      matchedRuleName,
      matchedRuleIndex,
      flaggedDestructive: pipeline.flaggedDestructive,
      plans,
      budgetsAtEvaluate,
      approvalTicketId,
      timestampIso,
      createdAtMs: this.now(),
      evaluationExpiresAtMs: this.now() + this.ttlMs,
      ticketTimeoutAtMs,
      bytes: totalBytes,
    }
    this.pending.set(evaluationId, entry)
    this.pendingBytes += totalBytes
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
      // Latch the live resolution first: the queue may clean the resolved
      // ticket long before this /audit arrives (retention < evaluation TTL).
      this.snapshotTicketResolution(entry)
      const resolution = entry.ticketResolution
      if (!resolution) {
        return { status: 409, body: { error: 'approval_unresolved' } }
      }
      approvalStatus = resolution.status
      approvedBy = resolution.resolvedBy
      // Same durable approval context the MCP path emits. Only denial reasons
      // apply here in practice — native tickets never start escalation timers.
      if (resolution.denialReason || resolution.escalatedAt) {
        approvalContext = {
          ticket_id: entry.approvalTicketId,
          ...(resolution.denialReason ? { denial_reason: resolution.denialReason } : {}),
          ...(resolution.escalatedAt
            ? {
                escalated_at: resolution.escalatedAt,
                escalated_to: [...(resolution.escalatedTo ?? [])],
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
      // The override applies to anything that tracks this call's money: the
      // spend-rule plan and every budget plan (a call has one true cost).
      const hasMoneyPlan = entry.plans.some(
        (plan) => plan.kind === 'spend' || plan.kind === 'budget',
      )
      if (!hasMoneyPlan) {
        return { status: 400, body: { error: 'no_spend_rule' } }
      }
    }

    const callHappened = req.status === 'success' || req.status === 'error'

    // Pre-generated so budget ledger rows can reference the audit record; a
    // retry after a post-commit failure reuses the latched id so the rows
    // already written keep pointing at the record that finally lands.
    // A post-commit retry must present the SAME payload the commit ran with;
    // anything else would finalize an audit row inconsistent with the
    // committed amounts (same contract as the tombstone replay path).
    if (entry.commitState && entry.commitState.payloadHash !== payloadHash) {
      return { status: 409, body: { error: 'evaluation_conflict' } }
    }

    const auditId = entry.commitState?.auditId ?? randomUUID()

    // Consume limit counters now — only when the call actually executed. All
    // plans of the call commit together. A budget ledger failure throws out
    // of audit() BEFORE the latch is set, so the retry re-attempts the whole
    // commit; any failure AFTER the latch (evidence, audit write) makes the
    // retry skip straight past the commit — exactly-once either way.
    let limitsChain = entry.commitState?.limitsChain
    if (callHappened && entry.plans.length > 0 && !entry.commitState) {
      limitsChain = this.commitPlans(entry, req.actual_amount, auditId, approvalStatus)
      entry.commitState = { auditId, limitsChain, payloadHash }
    } else if (!callHappened && !entry.commitState && entry.budgetsAtEvaluate) {
      // Nothing committed (`not_executed`): the record must still carry the
      // money-gate context — which budgets the call fed and, for a denied or
      // timed-out break-glass ticket, which breach the human was deciding.
      // The EVALUATE-TIME snapshot is audited verbatim: a re-peek here could
      // show a pot other calls or a reload mutated since the decision. No
      // kind on the blocks — nothing was recorded.
      limitsChain = { ...(limitsChain ?? {}), budgets: entry.budgetsAtEvaluate }
    }

    // Cross-door block_reason parity (issue #14): a budget-only break-glass
    // ticket that was denied or timed out AND honored by the adapter is a
    // BUDGET block — the same event records block_reason budget_exceeded on
    // the MCP door. Merged tickets keep the rule-gate reason (the rule gate
    // is first in the settled order), and an executed-despite report keeps
    // the plain approval reason (the block never happened; the TOCTOU caveat
    // covers it).
    const budgetBreachBlocked =
      !callHappened &&
      entry.action !== 'require_approval' &&
      (approvalStatus === 'denied' || approvalStatus === 'timeout') &&
      entry.plans.some((plan) => plan.kind === 'budget' && plan.breached)

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

    this.writeAudit({
      id: auditId,
      timestampIso: entry.timestampIso,
      origin: entry.origin,
      agentId: entry.agentId,
      sessionId: entry.sessionId,
      toolName: entry.toolName,
      toolInput: entry.toolInput,
      metadata: entry.metadata,
      action: entry.action,
      budgetBreachBlocked,
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
    // Latch immediately: the queue's retention may drop the ticket before
    // the adapter's /audit (or the evaluation's expiry) reads the outcome.
    if (entry) this.snapshotTicketResolution(entry)
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
    if (!isSenderScopedKey(key)) return true
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
      for (const plan of entry.plans) {
        const key = plan.kind === 'budget' ? plan.bucketKey : plan.key
        if (isSenderScopedKey(key)) inUse.add(key)
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
      this.spendLimiter?.getKeyState(key) !== undefined ||
      this.budgetEngine?.hasBucket(key) === true
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
        // Latch AFTER the transition: a still-live ticket reads as timeout,
        // an earlier resolution is already latched (or still readable), and
        // a queue-cleaned ticket falls back to the earlier latch.
        this.snapshotTicketResolution(entry)
      }
      // The expired record must not erase what IS known: a ticket the
      // adapter resolved but never audited keeps its human decision, and
      // entries that never committed keep the frozen evaluate-time budget
      // context. A committed entry's chain is #149's problem — untouched.
      const resolution = entry.ticketResolution
      const approvalContext: ApprovalAuditContext | undefined =
        entry.approvalTicketId && resolution && (resolution.denialReason || resolution.escalatedAt)
          ? {
              ticket_id: entry.approvalTicketId,
              ...(resolution.denialReason ? { denial_reason: resolution.denialReason } : {}),
              ...(resolution.escalatedAt
                ? {
                    escalated_at: resolution.escalatedAt,
                    escalated_to: [...(resolution.escalatedTo ?? [])],
                  }
                : {}),
            }
          : undefined
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
        approvalStatus: resolution?.status ?? null,
        approvedBy: resolution?.resolvedBy ?? null,
        approvalContext,
        limitsChain:
          !entry.commitState && entry.budgetsAtEvaluate
            ? { budgets: entry.budgetsAtEvaluate }
            : undefined,
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
      this.snapshotTicketResolution(entry)
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

  /** Latch the entry's ticket resolution while the ticket still exists. */
  private snapshotTicketResolution(entry: PendingEvaluation): void {
    if (entry.ticketResolution || !entry.approvalTicketId) return
    const ticket = this.getTicketStatus(entry.approvalTicketId)
    if (!ticket || ticket.status === 'pending') return
    entry.ticketResolution = {
      status: ticket.status,
      resolvedBy: ticket.resolved_by ?? null,
      ...(ticket.denial_reason ? { denialReason: ticket.denial_reason } : {}),
      ...(ticket.escalated_at
        ? { escalatedAt: ticket.escalated_at, escalatedTo: [...(ticket.escalated_to ?? [])] }
        : {}),
    }
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

    // Spend buckets are rule-discriminated via the shared composer so both
    // doors — which feed the same limiter — cannot drift apart on key format.
    const key = spendBucketKey(
      buildLimitKey(maxSpend.key, toolName, sessionId, senderId),
      decision.matchedRule.index,
    )
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

  /** Commit every plan of one call at /audit time; returns the chain blocks. */
  private commitPlans(
    entry: PendingEvaluation,
    actualAmount: number | undefined,
    auditId: string,
    approvalStatus: string | null,
  ): Record<string, unknown> | undefined {
    let chain: Record<string, unknown> | undefined

    // The fallible budget ledger commits FIRST: a throw here propagates out
    // of audit() with the entry still pending and NO limiter state consumed,
    // so the adapter's idempotent retry cannot double-record rate/spend.
    // INVARIANT: nothing between this recordAll and the commitState latch in
    // audit() may throw — the rate/spend records below run on inputs already
    // validated at /evaluate and /audit — because a throw there would make
    // the retry re-run recordAll and double-commit the budgets. Adding a
    // fallible step to this window requires latching the budget commit
    // separately first.
    const budgetPlans = entry.plans.filter((plan): plan is BudgetPlan => plan.kind === 'budget')
    if (budgetPlans.length > 0 && this.budgetEngine) {
      // Break-glass kinds (issue #14): a breached plan whose ticket was
      // APPROVED committed a sanctioned overage. Any other executed breach
      // (denied/timeout/cancelled ticket, host misbehavior or a race) counts
      // as plain spend — the counters stay truthful and the audit row's
      // approval_status carries the evidence.
      const kinds = new Map<string, 'spend' | 'approved_overage'>(
        budgetPlans
          .filter((plan) => plan.breached && approvalStatus === 'approved')
          .map((plan) => [plan.budget.name, 'approved_overage' as const]),
      )
      // actual_amount, when supplied, is the call's one true realized cost
      // and overrides every budget plan amount.
      const snapshots = this.budgetEngine.recordAll(
        budgetPlans.map((plan) => ({
          budget: plan.budget,
          bucketKey: plan.bucketKey,
          amount: actualAmount ?? plan.amount,
          generation: plan.generation,
        })),
        {
          kind: 'spend',
          ...(kinds.size > 0 ? { kinds } : {}),
          auditRecordId: auditId,
          origin: entry.origin,
          toolName: entry.toolName,
          timestampIso: new Date(this.now()).toISOString(),
        },
      )
      // Evidence for STALE commits (a tuple reload landed between /evaluate
      // and /audit) keeps the frozen evaluate-time block — what the decision
      // and any approver saw — with only the commit markers added; the live
      // snapshot would describe the reset pot under the NEW config.
      const frozenByName = new Map(
        (entry.budgetsAtEvaluate ?? []).map((block) => [block['name'], block]),
      )
      chain = {
        ...(chain ?? {}),
        budgets: snapshots.map((snapshot) => {
          const kind = kinds.get(snapshot.budget.name) ?? 'spend'
          const frozen = frozenByName.get(snapshot.budget.name)
          return snapshot.stale && frozen
            ? { ...frozen, kind, stale: true }
            : budgetWireBlock(snapshot, kind)
        }),
      }
    }

    for (const plan of entry.plans) {
      if (plan.kind === 'budget') {
        continue
      }
      if (
        plan.kind === 'rate' &&
        this.rateLimiter &&
        plan.limits.maxCalls &&
        plan.limits.windowMs
      ) {
        const r = this.rateLimiter.record({
          key: plan.key,
          maxCalls: plan.limits.maxCalls,
          windowMs: plan.limits.windowMs,
        })
        chain = {
          ...(chain ?? {}),
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
        chain = {
          ...(chain ?? {}),
          spend_limit: {
            allowed: r.allowed,
            current_spend: r.currentSpend,
            limit: r.limit,
            window_ms: r.windowMs,
            reset_at_ms: r.resetAtMs,
          },
        }
      }
    }

    return chain
  }

  private writeAudit(args: WriteAuditArgs): string {
    const id = args.id ?? randomUUID()
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
  /** Caller-supplied record id (pre-allocated when ledger rows reference it). */
  id?: string
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
  /** A budget-only break-glass denial/timeout the adapter honored (issue #14). */
  budgetBreachBlocked?: boolean
}

function deriveBlockReason(args: WriteAuditArgs): string | null {
  if (args.recordKind === 'evaluation_expired') return null // bypass signal, not a block
  // Install-time denials get their own block_reason so #16 can discriminate them
  // and so they count into blocked_total (issue #13).
  if (args.recordKind === 'install_scan') return args.wire === 'deny' ? 'install_denied' : null
  if (args.dryRun) return null
  // A budget-only break-glass denial/timeout is a BUDGET block — the same
  // event the MCP door records as budget_exceeded (cross-door filter parity).
  // The approval_status column still carries the denied/timeout outcome.
  if (args.budgetBreachBlocked) return 'budget_exceeded'
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
    case 'budget_exceeded':
      return 'budget_exceeded'
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
  return (
    wire === 'deny' ||
    wire === 'rate_limited' ||
    wire === 'spend_limited' ||
    wire === 'budget_exceeded'
  )
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
    wire === 'deny' ||
    wire === 'rate_limited' ||
    wire === 'spend_limited' ||
    wire === 'budget_exceeded' ||
    wire === 'dry_run'
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

/**
 * Whether a limiter/budget bucket key is scoped to a caller-minted sender id
 * and therefore consumes a sender-cardinality slot. Budget names are
 * charset-constrained (no ":"), so the prefix parse is unambiguous.
 */
function isSenderScopedKey(key: string): boolean {
  if (key.startsWith('sender:')) return true
  if (!key.startsWith('budget:')) return false
  const scope = key.slice('budget:'.length)
  const sep = scope.indexOf(':')
  return sep !== -1 && scope.slice(sep + 1).startsWith('sender:')
}

/** Wire block for one budget's view of a call (epoch-ms reset, limiter idiom). */
function budgetWireBlock(
  entry: BudgetPeekEntry,
  kind?: 'spend' | 'approved_overage',
): Record<string, unknown> {
  return {
    ...(kind ? { kind } : {}),
    name: entry.budget.name,
    limit: entry.budget.limit,
    spent: entry.spent,
    remaining: entry.remaining,
    attempted_amount: entry.amount,
    currency: entry.budget.currency,
    window: entry.budget.windowRaw,
    on_exceed: entry.budget.onExceed,
    allowed: entry.allowed,
    reset_at_ms: entry.resetAtMs,
    ...(entry.stale ? { stale: true } : {}),
  }
}

/** Wire block for a fail-closed invalid-amount contributor (real snapshot). */
function budgetFailureBlock(failure: BudgetChargeFailure): Record<string, unknown> {
  return {
    name: failure.budget.name,
    limit: failure.budget.limit,
    spent: failure.spent,
    remaining: failure.remaining,
    attempted_amount: null,
    currency: failure.budget.currency,
    window: failure.budget.windowRaw,
    on_exceed: failure.budget.onExceed,
    allowed: false,
    reason: 'invalid_amount',
    reset_at_ms: failure.resetAtMs,
  }
}

/**
 * Byte footprint of a pending entry's plans for admission accounting. Plans
 * hold compiled objects (matcher functions), so serialize a projection of the
 * caller-influenced parts instead of the plan itself.
 */
function planBytes(plans: readonly Plan[]): number {
  let total = 0
  for (const plan of plans) {
    total += byteLength(
      plan.kind === 'budget'
        ? {
            kind: plan.kind,
            name: plan.budget.name,
            key: plan.bucketKey,
            amount: plan.amount,
            breached: plan.breached,
          }
        : { kind: plan.kind, key: plan.key, amount: plan.amount ?? 0 },
    )
  }
  return total
}
