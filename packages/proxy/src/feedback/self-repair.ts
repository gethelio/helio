import type { CompiledPolicyRule } from '../policy/types.js'
import type { PolicyDecision } from '../policy/engine.js'
import type { EvidenceCheckResult, DependencyCheckResult } from '../evidence/grounding.js'
import type { RateLimitResult } from '../policy/rate-limiter.js'
import type { SpendLimitResult } from '../policy/spend-limiter.js'
import type { ToolDriftEvent } from '../policy/annotation-cache.js'
import type { BudgetChargeFailure, BudgetPeekEntry } from '../budget/engine.js'

// ---------------------------------------------------------------------------
// Block reasons — the discriminant for self-repair feedback.
// ---------------------------------------------------------------------------

/** Block reasons that the proxy can return as self-repair feedback. */
export type BlockReason =
  | 'policy_denied'
  | 'evidence_missing'
  | 'evidence_expired'
  | 'dependency_missing'
  | 'rate_limited'
  | 'spend_limited'
  | 'approval_denied'
  | 'approval_timeout'
  | 'client_disconnected'
  | 'shutdown_cancelled'
  | 'tool_definition_drift'
  | 'budget_exceeded'

// ---------------------------------------------------------------------------
// Feedback types — discriminated union keyed on `reason`.
// ---------------------------------------------------------------------------

/** Fields shared by all self-repair feedback variants. */
interface SelfRepairFeedbackBase {
  readonly blocked: true
  readonly reason: BlockReason
  readonly rule: string | null
  /** Index of the matched rule in `policies.rules`, or null (issue #109). */
  readonly rule_index: number | null
  readonly suggestion: string
  readonly retry_allowed: boolean
}

/** Policy explicitly denied the action. */
export interface PolicyDeniedFeedback extends SelfRepairFeedbackBase {
  readonly reason: 'policy_denied'
  readonly action: 'deny'
  /** The raw decision reason from the policy engine. */
  readonly policy_reason: string
}

/** Required evidence was never submitted. */
export interface EvidenceMissingFeedback extends SelfRepairFeedbackBase {
  readonly reason: 'evidence_missing'
  readonly action: 'deny'
  readonly missing_evidence: readonly string[]
  readonly expired_evidence: readonly string[]
  readonly missing_dependencies: readonly string[]
}

/** Required evidence was present but TTL elapsed. */
export interface EvidenceExpiredFeedback extends SelfRepairFeedbackBase {
  readonly reason: 'evidence_expired'
  readonly action: 'deny'
  readonly missing_evidence: readonly string[]
  readonly expired_evidence: readonly string[]
  readonly missing_dependencies: readonly string[]
}

/** Required prerequisite tool call was not made. */
export interface DependencyMissingFeedback extends SelfRepairFeedbackBase {
  readonly reason: 'dependency_missing'
  readonly action: 'deny'
  readonly missing_evidence: readonly string[]
  readonly expired_evidence: readonly string[]
  readonly missing_dependencies: readonly string[]
}

/** A human approver explicitly denied the action. */
export interface ApprovalDeniedFeedback extends SelfRepairFeedbackBase {
  readonly reason: 'approval_denied'
  readonly action: 'require_approval'
  readonly denied_by: string
  readonly denial_reason: string | null
}

/** The approval request timed out with no response. */
export interface ApprovalTimeoutFeedback extends SelfRepairFeedbackBase {
  readonly reason: 'approval_timeout'
  readonly action: 'require_approval'
  readonly timeout_seconds: number
}

/** The client disconnected while the approval workflow was in-flight. */
export interface ClientDisconnectedFeedback extends SelfRepairFeedbackBase {
  readonly reason: 'client_disconnected'
  readonly action: 'require_approval'
}

/** The proxy shut down while the approval workflow was in-flight. */
export interface ShutdownCancelledFeedback extends SelfRepairFeedbackBase {
  readonly reason: 'shutdown_cancelled'
  readonly action: 'require_approval'
}

/** The rate limit for this key has been exceeded. */
export interface RateLimitedFeedback extends SelfRepairFeedbackBase {
  readonly reason: 'rate_limited'
  readonly action: 'rate_limit'
  readonly current_calls: number
  readonly max_calls: number
  readonly window_seconds: number
  readonly reset_at: string // ISO 8601
}

/** The spend limit for this key has been exceeded. */
export interface SpendLimitedFeedback extends SelfRepairFeedbackBase {
  readonly reason: 'spend_limited'
  readonly action: 'spend_limit'
  readonly current_spend: number
  readonly max_spend: number
  readonly currency: string
  readonly window_seconds: number
  readonly reset_at: string // ISO 8601
}

