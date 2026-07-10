// ---------------------------------------------------------------------------
// Shutdown sequencing. The order is load-bearing for money state: every
// traffic door must stop accepting and DRAIN before any governance state is
// torn down, because a request served during shutdown must see real pots and
// counters — a cleared budget pot or limiter bucket reads as full headroom
// and would let a final call overspend (and, for budgets, durably ledger the
// overspend). Structural types keep this module import-light and testable.
// ---------------------------------------------------------------------------

export interface CloseableResources {
  /** The MCP server — the primary traffic door. Drained with `await`. */
  handle: { close(): Promise<void> }
  annotationPrime?: { stop(): void }
  closeForwarder?: () => Promise<void>
  auditWriter?: { close(): void }
  configWatcher?: { close(): void }
  sidebandHandle?: { close(): Promise<void> }
  evidenceStore?: { close(): void }
  approvalRouter?: { close(): void }
  approvalQueue?: { close(): void }
  rateLimiter?: { close(): void }
  spendLimiter?: { close(): void }
  budgetEngine?: { close(): void }
  closeDashboardApp?: () => void
  dashboardHandle?: { close(): Promise<void> }
  eventBus?: { close(): void }
  governanceService?: { close(): void }
}

/** Close everything the proxy holds, in traffic-safe order. */
export async function closeResources(resources: CloseableResources): Promise<void> {
  // Background loops first: nothing may schedule new work mid-shutdown.
  resources.annotationPrime?.stop()
  resources.configWatcher?.close()

  // Resolve pending approvals BEFORE draining the doors: requests parked on
  // a ticket unblock as shutdown-cancelled (fail closed) instead of hanging
  // the drain on a human who will never answer.
  resources.approvalRouter?.close()
  resources.approvalQueue?.close()

  // Disconnect SSE fan-out before its door: open event streams would
  // otherwise hold the dashboard server's drain until the force-exit timer.
  resources.closeDashboardApp?.()
  resources.eventBus?.close()

  // Traffic doors close and drain. Only after these awaits resolve is it
  // safe to tear down governance state.
  if (resources.dashboardHandle) await resources.dashboardHandle.close()
  if (resources.sidebandHandle) await resources.sidebandHandle.close()
  await resources.handle.close()

  // Governance state, now unreachable by new traffic.
  resources.governanceService?.close()
  resources.rateLimiter?.close()
  resources.spendLimiter?.close()
  resources.budgetEngine?.close()

  // Storage last: drained requests above may still have flushed audit rows.
  resources.evidenceStore?.close()
  resources.auditWriter?.close()
  if (resources.closeForwarder) await resources.closeForwarder()
}
