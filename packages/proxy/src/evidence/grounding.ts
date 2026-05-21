import type { EvidenceStore } from './store.js'

// ---------------------------------------------------------------------------
// Evidence check result — distinguishes missing from expired evidence.
// ---------------------------------------------------------------------------

/** Result of checking evidence requirements against the session store. */
export interface EvidenceCheckResult {
  /** True if all required evidence is present and valid. */
  readonly satisfied: boolean
  /** Evidence keys that were never stored. */
  readonly missing: string[]
  /** Evidence keys that were stored but have expired (TTL elapsed). */
  readonly expired: string[]
  /** Evidence keys that are present and valid. */
  readonly found: string[]
}

/** Result of checking dependency (tool call) requirements. */
export interface DependencyCheckResult {
  /** True if all required tools have been called in this session. */
  readonly satisfied: boolean
  /** Tool names that have not been called. */
  readonly missing: string[]
}

// ---------------------------------------------------------------------------
// Evidence grounding checks.
// ---------------------------------------------------------------------------

/**
 * Check whether all required evidence keys are present and valid in the store.
 *
 * Uses `getEvidence()` (with lazy eviction) to check for valid entries, then
 * `hasSeenEvidence()` to distinguish "never stored" from "stored but expired".
 */
export function checkEvidence(
  store: EvidenceStore,
  sessionId: string,
  requirements: readonly string[],
): EvidenceCheckResult {
  if (requirements.length === 0) {
    return { satisfied: true, missing: [], expired: [], found: [] }
  }

  const found: string[] = []
  const missing: string[] = []
  const expired: string[] = []

  for (const key of requirements) {
    const valid = store.getEvidence(sessionId, key)
    if (valid) {
      found.push(key)
    } else if (store.hasSeenEvidence(sessionId, key)) {
      expired.push(key)
    } else {
      missing.push(key)
    }
  }

  return {
    satisfied: missing.length === 0 && expired.length === 0,
    missing,
    expired,
    found,
  }
}

/** Options controlling how `checkDependencies` interprets tool call outcomes. */
export interface CheckDependenciesOptions {
  /**
   * When true (default), only successful upstream calls count as satisfying
   * the dependency. A tool call that was attempted but returned an upstream
   * error leaves the dependency unsatisfied. Set to false to restore the
   * legacy "any attempt counts" semantics — useful only for cases where
   * operators explicitly want to gate on invocation rather than outcome.
   */
  readonly requireSuccess?: boolean
}

/**
 * Check whether all required tool calls have been made in this session.
 *
 * Dependency chains are the lightweight ordering primitive for rules like
 * "process_refund requires a prior orders.lookup call." By default they
 * require the prior call to have *succeeded* — an upstream error does not
 * satisfy the dependency, because otherwise an agent could call the
 * dependency with a deliberately bad argument, have the upstream fail, and
 * proceed to the gated tool without real evidence. Operators who need the
 * old "any attempt counts" behavior can pass `{ requireSuccess: false }`.
 */
export function checkDependencies(
  store: EvidenceStore,
  sessionId: string,
  requirements: readonly string[],
  options: CheckDependenciesOptions = {},
): DependencyCheckResult {
  if (requirements.length === 0) {
    return { satisfied: true, missing: [] }
  }

  const requireSuccess = options.requireSuccess ?? true
  const missing: string[] = []

  for (const toolName of requirements) {
    const satisfied = requireSuccess
      ? store.hasSuccessfulTool(sessionId, toolName)
      : store.hasCompletedTool(sessionId, toolName)
    if (!satisfied) {
      missing.push(toolName)
    }
  }

  return {
    satisfied: missing.length === 0,
    missing,
  }
}
