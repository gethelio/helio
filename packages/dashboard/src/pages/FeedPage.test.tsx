import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { FeedPage } from './FeedPage'
import type { ActionEvent, AuditRecord } from '../types'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockSubscribe = vi.fn(() => vi.fn())

// Mutable epoch: the reconnect-backfill tests bump this and rerender so the
// reconnect effect actually runs (a static epoch of 1 never passes the
// `connectionEpoch <= 1` bail in FeedPage).
let mockConnectionEpoch = 1

vi.mock('../EventSourceContext', () => ({
  useEventSourceContext: () => ({
    connected: true,
    connectionEpoch: mockConnectionEpoch,
    subscribe: mockSubscribe,
  }),
}))

const mockFetchFeed = vi.fn()
const mockFetchAuditRecord = vi.fn()

vi.mock('../api', () => ({
  fetchFeed: (...args: unknown[]): unknown => mockFetchFeed(...args),
  fetchAuditRecord: (...args: unknown[]): unknown => mockFetchAuditRecord(...args),
}))

// Mock IntersectionObserver for auto-scroll
class MockIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('IntersectionObserver', MockIntersectionObserver)

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockSubscribe.mockClear()
  mockFetchFeed.mockReset()
  mockConnectionEpoch = 1
})

afterEach(() => {
  vi.restoreAllMocks()
})

function renderFeedPage() {
  return render(
    <MemoryRouter>
      <FeedPage />
    </MemoryRouter>,
  )
}

// ---------------------------------------------------------------------------
// Fixtures (issue #297)
// ---------------------------------------------------------------------------

function feedRecord(overrides: Partial<AuditRecord> = {}): AuditRecord {
  return {
    id: 'rec-1',
    tool_name: 'seed_tool',
    policy_decision: 'allow',
    block_reason: null,
    approval_status: null,
    session_id: null,
    session_source: null,
    protocol_version: null,
    upstream: null,
    agent_id: null,
    timestamp: new Date().toISOString(),
    total_duration_ms: 2,
    approval_wait_ms: 0,
    proxy_compute_ms: 2,
    flagged_destructive: false,
    dry_run: false,
    matched_rule: null,
    matched_rule_index: null,
    environment: null,
    record_kind: 'tool_call',
    origin: 'mcp',
    tool_input: {},
    upstream_response: null,
    upstream_error: null,
    upstream_http_status: null,
    upstream_latency_ms: null,
    approved_by: null,
    evidence_chain: null,
    created_at: new Date().toISOString(),
    metadata: null,
    ...overrides,
  }
}

function actionEvent(overrides: Partial<ActionEvent> = {}): ActionEvent {
  return {
    id: 'evt-1',
    tool_name: 'live_tool',
    policy_decision: 'allow',
    block_reason: null,
    approval_status: null,
    session_id: null,
    session_source: null,
    protocol_version: null,
    upstream: null,
    agent_id: null,
    environment: null,
    timestamp: new Date().toISOString(),
    total_duration_ms: 2,
    approval_wait_ms: 0,
    proxy_compute_ms: 2,
    flagged_destructive: false,
    dry_run: false,
    matched_rule: null,
    matched_rule_index: null,
    record_kind: 'tool_call',
    origin: 'mcp',
    ...overrides,
  }
}

