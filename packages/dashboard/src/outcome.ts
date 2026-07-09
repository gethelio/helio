// ---------------------------------------------------------------------------
// Outcome helpers for rendering and filtering audit/feed decisions.
// ---------------------------------------------------------------------------

export type DisplayOutcome =
  | 'allow'
  | 'deny'
  | 'rejected'
  | 'approval_denied'
  | 'approval_timeout'
  | 'client_disconnected'
  | 'shutdown_cancelled'
  | 'rate_limited'
  | 'spend_limited'
  | 'budget_exceeded'
  | 'dry_run'

export type OutcomeFilterValue = Exclude<DisplayOutcome, never>

export interface DecisionLike {
  readonly policy_decision?: string
  readonly block_reason?: string | null
  readonly approval_status?: string | null
  readonly dry_run?: boolean
}

export interface AuditOutcomeParams {
  readonly decision?: string
  readonly reason?: string
  readonly blocked?: boolean
  readonly dry_run?: boolean
}

/** Derive the operator-facing outcome from raw audit/action fields. */
export function deriveDisplayOutcome(record: DecisionLike): DisplayOutcome {
  if (record.dry_run) return 'dry_run'

  switch (record.block_reason) {
    case 'rate_limited':
      return 'rate_limited'
    case 'spend_limited':
      return 'spend_limited'
    case 'budget_exceeded':
      // A named-budget denial (issue #14). It usually rides
      // policy_decision "allow" — the rule allowed, the budget gate blocked —
      // so it must be pinned before the policy_decision fallthrough or the
      // dashboard would render a blocked call as Allow.
      return 'budget_exceeded'
    case 'approval_denied':
      return 'approval_denied'
    case 'approval_timeout':
      return 'approval_timeout'
    case 'client_disconnected':
      return 'client_disconnected'
    case 'shutdown_cancelled':
      return 'shutdown_cancelled'
    case 'install_denied':
      // Install-time denial (issue #13). Rendered as a deny; #16 may add a
      // dedicated chip. Pinned here so a blocked install never falls through to
      // "allow" regardless of policy_decision.
      return 'deny'
    case 'missing_tool_name':
      // Nameless tools/call rejection (issue #132). Its own outcome, distinct
      // from a governed deny so an operator can tell a fail-closed structural
      // rejection apart from a rule-matched deny. Pinned before the
      // policy_decision fallthrough.
      return 'rejected'
    default:
      break
  }

  if (record.policy_decision === 'deny') return 'deny'
  return 'allow'
}

/** Format a display outcome into the dashboard badge label. */
export function formatDisplayOutcome(outcome: DisplayOutcome): string {
  switch (outcome) {
    case 'allow':
      return 'Allow'
    case 'deny':
      return 'Deny'
    case 'rejected':
      return 'Rejected'
    case 'approval_denied':
      return 'Approval Denied'
    case 'approval_timeout':
      return 'Approval Timeout'
    case 'client_disconnected':
      return 'Client Disconnected'
    case 'shutdown_cancelled':
      return 'Shutdown Cancelled'
    case 'rate_limited':
      return 'Rate Limited'
    case 'spend_limited':
      return 'Spend Limited'
    case 'budget_exceeded':
      return 'Budget Exceeded'
    case 'dry_run':
      return 'Dry Run'
  }
}

/** Optional context chip for non-obvious allow-paths. */
export function deriveOutcomeContext(record: DecisionLike): string | null {
  if (deriveDisplayOutcome(record) !== 'allow') return null

  if (record.policy_decision === 'rate_limit') return 'Rate Limit Rule'
  if (record.policy_decision === 'spend_limit') return 'Spend Limit Rule'
  if (
    record.policy_decision === 'require_approval' ||
    record.approval_status === 'approved' ||
    record.approval_status === 'break_glass'
  ) {
    return 'Via Approval'
  }
  return null
}

/** Match a record against the selected outcome filter. */
export function matchesOutcomeFilter(
  record: DecisionLike,
  filter: OutcomeFilterValue | null,
): boolean {
  if (!filter) return true
  return deriveDisplayOutcome(record) === filter
}

/** Translate outcome filters into server-side /api/audit query params. */
export function outcomeFilterToAuditParams(filter: OutcomeFilterValue | null): AuditOutcomeParams {
  switch (filter) {
    case 'allow':
      return { blocked: false, dry_run: false }
    case 'deny':
      return { decision: 'deny' }
    case 'rejected':
      return { decision: 'rejected' }
    case 'approval_denied':
      return { reason: 'approval_denied' }
    case 'approval_timeout':
      return { reason: 'approval_timeout' }
    case 'client_disconnected':
      return { reason: 'client_disconnected' }
    case 'shutdown_cancelled':
      return { reason: 'shutdown_cancelled' }
    case 'rate_limited':
      return { reason: 'rate_limited' }
    case 'spend_limited':
      return { reason: 'spend_limited' }
    case 'budget_exceeded':
      return { reason: 'budget_exceeded' }
    case 'dry_run':
      return { dry_run: true }
    default:
      return {}
  }
}
