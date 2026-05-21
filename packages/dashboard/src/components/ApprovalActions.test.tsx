import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { ApprovalActions } from './ApprovalActions'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockApproveTicket = vi.fn()
const mockDenyTicket = vi.fn()
const mockBreakGlassTicket = vi.fn()

vi.mock('../api', () => ({
  approveTicket: (...args: unknown[]): unknown => mockApproveTicket(...args),
  denyTicket: (...args: unknown[]): unknown => mockDenyTicket(...args),
  breakGlassTicket: (...args: unknown[]): unknown => mockBreakGlassTicket(...args),
}))

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function renderActions(element: ReactElement) {
  return render(element)
}

beforeEach(() => {
  mockApproveTicket.mockReset()
  mockDenyTicket.mockReset()
  mockBreakGlassTicket.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ApprovalActions', () => {
  it('renders nothing when status is not pending', () => {
    const { container } = renderActions(
      <ApprovalActions ticketId="t-1" status="approved" onResolved={vi.fn()} />,
    )
    expect(container.innerHTML).toBe('')
  })

  it('renders Approve, Deny, and Break Glass buttons when pending', () => {
    renderActions(<ApprovalActions ticketId="t-1" status="pending" onResolved={vi.fn()} />)
    expect(screen.getByText('Approve')).toBeTruthy()
    expect(screen.getByText('Deny')).toBeTruthy()
    expect(screen.getByText('Break Glass')).toBeTruthy()
  })

  it('calls approveTicket on Approve click', async () => {
    const onResolved = vi.fn()
    mockApproveTicket.mockResolvedValue(undefined)
    renderActions(<ApprovalActions ticketId="t-1" status="pending" onResolved={onResolved} />)

    fireEvent.click(screen.getByText('Approve'))

    await waitFor(() => {
      expect(mockApproveTicket).toHaveBeenCalledWith('t-1', 'dashboard')
      expect(onResolved).toHaveBeenCalledTimes(1)
    })
  })

  it('does not pass a token argument to approveTicket', async () => {
    const onResolved = vi.fn()
    mockApproveTicket.mockResolvedValue(undefined)
    render(<ApprovalActions ticketId="t-1" status="pending" onResolved={onResolved} />)

    fireEvent.click(screen.getByText('Approve'))

    await waitFor(() => {
      expect(mockApproveTicket).toHaveBeenCalledWith('t-1', 'dashboard')
    })
  })

  it('switches to deny mode with inline form on Deny click', () => {
    renderActions(<ApprovalActions ticketId="t-1" status="pending" onResolved={vi.fn()} />)
    fireEvent.click(screen.getByText('Deny'))
    expect(screen.getByPlaceholderText('Reason (optional)')).toBeTruthy()
    expect(screen.getByText('Confirm Deny')).toBeTruthy()
    expect(screen.getByText('Cancel')).toBeTruthy()
  })

  it('submits deny with optional reason', async () => {
    const onResolved = vi.fn()
    mockDenyTicket.mockResolvedValue(undefined)
    renderActions(<ApprovalActions ticketId="t-1" status="pending" onResolved={onResolved} />)

    fireEvent.click(screen.getByText('Deny'))
    fireEvent.change(screen.getByPlaceholderText('Reason (optional)'), {
      target: { value: 'Not authorized' },
    })
    fireEvent.click(screen.getByText('Confirm Deny'))

    await waitFor(() => {
      expect(mockDenyTicket).toHaveBeenCalledWith('t-1', 'dashboard', 'Not authorized')
      expect(onResolved).toHaveBeenCalledTimes(1)
    })
  })

  it('opens break-glass modal on Break Glass click', () => {
    renderActions(<ApprovalActions ticketId="t-1" status="pending" onResolved={vi.fn()} />)
    fireEvent.click(screen.getByText('Break Glass'))
    expect(screen.getByText('Break-Glass Override')).toBeTruthy()
    expect(screen.getByPlaceholderText('Reason (required)')).toBeTruthy()
  })

  it('requires reason for break-glass and shows validation error', async () => {
    renderActions(<ApprovalActions ticketId="t-1" status="pending" onResolved={vi.fn()} />)
    fireEvent.click(screen.getByText('Break Glass'))
    fireEvent.click(screen.getByText('Override & Approve'))

    await waitFor(() => {
      expect(screen.getByText('A reason is required.')).toBeTruthy()
    })
    expect(mockBreakGlassTicket).not.toHaveBeenCalled()
  })

  it('submits break-glass with reason', async () => {
    const onResolved = vi.fn()
    mockBreakGlassTicket.mockResolvedValue(undefined)
    renderActions(<ApprovalActions ticketId="t-1" status="pending" onResolved={onResolved} />)

    fireEvent.click(screen.getByText('Break Glass'))
    fireEvent.change(screen.getByPlaceholderText('Reason (required)'), {
      target: { value: 'Production emergency' },
    })
    fireEvent.click(screen.getByText('Override & Approve'))

    await waitFor(() => {
      expect(mockBreakGlassTicket).toHaveBeenCalledWith('t-1', 'dashboard', 'Production emergency')
      expect(onResolved).toHaveBeenCalledTimes(1)
    })
  })

  it('shows error message for 409 (already resolved)', async () => {
    const apiError = new Error('Conflict')
    Object.assign(apiError, { status: 409 })
    mockApproveTicket.mockRejectedValue(apiError)

    renderActions(<ApprovalActions ticketId="t-1" status="pending" onResolved={vi.fn()} />)
    fireEvent.click(screen.getByText('Approve'))

    await waitFor(() => {
      expect(screen.getByText('This ticket has already been resolved')).toBeTruthy()
    })
  })

  it('cancels deny mode on Cancel click', () => {
    renderActions(<ApprovalActions ticketId="t-1" status="pending" onResolved={vi.fn()} />)
    fireEvent.click(screen.getByText('Deny'))
    expect(screen.getByText('Confirm Deny')).toBeTruthy()
    fireEvent.click(screen.getByText('Cancel'))
    expect(screen.queryByText('Confirm Deny')).toBeNull()
  })
})
