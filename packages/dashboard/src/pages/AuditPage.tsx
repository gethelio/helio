import { useCallback, useEffect, useState } from 'react'
import type { AuditRecord } from '../types'
import { fetchAuditRecord } from '../api'
import { useAuditQuery } from '../useAuditQuery'
import { useEventSourceContext } from '../EventSourceContext'
import { AuditFilterBar } from '../components/AuditFilterBar'
import { AuditTable } from '../components/AuditTable'
import { AuditDetailPanel } from '../components/AuditDetailPanel'
import { PageError } from '../components/PageError'

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AuditPage() {
  const {
    data,
    loading,
    error,
    filters,
    page,
    limit,
    setFilter,
    setBulkFilters,
    setPage,
    setLimit,
    refetch,
  } = useAuditQuery()

  // -- SSE new-records banner -----------------------------------------------
  const { subscribe } = useEventSourceContext()
  const [newCount, setNewCount] = useState(0)

  useEffect(() => {
    return subscribe('action', () => {
      setNewCount((c) => c + 1)
    })
  }, [subscribe])

  const refreshAfterNew = useCallback(() => {
    setNewCount(0)
    refetch()
  }, [refetch])

  // -- Detail slide-out state -----------------------------------------------
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedRecord, setSelectedRecord] = useState<AuditRecord | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)

  const handleRowClick = useCallback(
    (id: string) => {
      if (selectedId === id) {
        setSelectedId(null)
        setSelectedRecord(null)
        return
      }
      setSelectedId(id)
      setSelectedRecord(null)
      setDetailError(null)
      setDetailLoading(true)

      fetchAuditRecord(id)
        .then((rec) => {
          setSelectedId((current) => {
            if (current === id) {
              setSelectedRecord(rec)
              setDetailLoading(false)
            }
            return current
          })
        })
        .catch((err: unknown) => {
          setSelectedId((current) => {
            if (current === id) {
              setDetailLoading(false)
              setDetailError(err instanceof Error ? err.message : 'Failed to load record details')
            }
            return current
          })
        })
    },
    [selectedId],
  )

  const closePanel = useCallback(() => {
    setSelectedId(null)
    setSelectedRecord(null)
  }, [])

  // -- Escape key to close panel --------------------------------------------
  useEffect(() => {
    if (!selectedId) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closePanel()
    }
    document.addEventListener('keydown', handler)
    return () => {
      document.removeEventListener('keydown', handler)
    }
  }, [selectedId, closePanel])

  // -- Derived values -------------------------------------------------------
  const totalPages = data ? Math.ceil(data.total / limit) : 0
  const records = data?.data ?? []

  // -- Loading state --------------------------------------------------------
  if (loading && !data) {
    return (
      <div className="flex h-full flex-col gap-3">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="h-12 animate-pulse rounded-md bg-gray-100" />
        ))}
      </div>
    )
  }

  // -- Error state ----------------------------------------------------------
  if (error && !data) {
    return <PageError error={error} />
  }

  // -- Render ---------------------------------------------------------------
  return (
    <div className="flex h-full flex-col">
      {/* Page title */}
      <div className="mb-4">
        <h1 className="text-lg font-semibold text-gray-900">Audit Log</h1>
        <p className="mt-1 text-sm text-gray-500">Searchable history of all tool calls</p>
      </div>

      {/* SSE new-records banner */}
      {newCount > 0 && (
        <button
          type="button"
          onClick={refreshAfterNew}
          className="mb-3 w-full rounded-md bg-blue-50 px-3 py-2 text-center text-sm font-medium text-blue-700 transition-colors hover:bg-blue-100"
        >
          {newCount} new {newCount === 1 ? 'record' : 'records'} available — click to refresh
        </button>
      )}

      <AuditFilterBar filters={filters} setFilter={setFilter} setBulkFilters={setBulkFilters} />

      {/* Empty state */}
      {records.length === 0 && !loading && (
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
              d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 0 0 2.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 0 0-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75 2.25 2.25 0 0 0-.1-.664m-5.8 0A2.251 2.251 0 0 1 13.5 2.25H15a2.25 2.25 0 0 1 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25ZM6.75 12h.008v.008H6.75V12Zm0 3h.008v.008H6.75V15Zm0 3h.008v.008H6.75V18Z"
            />
          </svg>
          {data &&
          data.total === 0 &&
          !filters.tool &&
          !filters.decision &&
          !filters.reason &&
          !filters.session &&
          !filters.from &&
          !filters.to &&
          !filters.upstream_status_min &&
          !filters.upstream_status_max ? (
            <>
              <p className="text-sm font-medium">No audit records yet</p>
              <p className="text-xs text-gray-400">Start sending tool calls through Helio</p>
            </>
          ) : (
            <p className="text-sm font-medium">No records match the current filters</p>
          )}
        </div>
      )}

      <AuditTable
        records={records}
        selectedId={selectedId}
        page={page}
        totalPages={totalPages}
        limit={limit}
        loading={!!(loading && data)}
        onRowClick={handleRowClick}
        onPageChange={setPage}
        onLimitChange={setLimit}
      />

      {selectedId && (
        <AuditDetailPanel
          selectedRecord={selectedRecord}
          detailLoading={detailLoading}
          detailError={detailError}
          onClose={closePanel}
        />
      )}
    </div>
  )
}
