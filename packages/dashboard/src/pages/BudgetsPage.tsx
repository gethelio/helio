import { useCallback, useEffect, useRef, useState } from 'react'
import type { BudgetEventRecord, BudgetState, BudgetBucketState } from '../types'
import { fetchBudgets, fetchBudgetEvents } from '../api'
import { useEventSourceContext } from '../EventSourceContext'
import { usageColor, usagePercent, formatCountdown, formatCurrency } from '../utils'
import { PageError } from '../components/PageError'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 5_000
const COUNTDOWN_INTERVAL_MS = 1_000
const FLASH_MS = 10_000
const EVENTS_PAGE_SIZE = 20
/** A refresh batch that has not settled by then is aborted and released. */
const REFRESH_TIMEOUT_MS = 15_000

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The bucket key minus its `budget:<name>:` prefix, e.g. `session:abc123`. */
function bucketLabel(budgetName: string, bucketKey: string): string {
  const prefix = `budget:${budgetName}:`
  return bucketKey.startsWith(prefix) ? bucketKey.slice(prefix.length) : bucketKey
}

interface EventsPanelState {
  readonly loading: boolean
  readonly events: readonly BudgetEventRecord[]
  readonly total: number
  readonly error: string | null
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function BudgetsPage() {
  const [budgets, setBudgets] = useState<readonly BudgetState[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const [flashedNames, setFlashedNames] = useState<Set<string>>(new Set())
  // A Map, not a Record: budget names are arbitrary config strings, and a
  // plain object would surface INHERITED Object.prototype members for names
  // like "toString" or "__proto__" as phantom panel state.
  const [expanded, setExpanded] = useState<ReadonlyMap<string, EventsPanelState>>(new Map())

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  /** One RESETTABLE flash timer per budget — an SSE burst extends, not stacks. */
  const flashTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const expandedRef = useRef(expanded)
  expandedRef.current = expanded
  /** Pot fetch sequence: issue counter, plus the newest APPLIED response. */
  const potSeqRef = useRef(0)
  const potAppliedSeqRef = useRef(0)
  /**
   * Per-budget events response ordering. Tokens are minted from one
   * GLOBALLY monotonic counter (a per-budget counter would restart at 1
   * after a remove/re-add prune, letting a response from the budget's
   * first life match its second life's token). A response applies only
   * when its token beats the newest APPLIED one — guarding on the newest
   * ISSUED token instead would let a failed newer refresh doom the
   * panel's only successful (older) response to discard. Pruning a
   * removed budget writes the current counter as a BARRIER, so every
   * response from the old life stays unappliable after a re-add.
   */
  const eventsSeqCounterRef = useRef(0)
  const eventsAppliedSeqRef = useRef(new Map<string, number>())
  /**
   * The names in the most recent pot response, updated SYNCHRONOUSLY (the
   * expansion state prunes via setState, so `expandedRef` stays stale
   * until the next render — a trailing refresh batch runs before that and
   * must not resurrect a removed budget's panel through the stale ref).
   */
  const liveNamesRef = useRef<ReadonlySet<string> | null>(null)
  /** Refresh coalescer: one in flight, at most one trailing (merged names). */
  const refreshStateRef = useRef<{ inFlight: boolean; trailing: Set<string> | null }>({
    inFlight: false,
    trailing: null,
  })
  /** Controllers for in-flight refresh batches, aborted on unmount. */
  const refreshControllersRef = useRef(new Set<AbortController>())
  /** Set on unmount so a releasing batch does not start trailing work. */
  const disposedRef = useRef(false)
  const { subscribe } = useEventSourceContext()

  // -- Fetch helpers ----------------------------------------------------------
  const doFetch = useCallback((signal?: AbortSignal): Promise<void> => {
    // Overlapping fetches (poll vs SSE vs the initial load) can resolve out
    // of order. A response applies only when it is newer than the last
    // APPLIED one — comparing against the issue counter instead would let
    // a failed newer refresh (which applies nothing) doom an older success
    // to discard and strand the loading skeleton.
    const seq = ++potSeqRef.current
    return (signal ? fetchBudgets({ signal }) : fetchBudgets())
      .then((res) => {
        if (seq <= potAppliedSeqRef.current) return
        potAppliedSeqRef.current = seq
        setBudgets(res.budgets)
        setError(null)
        setLoading(false)
        // A hot reload can remove a budget while its ledger panel is open:
        // drop the orphaned expansion state so the poll stops fetching
        // events for a pot that no longer exists. The live set and the
        // applied-token barriers update SYNCHRONOUSLY so in-flight and
        // trailing work sees the removal before the next render.
        const live = new Set(res.budgets.map((budget) => budget.name))
        liveNamesRef.current = live
        // Barrier every removed name that could still have a response in
        // flight — expanded panels included, even ones that never applied.
        const tracked = new Set([
          ...expandedRef.current.keys(),
          ...eventsAppliedSeqRef.current.keys(),
        ])
        for (const name of tracked) {
          if (!live.has(name)) {
            eventsAppliedSeqRef.current.set(name, eventsSeqCounterRef.current)
          }
        }
        setExpanded((prev) => {
          if (![...prev.keys()].some((name) => !live.has(name))) return prev
          const next = new Map(prev)
          for (const name of prev.keys()) if (!live.has(name)) next.delete(name)
          return next
        })
      })
      .catch((err: unknown) => {
        // A success has already landed (before or after this request was
        // issued): keep the good data, ignore the failure silently.
        if (potAppliedSeqRef.current > 0) return
        // Nothing has EVER loaded: surface the failure instead of leaving
        // the skeleton up; a later success clears it.
        setError(err instanceof Error ? err.message : 'Failed to load budgets')
        setLoading(false)
      })
  }, [])

  const loadEvents = useCallback((name: string, signal?: AbortSignal): Promise<void> => {
    // A trailing/in-flight batch can name a budget the last pot response
    // already removed (expandedRef is stale until the next render): skip
    // it entirely rather than resurrect its pruned panel state.
    if (liveNamesRef.current && !liveNamesRef.current.has(name)) {
      return Promise.resolve()
    }

    const seq = ++eventsSeqCounterRef.current
    // A response applies only when newer than the last APPLIED one (see
    // the ref docs above): stale successes never overwrite fresher pages,
    // and a failed newer refresh cannot doom an older success to discard.
    const isApplicable = () => seq > (eventsAppliedSeqRef.current.get(name) ?? 0)

    setExpanded((prev) =>
      new Map(prev).set(name, {
        loading: true,
        events: prev.get(name)?.events ?? [],
        total: prev.get(name)?.total ?? 0,
        error: null,
      }),
    )
    return (
      signal
        ? fetchBudgetEvents(name, { limit: EVENTS_PAGE_SIZE }, { signal })
        : fetchBudgetEvents(name, { limit: EVENTS_PAGE_SIZE })
    )
      .then((res) => {
        if (!isApplicable()) return
        eventsAppliedSeqRef.current.set(name, seq)
        setExpanded((prev) =>
          prev.has(name)
            ? new Map(prev).set(name, {
                loading: false,
                events: res.data,
                total: res.total,
                error: null,
              })
            : prev,
        )
      })
      .catch((err: unknown) => {
        if (!isApplicable()) return
        setExpanded((prev) => {
          const current = prev.get(name)
          if (!current) return prev
          // Loaded rows stay visible through a failed refetch — the error
          // replaces the list only when there is nothing to preserve.
          return new Map(prev).set(name, {
            loading: false,
            events: current.events,
            total: current.total,
            error:
              current.events.length > 0
                ? null
                : err instanceof Error
                  ? err.message
                  : 'Failed to load events',
          })
        })
      })
  }, [])

  /**
   * One coalesced refresh: the pots plus every EXPANDED budget in `names`.
   * While a refresh is in flight, further requests fold into a single
   * trailing refresh with their names merged — an SSE burst costs one
   * in-flight round plus one trailing round, never N.
   */
  const runRefresh = useCallback(
    (names: ReadonlySet<string>) => {
      const state = refreshStateRef.current
      if (state.inFlight) {
        state.trailing = new Set([...(state.trailing ?? []), ...names])
        return
      }
      const execute = (batch: ReadonlySet<string>) => {
        state.inFlight = true
        const controller = new AbortController()
        refreshControllersRef.current.add(controller)
        const tasks: Array<Promise<unknown>> = [doFetch(controller.signal)]
        for (const name of batch) {
          if (expandedRef.current.has(name)) tasks.push(loadEvents(name, controller.signal))
        }
        // A request that never settles must not wedge the coalescer: after
        // the timeout the batch is aborted and released either way, and the
        // sequence guards make any late-landing response harmless.
        let releaseTimer: ReturnType<typeof setTimeout> | undefined
        const releaseTimeout = new Promise<void>((resolve) => {
          releaseTimer = setTimeout(() => {
            controller.abort()
            resolve()
          }, REFRESH_TIMEOUT_MS)
        })
        void Promise.race([Promise.allSettled(tasks), releaseTimeout]).then(() => {
          if (releaseTimer) clearTimeout(releaseTimer)
          refreshControllersRef.current.delete(controller)
          state.inFlight = false
          const trailing = state.trailing
          state.trailing = null
          if (trailing && !disposedRef.current) execute(trailing)
        })
      }
      execute(names)
    },
    [doFetch, loadEvents],
  )

  // One poll tick refreshes the pots AND every expanded ledger panel: some
  // commits deliberately emit no SSE event (a stale-generation charge after
  // a pot-resetting reload), so an open panel cannot rely on push alone.
  const pollTick = useCallback(() => {
    runRefresh(new Set(expandedRef.current.keys()))
  }, [runRefresh])

  const toggleEvents = useCallback(
    (name: string) => {
      if (expandedRef.current.has(name)) {
        // Collapsing INVALIDATES every outstanding request for the panel
        // (barrier = current counter): a collapsed budget has no expanded
        // entry for the removal prune to barrier, so without this a
        // request from before collapse → removal → re-add would apply
        // first-life data to the re-added budget's fresh panel.
        eventsAppliedSeqRef.current.set(name, eventsSeqCounterRef.current)
        setExpanded((prev) => {
          const next = new Map(prev)
          next.delete(name)
          return next
        })
        return
      }
      void loadEvents(name)
    },
    [loadEvents],
  )

  // -- Initial fetch + polling ------------------------------------------------
  useEffect(() => {
    // Captured so the cleanup drains the same Set instance the refresh
    // batches register into (satisfying react-hooks/exhaustive-deps).
    const controllers = refreshControllersRef.current
    disposedRef.current = false
    void doFetch()

    intervalRef.current = setInterval(pollTick, POLL_INTERVAL_MS)
    return () => {
      disposedRef.current = true
      if (intervalRef.current) clearInterval(intervalRef.current)
      for (const controller of controllers) controller.abort()
      controllers.clear()
    }
  }, [doFetch, pollTick])

  // -- SSE: budget_update / budget_breached → flash + immediate refetch -------
  useEffect(() => {
    const timers = flashTimersRef.current
    const onBudgetEvent = (name: string) => {
      setFlashedNames((prev) => new Set(prev).add(name))
      const existing = timers.get(name)
      if (existing) clearTimeout(existing)
      const timerId = setTimeout(() => {
        setFlashedNames((prev) => {
          const next = new Set(prev)
          next.delete(name)
          return next
        })
        timers.delete(name)
      }, FLASH_MS)
      timers.set(name, timerId)

      // The fixed poll interval is deliberately NOT reset here: it is the
      // only refresh path for budgets whose commits emit no SSE (a
      // stale-generation charge), and sustained events on one budget must
      // not starve another's. A tick landing right after an SSE refresh
      // just folds into the coalescer's trailing batch.
      runRefresh(new Set([name]))
    }

    const unsubUpdate = subscribe('budget_update', (event) => {
      onBudgetEvent(event.name)
    })
    const unsubBreach = subscribe('budget_breached', (event) => {
      onBudgetEvent(event.name)
    })
    return () => {
      unsubUpdate()
      unsubBreach()
      for (const id of timers.values()) clearTimeout(id)
      timers.clear()
    }
  }, [subscribe, runRefresh])

  // -- Countdown timer (1s) ----------------------------------------------------
  useEffect(() => {
    const id = setInterval(() => {
      setNow(Date.now())
    }, COUNTDOWN_INTERVAL_MS)
    return () => {
      clearInterval(id)
    }
  }, [])

  // -- Loading state ------------------------------------------------------------
  if (loading) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="h-32 animate-pulse rounded-md bg-gray-100" />
        ))}
      </div>
    )
  }

  // -- Error state --------------------------------------------------------------
  if (error) {
    return <PageError error={error} />
  }

  const pots = budgets ?? []

  // -- Empty state ----------------------------------------------------------------
  if (pots.length === 0) {
    return (
      <div className="flex h-full flex-col">
        <div className="mb-4">
          <h1 className="text-lg font-semibold text-gray-900">Budgets</h1>
          <p className="mt-1 text-sm text-gray-500">
            Cumulative cross-tool spend against named budgets
          </p>
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
              d="M2.25 18.75a60.07 60.07 0 0 1 15.797 2.101c.727.198 1.453-.342 1.453-1.096V18.75M3.75 4.5v.75A.75.75 0 0 1 3 6h-.75m0 0v-.375c0-.621.504-1.125 1.125-1.125H20.25M2.25 6v9m18-10.5v.75c0 .414.336.75.75.75h.75m-1.5-1.5h.375c.621 0 1.125.504 1.125 1.125v9.75c0 .621-.504 1.125-1.125 1.125h-.375m1.5-1.5H21a.75.75 0 0 0-.75.75v.75m0 0H3.75m0 0h-.375a1.125 1.125 0 0 1-1.125-1.125V15m1.5 1.5v-.75A.75.75 0 0 0 3 15h-.75M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm3 0h.008v.008H18V10.5Zm-12 0h.008v.008H6V10.5Z"
            />
          </svg>
          <p className="text-sm font-medium">No budgets configured</p>
          <p className="text-xs text-gray-400">
            Add a top-level <code>budgets</code> section to your Helio config
          </p>
        </div>
      </div>
    )
  }

  // -- Render ---------------------------------------------------------------------
  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto">
      <div>
        <h1 className="text-lg font-semibold text-gray-900">Budgets</h1>
        <p className="mt-1 text-sm text-gray-500">
          Cumulative cross-tool spend against named budgets
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {pots.map((budget) => (
          <BudgetCard
            key={budget.name}
            budget={budget}
            now={now}
            highlighted={flashedNames.has(budget.name)}
            panel={expanded.get(budget.name)}
            onToggleEvents={() => {
              toggleEvents(budget.name)
            }}
          />
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function BudgetCard({
  budget,
  now,
  highlighted,
  panel,
  onToggleEvents,
}: {
  budget: BudgetState
  now: number
  highlighted: boolean
  panel: EventsPanelState | undefined
  onToggleEvents: () => void
}) {
  return (
    <div
      className={`rounded-md border bg-white p-4 transition-shadow ${
        highlighted ? 'ring-2 ring-amber-300 border-amber-200' : 'border-gray-200'
      }`}
    >
      {/* Header: name + posture + currency + window */}
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-mono text-sm text-gray-900">{budget.name}</span>
          {budget.on_exceed === 'require_approval' && (
            <span className="shrink-0 rounded bg-amber-50 px-1.5 py-0.5 text-xs text-amber-700">
              break-glass
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="text-xs font-medium text-gray-400">{budget.currency}</span>
          <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500">
            {budget.window}
          </span>
        </div>
      </div>

      {/* Buckets */}
      {budget.buckets.length === 0 ? (
        <div className="mb-2">
          <div className="mb-2 flex items-center gap-3">
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-gray-100" />
            <span className="shrink-0 text-xs tabular-nums text-gray-600">
              {formatCurrency(0, budget.currency)} / {formatCurrency(budget.limit, budget.currency)}
            </span>
          </div>
          <p className="text-xs text-gray-500">No spend yet — full headroom</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {budget.buckets.map((bucket) => (
            <BucketRow key={bucket.bucket_key} budget={budget} bucket={bucket} now={now} />
          ))}
        </div>
      )}

      {/* Recent events (ledger listing) */}
      <button
        type="button"
        onClick={onToggleEvents}
        className="mt-3 text-xs font-medium text-blue-600 hover:text-blue-500"
      >
        {panel ? 'Hide recent events' : 'Recent events'}
      </button>
      {panel && <EventsPanel panel={panel} />}
    </div>
  )
}

function BucketRow({
  budget,
  bucket,
  now,
}: {
  budget: BudgetState
  bucket: BudgetBucketState
  now: number
}) {
  const label = bucketLabel(budget.name, bucket.bucket_key)
  const pct = usagePercent(bucket.spent, budget.limit)
  const remainingMs = bucket.reset_at_ms === null ? null : bucket.reset_at_ms - now

  return (
    <div>
      {label !== 'global' && <p className="mb-1 font-mono text-xs text-gray-400">{label}</p>}
      <div className="mb-1 flex items-center gap-3">
        <div className="h-2 flex-1 overflow-hidden rounded-full bg-gray-100">
          <div
            className={`h-full rounded-full transition-all ${usageColor(bucket.spent, budget.limit)}`}
            style={{ width: `${String(pct)}%` }}
          />
        </div>
        <span className="shrink-0 text-xs tabular-nums text-gray-600">
          {formatCurrency(bucket.spent, budget.currency)} /{' '}
          {formatCurrency(budget.limit, budget.currency)}
        </span>
      </div>
      <p className="text-xs text-gray-500">
        {remainingMs === null
          ? 'Session pot — never replenishes'
          : remainingMs > 0
            ? `Resets in ${formatCountdown(remainingMs)}`
            : 'Expired'}
      </p>
    </div>
  )
}

function EventsPanel({ panel }: { panel: EventsPanelState }) {
  if (panel.loading && panel.events.length === 0) {
    return <p className="mt-2 text-xs text-gray-400">Loading events…</p>
  }
  if (panel.error) {
    return <p className="mt-2 text-xs text-red-600">{panel.error}</p>
  }
  if (panel.events.length === 0) {
    return <p className="mt-2 text-xs text-gray-400">No spend recorded yet</p>
  }
  return (
    <div className="mt-2 flex flex-col gap-1">
      {panel.events.map((event) => (
        <div key={event.id} className="flex items-center justify-between gap-2 text-xs">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate font-mono text-gray-700">{event.tool_name}</span>
            <KindBadge kind={event.kind} />
          </div>
          <div className="flex shrink-0 items-center gap-2 text-gray-500">
            <span className="tabular-nums">{formatCurrency(event.amount, event.currency)}</span>
            <span className="text-gray-400">{new Date(event.timestamp).toLocaleTimeString()}</span>
          </div>
        </div>
      ))}
      {panel.total > panel.events.length && (
        <p className="mt-1 text-xs text-gray-400">
          …and {panel.total - panel.events.length} more in the ledger
        </p>
      )}
    </div>
  )
}

function KindBadge({ kind }: { kind: BudgetEventRecord['kind'] }) {
  if (kind === 'approved_overage') {
    return (
      <span className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-800">
        approved overage
      </span>
    )
  }
  return <span className="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-gray-600">spend</span>
}
