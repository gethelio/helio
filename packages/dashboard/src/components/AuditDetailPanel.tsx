import type { AuditRecord } from '../types'
import { formatTimestamp, formatLatency, stringifyForDisplay, truncateForDisplay } from '../utils'
import { PolicyBadge } from './PolicyBadge'
import { EvidenceChain } from './EvidenceChain'
import { DetailSection } from './DetailSection'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface AuditDetailPanelProps {
  selectedRecord: AuditRecord | null
  detailLoading: boolean
  detailError: string | null
  onClose: () => void
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AuditDetailPanel({
  selectedRecord,
  detailLoading,
  detailError,
  onClose,
}: AuditDetailPanelProps) {
  const toolInputPreview = selectedRecord ? stringifyForDisplay(selectedRecord.tool_input) : null
  const upstreamResponsePreview =
    selectedRecord?.upstream_response != null
      ? stringifyForDisplay(selectedRecord.upstream_response)
      : null

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/10"
        onClick={onClose}
        role="button"
        tabIndex={-1}
        aria-label="Close detail panel"
      />

      {/* Panel */}
      <div
        role="dialog"
        aria-label="Audit record details"
        className="fixed inset-y-0 right-0 z-50 w-full max-w-[480px] overflow-y-auto border-l border-gray-200 bg-white shadow-lg"
      >
        {/* Panel header */}
        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate font-mono text-sm font-semibold text-gray-900">
              {selectedRecord?.tool_name ?? 'Loading\u2026'}
            </h2>
            {selectedRecord && (
              <p className="text-xs text-gray-500">{formatTimestamp(selectedRecord.timestamp)}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ml-3 shrink-0 rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            aria-label="Close"
          >
            <svg
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={2}
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Panel body */}
        <div className="px-4 py-4">
          {detailLoading && !selectedRecord && (
            <div className="space-y-3">
              <div className="h-4 w-1/3 animate-pulse rounded bg-gray-100" />
              <div className="h-24 animate-pulse rounded bg-gray-100" />
              <div className="h-4 w-1/4 animate-pulse rounded bg-gray-100" />
              <div className="h-16 animate-pulse rounded bg-gray-100" />
            </div>
          )}

          {selectedRecord && (
            <div className="space-y-4 text-sm">
              {/* Decision */}
              <DetailSection label="Decision">
                <PolicyBadge
                  policyDecision={selectedRecord.policy_decision}
                  blockReason={selectedRecord.block_reason}
                  approvalStatus={selectedRecord.approval_status}
                  dryRun={selectedRecord.dry_run}
                  showContext={true}
                />
              </DetailSection>

              {/* Input parameters */}
              <DetailSection label="Input Parameters">
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap wrap-break-word rounded bg-gray-50 p-2 text-xs">
                  {toolInputPreview?.text}
                </pre>
                {toolInputPreview?.truncated && (
                  <p className="mt-1 text-[11px] text-amber-700">
                    Input payload preview is truncated for readability.
                  </p>
                )}
              </DetailSection>

              {/* Evidence chain */}
              {selectedRecord.evidence_chain && (
                <DetailSection label="Evidence Chain">
                  <EvidenceChain chain={selectedRecord.evidence_chain} />
                </DetailSection>
              )}

              {/* Matched rule */}
              {selectedRecord.matched_rule && (
                <DetailSection label="Matched Rule">
                  <span className="font-mono text-xs">{selectedRecord.matched_rule}</span>
                </DetailSection>
              )}

              {/* Approval details */}
              {selectedRecord.approval_status && (
                <DetailSection label="Approval">
                  <span className="text-xs">
                    {selectedRecord.approval_status}
                    {selectedRecord.approved_by ? ` by ${selectedRecord.approved_by}` : ''}
                  </span>
                </DetailSection>
              )}

              {/* Upstream response — capped at 4 KB via stringifyForDisplay.
                  A 1 MB upstream payload (or a JSON string field with
                  megabytes of unbroken text) would otherwise force
                  JSON.stringify to render the full value on every paint
                  and horizontally overflow the detail panel. */}
              {selectedRecord.upstream_response != null && (
                <DetailSection label="Upstream Response">
                  <pre
                    data-testid="upstream-response-json"
                    className="max-h-64 overflow-auto whitespace-pre-wrap wrap-break-word rounded bg-gray-50 p-2 text-xs"
                  >
                    {upstreamResponsePreview?.text}
                  </pre>
                  {upstreamResponsePreview?.truncated && (
                    <p className="mt-1 text-[11px] text-amber-700">
                      Upstream response preview is truncated for readability.
                    </p>
                  )}
                </DetailSection>
              )}

              {/* Upstream error — capped at 4 KB to defend the detail panel
                  layout against upstream-controlled error strings (a 1 MB
                  error message or pathological control characters would
                  otherwise break scrolling or hang the panel). */}
              {selectedRecord.upstream_error && (
                <DetailSection label="Upstream Error">
                  <span className="text-xs text-red-600 whitespace-pre-wrap wrap-break-word">
                    {truncateForDisplay(selectedRecord.upstream_error)}
                  </span>
                </DetailSection>
              )}

              {/* Duration breakdown */}
              <DetailSection label="Duration">
                <div className="space-y-0.5 text-xs tabular-nums text-gray-600">
                  <p>Total: {formatLatency(selectedRecord.total_duration_ms)}</p>
                  <p>Proxy compute: {formatLatency(selectedRecord.proxy_compute_ms)}</p>
                  {selectedRecord.approval_wait_ms > 0 && (
                    <p>Approval wait: {formatLatency(selectedRecord.approval_wait_ms)}</p>
                  )}
                  {selectedRecord.upstream_latency_ms != null && (
                    <p>Upstream: {formatLatency(selectedRecord.upstream_latency_ms)}</p>
                  )}
                </div>
              </DetailSection>

              {/* Flags */}
              {(selectedRecord.flagged_destructive || selectedRecord.dry_run) && (
                <DetailSection label="Flags">
                  <div className="flex gap-2">
                    {selectedRecord.flagged_destructive && (
                      <span className="inline-flex items-center rounded-md bg-red-50 px-2 py-1 text-xs font-medium text-red-700 ring-1 ring-inset ring-red-600/20">
                        Destructive
                      </span>
                    )}
                    {selectedRecord.dry_run && (
                      <span className="inline-flex items-center rounded-md bg-blue-50 px-2 py-1 text-xs font-medium text-blue-700 ring-1 ring-inset ring-blue-600/20">
                        Dry Run
                      </span>
                    )}
                  </div>
                </DetailSection>
              )}
            </div>
          )}

          {!detailLoading && !selectedRecord && detailError && (
            <p className="text-xs text-red-600">{detailError}</p>
          )}
        </div>
      </div>
    </>
  )
}
