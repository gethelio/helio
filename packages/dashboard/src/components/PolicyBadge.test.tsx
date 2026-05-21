import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PolicyBadge } from './PolicyBadge'

describe('PolicyBadge', () => {
  it.each([
    [{ policyDecision: 'allow' }, 'Allow', 'bg-emerald-50'],
    [{ policyDecision: 'deny' }, 'Deny', 'bg-red-50'],
    [
      { policyDecision: 'require_approval', blockReason: 'approval_denied' },
      'Approval Denied',
      'bg-red-50',
    ],
    [
      { policyDecision: 'require_approval', blockReason: 'approval_timeout' },
      'Approval Timeout',
      'bg-amber-50',
    ],
    [
      { policyDecision: 'require_approval', blockReason: 'client_disconnected' },
      'Client Disconnected',
      'bg-gray-100',
    ],
    [
      { policyDecision: 'require_approval', blockReason: 'shutdown_cancelled' },
      'Shutdown Cancelled',
      'bg-slate-100',
    ],
    [{ policyDecision: 'rate_limit', blockReason: 'rate_limited' }, 'Rate Limited', 'bg-orange-50'],
    [
      { policyDecision: 'spend_limit', blockReason: 'spend_limited' },
      'Spend Limited',
      'bg-purple-50',
    ],
    [{ policyDecision: 'allow', dryRun: true }, 'Dry Run', 'bg-blue-50'],
  ])('renders outcome badge with correct color class', (props, label, expectedClass) => {
    render(<PolicyBadge {...props} />)
    const badge = screen.getByText(label)
    expect(badge.className).toContain(expectedClass)
  })

  it('shows a context chip for allow via rate-limit rule', () => {
    render(<PolicyBadge policyDecision="rate_limit" blockReason={null} showContext={true} />)
    expect(screen.getByText('Allow')).toBeTruthy()
    expect(screen.getByText('Rate Limit Rule')).toBeTruthy()
  })

  it('shows a context chip for allow via approval', () => {
    render(
      <PolicyBadge
        policyDecision="require_approval"
        approvalStatus="approved"
        blockReason={null}
        showContext={true}
      />,
    )
    expect(screen.getByText('Allow')).toBeTruthy()
    expect(screen.getByText('Via Approval')).toBeTruthy()
  })
})
