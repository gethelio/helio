// ---------------------------------------------------------------------------
// EvidenceChain — visual renderer for the evidence_chain JSON stored in
// audit records. Renders nothing when the chain is null.
// ---------------------------------------------------------------------------

import { usageColor, usagePercent } from '../utils'

// ---------------------------------------------------------------------------
// Internal types (runtime-narrowed from Record<string, unknown>)
// ---------------------------------------------------------------------------

interface EvidenceData {
  required: string[]
  found: string[]
  missing: string[]
  expired: string[]
}

interface DependencyData {
  satisfied: boolean
  missing: string[]
}

interface RateLimitData {
  allowed: boolean
  current: number
  limit: number
}

interface SpendLimitData {
  allowed: boolean
  current_spend: number
  limit: number
}

interface BreakGlassData {
  reason: string
  invoked_by: string
}

interface ApprovalContextData {
  ticket_id: string
  denial_reason?: string
  escalated_at?: string
  escalated_to?: string[]
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

function isEvidenceData(v: unknown): v is EvidenceData {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return Array.isArray(o.found) && Array.isArray(o.missing) && Array.isArray(o.expired)
}

function isDependencyData(v: unknown): v is DependencyData {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return typeof o.satisfied === 'boolean' && Array.isArray(o.missing)
}

function isRateLimitData(v: unknown): v is RateLimitData {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return typeof o.current === 'number' && typeof o.limit === 'number'
}

function isSpendLimitData(v: unknown): v is SpendLimitData {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return typeof o.current_spend === 'number' && typeof o.limit === 'number'
}

function isBreakGlassData(v: unknown): v is BreakGlassData {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return typeof o.reason === 'string' && typeof o.invoked_by === 'string'
}

function isApprovalContextData(v: unknown): v is ApprovalContextData {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  if (typeof o.ticket_id !== 'string') return false
  if (o.denial_reason !== undefined && typeof o.denial_reason !== 'string') return false
  if (o.escalated_at !== undefined && typeof o.escalated_at !== 'string') return false
  if (
    o.escalated_to !== undefined &&
    !(Array.isArray(o.escalated_to) && o.escalated_to.every((t) => typeof t === 'string'))
  ) {
    return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Icons (inline SVG, 16x16)
// ---------------------------------------------------------------------------

function CheckIcon() {
  return (
    <svg className="h-4 w-4 shrink-0 text-emerald-600" viewBox="0 0 20 20" fill="currentColor">
      <path
        fillRule="evenodd"
        d="M16.704 4.153a.75.75 0 0 1 .143 1.052l-8 10.5a.75.75 0 0 1-1.127.075l-4.5-4.5a.75.75 0 0 1 1.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 0 1 1.05-.143Z"
        clipRule="evenodd"
      />
    </svg>
  )
}

function XIcon() {
  return (
    <svg className="h-4 w-4 shrink-0 text-red-600" viewBox="0 0 20 20" fill="currentColor">
      <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
    </svg>
  )
}

function ClockIcon() {
  return (
    <svg className="h-4 w-4 shrink-0 text-amber-600" viewBox="0 0 20 20" fill="currentColor">
      <path
        fillRule="evenodd"
        d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm.75-13a.75.75 0 0 0-1.5 0v5c0 .414.336.75.75.75h4a.75.75 0 0 0 0-1.5h-3.25V5Z"
        clipRule="evenodd"
      />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface EvidenceChainProps {
  chain: Record<string, unknown> | null
}

export function EvidenceChain({ chain }: EvidenceChainProps) {
  if (!chain) return null

  const evidence = isEvidenceData(chain.evidence) ? chain.evidence : null
  const dependencies = isDependencyData(chain.dependencies) ? chain.dependencies : null
  const rateLimit = isRateLimitData(chain.rate_limit) ? chain.rate_limit : null
  const spendLimit = isSpendLimitData(chain.spend_limit) ? chain.spend_limit : null
  const breakGlass = isBreakGlassData(chain.break_glass) ? chain.break_glass : null
  const approval = isApprovalContextData(chain.approval) ? chain.approval : null

  const hasContent = evidence || dependencies || rateLimit || spendLimit || breakGlass || approval
  if (!hasContent) return null

  return (
    <div className="space-y-3">
      {/* Evidence keys */}
      {evidence &&
        (evidence.found.length > 0 ||
          evidence.missing.length > 0 ||
          evidence.expired.length > 0) && (
          <div>
            <p className="mb-1.5 text-xs font-medium text-gray-500">Evidence</p>
            <div className="space-y-1">
              {evidence.found.map((key) => (
                <div key={`f-${key}`} className="flex items-center gap-2">
                  <CheckIcon />
                  <span className="text-xs text-emerald-700">{key}</span>
                </div>
              ))}
              {evidence.missing.map((key) => (
                <div key={`m-${key}`} className="flex items-center gap-2">
                  <XIcon />
                  <span className="text-xs text-red-700">{key}</span>
                </div>
              ))}
              {evidence.expired.map((key) => (
                <div key={`e-${key}`} className="flex items-center gap-2">
                  <ClockIcon />
                  <span className="text-xs text-amber-600">{key}</span>
                </div>
              ))}
            </div>
          </div>
        )}

      {/* Dependencies */}
      {dependencies && (
        <div>
          <p className="mb-1.5 text-xs font-medium text-gray-500">Dependencies</p>
          {dependencies.satisfied ? (
            <div className="flex items-center gap-2">
              <CheckIcon />
              <span className="text-xs text-emerald-700">All dependencies satisfied</span>
            </div>
          ) : (
            <div className="space-y-1">
              {dependencies.missing.map((dep) => (
                <div key={dep} className="flex items-center gap-2">
                  <XIcon />
                  <span className="text-xs text-red-700">{dep}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Rate limit */}
      {rateLimit && (
        <div>
          <p className="mb-1.5 text-xs font-medium text-gray-500">Rate Limit</p>
          <div className="flex items-center gap-3">
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-gray-100">
              <div
                className={`h-full rounded-full ${usageColor(rateLimit.current, rateLimit.limit)}`}
                style={{ width: `${String(usagePercent(rateLimit.current, rateLimit.limit))}%` }}
              />
            </div>
            <span className="shrink-0 text-xs tabular-nums text-gray-600">
              {rateLimit.current} / {rateLimit.limit} calls
            </span>
          </div>
        </div>
      )}

      {/* Spend limit */}
      {spendLimit && (
        <div>
          <p className="mb-1.5 text-xs font-medium text-gray-500">Spend Limit</p>
          <div className="flex items-center gap-3">
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-gray-100">
              <div
                className={`h-full rounded-full ${usageColor(spendLimit.current_spend, spendLimit.limit)}`}
                style={{
                  width: `${String(usagePercent(spendLimit.current_spend, spendLimit.limit))}%`,
                }}
              />
            </div>
            <span className="shrink-0 text-xs tabular-nums text-gray-600">
              {spendLimit.current_spend} / {spendLimit.limit}
            </span>
          </div>
        </div>
      )}

      {/* Break-glass */}
      {breakGlass && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3">
          <p className="text-xs font-medium text-amber-800">Break-Glass Override</p>
          <p className="mt-1 text-xs text-amber-700">
            <span className="font-medium">Reason:</span> {breakGlass.reason}
          </p>
          <p className="text-xs text-amber-700">
            <span className="font-medium">Invoked by:</span> {breakGlass.invoked_by}
          </p>
        </div>
      )}

      {/* Approval context (denial reason / escalation) */}
      {approval && (
        <div className="rounded-md border border-gray-200 bg-gray-50 p-3">
          <p className="text-xs font-medium text-gray-700">Approval</p>
          {approval.denial_reason && (
            <p className="mt-1 text-xs text-gray-600">
              <span className="font-medium">Denial reason:</span> {approval.denial_reason}
            </p>
          )}
          {approval.escalated_at && (
            <p className="mt-1 text-xs text-gray-600">
              <span className="font-medium">Escalated:</span> {approval.escalated_at}
              {approval.escalated_to && approval.escalated_to.length > 0
                ? ` to ${approval.escalated_to.join(', ')}`
                : ''}
            </p>
          )}
          <p className="mt-1 text-xs text-gray-400">Ticket {approval.ticket_id}</p>
        </div>
      )}
    </div>
  )
}
