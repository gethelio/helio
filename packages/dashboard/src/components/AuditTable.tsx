import type { AuditRecord } from '../types'
import { formatTimestamp, truncateId, formatLatency } from '../utils'
import { OriginBadge } from './OriginBadge'
import { PolicyBadge } from './PolicyBadge'

const PAGE_SIZES = [10, 25, 50] as const

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface AuditTableProps {
  records: readonly AuditRecord[]
  selectedId: string | null
  page: number
  totalPages: number
  limit: number
  loading: boolean
  onRowClick: (id: string) => void
  onPageChange: (page: number) => void
  onLimitChange: (limit: number) => void
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AuditTable({
  records,
  selectedId,
  page,
  totalPages,
  limit,
  loading,
  onRowClick,
  onPageChange,
  onLimitChange,
}: AuditTableProps) {
  // -- Empty state ----------------------------------------------------------
  if (records.length === 0 && !loading) {
    return null
  }

  return (
    <>
      {/* Loading overlay for filter changes */}
      {loading && (
        <div className="mb-3 h-0.5 overflow-hidden rounded-full bg-gray-100">
          <div className="h-full w-1/3 animate-pulse rounded-full bg-gray-300" />
        </div>
      )}

      {/* Table */}
      {records.length > 0 && (
        <div className="flex-1 overflow-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-xs font-medium text-gray-500">
                <th scope="col" className="pb-2 pr-4 font-medium">
                  Timestamp
                </th>
                <th scope="col" className="pb-2 pr-4 font-medium">
                  Tool
                </th>
                <th scope="col" className="pb-2 pr-4 font-medium">
                  Origin
                </th>
                <th scope="col" className="pb-2 pr-4 font-medium">
                  Decision
                </th>
                <th scope="col" className="hidden pb-2 pr-4 font-medium sm:table-cell">
                  Session / Agent
                </th>
                <th scope="col" className="hidden pb-2 pr-4 font-medium md:table-cell">
                  Channel
                </th>
                <th scope="col" className="hidden pb-2 pr-4 font-medium md:table-cell">
                  Sender
                </th>
                <th scope="col" className="pb-2 pr-4 text-right font-medium">
                  Duration
                </th>
                <th scope="col" className="pb-2 font-medium">
                  {/* Destructive flag — no header text */}
                </th>
              </tr>
            </thead>
            <tbody>
              {records.map((record) => (
                <tr
                  key={record.id}
                  onClick={() => {
                    onRowClick(record.id)
                  }}
                  className={`cursor-pointer border-b border-gray-100 transition-colors ${
                    selectedId === record.id ? 'bg-blue-50' : 'hover:bg-gray-50'
                  }`}
                >
                  <td className="whitespace-nowrap py-2.5 pr-4 text-xs tabular-nums text-gray-500">
                    {formatTimestamp(record.timestamp)}
                  </td>
                  <td className="py-2.5 pr-4 font-mono text-sm text-gray-900">
                    {record.tool_name}
                  </td>
                  <td className="py-2.5 pr-4">
                    <OriginBadge origin={record.origin} recordKind={record.record_kind} />
                  </td>
                  <td className="py-2.5 pr-4">
                    <PolicyBadge
                      policyDecision={record.policy_decision}
                      blockReason={record.block_reason}
                      approvalStatus={record.approval_status}
                      dryRun={record.dry_run}
                    />
                  </td>
                  <td className="hidden py-2.5 pr-4 text-xs text-gray-500 sm:table-cell">
                    {truncateId(record.agent_id ?? record.session_id)}
                  </td>
                  <td className="hidden py-2.5 pr-4 text-xs text-gray-500 md:table-cell">
                    {typeof record.metadata?.channel_id === 'string'
                      ? record.metadata.channel_id
                      : '—'}
                  </td>
                  <td className="hidden py-2.5 pr-4 text-xs text-gray-500 md:table-cell">
                    {typeof record.metadata?.sender_id === 'string'
                      ? record.metadata.sender_id
                      : '—'}
                  </td>
                  <td className="py-2.5 pr-4 text-right text-xs tabular-nums text-gray-500">
                    {formatLatency(record.total_duration_ms)}
                  </td>
                  <td className="py-2.5">
                    {record.flagged_destructive && (
                      <span
                        className="inline-block h-2 w-2 rounded-full bg-red-400"
                        title="Destructive"
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {totalPages > 0 && (
        <div className="flex items-center justify-between border-t border-gray-200 pt-3 mt-auto">
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => {
                onPageChange(page - 1)
              }}
              className="rounded-md border border-gray-200 bg-white px-2.5 py-1 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Previous
            </button>
            <span className="text-xs text-gray-500">
              Page {page} of {totalPages}
            </span>
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => {
                onPageChange(page + 1)
              }}
              className="rounded-md border border-gray-200 bg-white px-2.5 py-1 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Next
            </button>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">Rows per page</span>
            <select
              value={limit}
              onChange={(e) => {
                onLimitChange(Number(e.target.value))
              }}
              className="rounded-md border border-gray-200 bg-white px-2 py-1 text-xs text-gray-600 focus:border-gray-300 focus:outline-none"
            >
              {PAGE_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}
    </>
  )
}
