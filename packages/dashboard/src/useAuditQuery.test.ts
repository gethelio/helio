import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useAuditQuery } from './useAuditQuery'

// ---------------------------------------------------------------------------
// Mock fetchAudit
// ---------------------------------------------------------------------------

const mockFetchAudit = vi.fn()

vi.mock('./api', () => ({
  fetchAudit: (...args: unknown[]): unknown => mockFetchAudit(...args),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockResponse(overrides?: Partial<{ data: unknown[]; total: number }>) {
  return Promise.resolve({
    data: [],
    total: 0,
    limit: 25,
    offset: 0,
    ...overrides,
  })
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  // shouldAdvanceTime: true lets waitFor's internal polling timers proceed
  // while still intercepting setTimeout for the 300ms debounce
  vi.useFakeTimers({ shouldAdvanceTime: true })
  mockFetchAudit.mockReset()
  mockFetchAudit.mockReturnValue(mockResponse())
})

afterEach(() => {
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useAuditQuery', () => {
  it('fetches on mount with default params', async () => {
    const { result } = renderHook(() => useAuditQuery())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    expect(mockFetchAudit).toHaveBeenCalledTimes(1)
    expect(mockFetchAudit).toHaveBeenCalledWith(expect.objectContaining({ offset: 0, limit: 25 }))
  })

  it('debounces tool filter changes by 300ms', async () => {
    const { result } = renderHook(() => useAuditQuery())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    mockFetchAudit.mockClear()

    // Change tool filter — should not trigger fetch immediately
    act(() => {
      result.current.setFilter('tool', 'payment')
    })
    expect(mockFetchAudit).not.toHaveBeenCalled()

    // Advance 300ms for debounce
    act(() => {
      vi.advanceTimersByTime(300)
    })

    await waitFor(() => {
      expect(mockFetchAudit).toHaveBeenCalledWith(expect.objectContaining({ tool: 'payment' }))
    })
  })

  it('decision filter triggers fetch', async () => {
    const { result } = renderHook(() => useAuditQuery())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    mockFetchAudit.mockClear()

    act(() => {
      result.current.setFilter('decision', 'deny')
    })

    await waitFor(() => {
      expect(mockFetchAudit).toHaveBeenCalledWith(expect.objectContaining({ decision: 'deny' }))
    })
  })

  it('allow outcome filter maps to blocked=false and non-dry-run', async () => {
    const { result } = renderHook(() => useAuditQuery())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    mockFetchAudit.mockClear()

    act(() => {
      result.current.setFilter('decision', 'allow')
    })

    await waitFor(() => {
      expect(mockFetchAudit).toHaveBeenCalledWith(
        expect.objectContaining({ blocked: false, dry_run: false }),
      )
    })
  })

  it('rate-limited outcome filter maps to reason=rate_limited', async () => {
    const { result } = renderHook(() => useAuditQuery())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    mockFetchAudit.mockClear()

    act(() => {
      result.current.setFilter('decision', 'rate_limited')
    })

    await waitFor(() => {
      expect(mockFetchAudit).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'rate_limited' }),
      )
    })
  })

  it('maps upstream status range filters to numeric audit params', async () => {
    const { result } = renderHook(() => useAuditQuery())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    mockFetchAudit.mockClear()

    act(() => {
      result.current.setBulkFilters({ upstream_status_min: '500', upstream_status_max: '599' })
    })

    await waitFor(() => {
      expect(mockFetchAudit).toHaveBeenCalledWith(
        expect.objectContaining({ upstream_status_min: 500, upstream_status_max: 599 }),
      )
    })
  })

  it('filter changes reset page to 1', async () => {
    const { result } = renderHook(() => useAuditQuery())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    // Go to page 2
    act(() => {
      result.current.setPage(2)
    })
    expect(result.current.page).toBe(2)

    // Change a filter — should reset to page 1
    act(() => {
      result.current.setFilter('decision', 'allow')
    })
    expect(result.current.page).toBe(1)

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
  })

  it('setPage triggers fetch', async () => {
    const { result } = renderHook(() => useAuditQuery())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    mockFetchAudit.mockClear()

    act(() => {
      result.current.setPage(3)
    })

    await waitFor(() => {
      expect(mockFetchAudit).toHaveBeenCalledWith(expect.objectContaining({ offset: 50 }))
    })
  })

  it('refetch triggers a new fetch', async () => {
    const { result } = renderHook(() => useAuditQuery())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    mockFetchAudit.mockClear()

    act(() => {
      result.current.refetch()
    })

    await waitFor(() => {
      expect(mockFetchAudit).toHaveBeenCalledTimes(1)
    })
  })

  it('sets error state on fetch failure', async () => {
    mockFetchAudit.mockRejectedValue(new Error('Network error'))

    const { result } = renderHook(() => useAuditQuery())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
      expect(result.current.error).toBe('Network error')
    })
  })

  it('setLimit resets page to 1', async () => {
    const { result } = renderHook(() => useAuditQuery())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    act(() => {
      result.current.setPage(5)
    })
    expect(result.current.page).toBe(5)

    act(() => {
      result.current.setLimit(50)
    })
    expect(result.current.page).toBe(1)
    expect(result.current.limit).toBe(50)

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
  })

  it('passes origin/record_kind/channel/sender to fetchAudit (#16)', async () => {
    const { result } = renderHook(() => useAuditQuery())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    mockFetchAudit.mockClear()

    act(() => {
      result.current.setBulkFilters({ origin: 'openclaw', record_kind: 'install_scan' })
    })

    // origin is debounced; record_kind (select) is not. Flush the 300ms window so origin reaches fetchAudit.
    act(() => {
      vi.advanceTimersByTime(300)
    })

    await waitFor(() => {
      expect(mockFetchAudit).toHaveBeenLastCalledWith(
        expect.objectContaining({ origin: 'openclaw', record_kind: 'install_scan' }),
      )
    })
  })

  it('debounces channel/sender text filters by 300ms (#16)', async () => {
    const { result } = renderHook(() => useAuditQuery())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    mockFetchAudit.mockClear()

    // Change channel filter — should not trigger fetch with channel value immediately
    act(() => {
      result.current.setFilter('channel', 'C123')
    })
    expect(mockFetchAudit).not.toHaveBeenCalledWith(expect.objectContaining({ channel: 'C123' }))

    // Advance 300ms for debounce
    act(() => {
      vi.advanceTimersByTime(300)
    })

    await waitFor(() => {
      expect(mockFetchAudit).toHaveBeenLastCalledWith(expect.objectContaining({ channel: 'C123' }))
    })
  })
})
