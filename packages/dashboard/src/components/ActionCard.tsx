import { memo, useEffect, useRef, useState } from 'react'
import type { AuditRecord, ActionEvent } from '../types'
import { timeAgo, truncateId, formatLatency } from '../utils'
import { PolicyBadge } from './PolicyBadge'
import { DetailSection } from './DetailSection'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type FeedItem = AuditRecord | ActionEvent

interface ActionCardProps {
  record: FeedItem
  expanded: boolean
  onToggle: () => void
  expandedRecord?: AuditRecord | null
  loading?: boolean
  error?: string | null
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isFullRecord(item: FeedItem): item is AuditRecord {
  return 'tool_input' in item
}

const MAX_DETAIL_JSON_CHARS = 8_000

function serializeForDetail(value: unknown): { text: string; truncated: boolean } {
  let text: string
  try {
    text = JSON.stringify(value, null, 2)
  } catch {
    return { text: '"[unserializable value]"', truncated: false }
  }

  if (text.length <= MAX_DETAIL_JSON_CHARS) {
    return { text, truncated: false }
  }

  const omitted = text.length - MAX_DETAIL_JSON_CHARS
  return {
    text: `${text.slice(0, MAX_DETAIL_JSON_CHARS)}\n… [truncated ${String(omitted)} chars]`,
    truncated: true,
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const ActionCard = memo(function ActionCard({
  record,
  expanded,
  onToggle,
  expandedRecord,
  loading,
  error,
}: ActionCardProps) {
  const [now, setNow] = useState(Date.now())
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Tick every 10s to keep relative timestamps fresh
  useEffect(() => {
    intervalRef.current = setInterval(() => {
      setNow(Date.now())
    }, 10_000)
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [])

  // Force re-render when `now` changes (used by timeAgo)
  void now

  const detail = expanded ? (isFullRecord(record) ? record : expandedRecord) : null
  const destructive = record.flagged_destructive
  const toolInputJson = detail ? serializeForDetail(detail.tool_input) : null
  const evidenceChainJson = detail?.evidence_chain
    ? serializeForDetail(detail.evidence_chain)
    : null
  const upstreamResponseJson =
    detail?.upstream_response != null ? serializeForDetail(detail.upstream_response) : null

  return (
    <div
      className={`rounded-md border bg-white transition-colors ${
        destructive ? 'border-l-2 border-l-red-400 border-gray-200' : 'border-gray-200'
      } ${expanded ? 'shadow-sm' : 'hover:border-gray-300'}`}
    >
      {/* Summary row */}
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 p-4 text-left"
      >
        <span className="w-16 shrink-0 text-xs text-gray-400" title={record.timestamp}>
          {timeAgo(record.timestamp)}
        </span>

        <span className="min-w-0 flex-1 truncate font-mono text-sm text-gray-900">
          {record.tool_name}
        </span>

        <span className="hidden w-20 shrink-0 truncate text-xs text-gray-500 sm:block">
          {truncateId(record.agent_id ?? record.session_id)}
        </span>

        <PolicyBadge
          policyDecision={record.policy_decision}
          blockReason={record.block_reason}
          approvalStatus={record.approval_status}
          dryRun={record.dry_run}
          showContext={true}
        />

        <span className="w-14 shrink-0 text-right text-xs tabular-nums text-gray-500">
          {formatLatency(record.total_duration_ms)}
        </span>

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
        <div className="border-t border-gray-100 px-4 pb-4 pt-3">
          {loading && !detail && (
            <div className="space-y-2">
              <div className="h-4 w-1/3 animate-pulse rounded bg-gray-100" />
              <div className="h-20 animate-pulse rounded bg-gray-100" />
            </div>
          )}

          {detail && (
            <div className="space-y-3 text-sm">
              {/* Input parameters */}
              <DetailSection label="Input">
                <pre className="max-h-48 overflow-auto rounded bg-gray-50 p-2 text-xs">
                  {toolInputJson?.text}
                </pre>
                {toolInputJson?.truncated && (
                  <p className="mt-1 text-[11px] text-amber-700">
                    Input payload preview is truncated for readability.
                  </p>
                )}
              </DetailSection>

              {/* Matched rule */}
              {detail.matched_rule && (
                <DetailSection label="Matched Rule">
                  <span className="font-mono text-xs">{detail.matched_rule}</span>
                </DetailSection>
              )}

              {/* Evidence chain */}
              {detail.evidence_chain && (
                <DetailSection label="Evidence Chain">
                  <pre className="max-h-48 overflow-auto rounded bg-gray-50 p-2 text-xs">
                    {evidenceChainJson?.text}
                  </pre>
                  {evidenceChainJson?.truncated && (
                    <p className="mt-1 text-[11px] text-amber-700">
                      Evidence payload preview is truncated for readability.
                    </p>
                  )}
                </DetailSection>
              )}

              {/* Upstream response */}
              {detail.upstream_response != null && (
                <DetailSection label="Upstream Response">
                  <pre className="max-h-48 overflow-auto rounded bg-gray-50 p-2 text-xs">
                    {upstreamResponseJson?.text}
                  </pre>
                  {upstreamResponseJson?.truncated && (
                    <p className="mt-1 text-[11px] text-amber-700">
                      Upstream response preview is truncated for readability.
                    </p>
                  )}
                </DetailSection>
              )}

              {/* Upstream error */}
              {detail.upstream_error && (
                <DetailSection label="Upstream Error">
                  <span className="text-xs text-red-600">{detail.upstream_error}</span>
                </DetailSection>
              )}

              {/* Approval info */}
              {detail.approval_status && (
                <DetailSection label="Approval">
                  <span className="text-xs">
                    {detail.approval_status}
                    {detail.approved_by ? ` by ${detail.approved_by}` : ''}
                  </span>
                </DetailSection>
              )}

              {/* Duration breakdown */}
              <DetailSection label="Duration">
                <div className="space-y-0.5 text-xs tabular-nums text-gray-600">
                  <p>Total: {formatLatency(detail.total_duration_ms)}</p>
                  <p>Proxy compute: {formatLatency(detail.proxy_compute_ms)}</p>
                  {detail.approval_wait_ms > 0 && (
                    <p>Approval wait: {formatLatency(detail.approval_wait_ms)}</p>
                  )}
                  {detail.upstream_latency_ms != null && (
                    <p>Upstream: {formatLatency(detail.upstream_latency_ms)}</p>
                  )}
                </div>
              </DetailSection>
            </div>
          )}

          {!loading && !detail && error && <p className="text-xs text-red-600">{error}</p>}

          {!loading && !detail && !error && (
            <p className="text-xs text-gray-400">No additional details available.</p>
          )}
        </div>
      )}
    </div>
  )
})
