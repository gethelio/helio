import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { startAnnotationPrimeLoop } from './annotation-prime-loop.js'
import type { AnnotationCachePrimeResult } from './governed-forwarder.js'
import type { CompiledToolRevalidation } from './types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A prime result the fake forwarder can hand back, sync or deferred. */
type PrimeResponse = AnnotationCachePrimeResult | Promise<AnnotationCachePrimeResult>

interface FakeForwarder {
  primeAnnotationCache: () => Promise<AnnotationCachePrimeResult>
  readonly calls: number
}

/**
 * A forwarder stand-in that returns scripted results: `script[n]` for the
 * n-th call, then `fallback` for every call past the script.
 */
function fakeForwarder(script: PrimeResponse[], fallback: PrimeResponse): FakeForwarder {
  let calls = 0
  return {
    get calls() {
      return calls
    },
    primeAnnotationCache: () => {
      const next = script[calls] ?? fallback
      calls += 1
      return Promise.resolve(next)
    },
  }
}

/** A promise plus its resolver, for keeping a prime attempt in flight. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let settle: ((value: T) => void) | undefined
  const promise = new Promise<T>((res) => {
    settle = res
  })
  return {
    promise,
    resolve: (value: T) => {
      settle?.(value)
    },
  }
}

const ok = (toolsCached: number): AnnotationCachePrimeResult => ({ success: true, toolsCached })
const fail = (reason: string): AnnotationCachePrimeResult => ({
  success: false,
  toolsCached: 0,
  reason,
})

const revalidation = (intervalMs: number, enabled = true): CompiledToolRevalidation => ({
  enabled,
  intervalMs,
  maxAdvertisedTtlMs: intervalMs,
})

/** Upper bound the loop waits for the initial prime before serving traffic. */
const INITIAL_WAIT_MS = 1_500

