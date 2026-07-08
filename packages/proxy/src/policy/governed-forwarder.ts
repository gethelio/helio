import type {
  McpForwarder,
  McpForwarderWithInternal,
  McpRequest,
  ForwardResult,
  McpResponse,
} from '../mcp/types.js'
import { INTERNAL_ERROR, INVALID_PARAMS } from '../mcp/types.js'
import type { CompiledPolicy } from './types.js'
import type { PolicyDecision } from './engine.js'
import { decide } from './decision-pipeline.js'
import { ToolAnnotationCache } from './annotation-cache.js'
import type { ToolDriftEvent, ToolCacheUpdateResult } from './annotation-cache.js'
import type { AuditWriter } from '../audit/writer.js'
import type { AuditRecord } from '../audit/types.js'
import type { EvidenceStore } from '../evidence/store.js'
import type { EvidenceCheckResult, DependencyCheckResult } from '../evidence/grounding.js'
import {
  buildPolicyDeniedFeedback,
  buildEvidenceMissingFeedback,
  buildEvidenceExpiredFeedback,
  buildDependencyMissingFeedback,
  buildApprovalDeniedFeedback,
  buildApprovalTimeoutFeedback,
  buildClientDisconnectedFeedback,
  buildShutdownCancelledFeedback,
  buildRateLimitedFeedback,
  buildSpendLimitedFeedback,
  buildToolDriftFeedback,
} from '../feedback/self-repair.js'
import type { ApprovalRouter } from '../approval/router.js'
import type { ApprovalAuditContext, ApprovalOutcome } from '../approval/types.js'
import type { RateLimiter, RateLimitResult } from './rate-limiter.js'
import type { SpendLimiter, SpendLimitResult } from './spend-limiter.js'
import { resolvePath } from './matchers.js'

/** Custom JSON-RPC error code for policy denials. */
const POLICY_DENIED = -32001

/** Options for constructing a GovernedForwarder. */
export interface GovernedForwarderOptions {
  /** The current environment label (e.g. "production", "staging"). */
  environment?: string
  /** Async audit writer for recording tool call decisions. */
  auditWriter?: AuditWriter
  /** In-memory evidence store for evidence grounding. */
  evidenceStore?: EvidenceStore
  /** Approval router for handling require_approval decisions. */
  approvalRouter?: ApprovalRouter
  /** Rate limiter for handling rate_limit decisions. */
  rateLimiter?: RateLimiter
  /** Spend limiter for handling spend_limit decisions. */
  spendLimiter?: SpendLimiter
}

/** Result of attempting to prime the tool annotation cache. */
export interface AnnotationCachePrimeResult {
  /** True when cache update succeeded from a valid tools/list response shape. */
  readonly success: boolean
  /** Number of tools currently cached after the attempt. */
  readonly toolsCached: number
  /** Failure reason when success is false. */
  readonly reason?: string
}

/**
 * A McpForwarder decorator that evaluates policy rules before forwarding
 * tools/call requests to the upstream MCP server.
 *
 * - tools/call: evaluate policy → allow, deny, or reject (unimplemented action)
 * - tools/list: forward, then cache tool annotations for future evaluations
 * - All other methods: pass through directly
 */
export class GovernedForwarder implements McpForwarder {
  private readonly inner: McpForwarder
  private policy: CompiledPolicy
  private readonly environment: string | undefined
  private readonly auditWriter: AuditWriter | undefined
  private readonly evidenceStore: EvidenceStore | undefined
  private readonly approvalRouter: ApprovalRouter | undefined
  private readonly rateLimiter: RateLimiter | undefined
  private readonly spendLimiter: SpendLimiter | undefined
  private readonly annotationCache = new ToolAnnotationCache()
  private agentKeyWarned = false
  private senderKeyWarned = false

  constructor(inner: McpForwarder, policy: CompiledPolicy, options?: GovernedForwarderOptions) {
    this.inner = inner
    this.policy = policy
    this.environment = options?.environment
    this.auditWriter = options?.auditWriter
    this.evidenceStore = options?.evidenceStore
    this.approvalRouter = options?.approvalRouter
    this.rateLimiter = options?.rateLimiter
    this.spendLimiter = options?.spendLimiter
    if (this.evidenceStore) {
      this.evidenceStore.setAllowedEvidenceKeys(collectAllowedEvidenceKeys(policy))
    }
  }

  /**
   * Swap the compiled policy atomically and reconcile limit bucket state
   * against the new configuration.
   *
   * Rate and spend limit buckets are preserved when their underlying rule
   * config is unchanged — this is what makes a benign hot-reload (e.g. a
   * `vim :w` with no real edits, or a whitespace-only config change) safe:
   * operators do not get a surprise zero of their live rate/spend state
   * mid-window. Buckets whose config changed or whose rule was removed are
   * evicted by the limiters' `reconcile()` methods, so the next check
   * lazy-creates a fresh bucket under the new config.
   *
   * See `packages/proxy/src/policy/rate-limiter.ts` and `spend-limiter.ts`
   * for the per-bucket compare-and-evict semantics.
   */
  updatePolicy(policy: CompiledPolicy): void {
    this.policy = policy
    if (this.evidenceStore) {
      this.evidenceStore.setAllowedEvidenceKeys(collectAllowedEvidenceKeys(policy))
    }

    if (this.rateLimiter) {
      const rateConfigs: Array<{ maxCalls: number; windowMs: number }> = []
      for (const rule of policy.rules) {
        const limits = rule.limits
        if (limits?.maxCalls !== undefined && limits.windowMs !== undefined) {
          rateConfigs.push({ maxCalls: limits.maxCalls, windowMs: limits.windowMs })
        }
      }
      this.rateLimiter.reconcile(rateConfigs)
    }

    if (this.spendLimiter) {
      const spendConfigs: Array<{ limit: number; currency: string; windowMs: number }> = []
      for (const rule of policy.rules) {
        const maxSpend = rule.limits?.maxSpend
        if (maxSpend) {
          spendConfigs.push({
            limit: maxSpend.limit,
            currency: maxSpend.currency,
            windowMs: maxSpend.windowMs,
          })
        }
      }
      this.spendLimiter.reconcile(spendConfigs)
    }
  }

