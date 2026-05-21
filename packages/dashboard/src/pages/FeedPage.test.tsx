import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { FeedPage } from './FeedPage'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockSubscribe = vi.fn(() => vi.fn())

vi.mock('../EventSourceContext', () => ({
  useEventSourceContext: () => ({ connected: true, connectionEpoch: 1, subscribe: mockSubscribe }),
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
          tool_input: {},
          upstream_response: null,
          upstream_error: null,
          upstream_http_status: null,
          upstream_latency_ms: null,
          approved_by: null,
          evidence_chain: null,
          created_at: new Date().toISOString(),
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
