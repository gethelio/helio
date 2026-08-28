import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { LimitsPage } from './LimitsPage'
import { MS_PER_MINUTE, MS_PER_HOUR, MS_PER_DAY } from '../constants'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockSubscribe = vi.fn(() => vi.fn())

vi.mock('../EventSourceContext', () => ({
  useEventSourceContext: () => ({ connected: true, connectionEpoch: 1, subscribe: mockSubscribe }),
}))

const mockFetchLimits = vi.fn()

vi.mock('../api', () => ({
  fetchLimits: (...args: unknown[]): unknown => mockFetchLimits(...args),
}))

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockSubscribe.mockClear()
  mockFetchLimits.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

function renderPage() {
  return render(
    <MemoryRouter>
      <LimitsPage />
    </MemoryRouter>,
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LimitsPage', () => {
  it('renders rate limit cards', async () => {
    mockFetchLimits.mockResolvedValue({
      rate_limits: [
        {
          key: 'tool:send_email',
          current: 50,
          limit: 100,
          window_ms: MS_PER_HOUR,
          reset_at_ms: Date.now() + 30 * MS_PER_MINUTE,
        },
      ],
      spend_limits: [],
    })
    renderPage()

    await waitFor(() => {
      expect(screen.getByText('send_email')).toBeTruthy()
      expect(screen.getByText('50 / 100 calls')).toBeTruthy()
    })
  })

  it('groups upstream-prefixed tool keys under a door heading (issues #294/#297)', async () => {
    mockFetchLimits.mockResolvedValue({
      rate_limits: [
        {
          key: 'upstream:files:tool:send_email',
          current: 1,
          limit: 10,
          window_ms: MS_PER_HOUR,
          reset_at_ms: Date.now() + 30 * MS_PER_MINUTE,
        },
        {
          key: 'upstream:files:tool:send_email:rule:2',
          current: 2,
          limit: 10,
          window_ms: MS_PER_HOUR,
          reset_at_ms: Date.now() + 30 * MS_PER_MINUTE,
        },
        {
          key: 'tool:list_files',
          current: 3,
          limit: 10,
          window_ms: MS_PER_HOUR,
          reset_at_ms: Date.now() + 30 * MS_PER_MINUTE,
        },
      ],
      spend_limits: [],
    })
    renderPage()

    await waitFor(() => {
      // The door section heading owns the qualifier; in-section labels drop
      // the ` (door)` suffix the flat #294 rendering carried.
      expect(screen.getByRole('heading', { name: 'files' })).toBeTruthy()
      expect(screen.getByText('send_email')).toBeTruthy()
      expect(screen.getByText('send_email:rule:2')).toBeTruthy()
      // Singular keys keep today's first-colon split byte-identically.
      expect(screen.getByText('list_files')).toBeTruthy()
      // All three render as TOOL rows — the door prefix is a qualifier, not
      // a type of its own.
      expect(screen.getAllByText('tool')).toHaveLength(3)
    })
  })

  it('groups prefixed keys into sorted door sections with the base block first (issue #297)', async () => {
    mockFetchLimits.mockResolvedValue({
      rate_limits: [
        {
          key: 'upstream:beta:tool:search:rule:0',
          current: 2,
          limit: 10,
          window_ms: MS_PER_HOUR,
          reset_at_ms: Date.now() + 30 * MS_PER_MINUTE,
        },
        {
          key: 'upstream:alpha:tool:search:rule:0',
          current: 1,
          limit: 10,
          window_ms: MS_PER_HOUR,
          reset_at_ms: Date.now() + 30 * MS_PER_MINUTE,
        },
        {
          key: 'tool:fetch:rule:1',
          current: 3,
          limit: 10,
          window_ms: MS_PER_HOUR,
          reset_at_ms: Date.now() + 30 * MS_PER_MINUTE,
        },
        {
          key: 'session:abc-123:rule:2',
          current: 4,
          limit: 10,
          window_ms: MS_PER_HOUR,
          reset_at_ms: Date.now() + 30 * MS_PER_MINUTE,
        },
      ],
      spend_limits: [],
    })
    renderPage()

    await waitFor(() => {
      // EXACT heading-role queries: a substring text query would vacuously
      // match the pre-#297 flat card label `search:rule:0 (alpha)`.
      expect(screen.getByRole('heading', { name: 'alpha' })).toBeTruthy()
      expect(screen.getByRole('heading', { name: 'beta' })).toBeTruthy()
    })
    // In-section labels drop the ` (door)` suffix; the `:rule:<n>` suffix
    // keeps rendering exactly as today.
    expect(screen.getAllByText('search:rule:0')).toHaveLength(2)
    expect(screen.queryByText('search:rule:0 (alpha)')).toBeNull()
    // Base block: singular tool and session keys render first, unchanged,
    // and session keys never get a door invented for them.
    expect(screen.getByText('fetch:rule:1')).toBeTruthy()
    expect(screen.getByText('abc-123:rule:2')).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'session' })).toBeNull()
    const baseCard = screen.getByText('fetch:rule:1')
    const alphaHeading = screen.getByRole('heading', { name: 'alpha' })
    expect(
      baseCard.compareDocumentPosition(alphaHeading) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('renders zero door headings for singular keys (issue #297)', async () => {
    mockFetchLimits.mockResolvedValue({
      rate_limits: [
        {
          key: 'tool:send_email',
          current: 50,
          limit: 100,
          window_ms: MS_PER_HOUR,
          reset_at_ms: Date.now() + 30 * MS_PER_MINUTE,
        },
      ],
      spend_limits: [
        {
          key: 'session:abc:rule:1',
          current_spend: 80,
          limit: 200,
          currency: 'USD',
          window_ms: MS_PER_DAY,
          reset_at_ms: Date.now() + 12 * MS_PER_HOUR,
        },
      ],
    })
    renderPage()

    await waitFor(() => {
      expect(screen.getByText('send_email')).toBeTruthy()
    })
    const headings = screen.getAllByRole('heading').map((h) => h.textContent)
    expect(headings).toEqual(['Rate & Spend Limits', 'Rate Limits', 'Spend Limits'])
  })

  it('renders spend limit cards', async () => {
    mockFetchLimits.mockResolvedValue({
      rate_limits: [],
      spend_limits: [
        {
          key: 'tool:create_payment',
          current_spend: 80,
          limit: 200,
          currency: 'USD',
          window_ms: MS_PER_DAY,
          reset_at_ms: Date.now() + 12 * MS_PER_HOUR,
        },
      ],
    })
    renderPage()

    await waitFor(() => {
      expect(screen.getByText('create_payment')).toBeTruthy()
    })
  })

  it('progress bar width matches usage ratio', async () => {
    mockFetchLimits.mockResolvedValue({
      rate_limits: [
        {
          key: 'tool:test',
          current: 50,
          limit: 100,
          window_ms: MS_PER_HOUR,
          reset_at_ms: Date.now() + 30 * MS_PER_MINUTE,
        },
      ],
      spend_limits: [],
    })
    const { container } = renderPage()

    await waitFor(() => {
      // Find the progress bar inner div (has width style)
      const bars = container.querySelectorAll('[style*="width"]')
      const bar = Array.from(bars).find((el) => el.className.includes('rounded-full'))
      expect(bar).toBeTruthy()
      expect(bar?.getAttribute('style')).toContain('50%')
    })
  })

  it('uses green color for low usage (<80%)', async () => {
    mockFetchLimits.mockResolvedValue({
      rate_limits: [
        {
          key: 'tool:test',
          current: 30,
          limit: 100,
          window_ms: MS_PER_HOUR,
          reset_at_ms: Date.now() + 30 * MS_PER_MINUTE,
        },
      ],
      spend_limits: [],
    })
    const { container } = renderPage()

    await waitFor(() => {
      const bars = container.querySelectorAll('.bg-emerald-500')
      expect(bars.length).toBeGreaterThan(0)
    })
  })

  it('uses amber color for high usage (>=80%)', async () => {
    mockFetchLimits.mockResolvedValue({
      rate_limits: [
        {
          key: 'tool:test',
          current: 85,
          limit: 100,
          window_ms: MS_PER_HOUR,
          reset_at_ms: Date.now() + 30 * MS_PER_MINUTE,
        },
      ],
      spend_limits: [],
    })
    const { container } = renderPage()

    await waitFor(() => {
      const bars = container.querySelectorAll('.bg-amber-500')
      expect(bars.length).toBeGreaterThan(0)
    })
  })

  it('uses red color for exceeded limit (>=100%)', async () => {
    mockFetchLimits.mockResolvedValue({
      rate_limits: [
        {
          key: 'tool:test',
          current: 100,
          limit: 100,
          window_ms: MS_PER_HOUR,
          reset_at_ms: Date.now() + 30 * MS_PER_MINUTE,
        },
      ],
      spend_limits: [],
    })
    const { container } = renderPage()

    await waitFor(() => {
      const bars = container.querySelectorAll('.bg-red-500')
      expect(bars.length).toBeGreaterThan(0)
    })
  })

  it('shows empty state when no limits configured', async () => {
    mockFetchLimits.mockResolvedValue({ rate_limits: [], spend_limits: [] })
    renderPage()

    await waitFor(() => {
      expect(screen.getByText('No active limits configured')).toBeTruthy()
    })
  })

  it('subscribes to limit_warning SSE events', async () => {
    mockFetchLimits.mockResolvedValue({ rate_limits: [], spend_limits: [] })
    renderPage()

    await waitFor(() => {
      const eventTypes = mockSubscribe.mock.calls.map((c) => (c as unknown[])[0])
      expect(eventTypes).toContain('limit_warning')
    })
  })

  it('shows error state on fetch failure', async () => {
    mockFetchLimits.mockRejectedValue(new Error('Connection refused'))
    renderPage()

    await waitFor(() => {
      expect(screen.getByText('Connection refused')).toBeTruthy()
      expect(screen.getByText('Retry')).toBeTruthy()
    })
  })

  it('recovers from transient initial failure on the next poll', async () => {
    const intervalCallbacks: Array<() => void> = []
    const setIntervalSpy = vi
      .spyOn(global, 'setInterval')
      .mockImplementation((callback: TimerHandler): ReturnType<typeof setInterval> => {
        if (typeof callback === 'function') {
          intervalCallbacks.push(callback as () => void)
        }
        return 1 as unknown as ReturnType<typeof setInterval>
      })
    mockFetchLimits.mockRejectedValueOnce(new Error('Connection refused')).mockResolvedValue({
      rate_limits: [
        {
          key: 'tool:send_email',
          current: 1,
          limit: 100,
          window_ms: MS_PER_HOUR,
          reset_at_ms: Date.now() + 30 * MS_PER_MINUTE,
        },
      ],
      spend_limits: [],
    })
    renderPage()

    await waitFor(() => {
      expect(screen.getByText('Connection refused')).toBeTruthy()
    })

    act(() => {
      intervalCallbacks[0]?.()
    })

    await waitFor(() => {
      expect(screen.getByText('send_email')).toBeTruthy()
      expect(screen.queryByText('Connection refused')).toBeNull()
    })
    setIntervalSpy.mockRestore()
  })
})
