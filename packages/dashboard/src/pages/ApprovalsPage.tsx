import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  ApprovalTicket,
  ApprovalRequestedEvent,
  ApprovalResolvedEvent,
  ApprovalNotificationFailedEvent,
} from '../types'
import { fetchApprovals } from '../api'
import type { ApprovalStatus } from '../types'
import { useEventSourceContext } from '../EventSourceContext'
import {
  timeAgo,
  truncateId,
  formatTimestamp,
  formatCountdown,
  stringifyForDisplay,
} from '../utils'
import { ApprovalStatusBadge } from '../components/ApprovalStatusBadge'
import { ApprovalActions } from '../components/ApprovalActions'
import { DetailSection } from '../components/DetailSection'
import { PageError } from '../components/PageError'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function countdownColor(remainingMs: number): string {
  if (remainingMs <= 0) return 'text-red-600 font-semibold'
  if (remainingMs < 30_000) return 'text-red-600'
  if (remainingMs < 60_000) return 'text-amber-600'
  return 'text-gray-500'
}

function resolvedReason(ticket: ApprovalTicket): string {
  if (ticket.break_glass_reason) return ticket.break_glass_reason
  if (ticket.denial_reason) return ticket.denial_reason
  return '\u2014'
}

const APPROVAL_PAGE_SIZE = 250
const MAX_APPROVAL_PAGES = 20

