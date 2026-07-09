// ---------------------------------------------------------------------------
// Shared constants used across multiple dashboard pages and components.
// ---------------------------------------------------------------------------
import type { OutcomeFilterValue } from './outcome'

/** Decision filter options shared by FeedPage and AuditPage. */
export const DECISION_FILTERS: ReadonlyArray<{ label: string; value: OutcomeFilterValue | null }> =
  [
    { label: 'All', value: null },
    { label: 'Allow', value: 'allow' },
    { label: 'Deny', value: 'deny' },
    { label: 'Rejected', value: 'rejected' },
    { label: 'Approval Denied', value: 'approval_denied' },
    { label: 'Approval Timeout', value: 'approval_timeout' },
    { label: 'Client Disconnected', value: 'client_disconnected' },
    { label: 'Shutdown Cancelled', value: 'shutdown_cancelled' },
    { label: 'Rate Limited', value: 'rate_limited' },
    { label: 'Spend Limited', value: 'spend_limited' },
    { label: 'Budget Exceeded', value: 'budget_exceeded' },
    { label: 'Dry Run', value: 'dry_run' },
  ]

/**
 * Hex color map for chart fills keyed by policy decision.
 *
 * These must stay in sync with the Tailwind classes in PolicyBadge.tsx:
 *   allow → emerald (#059669), deny → red (#dc2626),
 *   rejected → rose (#e11d48), require_approval → amber (#d97706),
 *   rate_limit → orange (#ea580c), spend_limit → purple (#9333ea),
 *   dry_run → blue (#2563eb)
 */
export const DECISION_COLOR_HEX: Record<string, string> = {
  allow: '#059669',
  deny: '#dc2626',
  rejected: '#e11d48',
  require_approval: '#d97706',
  rate_limit: '#ea580c',
  spend_limit: '#9333ea',
  dry_run: '#2563eb',
}

export const FALLBACK_COLOR_HEX = '#6b7280'

/** Millisecond duration constants shared across pages, components, and tests. */
export const MS_PER_MINUTE = 60 * 1000
export const MS_PER_HOUR = 60 * MS_PER_MINUTE
export const MS_PER_DAY = 24 * MS_PER_HOUR

/** Time range options for analytics chart pickers (caller must pick one). */
export const TIME_PRESETS: ReadonlyArray<{ label: string; ms: number }> = [
  { label: '1h', ms: MS_PER_HOUR },
  { label: '24h', ms: MS_PER_DAY },
  { label: '7d', ms: 7 * MS_PER_DAY },
]

/** Time range options for filter bars (prefixes 'All' to clear the filter). */
export const TIME_FILTERS: ReadonlyArray<{ label: string; ms: number | null }> = [
  { label: 'All', ms: null },
  ...TIME_PRESETS,
]
