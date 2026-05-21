// ---------------------------------------------------------------------------
// Outcome helpers for rendering and filtering audit/feed decisions.
// ---------------------------------------------------------------------------

export type DisplayOutcome =
  | 'allow'
  | 'deny'
  | 'approval_denied'
  | 'approval_timeout'
  | 'client_disconnected'
  | 'shutdown_cancelled'
  | 'rate_limited'
  | 'spend_limited'
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
    case 'approval_denied':
      return 'approval_denied'
    case 'approval_timeout':
      return 'approval_timeout'
    case 'client_disconnected':
      return 'client_disconnected'
    case 'shutdown_cancelled':
      return 'shutdown_cancelled'
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
    case 'dry_run':
      return { dry_run: true }
    default:
      return {}
  }
}
