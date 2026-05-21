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
