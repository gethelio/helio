import { describe, it, expect } from 'vitest'
import {
  deriveDisplayOutcome,
  deriveOutcomeContext,
  outcomeFilterToAuditParams,
  formatDisplayOutcome,
} from './outcome'

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
  })
})
