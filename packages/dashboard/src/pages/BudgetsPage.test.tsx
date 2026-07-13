import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { BudgetsPage } from './BudgetsPage'
import type { BudgetEventRecord, BudgetState } from '../types'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockSubscribe = vi.fn(() => vi.fn())

vi.mock('../EventSourceContext', () => ({
  useEventSourceContext: () => ({ connected: true, connectionEpoch: 1, subscribe: mockSubscribe }),
}))

const mockFetchBudgets = vi.fn()
const mockFetchBudgetEvents = vi.fn()

vi.mock('../api', () => ({
  fetchBudgets: (...args: unknown[]): unknown => mockFetchBudgets(...args),
  fetchBudgetEvents: (...args: unknown[]): unknown => mockFetchBudgetEvents(...args),
}))

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function budgetState(overrides: Partial<BudgetState> = {}): BudgetState {
  return {
    name: 'daily-cap',
    limit: 100,
    currency: 'USD',
    window: '24h',
    key: 'global',
    on_exceed: 'deny',
    buckets: [
      {
        bucket_key: 'budget:daily-cap:global',
        spent: 40,
        remaining: 60,
        reset_at_ms: Date.now() + 60 * 60 * 1_000,
        last_activity_ms: Date.now(),
      },
    ],
    ...overrides,
  }
}

function eventRecord(overrides: Partial<BudgetEventRecord> = {}): BudgetEventRecord {
  return {
    id: 'evt-1',
    budget_name: 'daily-cap',
    bucket_key: 'budget:daily-cap:global',
    kind: 'spend',
    amount: 12.5,
    currency: 'USD',
    tool_name: 'stripe_charge',
    origin: 'mcp',
    audit_record_id: 'audit-1',
    timestamp: '2026-07-13T12:00:00.000Z',
    timestamp_ms: 1_800_000_000_000,
    created_at: '2026-07-13T12:00:00.001Z',
    ...overrides,
  }
}

