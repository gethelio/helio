// ---------------------------------------------------------------------------
// RateLimiter — in-memory sliding window rate limiter.
//
// Tracks call timestamps per key (e.g. "tool:send_email", "session:abc123")
// using a sliding window log algorithm. Each check() evicts expired entries,
// counts remaining, and either records the call or blocks.
//
// Follows the EvidenceStore/ApprovalQueue pattern: injectable clock, cleanup
// timer, close() for graceful teardown.
// ---------------------------------------------------------------------------

/** Options for constructing a RateLimiter. */
export interface RateLimiterOptions {
  /** Clock function for testable time. Defaults to `Date.now`. */
  readonly now?: () => number
  /** Interval (ms) between cleanup sweeps. 0 disables cleanup. Default: 60000. */
  readonly cleanupIntervalMs?: number
  /** Optional callback when utilization exceeds the warning threshold. */
  readonly onWarning?: (state: RateLimitKeyState) => void
  /** Utilization ratio (0-1) that triggers the warning callback. Default: 0.8. */
  readonly warningThreshold?: number
}

/** Parameters for a rate limit check. */
export interface RateLimitCheckParams {
  /** The bucket key, constructed by the caller (e.g. "tool:send_email"). */
  readonly key: string
  /** Maximum calls allowed within the window. */
  readonly maxCalls: number
  /** Sliding window duration in milliseconds. */
  readonly windowMs: number
}

/** Result of a rate limit check. */
export interface RateLimitResult {
  /** Whether the call was allowed (under the limit). */
  readonly allowed: boolean
  /** Number of calls in the current window (after this check). */
  readonly current: number
  /** The configured max calls. */
  readonly limit: number
  /** The configured window in milliseconds. */
  readonly windowMs: number
  /** Timestamp (ms) when the oldest entry in the window expires. 0 if no entries. */
  readonly resetAtMs: number
}

/**
 * Read-only snapshot of a rate limit key's current state (for dashboard).
 *
 * DTO: field names are snake_case because this type is emitted directly over
 * `/api/limits`. `JSON.stringify(state)` produces the wire shape without a
 * mapping layer. Strictly internal types in this file (e.g. `RateLimitResult`,
 * `RateLimitCheckParams`) remain idiomatic camelCase.
 */
export interface RateLimitKeyState {
  readonly key: string
  readonly current: number
  readonly limit: number
  readonly window_ms: number
  readonly reset_at_ms: number
}

/** Internal bucket: timestamps + last-seen config for dashboard reads. */
interface Bucket {
  timestamps: number[]
  maxCalls: number
  windowMs: number
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>()
  private readonly now: () => number
  private readonly onWarning: ((state: RateLimitKeyState) => void) | undefined
  private readonly warningThreshold: number
  private timer: ReturnType<typeof setInterval> | null = null
  private closed = false

