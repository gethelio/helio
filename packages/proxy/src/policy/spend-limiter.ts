// ---------------------------------------------------------------------------
// SpendLimiter — in-memory sliding window spend tracker.
//
// Tracks cumulative monetary spend per key (e.g. "tool:create_payment",
// "session:abc123") using a sliding window log algorithm. Each check()
// evicts expired entries, sums remaining amounts, and either records the
// spend or blocks.
//
// Mirrors the RateLimiter pattern: injectable clock, cleanup timer,
// close() for graceful teardown.
// ---------------------------------------------------------------------------

/** Options for constructing a SpendLimiter. */
export interface SpendLimiterOptions {
  /** Clock function for testable time. Defaults to `Date.now`. */
  readonly now?: () => number
  /** Interval (ms) between cleanup sweeps. 0 disables cleanup. Default: 60000. */
  readonly cleanupIntervalMs?: number
  /** Optional callback when utilization exceeds the warning threshold. */
  readonly onWarning?: (state: SpendLimitKeyState) => void
  /** Utilization ratio (0-1) that triggers the warning callback. Default: 0.8. */
  readonly warningThreshold?: number
}

/** Parameters for a spend limit check. */
export interface SpendLimitCheckParams {
  /** The bucket key, constructed by the caller (e.g. "tool:create_payment"). */
  readonly key: string
  /** The monetary amount of this call. */
  readonly amount: number
  /** Maximum cumulative spend allowed within the window. */
  readonly limit: number
  /** Sliding window duration in milliseconds. */
  readonly windowMs: number
}

/** Result of a spend limit check. */
export interface SpendLimitResult {
  /** Whether the spend was allowed (under the limit). */
  readonly allowed: boolean
  /** Cumulative spend in the current window (after this check). */
  readonly currentSpend: number
  /** The configured spend limit. */
  readonly limit: number
  /** The configured window in milliseconds. */
  readonly windowMs: number
  /** Timestamp (ms) when the oldest entry in the window expires. 0 if no entries. */
  readonly resetAtMs: number
  /**
   * Set when the call was rejected for a reason other than "would exceed limit".
   * `'invalid_amount'` indicates the amount was negative, NaN, or non-finite.
   */
  readonly reason?: 'invalid_amount'
}

/**
 * Read-only snapshot of a spend limit key's current state (for dashboard).
 *
 * DTO: field names are snake_case because this type is emitted directly over
 * `/api/limits`. `JSON.stringify(state)` produces the wire shape without a
 * mapping layer. Strictly internal types in this file (e.g. `SpendLimitResult`,
 * `SpendLimitCheckParams`) remain idiomatic camelCase.
 */
export interface SpendLimitKeyState {
  readonly key: string
  readonly current_spend: number
  readonly limit: number
  readonly currency: string
  readonly window_ms: number
  readonly reset_at_ms: number
}

/**
 * Compose a spend bucket key discriminated by the matched rule's index.
 *
 * Two spend_limit rules sharing a scope (e.g. two session-keyed rules) must
 * not share a bucket — the shared key had last-write-wins config and no
 * currency guard. The suffix — not a prefix — keeps the sideband's
 * `sender:`-prefixed cardinality accounting working. Both doors MUST build
 * spend keys through this function: they feed the same limiter instance, so
 * key-format agreement is load-bearing (issue #14 groundwork).
 */
export function spendBucketKey(baseKey: string, ruleIndex: number): string {
  return `${baseKey}:rule:${String(ruleIndex)}`
}

/** Parse the rule index out of a key built by {@link spendBucketKey}. */
const RULE_SUFFIX_RE = /:rule:(\d+)$/

/** A single spend entry: timestamp + amount. */
interface SpendEntry {
  timestamp: number
  amount: number
}

/** Internal bucket: entries + last-seen config for dashboard reads. */
interface SpendBucket {
  entries: SpendEntry[]
  limit: number
  currency: string
  windowMs: number
}

export class SpendLimiter {
  private readonly buckets = new Map<string, SpendBucket>()
  private readonly now: () => number
  private readonly onWarning: ((state: SpendLimitKeyState) => void) | undefined
  private readonly warningThreshold: number
  private timer: ReturnType<typeof setInterval> | null = null
  private closed = false

