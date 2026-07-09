// ---------------------------------------------------------------------------
// Compiled budget types — engine-ready form of the `budgets:` config section
// (issue #14). Mirrors the policy split: config types (config/schema.ts) carry
// raw strings validated by Zod; compiled types carry pre-built matchers and
// pre-parsed millisecond durations for zero-overhead evaluation.
// ---------------------------------------------------------------------------

import type { ToolMatcher } from '../policy/types.js'

/** One compiled contributor: which tools feed the budget, and from which field. */
export interface CompiledBudgetContributor {
  readonly tool: ToolMatcher
  /** Dot-path into the tool arguments (e.g. "$.amount"), resolved per call. */
  readonly field: string
}

/**
 * A budget's replenishment semantics.
 *
 * - `duration`: sliding window; spend ages out after `windowMs`.
 * - `session`: a depleting pot per session key that never replenishes on a
 *   timer; idle pots are garbage-collected after `idleTtlMs` because neither
 *   door has an authoritative session-end signal.
 */
export type CompiledBudgetWindow =
  | { readonly kind: 'duration'; readonly windowMs: number }
  | { readonly kind: 'session'; readonly idleTtlMs: number }

/** A fully compiled named budget, ready for the engine. */
export interface CompiledBudget {
  readonly name: string
  readonly limit: number
  readonly currency: string
  readonly window: CompiledBudgetWindow
  /** The raw config window string ("1h" | "session") for wire/docs surfaces. */
  readonly windowRaw: string
  readonly key: 'global' | 'session' | 'sender_id'
  /**
   * `require_approval` (break-glass) arrives later in this release train; the
   * compiled union is forward-shaped so the engine's exhaustive handling is
   * already in place, but the config schema only admits `deny` today.
   */
  readonly onExceed: 'deny' | 'require_approval'
  readonly contributors: readonly CompiledBudgetContributor[]
}
