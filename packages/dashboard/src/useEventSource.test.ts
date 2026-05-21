import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useEventSource } from './useEventSource'

// ---------------------------------------------------------------------------
// MockEventSource
// ---------------------------------------------------------------------------

class MockEventSource {
  static instances: MockEventSource[] = []

  url: string
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  closed = false
  private listeners = new Map<string, Set<(e: MessageEvent) => void>>()

  constructor(url: string) {
    this.url = url
    MockEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: (e: MessageEvent) => void) {
    let set = this.listeners.get(type)
    if (!set) {
      set = new Set()
      this.listeners.set(type, set)
    }
    set.add(listener)
  }

  removeEventListener(type: string, listener: (e: MessageEvent) => void) {
    this.listeners.get(type)?.delete(listener)
  }

  close() {
    this.closed = true
  }

  // -- Test helpers --

  _simulateOpen() {
    this.onopen?.()
  }

  _simulateError() {
    this.onerror?.()
  }

  _simulateEvent(type: string, data: string) {
    const listeners = this.listeners.get(type)
    if (!listeners) return
    const event = new MessageEvent(type, { data })
    for (const fn of listeners) fn(event)
  }
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  MockEventSource.instances = []
  vi.stubGlobal('EventSource', MockEventSource)
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ auth_required: false, authenticated: true }),
        text: () => Promise.resolve(''),
        statusText: 'OK',
      }),
    ),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function latestInstance(): MockEventSource {
  const inst = MockEventSource.instances.at(-1)
  if (!inst) throw new Error('no MockEventSource instance created yet')
  return inst
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useEventSource', () => {
  it('starts with connected=false', () => {
    const { result } = renderHook(() => useEventSource('/test'))
    expect(result.current.connected).toBe(false)
    expect(result.current.connectionEpoch).toBe(0)
  })

  it('sets connected=true after onopen', () => {
    const { result } = renderHook(() => useEventSource('/test'))
    act(() => {
      latestInstance()._simulateOpen()
    })
    expect(result.current.connected).toBe(true)
    expect(result.current.connectionEpoch).toBe(1)
  })

  it('sets connected=false after onerror', () => {
    const { result } = renderHook(() => useEventSource('/test'))
    act(() => {
      latestInstance()._simulateOpen()
    })
    expect(result.current.connected).toBe(true)
    act(() => {
      latestInstance()._simulateError()
    })
    expect(result.current.connected).toBe(false)
  })

  it('increments connectionEpoch on reconnect', () => {
    const { result } = renderHook(() => useEventSource('/test'))
    act(() => {
      latestInstance()._simulateOpen()
      latestInstance()._simulateError()
      latestInstance()._simulateOpen()
    })
    expect(result.current.connectionEpoch).toBe(2)
  })

  it('dispatches parsed JSON to subscribed listeners', () => {
    const { result } = renderHook(() => useEventSource('/test'))
    const listener = vi.fn()
    act(() => {
      result.current.subscribe('action', listener)
    })
    act(() => {
      latestInstance()._simulateEvent('action', JSON.stringify({ tool_name: 'test' }))
    })
    expect(listener).toHaveBeenCalledWith({ tool_name: 'test' })
  })

  it('unsubscribe removes listener', () => {
    const { result } = renderHook(() => useEventSource('/test'))
    const listener = vi.fn()
    let unsub: () => void
    act(() => {
      unsub = result.current.subscribe('action', listener)
    })
    act(() => {
      unsub()
    })
    act(() => {
      latestInstance()._simulateEvent('action', JSON.stringify({ tool_name: 'test' }))
    })
    expect(listener).not.toHaveBeenCalled()
  })

  it('ignores malformed JSON without crashing', () => {
    const { result } = renderHook(() => useEventSource('/test'))
    const listener = vi.fn()
    act(() => {
      result.current.subscribe('action', listener)
    })
    act(() => {
      latestInstance()._simulateEvent('action', 'not-json{')
    })
    expect(listener).not.toHaveBeenCalled()
  })

  it('calls close() on unmount', () => {
    const { unmount } = renderHook(() => useEventSource('/test'))
    const es = latestInstance()
    expect(es.closed).toBe(false)
    unmount()
    expect(es.closed).toBe(true)
  })

  it('connects to the specified URL', () => {
    renderHook(() => useEventSource('/custom-url'))
    expect(latestInstance().url).toBe('/custom-url')
  })

  it('calls onSessionExpired callback when auth probe reports unauthenticated', async () => {
    const onSessionExpired = vi.fn()
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ auth_required: true, authenticated: false }),
          text: () => Promise.resolve(''),
          statusText: 'OK',
        }),
      ),
    )

    renderHook(() => useEventSource('/test', onSessionExpired))

    act(() => {
      latestInstance()._simulateError()
    })

    await waitFor(() => {
      expect(onSessionExpired).toHaveBeenCalledTimes(1)
    })
  })
})
