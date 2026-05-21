import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AuditRecord, ActionEvent } from '../types'
import { fetchFeed, fetchAuditRecord } from '../api'
import { useEventSourceContext } from '../EventSourceContext'
import { ActionCard } from '../components/ActionCard'
import { PageError } from '../components/PageError'
import { DECISION_FILTERS } from '../constants'
import { matchesOutcomeFilter, type OutcomeFilterValue } from '../outcome'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type FeedItem = AuditRecord | ActionEvent

function isFullRecord(item: FeedItem): item is AuditRecord {
  return 'tool_input' in item
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_RECORDS = 500
const INITIAL_FETCH_LIMIT = 200
const MAX_BUFFERED_EVENTS = 200

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function FeedPage() {
  // -- State ----------------------------------------------------------------
  const [records, setRecords] = useState<FeedItem[]>([])
  const [liveBuffer, setLiveBuffer] = useState<FeedItem[]>([])
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [expandedRecord, setExpandedRecord] = useState<AuditRecord | null>(null)
  const [expandedLoading, setExpandedLoading] = useState(false)
  const [expandedError, setExpandedError] = useState<string | null>(null)
  const [filterTool, setFilterTool] = useState('')
  const [debouncedFilterTool, setDebouncedFilterTool] = useState('')
  const [filterDecision, setFilterDecision] = useState<OutcomeFilterValue | null>(null)
  const [isLive, setIsLive] = useState(true)
  const [initialLoading, setInitialLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const scrollRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const seenIdsRef = useRef(new Set<string>())
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const { subscribe, connectionEpoch } = useEventSourceContext()

  // -- Debounced tool filter ------------------------------------------------
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      setDebouncedFilterTool(filterTool)
    }, 300)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [filterTool])

  // -- Initial data load ----------------------------------------------------
  useEffect(() => {
    let canceled = false
    fetchFeed({ limit: INITIAL_FETCH_LIMIT })
      .then((res) => {
        if (canceled) return
        for (const r of res.data) seenIdsRef.current.add(r.id)
        setRecords(res.data as FeedItem[])
        setInitialLoading(false)
      })
      .catch((err: unknown) => {
        if (canceled) return
        setError(err instanceof Error ? err.message : 'Failed to load feed')
        setInitialLoading(false)
      })
    return () => {
      canceled = true
    }
  }, [])

  // -- SSE subscription -----------------------------------------------------
  useEffect(() => {
    return subscribe('action', (event: ActionEvent) => {
      if (seenIdsRef.current.has(event.id)) return
      seenIdsRef.current.add(event.id)

      setIsLive((live) => {
        if (live) {
          setRecords((prev) => {
            const next = [event as FeedItem, ...prev].slice(0, MAX_RECORDS)
            // Prune seenIds to match surviving records
            if (prev.length >= MAX_RECORDS) {
              seenIdsRef.current = new Set(next.map((r) => r.id))
            }
            return next
          })
        } else {
          setLiveBuffer((prev) => [event, ...prev].slice(0, MAX_BUFFERED_EVENTS))
        }
        return live
      })
    })
  }, [subscribe])

  // Backfill after SSE reconnect: /api/events is live-only, so pull the latest
  // canonical feed snapshot from REST whenever the stream re-opens.
  useEffect(() => {
    if (connectionEpoch <= 1) return
    fetchFeed({ limit: INITIAL_FETCH_LIMIT })
      .then((res) => {
        const next = res.data as FeedItem[]
        seenIdsRef.current = new Set(next.map((r) => r.id))
        setRecords(next)
        setLiveBuffer([])
        setIsLive(true)
      })
      .catch(() => {
        // Keep prior data if reconnect backfill fails.
      })
  }, [connectionEpoch])

  // -- Auto-scroll (IntersectionObserver) -----------------------------------
  useEffect(() => {
    const sentinel = sentinelRef.current
    const scrollContainer = scrollRef.current
    if (!sentinel || !scrollContainer) return

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setIsLive(true)
        } else {
          setIsLive(false)
        }
      },
      { root: scrollContainer, threshold: 0.1 },
    )
    observer.observe(sentinel)
    return () => {
      observer.disconnect()
    }
  }, [])

  // -- Flush live buffer ----------------------------------------------------
  const flushBuffer = useCallback(() => {
    setLiveBuffer((buf) => {
      if (buf.length === 0) return buf
      setRecords((prev) => [...buf, ...prev].slice(0, MAX_RECORDS))
      return []
    })
    setIsLive(true)
    scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
  }, [])

  // -- Toggle live/paused ---------------------------------------------------
  const toggleLive = useCallback(() => {
    setIsLive((prev) => {
      if (!prev) {
        // Resuming — flush any buffered items
        setLiveBuffer((buf) => {
          if (buf.length > 0) {
            setRecords((r) => [...buf, ...r].slice(0, MAX_RECORDS))
          }
          return []
        })
        scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
      }
      return !prev
    })
  }, [])

  // -- Expand/collapse ------------------------------------------------------
  const handleToggle = useCallback(
    (id: string, item: FeedItem) => {
      if (expandedId === id) {
        setExpandedId(null)
        setExpandedRecord(null)
        return
      }
      setExpandedId(id)
      setExpandedRecord(null)
      setExpandedError(null)

      if (!isFullRecord(item)) {
        // SSE-sourced item — fetch full record
        setExpandedLoading(true)
        fetchAuditRecord(id)
          .then((rec) => {
            // Guard against stale response if user expanded a different card
            setExpandedId((current) => {
              if (current === id) {
                setExpandedRecord(rec)
                setExpandedLoading(false)
              }
              return current
            })
          })
          .catch((err: unknown) => {
            setExpandedId((current) => {
              if (current === id) {
                setExpandedLoading(false)
                setExpandedError(
                  err instanceof Error ? err.message : 'Failed to load record details',
                )
              }
              return current
            })
          })
      }
    },
    [expandedId],
  )

  // -- Client-side filtering ------------------------------------------------
  const filtered = useMemo(() => {
    return records.filter((r) => {
      if (
        debouncedFilterTool &&
        !r.tool_name.toLowerCase().includes(debouncedFilterTool.toLowerCase())
      )
        return false
      if (filterDecision && !matchesOutcomeFilter(r, filterDecision)) return false
      return true
    })
  }, [records, debouncedFilterTool, filterDecision])

  // -- Loading state --------------------------------------------------------
  if (initialLoading) {
    return (
      <div className="flex h-full flex-col gap-3">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="h-16 animate-pulse rounded-md bg-gray-100" />
        ))}
      </div>
    )
  }

  // -- Error state ----------------------------------------------------------
  if (error) {
    return <PageError error={error} />
  }

  // -- Render ---------------------------------------------------------------
  return (
    <div className="flex h-full flex-col">
      {/* Page title */}
      <div className="mb-4">
        <h1 className="text-lg font-semibold text-gray-900">Activity Feed</h1>
        <p className="mt-1 text-sm text-gray-500">Real-time tool call stream</p>
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3 pb-4">
        {/* Tool name search */}
        <input
          type="text"
          placeholder="Filter by tool name…"
          value={filterTool}
          onChange={(e) => {
            setFilterTool(e.target.value)
          }}
          className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-gray-300 focus:outline-none"
        />

        {/* Decision pills */}
        <div className="flex flex-wrap gap-1.5">
          {DECISION_FILTERS.map(({ label, value }) => (
            <button
              key={label}
              type="button"
              onClick={() => {
                setFilterDecision(value)
              }}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                filterDecision === value
                  ? 'bg-gray-900 text-white'
                  : 'border border-gray-200 bg-white text-gray-600 hover:bg-gray-50'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Live toggle */}
        <button
          type="button"
          onClick={toggleLive}
          className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors border border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
        >
          <span
            className={`inline-block h-2 w-2 rounded-full ${
              isLive ? 'animate-pulse bg-emerald-500' : 'bg-amber-500'
            }`}
          />
          {isLive ? 'Live' : 'Paused'}
        </button>
      </div>

      {/* New items banner */}
      {liveBuffer.length > 0 && (
        <button
          type="button"
          onClick={flushBuffer}
          className="mb-3 w-full rounded-md bg-blue-50 px-3 py-2 text-center text-sm font-medium text-blue-700 hover:bg-blue-100 transition-colors"
        >
          {liveBuffer.length} new {liveBuffer.length === 1 ? 'action' : 'actions'} — click to load
        </button>
      )}

      {/* Feed list */}
      <div ref={scrollRef} className="flex-1 space-y-2 overflow-y-auto">
        <div ref={sentinelRef} className="h-0" />

        {filtered.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-gray-500">
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
                d="M3.75 13.5 14.25 2.25l-3 10.5h9L9.75 24l3-10.5h-9Z"
              />
            </svg>
            {records.length === 0 ? (
              <>
                <p className="text-sm font-medium">No actions yet</p>
                <p className="text-xs text-gray-400">Start sending tool calls through Helio</p>
              </>
            ) : (
              <>
                <p className="text-sm font-medium">No matching actions</p>
                <p className="text-xs text-gray-400">Try adjusting your filters</p>
              </>
            )}
          </div>
        )}

        {filtered.map((item) => (
          <ActionCard
            key={item.id}
            record={item}
            expanded={expandedId === item.id}
            onToggle={() => {
              handleToggle(item.id, item)
            }}
            expandedRecord={expandedId === item.id ? expandedRecord : null}
            loading={expandedId === item.id && expandedLoading}
            error={expandedId === item.id ? expandedError : null}
          />
        ))}
      </div>
    </div>
  )
}