/** The tool's definition drifted from its baseline (MCP rug-pull guard). */
export interface ToolDriftFeedback extends SelfRepairFeedbackBase {
  readonly reason: 'tool_definition_drift'
  readonly action: 'deny' | 'require_approval'
  readonly drifted_aspects: readonly string[]
}

/** One breached (or invalid-amount) budget inside a budget_exceeded denial. */
export interface BudgetBreachBlock {
  readonly name: string
  readonly limit: number
  readonly spent: number
  readonly remaining: number
  readonly attempted_amount: number | null
  readonly currency: string
  readonly window: string
  readonly on_exceed: 'deny' | 'require_approval'
  /** ISO-8601 for duration windows; null for session pots (never replenish). */
  readonly reset_at: string | null
  /** Set when the contributor amount was missing or invalid (fail closed). */
  readonly reason?: 'invalid_amount'
}

/** One or more named budgets denied the call (issue #14). */
export interface BudgetExceededFeedback extends SelfRepairFeedbackBase {
  readonly reason: 'budget_exceeded'
  readonly action: 'budget'
  readonly budgets: readonly BudgetBreachBlock[]
}

/** A human denied the break-glass ticket for a budget overage (issue #14). */
export interface BudgetApprovalDeniedFeedback extends SelfRepairFeedbackBase {
  readonly reason: 'budget_exceeded'
  readonly action: 'budget'
  readonly denied_by: string
  readonly denial_reason: string | null
  readonly budgets: readonly BudgetBreachBlock[]
}

/**
 * The break-glass ticket for a budget overage timed out (issue #14). Budget
 * tickets fail closed on timeout regardless of `approval.default_on_timeout`
 * — money gates do not fail open.
 */
export interface BudgetApprovalTimeoutFeedback extends SelfRepairFeedbackBase {
  readonly reason: 'budget_exceeded'
  readonly action: 'budget'
  readonly timeout_seconds: number
  readonly budgets: readonly BudgetBreachBlock[]
}

/** Discriminated union of all self-repair feedback types. */
export type SelfRepairFeedback =
  | PolicyDeniedFeedback
  | EvidenceMissingFeedback
  | EvidenceExpiredFeedback
  | DependencyMissingFeedback
  | ApprovalDeniedFeedback
  | ApprovalTimeoutFeedback
  | ClientDisconnectedFeedback
  | ShutdownCancelledFeedback
  | RateLimitedFeedback
  | SpendLimitedFeedback
  | ToolDriftFeedback
  | BudgetExceededFeedback
  | BudgetApprovalDeniedFeedback
  | BudgetApprovalTimeoutFeedback

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract rule name and index from a compiled rule.
 *
 * Every builder spreads this return, so the base `rule`/`rule_index` fields
 * have exactly one emission site. The deprecated `ruleIndex` alias from the
 * issue #109 rename lived here for its one-release window and was removed in
 * issue #144.
 */
export function ruleInfo(rule?: CompiledPolicyRule): {
  rule: string | null
  rule_index: number | null
} {
  return {
    rule: rule?.name ?? null,
    rule_index: rule?.index ?? null,
  }
}

// ---------------------------------------------------------------------------
// Builder functions — pure, no side effects.
// ---------------------------------------------------------------------------

/**
 * Build self-repair feedback for a policy deny decision.
 *
 * Suggestion fallback chain:
 * 1. `rule.feedback.suggestion` if present
 * 2. `rule.feedback.message` if present
 * 3. Auto-generated from template
 */
export function buildPolicyDeniedFeedback(decision: PolicyDecision): PolicyDeniedFeedback {
  const info = ruleInfo(decision.matchedRule)

  const suggestion =
    decision.matchedRule?.feedback?.suggestion ??
    decision.matchedRule?.feedback?.message ??
    `This action was denied by policy${info.rule ? ` (rule: "${info.rule}")` : ''}. Review the policy configuration or use an allowed tool instead.`

  return {
    blocked: true,
    reason: 'policy_denied',
    ...info,
    action: 'deny',
    policy_reason: decision.reason,
    suggestion,
    retry_allowed: false,
  }
}

