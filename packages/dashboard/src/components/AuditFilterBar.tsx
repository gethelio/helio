import { useCallback, useEffect, useRef, useState } from 'react'
import type { AuditFilters } from '../useAuditQuery'
import { DECISION_FILTERS, TIME_FILTERS } from '../constants'
import { outcomeFilterToAuditParams } from '../outcome'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function localToIso(local: string): string {
  if (!local) return ''
  return new Date(local).toISOString()
}

function isoToLocal(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function buildExportUrl(
  format: 'json' | 'csv',
  filters: {
    tool: string
    decision: AuditFilters['decision']
    reason: string | null
    session: string
    from: string
    to: string
    upstream_status_min: string
    upstream_status_max: string
    origin: string
    record_kind: string
    channel: string
    sender: string
  },
): string {
  const outcomeParams = outcomeFilterToAuditParams(filters.decision)
  const params = new URLSearchParams()
  params.set('format', format)
  if (filters.tool) params.set('tool', filters.tool)
  if (outcomeParams.decision) params.set('decision', outcomeParams.decision)
  const reason = filters.reason ?? outcomeParams.reason
  if (reason) params.set('reason', reason)
  if (outcomeParams.blocked !== undefined) params.set('blocked', String(outcomeParams.blocked))
  if (outcomeParams.dry_run !== undefined) params.set('dry_run', String(outcomeParams.dry_run))
  if (filters.session) params.set('session', filters.session)
  if (filters.from) params.set('from', filters.from)
  if (filters.to) params.set('to', filters.to)
  if (filters.upstream_status_min) params.set('upstream_status_min', filters.upstream_status_min)
  if (filters.upstream_status_max) params.set('upstream_status_max', filters.upstream_status_max)
  if (filters.origin) params.set('origin', filters.origin)
  if (filters.record_kind) params.set('record_kind', filters.record_kind)
  if (filters.channel) params.set('channel_id', filters.channel)
  if (filters.sender) params.set('sender_id', filters.sender)
  return `/api/audit/export?${params.toString()}`
}

const BLOCK_REASON_FILTERS: ReadonlyArray<{ label: string; value: string | null }> = [
  { label: 'All Reasons', value: null },
  { label: 'Policy Denied', value: 'policy_denied' },
  { label: 'Evidence Missing', value: 'evidence_missing' },
  { label: 'Evidence Expired', value: 'evidence_expired' },
  { label: 'Dependency Missing', value: 'dependency_missing' },
  { label: 'Approval Denied', value: 'approval_denied' },
  { label: 'Approval Timeout', value: 'approval_timeout' },
  { label: 'Client Disconnected', value: 'client_disconnected' },
  { label: 'Shutdown Cancelled', value: 'shutdown_cancelled' },
  { label: 'Install Denied', value: 'install_denied' },
  { label: 'Rate Limited', value: 'rate_limited' },
  { label: 'Spend Limited', value: 'spend_limited' },
]

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface AuditFilterBarProps {
  filters: AuditFilters
  setFilter: <K extends keyof AuditFilters>(key: K, value: AuditFilters[K]) => void
  setBulkFilters: (patch: Partial<AuditFilters>) => void
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AuditFilterBar({ filters, setFilter, setBulkFilters }: AuditFilterBarProps) {
  // -- Time range preset state ----------------------------------------------
  const [timePreset, setTimePreset] = useState<number | null | 'custom'>(null)

  // -- Export dropdown state ------------------------------------------------
  const [exportOpen, setExportOpen] = useState(false)
  const [exportBusy, setExportBusy] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const exportRef = useRef<HTMLDivElement>(null)

  // Close dropdown on outside click
  useEffect(() => {
    if (!exportOpen) return
    const handler = (e: MouseEvent) => {
      if (exportRef.current && !exportRef.current.contains(e.target as Node)) {
        setExportOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => {
      document.removeEventListener('mousedown', handler)
    }
  }, [exportOpen])

  // Close dropdown on Escape
  useEffect(() => {
    if (!exportOpen) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExportOpen(false)
    }
    document.addEventListener('keydown', handler)
    return () => {
      document.removeEventListener('keydown', handler)
    }
  }, [exportOpen])

  const handleExport = useCallback(
    async (format: 'json' | 'csv') => {
      setExportOpen(false)
      setExportError(null)
      setExportBusy(true)
      try {
        const url = buildExportUrl(format, filters)
        const res = await fetch(url)
        if (!res.ok) {
          const text = await res.text().catch(() => '')
          throw new Error(text || `Export failed (${String(res.status)})`)
        }

        const blob = await res.blob()
        const objectUrl = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = objectUrl
        a.download = `helio-audit-export.${format}`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(objectUrl)
      } catch (err) {
        setExportError(err instanceof Error ? err.message : 'Failed to export audit records')
      } finally {
        setExportBusy(false)
      }
    },
    [filters],
  )

  const handleTimePreset = useCallback(
    (ms: number | null) => {
      setTimePreset(ms)
      if (ms === null) {
        setBulkFilters({ from: '', to: '' })
      } else {
        setBulkFilters({ from: new Date(Date.now() - ms).toISOString(), to: '' })
      }
    },
    [setBulkFilters],
  )

  const handleCustomTime = useCallback(() => {
    setTimePreset('custom')
  }, [])

  return (
    <>
      {/* Row 1: tool search + decision pills */}
      <div className="flex flex-wrap items-center gap-3 pb-3">
        <input
          type="text"
          placeholder="Filter by tool name…"
          value={filters.tool}
          onChange={(e) => {
            setFilter('tool', e.target.value)
          }}
          className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-gray-300 focus:outline-none"
        />

        <div className="flex flex-wrap gap-1.5">
          {DECISION_FILTERS.map(({ label, value }) => (
            <button
              key={label}
              type="button"
              onClick={() => {
                setFilter('decision', value)
              }}
              aria-pressed={filters.decision === value}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                filters.decision === value
                  ? 'bg-gray-900 text-white'
                  : 'border border-gray-200 bg-white text-gray-600 hover:bg-gray-50'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <select
          value={filters.reason ?? ''}
          onChange={(e) => {
            setFilter('reason', e.target.value || null)
          }}
          className="rounded-md border border-gray-200 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 focus:border-gray-300 focus:outline-none"
        >
          {BLOCK_REASON_FILTERS.map((option) => (
            <option key={option.label} value={option.value ?? ''}>
              {option.label}
            </option>
          ))}
        </select>

        <input
          type="text"
          aria-label="Origin"
          placeholder="Origin (e.g. openclaw)…"
          value={filters.origin}
          onChange={(e) => {
            setFilter('origin', e.target.value)
          }}
          className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-gray-300 focus:outline-none"
        />

        <select
          aria-label="Record Kind"
          value={filters.record_kind}
          onChange={(e) => {
            setFilter('record_kind', e.target.value)
          }}
          className="rounded-md border border-gray-200 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 focus:border-gray-300 focus:outline-none"
        >
          <option value="">All Kinds</option>
          <option value="tool_call">Tool Call</option>
          <option value="install_scan">Install Scan</option>
          <option value="drift_event">Drift</option>
          <option value="evaluation_expired">Expired</option>
        </select>
      </div>

      {/* Row 2: time range + session + export */}
      <div className="flex flex-wrap items-center gap-3 pb-4">
        {/* Time presets */}
        <div className="flex gap-1.5">
          {TIME_FILTERS.map(({ label, ms }) => (
            <button
              key={label}
              type="button"
              onClick={() => {
                handleTimePreset(ms)
              }}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                timePreset === ms
                  ? 'bg-gray-900 text-white'
                  : 'border border-gray-200 bg-white text-gray-600 hover:bg-gray-50'
              }`}
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            onClick={handleCustomTime}
            className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
              timePreset === 'custom'
                ? 'bg-gray-900 text-white'
                : 'border border-gray-200 bg-white text-gray-600 hover:bg-gray-50'
            }`}
          >
            Custom
          </button>
        </div>

        {/* Custom time inputs */}
        {timePreset === 'custom' && (
          <>
            <input
              type="datetime-local"
              value={isoToLocal(filters.from)}
              onChange={(e) => {
                setFilter('from', localToIso(e.target.value))
              }}
              className="rounded-md border border-gray-200 bg-white px-2 py-1 text-xs text-gray-900 focus:border-gray-300 focus:outline-none"
            />
            <span className="text-xs text-gray-400">to</span>
            <input
              type="datetime-local"
              value={isoToLocal(filters.to)}
              onChange={(e) => {
                setFilter('to', localToIso(e.target.value))
              }}
              className="rounded-md border border-gray-200 bg-white px-2 py-1 text-xs text-gray-900 focus:border-gray-300 focus:outline-none"
            />
          </>
        )}

        {/* Session ID */}
        <input
          type="text"
          placeholder="Session ID…"
          value={filters.session}
          onChange={(e) => {
            setFilter('session', e.target.value)
          }}
          className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-gray-300 focus:outline-none"
        />

        <input
          type="text"
          placeholder="Channel ID…"
          value={filters.channel}
          onChange={(e) => {
            setFilter('channel', e.target.value)
          }}
          className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-gray-300 focus:outline-none"
        />

        <input
          type="text"
          placeholder="Sender ID…"
          value={filters.sender}
          onChange={(e) => {
            setFilter('sender', e.target.value)
          }}
          className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-gray-300 focus:outline-none"
        />

        <input
          type="number"
          min={100}
          max={599}
          placeholder="Status min"
          value={filters.upstream_status_min}
          onChange={(e) => {
            setFilter('upstream_status_min', e.target.value)
          }}
          className="w-28 rounded-md border border-gray-200 bg-white px-2 py-1.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-gray-300 focus:outline-none"
        />

        <input
          type="number"
          min={100}
          max={599}
          placeholder="Status max"
          value={filters.upstream_status_max}
          onChange={(e) => {
            setFilter('upstream_status_max', e.target.value)
          }}
          className="w-28 rounded-md border border-gray-200 bg-white px-2 py-1.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-gray-300 focus:outline-none"
        />

        <div className="flex-1" />

        {/* Export dropdown */}
        <div ref={exportRef} className="relative">
          <button
            type="button"
            onClick={() => {
              setExportOpen((o) => !o)
            }}
            aria-expanded={exportOpen}
            aria-haspopup="menu"
            className="flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-50"
          >
            Export
            <svg
              className={`h-4 w-4 text-gray-400 transition-transform ${exportOpen ? 'rotate-180' : ''}`}
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={2}
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="m19 9-7 7-7-7" />
            </svg>
          </button>

          {exportOpen && (
            <div className="absolute right-0 z-10 mt-1 w-36 rounded-md border border-gray-200 bg-white py-1 shadow-lg">
              <button
                type="button"
                onClick={() => {
                  void handleExport('json')
                }}
                disabled={exportBusy}
                className="block w-full px-3 py-1.5 text-left text-sm text-gray-700 hover:bg-gray-50"
              >
                Export JSON
              </button>
              <button
                type="button"
                onClick={() => {
                  void handleExport('csv')
                }}
                disabled={exportBusy}
                className="block w-full px-3 py-1.5 text-left text-sm text-gray-700 hover:bg-gray-50"
              >
                Export CSV
              </button>
            </div>
          )}
        </div>
      </div>
      {exportError && <p className="pb-2 text-xs text-red-600">{exportError}</p>}
    </>
  )
}
