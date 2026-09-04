/** Every outcome a reload attempt can record. C4b appends 'watch_failed'. */
export const POLICY_RELOAD_OUTCOMES = [
  'applied',
  'rejected_invalid',
  'rejected_unroutable',
  'rejected_budget_flush',
  'rejected_pinned',
] as const

export type PolicyReloadOutcome = (typeof POLICY_RELOAD_OUTCOMES)[number]