  constructor(options: SpendLimiterOptions = {}) {
    this.now = options.now ?? Date.now
    this.onWarning = options.onWarning
    this.warningThreshold = options.warningThreshold ?? 0.8

    const intervalMs = options.cleanupIntervalMs ?? 60_000
    if (intervalMs > 0) {
      this.timer = setInterval(() => {
        this.cleanup()
      }, intervalMs)
      this.timer.unref()
    }
  }

  // -------------------------------------------------------------------------
  // Core operations
  // -------------------------------------------------------------------------

  /**
   * Check and optionally record a spend against the limit.
   *
   * Evicts expired entries, sums remaining amounts, then checks:
   * - Under limit (currentSpend + amount <= limit): records and returns `allowed: true`
   * - Would exceed: does NOT record (rejected spends don't consume budget)
   */
  check(params: SpendLimitCheckParams): SpendLimitResult {
    const { key, amount, limit, windowMs } = params
    const now = this.now()
    const windowStart = now - windowMs

    // Reject negative or non-finite amounts without touching bucket state.
    // A single negative or NaN value would otherwise corrupt the sliding-window
    // sum and silently zero out the budget until the window expires.
    if (!Number.isFinite(amount) || amount < 0) {
      const existing = this.buckets.get(key)
      const activeEntries = existing
        ? existing.entries.filter((e) => e.timestamp > windowStart)
        : []
      const currentSpend = activeEntries.reduce((sum, e) => sum + e.amount, 0)
      const oldest = activeEntries[0]
      return {
        allowed: false,
        currentSpend,
        limit,
        windowMs,
        resetAtMs: oldest ? oldest.timestamp + windowMs : 0,
        reason: 'invalid_amount',
      }
    }

    let bucket = this.buckets.get(key)
    if (!bucket) {
      bucket = { entries: [], limit, currency: '', windowMs }
      this.buckets.set(key, bucket)
    }

    // Update stored config (may change on policy hot-reload)
    bucket.limit = limit
    bucket.windowMs = windowMs

    // Evict expired entries
    bucket.entries = bucket.entries.filter((e) => e.timestamp > windowStart)

    const currentSpend = bucket.entries.reduce((sum, e) => sum + e.amount, 0)

    if (currentSpend + amount > limit) {
      // Would exceed limit — do NOT record the attempt
      const oldest = bucket.entries[0]
      return {
        allowed: false,
        currentSpend,
        limit,
        windowMs,
        resetAtMs: oldest ? oldest.timestamp + windowMs : 0,
      }
    }

    // Under limit — record and allow
    bucket.entries.push({ timestamp: now, amount })
    const newSpend = currentSpend + amount
    const resetAtMs = (bucket.entries[0]?.timestamp ?? now) + windowMs

    // Emit warning when approaching the limit
    if (this.onWarning && newSpend / limit >= this.warningThreshold) {
      this.safeWarn({
        key,
        current_spend: newSpend,
        limit,
        currency: bucket.currency,
        window_ms: windowMs,
        reset_at_ms: resetAtMs,
      })
    }

    return {
      allowed: true,
      currentSpend: newSpend,
      limit,
      windowMs,
      resetAtMs,
    }
  }

  /**
   * Unconditionally record a spend against the limit.
   *
   * Unlike check(), this always appends the amount — even when it pushes the
   * window past the limit — because the spend it represents has already been
   * incurred. The sideband peeks at /evaluate and commits here at /audit once
   * the external call ran (issue #12, D3).
   *
   * Throws on a negative or non-finite amount: such amounts are rejected at
   * /evaluate, so one reaching record() is a logic bug we surface loudly rather
   * than silently corrupt the sliding-window sum. Warnings fire only while the
   * post-append spend stays within the limit (parity with check()).
   */
  record(params: SpendLimitCheckParams): SpendLimitResult {
    const { key, amount, limit, windowMs } = params

    if (!Number.isFinite(amount) || amount < 0) {
      throw new RangeError(
        `SpendLimiter.record() received an invalid amount (${String(amount)}); ` +
          'invalid amounts must be rejected at /evaluate, never committed',
      )
    }

