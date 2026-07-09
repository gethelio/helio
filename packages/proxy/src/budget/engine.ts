// ---------------------------------------------------------------------------
// BudgetEngine — in-memory state for named cross-tool budgets (issue #14).
//
// One engine instance is shared by both doors (MCP forwarder and sideband
// governance service): one pot, both doors. The gate sequence is the caller's
// job — resolveCharges → peekAll (all matching budgets, all-or-nothing) →
// recordAll only when the call actually proceeds. peekAll never mutates;
// recordAll writes the ledger sink first (one atomic batch) and applies
// in-memory state only after the sink commits, so a failed durable write can
// never leave memory and ledger disagreeing about money.
//
// Mirrors the SpendLimiter pattern: injectable clock, cleanup timer, close().
// ---------------------------------------------------------------------------

import { resolvePath } from '../policy/matchers.js'
import type { CompiledBudget } from './types.js'

/** Everything the engine needs about one tool call to resolve its charges. */
export interface BudgetChargeContext {
  readonly toolName: string
  readonly toolArguments: Record<string, unknown> | undefined
  readonly sessionId: string | null
  /** Adapter-supplied sender id (sideband only); null on the MCP path. */
  readonly senderId: string | null
}

/** One budget's share of a call: which bucket, how much. */
export interface BudgetCharge {
  readonly budget: CompiledBudget
  readonly bucketKey: string
  readonly amount: number
  /**
   * The budget's config generation at peek time. A tuple-changing reload
   * bumps the generation and resets the pot; a charge frozen before the bump
   * (sideband /evaluate → /audit, or an MCP approval wait) is stale and MUST
   * NOT repopulate the new pot with old-config spend — recordAll skips it.
   */
  readonly generation: number
}

/** A budget whose contributor matched but whose amount was unusable. */
export interface BudgetChargeFailure {
  readonly budget: CompiledBudget
  readonly bucketKey: string
  readonly reason: 'invalid_amount'
  /** REAL accrued spend on the bucket the charge would have hit. */
  readonly spent: number
  readonly remaining: number
  /** Epoch ms when the oldest entry ages out (duration); null for session pots. */
  readonly resetAtMs: number | null
}

/** Snapshot of one budget's state relative to a charge. */
export interface BudgetPeekEntry {
  readonly budget: CompiledBudget
  readonly bucketKey: string
  readonly amount: number
  readonly allowed: boolean
  /** Spend accrued before this charge. */
  readonly spent: number
  /** Headroom before this charge: max(0, limit - spent). */
  readonly remaining: number
  /** Epoch ms when the oldest entry ages out (duration); null for session pots. */
  readonly resetAtMs: number | null
  /**
   * Set on recordAll snapshots for charges frozen before a tuple-changing
   * reload: the executed spend was ledgered under its evaluate-time
   * generation, but the reset pot was not touched.
   */
  readonly stale?: true
}

/** Metadata recorded with every committed charge of one call. */
export interface BudgetCommitMeta {
  readonly kind: 'spend' | 'approved_overage'
  readonly auditRecordId: string
  readonly origin: string
  readonly toolName: string
  readonly timestampIso: string
}

/**
 * One durable ledger row. DTO: snake_case, matching the `budget_events`
 * table columns the persistence layer writes.
 */
export interface BudgetLedgerRow {
  readonly budget_name: string
  readonly bucket_key: string
  readonly kind: 'spend' | 'approved_overage'
  readonly amount: number
  readonly currency: string
  readonly tool_name: string
  readonly origin: string
  readonly audit_record_id: string
  readonly timestamp: string
  readonly timestamp_ms: number
  /**
   * The charge's config generation at evaluate time. Rows from a stale
   * generation are historical accounting for money that really moved; live
   * replay only ever reads the current generation (the epoch of PR 2).
   */
  readonly generation: number
}

/**
 * Durable sink for committed charges. `commitAll` MUST be transactional:
 * either every row of the batch persists or none does (a throw means none).
 * The in-memory default is a no-op; the SQLite ledger implements this.
 */
export interface BudgetLedgerSink {
  commitAll(rows: readonly BudgetLedgerRow[]): void
}