/** Build self-repair feedback when required evidence was never submitted. */
export function buildEvidenceMissingFeedback(
  decision: PolicyDecision,
  evidenceResult: EvidenceCheckResult | undefined,
  dependencyResult: DependencyCheckResult | undefined,
): EvidenceMissingFeedback {
  const info = ruleInfo(decision.matchedRule)
  const missing = evidenceResult?.missing ?? []

  const suggestion =
    missing.length === 1
      ? `Call the ${String(missing[0])} tool first to provide the required evidence, then retry this action.`
      : `Call the following tools first to provide the required evidence: ${missing.join(', ')}. Then retry this action.`

  return {
    blocked: true,
    reason: 'evidence_missing',
    ...info,
    action: 'deny',
    missing_evidence: missing,
    expired_evidence: evidenceResult?.expired ?? [],
    missing_dependencies: dependencyResult?.missing ?? [],
    suggestion,
    retry_allowed: true,
  }
}

/** Build self-repair feedback when required evidence has expired (TTL elapsed). */
export function buildEvidenceExpiredFeedback(
  decision: PolicyDecision,
  evidenceResult: EvidenceCheckResult | undefined,
  dependencyResult: DependencyCheckResult | undefined,
): EvidenceExpiredFeedback {
  const info = ruleInfo(decision.matchedRule)
  const expired = evidenceResult?.expired ?? []

  const suggestion =
    expired.length === 1
      ? `Evidence from ${String(expired[0])} has expired. Call it again to refresh the evidence, then retry this action.`
      : `Evidence from the following tools has expired: ${expired.join(', ')}. Call them again to refresh, then retry this action.`

  return {
    blocked: true,
    reason: 'evidence_expired',
    ...info,
    action: 'deny',
    missing_evidence: evidenceResult?.missing ?? [],
    expired_evidence: expired,
    missing_dependencies: dependencyResult?.missing ?? [],
    suggestion,
    retry_allowed: true,
  }
}

/** Build self-repair feedback when required prerequisite tool calls have not been made. */
export function buildDependencyMissingFeedback(
  decision: PolicyDecision,
  evidenceResult: EvidenceCheckResult | undefined,
  dependencyResult: DependencyCheckResult | undefined,
): DependencyMissingFeedback {
  const info = ruleInfo(decision.matchedRule)
  const missing = dependencyResult?.missing ?? []

  const suggestion =
    missing.length === 1
      ? `Call the ${String(missing[0])} tool first before attempting this action.`
      : `Call the following tools first: ${missing.join(', ')}. Then retry this action.`

  return {
    blocked: true,
    reason: 'dependency_missing',
    ...info,
    action: 'deny',
    missing_evidence: evidenceResult?.missing ?? [],
    expired_evidence: evidenceResult?.expired ?? [],
    missing_dependencies: missing,
    suggestion,
    retry_allowed: true,
  }
}

/**
 * Build self-repair feedback when a human approver explicitly denied the action.
 *
 * Suggestion fallback chain:
 * 1. `rule.feedback.suggestion` if present
 * 2. `rule.feedback.message` if present
 * 3. Auto-generated from template
 */
export function buildApprovalDeniedFeedback(
  decision: PolicyDecision,
  deniedBy: string,
  denialReason?: string,
): ApprovalDeniedFeedback {
  const info = ruleInfo(decision.matchedRule)

  const suggestion =
    decision.matchedRule?.feedback?.suggestion ??
    decision.matchedRule?.feedback?.message ??
    `This action was denied by ${deniedBy}.${denialReason ? ` Reason: ${denialReason}.` : ''} Contact them for details or use an alternative approach.`

  return {
    blocked: true,
    reason: 'approval_denied',
    ...info,
    action: 'require_approval',
    denied_by: deniedBy,
    denial_reason: denialReason ?? null,
    suggestion,
    retry_allowed: false,
  }
}

/** Build self-repair feedback when an approval request timed out. */
export function buildApprovalTimeoutFeedback(
  decision: PolicyDecision,
  timeoutMs: number,
): ApprovalTimeoutFeedback {
  const info = ruleInfo(decision.matchedRule)
  const timeoutSeconds = Math.round(timeoutMs / 1_000)

  const suggestion =
    decision.matchedRule?.feedback?.suggestion ??
    decision.matchedRule?.feedback?.message ??
    `Approval request timed out after ${String(timeoutSeconds)}s. Try again or contact an approver directly.`

  return {
    blocked: true,
    reason: 'approval_timeout',
    ...info,
    action: 'require_approval',
    timeout_seconds: timeoutSeconds,
    suggestion,
    retry_allowed: true,
  }
}

/** Build self-repair feedback when the caller disconnects before completion. */
export function buildClientDisconnectedFeedback(
  decision: PolicyDecision,
): ClientDisconnectedFeedback {
  const info = ruleInfo(decision.matchedRule)
  const suggestion =
    decision.matchedRule?.feedback?.suggestion ??
    decision.matchedRule?.feedback?.message ??
    'The client disconnected before this request completed. Retry with a stable connection.'

  return {
    blocked: true,
    reason: 'client_disconnected',
    ...info,
    action: 'require_approval',
    suggestion,
    retry_allowed: true,
  }
}