/** The 'action' SSE handler FeedPage registered with the mocked subscribe. */
function actionHandler(): (event: ActionEvent) => void {
  const call = mockSubscribe.mock.calls.find((c) => (c as unknown[])[0] === 'action')
  if (!call) throw new Error('FeedPage did not subscribe to action events')
  return (call as unknown[])[1] as (event: ActionEvent) => void
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FeedPage', () => {
  it('renders feed items from initial fetch', async () => {
    mockFetchFeed.mockResolvedValue({
      data: [
        {
          id: '1',
          tool_name: 'send_email',
          policy_decision: 'allow',
          block_reason: null,
          approval_status: null,
          session_id: null,
          session_source: null,
          protocol_version: null,
          upstream: null,
          agent_id: null,
          timestamp: new Date().toISOString(),
          total_duration_ms: 2,
          approval_wait_ms: 0,
          proxy_compute_ms: 2,
          flagged_destructive: false,
          dry_run: false,
          matched_rule: null,
          matched_rule_index: null,
          environment: null,
          record_kind: 'tool_call',
          origin: 'mcp',
          tool_input: {},
          upstream_response: null,
          upstream_error: null,
          upstream_http_status: null,
          upstream_latency_ms: null,
          approved_by: null,
          evidence_chain: null,
          created_at: new Date().toISOString(),
          metadata: null,
        },
      ],
      total: 1,
      limit: 200,
      offset: 0,
    })

    renderFeedPage()
    await waitFor(() => {
      expect(screen.getByText('send_email')).toBeTruthy()
    })
  })

  it('subscribes to SSE action events', async () => {
    mockFetchFeed.mockResolvedValue({ data: [], total: 0, limit: 200, offset: 0 })
    renderFeedPage()

    await waitFor(() => {
      expect(mockSubscribe).toHaveBeenCalledWith('action', expect.any(Function))
    })
  })

  it('shows empty state when no records', async () => {
    mockFetchFeed.mockResolvedValue({ data: [], total: 0, limit: 200, offset: 0 })
    renderFeedPage()

    await waitFor(() => {
      expect(screen.getByText(/No actions yet/)).toBeTruthy()
    })
  })

  it('renders decision filter pills', async () => {
    mockFetchFeed.mockResolvedValue({ data: [], total: 0, limit: 200, offset: 0 })
    renderFeedPage()

    await waitFor(() => {
      expect(screen.getByText('All')).toBeTruthy()
      expect(screen.getByText('Allow')).toBeTruthy()
      expect(screen.getByText('Deny')).toBeTruthy()
      expect(screen.getByText('Approval Denied')).toBeTruthy()
      expect(screen.getByText('Approval Timeout')).toBeTruthy()
      expect(screen.getByText('Rate Limited')).toBeTruthy()
      expect(screen.getByText('Spend Limited')).toBeTruthy()
      expect(screen.getByText('Dry Run')).toBeTruthy()
    })
  })

  it('renders live/paused toggle', async () => {
    mockFetchFeed.mockResolvedValue({ data: [], total: 0, limit: 200, offset: 0 })
    renderFeedPage()

    await waitFor(() => {
      expect(screen.getByText('Live')).toBeTruthy()
    })
  })

  it('shows error state on fetch failure', async () => {
    mockFetchFeed.mockRejectedValue(new Error('Network error'))
    renderFeedPage()

    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeTruthy()
      expect(screen.getByText('Retry')).toBeTruthy()
    })
  })
})

// ---------------------------------------------------------------------------
// Upstream attribution (issue #297)
// ---------------------------------------------------------------------------

