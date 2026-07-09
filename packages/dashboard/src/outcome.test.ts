import { describe, it, expect } from 'vitest'
import {
  deriveDisplayOutcome,
  deriveOutcomeContext,
  outcomeFilterToAuditParams,
  formatDisplayOutcome,
} from './outcome'
import { DECISION_FILTERS } from './constants'

describe('outcome helpers', () => {
  it('derives allow for non-blocked rate/spend/approval actions', () => {
    expect(
      deriveDisplayOutcome({ policy_decision: 'rate_limit', block_reason: null, dry_run: false }),
    ).toBe('allow')
    expect(
      deriveDisplayOutcome({ policy_decision: 'spend_limit', block_reason: null, dry_run: false }),
    ).toBe('allow')
    expect(
      deriveDisplayOutcome({
        policy_decision: 'require_approval',
        approval_status: 'approved',
        block_reason: null,
        dry_run: false,
      }),
    ).toBe('allow')
  })

  it('derives explicit blocked outcomes from block_reason', () => {
    expect(deriveDisplayOutcome({ block_reason: 'rate_limited' })).toBe('rate_limited')
    expect(deriveDisplayOutcome({ block_reason: 'spend_limited' })).toBe('spend_limited')
    expect(deriveDisplayOutcome({ block_reason: 'approval_denied' })).toBe('approval_denied')
    expect(deriveDisplayOutcome({ block_reason: 'approval_timeout' })).toBe('approval_timeout')
    expect(deriveDisplayOutcome({ block_reason: 'client_disconnected' })).toBe(
      'client_disconnected',
    )
    expect(deriveDisplayOutcome({ block_reason: 'shutdown_cancelled' })).toBe('shutdown_cancelled')
  })

  it('renders an install_denied block_reason as deny independent of policy_decision', () => {
    // Belt-and-braces: even if policy_decision is not 'deny', a blocked install
    // must never render as "allow".
    expect(deriveDisplayOutcome({ block_reason: 'install_denied' })).toBe('deny')
  })

  it('renders a nameless-call rejection as its own outcome, distinct from allow and deny', () => {
    expect(
      deriveDisplayOutcome({ policy_decision: 'rejected', block_reason: 'missing_tool_name' }),
    ).toBe('rejected')
  })

  it('derives dry_run with highest priority', () => {
    expect(
      deriveDisplayOutcome({
        policy_decision: 'deny',
        block_reason: 'policy_denied',
        dry_run: true,
      }),
    ).toBe('dry_run')
  })

  it('formats display labels', () => {
    expect(formatDisplayOutcome('approval_timeout')).toBe('Approval Timeout')
    expect(formatDisplayOutcome('client_disconnected')).toBe('Client Disconnected')
    expect(formatDisplayOutcome('shutdown_cancelled')).toBe('Shutdown Cancelled')
    expect(formatDisplayOutcome('rate_limited')).toBe('Rate Limited')
    expect(formatDisplayOutcome('rejected')).toBe('Rejected')
  })

  it('derives context chips for allow-path governance actions', () => {
    expect(deriveOutcomeContext({ policy_decision: 'rate_limit' })).toBe('Rate Limit Rule')
    expect(deriveOutcomeContext({ policy_decision: 'spend_limit' })).toBe('Spend Limit Rule')
    expect(
      deriveOutcomeContext({ policy_decision: 'require_approval', approval_status: 'approved' }),
    ).toBe('Via Approval')
  })

  it('maps outcome filters to audit API params', () => {
    expect(outcomeFilterToAuditParams('allow')).toEqual({ blocked: false, dry_run: false })
    expect(outcomeFilterToAuditParams('deny')).toEqual({ decision: 'deny' })
    expect(outcomeFilterToAuditParams('approval_denied')).toEqual({ reason: 'approval_denied' })
    expect(outcomeFilterToAuditParams('client_disconnected')).toEqual({
      reason: 'client_disconnected',
    })
    expect(outcomeFilterToAuditParams('shutdown_cancelled')).toEqual({
      reason: 'shutdown_cancelled',
    })
    expect(outcomeFilterToAuditParams('dry_run')).toEqual({ dry_run: true })
    expect(outcomeFilterToAuditParams('rejected')).toEqual({ decision: 'rejected' })
  })
})

// ---------------------------------------------------------------------------
// budget_exceeded (issue #14)
// ---------------------------------------------------------------------------

describe('budget_exceeded outcome', () => {
  it('renders a budget denial as Budget Exceeded, never Allow', () => {
    // A budget denial rides policy_decision "allow" (the rule allowed; the
    // budget gate blocked) — the block_reason must win over the fallthrough.
    const outcome = deriveDisplayOutcome({
      policy_decision: 'allow',
      block_reason: 'budget_exceeded',
    })
    expect(outcome).toBe('budget_exceeded')
    expect(formatDisplayOutcome(outcome)).toBe('Budget Exceeded')
  })

  it('maps the budget_exceeded filter to the block-reason query param', () => {
    expect(outcomeFilterToAuditParams('budget_exceeded')).toEqual({
      reason: 'budget_exceeded',
    })
  })

  it('offers Budget Exceeded in the decision filter list', () => {
    expect(DECISION_FILTERS.some((f) => f.value === 'budget_exceeded')).toBe(true)
  })
})
