import { useCallback, useEffect, useState } from 'react'
import type { AnalyticsResponse } from '../types'
import { MS_PER_DAY, TIME_PRESETS } from '../constants'
import { fetchAnalytics } from '../api'
import { TimeSeriesChart } from '../components/TimeSeriesChart'
import { DecisionPieChart } from '../components/DecisionPieChart'
import { TopToolsChart } from '../components/TopToolsChart'
import { PageError } from '../components/PageError'
import { formatLabel } from '../utils'

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AnalyticsPage() {
  const [data, setData] = useState<AnalyticsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activePreset, setActivePreset] = useState(MS_PER_DAY)

  // -- Fetch helper ---------------------------------------------------------
  const doFetch = useCallback(
    (isInitial: boolean) => {
      const from = new Date(Date.now() - activePreset).toISOString()
      fetchAnalytics(from, undefined)
        .then((res) => {
          setData(res)
          setError(null)
          if (isInitial) setLoading(false)
        })
        .catch((err: unknown) => {
          if (isInitial) {
            setError(err instanceof Error ? err.message : 'Failed to load analytics')
            setLoading(false)
          }
        })
    },
    [activePreset],
  )

  // -- Fetch on mount + preset change ---------------------------------------
  useEffect(() => {
    setLoading(true)
    doFetch(true)
  }, [doFetch])

  // -- Preset change handler ------------------------------------------------
  function handlePresetChange(ms: number) {
    if (ms === activePreset) return
    setActivePreset(ms)
  }

  // -- Loading state --------------------------------------------------------
  if (loading) {
    return (
      <div className="flex flex-col gap-6">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="h-20 animate-pulse rounded-md bg-gray-100" />
          ))}
        </div>
        <div className="h-64 animate-pulse rounded-md bg-gray-100" />
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="h-72 animate-pulse rounded-md bg-gray-100" />
          <div className="h-72 animate-pulse rounded-md bg-gray-100" />
        </div>
      </div>
    )
  }

  // -- Error state ----------------------------------------------------------
  if (error) {
    return <PageError error={error} />
  }

  // -- Empty state ----------------------------------------------------------
  if (!data || data.total === 0) {
    return (
      <div className="flex h-full flex-col gap-6">
        <div>
          <h1 className="text-lg font-semibold text-gray-900">Analytics</h1>
          <p className="mt-1 text-sm text-gray-500">Tool call volume and decision breakdown</p>
        </div>
        <TimeRangePills activePreset={activePreset} onPresetChange={handlePresetChange} />
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
              d="M10.5 6a7.5 7.5 0 1 0 7.5 7.5h-7.5V6Z"
            />
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M13.5 10.5H21A7.5 7.5 0 0 0 13.5 3v7.5Z"
            />
          </svg>
          <p className="text-sm font-medium">No data yet</p>
          <p className="text-xs text-gray-400">Start sending tool calls through Helio</p>
        </div>
      </div>
    )
  }

  // -- Derived values -------------------------------------------------------
  const allowed: string | number = data.allowed_total ?? '\u2014'
  const blocked: string | number = data.blocked_total ?? '\u2014'
  const blockedByReasonUnavailable = data.by_block_reason === undefined
  const blockedByReason = (data.by_block_reason ?? []).map((reasonCount) => ({
    tool_name: formatLabel(reasonCount.reason),
    count: reasonCount.count,
  }))
  const approvalRateDisplay =
    data.approval_rate != null ? `${String(Math.round(data.approval_rate * 100))}%` : '\u2014'

  // -- Render ---------------------------------------------------------------
  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto">
      {/* Page title */}
      <div>
        <h1 className="text-lg font-semibold text-gray-900">Analytics</h1>
        <p className="mt-1 text-sm text-gray-500">Tool call volume and decision breakdown</p>
      </div>

      {/* Time range pills */}
      <TimeRangePills activePreset={activePreset} onPresetChange={handlePresetChange} />

      {/* Summary stat cards */}
      <section>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Total Actions" value={data.total} />
          <StatCard label="Allowed" value={allowed} color="emerald" />
          <StatCard label="Blocked" value={blocked} color="red" />
          <StatCard label="Approval Rate" value={approvalRateDisplay} color="amber" />
        </div>
      </section>

      {/* Actions per hour chart */}
      <section>
        <h2 className="mb-3 text-sm font-medium text-gray-500">Actions Per Hour</h2>
        <div className="rounded-md border border-gray-200 bg-white p-4">
          <TimeSeriesChart data={data.per_hour} />
        </div>
      </section>

      {/* Two-column: Decision Breakdown + Top Tools */}
      <div className="grid gap-6 lg:grid-cols-2">
        <section>
          <h2 className="mb-3 text-sm font-medium text-gray-500">Matched Actions</h2>
          <div className="rounded-md border border-gray-200 bg-white p-4">
            {data.by_decision.length > 0 ? (
              <DecisionPieChart data={data.by_decision} />
            ) : (
              <p className="py-8 text-center text-sm text-gray-400">No decision data</p>
            )}
          </div>
        </section>

        <section>
          <h2 className="mb-3 text-sm font-medium text-gray-500">Top Tools</h2>
          <div className="rounded-md border border-gray-200 bg-white p-4">
            {data.top_tools.length > 0 ? (
              <TopToolsChart data={data.top_tools} />
            ) : (
              <p className="py-8 text-center text-sm text-gray-400">No tool data</p>
            )}
          </div>
        </section>
      </div>

      <section>
        <h2 className="mb-3 text-sm font-medium text-gray-500">Blocked by Reason</h2>
        <div className="rounded-md border border-gray-200 bg-white p-4">
          {blockedByReasonUnavailable ? (
            <p className="py-8 text-center text-sm text-gray-400">Requires a newer proxy version</p>
          ) : blockedByReason.length > 0 ? (
            <TopToolsChart data={blockedByReason} />
          ) : (
            <p className="py-8 text-center text-sm text-gray-400">No blocked actions</p>
          )}
        </div>
      </section>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function TimeRangePills({
  activePreset,
  onPresetChange,
}: {
  activePreset: number
  onPresetChange: (ms: number) => void
}) {
  return (
    <div className="flex gap-1.5">
      {TIME_PRESETS.map((preset) => (
        <button
          key={preset.label}
          type="button"
          onClick={() => {
            onPresetChange(preset.ms)
          }}
          className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
            activePreset === preset.ms
              ? 'bg-gray-900 text-white'
              : 'border border-gray-200 bg-white text-gray-600 hover:bg-gray-50'
          }`}
        >
          {preset.label}
        </button>
      ))}
    </div>
  )
}

const VALUE_COLORS: Record<'emerald' | 'red' | 'amber', string> = {
  emerald: 'text-emerald-700',
  red: 'text-red-700',
  amber: 'text-amber-700',
}

function StatCard({
  label,
  value,
  color,
}: {
  label: string
  value: string | number
  color?: 'emerald' | 'red' | 'amber'
}) {
  const valueColor = (color && VALUE_COLORS[color]) ?? 'text-gray-900'

  return (
    <div className="rounded-md border border-gray-200 bg-white p-4">
      <p className="text-sm font-medium text-gray-500">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${valueColor}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </p>
    </div>
  )
}