describe('startAnnotationPrimeLoop', () => {
  let logged: string[] = []

  /** Every stderr line the loop has emitted so far. */
  const messages = (): string[] => logged

  beforeEach(() => {
    vi.useFakeTimers()
    // Deterministic backoff: jitter is floor(random * 250).
    vi.spyOn(Math, 'random').mockReturnValue(0)
    logged = []
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(String(args[0]))
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('preserves startup behavior: initial attempt, 1.5s wait race, backoff retries until success', async () => {
    const slowInitial = deferred<AnnotationCachePrimeResult>()
    const forwarder = fakeForwarder([slowInitial.promise, fail('still down')], ok(2))

    const startPromise = startAnnotationPrimeLoop(forwarder, undefined)
    await vi.advanceTimersByTimeAsync(INITIAL_WAIT_MS)
    const controller = await startPromise

    // The initial attempt is still in flight: startup continues fail-closed
    // and a background retry is armed.
    expect(forwarder.calls).toBe(1)
    expect(messages()).toContain(
      '[helio] Annotation cache priming did not complete within 1500ms; continuing startup fail-closed and retrying in background',
    )
    expect(messages()).toContain('[helio] Annotation cache prime retry 1 scheduled in 1000ms')

    // The late initial failure reports but does not double-arm the retry.
    slowInitial.resolve(fail('slow upstream'))
    await vi.advanceTimersByTimeAsync(0)
    expect(messages()).toContain(
      '[helio] Annotation cache priming failed: slow upstream — undocumented tools will be denied (fail-closed) until priming succeeds',
    )

    // Retry 1 fails, backoff doubles to 2000ms.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(forwarder.calls).toBe(2)
    expect(messages()).toContain(
      '[helio] Annotation cache prime retry 1 failed: still down — still fail-closed',
    )
    expect(messages()).toContain('[helio] Annotation cache prime retry 2 scheduled in 2000ms')

    // Retry 2 succeeds.
    await vi.advanceTimersByTimeAsync(2_000)
    expect(forwarder.calls).toBe(3)
    expect(messages()).toContain(
      '[helio] Annotation cache primed after retry 2: 2 tool definitions baselined for drift detection (baselines are per-process; a restart re-baselines — review tool_drift audit records before restarting)',
    )

    // Revalidation is undefined here: no further attempts, ever.
    await vi.advanceTimersByTimeAsync(600_000)
    expect(forwarder.calls).toBe(3)
    controller.stop()
  })

  it('starts the revalidation cadence after the initial prime fails and the first retry succeeds', async () => {
    const forwarder = fakeForwarder([fail('still down'), ok(2)], ok(3))
    const controller = await startAnnotationPrimeLoop(forwarder, revalidation(300_000))

    // The initial attempt fails right away (no deferred promise here), so the
    // 1.5s startup race resolves via the 'completed' branch, not a timeout,
    // and a retry is armed straight from handlePrimeResult.
    expect(forwarder.calls).toBe(1)
    expect(messages()).toContain(
      '[helio] Annotation cache priming failed: still down — undocumented tools will be denied (fail-closed) until priming succeeds',
    )
    expect(messages()).toContain('[helio] Annotation cache prime retry 1 scheduled in 1000ms')

    // Retry 1 succeeds: this is the only place the cadence gets armed —
    // every other revalidation test primes on the initial attempt instead.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(forwarder.calls).toBe(2)
    expect(messages()).toContain(
      '[helio] Annotation cache primed after retry 1: 2 tool definitions baselined for drift detection (baselines are per-process; a restart re-baselines — review tool_drift audit records before restarting)',
    )

    // Nothing fires before the interval elapses.
    await vi.advanceTimersByTimeAsync(299_999)
    expect(forwarder.calls).toBe(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(forwarder.calls).toBe(3)

    // The cadence repeats.
    await vi.advanceTimersByTimeAsync(300_000)
    expect(forwarder.calls).toBe(4)
    controller.stop()
  })

  it('schedules revalidation at intervalMs after the first success and keeps the cadence', async () => {
    const forwarder = fakeForwarder([], ok(2))
    const controller = await startAnnotationPrimeLoop(forwarder, revalidation(300_000))

    expect(forwarder.calls).toBe(1)
    expect(messages()).toContain(
      '[helio] Annotation cache primed: 2 tool definitions baselined for drift detection (baselines are per-process; a restart re-baselines — review tool_drift audit records before restarting)',
    )

    // Nothing fires before the interval elapses.
    await vi.advanceTimersByTimeAsync(299_999)
    expect(forwarder.calls).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(forwarder.calls).toBe(2)

    // The cadence repeats.
    await vi.advanceTimersByTimeAsync(300_000)
    expect(forwarder.calls).toBe(3)
    await vi.advanceTimersByTimeAsync(300_000)
    expect(forwarder.calls).toBe(4)

    // Quiet success: revalidation logs nothing of its own.
    expect(messages().filter((m) => m.includes('Tool revalidation'))).toEqual([])
    controller.stop()
  })

  it('a failed revalidation logs, keeps the cadence, and never re-enters backoff', async () => {
    const forwarder = fakeForwarder([ok(2)], fail('upstream 503'))
    const controller = await startAnnotationPrimeLoop(forwarder, revalidation(300_000))

    await vi.advanceTimersByTimeAsync(300_000)
    expect(forwarder.calls).toBe(2)
    expect(messages()).toContain(
      '[helio] Tool revalidation failed: upstream 503 — keeping the last baselines; next attempt in 300000ms',
    )

    // No backoff timer: nothing fires at the 1s retry base delay.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(forwarder.calls).toBe(2)

    // The interval cadence survives the failure.
    await vi.advanceTimersByTimeAsync(299_000)
    expect(forwarder.calls).toBe(3)
    expect(messages().filter((m) => m.includes('Tool revalidation failed'))).toHaveLength(2)
    expect(messages().some((m) => m.includes('prime retry'))).toBe(false)
    controller.stop()
  })

  it('does not revalidate when disabled, and reconfigure() retimes/starts/stops the timer live', async () => {
    const forwarder = fakeForwarder([], ok(1))
    const controller = await startAnnotationPrimeLoop(forwarder, revalidation(300_000, false))

    // Disabled at startup: no timer is armed at all.
    await vi.advanceTimersByTimeAsync(600_000)
    expect(forwarder.calls).toBe(1)
    expect(vi.getTimerCount()).toBe(0)

    // Enabling live starts the cadence.
    controller.reconfigure(revalidation(60_000))
    await vi.advanceTimersByTimeAsync(59_999)
    expect(forwarder.calls).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(forwarder.calls).toBe(2)

    // Retiming applies to the pending timer, not just the next one.
    controller.reconfigure(revalidation(10_000))
    await vi.advanceTimersByTimeAsync(9_999)
    expect(forwarder.calls).toBe(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(forwarder.calls).toBe(3)

    // Removing the section stops the cadence.
    controller.reconfigure(undefined)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(600_000)
    expect(forwarder.calls).toBe(3)
    controller.stop()
  })

  it('stop() clears both retry and revalidation timers', async () => {
    // Retry timer: a failing prime arms backoff, stop() disarms it.
    const failing = fakeForwarder([], fail('down'))
    const retryController = await startAnnotationPrimeLoop(failing, revalidation(300_000))
    expect(failing.calls).toBe(1)
    // Two live timers: the unref'd 1.5s startup race and the retry.
    expect(vi.getTimerCount()).toBe(2)
    retryController.stop()
    // Only the startup race timer remains; it never re-arms.
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(600_000)
    expect(failing.calls).toBe(1)

    // Revalidation timer: a primed loop keeps a live timer, stop() clears it.
    const primed = fakeForwarder([], ok(2))
    const revalidateController = await startAnnotationPrimeLoop(primed, revalidation(300_000))
    await vi.advanceTimersByTimeAsync(INITIAL_WAIT_MS)
    expect(vi.getTimerCount()).toBe(1)
    revalidateController.stop()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(600_000)
    expect(primed.calls).toBe(1)
  })

  it('reconfigure() during an in-flight revalidation yields exactly one timer chain', async () => {
    const firstRevalidation = deferred<AnnotationCachePrimeResult>()
    const secondRevalidation = deferred<AnnotationCachePrimeResult>()
    const forwarder = fakeForwarder(
      [ok(2), firstRevalidation.promise, secondRevalidation.promise],
      ok(2),
    )
    const controller = await startAnnotationPrimeLoop(forwarder, revalidation(300_000))

    // Revalidation #1 is in flight when the operator retimes the cadence.
    await vi.advanceTimersByTimeAsync(300_000)
    expect(forwarder.calls).toBe(2)
    controller.reconfigure(revalidation(60_000))

    // The new cadence fires while #1 is still pending.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(forwarder.calls).toBe(3)

    // The orphaned attempt completes: it must not open a second chain.
    firstRevalidation.resolve(ok(2))
    await vi.advanceTimersByTimeAsync(0)
    secondRevalidation.resolve(ok(2))
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(1)

    // Exactly one revalidation per 60s, no doubled cadence.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(forwarder.calls).toBe(4)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(forwarder.calls).toBe(5)
    controller.stop()
  })

  it('disabling via reconfigure() during an in-flight revalidation neither crashes nor reschedules', async () => {
    const inFlight = deferred<AnnotationCachePrimeResult>()
    const forwarder = fakeForwarder([ok(2), inFlight.promise], ok(2))
    const controller = await startAnnotationPrimeLoop(forwarder, revalidation(300_000))

    await vi.advanceTimersByTimeAsync(300_000)
    expect(forwarder.calls).toBe(2)

    controller.reconfigure(undefined)
    controller.reconfigure(revalidation(60_000, false))

    inFlight.resolve(fail('upstream gone'))
    await vi.advanceTimersByTimeAsync(0)

    // The orphaned failure is silent and arms nothing.
    expect(messages().some((m) => m.includes('Tool revalidation failed'))).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(600_000)
    expect(forwarder.calls).toBe(2)
    controller.stop()
  })
})
