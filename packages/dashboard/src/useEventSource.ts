import { useEffect, useRef, useState, useCallback } from 'react'
import type { DashboardEventType, DashboardEventMap } from './types'
import { fetchAuthSession } from './api'

// ---------------------------------------------------------------------------
// useEventSource — SSE hook for real-time dashboard updates.
//
// Connects to GET /api/events using the browser's native EventSource API.
// Exposes a `connected` boolean for the status indicator, and typed
// subscribe/unsubscribe methods for page-level event listeners.
//
// EventSource provides automatic reconnection out of the box — when the
// connection drops, the browser reconnects after a short delay.
// ---------------------------------------------------------------------------

type Listener<K extends DashboardEventType> = (data: DashboardEventMap[K]) => void

export interface UseEventSourceReturn {
  /** Whether the SSE connection is currently open. */
  connected: boolean
  /**
   * Monotonic counter incremented on each successful SSE open.
   * Useful for reconnect backfills in live-only streams.
   */
  connectionEpoch: number
  /** Subscribe to a specific event type. Returns an unsubscribe function. */
  subscribe: <K extends DashboardEventType>(event: K, listener: Listener<K>) => () => void
}

export function useEventSource(
  url: string = '/api/events',
  onSessionExpired?: () => void,
): UseEventSourceReturn {
  const [connected, setConnected] = useState(false)
  const [connectionEpoch, setConnectionEpoch] = useState(0)
  const listenersRef = useRef(new Map<string, Set<Listener<DashboardEventType>>>())
  const esRef = useRef<EventSource | null>(null)

  useEffect(() => {
    const es = new EventSource(url)
    esRef.current = es

    es.onopen = () => {
      setConnected(true)
      setConnectionEpoch((epoch) => epoch + 1)
    }
    es.onerror = () => {
      setConnected(false)
      void fetchAuthSession()
        .then((session) => {
          if (session.auth_required && !session.authenticated) {
            onSessionExpired?.()
          }
        })
        .catch(() => {
          // Ignore auth probe errors on transient network failures.
        })
    }

    const eventTypes: DashboardEventType[] = [
      'action',
      'approval_requested',
      'approval_resolved',
      'approval_notification_failed',
      'limit_warning',
    ]

    for (const eventType of eventTypes) {
      es.addEventListener(eventType, (e: MessageEvent) => {
        const listeners = listenersRef.current.get(eventType)
        if (!listeners || listeners.size === 0) return

        try {
          const data = JSON.parse(e.data as string) as DashboardEventMap[typeof eventType]
          for (const listener of listeners) {
            listener(data)
          }
        } catch {
          // eslint-disable-next-line no-console -- surface SSE data corruption in browser console
          console.warn(`[helio] Failed to parse SSE event data for "${eventType}"`)
        }
      })
    }

    return () => {
      es.close()
      esRef.current = null
      setConnected(false)
    }
  }, [url, onSessionExpired])

  const subscribe = useCallback(
    <K extends DashboardEventType>(event: K, listener: Listener<K>): (() => void) => {
      const map = listenersRef.current
      let set = map.get(event)
      if (!set) {
        set = new Set()
        map.set(event, set)
      }
      const castListener = listener as Listener<DashboardEventType>
      set.add(castListener)

      return () => {
        set.delete(castListener)
      }
    },
    [],
  )

  return { connected, connectionEpoch, subscribe }
}