  /**
   * Prime the annotation cache by fetching tools/list directly from upstream.
   *
   * This path is intended for startup warm-up and intentionally bypasses policy
   * and audit handling. Runtime tools/list requests still flow through forward().
   *
   * When the inner forwarder exposes `forwardInternal` (duck-typed), the prime
   * request is routed through it so session-enforcing servers (e.g. Streamable
   * HTTP upstreams) receive the request on the managed internal session rather
   * than as a sessionless call that they would reject with HTTP 400.
   */
  async primeAnnotationCache(): Promise<AnnotationCachePrimeResult> {
    const syntheticToolsList: McpRequest = {
      jsonrpc: '2.0',
      id: 'helio-prime-annotations',
      method: 'tools/list',
    }
    const internal: McpForwarderWithInternal = this.inner

    try {
      const result =
        typeof internal.forwardInternal === 'function'
          ? await internal.forwardInternal(syntheticToolsList)
          : await this.inner.forward(syntheticToolsList)
      // An HTTP error is never a usable tools/list, even if the error body
      // happens to contain a result.tools-shaped payload.
      if (result.response.status >= 400) {
        return {
          success: false,
          toolsCached: this.annotationCache.size,
          reason: classifyPrimeFailure(result.response),
        }
      }
      const update = this.applyToolDefinitionUpdate(result.response.body, undefined)
      if (!update.updated) {
        return {
          success: false,
          toolsCached: this.annotationCache.size,
          reason: classifyPrimeFailure(result.response),
        }
      }
      return { success: true, toolsCached: this.annotationCache.size }
    } catch (error) {
      return {
        success: false,
        toolsCached: this.annotationCache.size,
        reason: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async forward(request: McpRequest): Promise<ForwardResult> {
    // Only intercept tools/call — everything else passes through
    if (request.method === 'tools/call') {
      return this.handleToolsCall(request)
    }

    // Forward the request
    const result = await this.inner.forward(request)

    // Intercept tools/list responses to diff tool definitions
    if (request.method === 'tools/list') {
      this.applyToolDefinitionUpdate(result.response.body, request.sessionId)
    }

    return result
  }

  /**
   * Apply a tools/list response to the definition cache and surface any
   * drift: console warning + immediate audit record per event. Single entry
   * point for both runtime tools/list responses and startup priming, so the
   * cache is updated exactly once per response.
   */
  private applyToolDefinitionUpdate(
    responseBody: unknown,
    sessionId: string | undefined,
  ): ToolCacheUpdateResult {
    const update = this.annotationCache.update(responseBody)
    if (!update.updated) return update

    for (const drift of update.drifted) {
      const aspects = drift.changes.map((change) => change.aspect).join(', ')
      // eslint-disable-next-line no-console -- Intentional operational warning
      console.error(
        `[helio] Tool definition drift detected: "${drift.toolName}" changed (${aspects}) after baseline — calls governed by policies.on_tool_drift (${this.policy.onToolDrift ?? 'block'})`,
      )
      this.writeDriftAuditRecord(drift, sessionId, 'tool_drift')
    }
    for (const toolName of update.reverted) {
      // eslint-disable-next-line no-console -- Intentional operational warning
      console.error(
        `[helio] Tool definition drift cleared: "${toolName}" returned to its baseline definition`,
      )
      this.writeDriftAuditRecord({ toolName, changes: [] }, sessionId, 'tool_drift_reverted')
    }
    return update
  }

  /** Write an immediate audit record for a drift event (not a tool call). */
  private writeDriftAuditRecord(
    drift: ToolDriftEvent,
    sessionId: string | undefined,
    decision: 'tool_drift' | 'tool_drift_reverted',
  ): void {
    if (!this.auditWriter) return
    this.auditWriter.pushImmediate({
      timestamp: new Date().toISOString(),
      session_id: sessionId ?? null,
      agent_id: null,
      environment: this.environment ?? null,
      tool_name: drift.toolName,
      tool_input: {},
      policy_decision: decision,
      block_reason: null,
      matched_rule: null,
      matched_rule_index: null,
      evidence_chain:
        decision === 'tool_drift'
          ? ({ tool_drift: { changes: drift.changes } } as Record<string, unknown>)
          : null,
      approval_status: null,
      approved_by: null,
      upstream_response: null,
      upstream_error: null,
      upstream_http_status: null,
      upstream_latency_ms: null,
      total_duration_ms: 0,
      approval_wait_ms: 0,
      proxy_compute_ms: 0,
      flagged_destructive: false,
      dry_run: false,
      record_kind: 'drift_event',
      origin: 'mcp',
      metadata: null,
    })
  }

  private async handleToolsCall(request: McpRequest): Promise<ForwardResult> {
    const startTime = performance.now()
    const timestamp = new Date().toISOString()
    const params = request.params as Record<string, unknown> | undefined
    const toolName = typeof params?.['name'] === 'string' ? params['name'] : undefined

    // Fail closed on a nameless tools/call (missing, non-string, or empty
    // params.name). Forwarding it unrecorded would let a lenient upstream act
    // on it outside both policy evaluation and the audit trail — the one-field
    // governance bypass that #132 closes. Reject with invalid-params and write
    // a distinct audit record so the trail stays complete.
    if (!toolName) {
      return this.rejectNamelessToolsCall(request, params, timestamp, startTime)
    }

    const toolArguments =
      params?.['arguments'] && typeof params['arguments'] === 'object'
        ? (params['arguments'] as Record<string, unknown>)
        : undefined

    const {
      decision,
      driftEvent,
      driftMode,
      driftBlocked,
      flaggedDestructive,
      evidenceResult,
      dependencyResult,
      evidenceBlocked,
      sessionBlocked,
      isDryRun,
    } = decide({
      toolName,
      toolArguments,
      sessionId: request.sessionId,
      policy: this.policy,
      environment: this.environment,
      evidenceStore: this.evidenceStore,
      baselineAnnotations: this.annotationCache.get(toolName),
      currentAnnotations: this.annotationCache.getCurrent(toolName),
      driftEvent: this.annotationCache.getDrift(toolName),
    })

    let result: ForwardResult
    let approvalOutcome: ApprovalOutcome | undefined
    let approvalWaitMs = 0
    let approvalContext: ApprovalAuditContext | undefined
    let rateLimitResult: RateLimitResult | undefined
    let spendLimitResult: SpendLimitResult | undefined
    let forwardingError: Error | undefined
    try {
      if (isDryRun) {
        result = this.handleDryRun(request, decision, toolName, toolArguments, evidenceBlocked)
      } else if (sessionBlocked) {
        result = this.makeSessionRequiredBlockResult(request, decision)
      } else if (evidenceBlocked) {
        result = this.makeEvidenceBlockResult(request, decision, evidenceResult, dependencyResult)
      } else if (driftBlocked && driftEvent) {
        result = this.makeDriftBlockResult(request, driftEvent)
      } else if (decision.action === 'allow') {
        result = await this.inner.forward(request)
      } else if (decision.action === 'deny') {
        result = this.makeDenyResult(request, decision)
      } else if (decision.action === 'require_approval') {
        if (!this.approvalRouter) {
          result = this.makeUnsupportedResult(request, decision, toolName)
        } else {
          const approvalResult = await this.handleApproval(
            request,
            decision,
            toolName,
            toolArguments,
          )
          result = approvalResult.result
          approvalOutcome = approvalResult.outcome
          approvalWaitMs = approvalResult.approvalWaitMs
          approvalContext = approvalResult.approvalContext
        }
      } else if (decision.action === 'rate_limit') {
        if (!this.rateLimiter) {
          result = this.makeUnsupportedResult(request, decision, toolName)
        } else {
          const rlResult = await this.handleRateLimit(request, decision, toolName)
          result = rlResult.result
          rateLimitResult = rlResult.rateLimitResult
        }
      } else if (decision.action === 'spend_limit') {
        if (!this.spendLimiter) {
          result = this.makeUnsupportedResult(request, decision, toolName)
        } else {
          const slResult = await this.handleSpendLimit(request, decision, toolName, toolArguments)
          result = slResult.result
          spendLimitResult = slResult.spendLimitResult
        }
      } else {
        // Unknown action (shouldn't happen) — deny defensively
        result = this.makeDenyResult(request, decision)
      }
    } catch (error) {
      forwardingError = error instanceof Error ? error : new Error(String(error))
      result = makeErrorResult(request, INTERNAL_ERROR, 'upstream forwarding failed', {
        failure_class: 'upstream_forward_error',
        failure_reason: forwardingError.message,
      })
    }

    // Record tool call for dependency tracking (never in dry-run — nothing was forwarded)
    const wasForwarded = this.wasForwardedUpstream(
      decision,
      approvalOutcome,
      rateLimitResult,
      spendLimitResult,
    )
    if (wasForwarded && !isDryRun && this.evidenceStore && request.sessionId && toolName) {
      const succeeded = !hasJsonRpcError(result)
      this.evidenceStore.recordToolCall(request.sessionId, toolName, succeeded)
    }

    const totalDurationMs = performance.now() - startTime
    this.writeAuditRecord(
      request,
      timestamp,
      toolName,
      toolArguments,
      decision,
      result,
      totalDurationMs,
      approvalWaitMs,
      flaggedDestructive,
      evidenceResult,
      dependencyResult,
      evidenceBlocked,
      approvalOutcome,
      approvalContext,
      rateLimitResult,
      spendLimitResult,
      isDryRun,
      forwardingError,
      driftEvent ? { event: driftEvent, mode: driftMode } : undefined,
    )

    return result
  }

  /**
   * Reject a `tools/call` that carries no usable tool name and record it.
   *
   * The rejection is its own audit shape, not a governed decision: no rule was
   * evaluated, so it is written directly (like {@link writeDriftAuditRecord})
   * rather than threaded through {@link writeAuditRecord}, whose
   * `PolicyDecision.action` union has no `rejected` member and whose
   * forwarded-upstream logic does not apply. The raw `params` are preserved in
   * `tool_input` so an investigator can see exactly what a lenient upstream
   * could have keyed off.
   */
  private rejectNamelessToolsCall(
    request: McpRequest,
    params: unknown,
    timestamp: string,
    startTime: number,
  ): ForwardResult {
    const result = makeErrorResult(
      request,
      INVALID_PARAMS,
      'tools/call requires a string params.name',
      { blocked: true, reason: 'missing_tool_name' },
    )

    if (this.auditWriter) {
      // Preserve the raw params losslessly and unambiguously: always nest the
      // wire value (object, array, scalar, null, or absent) under a single
      // `raw_params` key. Storing a plain object verbatim would collide — a
      // caller sending `{ raw_params: 42 }` would be indistinguishable from a
      // caller sending the scalar `42` once wrapped — so wrap uniformly.
      // `tool_input` stays a Record<string, unknown> as its type requires.
      const toolInput: Record<string, unknown> = { raw_params: params ?? null }

      this.auditWriter.pushImmediate({
        timestamp,
        session_id: request.sessionId ?? null,
        agent_id: null,
        environment: this.environment ?? null,
        tool_name: '<nameless>',
        tool_input: toolInput,
        policy_decision: 'rejected',
        block_reason: 'missing_tool_name',
        matched_rule: null,
        matched_rule_index: null,
        evidence_chain: null,
        approval_status: null,
        approved_by: null,
        upstream_response: null,
        upstream_error: null,
        upstream_http_status: null,
        upstream_latency_ms: null,
        total_duration_ms: performance.now() - startTime,
        approval_wait_ms: 0,
        proxy_compute_ms: performance.now() - startTime,
        flagged_destructive: false,
        dry_run: false,
        record_kind: 'tool_call',
        origin: 'mcp',
        metadata: null,
      })
    }

    return result
  }

  private async handleApproval(
    request: McpRequest,
    decision: PolicyDecision,
    toolName: string,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<{
    result: ForwardResult
    outcome: ApprovalOutcome
    approvalWaitMs: number
    approvalContext?: ApprovalAuditContext
  }> {
    // Caller guarantees this.approvalRouter is defined
    const router = this.approvalRouter as ApprovalRouter

    const approvalStart = performance.now()
    const outcome = await router.submit(
      {
        tool_name: toolName,
        tool_input: toolArguments ?? {},
        matched_rule: decision.matchedRule,
        session_id: request.sessionId ?? null,
      },
      request.signal,
    )
    const approvalWaitMs = performance.now() - approvalStart

    // Snapshot approval context now, before any upstream await: a forwarded
    // call can outlive the queue's resolved-ticket retention, so a later
    // ticket read-back could come up empty.
    const ticket = outcome.ticketId ? router.getTicket(outcome.ticketId) : undefined
    const denialReason = outcome.status === 'denied' && outcome.reason ? outcome.reason : undefined
    // The ticketId guard skips the synthetic ticketless denial emitted when
    // submit() races router close — its "Router is closed" reason is not an
    // approver decision and there is no ticket for the block to point at.
    const approvalContext: ApprovalAuditContext | undefined =
      outcome.ticketId && (denialReason || ticket?.escalated_at)
        ? {
            ticket_id: outcome.ticketId,
            ...(denialReason ? { denial_reason: denialReason } : {}),
            ...(ticket?.escalated_at
              ? {
                  escalated_at: ticket.escalated_at,
                  escalated_to: [...(ticket.escalated_to ?? [])],
                }
              : {}),
          }
        : undefined

    let result: ForwardResult

    if (outcome.status === 'approved' || outcome.status === 'break_glass') {
      if (request.signal?.aborted) {
        result = this.makeClientDisconnectedBlockResult(request, decision)
      } else {
        result = await this.inner.forward(request)
      }
    } else if (outcome.status === 'denied') {
      const feedback = buildApprovalDeniedFeedback(decision, outcome.resolvedBy, outcome.reason)
      const message =
        decision.matchedRule?.feedback?.message ?? `Approval denied by ${outcome.resolvedBy}`
      result = makeErrorResult(request, POLICY_DENIED, message, { ...feedback })
    } else if (outcome.status === 'client_disconnected') {
      result = this.makeClientDisconnectedBlockResult(request, decision)
    } else if (outcome.status === 'shutdown_cancelled') {
      const feedback = buildShutdownCancelledFeedback(decision)
      const message =
        decision.matchedRule?.feedback?.message ?? 'Approval cancelled by proxy shutdown'
      result = makeErrorResult(request, POLICY_DENIED, message, { ...feedback })
    } else {
      // timeout
      if (router.defaultOnTimeout === 'allow' && !request.signal?.aborted) {
        result = await this.inner.forward(request)
      } else if (request.signal?.aborted) {
        result = this.makeClientDisconnectedBlockResult(request, decision)
      } else {
        const feedback = buildApprovalTimeoutFeedback(decision, outcome.timeoutMs)
        const message = decision.matchedRule?.feedback?.message ?? `Approval timed out`
        result = makeErrorResult(request, POLICY_DENIED, message, { ...feedback })
      }
    }

    return { result, outcome, approvalWaitMs, approvalContext }
  }

  private async handleRateLimit(
    request: McpRequest,
    decision: PolicyDecision,
    toolName: string,
  ): Promise<{ result: ForwardResult; rateLimitResult: RateLimitResult }> {
    // Caller guarantees this.rateLimiter is defined
    const limiter = this.rateLimiter as RateLimiter
    const limits = decision.matchedRule?.limits

    if (!limits?.maxCalls || !limits.windowMs) {
      const result = this.makePolicyMisconfiguredResult(
        request,
        decision,
        `Policy misconfigured: rate_limit rule for "${toolName}" requires limits.max_calls and limits.window`,
      )
      return {
        result,
        rateLimitResult: { allowed: false, current: 0, limit: 0, windowMs: 0, resetAtMs: 0 },
      }
    }

    const key = this.buildLimitKey(limits.key, toolName, request)
    const rateLimitResult = limiter.check({
      key,
      maxCalls: limits.maxCalls,
      windowMs: limits.windowMs,
    })

    let result: ForwardResult
    if (rateLimitResult.allowed) {
      result = await this.inner.forward(request)
    } else {
      const feedback = buildRateLimitedFeedback(decision, rateLimitResult)
      const message = decision.matchedRule?.feedback?.message ?? `Rate limit exceeded for ${key}`
      result = makeErrorResult(request, POLICY_DENIED, message, { ...feedback })
    }

    return { result, rateLimitResult }
  }

  private async handleSpendLimit(
    request: McpRequest,
    decision: PolicyDecision,
    toolName: string,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<{ result: ForwardResult; spendLimitResult: SpendLimitResult }> {
    // Caller guarantees this.spendLimiter is defined
    const limiter = this.spendLimiter as SpendLimiter
    const maxSpend = decision.matchedRule?.limits?.maxSpend

    if (!maxSpend) {
      const result = this.makePolicyMisconfiguredResult(
        request,
        decision,
        `Policy misconfigured: spend_limit rule for "${toolName}" requires limits.max_spend`,
      )
      return {
        result,
        spendLimitResult: { allowed: false, currentSpend: 0, limit: 0, windowMs: 0, resetAtMs: 0 },
      }
    }

    // Extract the monetary amount from tool arguments
    const key = this.buildLimitKey(maxSpend.key, toolName, request)
    const rawAmount = resolvePath(maxSpend.field, toolArguments ?? {})
    if (typeof rawAmount !== 'number') {
      // eslint-disable-next-line no-console -- Intentional operational warning
      console.error(
        `[helio] Warning: spend limit field "${maxSpend.field}" did not resolve to a number for tool "${toolName}" (got ${typeof rawAmount}), denying request`,
      )
      const existingState = limiter.getKeyState(key)
      const invalidAmount: SpendLimitResult = {
        allowed: false,
        currentSpend: existingState?.current_spend ?? 0,
        limit: maxSpend.limit,
        windowMs: maxSpend.windowMs,
        resetAtMs: existingState?.reset_at_ms ?? Date.now() + maxSpend.windowMs,
        reason: 'invalid_amount',
      }
      const feedback = buildSpendLimitedFeedback(decision, invalidAmount, maxSpend.currency)
      const result = makeErrorResult(
        request,
        POLICY_DENIED,
        `Spend limit denied: invalid amount for field "${maxSpend.field}"`,
        { ...feedback },
      )
      return {
        result,
        spendLimitResult: invalidAmount,
      }
    }

    // Delegate validation to the limiter primitive — it rejects negative and
    // non-finite amounts without mutating bucket state, and returns a result
    // carrying the real currentSpend / resetAtMs from any pre-existing
    // legitimate spend on this bucket. That gives the audit row an accurate
    // snapshot of the bucket at the time of the attack, instead of a fake-zero
    // synthetic result.
    const spendLimitResult = limiter.check({
      key,
      amount: rawAmount,
      limit: maxSpend.limit,
      windowMs: maxSpend.windowMs,
    })

    if (spendLimitResult.reason === 'invalid_amount') {
      // eslint-disable-next-line no-console -- Intentional operational warning
      console.error(
        `[helio] Warning: spend limit field "${maxSpend.field}" resolved to invalid amount (${String(rawAmount)}) for tool "${toolName}" (rule: ${decision.matchedRule.name ?? 'unnamed'}), denying request`,
      )
    } else {
      // Bucket was created or updated — label it for dashboard reads. Skip on
      // the invalid-amount path because the limiter never created a bucket.
      limiter.setCurrency(key, maxSpend.currency)
    }

    let result: ForwardResult
    if (spendLimitResult.allowed) {
      result = await this.inner.forward(request)
    } else {
      const feedback = buildSpendLimitedFeedback(decision, spendLimitResult, maxSpend.currency)
      const message =
        spendLimitResult.reason === 'invalid_amount'
          ? `Spend limit denied: invalid amount for field "${maxSpend.field}"`
          : (decision.matchedRule.feedback?.message ??
            `Spend limit exceeded for ${key} (${maxSpend.currency})`)
      result = makeErrorResult(request, POLICY_DENIED, message, { ...feedback })
    }

    return { result, spendLimitResult }
  }

  /**
   * Handle dry-run mode: compute what would have happened without forwarding
   * or consuming any resources. Returns an MCP-compliant synthetic response.
   */
  private handleDryRun(
    request: McpRequest,
    decision: PolicyDecision,
    toolName: string,
    toolArguments: Record<string, unknown> | undefined,
    evidenceBlocked: boolean,
  ): ForwardResult {
    const evidenceSatisfied = !evidenceBlocked
    let wouldForward = false
    let limitsOk = true

    if (!evidenceBlocked) {
      switch (decision.action) {
        case 'allow':
          wouldForward = true
          break
        case 'rate_limit':
          if (
            this.rateLimiter &&
            decision.matchedRule?.limits?.maxCalls &&
            decision.matchedRule.limits.windowMs
          ) {
            const key = this.buildLimitKey(decision.matchedRule.limits.key, toolName, request)
            const peekResult = this.rateLimiter.peek({
              key,
              maxCalls: decision.matchedRule.limits.maxCalls,
              windowMs: decision.matchedRule.limits.windowMs,
            })
            wouldForward = peekResult.allowed
            limitsOk = peekResult.allowed
          }
          break
        case 'spend_limit':
          if (this.spendLimiter && decision.matchedRule?.limits?.maxSpend) {
            const maxSpend = decision.matchedRule.limits.maxSpend
            const rawAmount = resolvePath(maxSpend.field, toolArguments ?? {})
            if (typeof rawAmount === 'number') {
              if (!Number.isFinite(rawAmount) || rawAmount < 0) {
                // eslint-disable-next-line no-console -- Intentional operational warning
                console.error(
                  `[helio] Warning: spend limit field "${maxSpend.field}" resolved to invalid amount (${String(rawAmount)}) for tool "${toolName}" in dry-run, denying`,
                )
                wouldForward = false
                limitsOk = false
              } else {
                const key = this.buildLimitKey(maxSpend.key, toolName, request)
                const peekResult = this.spendLimiter.peek({
                  key,
                  amount: rawAmount,
                  limit: maxSpend.limit,
                  windowMs: maxSpend.windowMs,
                })
                wouldForward = peekResult.allowed
                limitsOk = peekResult.allowed
              }
            }
          }
          break
        // deny, dry_run, require_approval: wouldForward stays false
      }
    }

    return this.makeDryRunResult(request, decision, wouldForward, evidenceSatisfied, limitsOk)
  }

  /** Construct a limit bucket key based on the configured key type. */
  private buildLimitKey(
    keyType: 'tool' | 'agent' | 'session' | 'sender_id' | undefined,
    toolName: string,
    request: McpRequest,
  ): string {
    switch (keyType) {
      case 'session':
        return `session:${request.sessionId ?? 'unknown'}`
      case 'agent':
        // agent_id is not yet available on McpRequest — fall back to tool
        if (!this.agentKeyWarned) {
          this.agentKeyWarned = true
          // eslint-disable-next-line no-console -- Intentional operational warning
          console.error(
            '[helio] Warning: limits.key "agent" is not yet supported, falling back to "tool"',
          )
        }
        return `tool:${toolName}`
      case 'sender_id':
        // sender_id is an adapter (host-enforced) context field — absent on the
        // MCP path, so fall back to tool scope. Config validation rejects this
        // combination when the sideband is disabled (issue #13).
        if (!this.senderKeyWarned) {
          this.senderKeyWarned = true
          // eslint-disable-next-line no-console -- Intentional operational warning
          console.error(
            '[helio] Warning: limits.key "sender_id" has no sender on the MCP path, falling back to "tool"',
          )
        }
        return `tool:${toolName}`
      case 'tool':
      default:
        return `tool:${toolName}`
    }
  }

  /** Determine if the request was actually forwarded to the upstream MCP server. */
  private wasForwardedUpstream(
    decision: PolicyDecision,
    approvalOutcome?: ApprovalOutcome,
    rateLimitResult?: RateLimitResult,
    spendLimitResult?: SpendLimitResult,
  ): boolean {
    return (
      decision.action === 'allow' ||
      approvalOutcome?.status === 'approved' ||
      approvalOutcome?.status === 'break_glass' ||
      (approvalOutcome?.status === 'timeout' &&
        this.approvalRouter?.defaultOnTimeout === 'allow') ||
      rateLimitResult?.allowed === true ||
      spendLimitResult?.allowed === true
    )
  }

  private writeAuditRecord(
    request: McpRequest,
    timestamp: string,
    toolName: string,
    toolArguments: Record<string, unknown> | undefined,
    decision: PolicyDecision,
    result: ForwardResult,
    totalDurationMs: number,
    approvalWaitMs: number,
    flaggedDestructive: boolean,
    evidenceResult?: EvidenceCheckResult,
    dependencyResult?: DependencyCheckResult,
    evidenceBlocked?: boolean,
    approvalOutcome?: ApprovalOutcome,
    approvalContext?: ApprovalAuditContext,
    rateLimitResult?: RateLimitResult,
    spendLimitResult?: SpendLimitResult,
    isDryRun?: boolean,
    forwardingError?: Error,
    drift?: { event: ToolDriftEvent; mode: 'block' | 'require_approval' | 'log' },
  ): void {
    if (!this.auditWriter) return

    const wasForwarded = this.wasForwardedUpstream(
      decision,
      approvalOutcome,
      rateLimitResult,
      spendLimitResult,
    )

    // In dry-run mode, nothing was actually forwarded regardless of what
    // wasForwardedUpstream() returns based on the policy decision alone.
    const actuallyForwarded = wasForwarded && !isDryRun
    const hadForwardingError = forwardingError !== undefined

    // Extract upstream error from JSON-RPC error response
    let upstreamError: string | null = null
    const upstreamHttpStatus =
      actuallyForwarded && !hadForwardingError ? result.response.status : null
    const upstreamLatencyMs = actuallyForwarded && !hadForwardingError ? result.durationMs : null
    const proxyComputeMs = Math.max(0, totalDurationMs - approvalWaitMs - (upstreamLatencyMs ?? 0))
    if (forwardingError) {
      upstreamError = forwardingError.message
    } else if (actuallyForwarded) {
      const body = result.response.body as Record<string, unknown> | undefined
      const error = body?.['error'] as Record<string, unknown> | undefined
      if (typeof error?.['message'] === 'string') {
        upstreamError = error['message']
      }
    } else if (spendLimitResult?.reason === 'invalid_amount') {
      upstreamError = 'invalid spend amount'
    }

    // Build evidence chain, augmenting with break-glass metadata if applicable
    let evidenceChain = buildEvidenceChain(evidenceResult, dependencyResult, evidenceBlocked)
    if (approvalOutcome?.status === 'break_glass' && 'reason' in approvalOutcome) {
      evidenceChain = {
        ...(evidenceChain ?? {}),
        break_glass: {
          reason: approvalOutcome.reason,
          invoked_by: approvalOutcome.resolvedBy,
        },
      }
    }
    if (approvalContext) {
      evidenceChain = {
        ...(evidenceChain ?? {}),
        approval: { ...approvalContext },
      }
    }
    if (rateLimitResult) {
      evidenceChain = {
        ...(evidenceChain ?? {}),
        rate_limit: {
          allowed: rateLimitResult.allowed,
          current: rateLimitResult.current,
          limit: rateLimitResult.limit,
          window_ms: rateLimitResult.windowMs,
          reset_at_ms: rateLimitResult.resetAtMs,
        },
      }
    }
    if (spendLimitResult) {
      evidenceChain = {
        ...(evidenceChain ?? {}),
        spend_limit: {
          allowed: spendLimitResult.allowed,
          current_spend: spendLimitResult.currentSpend,
          limit: spendLimitResult.limit,
          window_ms: spendLimitResult.windowMs,
          reset_at_ms: spendLimitResult.resetAtMs,
          ...(spendLimitResult.reason ? { reason: spendLimitResult.reason } : {}),
        },
      }
    }

    if (drift) {
      evidenceChain = {
        ...(evidenceChain ?? {}),
        tool_drift: {
          mode: drift.mode,
          changes: drift.event.changes,
        },
      }
    }

    const blockReason = extractBlockReason(result)

    const record: Omit<AuditRecord, 'id' | 'created_at'> = {
      timestamp,
      session_id: request.sessionId ?? null,
      agent_id: null,
      environment: this.environment ?? null,
      tool_name: toolName,
      tool_input: toolArguments ?? {},
      policy_decision: decision.action,
      block_reason: blockReason,
      matched_rule: decision.matchedRule?.name ?? null,
      matched_rule_index: decision.matchedRule?.index ?? null,
      evidence_chain: evidenceChain,
      approval_status: approvalOutcome?.status ?? null,
      approved_by:
        approvalOutcome && 'resolvedBy' in approvalOutcome ? approvalOutcome.resolvedBy : null,
      upstream_response: actuallyForwarded && !hadForwardingError ? result.response.body : null,
      upstream_error: upstreamError,
      upstream_http_status: upstreamHttpStatus,
      upstream_latency_ms: upstreamLatencyMs,
      total_duration_ms: totalDurationMs,
      approval_wait_ms: approvalWaitMs,
      proxy_compute_ms: proxyComputeMs,
      flagged_destructive: flaggedDestructive,
      dry_run: isDryRun ?? false,
      record_kind: 'tool_call',
      origin: 'mcp',
      metadata: null,
    }

    // Security-critical decisions — denies, approval resolutions, and
    // rate/spend blocks — are prioritized onto the writer's near-term async
    // flush queue. Ordinary allows stay buffered to reduce write churn.
    // Crash durability is preserved by the process-level crash-drain hook,
    // which synchronously flushes the writer before exit.
    const isEnforcementDecision = !isDryRun && (!wasForwarded || approvalOutcome !== undefined)
    if (isEnforcementDecision) {
      this.auditWriter.pushImmediate(record)
    } else {
      this.auditWriter.push(record)
    }
  }

  private makeDriftBlockResult(request: McpRequest, drift: ToolDriftEvent): ForwardResult {
    const feedback = buildToolDriftFeedback(drift, 'deny')
    return makeErrorResult(
      request,
      POLICY_DENIED,
      `Tool definition drift: "${drift.toolName}" changed after baseline`,
      { ...feedback },
    )
  }

  private makeDenyResult(request: McpRequest, decision: PolicyDecision): ForwardResult {
    const feedback = buildPolicyDeniedFeedback(decision)
    const message = decision.matchedRule?.feedback?.message ?? `Policy denied: ${decision.reason}`
    return makeErrorResult(request, POLICY_DENIED, message, { ...feedback })
  }

  private makePolicyMisconfiguredResult(
    request: McpRequest,
    decision: PolicyDecision,
    reason: string,
  ): ForwardResult {
    const denyDecision: PolicyDecision = {
      action: 'deny',
      matchedRule: decision.matchedRule,
      reason,
    }
    const feedback = buildPolicyDeniedFeedback(denyDecision)
    return makeErrorResult(request, POLICY_DENIED, reason, { ...feedback })
  }

  private makeUnsupportedResult(
    request: McpRequest,
    decision: PolicyDecision,
    toolName?: string,
  ): ForwardResult {
    const action = decision.action

    // Destructive auto-escalation has no matched rule
    const message = decision.matchedRule
      ? `Action "${action}" matched by ${decision.matchedRule.name ? `"${decision.matchedRule.name}"` : `rule[${String(decision.matchedRule.index)}]`} is not yet supported`
      : `Destructive tool "${toolName ?? 'unknown'}" requires approval (flag_destructive policy)`

    return makeErrorResult(request, POLICY_DENIED, message, {
      blocked: true,
      rule: decision.matchedRule?.name ?? null,
      ruleIndex: decision.matchedRule?.index ?? null,
      action,
      reason: decision.reason,
      unsupported: true,
    })
  }

  private makeDryRunResult(
    request: McpRequest,
    decision: PolicyDecision,
    wouldForward: boolean,
    evidenceSatisfied: boolean,
    limitsOk: boolean,
  ): ForwardResult {
    const payload = {
      dry_run: true,
      would_forward: wouldForward,
      policy_decision: decision.action,
      matched_rule: decision.matchedRule?.name ?? null,
      evidence_satisfied: evidenceSatisfied,
      limits_ok: limitsOk,
    }
    const body = {
      jsonrpc: '2.0' as const,
      id: request.id ?? null,
      result: {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
      },
    }
    const response: McpResponse = {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body,
    }
    return { response, durationMs: 0 }
  }

  private makeEvidenceBlockResult(
    request: McpRequest,
    decision: PolicyDecision,
    evidenceResult?: EvidenceCheckResult,
    dependencyResult?: DependencyCheckResult,
  ): ForwardResult {
    // Determine the primary block reason
    const reason =
      evidenceResult && !evidenceResult.satisfied
        ? evidenceResult.expired.length > 0
          ? 'evidence_expired'
          : 'evidence_missing'
        : 'dependency_missing'

    const builder =
      reason === 'evidence_expired'
        ? buildEvidenceExpiredFeedback
        : reason === 'evidence_missing'
          ? buildEvidenceMissingFeedback
          : buildDependencyMissingFeedback

    const feedback = builder(decision, evidenceResult, dependencyResult)

    return makeErrorResult(
      request,
      POLICY_DENIED,
      `Evidence grounding failed: ${decision.reason}`,
      { ...feedback },
    )
  }

  private makeSessionRequiredBlockResult(
    request: McpRequest,
    decision: PolicyDecision,
  ): ForwardResult {
    const feedback = buildPolicyDeniedFeedback(decision)
    return makeErrorResult(
      request,
      POLICY_DENIED,
      'Mcp-Session-Id is required for evidence/dependency-gated policy rules',
      {
        ...feedback,
        retry_allowed: true,
      },
    )
  }

  private makeClientDisconnectedBlockResult(
    request: McpRequest,
    decision: PolicyDecision,
  ): ForwardResult {
    const feedback = buildClientDisconnectedFeedback(decision)
    return makeErrorResult(request, POLICY_DENIED, 'Client disconnected before completion', {
      ...feedback,
    })
  }
}

function collectAllowedEvidenceKeys(policy: CompiledPolicy): string[] {
  const keys = new Set<string>()
  for (const rule of policy.rules) {
    for (const key of rule.evidence?.requires ?? []) {
      keys.add(key)
    }
  }
  return [...keys]
}

/** Build a ForwardResult containing a JSON-RPC error response. */
function makeErrorResult(
  request: McpRequest,
  code: number,
  message: string,
  data: Record<string, unknown>,
): ForwardResult {
  const body = {
    jsonrpc: '2.0' as const,
    id: request.id ?? null,
    error: { code, message, data },
  }
  const response: McpResponse = {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body,
  }
  return { response, durationMs: 0 }
}

/** Check if a ForwardResult contains a JSON-RPC error response. */
function hasJsonRpcError(result: ForwardResult): boolean {
  const body = result.response.body as Record<string, unknown> | undefined
  return body?.['error'] !== undefined
}

/** Produce an actionable reason when a prime tools/list response is unusable. */
function classifyPrimeFailure(response: McpResponse): string {
  if (response.status >= 400) {
    return `upstream returned HTTP ${String(response.status)} to tools/list (session/initialize may be required)`
  }
  const rawBody = response.body
  if (typeof rawBody !== 'object' || rawBody === null) {
    return `upstream tools/list returned a non-JSON body (content-type ${response.headers['content-type'] ?? 'unknown'})`
  }
  const body = rawBody as Record<string, unknown>
  const error = body['error']
  if (typeof error === 'string') {
    // Non-conforming upstreams sometimes return a bare string error.
    return `upstream tools/list returned a JSON-RPC error: ${error}`
  }
  if (error !== null && typeof error === 'object') {
    const message = (error as Record<string, unknown>)['message']
    if (typeof message === 'string') {
      return `upstream tools/list returned a JSON-RPC error: ${message}`
    }
  }
  return 'upstream tools/list response was missing result.tools'
}

function extractBlockReason(result: ForwardResult): string | null {
  const body = result.response.body as Record<string, unknown> | undefined
  const error = body?.['error']
  if (!error || typeof error !== 'object') return null
  const data = (error as Record<string, unknown>)['data'] as Record<string, unknown> | undefined
  if (!data || data['blocked'] !== true) return null
  return typeof data['reason'] === 'string' ? data['reason'] : null
}

/** Build the evidence_chain field for audit records. */
function buildEvidenceChain(
  evidenceResult?: EvidenceCheckResult,
  dependencyResult?: DependencyCheckResult,
  blocked?: boolean,
): Record<string, unknown> | null {
  if (!evidenceResult && !dependencyResult) return null

  const chain: Record<string, unknown> = { blocked: blocked ?? false }

  if (evidenceResult) {
    chain['evidence'] = {
      required: [...evidenceResult.found, ...evidenceResult.missing, ...evidenceResult.expired],
      found: evidenceResult.found,
      missing: evidenceResult.missing,
      expired: evidenceResult.expired,
    }
  }

  if (dependencyResult) {
    chain['dependencies'] = {
      satisfied: dependencyResult.satisfied,
      missing: dependencyResult.missing,
    }
  }

  return chain
}