describe('upstream attribution (issue #297)', () => {
  it('renders the door span on a live SSE card from a named ActionEvent', async () => {
    mockFetchFeed.mockResolvedValue({ data: [], total: 0, limit: 200, offset: 0 })
    renderFeedPage()

    await waitFor(() => {
      expect(mockSubscribe).toHaveBeenCalledWith('action', expect.any(Function))
    })
    const handler = actionHandler()
    act(() => {
      handler(actionEvent({ id: 'evt-a', tool_name: 'search', upstream: 'alpha' }))
    })

    await waitFor(() => {
      expect(screen.getByText('search')).toBeTruthy()
      expect(screen.getByText('alpha')).toBeTruthy()
    })
  })

  it('renders no upstream filter control for all-null feed data', async () => {
    mockFetchFeed.mockResolvedValue({
      data: [feedRecord()],
      total: 1,
      limit: 200,
      offset: 0,
    })
    renderFeedPage()

    await waitFor(() => {
      expect(screen.getByText('seed_tool')).toBeTruthy()
    })
    expect(screen.queryByPlaceholderText('Filter by upstream…')).toBeNull()
  })

  it('refetches on filter change, carries the filter across reconnect, and never double-fetches', async () => {
    // The four-step sequence: (1) mount fetches unfiltered; (2) a filter
    // change triggers exactly ONE debounced refetch owned by the load
    // effect; (3) an SSE reconnect backfills with the current filter read
    // through a ref; (4) a second filter change after the reconnect still
    // triggers exactly ONE fetch — an implementation that gives the
    // reconnect effect the filter as a dep fires both effects here and
    // fails the exact call count.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      mockFetchFeed.mockResolvedValue({
        data: [feedRecord({ id: 'rec-a', tool_name: 'seed_tool', upstream: 'alpha' })],
        total: 1,
        limit: 200,
        offset: 0,
      })
      const view = renderFeedPage()

      // Step 1 — mount: one unfiltered fetch.
      await waitFor(() => {
        expect(mockFetchFeed).toHaveBeenCalledTimes(1)
      })
      const mountCallArg = mockFetchFeed.mock.calls[0]?.[0] as { upstream?: string } | undefined
      expect(mountCallArg?.upstream).toBeUndefined()
      await waitFor(() => {
        expect(screen.getByPlaceholderText('Filter by upstream…')).toBeTruthy()
      })

      // Step 2 — set the filter: exactly one debounced refetch with it.
      fireEvent.change(screen.getByPlaceholderText('Filter by upstream…'), {
        target: { value: 'alpha' },
      })
      act(() => {
        vi.advanceTimersByTime(300)
      })
      await waitFor(() => {
        expect(mockFetchFeed).toHaveBeenCalledTimes(2)
      })
      expect(mockFetchFeed).toHaveBeenLastCalledWith(expect.objectContaining({ upstream: 'alpha' }))

      // Live SSE items obey the filter client-side between fetches.
      const handler = actionHandler()
      act(() => {
        handler(actionEvent({ id: 'evt-beta', tool_name: 'beta_tool', upstream: 'beta' }))
        handler(actionEvent({ id: 'evt-alpha', tool_name: 'alpha_tool', upstream: 'alpha' }))
      })
      await waitFor(() => {
        expect(screen.getByText('alpha_tool')).toBeTruthy()
      })
      expect(screen.queryByText('beta_tool')).toBeNull()

      // Step 3 — SSE reconnect: the backfill carries the filter via the ref.
      mockConnectionEpoch = 2
      view.rerender(
        <MemoryRouter>
          <FeedPage />
        </MemoryRouter>,
      )
      await waitFor(() => {
        expect(mockFetchFeed).toHaveBeenCalledTimes(3)
      })
      expect(mockFetchFeed).toHaveBeenLastCalledWith(expect.objectContaining({ upstream: 'alpha' }))

      // Step 4 — change the filter after the reconnect: EXACTLY one more.
      fireEvent.change(screen.getByPlaceholderText('Filter by upstream…'), {
        target: { value: 'beta' },
      })
      act(() => {
        vi.advanceTimersByTime(300)
      })
      await waitFor(() => {
        expect(mockFetchFeed).toHaveBeenCalledTimes(4)
      })
      expect(mockFetchFeed).toHaveBeenLastCalledWith(expect.objectContaining({ upstream: 'beta' }))
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the upstream filter control rendered when it matches zero rows', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      mockFetchFeed
        .mockResolvedValueOnce({
          data: [feedRecord({ id: 'rec-a', upstream: 'alpha' })],
          total: 1,
          limit: 200,
          offset: 0,
        })
        .mockResolvedValue({ data: [], total: 0, limit: 200, offset: 0 })
      renderFeedPage()

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Filter by upstream…')).toBeTruthy()
      })
      fireEvent.change(screen.getByPlaceholderText('Filter by upstream…'), {
        target: { value: 'ghost' },
      })
      act(() => {
        vi.advanceTimersByTime(300)
      })

      // The refetch matched nothing; the control that caused the empty
      // result must stay rendered so the filter can be cleared.
      await waitFor(() => {
        expect(mockFetchFeed).toHaveBeenCalledTimes(2)
      })
      await waitFor(() => {
        expect(screen.queryByText('seed_tool')).toBeNull()
      })
      expect(screen.getByPlaceholderText('Filter by upstream…')).toBeTruthy()
      // A zero-match refetch is a FILTER result, not an empty database —
      // replace-and-reset must not flip the copy to the empty-DB message.
      expect(screen.getByText('No matching actions')).toBeTruthy()
      expect(screen.queryByText('No actions yet')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the loaded feed when a filter refetch fails', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      mockFetchFeed
        .mockResolvedValueOnce({
          data: [feedRecord({ id: 'rec-a', tool_name: 'seed_tool', upstream: 'alpha' })],
          total: 1,
          limit: 200,
          offset: 0,
        })
        .mockRejectedValue(new Error('proxy went away'))
      renderFeedPage()

      await waitFor(() => {
        expect(screen.getByText('seed_tool')).toBeTruthy()
      })
      fireEvent.change(screen.getByPlaceholderText('Filter by upstream…'), {
        target: { value: 'alpha' },
      })
      act(() => {
        vi.advanceTimersByTime(300)
      })
      await waitFor(() => {
        expect(mockFetchFeed).toHaveBeenCalledTimes(2)
      })

      // The refetch failed AFTER a successful load: keep the last good
      // data and the filter control — never the full-page error whose only
      // Retry is a window reload.
      expect(screen.getByText('seed_tool')).toBeTruthy()
      expect(screen.queryByText('Retry')).toBeNull()
      expect(screen.getByPlaceholderText('Filter by upstream…')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('recovers from a failed initial load when the reconnect backfill succeeds', async () => {
    mockFetchFeed.mockRejectedValueOnce(new Error('Network error')).mockResolvedValue({
      data: [feedRecord({ id: 'rec-a', tool_name: 'seed_tool' })],
      total: 1,
      limit: 200,
      offset: 0,
    })
    const view = renderFeedPage()

    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeTruthy()
    })

    mockConnectionEpoch = 2
    view.rerender(
      <MemoryRouter>
        <FeedPage />
      </MemoryRouter>,
    )

    // The backfill replaced the records; a stale error must not pin the
    // operator on the full-page error view.
    await waitFor(() => {
      expect(screen.getByText('seed_tool')).toBeTruthy()
    })
    expect(screen.queryByText('Network error')).toBeNull()
  })
})
