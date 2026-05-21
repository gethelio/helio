/**
 * Shared utilities for example start scripts.
 *
 * Provides graceful shutdown (first Ctrl+C) with a 4s force-kill
 * fallback, and a simple HTTP healthcheck poller.
 */

/**
 * Register cleanup handlers for SIGINT/SIGTERM.
 *
 * First signal: wait up to 4s for children to exit gracefully.
 * Second signal: force-kill all children and exit immediately.
 *
 * @param {import('node:child_process').ChildProcess[]} children
 * @param {{ exitCode?: number }} state — mutable object whose
 *   `exitCode` property is read at exit time.
 */
export function registerCleanup(children, state) {
  let shuttingDown = false

  function cleanup() {
    if (shuttingDown) {
      // Second Ctrl+C — force exit immediately
      for (const child of children) {
        try {
          child.kill('SIGKILL')
        } catch {}
      }
      process.exit(state.exitCode ?? 0)
    }
    shuttingDown = true
    // Children already received SIGINT from the process group — don't
    // send another signal.  Just wait for them to exit gracefully, with
    // a fallback force-kill after 4 seconds (proxy uses a 5s timeout
    // internally, so this fires just before that to keep things tidy).
    setTimeout(() => {
      for (const child of children) {
        try {
          child.kill('SIGKILL')
        } catch {}
      }
      process.exit(state.exitCode ?? 0)
    }, 4000).unref()
  }

  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)

  return cleanup
}

/**
 * Poll an HTTP endpoint until it returns 200 OK.
 *
 * @param {string} url — the URL to poll
 * @param {number} [maxWaitMs=5000] — give up after this many ms
 */
export async function waitForHealthcheck(url, maxWaitMs = 5000) {
  const start = Date.now()
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {
      // Server not ready yet
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`Healthcheck at ${url} did not respond within ${maxWaitMs}ms`)
}
