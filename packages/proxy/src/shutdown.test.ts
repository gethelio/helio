import { describe, it, expect } from 'vitest'
import { closeResources } from './shutdown.js'

function orderedHarness() {
  const order: string[] = []
  const sync = (name: string) => ({
    close: () => {
      order.push(name)
    },
  })
  const asyncClose = (name: string) => ({
    close: async () => {
      // A real server drain crosses the event loop; the sequencing must
      // hold across genuine await points, not just synchronous calls.
      await Promise.resolve()
      order.push(name)
    },
  })
  return { order, sync, asyncClose }
}

describe('closeResources', () => {
  it('drains every traffic door before tearing down governance state', async () => {
    const { order, sync, asyncClose } = orderedHarness()

    await closeResources({
      handle: asyncClose('handle'),
      annotationPrime: { stop: () => order.push('annotationPrime') },
      closeForwarder: async () => {
        await Promise.resolve()
        order.push('forwarder')
      },
      auditWriter: sync('auditWriter'),
      configWatcher: sync('configWatcher'),
      sidebandHandle: asyncClose('sidebandHandle'),
      evidenceStore: sync('evidenceStore'),
      approvalRouter: sync('approvalRouter'),
      approvalQueue: sync('approvalQueue'),
      rateLimiter: sync('rateLimiter'),
      spendLimiter: sync('spendLimiter'),
      budgetEngine: sync('budgetEngine'),
      closeDashboardApp: () => order.push('dashboardApp'),
      dashboardHandle: asyncClose('dashboardHandle'),
      eventBus: sync('eventBus'),
      governanceService: sync('governanceService'),
    })

    const position = (name: string) => order.indexOf(name)

    // A request admitted during shutdown must see real pots and counters: a
    // cleared budget pot reads as full headroom. Every door drains first.
    for (const door of ['handle', 'sidebandHandle', 'dashboardHandle']) {
      for (const governance of [
        'budgetEngine',
        'rateLimiter',
        'spendLimiter',
        'governanceService',
      ]) {
        expect(position(door), `${door} must close before ${governance}`).toBeLessThan(
          position(governance),
        )
      }
    }

    // Approvals resolve BEFORE the doors drain, or requests parked on a
    // ticket would hang the drain until the force-exit timer.
    expect(position('approvalRouter')).toBeLessThan(position('handle'))
    expect(position('approvalQueue')).toBeLessThan(position('handle'))

    // Storage closes last so drained requests could still write audit rows.
    expect(position('auditWriter')).toBeGreaterThan(position('budgetEngine'))
    expect(order).toHaveLength(16)
  })

  it('handles a minimal resource set (only the MCP handle)', async () => {
    const { order, asyncClose } = orderedHarness()
    await expect(closeResources({ handle: asyncClose('handle') })).resolves.toBeUndefined()
    expect(order).toEqual(['handle'])
  })
})