beforeEach(() => {
  mockSubscribe.mockClear()
  mockFetchBudgets.mockReset()
  mockFetchBudgetEvents.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

function renderPage() {
  return render(
    <MemoryRouter>
      <BudgetsPage />
    </MemoryRouter>,
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BudgetsPage', () => {
  it('renders pot cards with name, window, and per-bucket progress', async () => {
    mockFetchBudgets.mockResolvedValue({ budgets: [budgetState()] })
    renderPage()

    await waitFor(() => {
      expect(screen.getByText('daily-cap')).toBeTruthy()
      expect(screen.getByText('24h')).toBeTruthy()
      expect(screen.getByText(/Resets in/)).toBeTruthy()
    })
  })

  it('progress bar width matches the bucket usage ratio', async () => {
    mockFetchBudgets.mockResolvedValue({ budgets: [budgetState()] })
    const { container } = renderPage()

    await waitFor(() => {
      const bars = container.querySelectorAll('[style*="width"]')
      const bar = Array.from(bars).find((el) => el.className.includes('rounded-full'))
      expect(bar?.getAttribute('style')).toContain('40%')
    })
  })

  it('renders a configured budget with zero live buckets at full headroom', async () => {
    mockFetchBudgets.mockResolvedValue({ budgets: [budgetState({ buckets: [] })] })
    renderPage()

    await waitFor(() => {
      expect(screen.getByText('daily-cap')).toBeTruthy()
      expect(screen.getByText(/No spend yet/)).toBeTruthy()
    })
  })

  it('shows the session-pot line instead of a countdown for session windows', async () => {
    mockFetchBudgets.mockResolvedValue({
      budgets: [
        budgetState({
          name: 'session-cap',
          window: 'session',
          key: 'session',
          buckets: [
            {
              bucket_key: 'budget:session-cap:session:abc',
              spent: 10,
              remaining: 90,
              reset_at_ms: null,
              last_activity_ms: Date.now(),
            },
          ],
        }),
      ],
    })
    renderPage()

    await waitFor(() => {
      expect(screen.getByText(/never replenishes/)).toBeTruthy()
      expect(screen.queryByText(/Resets in/)).toBeNull()
    })
  })

  it('expanding recent events fetches and renders them with kind badges', async () => {
    mockFetchBudgets.mockResolvedValue({ budgets: [budgetState()] })
    mockFetchBudgetEvents.mockResolvedValue({
      data: [
        eventRecord(),
        eventRecord({ id: 'evt-2', kind: 'approved_overage', tool_name: 'paypal_send' }),
      ],
      total: 2,
      limit: 20,
      offset: 0,
    })
    const { container } = renderPage()

    await waitFor(() => {
      expect(screen.getByText('daily-cap')).toBeTruthy()
    })
    expect(mockFetchBudgetEvents).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText(/Recent events/))

    await waitFor(() => {
      expect(mockFetchBudgetEvents).toHaveBeenCalledWith('daily-cap', { limit: 20 })
      expect(screen.getByText('stripe_charge')).toBeTruthy()
      expect(screen.getByText('paypal_send')).toBeTruthy()
      // The overage badge is visually distinct (amber) from the gray spend badge.
      expect(screen.getByText('approved overage')).toBeTruthy()
      expect(container.querySelector('.bg-amber-100')).toBeTruthy()
      expect(screen.getByText('spend')).toBeTruthy()
    })
  })

  it('renders and expands budgets named after Object prototype keys', async () => {
    // "__proto__", "toString", "constructor" are schema-valid budget names.
    // Plain-object panel state would read INHERITED Object properties for
    // them (truthy functions), crashing EventsPanel and jamming the toggle.
    mockFetchBudgets.mockResolvedValue({
      budgets: [
        budgetState({
          name: 'toString',
          buckets: [
            {
              bucket_key: 'budget:toString:global',
              spent: 5,
              remaining: 95,
              reset_at_ms: Date.now() + 60_000,
              last_activity_ms: Date.now(),
            },
          ],
        }),
        budgetState({ name: '__proto__', buckets: [] }),
        budgetState({ name: 'constructor', buckets: [] }),
      ],
    })
    mockFetchBudgetEvents.mockResolvedValue({
      data: [eventRecord({ budget_name: 'toString', tool_name: 'proto_tool' })],
      total: 1,
      limit: 20,
      offset: 0,
    })
    renderPage()

    await waitFor(() => {
      expect(screen.getByText('toString')).toBeTruthy()
      expect(screen.getByText('__proto__')).toBeTruthy()
      expect(screen.getByText('constructor')).toBeTruthy()
    })

    // The toggle must treat these as collapsed (no own entry) and expand.
    fireEvent.click(screen.getAllByText(/Recent events/)[0] as HTMLElement)
    await waitFor(() => {
      expect(mockFetchBudgetEvents).toHaveBeenCalledWith('toString', { limit: 20 })
      expect(screen.getByText('proto_tool')).toBeTruthy()
    })
  })

  it('collapsing an expanded panel hides the events list', async () => {
    mockFetchBudgets.mockResolvedValue({ budgets: [budgetState()] })
    mockFetchBudgetEvents.mockResolvedValue({
      data: [eventRecord()],
      total: 1,
      limit: 20,
      offset: 0,
    })
    renderPage()

    await waitFor(() => {
      expect(screen.getByText('daily-cap')).toBeTruthy()
    })
    fireEvent.click(screen.getByText(/Recent events/))
    await waitFor(() => {
      expect(screen.getByText('stripe_charge')).toBeTruthy()
    })

    fireEvent.click(screen.getByText(/Hide recent events/))
    await waitFor(() => {
      expect(screen.queryByText('stripe_charge')).toBeNull()
      expect(screen.getByText(/Recent events/)).toBeTruthy()
    })
  })

  it('the poll fallback refreshes expanded event panels without any SSE', async () => {
    // Stale-generation commits are ledgered but deliberately emit no SSE
    // event — an open ledger panel must still pick them up on the poll.
    const intervalCallbacks: Array<() => void> = []
    const setIntervalSpy = vi
      .spyOn(global, 'setInterval')
      .mockImplementation((callback: TimerHandler): ReturnType<typeof setInterval> => {
        if (typeof callback === 'function') {
          intervalCallbacks.push(callback as () => void)
        }
        return 1 as unknown as ReturnType<typeof setInterval>
      })
    mockFetchBudgets.mockResolvedValue({ budgets: [budgetState()] })
    mockFetchBudgetEvents.mockResolvedValue({
      data: [eventRecord()],
      total: 1,
      limit: 20,
      offset: 0,
    })
    renderPage()

    await waitFor(() => {
      expect(screen.getByText('daily-cap')).toBeTruthy()
    })
    fireEvent.click(screen.getByText(/Recent events/))
    await waitFor(() => {
      expect(mockFetchBudgetEvents).toHaveBeenCalledTimes(1)
    })

    act(() => {
      for (const callback of intervalCallbacks) callback()
    })

    await waitFor(() => {
      expect(mockFetchBudgetEvents).toHaveBeenCalledTimes(2)
      // Poll-driven refreshes carry the batch's abort signal.
      expect(mockFetchBudgetEvents).toHaveBeenLastCalledWith(
        'daily-cap',
        { limit: 20 },
        { signal: expect.any(AbortSignal) as AbortSignal },
      )
    })
    setIntervalSpy.mockRestore()
  })

  it('an older events success still lands when the newer refresh failed', async () => {
    // Expand (slow request) + SSE refresh (fails fast): the failed refresh
    // applies nothing, so the older success — the panel's ONLY data — must
    // still render.
    mockFetchBudgets.mockResolvedValue({ budgets: [budgetState()] })
    let resolveFirst!: (value: unknown) => void
    let rejectSecond!: (reason: unknown) => void
    mockFetchBudgetEvents
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectSecond = reject
          }),
      )
    renderPage()

    await waitFor(() => {
      expect(screen.getByText('daily-cap')).toBeTruthy()
    })
    fireEvent.click(screen.getByText(/Recent events/))
    await waitFor(() => {
      expect(mockFetchBudgetEvents).toHaveBeenCalledTimes(1)
    })

    const updateCall = mockSubscribe.mock.calls.find(
      (c) => (c as unknown[])[0] === 'budget_update',
    ) as unknown[] | undefined
    const handler = updateCall?.[1] as (event: unknown) => void
    act(() => {
      handler({
        name: 'daily-cap',
        bucket_key: 'budget:daily-cap:global',
        kind: 'spend',
        amount: 5,
        spent: 45,
        remaining: 55,
        limit: 100,
        currency: 'USD',
        utilization: 0.45,
      })
    })
    await waitFor(() => {
      expect(mockFetchBudgetEvents).toHaveBeenCalledTimes(2)
    })

    await act(async () => {
      rejectSecond(new Error('transient blip'))
      await Promise.resolve()
    })
    await act(async () => {
      resolveFirst({
        data: [eventRecord({ tool_name: 'only_data' })],
        total: 1,
        limit: 20,
        offset: 0,
      })
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(screen.getByText('only_data')).toBeTruthy()
    })
  })

  it('a refetch failure keeps already-loaded events visible', async () => {
    mockFetchBudgets.mockResolvedValue({ budgets: [budgetState()] })
    mockFetchBudgetEvents
      .mockResolvedValueOnce({
        data: [eventRecord({ tool_name: 'loaded_row' })],
        total: 1,
        limit: 20,
        offset: 0,
      })
      .mockRejectedValueOnce(new Error('transient blip'))
    renderPage()

    await waitFor(() => {
      expect(screen.getByText('daily-cap')).toBeTruthy()
    })
    fireEvent.click(screen.getByText(/Recent events/))
    await waitFor(() => {
      expect(screen.getByText('loaded_row')).toBeTruthy()
    })

    const updateCall = mockSubscribe.mock.calls.find(
      (c) => (c as unknown[])[0] === 'budget_update',
    ) as unknown[] | undefined
    const handler = updateCall?.[1] as (event: unknown) => void
    act(() => {
      handler({
        name: 'daily-cap',
        bucket_key: 'budget:daily-cap:global',
        kind: 'spend',
        amount: 5,
        spent: 45,
        remaining: 55,
        limit: 100,
        currency: 'USD',
        utilization: 0.45,
      })
    })

    // The failed refetch must not hide the rows behind an error message.
    await waitFor(() => {
      expect(mockFetchBudgetEvents).toHaveBeenCalledTimes(2)
    })
    await waitFor(() => {
      expect(screen.getByText('loaded_row')).toBeTruthy()
      expect(screen.queryByText('transient blip')).toBeNull()
    })
  })

  it('an out-of-order stale events response never overwrites a fresher one', async () => {
    mockFetchBudgets.mockResolvedValue({ budgets: [budgetState()] })

    // Two in-flight requests resolving out of order: the FIRST (stale)
    // resolves after the SECOND (fresh). The panel must keep the fresh page.
    let resolveFirst!: (value: unknown) => void
    let resolveSecond!: (value: unknown) => void
    mockFetchBudgetEvents
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve
          }),
      )
    renderPage()

    await waitFor(() => {
      expect(screen.getByText('daily-cap')).toBeTruthy()
    })
    fireEvent.click(screen.getByText(/Recent events/))
    await waitFor(() => {
      expect(mockFetchBudgetEvents).toHaveBeenCalledTimes(1)
    })

    // An SSE budget_update triggers a second fetch for the expanded panel.
    const updateCall = mockSubscribe.mock.calls.find(
      (c) => (c as unknown[])[0] === 'budget_update',
    ) as unknown[] | undefined
    const handler = updateCall?.[1] as (event: unknown) => void
    act(() => {
      handler({
        name: 'daily-cap',
        bucket_key: 'budget:daily-cap:global',
        kind: 'spend',
        amount: 5,
        spent: 45,
        remaining: 55,
        limit: 100,
        currency: 'USD',
        utilization: 0.45,
      })
    })
    await waitFor(() => {
      expect(mockFetchBudgetEvents).toHaveBeenCalledTimes(2)
    })

    await act(async () => {
      resolveSecond({
        data: [eventRecord({ id: 'fresh', tool_name: 'fresh_tool' })],
        total: 2,
        limit: 20,
        offset: 0,
      })
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(screen.getByText('fresh_tool')).toBeTruthy()
    })

    await act(async () => {
      resolveFirst({
        data: [eventRecord({ id: 'stale', tool_name: 'stale_tool' })],
        total: 1,
        limit: 20,
        offset: 0,
      })
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(screen.getByText('fresh_tool')).toBeTruthy()
      expect(screen.queryByText('stale_tool')).toBeNull()
    })
  })

  it('a request outstanding across collapse, removal, and re-add cannot land', async () => {
    // Collapse leaves no expanded entry for the removal prune to barrier,
    // so an in-flight pre-collapse request must be invalidated by the
    // COLLAPSE itself — otherwise it applies first-life data to the
    // re-added budget's fresh panel.
    const intervalCallbacks: Array<() => void> = []
    const setIntervalSpy = vi
      .spyOn(global, 'setInterval')
      .mockImplementation((callback: TimerHandler): ReturnType<typeof setInterval> => {
        if (typeof callback === 'function') {
          intervalCallbacks.push(callback as () => void)
        }
        return 1 as unknown as ReturnType<typeof setInterval>
      })
    mockFetchBudgets
      .mockResolvedValueOnce({ budgets: [budgetState()] })
      .mockResolvedValueOnce({ budgets: [] })
      .mockResolvedValue({ budgets: [budgetState()] })
    const eventResolvers: Array<(value: unknown) => void> = []
    mockFetchBudgetEvents.mockImplementation(
      () =>
        new Promise((resolve) => {
          eventResolvers.push(resolve)
        }),
    )
    renderPage()

    await waitFor(() => {
      expect(screen.getByText('daily-cap')).toBeTruthy()
    })
    // First life: expand (request 1 stays in flight), then collapse.
    fireEvent.click(screen.getByText(/Recent events/))
    await waitFor(() => {
      expect(mockFetchBudgetEvents).toHaveBeenCalledTimes(1)
    })
    fireEvent.click(screen.getByText(/Hide recent events/))

    // Hot reload removes the budget (nothing expanded, nothing to prune)…
    act(() => {
      for (const callback of intervalCallbacks) callback()
    })
    await waitFor(() => {
      expect(screen.getByText('No budgets configured')).toBeTruthy()
    })
    // …then a later reload re-adds it.
    act(() => {
      for (const callback of intervalCallbacks) callback()
    })
    await waitFor(() => {
      expect(screen.getByText('daily-cap')).toBeTruthy()
    })

    // Second life: expand again (request 2 in flight) — and the FIRST
    // life's response lands first. It must be discarded.
    fireEvent.click(screen.getByText(/Recent events/))
    await waitFor(() => {
      expect(mockFetchBudgetEvents).toHaveBeenCalledTimes(2)
    })
    await act(async () => {
      eventResolvers[0]?.({
        data: [eventRecord({ id: 'stale', tool_name: 'stale_tool' })],
        total: 1,
        limit: 20,
        offset: 0,
      })
      await Promise.resolve()
    })
    expect(screen.queryByText('stale_tool')).toBeNull()

    await act(async () => {
      eventResolvers[1]?.({
        data: [eventRecord({ id: 'fresh', tool_name: 'fresh_tool' })],
        total: 1,
        limit: 20,
        offset: 0,
      })
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(screen.getByText('fresh_tool')).toBeTruthy()
      expect(screen.queryByText('stale_tool')).toBeNull()
    })
    setIntervalSpy.mockRestore()
  })

  it('a pre-removal events response cannot land after the budget is re-added', async () => {
    // Remove/re-add must not let an in-flight request from the budget's
    // FIRST life reuse a fresh request token and overwrite its second life.
    const intervalCallbacks: Array<() => void> = []
    const setIntervalSpy = vi
      .spyOn(global, 'setInterval')
      .mockImplementation((callback: TimerHandler): ReturnType<typeof setInterval> => {
        if (typeof callback === 'function') {
          intervalCallbacks.push(callback as () => void)
        }
        return 1 as unknown as ReturnType<typeof setInterval>
      })
    mockFetchBudgets
      .mockResolvedValueOnce({ budgets: [budgetState()] })
      .mockResolvedValueOnce({ budgets: [] })
      .mockResolvedValue({ budgets: [budgetState()] })
    const eventResolvers: Array<(value: unknown) => void> = []
    mockFetchBudgetEvents.mockImplementation(
      () =>
        new Promise((resolve) => {
          eventResolvers.push(resolve)
        }),
    )
    renderPage()

    await waitFor(() => {
      expect(screen.getByText('daily-cap')).toBeTruthy()
    })
    // First life: expand — request from before the removal stays in flight.
    fireEvent.click(screen.getByText(/Recent events/))
    await waitFor(() => {
      expect(mockFetchBudgetEvents).toHaveBeenCalledTimes(1)
    })

    // Hot reload removes the budget (prunes expansion state)…
    act(() => {
      for (const callback of intervalCallbacks) callback()
    })
    await waitFor(() => {
      expect(screen.getByText('No budgets configured')).toBeTruthy()
    })
    // The poll's own events request settles (only the EXPAND-time request
    // from the first life stays in flight), releasing the coalescer.
    await act(async () => {
      eventResolvers[1]?.({ data: [], total: 0, limit: 20, offset: 0 })
      await Promise.resolve()
    })
    // …and a later reload re-adds it.
    act(() => {
      for (const callback of intervalCallbacks) callback()
    })
    await waitFor(() => {
      expect(screen.getByText('daily-cap')).toBeTruthy()
    })

    // Second life: expand again and land the FRESH response first.
    fireEvent.click(screen.getByText(/Recent events/))
    const freshIndex = eventResolvers.length - 1
    await act(async () => {
      eventResolvers[freshIndex]?.({
        data: [eventRecord({ id: 'fresh', tool_name: 'fresh_tool' })],
        total: 1,
        limit: 20,
        offset: 0,
      })
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(screen.getByText('fresh_tool')).toBeTruthy()
    })

    // The first life's response finally lands — it must be discarded.
    await act(async () => {
      eventResolvers[0]?.({
        data: [eventRecord({ id: 'stale', tool_name: 'stale_tool' })],
        total: 1,
        limit: 20,
        offset: 0,
      })
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(screen.getByText('fresh_tool')).toBeTruthy()
      expect(screen.queryByText('stale_tool')).toBeNull()
    })
    setIntervalSpy.mockRestore()
  })

  it('an out-of-order stale pot response never overwrites a fresher one', async () => {
    // Initial fetch (slow) overlaps an SSE-triggered refetch (fast): the
    // older snapshot resolving last must not roll the pot numbers back.
    let resolveInitial!: (value: unknown) => void
    let resolveRefetch!: (value: unknown) => void
    mockFetchBudgets
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveInitial = resolve
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRefetch = resolve
          }),
      )
    renderPage()

    await waitFor(() => {
      const eventTypes = mockSubscribe.mock.calls.map((c) => (c as unknown[])[0])
      expect(eventTypes).toContain('budget_update')
    })
    const updateCall = mockSubscribe.mock.calls.find(
      (c) => (c as unknown[])[0] === 'budget_update',
    ) as unknown[] | undefined
    const handler = updateCall?.[1] as (event: unknown) => void
    act(() => {
      handler({
        name: 'daily-cap',
        bucket_key: 'budget:daily-cap:global',
        kind: 'spend',
        amount: 5,
        spent: 45,
        remaining: 55,
        limit: 100,
        currency: 'USD',
        utilization: 0.45,
      })
    })
    await waitFor(() => {
      expect(mockFetchBudgets).toHaveBeenCalledTimes(2)
    })

    const bucketAt = (spent: number) => ({
      bucket_key: 'budget:daily-cap:global',
      spent,
      remaining: 100 - spent,
      reset_at_ms: Date.now() + 60_000,
      last_activity_ms: Date.now(),
    })
    await act(async () => {
      resolveRefetch({ budgets: [budgetState({ buckets: [bucketAt(45)] })] })
      await Promise.resolve()
    })
    await act(async () => {
      resolveInitial({ budgets: [budgetState({ buckets: [bucketAt(40)] })] })
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(screen.getByText(/45\.00/)).toBeTruthy()
      expect(screen.queryByText(/40\.00/)).toBeNull()
    })
  })

  it('a stale initial failure after a fresher success shows no error page', async () => {
    let rejectInitial!: (reason: unknown) => void
    let resolveRefetch!: (value: unknown) => void
    mockFetchBudgets
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectInitial = reject
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRefetch = resolve
          }),
      )
    renderPage()

    await waitFor(() => {
      const eventTypes = mockSubscribe.mock.calls.map((c) => (c as unknown[])[0])
      expect(eventTypes).toContain('budget_update')
    })
    const updateCall = mockSubscribe.mock.calls.find(
      (c) => (c as unknown[])[0] === 'budget_update',
    ) as unknown[] | undefined
    const handler = updateCall?.[1] as (event: unknown) => void
    act(() => {
      handler({
        name: 'daily-cap',
        bucket_key: 'budget:daily-cap:global',
        kind: 'spend',
        amount: 5,
        spent: 45,
        remaining: 55,
        limit: 100,
        currency: 'USD',
        utilization: 0.45,
      })
    })
    await waitFor(() => {
      expect(mockFetchBudgets).toHaveBeenCalledTimes(2)
    })

    await act(async () => {
      resolveRefetch({ budgets: [budgetState()] })
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(screen.getByText('daily-cap')).toBeTruthy()
    })

    await act(async () => {
      rejectInitial(new Error('Connection refused'))
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(screen.getByText('daily-cap')).toBeTruthy()
      expect(screen.queryByText('Connection refused')).toBeNull()
      expect(screen.queryByText('Retry')).toBeNull()
    })
  })

  it('an older success still lands when every newer refresh failed', async () => {
    // Initial (slow) + SSE refresh (fails fast): the failed refresh applies
    // nothing, so the older initial SUCCESS must still populate the page —
    // otherwise the skeleton never resolves.
    let resolveInitial!: (value: unknown) => void
    let rejectRefetch!: (reason: unknown) => void
    mockFetchBudgets
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveInitial = resolve
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectRefetch = reject
          }),
      )
    renderPage()

    await waitFor(() => {
      const eventTypes = mockSubscribe.mock.calls.map((c) => (c as unknown[])[0])
      expect(eventTypes).toContain('budget_update')
    })
    const updateCall = mockSubscribe.mock.calls.find(
      (c) => (c as unknown[])[0] === 'budget_update',
    ) as unknown[] | undefined
    const handler = updateCall?.[1] as (event: unknown) => void
    act(() => {
      handler({
        name: 'daily-cap',
        bucket_key: 'budget:daily-cap:global',
        kind: 'spend',
        amount: 5,
        spent: 45,
        remaining: 55,
        limit: 100,
        currency: 'USD',
        utilization: 0.45,
      })
    })
    await waitFor(() => {
      expect(mockFetchBudgets).toHaveBeenCalledTimes(2)
    })

    await act(async () => {
      rejectRefetch(new Error('transient blip'))
      await Promise.resolve()
    })
    await act(async () => {
      resolveInitial({ budgets: [budgetState()] })
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(screen.getByText('daily-cap')).toBeTruthy()
    })
  })

  it('surfaces an error when every request failed and nothing ever loaded', async () => {
    // The initial request hangs forever; an SSE-triggered refresh fails.
    // With zero data ever applied, the failure must surface instead of
    // leaving the skeleton up indefinitely.
    mockFetchBudgets
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockImplementationOnce(() => Promise.reject(new Error('Connection refused')))
    renderPage()

    await waitFor(() => {
      const eventTypes = mockSubscribe.mock.calls.map((c) => (c as unknown[])[0])
      expect(eventTypes).toContain('budget_update')
    })
    const updateCall = mockSubscribe.mock.calls.find(
      (c) => (c as unknown[])[0] === 'budget_update',
    ) as unknown[] | undefined
    const handler = updateCall?.[1] as (event: unknown) => void
    act(() => {
      handler({
        name: 'daily-cap',
        bucket_key: 'budget:daily-cap:global',
        kind: 'spend',
        amount: 5,
        spent: 45,
        remaining: 55,
        limit: 100,
        currency: 'USD',
        utilization: 0.45,
      })
    })

    await waitFor(() => {
      expect(screen.getByText('Connection refused')).toBeTruthy()
      expect(screen.getByText('Retry')).toBeTruthy()
    })
  })

  it('subscribes to budget_update and budget_breached SSE events', async () => {
    mockFetchBudgets.mockResolvedValue({ budgets: [] })
    renderPage()

    await waitFor(() => {
      const eventTypes = mockSubscribe.mock.calls.map((c) => (c as unknown[])[0])
      expect(eventTypes).toContain('budget_update')
      expect(eventTypes).toContain('budget_breached')
    })
  })

  it('flashes the affected card and refetches on budget_update', async () => {
    mockFetchBudgets.mockResolvedValue({ budgets: [budgetState()] })
    const { container } = renderPage()

    await waitFor(() => {
      expect(screen.getByText('daily-cap')).toBeTruthy()
    })
    const fetchesBefore = mockFetchBudgets.mock.calls.length

    const updateCall = mockSubscribe.mock.calls.find(
      (c) => (c as unknown[])[0] === 'budget_update',
    ) as unknown[] | undefined
    const handler = updateCall?.[1] as (event: unknown) => void
    act(() => {
      handler({
        name: 'daily-cap',
        bucket_key: 'budget:daily-cap:global',
        kind: 'spend',
        amount: 5,
        spent: 45,
        remaining: 55,
        limit: 100,
        currency: 'USD',
        utilization: 0.45,
      })
    })

    await waitFor(() => {
      expect(container.querySelector('.ring-2')).toBeTruthy()
      expect(mockFetchBudgets.mock.calls.length).toBeGreaterThan(fetchesBefore)
    })
  })

  it('coalesces an SSE burst into one in-flight refresh plus one trailing', async () => {
    const deferredResolvers: Array<(value: unknown) => void> = []
    mockFetchBudgets.mockResolvedValueOnce({ budgets: [budgetState()] }).mockImplementation(
      () =>
        new Promise((resolve) => {
          deferredResolvers.push(resolve)
        }),
    )
    renderPage()

    await waitFor(() => {
      expect(screen.getByText('daily-cap')).toBeTruthy()
    })
    expect(mockFetchBudgets).toHaveBeenCalledTimes(1)

    const updateCall = mockSubscribe.mock.calls.find(
      (c) => (c as unknown[])[0] === 'budget_update',
    ) as unknown[] | undefined
    const handler = updateCall?.[1] as (event: unknown) => void
    const fire = () => {
      handler({
        name: 'daily-cap',
        bucket_key: 'budget:daily-cap:global',
        kind: 'spend',
        amount: 5,
        spent: 45,
        remaining: 55,
        limit: 100,
        currency: 'USD',
        utilization: 0.45,
      })
    }

    // A burst of five events: one refresh goes in flight, the other four
    // fold into a single trailing refresh.
    act(() => {
      fire()
      fire()
      fire()
      fire()
      fire()
    })
    expect(mockFetchBudgets).toHaveBeenCalledTimes(2)

    await act(async () => {
      deferredResolvers[0]?.({ budgets: [budgetState()] })
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(mockFetchBudgets).toHaveBeenCalledTimes(3)
    })

    await act(async () => {
      deferredResolvers[1]?.({ budgets: [budgetState()] })
      await Promise.resolve()
    })
    // No further trailing work queued.
    expect(mockFetchBudgets).toHaveBeenCalledTimes(3)
  })

  it('prunes expansion state when a budget disappears on reload', async () => {
    const intervalCallbacks: Array<() => void> = []
    const setIntervalSpy = vi
      .spyOn(global, 'setInterval')
      .mockImplementation((callback: TimerHandler): ReturnType<typeof setInterval> => {
        if (typeof callback === 'function') {
          intervalCallbacks.push(callback as () => void)
        }
        return 1 as unknown as ReturnType<typeof setInterval>
      })
    mockFetchBudgets
      .mockResolvedValueOnce({ budgets: [budgetState()] })
      .mockResolvedValue({ budgets: [] })
    mockFetchBudgetEvents.mockResolvedValue({
      data: [eventRecord()],
      total: 1,
      limit: 20,
      offset: 0,
    })
    renderPage()

    await waitFor(() => {
      expect(screen.getByText('daily-cap')).toBeTruthy()
    })
    fireEvent.click(screen.getByText(/Recent events/))
    await waitFor(() => {
      expect(mockFetchBudgetEvents).toHaveBeenCalledTimes(1)
    })

    // The next poll learns the budget was removed by a hot reload…
    act(() => {
      for (const callback of intervalCallbacks) callback()
    })
    await waitFor(() => {
      expect(screen.getByText('No budgets configured')).toBeTruthy()
    })
    const callsAfterRemoval = mockFetchBudgetEvents.mock.calls.length

    // …so later polls must no longer fetch the removed budget's events.
    act(() => {
      for (const callback of intervalCallbacks) callback()
    })
    await waitFor(() => {
      expect(mockFetchBudgets.mock.calls.length).toBeGreaterThanOrEqual(3)
    })
    expect(mockFetchBudgetEvents).toHaveBeenCalledTimes(callsAfterRemoval)
    setIntervalSpy.mockRestore()
  })

  it('a trailing batch cannot resurrect expansion state for a removed budget', async () => {
    // The prune lands via setState, but a trailing refresh executes in the
    // microtask right after the in-flight batch settles — BEFORE the next
    // render syncs expandedRef — so it must be gated on the synchronous
    // live-budget set, not the (stale) expansion ref.
    const intervalCallbacks: Array<() => void> = []
    const setIntervalSpy = vi
      .spyOn(global, 'setInterval')
      .mockImplementation((callback: TimerHandler): ReturnType<typeof setInterval> => {
        if (typeof callback === 'function') {
          intervalCallbacks.push(callback as () => void)
        }
        return 1 as unknown as ReturnType<typeof setInterval>
      })
    let resolveRemoval!: (value: unknown) => void
    mockFetchBudgets
      .mockResolvedValueOnce({ budgets: [budgetState()] })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRemoval = resolve
          }),
      )
      .mockResolvedValue({ budgets: [] })
    mockFetchBudgetEvents.mockResolvedValue({
      data: [eventRecord()],
      total: 1,
      limit: 20,
      offset: 0,
    })
    renderPage()

    await waitFor(() => {
      expect(screen.getByText('daily-cap')).toBeTruthy()
    })
    fireEvent.click(screen.getByText(/Recent events/))
    await waitFor(() => {
      expect(mockFetchBudgetEvents).toHaveBeenCalledTimes(1)
    })

    const updateCall = mockSubscribe.mock.calls.find(
      (c) => (c as unknown[])[0] === 'budget_update',
    ) as unknown[] | undefined
    const handler = updateCall?.[1] as (event: unknown) => void

    // Batch 1 goes in flight (its pot fetch will report the REMOVAL)…
    act(() => {
      handler({
        name: 'daily-cap',
        bucket_key: 'budget:daily-cap:global',
        kind: 'spend',
        amount: 5,
        spent: 45,
        remaining: 55,
        limit: 100,
        currency: 'USD',
        utilization: 0.45,
      })
    })
    // …and a poll tick queues a trailing batch naming the expanded budget.
    act(() => {
      for (const callback of intervalCallbacks) callback()
    })
    const eventCallsBeforeRemoval = mockFetchBudgetEvents.mock.calls.length

    // The removal lands OUTSIDE act: in production, the trailing batch's
    // microtask runs before React's scheduled re-render syncs expandedRef,
    // so the stale ref still names the pruned budget.
    resolveRemoval({ budgets: [] })
    await new Promise((resolve) => setTimeout(resolve, 0))
    await waitFor(() => {
      expect(screen.getByText('No budgets configured')).toBeTruthy()
    })

    // The trailing batch must NOT have fetched events for the removed
    // budget nor resurrected its panel state: a later poll fetches nothing.
    const eventCallsAfterRemoval = mockFetchBudgetEvents.mock.calls.length
    expect(eventCallsAfterRemoval).toBe(eventCallsBeforeRemoval)
    act(() => {
      for (const callback of intervalCallbacks) callback()
    })
    await waitFor(() => {
      expect(mockFetchBudgets.mock.calls.length).toBeGreaterThanOrEqual(4)
    })
    expect(mockFetchBudgetEvents.mock.calls.length).toBe(eventCallsAfterRemoval)
    setIntervalSpy.mockRestore()
  })

  it('sustained SSE traffic cannot starve the poll fallback', async () => {
    // Budget A emitting events more often than the poll interval must not
    // keep resetting the timer: budget B's stale-generation commits emit no
    // SSE by design, so the fixed poll is B's ONLY refresh path.
    const registered: Array<() => void> = []
    const setIntervalSpy = vi
      .spyOn(global, 'setInterval')
      .mockImplementation((callback: TimerHandler): ReturnType<typeof setInterval> => {
        if (typeof callback === 'function') {
          registered.push(callback as () => void)
        }
        return registered.length as unknown as ReturnType<typeof setInterval>
      })
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval').mockImplementation(() => undefined)
    mockFetchBudgets.mockResolvedValue({
      budgets: [budgetState({ name: 'cap-a' }), budgetState({ name: 'cap-b' })],
    })
    renderPage()

    await waitFor(() => {
      expect(screen.getByText('cap-a')).toBeTruthy()
    })
    const timersAtMount = registered.length
    const clearsAtMount = clearIntervalSpy.mock.calls.length

    const updateCall = mockSubscribe.mock.calls.find(
      (c) => (c as unknown[])[0] === 'budget_update',
    ) as unknown[] | undefined
    const handler = updateCall?.[1] as (event: unknown) => void
    act(() => {
      for (let i = 0; i < 3; i++) {
        handler({
          name: 'cap-a',
          bucket_key: 'budget:cap-a:global',
          kind: 'spend',
          amount: 5,
          spent: 45,
          remaining: 55,
          limit: 100,
          currency: 'USD',
          utilization: 0.45,
        })
      }
    })

    // The fixed interval stays untouched — no clears, no re-registrations.
    expect(registered.length).toBe(timersAtMount)
    expect(clearIntervalSpy.mock.calls.length).toBe(clearsAtMount)
    setIntervalSpy.mockRestore()
    clearIntervalSpy.mockRestore()
  })

  it('a trailing batch merges poll names with SSE names across budgets', async () => {
    // While budget A's SSE refresh is in flight, a poll tick (naming
    // expanded budget B) and another A event fold into ONE trailing batch
    // that must still carry B — otherwise sustained A traffic could delay
    // B's ledger refresh even with the fixed poll interval.
    const intervalCallbacks: Array<() => void> = []
    const setIntervalSpy = vi
      .spyOn(global, 'setInterval')
      .mockImplementation((callback: TimerHandler): ReturnType<typeof setInterval> => {
        if (typeof callback === 'function') {
          intervalCallbacks.push(callback as () => void)
        }
        return 1 as unknown as ReturnType<typeof setInterval>
      })
    let resolveInFlight!: (value: unknown) => void
    const twoBudgets = {
      budgets: [budgetState({ name: 'cap-a' }), budgetState({ name: 'cap-b', buckets: [] })],
    }
    mockFetchBudgets
      .mockResolvedValueOnce(twoBudgets)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveInFlight = resolve
          }),
      )
      .mockResolvedValue(twoBudgets)
    mockFetchBudgetEvents.mockResolvedValue({
      data: [eventRecord({ budget_name: 'cap-b' })],
      total: 1,
      limit: 20,
      offset: 0,
    })
    renderPage()

    await waitFor(() => {
      expect(screen.getByText('cap-b')).toBeTruthy()
    })
    // Expand B (its only refresh source besides SSE is the poll).
    fireEvent.click(screen.getAllByText(/Recent events/)[1] as HTMLElement)
    await waitFor(() => {
      expect(mockFetchBudgetEvents).toHaveBeenCalledTimes(1)
    })

    const updateCall = mockSubscribe.mock.calls.find(
      (c) => (c as unknown[])[0] === 'budget_update',
    ) as unknown[] | undefined
    const handler = updateCall?.[1] as (event: unknown) => void
    const fireForA = () => {
      handler({
        name: 'cap-a',
        bucket_key: 'budget:cap-a:global',
        kind: 'spend',
        amount: 5,
        spent: 45,
        remaining: 55,
        limit: 100,
        currency: 'USD',
        utilization: 0.45,
      })
    }

    act(() => {
      fireForA() // batch 1 in flight (hung pot fetch); A is not expanded
      for (const callback of intervalCallbacks) callback() // trailing gains {cap-b}
      fireForA() // merges into the SAME trailing batch
    })
    // Nothing new started while batch 1 is in flight.
    expect(mockFetchBudgets).toHaveBeenCalledTimes(2)
    expect(mockFetchBudgetEvents).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveInFlight(twoBudgets)
      await Promise.resolve()
    })

    // Exactly one trailing batch ran, and it refreshed B's ledger panel.
    await waitFor(() => {
      expect(mockFetchBudgets).toHaveBeenCalledTimes(3)
      expect(mockFetchBudgetEvents).toHaveBeenCalledTimes(2)
      expect(mockFetchBudgetEvents).toHaveBeenLastCalledWith(
        'cap-b',
        { limit: 20 },
        { signal: expect.any(AbortSignal) as AbortSignal },
      )
    })
    setIntervalSpy.mockRestore()
  })

  it('a hanging refresh releases after the timeout and later refreshes recover', async () => {
    // One never-settling request must not wedge the coalescer: the batch
    // times out, its requests abort, and the queued trailing refresh runs.
    mockFetchBudgets
      .mockResolvedValueOnce({ budgets: [budgetState()] })
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValue({ budgets: [budgetState()] })
    renderPage()

    await waitFor(() => {
      expect(screen.getByText('daily-cap')).toBeTruthy()
    })
    const updateCall = mockSubscribe.mock.calls.find(
      (c) => (c as unknown[])[0] === 'budget_update',
    ) as unknown[] | undefined
    const handler = updateCall?.[1] as (event: unknown) => void
    const fire = () => {
      handler({
        name: 'daily-cap',
        bucket_key: 'budget:daily-cap:global',
        kind: 'spend',
        amount: 5,
        spent: 45,
        remaining: 55,
        limit: 100,
        currency: 'USD',
        utilization: 0.45,
      })
    }

    // Capture timers only from here so waitFor above keeps real timers.
    const timeoutCallbacks: Array<{ callback: () => void; delay: number }> = []
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout').mockImplementation(((
      callback: TimerHandler,
      delay?: number,
    ) => {
      if (typeof callback === 'function') {
        timeoutCallbacks.push({ callback: callback as () => void, delay: delay ?? 0 })
      }
      return timeoutCallbacks.length as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout)

    act(() => {
      fire() // starts the hung refresh (fetchBudgets call 2)
      fire() // folds into trailing
    })
    expect(mockFetchBudgets).toHaveBeenCalledTimes(2)

    // The refresh-release timer fires: the batch aborts and releases.
    const release = timeoutCallbacks.find((t) => t.delay === 15_000)
    expect(release).toBeDefined()
    await act(async () => {
      release?.callback()
      await Promise.resolve()
    })

    // The trailing refresh ran (recovery) and the hung request was aborted.
    expect(mockFetchBudgets).toHaveBeenCalledTimes(3)
    const hungOptions = mockFetchBudgets.mock.calls[1]?.[0] as { signal?: AbortSignal } | undefined
    expect(hungOptions?.signal?.aborted).toBe(true)
    setTimeoutSpy.mockRestore()
  })

  it('shows the empty state when no budgets are configured', async () => {
    mockFetchBudgets.mockResolvedValue({ budgets: [] })
    renderPage()

    await waitFor(() => {
      expect(screen.getByText('No budgets configured')).toBeTruthy()
    })
  })

  it('shows the error state on fetch failure', async () => {
    mockFetchBudgets.mockRejectedValue(new Error('Connection refused'))
    renderPage()

    await waitFor(() => {
      expect(screen.getByText('Connection refused')).toBeTruthy()
      expect(screen.getByText('Retry')).toBeTruthy()
    })
  })
})
