// ---------------------------------------------------------------------------
// Session identity gate (issue #218) — the enforcement seam between resolved
// session identity and every session-dependent control.
//
// Engagement checklist — a control is session-dependent when it is any of:
//   - a `key: session` rate limit        (sessionLimitKey demands the brand)
//   - a `key: session` spend limit       (sessionLimitKey demands the brand)
//   - a `key: session` budget            (gateBudgetCharges checks engagement;
//                                         peekAll/recordAll demand GatedCharges)
//   - an evidence.requires / requires rule (decision-pipeline grounded gate)
// Adding a new session-keyed consumer means minting through this module —
// the brands make skipping the gate a compile error, not a review item.
//
// Brand forging (`as GatedSession`, `as GatedCharges`, `as FrozenBudgetPlans`)
// is unsupported outside this module; the two test mints live on the
// test-helper path, outside the production import graph.
// ---------------------------------------------------------------------------

import type { BudgetCharge, BudgetChargeFailure } from '../budget/engine.js'
import type { CompiledBudget } from '../budget/types.js'

declare const GATED_SESSION: unique symbol
/** A session bucket value that provably passed the identity gate. */
export type GatedSession = string & { readonly [GATED_SESSION]: true }

declare const GATED_CHARGES: unique symbol
/** Budget charges that provably passed the session engagement check. */
export type GatedCharges = readonly BudgetCharge[] & { readonly [GATED_CHARGES]: true }

declare const FROZEN_PLAN: unique symbol
/**
 * A deferred budget plan frozen at sideband /evaluate from gated charges.
 * The brand is element-level so the `/audit` plan-union filter refines to
 * `FrozenBudgetPlan[]` through its type predicate with no cast.
 */
export interface FrozenBudgetPlan {
  readonly kind: 'budget'
  readonly budget: CompiledBudget
  readonly bucketKey: string
  readonly amount: number
  /** Config generation at evaluate time; stale charges are skipped at commit. */
  readonly generation: number
  /**
   * Whether this charge breached its budget at /evaluate (issue #14 break-
   * glass): a breached plan whose ticket was APPROVED commits as
   * `approved_overage`; every other executed plan commits as plain `spend`.
   */
  readonly breached: boolean
  readonly [FROZEN_PLAN]: true
}

/** Element-brand-only alias: the array itself is deliberately unsealed. */
export type FrozenBudgetPlans = readonly FrozenBudgetPlan[]

/** The identity gate's mode-agnostic verdict — the caller decides what
 * unresolved means (enforce → deny; dry-run → report the marker). */
export type SessionGate =
  | { readonly ok: true; readonly session: GatedSession; readonly anonymous: boolean }
  | { readonly ok: false }

/**
 * Well-formed session identity: non-null and non-empty AFTER trimming — the
 * same rule the MCP resolver applies before stamping a request. Every
 * consumer of adapter-supplied ids (the gate, the decision pipeline's
 * grounded-rule presence check, sideband ingress) shares this ONE seam so a
 * whitespace-only id can neither key a bucket nor act as an evidence
 * session anywhere.
 */
export function isWellFormedSessionId(id: string | null | undefined): id is string {
  return id != null && id.trim() !== ''
}

/**
 * Run the identity gate for one request. A resolved id mints its attributed
 * brand under both modes; an unresolved id mints the literal `unknown`
 * bucket value under `anonymous` (pre-0.12 pooling, preserved on disk) and
 * yields `{ ok: false }` under `deny`.
 */
export function gateSession(
  sessionId: string | null | undefined,
  onUnresolved: 'deny' | 'anonymous',
): SessionGate {
  if (isWellFormedSessionId(sessionId)) {
    return { ok: true, session: sessionId as GatedSession, anonymous: false }
  }
  if (onUnresolved === 'anonymous') {
    return { ok: true, session: 'unknown' as GatedSession, anonymous: true }
  }
  return { ok: false }
}

/** Build a `key: session` limit bucket key — obtainable only via the gate. */
export function sessionLimitKey(session: GatedSession): string {
  return `session:${session}`
}

/** The budget gate's verdict on one call's resolved charges. */
export type GatedBudgetCharges =
  | { readonly ok: true; readonly charges: GatedCharges }
  | { readonly ok: false; readonly unresolvedEngaged: true }

/**
 * The budget engagement check (#215-critical): with an unresolved identity,
 * any session-keyed charge OR failure among the call's resolved charges
 * reports `unresolvedEngaged` before a single peek runs. Calls that feed
 * only global/sender pots pass through untouched, and an anonymous mint
 * pools with a one-shot warning at its first session-keyed engagement.
 */