/** Payload for the per-charge commit callback (dashboard event bus). */
export interface BudgetCommitEvent {
  readonly name: string
  readonly bucket_key: string
  readonly kind: 'spend' | 'approved_overage'
  readonly amount: number
  readonly spent: number
  readonly remaining: number
  readonly limit: number
  readonly currency: string
  readonly utilization: number
}

/** Wire-ready bucket state for `GET /api/budgets` (snake_case DTO). */
export interface BudgetBucketState {
  readonly bucket_key: string
  readonly spent: number
  readonly remaining: number
  readonly reset_at_ms: number | null
  readonly last_activity_ms: number
}

/** Wire-ready budget state for `GET /api/budgets` (snake_case DTO). */
export interface BudgetState {
  readonly name: string
  readonly limit: number
  readonly currency: string
  readonly window: string
  readonly key: 'global' | 'session' | 'sender_id'
  readonly on_exceed: 'deny' | 'require_approval'
  readonly buckets: readonly BudgetBucketState[]
}

export interface BudgetEngineOptions {
  readonly budgets?: readonly CompiledBudget[]
  /** Clock function for testable time. Defaults to `Date.now`. */
  readonly now?: () => number
  /** Interval (ms) between GC sweeps. 0 disables the timer. Default: 60000. */
  readonly cleanupIntervalMs?: number
  /** Durable sink; defaults to a no-op (state resets on restart). */
  readonly ledger?: BudgetLedgerSink
  /** Fired once per committed charge with post-record numbers. */
  readonly onCommit?: (event: BudgetCommitEvent) => void
}

interface BudgetBucket {
  /** Sliding-window entries (duration windows). */
  entries: Array<{ timestampMs: number; amount: number }>
  /** Running total (session windows). */
  total: number
  lastActivityMs: number
}

const NOOP_LEDGER: BudgetLedgerSink = { commitAll: () => {} }

export class BudgetEngine {
  private budgets = new Map<string, CompiledBudget>()
  /** budget name → bucket key → bucket. */
  private readonly state = new Map<string, Map<string, BudgetBucket>>()
  /** budget name → config generation; bumped whenever the pot resets. */
  private readonly generations = new Map<string, number>()
  private readonly now: () => number
  private readonly ledger: BudgetLedgerSink
  private readonly onCommit: ((event: BudgetCommitEvent) => void) | undefined
  private timer: ReturnType<typeof setInterval> | null = null
  private closed = false

  constructor(options: BudgetEngineOptions = {}) {
    this.now = options.now ?? Date.now
    this.ledger = options.ledger ?? NOOP_LEDGER
    this.onCommit = options.onCommit
    for (const budget of options.budgets ?? []) {
      this.budgets.set(budget.name, budget)
      this.generations.set(budget.name, 1)
    }

    const intervalMs = options.cleanupIntervalMs ?? 60_000
    if (intervalMs > 0) {
      this.timer = setInterval(() => {
        this.gc()
      }, intervalMs)
      this.timer.unref()
    }
  }

  // -------------------------------------------------------------------------
  // Gate operations
  // -------------------------------------------------------------------------

  /**
   * Resolve which budgets a call feeds and how much it charges each.
   *
   * A budget participates when any contributor glob matches the tool name;
   * the FIRST matching contributor (config order) supplies the amount field.
   * A missing, non-numeric, negative, or non-finite amount fails closed as a
   * `failures` entry — the caller must deny the call.
   */
  resolveCharges(ctx: BudgetChargeContext): {
    charges: BudgetCharge[]
    failures: BudgetChargeFailure[]
  } {
    const charges: BudgetCharge[] = []
    const failures: BudgetChargeFailure[] = []

    for (const budget of this.budgets.values()) {
      const contributor = budget.contributors.find((c) => c.tool.test(ctx.toolName))
      if (!contributor) continue

      const raw = resolvePath(contributor.field, ctx.toolArguments ?? {})
      if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
        // Fail closed with the REAL bucket snapshot — feedback must not
        // fabricate zero spend for a pot that has accrued state.
        const bucketKey = this.bucketKey(budget, ctx)
        const nowMs = this.now()
        const bucket = this.liveBucket(budget, bucketKey, nowMs)
        const spent = bucket ? this.spentOf(budget, bucket, nowMs) : 0
        failures.push({
          budget,
          bucketKey,
          reason: 'invalid_amount',
          spent,
          remaining: Math.max(0, budget.limit - spent),
          // null is reserved for session pots on the wire; an empty duration
          // bucket resets one window from now.
          resetAtMs:
            budget.window.kind === 'duration'
              ? bucket && bucket.entries.length > 0
                ? (bucket.entries[0]?.timestampMs ?? nowMs) + budget.window.windowMs
                : nowMs + budget.window.windowMs
              : null,
        })
        continue
      }

      charges.push({
        budget,
        bucketKey: this.bucketKey(budget, ctx),
        amount: raw,
        generation: this.generations.get(budget.name) ?? 0,
      })
    }