/** Build self-repair feedback when the proxy shuts down before completion. */
export function buildShutdownCancelledFeedback(
  decision: PolicyDecision,
): ShutdownCancelledFeedback {
  const info = ruleInfo(decision.matchedRule)
  const suggestion =
    decision.matchedRule?.feedback?.suggestion ??
    decision.matchedRule?.feedback?.message ??
    'The proxy was shut down while this request was awaiting approval (for example during deploy/restart). Retry once the proxy is healthy.'

  return {
    blocked: true,
    reason: 'shutdown_cancelled',
    ...info,
    action: 'require_approval',
    suggestion,
    retry_allowed: true,
  }
}

/** Build self-repair feedback when a rate limit has been exceeded. */
export function buildRateLimitedFeedback(
  decision: PolicyDecision,
  result: RateLimitResult,
): RateLimitedFeedback {
  const info = ruleInfo(decision.matchedRule)
  const windowSeconds = Math.round(result.windowMs / 1_000)
  const resetAt = new Date(result.resetAtMs).toISOString()

  const suggestion =
    decision.matchedRule?.feedback?.suggestion ??
    decision.matchedRule?.feedback?.message ??
    `Rate limit exceeded (${String(result.current)}/${String(result.limit)} calls in ${String(windowSeconds)}s window). Retry after ${resetAt} or reduce call frequency.`

  return {
    blocked: true,
    reason: 'rate_limited',
    ...info,
    action: 'rate_limit',
    current_calls: result.current,
    max_calls: result.limit,
    window_seconds: windowSeconds,
    reset_at: resetAt,
    suggestion,
    retry_allowed: true,
  }
}

/** Build self-repair feedback when a tool's definition drifted from baseline. */
export function buildToolDriftFeedback(
  drift: ToolDriftEvent,
  action: 'deny' | 'require_approval',
): ToolDriftFeedback {
  const aspects = drift.changes.map((change) => change.aspect)
  return {
    blocked: true,
    reason: 'tool_definition_drift',
    ...ruleInfo(undefined),
    action,
    drifted_aspects: aspects,
    suggestion:
      `The definition of "${drift.toolName}" changed upstream (${aspects.join(', ')}) after ` +
      'Helio baselined it. An operator must review the change; restarting the proxy ' +
      're-baselines, or the upstream can revert the change.',
    retry_allowed: false,
  }
}

/** Build self-repair feedback when a spend limit has been exceeded. */
export function buildSpendLimitedFeedback(
  decision: PolicyDecision,
  result: SpendLimitResult,
  currency: string,
): SpendLimitedFeedback {
  const info = ruleInfo(decision.matchedRule)
  const windowSeconds = Math.round(result.windowMs / 1_000)

  // Invalid amount: input-level deny, no bucket state to surface. Retry is
  // immediate with a corrected value, not after the window resets — so reset_at
  // is now and the suggestion explains the expected shape.
  if (result.reason === 'invalid_amount') {
    const field = decision.matchedRule?.limits?.maxSpend?.field ?? 'amount'
    return {
      blocked: true,
      reason: 'spend_limited',
      ...info,
      action: 'spend_limit',
      current_spend: result.currentSpend,
      max_spend: result.limit,
      currency,
      window_seconds: windowSeconds,
      reset_at: new Date().toISOString(),
      suggestion:
        decision.matchedRule?.feedback?.suggestion ??
        decision.matchedRule?.feedback?.message ??
        `Spend amount for field "${field}" must be a non-negative finite number. Retry with a valid amount.`,
      retry_allowed: true,
    }
  }

  const resetAt = new Date(result.resetAtMs).toISOString()

  const suggestion =
    decision.matchedRule?.feedback?.suggestion ??
    decision.matchedRule?.feedback?.message ??
    `Spend limit exceeded (${String(result.currentSpend)}/${String(result.limit)} ${currency} in ${String(windowSeconds)}s window). Retry after ${resetAt} or reduce spend.`

  return {
    blocked: true,
    reason: 'spend_limited',
    ...info,
    action: 'spend_limit',
    current_spend: result.currentSpend,
    max_spend: result.limit,
    currency,
    window_seconds: windowSeconds,
    reset_at: resetAt,
    suggestion,
    retry_allowed: true,
  }
}

/**
 * Build self-repair feedback when named budgets deny a call (issue #14).
 *
 * Lists every breached budget (all-or-nothing gate: one breach denies the
 * call and nothing is recorded anywhere) and every fail-closed invalid-amount
 * contributor. The rule fields come from the shared `ruleInfo` helper.
 */