interface ApprovalFetchResult {
  readonly items: readonly ApprovalTicket[]
  readonly total: number
  readonly truncated: boolean
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ApprovalsPage() {
  // -- State ----------------------------------------------------------------
  const [activeTab, setActiveTab] = useState<'pending' | 'resolved'>('pending')
  const [pendingTickets, setPendingTickets] = useState<ApprovalTicket[]>([])
  const [resolvedTickets, setResolvedTickets] = useState<ApprovalTicket[]>([])
  const [initialLoading, setInitialLoading] = useState(true)
  const [resolvedLoading, setResolvedLoading] = useState(false)
  const [resolvedLoaded, setResolvedLoaded] = useState(false)
  const [pendingError, setPendingError] = useState<string | null>(null)
  const [resolvedError, setResolvedError] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const [pendingTruncated, setPendingTruncated] = useState(false)
  const [pendingTotal, setPendingTotal] = useState(0)
  const [resolvedTruncated, setResolvedTruncated] = useState(false)
  const [resolvedTotal, setResolvedTotal] = useState(0)

  const { subscribe, connectionEpoch } = useEventSourceContext()

  const fetchAllApprovals = useCallback(
    async (status?: ApprovalStatus): Promise<ApprovalFetchResult> => {
      const items: ApprovalTicket[] = []
      let offset = 0
      let total = 0
      let truncated = false

      for (let page = 0; page < MAX_APPROVAL_PAGES; page++) {
        const res = await fetchApprovals(status, {
          limit: APPROVAL_PAGE_SIZE,
          offset,
        })
        total = res.total
        items.push(...res.data)

        const nextOffset = offset + res.data.length
        const exhausted = res.data.length === 0 || nextOffset >= res.total
        if (exhausted) break
        if (page === MAX_APPROVAL_PAGES - 1) {
          truncated = true
          break
        }
        offset = nextOffset
      }

      return { items, total, truncated }
    },
    [],
  )

  // -- Countdown timer (1s interval) ----------------------------------------
  useEffect(() => {
    const id = setInterval(() => {
      setNow(Date.now())
    }, 1000)
    return () => {
      clearInterval(id)
    }
  }, [])

  // -- Initial fetch (pending only) -----------------------------------------
  useEffect(() => {
    let canceled = false
    setPendingError(null)
    fetchAllApprovals('pending')
      .then((res) => {
        if (canceled) return
        setPendingTickets([...res.items])
        setPendingTruncated(res.truncated)
        setPendingTotal(res.total)
        setInitialLoading(false)
      })
      .catch((err: unknown) => {
        if (canceled) return
        setPendingError(err instanceof Error ? err.message : 'Failed to load approvals')
        setInitialLoading(false)
      })
    return () => {
      canceled = true
    }
  }, [fetchAllApprovals])

  // -- Lazy fetch for Resolved tab ------------------------------------------
  useEffect(() => {
    if (activeTab !== 'resolved' || resolvedLoaded) return
    let canceled = false
    setResolvedLoading(true)
    setResolvedError(null)
    fetchAllApprovals()
      .then((res) => {
        if (canceled) return
        setResolvedTickets([...res.items].filter((t) => t.status !== 'pending'))
        setResolvedTruncated(res.truncated)
        setResolvedTotal(res.total)
        setResolvedLoading(false)
        setResolvedLoaded(true)
      })
      .catch((err: unknown) => {
        if (canceled) return
        setResolvedError(err instanceof Error ? err.message : 'Failed to load resolved approvals')
        setResolvedLoading(false)
      })
    return () => {
      canceled = true
    }
  }, [activeTab, resolvedLoaded, fetchAllApprovals])

  // -- SSE: new approval requested → refetch pending ------------------------
  useEffect(() => {
    return subscribe('approval_requested', (_event: ApprovalRequestedEvent) => {
      fetchAllApprovals('pending')
        .then((res) => {
          setPendingTickets([...res.items])
          setPendingTruncated(res.truncated)
          setPendingTotal(res.total)
          setPendingError(null)
        })
        .catch(() => {
          // Silently ignore refetch failures — keep last good data
        })
    })
  }, [subscribe, fetchAllApprovals])

  // -- SSE: approval resolved → remove from pending, mark resolved stale ----
  useEffect(() => {
    return subscribe('approval_resolved', (event: ApprovalResolvedEvent) => {
      setPendingTickets((prev) => prev.filter((t) => t.id !== event.ticket_id))
      setPendingTotal((prev) => Math.max(0, prev - 1))
      setResolvedLoaded(false)
      setResolvedTruncated(false)
    })
  }, [subscribe])

  // -- SSE: notification delivery failed → refetch pending -------------------
  useEffect(() => {
    return subscribe('approval_notification_failed', (_event: ApprovalNotificationFailedEvent) => {
      fetchAllApprovals('pending')
        .then((res) => {
          setPendingTickets([...res.items])
          setPendingTruncated(res.truncated)
          setPendingTotal(res.total)
          setPendingError(null)
        })
        .catch(() => {
          // Silently ignore refetch failures — keep last good data
        })
    })
  }, [subscribe, fetchAllApprovals])

  // Reconnect backfill: /api/events is live-only, so fetch canonical state
  // from REST when the SSE stream reconnects.
  useEffect(() => {
    if (connectionEpoch <= 1) return
    fetchAllApprovals('pending')
      .then((res) => {
        setPendingTickets([...res.items])
        setPendingTruncated(res.truncated)
        setPendingTotal(res.total)
        setPendingError(null)
      })
      .catch(() => {
        // Keep previous data when backfill fails.
      })
    setResolvedLoaded(false)
    setResolvedTruncated(false)
  }, [connectionEpoch, fetchAllApprovals])

  // -- Handlers -------------------------------------------------------------
  const handleResolved = useCallback((ticketId: string) => {
    setPendingTickets((prev) => prev.filter((t) => t.id !== ticketId))
    setPendingTotal((prev) => Math.max(0, prev - 1))
    setResolvedLoaded(false)
    setResolvedTruncated(false)
  }, [])

  const toggleExpand = useCallback((id: string) => {
    setExpandedId((prev) => (prev === id ? null : id))
  }, [])

  // -- Sort pending by requested_at desc ------------------------------------
  const sortedPending = useMemo(
    () =>
      [...pendingTickets].sort(
        (a, b) => new Date(b.requested_at).getTime() - new Date(a.requested_at).getTime(),
      ),
    [pendingTickets],
  )

  const pendingNotificationFailures = useMemo(
    () =>
      sortedPending
        .flatMap((ticket) =>
          (ticket.notification_failures ?? []).map((failure) => ({
            ticket_id: ticket.id,
            tool_name: ticket.tool_name,
            ...failure,
          })),
        )
        .sort((a, b) => new Date(b.failed_at).getTime() - new Date(a.failed_at).getTime()),
    [sortedPending],
  )

  // -- Sort resolved by resolved_at desc ------------------------------------
  const sortedResolved = useMemo(
    () =>
      [...resolvedTickets].sort((a, b) => {
        const aTime = a.resolved_at ? new Date(a.resolved_at).getTime() : 0
        const bTime = b.resolved_at ? new Date(b.resolved_at).getTime() : 0
        return bTime - aTime
      }),
    [resolvedTickets],
  )

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

  // -- Render ---------------------------------------------------------------
  return (
    <div className="flex h-full flex-col">
      {/* Page title */}
      <div className="mb-4">
        <h1 className="text-lg font-semibold text-gray-900">Approvals</h1>
        <p className="mt-1 text-sm text-gray-500">Pending and resolved approval requests</p>
      </div>

      {/* Tab bar */}
      <div className="flex flex-wrap items-center gap-3 pb-4">
        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={() => {
              setActiveTab('pending')
            }}
            className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
              activeTab === 'pending'
                ? 'bg-gray-900 text-white'
                : 'border border-gray-200 bg-white text-gray-600 hover:bg-gray-50'
            }`}
          >
            Pending{sortedPending.length > 0 ? ` (${String(sortedPending.length)})` : ''}
          </button>
          <button
            type="button"
            onClick={() => {
              setActiveTab('resolved')
            }}
            className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
              activeTab === 'resolved'
                ? 'bg-gray-900 text-white'
                : 'border border-gray-200 bg-white text-gray-600 hover:bg-gray-50'
            }`}
          >
            Resolved
          </button>
        </div>
      </div>

