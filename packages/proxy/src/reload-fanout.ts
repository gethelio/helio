import type { CompiledPolicy } from './policy/index.js'
import type { CompiledToolRevalidation } from './policy/types.js'

// ---------------------------------------------------------------------------
// Hot-reload policy fan-out across governed upstream stacks. Kept out of
// cli.ts so it stays unit-testable (cli.ts parses argv at import time).
// Structural types keep the module import-light, like shutdown.ts.
// ---------------------------------------------------------------------------

/** One governed upstream stack the reload fan-out applies a new policy to. */
export interface ReloadableStack {
  readonly governedForwarder: { updatePolicy(policy: CompiledPolicy): void }
  readonly annotationPrime: {
    reconfigure(revalidation: CompiledToolRevalidation | undefined): void
  }
}

/**
 * Apply a reloaded policy across every governed stack, in config order.
 * Update and reconfigure are PAIRED per stack (matching the singular
 * sequence) rather than swept per operation, so a future partial failure
 * surfaces adjacent to its door.
 */
export function applyReloadedPolicy(
  stacks: ReadonlyArray<ReloadableStack>,
  newPolicy: CompiledPolicy,
): void {
  for (const stack of stacks) {
    stack.governedForwarder.updatePolicy(newPolicy)
    stack.annotationPrime.reconfigure(newPolicy.toolRevalidation)
  }
}
