import { memo } from 'react'
import { formatOrigin, formatRecordKind } from '../origin'

interface OriginBadgeProps {
  origin: string
  recordKind: string
}

const ORIGIN_COLORS: Record<string, string> = {
  mcp: 'bg-gray-100 text-gray-600 ring-gray-500/20',
}
const ORIGIN_DEFAULT = 'bg-indigo-50 text-indigo-700 ring-indigo-600/20' // adapters
const KIND_COLORS = 'bg-amber-50 text-amber-700 ring-amber-600/20'

export const OriginBadge = memo(function OriginBadge({ origin, recordKind }: OriginBadgeProps) {
  const originColors = ORIGIN_COLORS[origin] ?? ORIGIN_DEFAULT
  const kindLabel = formatRecordKind(recordKind)
  return (
    <div className="inline-flex items-center gap-1.5">
      <span
        className={`inline-flex items-center rounded-md px-2 py-1 text-xs font-medium ring-1 ring-inset ${originColors}`}
      >
        {formatOrigin(origin)}
      </span>
      {kindLabel && (
        <span
          className={`inline-flex items-center rounded-md px-2 py-1 text-xs font-medium ring-1 ring-inset ${KIND_COLORS}`}
        >
          {kindLabel}
        </span>
      )}
    </div>
  )
})
