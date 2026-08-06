// ---------------------------------------------------------------------------
// Test-only brand mints (issue #218). These deliberately bypass the identity
// gate and the budget engagement check so engine/limiter unit tests can
// exercise internals directly. They live on the test-helper path and MUST
// stay out of the production import graph — production code obtains
// GatedSession via gateSession and GatedCharges via gateBudgetCharges only.
// ---------------------------------------------------------------------------

import type { BudgetCharge } from '../../budget/engine.js'
import type { GatedCharges, GatedSession } from '../../policy/session-gate.js'

/** Test-only mint of a session bucket value, bypassing the identity gate. */
export function mintGatedSession(id: string): GatedSession {
  return id as GatedSession
}

/** Test-only mint of budget charges, bypassing the engagement check. */
export function mintGatedCharges(charges: readonly BudgetCharge[]): GatedCharges {
  return charges as GatedCharges
}
