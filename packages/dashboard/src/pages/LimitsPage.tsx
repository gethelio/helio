import { useCallback, useEffect, useRef, useState } from 'react'
import type { LimitsResponse, RateLimitKeyState, SpendLimitKeyState } from '../types'
import { MS_PER_MINUTE, MS_PER_HOUR, MS_PER_DAY } from '../constants'
import { fetchLimits } from '../api'
import { useEventSourceContext } from '../EventSourceContext'
import { usageColor, usagePercent, formatCountdown, formatCurrency } from '../utils'
import { PageError } from '../components/PageError'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 5_000
const COUNTDOWN_INTERVAL_MS = 1_000
const WARNING_FLASH_MS = 10_000

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatWindow(ms: number): string {
  if (ms >= MS_PER_DAY) {
    const d = Math.round(ms / MS_PER_DAY)
    return `${String(d)}d`
  }
  if (ms >= MS_PER_HOUR) {
    const h = Math.round(ms / MS_PER_HOUR)
    return `${String(h)}h`
  }
  const m = Math.round(ms / MS_PER_MINUTE)
  return `${String(m)}m`
}

function parseKeyLabel(key: string): { type: string; name: string } {
  const idx = key.indexOf(':')
  if (idx === -1) return { type: '', name: key }
  return { type: key.slice(0, idx), name: key.slice(idx + 1) }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function LimitsPage() {
  const [data, setData] = useState<LimitsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const [warningKeys, setWarningKeys] = useState<Set<string>>(new Set())

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const warningTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())
  const { subscribe } = useEventSourceContext()

  // -- Fetch helper ---------------------------------------------------------
  const doFetch = useCallback((isInitial: boolean) => {
    fetchLimits()
      .then((res) => {
        setData(res)
        setError(null)
        if (isInitial) setLoading(false)
      })
      .catch((err: unknown) => {
        if (isInitial) {
          setError(err instanceof Error ? err.message : 'Failed to load limits')
          setLoading(false)
        }
        // Silently ignore refetch failures — keep last good data
      })
  }, [])

  // -- Initial fetch + polling ----------------------------------------------
  useEffect(() => {
    doFetch(true)

    intervalRef.current = setInterval(() => {
      doFetch(false)
    }, POLL_INTERVAL_MS)
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [doFetch])

  // -- SSE: limit_warning → highlight + immediate refetch -------------------
  // Note: intervalRef is shared with the polling effect above. The polling
  // effect's cleanup is the canonical owner; this effect resets the timer
  // on SSE events to avoid a double-fetch right after an event-triggered refetch.
  useEffect(() => {
    // Capture the warning-timers Set so the cleanup function references the
    // same instance the effect body mutates, satisfying react-hooks/exhaustive-deps.
    const timers = warningTimersRef.current
    const unsub = subscribe('limit_warning', (event) => {
      // Flash highlight on the affected card
      setWarningKeys((prev) => new Set(prev).add(event.key))
      const timerId = setTimeout(() => {
        setWarningKeys((prev) => {
          const next = new Set(prev)
          next.delete(event.key)
          return next
        })
        timers.delete(timerId)
      }, WARNING_FLASH_MS)
      timers.add(timerId)

      // Immediate refetch + reset polling timer
      doFetch(false)
      if (intervalRef.current) clearInterval(intervalRef.current)
      intervalRef.current = setInterval(() => {
        doFetch(false)
      }, POLL_INTERVAL_MS)
    })
    return () => {
      unsub()
      for (const id of timers) clearTimeout(id)
      timers.clear()
    }
  }, [subscribe, doFetch])

  // -- Countdown timer (1s) -------------------------------------------------
  useEffect(() => {
    const id = setInterval(() => {
      setNow(Date.now())
    }, COUNTDOWN_INTERVAL_MS)
    return () => {
      clearInterval(id)
    }
  }, [])

  // -- Loading state --------------------------------------------------------
  if (loading) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="h-24 animate-pulse rounded-md bg-gray-100" />
        ))}
      </div>
    )
  }

  // -- Error state ----------------------------------------------------------
  if (error) {
    return <PageError error={error} />
  }

  const rateLimits = data?.rate_limits ?? []
  const spendLimits = data?.spend_limits ?? []

  // -- Full empty state -----------------------------------------------------
  if (rateLimits.length === 0 && spendLimits.length === 0) {
    return (
      <div className="flex h-full flex-col">
        <div className="mb-4">
          <h1 className="text-lg font-semibold text-gray-900">Rate &amp; Spend Limits</h1>
          <p className="mt-1 text-sm text-gray-500">Current usage against configured limits</p>
        </div>
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-gray-500">
          <svg
            className="h-10 w-10 text-gray-300"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1.5}
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 0 1 3 19.875v-6.75ZM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V8.625ZM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V4.125Z"
            />
          </svg>
          <p className="text-sm font-medium">No active limits configured</p>
          <p className="text-xs text-gray-400">Add rate or spend limits to your policy</p>
        </div>
      </div>
    )
  }

  // -- Render ---------------------------------------------------------------
  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto">
      {/* Page title */}
      <div>
        <h1 className="text-lg font-semibold text-gray-900">Rate &amp; Spend Limits</h1>
        <p className="mt-1 text-sm text-gray-500">Current usage against configured limits</p>
      </div>

      {/* Rate Limits */}
      <section>
        <h2 className="mb-3 text-sm font-medium text-gray-500">Rate Limits</h2>
        {rateLimits.length === 0 ? (
          <p className="text-sm text-gray-500">No rate limits configured</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {rateLimits.map((rl) => (
              <RateLimitCard
                key={rl.key}
                state={rl}
                now={now}
                highlighted={warningKeys.has(rl.key)}
              />
            ))}
          </div>
        )}
      </section>

      {/* Spend Limits */}
      <section>
        <h2 className="mb-3 text-sm font-medium text-gray-500">Spend Limits</h2>
        {spendLimits.length === 0 ? (
          <p className="text-sm text-gray-500">No spend limits configured</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {spendLimits.map((sl) => (
              <SpendLimitCard
                key={sl.key}
                state={sl}
                now={now}
                highlighted={warningKeys.has(sl.key)}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function RateLimitCard({
  state,
  now,
  highlighted,
}: {
  state: RateLimitKeyState
  now: number
  highlighted: boolean
}) {
  const { type, name } = parseKeyLabel(state.key)
  const remaining = state.reset_at_ms - now
  const pct = usagePercent(state.current, state.limit)

  return (
    <div
      className={`rounded-md border bg-white p-4 transition-shadow ${
        highlighted ? 'ring-2 ring-amber-300 border-amber-200' : 'border-gray-200'
      }`}
    >
      {/* Header: key + window */}
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="min-w-0">
          {type && <span className="mr-1 text-xs text-gray-400">{type}</span>}
          <span className="font-mono text-sm text-gray-900">{name}</span>
        </div>
        <span className="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500">
          {formatWindow(state.window_ms)}
        </span>
      </div>

      {/* Progress bar */}
      <div className="mb-2 flex items-center gap-3">
        <div className="h-2 flex-1 overflow-hidden rounded-full bg-gray-100">
          <div
            className={`h-full rounded-full transition-all ${usageColor(state.current, state.limit)}`}
            style={{ width: `${String(pct)}%` }}
          />
        </div>
        <span className="shrink-0 text-xs tabular-nums text-gray-600">
          {state.current} / {state.limit} calls
        </span>
      </div>

      {/* Reset countdown */}
      <p className="text-xs text-gray-500">
        {remaining > 0
          ? `Resets in ${formatCountdown(remaining)}`
          : state.current > 0
            ? 'Expired'
            : 'No active window'}
      </p>
    </div>
  )
}

function SpendLimitCard({
  state,
  now,
  highlighted,
}: {
  state: SpendLimitKeyState
  now: number
  highlighted: boolean
}) {
  const { type, name } = parseKeyLabel(state.key)
  const remaining = state.reset_at_ms - now
  const pct = usagePercent(state.current_spend, state.limit)

  return (
    <div
      className={`rounded-md border bg-white p-4 transition-shadow ${
        highlighted ? 'ring-2 ring-amber-300 border-amber-200' : 'border-gray-200'
      }`}
    >
      {/* Header: key + currency + window */}
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="min-w-0">
          {type && <span className="mr-1 text-xs text-gray-400">{type}</span>}
          <span className="font-mono text-sm text-gray-900">{name}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="text-xs font-medium text-gray-400">{state.currency}</span>
          <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500">
            {formatWindow(state.window_ms)}
          </span>
        </div>
      </div>

      {/* Progress bar */}
      <div className="mb-2 flex items-center gap-3">
        <div className="h-2 flex-1 overflow-hidden rounded-full bg-gray-100">
          <div
            className={`h-full rounded-full transition-all ${usageColor(state.current_spend, state.limit)}`}
            style={{ width: `${String(pct)}%` }}
          />
        </div>
        <span className="shrink-0 text-xs tabular-nums text-gray-600">
          {formatCurrency(state.current_spend, state.currency)} /{' '}
          {formatCurrency(state.limit, state.currency)}
        </span>
      </div>

      {/* Reset countdown */}
      <p className="text-xs text-gray-500">
        {remaining > 0
          ? `Resets in ${formatCountdown(remaining)}`
          : state.current_spend > 0
            ? 'Expired'
            : 'No active window'}
      </p>
    </div>
  )
}
