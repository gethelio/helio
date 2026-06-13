import { memo } from 'react'
import type { ApprovalStatus } from '../types'
import { formatLabel } from '../utils'

interface ApprovalStatusBadgeProps {
  status: ApprovalStatus
}

const COLORS: Record<ApprovalStatus, string> = {
  pending: 'bg-amber-50 text-amber-700 ring-amber-600/20',
  approved: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  denied: 'bg-red-50 text-red-700 ring-red-600/20',
  timeout: 'bg-orange-50 text-orange-700 ring-orange-600/20',
  break_glass: 'bg-purple-50 text-purple-700 ring-purple-600/20',
  client_disconnected: 'bg-gray-100 text-gray-700 ring-gray-500/20',
  shutdown_cancelled: 'bg-slate-100 text-slate-700 ring-slate-500/20',
  cancelled: 'bg-slate-100 text-slate-700 ring-slate-500/20',
}

export const ApprovalStatusBadge = memo(function ApprovalStatusBadge({
  status,
}: ApprovalStatusBadgeProps) {
  const colors = COLORS[status]

  return (
    <span
      className={`inline-flex items-center rounded-md px-2 py-1 text-xs font-medium ring-1 ring-inset ${colors}`}
    >
      {formatLabel(status)}
    </span>
  )
})
