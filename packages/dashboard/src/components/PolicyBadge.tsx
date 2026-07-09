import { memo } from 'react'
import { deriveDisplayOutcome, deriveOutcomeContext, formatDisplayOutcome } from '../outcome'

interface PolicyBadgeProps {
  policyDecision: string
  blockReason?: string | null
  approvalStatus?: string | null
  dryRun?: boolean
  showContext?: boolean
}

const COLORS: Record<string, string> = {
  allow: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  deny: 'bg-red-50 text-red-700 ring-red-600/20',
  rejected: 'bg-rose-50 text-rose-700 ring-rose-600/20',
  approval_denied: 'bg-red-50 text-red-700 ring-red-600/20',
  approval_timeout: 'bg-amber-50 text-amber-700 ring-amber-600/20',
  client_disconnected: 'bg-gray-100 text-gray-700 ring-gray-500/20',
  shutdown_cancelled: 'bg-slate-100 text-slate-700 ring-slate-500/20',
  rate_limited: 'bg-orange-50 text-orange-700 ring-orange-600/20',
  spend_limited: 'bg-purple-50 text-purple-700 ring-purple-600/20',
  budget_exceeded: 'bg-fuchsia-50 text-fuchsia-700 ring-fuchsia-600/20',
  dry_run: 'bg-blue-50 text-blue-700 ring-blue-600/20',
}

const DEFAULT_COLORS = 'bg-gray-50 text-gray-700 ring-gray-600/20'

const CONTEXT_COLORS = 'bg-gray-100 text-gray-600 ring-gray-500/20'

export const PolicyBadge = memo(function PolicyBadge({
  policyDecision,
  blockReason,
  approvalStatus,
  dryRun,
  showContext = false,
}: PolicyBadgeProps) {
  const outcome = deriveDisplayOutcome({
    policy_decision: policyDecision,
    block_reason: blockReason ?? null,
    approval_status: approvalStatus ?? null,
    dry_run: dryRun ?? false,
  })
  const context = showContext
    ? deriveOutcomeContext({
        policy_decision: policyDecision,
        block_reason: blockReason ?? null,
        approval_status: approvalStatus ?? null,
        dry_run: dryRun ?? false,
      })
    : null
  const colors = COLORS[outcome] ?? DEFAULT_COLORS

  return (
    <div className="inline-flex items-center gap-1.5">
      <span
        className={`inline-flex items-center rounded-md px-2 py-1 text-xs font-medium ring-1 ring-inset ${colors}`}
      >
        {formatDisplayOutcome(outcome)}
      </span>
      {context && (
        <span
          className={`inline-flex items-center rounded-md px-2 py-1 text-xs font-medium ring-1 ring-inset ${CONTEXT_COLORS}`}
        >
          {context}
        </span>
      )}
    </div>
  )
})
