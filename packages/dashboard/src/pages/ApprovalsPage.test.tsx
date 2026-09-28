import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

  it('renders upstream and the session source on an expanded ticket (issues #292/#251)', async () => {
    const namedTicket: ApprovalTicket = {
      ...pendingTicket,
      upstream: 'github',
      session_source: 'header',
    }
    mockFetchApprovals.mockResolvedValue({
      data: [namedTicket],
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
      expect(screen.getByText('Upstream')).toBeTruthy()
      expect(screen.getAllByText('github').length).toBeGreaterThanOrEqual(1)
      expect(document.body.textContent).toContain('sess-abc (header)')
    })
  })

  it('renders no Upstream row for a ticket without one (issue #292 darkness pin)', async () => {
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
    fireEvent.click(screen.getByText('delete_record'))

    await waitFor(() => {
      expect(screen.getByText('Session ID')).toBeTruthy()
    })
    expect(screen.queryByText('Upstream')).toBeNull()
    expect(document.body.textContent).not.toContain('(header)')
  })

  it('renders breached budget context on a pending break-glass ticket (issue #14)', async () => {
    const breakGlassTicket: ApprovalTicket = {
      ...pendingTicket,
      id: 'ticket-bg',
      tool_name: 'stripe_charge',
      breached_budgets: [
        {
          name: 'daily-cap',
          limit: 50,
          spent: 49.1,
          attempted_amount: 5,
          currency: 'USD',
          window: '24h',
        },
      ],
    }
    mockFetchApprovals.mockImplementation((status: unknown) =>
      Promise.resolve(
        status === 'pending'
          ? { data: [breakGlassTicket], total: 1, limit: 1000, offset: 0 }
          : { data: [], total: 0, limit: 1000, offset: 0 },
      ),
    )
    renderPage()

    await waitFor(() => {
      expect(screen.getByText('stripe_charge')).toBeTruthy()
    })
    fireEvent.click(screen.getByText('stripe_charge'))

    await waitFor(() => {
      // The approver must see WHAT they are approving past its limit.
      expect(screen.getByText('Breached Budgets')).toBeTruthy()
      expect(screen.getByText(/daily-cap/)).toBeTruthy()
      expect(document.body.textContent).toContain('49.1')
      expect(document.body.textContent).toContain('50')
      expect(document.body.textContent).toContain('USD')
      expect(document.body.textContent).toContain('+5')
    })
  })

  // -------------------------------------------------------------------------
  // definition drift context (issue #60)
  // -------------------------------------------------------------------------

  const driftChanges = [
    {
      aspect: 'annotations',
      baseline: { destructiveHint: false },
      current: { destructiveHint: true },
    },
    { aspect: 'description', baseline: 'Send an email', current: 'Send and delete the draft' },
  ]

  /** A 30-property schema whose pretty form runs past 4,096 characters. */
  function bigSchema(extra?: Record<string, unknown>) {
    const properties: Record<string, unknown> = {}
    for (let i = 0; i < 30; i += 1) {
      properties[`field_${String(i).padStart(2, '0')}`] = {
        type: 'string',
        description: `Field number ${String(i)} of the schema, described at some length for size.`,
        minLength: 1,
        maxLength: 256,
      }
    }
    return { type: 'object', properties: { ...properties, ...extra }, required: ['field_00'] }
  }

  async function expandPending(ticket: ApprovalTicket) {
    mockFetchApprovals.mockImplementation((status: unknown) =>
      Promise.resolve(
        status === 'pending'
          ? { data: [ticket], total: 1, limit: 1000, offset: 0 }
          : { data: [], total: 0, limit: 1000, offset: 0 },
      ),
    )
    renderPage()
    await waitFor(() => {
      expect(screen.getByText(ticket.tool_name)).toBeTruthy()
    })
    fireEvent.click(screen.getByText(ticket.tool_name))
  }

  const preTexts = () => Array.from(document.querySelectorAll('pre')).map((el) => el.textContent)

  it('renders the drift section on a pending drifted ticket (issue #60)', async () => {
    await expandPending({
      ...pendingTicket,
      id: 'ticket-drift',
      tool_name: 'send_email',
      matched_rule: null,
      tool_drift: { changes: driftChanges, mode: 'require_approval' },
    })

    await waitFor(() => {
      expect(screen.getByText('Definition Drift')).toBeTruthy()
    })
    expect(screen.getAllByText('annotations').length).toBeGreaterThan(0)
    expect(screen.getAllByText('description').length).toBeGreaterThan(0)
    const text = document.body.textContent
    expect(text).toContain(`${String('{"destructiveHint":false}'.length)} B`)
    expect(text).toContain(`${String('"Send and delete the draft"'.length)} B`)
    expect(preTexts().join('\n')).toContain('"destructiveHint": true')
    expect(preTexts().join('\n')).toContain('"Send and delete the draft"')
    expect(text).toContain(
      "The tool's definition changed after Helio baselined it and this hold is that drift",
    )
  })

  it('renders the drift section on a resolved drifted ticket (issue #60)', async () => {
    const resolvedTicket: ApprovalTicket = {
      ...pendingTicket,
      id: 'ticket-drift-resolved',
      tool_name: 'send_email',
      status: 'approved',
      resolved_at: new Date().toISOString(),
      resolved_by: 'alice',
      tool_drift: { changes: driftChanges, mode: 'log' },
    }
    mockFetchApprovals.mockImplementation((status: unknown) =>
      Promise.resolve(
        status === 'pending'
          ? { data: [], total: 0, limit: 1000, offset: 0 }
          : { data: [resolvedTicket], total: 1, limit: 1000, offset: 0 },
      ),
    )
    renderPage()
    await waitFor(() => {
      expect(screen.getByText(/Resolved/)).toBeTruthy()
    })
    fireEvent.click(screen.getByText(/Resolved/))
    await waitFor(() => {
      expect(screen.getByText('send_email')).toBeTruthy()
    })
    fireEvent.click(screen.getByText('send_email'))

    await waitFor(() => {
      expect(screen.getByText('Definition Drift')).toBeTruthy()
    })
    expect(preTexts().join('\n')).toContain('"Send an email"')
    expect(document.body.textContent).toContain(
      'this hold is the rule on the Matched Rule line, the drift is context',
    )
  })

  it('opens both panes at the same character when the difference sits past the cap (issue #60)', async () => {
    const baseline = bigSchema()
    const current = bigSchema({ force_delete: { type: 'boolean' } })
    expect(JSON.stringify(baseline, null, 2).length).toBeGreaterThan(4_096)
    await expandPending({
      ...pendingTicket,
      id: 'ticket-schema',
      tool_name: 'delete_record',
      tool_drift: { changes: [{ aspect: 'inputSchema', baseline, current }], mode: 'log' },
    })

    await waitFor(() => {
      expect(screen.getByText('Definition Drift')).toBeTruthy()
    })
    const text = document.body.textContent
    expect(text).toMatch(/the first difference is at character \d+/)
    const panes = preTexts().filter((t) => t.startsWith('\u2026'))
    expect(panes).toHaveLength(2)
    expect(panes[0]?.slice(0, 40)).toBe(panes[1]?.slice(0, 40))
    expect(panes[1]).toContain('force_delete')
    expect(panes[0]).not.toContain('force_delete')
  })

  it('renders an absent side as absent and a null side as null without throwing (issue #60)', async () => {
    // A fetched change with no `current` key and one with an in-memory undefined baseline.
    const fetched = JSON.parse(
      JSON.stringify({ aspect: 'description', baseline: 'was' }),
    ) as Record<string, unknown>
    await expandPending({
      ...pendingTicket,
      id: 'ticket-absent',
      tool_name: 'delete_record',
      tool_drift: {
        changes: [
          { aspect: 'inputSchema', baseline: undefined, current: { type: 'object' } },
          fetched as { aspect: string },
          { aspect: 'title', baseline: null, current: 'now' },
        ],
        mode: 'log',
      },
    })

    await waitFor(() => {
      expect(screen.getByText('Definition Drift')).toBeTruthy()
    })
    expect(screen.getAllByText(/^(Baseline|Current): absent$/)).toHaveLength(2)
    expect(preTexts()).toContain('null')
    expect(preTexts().join('\n')).toContain('"was"')
  })

  it('captions the hold from the ticket fields on every shape (issue #60)', async () => {
    const breached = [
      { name: 'small', limit: 10, spent: 0, attempted_amount: 20, currency: 'USD', window: '24h' },
    ]
    const base = {
      ...pendingTicket,
      tool_name: 'stripe_charge',
      matched_rule: null,
      tool_drift: { changes: driftChanges, mode: 'log' as const },
    }
    const shapes: Array<{ ticket: ApprovalTicket; caption: string }> = [
      {
        ticket: { ...base, id: 's1', breached_budgets: breached, matched_rule: 'allow-pay' },
        caption: 'this hold is the overage in Breached Budgets, the drift is context',
      },
      {
        ticket: {
          ...base,
          id: 's2',
          breached_budgets: breached,
          tool_drift: { changes: driftChanges, mode: 'require_approval' },
        },
        caption: 'this hold is the overage in Breached Budgets, the drift is context',
      },
      {
        ticket: { ...base, id: 's3', matched_rule: 'approve-pay' },
        caption: 'this hold is the rule on the Matched Rule line, the drift is context',
      },
      {
        ticket: {
          ...base,
          id: 's4',
          tool_drift: { changes: driftChanges, mode: 'require_approval' },
        },
        caption:
          "The tool's definition changed after Helio baselined it and this hold is that drift",
      },
      {
        ticket: { ...base, id: 's5' },
        caption: 'this hold is flag_destructive, the drift is context',
      },
      {
        ticket: {
          ...base,
          id: 's6',
          channel_name: 'native:openclaw',
          breached_budgets: breached,
          matched_rule: 'allow-pay',
        },
        caption:
          'this approval covers the overage in Breached Budgets; the Matched Rule line is the rule that matched; the drift is context',
      },
      {
        ticket: {
          ...base,
          id: 's7',
          channel_name: 'native:openclaw',
          breached_budgets: breached,
          tool_drift: { changes: driftChanges, mode: 'require_approval' },
        },
        caption: 'this approval covers the drift and the overage in Breached Budgets',
      },
      {
        ticket: { ...base, id: 's8', channel_name: 'native:openclaw', breached_budgets: breached },
        caption: 'this hold is the overage in Breached Budgets; the drift is context',
      },
    ]
    for (const { ticket, caption } of shapes) {
      await expandPending(ticket)
      await waitFor(() => {
        expect(screen.getByText('Definition Drift')).toBeTruthy()
      })
      expect(document.body.textContent).toContain(caption)
      cleanup()
    }
    // The drift caption ends at the drift: nothing about what approving does next.
    const s4 = shapes[3]?.ticket as ApprovalTicket
    await expandPending(s4)
    await waitFor(() => {
      expect(screen.getByText('Definition Drift')).toBeTruthy()
    })
    expect(document.body.textContent).toMatch(
      /and this hold is that drift\s*(annotations|description)/,
    )
    cleanup()

    // Absent on a plain ticket.
    await expandPending({ ...pendingTicket, id: 'plain', tool_name: 'delete_record' })
    await waitFor(() => {
      expect(screen.getByText('Input')).toBeTruthy()
    })
    expect(screen.queryByText('Definition Drift')).toBeNull()
  })

  it('renders breached budget context on a resolved break-glass ticket (issue #14)', async () => {
    const resolvedTicket: ApprovalTicket = {
      ...pendingTicket,
      id: 'ticket-bg-resolved',
      tool_name: 'stripe_charge',
      status: 'approved',
      resolved_at: new Date().toISOString(),
      resolved_by: 'alice',
      breached_budgets: [
        {
          name: 'weekly-cap',
          limit: 500,
          spent: 498,
          attempted_amount: 12,
          currency: 'EUR',
          window: '7d',
        },
      ],
    }
    mockFetchApprovals.mockImplementation((status: unknown) =>
      Promise.resolve(
        status === 'pending'
          ? { data: [], total: 0, limit: 1000, offset: 0 }
          : { data: [resolvedTicket], total: 1, limit: 1000, offset: 0 },
      ),
    )
    renderPage()

    // The resolved list is lazy-loaded behind its tab.
    await waitFor(() => {
      expect(screen.getByText(/Resolved/)).toBeTruthy()
    })
    fireEvent.click(screen.getByText(/Resolved/))

    await waitFor(() => {
      expect(screen.getByText('stripe_charge')).toBeTruthy()
    })
    fireEvent.click(screen.getByText('stripe_charge'))

    await waitFor(() => {
      expect(screen.getByText('Breached Budgets')).toBeTruthy()
      expect(screen.getByText(/weekly-cap/)).toBeTruthy()
      expect(document.body.textContent).toContain('498')
      expect(document.body.textContent).toContain('EUR')
    })
  })

  it('prints a resolved time in UTC with the zone on the face', async () => {
    const resolvedTicket: ApprovalTicket = {
      ...pendingTicket,
      id: 'ticket-resolved-utc',
      status: 'approved',
      resolved_at: '2026-07-13T12:00:00.000Z',
      resolved_by: 'alice',
    }
    mockFetchApprovals.mockImplementation((status: unknown) =>
      Promise.resolve(
        status === 'pending'
          ? { data: [], total: 0, limit: 1000, offset: 0 }
          : { data: [resolvedTicket], total: 1, limit: 1000, offset: 0 },
      ),
    )
    renderPage()

    await waitFor(() => {
      expect(screen.getByText(/Resolved/)).toBeTruthy()
    })
    fireEvent.click(screen.getByText(/Resolved/))

    await waitFor(() => {
      expect(screen.getByText('2026-07-13 12:00:00 UTC')).toBeTruthy()
    })
  })

  it('renders the Upstream section in an expanded resolved row (issue #297)', async () => {
    const resolvedTicket: ApprovalTicket = {
      ...pendingTicket,
      id: 'ticket-resolved-upstream',
      tool_name: 'stripe_charge',
      status: 'approved',
      resolved_at: new Date().toISOString(),
      resolved_by: 'alice',
      upstream: 'github',
    }
    mockFetchApprovals.mockImplementation((status: unknown) =>
      Promise.resolve(
        status === 'pending'
          ? { data: [], total: 0, limit: 1000, offset: 0 }
          : { data: [resolvedTicket], total: 1, limit: 1000, offset: 0 },
      ),
    )
    renderPage()

    await waitFor(() => {
      expect(screen.getByText(/Resolved/)).toBeTruthy()
    })
    fireEvent.click(screen.getByText(/Resolved/))

    await waitFor(() => {
      expect(screen.getByText('stripe_charge')).toBeTruthy()
    })
    fireEvent.click(screen.getByText('stripe_charge'))

    await waitFor(() => {
      expect(screen.getByText('Upstream')).toBeTruthy()
      expect(screen.getByText('github')).toBeTruthy()
    })
  })

  it('renders no Upstream section in a resolved row without one (issue #297)', async () => {
    const resolvedTicket: ApprovalTicket = {
      ...pendingTicket,
      id: 'ticket-resolved-plain',
      tool_name: 'stripe_charge',
      status: 'approved',
      resolved_at: new Date().toISOString(),
      resolved_by: 'alice',
    }
    mockFetchApprovals.mockImplementation((status: unknown) =>
      Promise.resolve(
        status === 'pending'
          ? { data: [], total: 0, limit: 1000, offset: 0 }
          : { data: [resolvedTicket], total: 1, limit: 1000, offset: 0 },
      ),
    )
    renderPage()

    await waitFor(() => {
      expect(screen.getByText(/Resolved/)).toBeTruthy()
    })
    fireEvent.click(screen.getByText(/Resolved/))

    await waitFor(() => {
      expect(screen.getByText('stripe_charge')).toBeTruthy()
    })
    fireEvent.click(screen.getByText('stripe_charge'))

    await waitFor(() => {
      expect(screen.getByText('Requested At')).toBeTruthy()
    })
    expect(screen.queryByText('Upstream')).toBeNull()
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
