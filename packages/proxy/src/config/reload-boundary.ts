import { isDeepStrictEqual } from 'node:util'
import type { HelioConfig } from './schema.js'

// ---------------------------------------------------------------------------
// Reload boundary diffing
// ---------------------------------------------------------------------------

/** Result of comparing two validated configs across the hot-reload boundary. */
export interface ReloadBoundaryDiff {
  /** Config paths that changed but require process restart to take effect. */
  readonly restartRequiredPaths: readonly string[]
}

/**
 * Compare two validated configs and report changed paths that do not hot-reload.
 *
 * Hot-reload applies `policies.default`, `policies.flag_destructive`,
 * `policies.dry_run`, and `policies.rules` by swapping the compiled policy,
 * and `budgets` by reconciling the budget engine on name identity.
 * Everything else is startup-bound (listeners, upstream, dashboard, etc.) and
 * requires process restart.
 */
export function diffReloadBoundary(previous: HelioConfig, next: HelioConfig): ReloadBoundaryDiff {
  const restartRequiredPaths: string[] = []

  if (!isDeepStrictEqual(previous.upstream, next.upstream)) {
    restartRequiredPaths.push('upstream')
  }
  if (!isDeepStrictEqual(previous.listen, next.listen)) {
    restartRequiredPaths.push('listen')
  }
  if (!isDeepStrictEqual(previous.dashboard, next.dashboard)) {
    restartRequiredPaths.push('dashboard')
  }
  if (!isDeepStrictEqual(previous.environment, next.environment)) {
    restartRequiredPaths.push('environment')
  }
  if (!isDeepStrictEqual(previous.approval, next.approval)) {
    restartRequiredPaths.push('approval')
  }
  if (!isDeepStrictEqual(previous.audit, next.audit)) {
    restartRequiredPaths.push('audit')
  }
  if (!isDeepStrictEqual(previous.sdk, next.sdk)) {
    restartRequiredPaths.push('sdk')
  }

  // `budgets` is deliberately NOT in this list: budgets hot-reload (the
  // watcher recompiles them and the engine reconciles by name, issue #14).
  // Do not cargo-cult it in when adding the next top-level field.

  // `policies.hot_reload` only affects whether the watcher exists at startup.
  const previousHotReload = previous.policies.hot_reload ?? true
  const nextHotReload = next.policies.hot_reload ?? true
  if (previousHotReload !== nextHotReload) {
    restartRequiredPaths.push('policies.hot_reload')
  }

  return { restartRequiredPaths }
}