  constructor(options: RateLimiterOptions = {}) {
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
   * Check and optionally record a call against the rate limit.
   *
   * Evicts expired timestamps, then checks the count:
   * - Under limit: records the timestamp and returns `allowed: true`
   * - At/over limit: does NOT record (blocked calls don't consume a slot)
   */
  check(params: RateLimitCheckParams): RateLimitResult {
    const { key, maxCalls, windowMs } = params
    const now = this.now()
    const windowStart = now - windowMs

    let bucket = this.buckets.get(key)
    if (!bucket) {
      bucket = { timestamps: [], maxCalls, windowMs }
      this.buckets.set(key, bucket)
    }

    // Update stored config (may change on policy hot-reload)
    bucket.maxCalls = maxCalls
    bucket.windowMs = windowMs

    // Evict expired timestamps
    bucket.timestamps = bucket.timestamps.filter((ts) => ts > windowStart)

    if (bucket.timestamps.length >= maxCalls) {
      // Over limit — do NOT record the attempt
      const oldest = bucket.timestamps[0] ?? 0
      return {
        allowed: false,
        current: bucket.timestamps.length,
        limit: maxCalls,
        windowMs,
        resetAtMs: oldest + windowMs,
      }
    }

    // Under limit — record and allow
    bucket.timestamps.push(now)
    const current = bucket.timestamps.length
    const resetAtMs = (bucket.timestamps[0] ?? now) + windowMs

    // Emit warning when approaching the limit
    if (this.onWarning && current / maxCalls >= this.warningThreshold) {
      this.onWarning({ key, current, limit: maxCalls, window_ms: windowMs, reset_at_ms: resetAtMs })
    }

    return {
      allowed: true,
      current,
      limit: maxCalls,
      windowMs,
      resetAtMs,
    }
  }

  /**
   * Check the rate limit without recording the call (non-destructive).
   *
   * Used by dry-run mode to determine what would happen without consuming
   * a slot in the bucket.
   */
  peek(params: RateLimitCheckParams): RateLimitResult {
    const { key, maxCalls, windowMs } = params
    const now = this.now()
    const windowStart = now - windowMs

    const bucket = this.buckets.get(key)
    if (!bucket) {
      // No bucket exists — would be allowed (first call)
      return {
        allowed: true,
        current: 1,
        limit: maxCalls,
        windowMs,
        resetAtMs: now + windowMs,
      }
    }

    // Count entries in the window without mutating
    const activeCount = bucket.timestamps.filter((ts) => ts > windowStart).length

    if (activeCount >= maxCalls) {
      const oldest = bucket.timestamps.find((ts) => ts > windowStart) ?? 0
      return {
        allowed: false,
        current: activeCount,
        limit: maxCalls,
        windowMs,
        resetAtMs: oldest + windowMs,
      }
    }

    const oldest = bucket.timestamps.find((ts) => ts > windowStart) ?? now
    return {
      allowed: true,
      current: activeCount + 1,
      limit: maxCalls,
      windowMs,
      resetAtMs: oldest + windowMs,
    }
  }

  // -------------------------------------------------------------------------
  // Read operations (for dashboard API)
  // -------------------------------------------------------------------------

  /** Get the current state of a single key. Returns undefined if not tracked. */
  getKeyState(key: string): RateLimitKeyState | undefined {
    const bucket = this.buckets.get(key)
    if (!bucket) return undefined

    // Evict expired for an accurate read
    const windowStart = this.now() - bucket.windowMs
    bucket.timestamps = bucket.timestamps.filter((ts) => ts > windowStart)

    if (bucket.timestamps.length === 0) {
      this.buckets.delete(key)
      return undefined
    }

    return {
      key,
      current: bucket.timestamps.length,
      limit: bucket.maxCalls,
      window_ms: bucket.windowMs,
      reset_at_ms: (bucket.timestamps[0] ?? 0) + bucket.windowMs,
    }
  }

  /** List all tracked keys with their current state. */
  listKeyStates(): RateLimitKeyState[] {
    const states: RateLimitKeyState[] = []
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

  /** Sweep all buckets: remove expired timestamps, delete empty buckets. */
  cleanup(): void {
    const now = this.now()
    for (const [key, bucket] of this.buckets) {
      const windowStart = now - bucket.windowMs
      bucket.timestamps = bucket.timestamps.filter((ts) => ts > windowStart)
      if (bucket.timestamps.length === 0) {
        this.buckets.delete(key)
      }
    }
  }

  /** Clear all rate limit state. Called on policy hot-reload. */
  reset(): void {
    this.buckets.clear()
  }

  /**
   * Reconcile bucket state against a new policy's limit configuration.
   *
   * Walks every existing bucket and checks whether its last-seen
   * `{ maxCalls, windowMs }` tuple still appears anywhere in `validConfigs`.
   * Buckets whose config is still present are left untouched — counters and
   * elapsed-window progress are preserved across hot-reloads. Buckets whose
   * config is gone (rule changed or removed) are evicted so the next check
   * lazy-creates a fresh bucket under the new config.
   *
   * This is the compare-and-evict semantic that replaces the old `reset()`
   * call on every hot-reload, which wiped all state even when the matching
   * rule was unchanged.
   */
  reconcile(validConfigs: Iterable<{ maxCalls: number; windowMs: number }>): void {
    const valid = new Set<string>()
    for (const config of validConfigs) {
      valid.add(`${String(config.maxCalls)}|${String(config.windowMs)}`)
    }

    for (const [key, bucket] of this.buckets) {
      const tuple = `${String(bucket.maxCalls)}|${String(bucket.windowMs)}`
      if (!valid.has(tuple)) {
        this.buckets.delete(key)
      }
    }
  }

  /** Stop the cleanup timer and mark as closed. */
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
