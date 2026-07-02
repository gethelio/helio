import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { EvidenceChain } from './EvidenceChain'

describe('EvidenceChain', () => {
  it('renders nothing when chain is null', () => {
    const { container } = render(<EvidenceChain chain={null} />)
    expect(container.innerHTML).toBe('')
  })

  it('renders nothing when chain has no recognized sections', () => {
    const { container } = render(<EvidenceChain chain={{ unknown: 'data' }} />)
    expect(container.innerHTML).toBe('')
  })

  it('renders found evidence keys with green text', () => {
    const chain = {
      evidence: { required: ['orders.lookup'], found: ['orders.lookup'], missing: [], expired: [] },
    }
    render(<EvidenceChain chain={chain} />)
    expect(screen.getByText('orders.lookup')).toBeTruthy()
    expect(screen.getByText('orders.lookup').className).toContain('text-emerald-700')
  })

  it('renders missing evidence keys with red text', () => {
    const chain = {
      evidence: { required: ['orders.lookup'], found: [], missing: ['orders.lookup'], expired: [] },
    }
    render(<EvidenceChain chain={chain} />)
    expect(screen.getByText('orders.lookup').className).toContain('text-red-700')
  })

  it('renders expired evidence keys with amber text', () => {
    const chain = {
      evidence: { required: ['orders.lookup'], found: [], missing: [], expired: ['orders.lookup'] },
    }
    render(<EvidenceChain chain={chain} />)
    expect(screen.getByText('orders.lookup').className).toContain('text-amber-600')
  })

  it('renders dependencies satisfied message', () => {
    const chain = { dependencies: { satisfied: true, missing: [] } }
    render(<EvidenceChain chain={chain} />)
    expect(screen.getByText('All dependencies satisfied')).toBeTruthy()
  })

  it('renders missing dependencies list', () => {
    const chain = { dependencies: { satisfied: false, missing: ['auth.verify', 'orders.lookup'] } }
    render(<EvidenceChain chain={chain} />)
    expect(screen.getByText('auth.verify')).toBeTruthy()
    expect(screen.getByText('orders.lookup')).toBeTruthy()
  })

  it('renders rate limit progress bar with usage', () => {
    const chain = { rate_limit: { allowed: true, current: 50, limit: 100 } }
    render(<EvidenceChain chain={chain} />)
    expect(screen.getByText('Rate Limit')).toBeTruthy()
    expect(screen.getByText('50 / 100 calls')).toBeTruthy()
  })

  it('renders spend limit progress bar', () => {
    const chain = { spend_limit: { allowed: true, current_spend: 250, limit: 5000 } }
    render(<EvidenceChain chain={chain} />)
    expect(screen.getByText('Spend Limit')).toBeTruthy()
    expect(screen.getByText('250 / 5000')).toBeTruthy()
  })

  it('renders break-glass section with reason', () => {
    const chain = { break_glass: { reason: 'Production emergency', invoked_by: 'admin' } }
    render(<EvidenceChain chain={chain} />)
    expect(screen.getByText('Break-Glass Override')).toBeTruthy()
    expect(screen.getByText('Production emergency')).toBeTruthy()
    expect(screen.getByText('admin')).toBeTruthy()
  })

  it('renders approval context with denial reason and ticket id', () => {
    const chain = { approval: { ticket_id: 'abc-123', denial_reason: 'Too risky' } }
    render(<EvidenceChain chain={chain} />)
    expect(screen.getByText('Approval')).toBeTruthy()
    expect(screen.getByText('Too risky')).toBeTruthy()
    expect(screen.getByText(/abc-123/)).toBeTruthy()
  })

  it('renders approval escalation timestamp and targets', () => {
    const chain = {
      approval: {
        ticket_id: 'abc-123',
        escalated_at: '2026-07-02T15:03:34.869Z',
        escalated_to: ['hooks', 'dashboard'],
      },
    }
    render(<EvidenceChain chain={chain} />)
    expect(screen.getByText('Approval')).toBeTruthy()
    expect(screen.getByText(/2026-07-02T15:03:34\.869Z/)).toBeTruthy()
    expect(screen.getByText(/hooks, dashboard/)).toBeTruthy()
  })

  it('ignores a malformed approval block', () => {
    const chain = { approval: { ticket_id: 42, escalated_to: 'oops' } }
    const { container } = render(<EvidenceChain chain={chain} />)
    expect(container.innerHTML).toBe('')
  })

  it('applies correct progress bar color based on usage', () => {
    // High usage (100%) should get red
    const chain = { rate_limit: { allowed: false, current: 100, limit: 100 } }
    const { container } = render(<EvidenceChain chain={chain} />)
    const bars = container.querySelectorAll('[style*="width"]')
    const progressBar = Array.from(bars).find((el) => el.className.includes('rounded-full'))
    expect(progressBar?.className).toContain('bg-red-500')
  })
})