    const now = this.now()
    const windowStart = now - windowMs

    let bucket = this.buckets.get(key)
    if (!bucket) {
      bucket = { entries: [], limit, currency: '', windowMs }
      this.buckets.set(key, bucket)
    }

    // Update stored config (may change on policy hot-reload)
    bucket.limit = limit
    bucket.windowMs = windowMs

    // Evict expired entries, then append unconditionally.
    bucket.entries = bucket.entries.filter((e) => e.timestamp > windowStart)
    bucket.entries.push({ timestamp: now, amount })
    const currentSpend = bucket.entries.reduce((sum, e) => sum + e.amount, 0)
    const resetAtMs = (bucket.entries[0]?.timestamp ?? now) + windowMs

    if (this.onWarning && currentSpend <= limit && currentSpend / limit >= this.warningThreshold) {
      this.safeWarn({
        key,
        current_spend: currentSpend,
        limit,
        currency: bucket.currency,
        window_ms: windowMs,
        reset_at_ms: resetAtMs,
      })
    }

    return {
      allowed: currentSpend <= limit,
      currentSpend,
      limit,
      windowMs,
      resetAtMs,
    }
  }

  /**
   * Check the spend limit without recording the spend (non-destructive).
   *
   * Used by dry-run mode to determine what would happen without consuming
   * budget in the bucket.
   */
  peek(params: SpendLimitCheckParams): SpendLimitResult {
    const { key, amount, limit, windowMs } = params
    const now = this.now()
    const windowStart = now - windowMs

    const bucket = this.buckets.get(key)

    // Reject negative or non-finite amounts without mutating state. Same guard
    // as check() — peek must agree so dry-run cannot leak the attack pattern.
    if (!Number.isFinite(amount) || amount < 0) {
      const activeEntries = bucket ? bucket.entries.filter((e) => e.timestamp > windowStart) : []
      const currentSpend = activeEntries.reduce((sum, e) => sum + e.amount, 0)
      const oldest = activeEntries[0]
      return {
        allowed: false,
        currentSpend,
        limit,
        windowMs,
        resetAtMs: oldest ? oldest.timestamp + windowMs : 0,
        reason: 'invalid_amount',
      }
    }

    if (!bucket) {
      // No bucket exists — would be allowed (first spend)
      const wouldExceed = amount > limit
      return {
        allowed: !wouldExceed,
        currentSpend: wouldExceed ? 0 : amount,
        limit,
        windowMs,
        resetAtMs: now + windowMs,
      }
    }

    // Sum active entries without mutating
    const activeEntries = bucket.entries.filter((e) => e.timestamp > windowStart)
    const currentSpend = activeEntries.reduce((sum, e) => sum + e.amount, 0)

    if (currentSpend + amount > limit) {
      const oldest = activeEntries[0]
      return {
        allowed: false,
        currentSpend,
        limit,
        windowMs,
        resetAtMs: oldest ? oldest.timestamp + windowMs : 0,
      }
    }

    const newSpend = currentSpend + amount
    const oldest = activeEntries[0]
    return {
      allowed: true,
      currentSpend: newSpend,
      limit,
      windowMs,
      resetAtMs: oldest ? oldest.timestamp + windowMs : now + windowMs,
    }
  }

  /**
   * Set the display currency for a key. Called by the governed forwarder
   * after check() so dashboard reads include the currency label.
   */
  setCurrency(key: string, currency: string): void {
    const bucket = this.buckets.get(key)
    if (bucket) bucket.currency = currency
  }

  // -------------------------------------------------------------------------
  // Read operations (for dashboard API)
  // -------------------------------------------------------------------------

  /** Get the current state of a single key. Returns undefined if not tracked. */
  getKeyState(key: string): SpendLimitKeyState | undefined {
    const bucket = this.buckets.get(key)
    if (!bucket) return undefined

    // Evict expired for an accurate read
    const windowStart = this.now() - bucket.windowMs
    bucket.entries = bucket.entries.filter((e) => e.timestamp > windowStart)

    if (bucket.entries.length === 0) {
      this.buckets.delete(key)
      return undefined
    }

    const currentSpend = bucket.entries.reduce((sum, e) => sum + e.amount, 0)

    return {
      key,
      current_spend: currentSpend,
      limit: bucket.limit,
      currency: bucket.currency,
      window_ms: bucket.windowMs,
      reset_at_ms: (bucket.entries[0]?.timestamp ?? 0) + bucket.windowMs,
    }
  }