export function gateBudgetCharges(
  resolved: {
    readonly charges: readonly BudgetCharge[]
    readonly failures: readonly BudgetChargeFailure[]
  },
  gate: SessionGate,
): GatedBudgetCharges {
  const sessionEngaged =
    resolved.charges.some((charge) => charge.budget.key === 'session') ||
    resolved.failures.some((failure) => failure.budget.key === 'session')
  if (!gate.ok) {
    if (sessionEngaged) return { ok: false, unresolvedEngaged: true }
    return { ok: true, charges: resolved.charges as GatedCharges }
  }
  if (gate.anonymous && sessionEngaged) warnAnonymousPoolingOnce()
  return { ok: true, charges: resolved.charges as GatedCharges }
}

/**
 * Freeze gated charges into deferred budget plans at sideband /evaluate.
 * Runs AFTER `peekAll` — the breach markers come from the peek and pair
 * positionally with the charges. The frozen brand is derivable only from
 * `GatedCharges`, so a frozen plan proves its charges passed the check.
 */
export function freezeGatedPlans(
  charges: GatedCharges,
  breached: readonly boolean[],
): FrozenBudgetPlans {
  if (breached.length !== charges.length) {
    throw new Error(
      `freezeGatedPlans: breach markers must pair positionally with charges ` +
        `(${String(breached.length)} markers for ${String(charges.length)} charges)`,
    )
  }
  // Named-field copy only: a charge-level `upstream` label (issue #295) is
  // deliberately dropped here, so deferred commits snapshot upstream: null.
  return charges.map(
    (charge, index) =>
      ({
        kind: 'budget' as const,
        budget: charge.budget,
        bucketKey: charge.bucketKey,
        amount: charge.amount,
        generation: charge.generation,
        breached: breached[index] === true,
      }) as FrozenBudgetPlan,
  )
}

/**
 * Rebuild committable charges from frozen plans at sideband /audit, applying
 * the legitimate `actual_amount` override. NOT an embedder API: embedders
 * obtain `GatedCharges` via `gateBudgetCharges` only — this remint exists
 * solely for the evaluate→audit deferred commit, and its parameter brand
 * means the plans provably passed the engagement check at evaluate time.
 */
export function remintDeferredCharges(
  frozen: FrozenBudgetPlans,
  actualAmount?: number,
): GatedCharges {
  // The double cast is the sanctioned mint: the frozen brand on the input
  // proves the engagement check ran at evaluate time.
  return frozen.map((plan) => ({
    budget: plan.budget,
    bucketKey: plan.bucketKey,
    amount: actualAmount ?? plan.amount,
    generation: plan.generation,
  })) as unknown as GatedCharges
}

// ---------------------------------------------------------------------------
// Deny messages — one builder per class, both naming the tried strategies.
// ---------------------------------------------------------------------------

/** Deny message for an engaged `key: session` limit or budget. */
export function sessionUnresolvedControlMessage(tried: string): string {
  return (
    `No session identity resolved (tried: ${tried}) — a session-keyed limit or ` +
    'budget requires one. See session.identity in helio.yaml.'
  )
}

/** Deny message for the grounded-rule gate (evidence/dependency rules). */
export function sessionRequiredForGroundingMessage(tried: string): string {
  return (
    `No session identity resolved (tried: ${tried}) — rules using ` +
    'evidence.requires or requires need one. See session.identity in helio.yaml.'
  )
}

// ---------------------------------------------------------------------------
// One-shot operational warnings
// ---------------------------------------------------------------------------

let unresolvedEngagementWarned = false
let anonymousPoolingWarned = false

/** Test-only: re-arm the one-shot warnings. */
export function resetSessionGateWarningsForTests(): void {
  unresolvedEngagementWarned = false
  anonymousPoolingWarned = false
}

/**
 * First deny-mode engagement of a session-dependent control with unresolved
 * identity. Runtime is the first knowable moment: a chain whose clients send
 * nothing is statically indistinguishable from one whose clients will.
 */
export function warnSessionUnresolvedEngagementOnce(tried: string): void {
  if (unresolvedEngagementWarned) return
  unresolvedEngagementWarned = true
  // eslint-disable-next-line no-console -- Intentional operational warning
  console.error(
    `[helio] Warning: a session-keyed control was engaged with no resolved session ` +
      `identity (tried: ${tried}); session.on_unresolved: deny denies such requests ` +
      '(dry-run reports them). Send an identity the chain can read (e.g. the ' +
      'x-helio-session-id header), or set session.on_unresolved: anonymous to ' +
      'restore pre-0.12 shared pooling.',
  )
}

/** First session-keyed engagement that pooled through the anonymous mint. */
export function warnAnonymousPoolingOnce(): void {
  if (anonymousPoolingWarned) return
  anonymousPoolingWarned = true
  // eslint-disable-next-line no-console -- Intentional operational warning
  console.error(
    '[helio] Warning: session identity unresolved; session-keyed limits and budgets ' +
      'are pooling into the shared "unknown" bucket (session.on_unresolved: anonymous). ' +
      'Have callers send session identity to isolate them from each other.',
  )
}
