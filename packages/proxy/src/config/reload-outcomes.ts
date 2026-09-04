/** Every outcome a reload attempt can record. `watch_failed` means the watch itself failed; nothing was read. */
export const POLICY_RELOAD_OUTCOMES = [
  'applied',
  'rejected_invalid',
  'rejected_unroutable',
  'rejected_budget_flush',
  'rejected_pinned',
  'watch_failed',
] as const

export type PolicyReloadOutcome = (typeof POLICY_RELOAD_OUTCOMES)[number]
