/* eslint-disable no-console -- crash-drain reports through the CLI's stderr */

/**
 * Crash-drain registry.
 *
 * When the proxy is about to exit because of an unhandled rejection or an
 * uncaught exception, any resources that buffer in-memory state (the audit
 * writer in particular) must get a chance to flush before the process dies.
 *
 * Components register a hook via `registerCrashDrainHook(fn)` at construction
 * time; the CLI's process error handlers call `drainForCrash()` right before
 * `process.exit(1)` to run every hook in order, swallowing any errors so a
 * broken hook cannot block the others from running.
 */

type CrashDrainHook = () => void | Promise<void>

const hooks: CrashDrainHook[] = []
let draining = false

/** Register a function to run when the process is crashing. */
export function registerCrashDrainHook(hook: CrashDrainHook): void {
  hooks.push(hook)
}

/**
 * Run every registered hook in order, awaiting async ones and swallowing
 * (but logging) any errors so a broken hook cannot block the rest.
 *
 * If `unhandledRejection` and `uncaughtException` both fire in quick
 * succession, this guards against running every hook twice.
 */
export async function drainForCrash(): Promise<void> {
  if (draining) return
  draining = true
  for (const hook of hooks) {
    try {
      await hook()
    } catch (err) {
      console.error('[helio] crash-drain hook failed:', err)
    }
  }
}

/** Test-only: clear the registry (and drained flag) between runs. */
export function resetCrashDrainHooks(): void {
  hooks.length = 0
  draining = false
}