  /** List all tracked keys with their current state. */
  listKeyStates(): SpendLimitKeyState[] {
    const states: SpendLimitKeyState[] = []
    // Iterate over keys to trigger lazy eviction via getKeyState
    for (const key of [...this.buckets.keys()]) {
      const state = this.getKeyState(key)
      if (state) states.push(state)
    }
    return states
  }

  // -------------------------------------------------------------------------
  // Maintenance
  // -------------------------------------------------------------------------

  /** Sweep all buckets: remove expired entries, delete empty buckets. */
  cleanup(): void {
    const now = this.now()
    for (const [key, bucket] of this.buckets) {
      const windowStart = now - bucket.windowMs
      bucket.entries = bucket.entries.filter((e) => e.timestamp > windowStart)
      if (bucket.entries.length === 0) {
        this.buckets.delete(key)
      }
    }
  }

  /** Clear all spend limit state. Called on policy hot-reload. */
  reset(): void {
    this.buckets.clear()
  }

  /**
   * Reconcile bucket state against a new policy's spend configuration.
   *
   * Walks every existing bucket and checks whether its last-seen
   * `{ limit, currency, windowMs }` tuple still appears in `validConfigs`.
   * Buckets whose config is unchanged are left untouched — cumulative spend
   * and elapsed-window progress are preserved across hot-reloads. Buckets
   * whose config is gone (rule changed or removed) are evicted so the next
   * check lazy-creates a fresh bucket under the new config.
   *
   * Keys built by {@link spendBucketKey} carry the owning rule's index, and
   * for those the tuple must match at THAT index (`config.ruleIndex`): a
   * reorder that shifts a spend rule's index evicts its old-index bucket
   * instead of leaving an orphan no rule reads again — or worse, letting
   * whatever rule now sits at that index adopt another rule's accrued spend.
   * Un-suffixed keys keep the tuple-anywhere match.
   *
   * Currency is part of the tuple because a USD→EUR switch is a meaningful
   * policy change — the same numeric limit buys a different amount of real
   * spend, so the bucket must reset. This replaces the old `reset()` call
   * on every hot-reload, which wiped all state even when the matching rule
   * was unchanged.
   */
  reconcile(
    validConfigs: Iterable<{
      limit: number
      currency: string
      windowMs: number
      ruleIndex?: number
    }>,
  ): void {
    const valid = new Set<string>()
    const byIndex = new Map<number, string>()
    for (const config of validConfigs) {
      const tuple = `${String(config.limit)}|${config.currency}|${String(config.windowMs)}`
      if (config.ruleIndex === undefined) {
        valid.add(tuple)
      } else {
        byIndex.set(config.ruleIndex, tuple)
      }
    }

    for (const [key, bucket] of this.buckets) {
      const tuple = `${String(bucket.limit)}|${bucket.currency}|${String(bucket.windowMs)}`
      const suffix = RULE_SUFFIX_RE.exec(key)
      const survives = suffix ? byIndex.get(Number(suffix[1])) === tuple : valid.has(tuple)
      if (!survives) {
        this.buckets.delete(key)
      }
    }
  }

  /** Stop the cleanup timer and mark as closed. */
  /**
   * Invoke the warning callback without letting a subscriber throw into the
   * limiter's caller: a warning fires after state has already mutated, and a
   * governed call must not be blocked (or double-charged on retry) by an
   * observability bug.
   */
  private safeWarn(state: SpendLimitKeyState): void {
    if (!this.onWarning) return
    try {
      this.onWarning(state)
    } catch (err) {
      // eslint-disable-next-line no-console -- Subscriber bugs must not affect enforcement
      console.error('[helio] limit warning subscriber threw:', err)
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.buckets.clear()
  }
}
