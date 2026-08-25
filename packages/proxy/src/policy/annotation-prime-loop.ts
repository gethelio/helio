/* eslint-disable no-console -- prime loop reports through the CLI's stderr */
import type { AnnotationCachePrimeResult, GovernedForwarder } from './governed-forwarder.js'
import type { CompiledToolRevalidation } from './types.js'
import { helioLogTag } from '../util/log-label.js'

/** Upper bound to wait for startup cache priming before serving requests. */
const ANNOTATION_PRIME_INITIAL_WAIT_MS = 1_500
/** Base delay for background retry/backoff when startup priming fails. */
const ANNOTATION_PRIME_RETRY_BASE_MS = 1_000
/** Maximum backoff delay for annotation cache prime retries. */
const ANNOTATION_PRIME_RETRY_MAX_MS = 30_000
/** Random jitter added to retry delay to avoid synchronized retries. */
const ANNOTATION_PRIME_RETRY_JITTER_MS = 250

export interface AnnotationPrimeController {
  stop(): void
  /**
   * Apply a hot-reloaded `policies.tool_revalidation` section. Enabling,
   * disabling, or retiming takes effect on the next tick — no restart.
   */
  reconfigure(revalidation: CompiledToolRevalidation | undefined): void
}

function computePrimeRetryDelayMs(attempt: number): number {
  const exponent = Math.max(0, attempt - 1)
  const baseDelay = Math.min(
    ANNOTATION_PRIME_RETRY_MAX_MS,
    ANNOTATION_PRIME_RETRY_BASE_MS * 2 ** exponent,
  )
  const jitter = Math.floor(Math.random() * ANNOTATION_PRIME_RETRY_JITTER_MS)
  return Math.min(ANNOTATION_PRIME_RETRY_MAX_MS, baseDelay + jitter)
}

/**
 * Prime the annotation cache during startup, then keep retrying in the
 * background until success. Failures remain fail-closed by policy defaults.
 *
 * After the first success, when `policies.tool_revalidation` is enabled, the
 * same `primeAnnotationCache()` entry point runs on the configured interval so
 * a definition that changes long after startup is still caught (a 2026-07-28
 * upstream may advertise a cache lifetime; Helio re-checks on its own clock).
 * A failed revalidation keeps the existing baselines and the cadence — it
 * never re-enters startup backoff.
 */
export async function startAnnotationPrimeLoop(
  forwarder: Pick<GovernedForwarder, 'primeAnnotationCache'>,
  revalidation: CompiledToolRevalidation | undefined,
  upstreamName?: string,
): Promise<AnnotationPrimeController> {
  const tag = helioLogTag(upstreamName)
  let stopped = false
  let primed = false
  let retryAttempt = 0
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let current = revalidation
  let revalidateTimer: ReturnType<typeof setTimeout> | undefined
  let revalidateEpoch = 0

  const clearRetryTimer = () => {
    if (!retryTimer) return
    clearTimeout(retryTimer)
    retryTimer = undefined
  }

  const clearRevalidateTimer = () => {
    if (!revalidateTimer) return
    clearTimeout(revalidateTimer)
    revalidateTimer = undefined
  }

  /**
   * Arm the next revalidation tick. The `revalidateTimer` check keeps a
   * reconfigure that lands mid-flight from opening a second timer chain, and
   * the epoch token orphans any completion that belongs to a superseded
   * configuration.
   */
  const scheduleRevalidation = () => {
    const rv = current
    if (stopped || !primed || !rv?.enabled || revalidateTimer) return
    const epoch = revalidateEpoch
    revalidateTimer = setTimeout(() => {
      revalidateTimer = undefined
      void forwarder.primeAnnotationCache().then((result) => {
        if (epoch !== revalidateEpoch) return // reconfigured or stopped mid-flight
        if (!result.success) {
          console.error(
            `${tag} Tool revalidation failed: ${result.reason ?? 'unknown reason'} — keeping the last baselines; next attempt in ${String(rv.intervalMs)}ms`,
          )
        }
        scheduleRevalidation()
      })
    }, rv.intervalMs)
    revalidateTimer.unref()
  }

  const stop = () => {
    stopped = true
    revalidateEpoch += 1
    clearRetryTimer()
    clearRevalidateTimer()
  }

  const reconfigure = (next: CompiledToolRevalidation | undefined) => {
    current = next
    revalidateEpoch += 1 // any in-flight completion returns without rescheduling
    clearRevalidateTimer()
    scheduleRevalidation() // no-ops unless primed && enabled
  }

  const scheduleRetry = () => {
    if (stopped || primed || retryTimer) return
    retryAttempt += 1
    const delayMs = computePrimeRetryDelayMs(retryAttempt)
    console.error(
      `${tag} Annotation cache prime retry ${String(retryAttempt)} scheduled in ${String(delayMs)}ms`,
    )
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      void runPrimeAttempt('retry')
    }, delayMs)
    retryTimer.unref()
  }

  const handlePrimeResult = (phase: 'initial' | 'retry', result: AnnotationCachePrimeResult) => {
    if (stopped || primed) return

    if (result.success) {
      primed = true
      clearRetryTimer()
      const prefix =
        phase === 'initial'
          ? `${tag} Annotation cache primed`
          : `${tag} Annotation cache primed after retry ${String(retryAttempt)}`
      console.error(
        `${prefix}: ${String(result.toolsCached)} tool definitions baselined for drift detection (baselines are per-process; a restart re-baselines — review tool_drift audit records before restarting)`,
      )
      scheduleRevalidation()
      return
    }

    const reason = result.reason ?? 'unknown reason'
    if (phase === 'initial') {
      console.error(
        `${tag} Annotation cache priming failed: ${reason} — undocumented tools will be denied (fail-closed) until priming succeeds`,
      )
    } else {
      console.error(
        `${tag} Annotation cache prime retry ${String(retryAttempt)} failed: ${reason} — still fail-closed`,
      )
    }
    scheduleRetry()
  }

  const runPrimeAttempt = async (phase: 'initial' | 'retry') => {
    const result = await forwarder.primeAnnotationCache()
    handlePrimeResult(phase, result)
  }

  const initialAttempt = runPrimeAttempt('initial')
  const initialOutcome = await Promise.race([
    initialAttempt.then(() => 'completed' as const),
    new Promise<'timeout'>((resolve) => {
      setTimeout(() => {
        resolve('timeout')
      }, ANNOTATION_PRIME_INITIAL_WAIT_MS).unref()
    }),
  ])

  if (initialOutcome === 'timeout') {
    console.error(
      `${tag} Annotation cache priming did not complete within ${String(ANNOTATION_PRIME_INITIAL_WAIT_MS)}ms; continuing startup fail-closed and retrying in background`,
    )
    scheduleRetry()
  }

  return { stop, reconfigure }
}