    return { charges, failures }
  }

  /** Check every charge without mutating. All-or-nothing: one deny flips `allowed`. */
  peekAll(charges: readonly BudgetCharge[]): { allowed: boolean; entries: BudgetPeekEntry[] } {
    const entries = charges.map((charge) => this.snapshot(charge))
    return { allowed: entries.every((entry) => entry.allowed), entries }
  }

  /**
   * Commit every charge of one call: ledger first (one atomic batch), then
   * in-memory state, then the commit events. A sink throw propagates and
   * leaves ALL in-memory buckets untouched — no partial commit, ever.
   * Recording is unconditional past the sink (an approved overage
   * legitimately pushes a bucket past its limit).
   */
  recordAll(charges: readonly BudgetCharge[], meta: BudgetCommitMeta): BudgetPeekEntry[] {
    const nowMs = this.now()

    // Stale-generation charges were frozen before a tuple-changing reload (or
    // a removal) reset the pot. The call EXECUTED, so the money stays on the
    // ledger — under its evaluate-time generation — but it must not mutate
    // the reset pot's live state.
    const current: BudgetCharge[] = []
    const stale: BudgetCharge[] = []
    for (const charge of charges) {
      if (this.generations.get(charge.budget.name) === charge.generation) {
        current.push(charge)
      } else {
        stale.push(charge)
        // eslint-disable-next-line no-console -- Intentional operational warning
        console.error(
          `[helio] Budget "${charge.budget.name}": an in-flight charge outlived a config ` +
            `change; its amount is ledgered under the old generation but does not count ` +
            `against the current pot`,
        )
      }
    }

    this.ledger.commitAll(
      charges.map((charge) => ({
        budget_name: charge.budget.name,
        bucket_key: charge.bucketKey,
        kind: meta.kind,
        amount: charge.amount,
        currency: charge.budget.currency,
        tool_name: meta.toolName,
        origin: meta.origin,
        audit_record_id: meta.auditRecordId,
        timestamp: meta.timestampIso,
        timestamp_ms: nowMs,
        generation: charge.generation,
      })),
    )

    // Mutate EVERY bucket before emitting any callback: a throwing subscriber
    // must not leave memory partially updated relative to the ledger batch
    // that already committed above.
    const snapshots: BudgetPeekEntry[] = []
    for (const charge of current) {
      const bucket = this.bucketFor(charge.budget.name, charge.bucketKey)
      if (charge.budget.window.kind === 'duration') {
        this.evictExpired(bucket, charge.budget.window.windowMs, nowMs)
        bucket.entries.push({ timestampMs: nowMs, amount: charge.amount })
      } else {
        bucket.total += charge.amount
      }
      bucket.lastActivityMs = nowMs
      snapshots.push(this.snapshot(charge, { postRecord: true }))
    }
    for (const charge of stale) {
      // An honest snapshot: the CURRENT pot's real numbers (which this charge
      // deliberately did not touch) plus the stale marker — so use the live
      // config where the name still exists (the frozen charge carries the
      // pre-reload one). snapshot() keeps the reset contract: null stays
      // session-only.
      const liveBudget = this.budgets.get(charge.budget.name) ?? charge.budget
      snapshots.push({ ...this.snapshot({ ...charge, budget: liveBudget }), stale: true })
    }

    for (let i = 0; i < current.length; i++) {
      const charge = current[i]
      const snapshot = snapshots[i]
      if (!charge || !snapshot || !this.onCommit) continue
      try {
        this.onCommit({
          name: charge.budget.name,
          bucket_key: charge.bucketKey,
          kind: meta.kind,
          amount: charge.amount,
          spent: snapshot.spent,
          remaining: snapshot.remaining,
          limit: charge.budget.limit,
          currency: charge.budget.currency,
          utilization: snapshot.spent / charge.budget.limit,
        })
      } catch (err) {
        // eslint-disable-next-line no-console -- Subscriber bugs must not corrupt money state
        console.error('[helio] budget onCommit subscriber threw:', err)
      }
    }
    return snapshots
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Swap budget configs on hot-reload. Identity is the NAME: removed names
   * drop their live buckets; a changed `{limit, currency, window, key}` tuple
   * resets the budget's buckets (a different pool or scope structure);
   * everything else — contributors, on_exceed — applies to the accrued state
   * as-is, because those edits do not change what was already spent.
   */
  reconcile(next: readonly CompiledBudget[]): void {
    const nextByName = new Map(next.map((budget) => [budget.name, budget]))

    for (const [name, budget] of nextByName) {
      const current = this.budgets.get(name)
      if (!current || tupleChanged(current, budget)) {
        // New name or a different pool: reset state and invalidate any
        // in-flight charges frozen under the old generation.
        this.state.delete(name)
        this.generations.set(name, (this.generations.get(name) ?? 0) + 1)
      }
    }
    for (const name of [...this.budgets.keys()]) {
      if (nextByName.has(name)) continue
      this.state.delete(name)
      // A removed budget's generation bumps too: an in-flight charge frozen
      // before the removal must go stale, or its commit would recreate
      // hidden bucket state for a budget that no longer exists. Generations
      // for removed names are kept (not deleted) so a later re-add keeps
      // counting up instead of colliding with older in-flight charges.
      this.generations.set(name, (this.generations.get(name) ?? 0) + 1)
    }

    this.budgets = nextByName
  }

  /** Sweep: collect idle session pots, evict expired duration entries. */
  gc(): void {
    const nowMs = this.now()
    for (const [name, buckets] of this.state) {
      const budget = this.budgets.get(name)
      if (!budget) {
        this.state.delete(name)
        continue
      }
      for (const [key, bucket] of buckets) {
        if (budget.window.kind === 'session') {
          if (nowMs - bucket.lastActivityMs > budget.window.idleTtlMs) buckets.delete(key)
        } else {
          this.evictExpired(bucket, budget.window.windowMs, nowMs)
          if (bucket.entries.length === 0) buckets.delete(key)
        }
      }
      if (buckets.size === 0) this.state.delete(name)
    }
  }

  // -------------------------------------------------------------------------
  // Read surface
  // -------------------------------------------------------------------------

  /**
   * Wire-ready state for `GET /api/budgets`. Configured budgets appear even
   * with zero live buckets, so the dashboard shows every pot at headroom.
   */
  listStates(): BudgetState[] {
    const nowMs = this.now()
    return [...this.budgets.values()].map((budget) => {
      const buckets: BudgetBucketState[] = []
      for (const key of [...(this.state.get(budget.name)?.keys() ?? [])]) {
        const bucket = this.liveBucket(budget, key, nowMs)
        if (!bucket) continue
        const spent = this.spentOf(budget, bucket, nowMs)
        buckets.push({
          bucket_key: key,
          spent,
          remaining: Math.max(0, budget.limit - spent),
          reset_at_ms:
            budget.window.kind === 'duration'
              ? (bucket.entries[0]?.timestampMs ?? nowMs) + budget.window.windowMs
              : null,
          last_activity_ms: bucket.lastActivityMs,
        })
      }
      return {
        name: budget.name,
        limit: budget.limit,
        currency: budget.currency,
        window: budget.windowRaw,
        key: budget.key,
        on_exceed: budget.onExceed,
        buckets,
      }
    })
  }

  /** Whether any budget holds a live bucket under `key` (cardinality probes). */
  hasBucket(key: string): boolean {
    const nowMs = this.now()
    for (const name of [...this.state.keys()]) {
      const budget = this.budgets.get(name)
      if (!budget) continue
      if (this.liveBucket(budget, key, nowMs)) return true
    }
    return false
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.state.clear()
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private bucketKey(budget: CompiledBudget, ctx: BudgetChargeContext): string {
    switch (budget.key) {
      case 'session':
        return `budget:${budget.name}:session:${ctx.sessionId ?? 'unknown'}`
      case 'sender_id':
        return `budget:${budget.name}:sender:${ctx.senderId ?? 'unknown'}`
      case 'global':
        return `budget:${budget.name}:global`
    }
  }

  private bucketFor(name: string, key: string): BudgetBucket {
    let buckets = this.state.get(name)
    if (!buckets) {
      buckets = new Map()
      this.state.set(name, buckets)
    }
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { entries: [], total: 0, lastActivityMs: this.now() }
      buckets.set(key, bucket)
    }
    return bucket
  }

  private evictExpired(bucket: BudgetBucket, windowMs: number, nowMs: number): void {
    const windowStart = nowMs - windowMs
    bucket.entries = bucket.entries.filter((entry) => entry.timestampMs > windowStart)
  }

  /**
   * Fetch a bucket for reading, evicting expired duration entries first and
   * pruning the bucket if nothing is left. Reads must never see (or keep
   * alive, via `hasBucket`-driven capacity slots) state the window has
   * already expired — expiry is lazy on read, not just on the sweep timer.
   */
  private liveBucket(budget: CompiledBudget, key: string, nowMs: number): BudgetBucket | undefined {
    const buckets = this.state.get(budget.name)
    const bucket = buckets?.get(key)
    if (!bucket || !buckets) return undefined
    if (budget.window.kind === 'duration') {
      this.evictExpired(bucket, budget.window.windowMs, nowMs)
      if (bucket.entries.length === 0) {
        buckets.delete(key)
        if (buckets.size === 0) this.state.delete(budget.name)
        return undefined
      }
    }
    return bucket
  }

  private spentOf(budget: CompiledBudget, bucket: BudgetBucket, nowMs: number): number {
    if (budget.window.kind === 'session') return bucket.total
    const windowStart = nowMs - budget.window.windowMs
    return bucket.entries.reduce(
      (sum, entry) => (entry.timestampMs > windowStart ? sum + entry.amount : sum),
      0,
    )
  }

  private snapshot(charge: BudgetCharge, options: { postRecord?: boolean } = {}): BudgetPeekEntry {
    const nowMs = this.now()
    const bucket = this.liveBucket(charge.budget, charge.bucketKey, nowMs)
    const accrued = bucket ? this.spentOf(charge.budget, bucket, nowMs) : 0
    // Pre-record: `spent` is the accrued state the charge is checked against.
    // Post-record: the charge is already inside the bucket.
    const spent = accrued
    const checkedAgainst = options.postRecord ? accrued - charge.amount : accrued
    const resetAtMs =
      charge.budget.window.kind === 'duration'
        ? bucket && bucket.entries.length > 0
          ? (bucket.entries[0]?.timestampMs ?? nowMs) + charge.budget.window.windowMs
          : nowMs + charge.budget.window.windowMs
        : null

    return {
      budget: charge.budget,
      bucketKey: charge.bucketKey,
      amount: charge.amount,
      allowed: checkedAgainst + charge.amount <= charge.budget.limit,
      spent,
      remaining: Math.max(0, charge.budget.limit - spent),
      resetAtMs,
    }
  }
}

function tupleChanged(a: CompiledBudget, b: CompiledBudget): boolean {
  // `key` is part of the reset tuple: a scope change (e.g. global → session)
  // restructures bucket identity, and preserving the old scope's buckets
  // would strand them — displayed but never read — while new keys start at
  // zero.
  return (
    a.limit !== b.limit ||
    a.currency !== b.currency ||
    a.windowRaw !== b.windowRaw ||
    a.key !== b.key
  )
}