/** Map a breached peek entry to its wire block (shared by every budget builder). */
function breachBlock(entry: BudgetPeekEntry): BudgetBreachBlock {
  return {
    name: entry.budget.name,
    limit: entry.budget.limit,
    spent: entry.spent,
    remaining: entry.remaining,
    attempted_amount: entry.amount,
    currency: entry.budget.currency,
    window: entry.budget.windowRaw,
    on_exceed: entry.budget.onExceed,
    reset_at: entry.resetAtMs === null ? null : new Date(entry.resetAtMs).toISOString(),
  }
}

export function buildBudgetExceededFeedback(
  decision: PolicyDecision,
  breaches: readonly BudgetPeekEntry[],
  failures: readonly BudgetChargeFailure[],
): BudgetExceededFeedback {
  const info = ruleInfo(decision.matchedRule)

  const budgets: BudgetBreachBlock[] = [
    ...breaches.map(breachBlock),
    ...failures.map((failure) => ({
      name: failure.budget.name,
      limit: failure.budget.limit,
      spent: failure.spent,
      remaining: failure.remaining,
      attempted_amount: null,
      currency: failure.budget.currency,
      window: failure.budget.windowRaw,
      on_exceed: failure.budget.onExceed,
      reset_at: failure.resetAtMs === null ? null : new Date(failure.resetAtMs).toISOString(),
      reason: 'invalid_amount' as const,
    })),
  ]

  // Budget-specific by design: a matched rule's feedback describes the RULE
  // (which may have said allow), not the budget that denied the call.
  const suggestion =
    failures.length > 0
      ? `Budget ${failures.map((f) => `"${f.budget.name}"`).join(', ')} could not read a valid spend amount from this call. Retry with a non-negative finite amount in the expected field.`
      : `Budget ${breaches.map((b) => `"${b.budget.name}"`).join(', ')} would be exceeded by this call. Wait for the window to reset or reduce the amount.`

  // Retryability hinges on the actual breaches: duration windows replenish,
  // session pots never do. Invalid amounts are fixable, but only when no
  // session breach would deny the retry anyway.
  const retryAllowed = breaches.every((entry) => entry.budget.window.kind === 'duration')

  return {
    blocked: true,
    reason: 'budget_exceeded',
    ...info,
    action: 'budget',
    budgets,
    suggestion,
    retry_allowed: retryAllowed,
  }
}

/**
 * Build feedback when a human denied the composite break-glass ticket for a
 * budget overage (issue #14). Lists every breach the ticket covered.
 */
export function buildBudgetApprovalDeniedFeedback(
  decision: PolicyDecision,
  breaches: readonly BudgetPeekEntry[],
  deniedBy: string,
  denialReason?: string,
): BudgetApprovalDeniedFeedback {
  const info = ruleInfo(decision.matchedRule)
  const names = breaches.map((b) => `"${b.budget.name}"`).join(', ')

  return {
    blocked: true,
    reason: 'budget_exceeded',
    ...info,
    action: 'budget',
    denied_by: deniedBy,
    denial_reason: denialReason ?? null,
    budgets: breaches.map(breachBlock),
    suggestion:
      `The budget overage on ${names} was denied by ${deniedBy}.` +
      `${denialReason ? ` Reason: ${denialReason}.` : ''} ` +
      'Wait for the window to reset, reduce the amount, or contact them for details.',
    retry_allowed: false,
  }
}

/**
 * Build feedback when the composite break-glass ticket timed out (issue #14).
 * Budget tickets always fail closed on timeout — `default_on_timeout: allow`
 * never applies to money gates — but a retry re-raises a fresh ticket.
 */
export function buildBudgetApprovalTimeoutFeedback(
  decision: PolicyDecision,
  breaches: readonly BudgetPeekEntry[],
  timeoutMs: number,
): BudgetApprovalTimeoutFeedback {
  const info = ruleInfo(decision.matchedRule)
  const timeoutSeconds = Math.round(timeoutMs / 1_000)
  const names = breaches.map((b) => `"${b.budget.name}"`).join(', ')

  return {
    blocked: true,
    reason: 'budget_exceeded',
    ...info,
    action: 'budget',
    timeout_seconds: timeoutSeconds,
    budgets: breaches.map(breachBlock),
    suggestion:
      `The break-glass request for ${names} timed out after ${String(timeoutSeconds)}s ` +
      '(budget approvals never fail open). Try again or contact an approver directly.',
    retry_allowed: true,
  }
}
