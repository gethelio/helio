import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { ApprovalsPage } from './ApprovalsPage'
import type { ApprovalTicket } from '../types'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockSubscribe = vi.fn(() => vi.fn())

vi.mock('../EventSourceContext', () => ({
  useEventSourceContext: () => ({ connected: true, connectionEpoch: 1, subscribe: mockSubscribe }),
}))

const mockFetchApprovals = vi.fn()
const mockApproveTicket = vi.fn()
const mockDenyTicket = vi.fn()
const mockBreakGlassTicket = vi.fn()

vi.mock('../api', () => ({
  fetchApprovals: (...args: unknown[]): unknown => mockFetchApprovals(...args),
  approveTicket: (...args: unknown[]): unknown => mockApproveTicket(...args),
  denyTicket: (...args: unknown[]): unknown => mockDenyTicket(...args),
  breakGlassTicket: (...args: unknown[]): unknown => mockBreakGlassTicket(...args),
}))

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const pendingTicket: ApprovalTicket = {
  id: 'ticket-1',
  tool_name: 'delete_record',
  tool_input: { id: 'rec-1' },
  matched_rule: 'rule-destructive',
  rule_index: 0,
  channel_name: 'dashboard',
  session_id: 'sess-abc',
  requested_at: new Date().toISOString(),
  timeout_at: new Date(Date.now() + 300_000).toISOString(),
  timeout_ms: 300_000,
  status: 'pending',
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockSubscribe.mockClear()
  mockFetchApprovals.mockReset()
  mockApproveTicket.mockReset()
  mockDenyTicket.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

function renderPage() {
  return render(
    <MemoryRouter>
      <ApprovalsPage />
    </MemoryRouter>,
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ApprovalsPage', () => {
  it('renders pending tickets', async () => {
    mockFetchApprovals.mockResolvedValue({
      data: [pendingTicket],
      total: 1,
      limit: 1000,
      offset: 0,
    })
    renderPage()

    await waitFor(() => {
      expect(screen.getByText('delete_record')).toBeTruthy()
    })
  })

  it('shows empty state when no pending tickets', async () => {
    mockFetchApprovals.mockResolvedValue({ data: [], total: 0, limit: 1000, offset: 0 })
    renderPage()

    await waitFor(() => {
      expect(screen.getByText('No pending approvals')).toBeTruthy()
    })
  })

  it('subscribes to approval_requested, approval_resolved, and notify-failure SSE events', async () => {
    mockFetchApprovals.mockResolvedValue({ data: [], total: 0, limit: 1000, offset: 0 })
    renderPage()

    await waitFor(() => {
      const eventTypes = mockSubscribe.mock.calls.map((c) => (c as unknown[])[0])
      expect(eventTypes).toContain('approval_requested')
      expect(eventTypes).toContain('approval_resolved')
      expect(eventTypes).toContain('approval_notification_failed')
    })
  })

  it('renders countdown for pending ticket', async () => {
    mockFetchApprovals.mockResolvedValue({
      data: [pendingTicket],
      total: 1,
      limit: 1000,
      offset: 0,
    })
    renderPage()

    await waitFor(() => {
      // Should display some countdown text (e.g. "4m 59s" or similar).
      // jsdom always yields a string for document.body.textContent once the
      // component has rendered, so no fallback is needed.
      expect(document.body.textContent).toMatch(/\d+m \d+s/)
    })
  })

  it('shows error state on fetch failure', async () => {
    mockFetchApprovals.mockRejectedValue(new Error('Server down'))
    renderPage()

    await waitFor(() => {
      expect(screen.getByText('Server down')).toBeTruthy()
      expect(screen.getByText('Retry')).toBeTruthy()
    })
  })

  it('shows a warning banner when pending tickets contain notification failures', async () => {
    const ticketWithFailure: ApprovalTicket = {
      ...pendingTicket,
      notification_failures: [
        {
          channel: 'slack',
          phase: 'initial',
          error: 'slack unreachable',
          failed_at: new Date().toISOString(),
        },
      ],
    }
    mockFetchApprovals.mockResolvedValue({
      data: [ticketWithFailure],
      total: 1,
      limit: 1000,
      offset: 0,
    })
    renderPage()

    await waitFor(() => {
      expect(screen.getByText(/Approval notification delivery failures detected/)).toBeTruthy()
      expect(screen.getByText(/Requests stay pending in this queue/)).toBeTruthy()
    })
  })

  it('truncates oversized tool_input payloads in pending detail view', async () => {
    const oversizedPending: ApprovalTicket = {
      ...pendingTicket,
      tool_input: { payload: 'x'.repeat(10_000) },
    }
    mockFetchApprovals.mockResolvedValue({
      data: [oversizedPending],
      total: 1,
      limit: 1000,
      offset: 0,
    })
    renderPage()

    await waitFor(() => {
      expect(screen.getByText('delete_record')).toBeTruthy()
    })

    fireEvent.click(screen.getByText('delete_record'))

    await waitFor(() => {
      expect(screen.getByText('Input payload preview is truncated for readability.')).toBeTruthy()
    })
  })

  it('shows an explicit warning when pending approvals hit pagination safety cap', async () => {
    mockFetchApprovals.mockImplementation((_status?: string, pagination?: { offset?: number }) => {
      const offset = pagination?.offset ?? 0
      return Promise.resolve({
        data: [
          {
            ...pendingTicket,
            id: `ticket-${String(offset)}`,
            tool_name: `delete_record_${String(offset)}`,
          },
        ],
        total: 6_000,
        limit: 250,
        offset,
      })
    })
    renderPage()

    await waitFor(() => {
      expect(screen.getByText(/Showing only the newest 5000 pending approvals/)).toBeTruthy()
      expect(screen.getByText(/Older entries are not loaded in this view/)).toBeTruthy()
    })

    expect(mockFetchApprovals).toHaveBeenCalledTimes(20)
  })
})