      {/* Pending tab */}
      {activeTab === 'pending' && (
        <div className="flex-1 space-y-2 overflow-y-auto">
          {pendingError && <PageError error={pendingError} />}
          {!pendingError && pendingNotificationFailures.length > 0 && (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
              <p className="font-medium">
                Approval notification delivery failures detected (
                {String(pendingNotificationFailures.length)}).
              </p>
              <p className="mt-1">
                Requests stay pending in this queue even when Slack/webhook delivery fails. Review
                affected tickets and resolve manually if needed.
              </p>
              <ul className="mt-2 list-disc pl-4">
                {pendingNotificationFailures.slice(0, 3).map((failure) => (
                  <li key={`${failure.ticket_id}-${failure.failed_at}-${failure.phase}`}>
                    <span className="font-mono">{failure.tool_name}</span> via {failure.channel} (
                    {failure.phase}) failed {timeAgo(failure.failed_at)}: {failure.error}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {!pendingError && pendingTruncated && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Showing only the newest {String(APPROVAL_PAGE_SIZE * MAX_APPROVAL_PAGES)} pending
              approvals ({String(pendingTotal)} total). Older entries are not loaded in this view.
            </div>
          )}

          {!pendingError && sortedPending.length === 0 && (
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
                  d="M9 12.75 11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285Z"
                />
              </svg>
              <p className="text-sm font-medium">No pending approvals</p>
              <p className="text-xs text-gray-400">Approval requests will appear here</p>
            </div>
          )}
          {!pendingError &&
            sortedPending.map((ticket) => (
              <PendingCard
                key={ticket.id}
                ticket={ticket}
                now={now}
                expanded={expandedId === ticket.id}
                onToggle={() => {
                  toggleExpand(ticket.id)
                }}
                onResolved={() => {
                  handleResolved(ticket.id)
                }}
              />
            ))}
        </div>
      )}

      {/* Resolved tab */}
      {activeTab === 'resolved' && (
        <div className="flex-1 overflow-auto">
          {resolvedLoading && (
            <div className="flex h-full flex-col gap-3">
              {Array.from({ length: 4 }, (_, i) => (
                <div key={i} className="h-10 animate-pulse rounded-md bg-gray-100" />
              ))}
            </div>
          )}

          {!resolvedLoading && resolvedError && <PageError error={resolvedError} />}
          {!resolvedLoading && !resolvedError && resolvedTruncated && (
            <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Showing only the newest {String(APPROVAL_PAGE_SIZE * MAX_APPROVAL_PAGES)} approvals (
              {String(resolvedTotal)} total before filtering). Older resolved entries are not loaded
              in this view.
            </div>
          )}

          {!resolvedLoading && !resolvedError && sortedResolved.length === 0 && (
            <div className="flex h-full items-center justify-center text-gray-500">
              <p className="text-sm">No resolved approvals yet</p>
            </div>
          )}

          {!resolvedLoading && !resolvedError && sortedResolved.length > 0 && (
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className="pb-2 pr-4 text-xs font-medium text-gray-500">Resolved At</th>
                  <th className="pb-2 pr-4 text-xs font-medium text-gray-500">Tool</th>
                  <th className="pb-2 pr-4 text-xs font-medium text-gray-500">Status</th>
                  <th className="pb-2 pr-4 text-xs font-medium text-gray-500">Resolved By</th>
                  <th className="hidden pb-2 pr-4 text-xs font-medium text-gray-500 md:table-cell">
                    Reason
                  </th>
                  <th className="hidden pb-2 text-xs font-medium text-gray-500 sm:table-cell">
                    Session
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortedResolved.map((ticket) => (
                  <ResolvedRow
                    key={ticket.id}
                    ticket={ticket}
                    expanded={expandedId === ticket.id}
                    onToggle={() => {
                      toggleExpand(ticket.id)
                    }}
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function PendingCard({
  ticket,
  now,
  expanded,
  onToggle,
  onResolved,
}: {
  ticket: ApprovalTicket
  now: number
  expanded: boolean
  onToggle: () => void
  onResolved: () => void
}) {
  const remaining = Math.max(0, new Date(ticket.timeout_at).getTime() - now)
  const inputPreview = stringifyForDisplay(ticket.tool_input)

  return (
    <div
      className={`rounded-md border bg-white transition-colors ${
        expanded ? 'border-gray-200 shadow-sm' : 'border-gray-200 hover:border-gray-300'
      }`}
    >
      {/* Summary row */}
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 p-4 text-left"
      >
        {/* Countdown */}
        <span className={`w-16 shrink-0 text-xs tabular-nums ${countdownColor(remaining)}`}>
          {formatCountdown(remaining)}
        </span>

        {/* Tool name */}
        <span className="min-w-0 flex-1 truncate font-mono text-sm text-gray-900">
          {ticket.tool_name}
        </span>

        {/* Session / Agent ID */}
        <span className="hidden w-20 shrink-0 truncate text-xs text-gray-500 sm:block">
          {truncateId(ticket.session_id)}
        </span>

        {/* Matched rule */}
        {ticket.matched_rule && (
          <span className="hidden shrink-0 truncate font-mono text-xs text-gray-400 lg:block lg:max-w-32">
            {ticket.matched_rule}
          </span>
        )}

        {/* Time since requested */}
        <span
          className="w-14 shrink-0 text-right text-xs text-gray-400"
          title={ticket.requested_at}
        >
          {timeAgo(ticket.requested_at)}
        </span>

        {/* Expand chevron */}
        <svg
          className={`h-4 w-4 shrink-0 text-gray-400 transition-transform ${expanded ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={2}
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="m19 9-7 7-7-7" />
        </svg>
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t border-gray-100 px-4 pb-4 pt-3 space-y-3 text-sm">
          <DetailSection label="Input">
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap wrap-break-word rounded bg-gray-50 p-2 text-xs">
              {inputPreview.text}
            </pre>
            {inputPreview.truncated && (
              <p className="mt-1 text-[11px] text-amber-700">
                Input payload preview is truncated for readability.
              </p>
            )}
          </DetailSection>

          <DetailSection label="Session ID">
            <span className="font-mono text-xs">{ticket.session_id ?? '\u2014'}</span>
          </DetailSection>

          <DetailSection label="Channel">
            <span className="text-xs">{ticket.channel_name}</span>
          </DetailSection>

          {ticket.matched_rule && (
            <DetailSection label="Matched Rule">
              <span className="font-mono text-xs">{ticket.matched_rule}</span>
            </DetailSection>
          )}

          <DetailSection label="Requested At">
            <span className="text-xs tabular-nums">{formatTimestamp(ticket.requested_at)}</span>
          </DetailSection>

          <DetailSection label="Timeout At">
            <span className="text-xs tabular-nums">{formatTimestamp(ticket.timeout_at)}</span>
          </DetailSection>

          {ticket.escalated_at && (
            <DetailSection label="Escalated">
              <span className="text-xs">
                {formatTimestamp(ticket.escalated_at)}
                {ticket.escalated_to && ticket.escalated_to.length > 0
                  ? ` \u2192 ${ticket.escalated_to.join(', ')}`
                  : ''}
              </span>
            </DetailSection>
          )}

          {ticket.notification_failures && ticket.notification_failures.length > 0 && (
            <DetailSection label="Notification Failures">
              <ul className="space-y-1 text-xs text-red-700">
                {ticket.notification_failures.map((failure, idx) => (
                  <li key={`${failure.failed_at}-${failure.phase}-${String(idx)}`}>
                    {formatTimestamp(failure.failed_at)} - {failure.phase} via {failure.channel}:{' '}
                    {failure.error}
                  </li>
                ))}
              </ul>
            </DetailSection>
          )}

          {/* Actions */}
          <div className="pt-1">
            <ApprovalActions ticketId={ticket.id} status={ticket.status} onResolved={onResolved} />
          </div>
        </div>
      )}
    </div>
  )
}

function ResolvedRow({
  ticket,
  expanded,
  onToggle,
}: {
  ticket: ApprovalTicket
  expanded: boolean
  onToggle: () => void
}) {
  const inputPreview = stringifyForDisplay(ticket.tool_input)

  return (
    <>
      <tr
        onClick={onToggle}
        className={`cursor-pointer border-b border-gray-100 hover:bg-gray-50 ${
          expanded ? 'bg-blue-50' : ''
        }`}
      >
        <td className="py-2.5 pr-4 text-xs tabular-nums text-gray-600">
          {ticket.resolved_at ? formatTimestamp(ticket.resolved_at) : '\u2014'}
        </td>
        <td className="py-2.5 pr-4 font-mono text-sm text-gray-900">{ticket.tool_name}</td>
        <td className="py-2.5 pr-4">
          <ApprovalStatusBadge status={ticket.status} />
        </td>
        <td className="py-2.5 pr-4 text-xs text-gray-600">{ticket.resolved_by ?? '\u2014'}</td>
        <td className="hidden py-2.5 pr-4 text-xs text-gray-500 md:table-cell">
          <span className="line-clamp-1">{resolvedReason(ticket)}</span>
        </td>
        <td className="hidden py-2.5 text-xs text-gray-500 sm:table-cell">
          {truncateId(ticket.session_id)}
        </td>
      </tr>

      {/* Expanded detail row */}
      {expanded && (
        <tr>
          <td colSpan={6} className="border-b border-gray-100 bg-gray-50 px-4 py-3">
            <div className="space-y-3 text-sm">
              <DetailSection label="Input">
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap wrap-break-word rounded bg-white p-2 text-xs">
                  {inputPreview.text}
                </pre>
                {inputPreview.truncated && (
                  <p className="mt-1 text-[11px] text-amber-700">
                    Input payload preview is truncated for readability.
                  </p>
                )}
              </DetailSection>

              <DetailSection label="Requested At">
                <span className="text-xs tabular-nums">{formatTimestamp(ticket.requested_at)}</span>
              </DetailSection>

              <DetailSection label="Timeout At">
                <span className="text-xs tabular-nums">{formatTimestamp(ticket.timeout_at)}</span>
              </DetailSection>

              {ticket.resolved_at && (
                <DetailSection label="Resolved At">
                  <span className="text-xs tabular-nums">
                    {formatTimestamp(ticket.resolved_at)}
                  </span>
                </DetailSection>
              )}

              {ticket.denial_reason && (
                <DetailSection label="Denial Reason">
                  <span className="text-xs">{ticket.denial_reason}</span>
                </DetailSection>
              )}

              {ticket.break_glass_reason && (
                <DetailSection label="Break-Glass Reason">
                  <span className="text-xs text-amber-700">{ticket.break_glass_reason}</span>
                </DetailSection>
              )}

              {ticket.escalated_at && (
                <DetailSection label="Escalated">
                  <span className="text-xs">
                    {formatTimestamp(ticket.escalated_at)}
                    {ticket.escalated_to && ticket.escalated_to.length > 0
                      ? ` \u2192 ${ticket.escalated_to.join(', ')}`
                      : ''}
                  </span>
                </DetailSection>
              )}

              <DetailSection label="Channel">
                <span className="text-xs">{ticket.channel_name}</span>
              </DetailSection>

              {ticket.matched_rule && (
                <DetailSection label="Matched Rule">
                  <span className="font-mono text-xs">{ticket.matched_rule}</span>
                </DetailSection>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}
