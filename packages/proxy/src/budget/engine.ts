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
  /** Default kind for every charge of the call. */
  readonly kind: 'spend' | 'approved_overage'
  /**
   * Per-budget overrides by budget name (break-glass): one approved call can
   * mix kinds — breached budgets commit as `approved_overage` while
   * unbreached ones stay `spend` — and all rows must still land in ONE
   * ledger transaction, so the split is expressed here, not via two calls.
   */
  readonly kinds?: ReadonlyMap<string, 'spend' | 'approved_overage'>
  readonly auditRecordId: string
  readonly origin: string
  readonly toolName: string
  readonly timestampIso: string
}

/** The effective ledger kind for one charge of a call. */
function kindOf(meta: BudgetCommitMeta, budgetName: string): 'spend' | 'approved_overage' {
  return meta.kinds?.get(budgetName) ?? meta.kind
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

/**
 * On-disk identity and epoch of one budget (a `budget_meta` row). The
 * `{limit_amount, currency, window, key}` tuple is the reset tuple persisted
 * across restarts; `epoch` is the on-disk spelling of the engine's config
 * generation. `key` is typed as a plain string because it is only ever
 * compared, never dispatched on.
 */
export interface BudgetMetaRow {
  readonly budget_name: string
  readonly limit_amount: number
  readonly currency: string
  /** Raw config window string: '1h' | 'session'. */
  readonly window: string
  readonly key: string
  readonly epoch: number
}

/** One replayed `budget_events` row for rebuilding a duration window. */
export interface BudgetReplayEvent {
  readonly bucket_key: string
  readonly amount: number
  readonly timestamp_ms: number
}

/** One rebuilt session pot: post-watermark lifetime sum + last activity. */
export interface BudgetReplayBucket {
  readonly bucket_key: string
  readonly total: number
  readonly last_activity_ms: number
}

/**
 * Full persistence contract the SQLite ledger implements on top of the
 * commit sink: meta/epoch bookkeeping, startup replay reads, and GC
 * watermarks. The engine probes its sink for these capabilities once and
 * persists exactly what the sink can persist — a plain sink (tests, no-op)
 * keeps the PR 1 in-memory behavior.
 */
export interface BudgetPersistence extends BudgetLedgerSink {
  readMeta(budgetName: string): BudgetMetaRow | undefined
  /** Every meta row on disk, including names no longer configured. */
  readAllMeta(): readonly BudgetMetaRow[]
  /** Upsert: the on-disk epoch must be authoritative at all times. */
  writeMeta(meta: BudgetMetaRow): void
  /**
   * Upsert every row in ONE transaction: a reload's epoch mints land
   * together or not at all, so a failed reload can be rejected with disk
   * and memory both untouched.
   */
  writeMetaBatch(metas: readonly BudgetMetaRow[]): void
  /**
   * The highest epoch present in `budget_events` for the name; 0 when none.
   * Epoch minting consults this so an epoch that already has rows — for
   * example after a swallowed reconcile-time meta-write failure — can never
   * be re-minted for a different pot.
   */
  maxEventEpoch(budgetName: string): number
  /** MUST return rows in ascending `timestamp_ms` order (ties by insert order). */
  replayDurationEvents(
    budgetName: string,
    epoch: number,
    sinceMs: number,
  ): readonly BudgetReplayEvent[]
  /**
   * Every bucket of the epoch with its post-watermark sum and last activity.
   * Liveness policy (idle-TTL) is the engine's job, not the store's.
   */
  replaySessionBuckets(budgetName: string, epoch: number): readonly BudgetReplayBucket[]
  /** Upsert the idle-GC watermark for one session bucket. */
  recordBucketGc(budgetName: string, bucketKey: string, gcAfterMs: number): void
}

/** Whether a sink carries the full persistence contract. */
export function isBudgetPersistence(sink: BudgetLedgerSink): sink is BudgetPersistence {
  const candidate = sink as Partial<BudgetPersistence>
  return (
    typeof candidate.readMeta === 'function' &&
    typeof candidate.readAllMeta === 'function' &&
    typeof candidate.writeMeta === 'function' &&
    typeof candidate.writeMetaBatch === 'function' &&
    typeof candidate.maxEventEpoch === 'function' &&
    typeof candidate.replayDurationEvents === 'function' &&
    typeof candidate.replaySessionBuckets === 'function' &&
    typeof candidate.recordBucketGc === 'function'
  )
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

/**
 * Payload for the per-budget breach callback (dashboard event bus). Fired
 * via {@link BudgetEngine.reportBreaches} by the DOORS at the moment a peek
 * actually denies a call or raises the composite break-glass ticket — never
 * by `peekAll` itself, which is pure and also runs for dry-run.
 */
export interface BudgetBreachEvent {
  readonly name: string
  readonly bucket_key: string
  /** The budget's configured posture, even when the outcome was a deny. */
  readonly on_exceed: 'deny' | 'require_approval'
  readonly attempted_amount: number
  readonly spent: number
  readonly limit: number
  readonly currency: string
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
  /** Fired once per breached budget when a door denies or raises a ticket. */
  readonly onBreach?: (event: BudgetBreachEvent) => void
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
  /** The sink again, when it carries the full persistence contract. */
  private readonly persistence: BudgetPersistence | null
  private readonly onCommit: ((event: BudgetCommitEvent) => void) | undefined
  private readonly onBreach: ((event: BudgetBreachEvent) => void) | undefined
  private timer: ReturnType<typeof setInterval> | null = null
  private closed = false
  private hydrated = false

  constructor(options: BudgetEngineOptions = {}) {
    this.now = options.now ?? Date.now
    this.ledger = options.ledger ?? NOOP_LEDGER
    this.persistence = isBudgetPersistence(this.ledger) ? this.ledger : null
    this.onCommit = options.onCommit
    this.onBreach = options.onBreach
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
        kind: kindOf(meta, charge.budget.name),
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
          kind: kindOf(meta, charge.budget.name),
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

  /**
   * Fire one `onBreach` event per breached entry. Called by the doors at the
   * moment a peek outcome actually denies the call or raises the composite
   * break-glass ticket (never for dry-run peeks, never for invalid-amount
   * failures — those are input errors, not breaches). Subscriber throws are
   * isolated: a dashboard bug must never affect a gate outcome.
   */
  reportBreaches(entries: readonly BudgetPeekEntry[]): void {
    if (!this.onBreach) return
    for (const entry of entries) {
      try {
        this.onBreach({
          name: entry.budget.name,
          bucket_key: entry.bucketKey,
          on_exceed: entry.budget.onExceed,
          attempted_amount: entry.amount,
          spent: entry.spent,
          limit: entry.budget.limit,
          currency: entry.budget.currency,
        })
      } catch (err) {
        // eslint-disable-next-line no-console -- Subscriber bugs must not affect gate outcomes
        console.error('[helio] budget onBreach subscriber threw:', err)
      }
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Rebuild in-memory state from the ledger. Call once at startup, after
   * construction and before serving traffic; a no-op when the configured
   * sink does not carry the persistence contract (in-memory mode).
   *
   * Per configured budget, `budget_meta` decides:
   * - no row → first boot for this name: mint epoch 1, nothing to replay;
   * - a different `{limit, currency, window, key}` tuple → the config
   *   changed while down: bump the epoch, replay nothing (the same reset a
   *   live tuple-changing reload performs, extended across restarts). Old
   *   rows keep their epoch — history stays queryable, replay ignores it;
   * - a matching tuple → replay at the meta epoch: duration windows rebuild
   *   entry lists from a window lookback (bit-equivalent to never having
   *   restarted), session windows rebuild still-live pots (idle-TTL bound)
   *   from their post-GC-watermark lifetime sums.
   *
   * Meta writes here propagate failures: a ledger that cannot record epochs
   * at startup must fail the boot loudly, the same posture as the audit
   * store's schema assertion.
   */
  hydrate(): void {
    if (!this.persistence) return
    // Latched: a second hydrate would append every replayed duration entry
    // again, double-counting real money.
    if (this.hydrated) return
    this.hydrated = true
    const nowMs = this.now()

    const metaByName = new Map(
      this.persistence.readAllMeta().map((meta) => [meta.budget_name, meta]),
    )

    for (const budget of this.budgets.values()) {
      const meta = metaByName.get(budget.name)
      if (!meta) {
        // First boot for this name. Minting still consults the rows: a
        // swallowed reconcile-time meta-write failure can leave rows at an
        // epoch no meta row records, and re-minting that epoch would replay
        // them into a pot they never belonged to. Those retired rows stay
        // history only.
        const epoch = this.persistence.maxEventEpoch(budget.name) + 1
        this.persistence.writeMeta(metaOf(budget, epoch))
        this.generations.set(budget.name, epoch)
        continue
      }
      if (metaTupleChanged(meta, budget)) {
        const epoch = Math.max(meta.epoch, this.persistence.maxEventEpoch(budget.name)) + 1
        this.persistence.writeMeta(metaOf(budget, epoch))
        this.generations.set(budget.name, epoch)
        continue
      }

      this.generations.set(budget.name, meta.epoch)
      if (budget.window.kind === 'duration') {
        const events = this.persistence.replayDurationEvents(
          budget.name,
          meta.epoch,
          nowMs - budget.window.windowMs,
        )
        for (const event of events) {
          const bucket = this.bucketFor(budget.name, event.bucket_key)
          bucket.entries.push({ timestampMs: event.timestamp_ms, amount: event.amount })
          // Events arrive time-ordered, so the last assignment is the max.
          bucket.lastActivityMs = event.timestamp_ms
        }
      } else {
        const liveAfterMs = nowMs - budget.window.idleTtlMs
        for (const row of this.persistence.replaySessionBuckets(budget.name, meta.epoch)) {
          if (row.last_activity_ms >= liveAfterMs) {
            const bucket = this.bucketFor(budget.name, row.bucket_key)
            bucket.total = row.total
            bucket.lastActivityMs = row.last_activity_ms
          } else if (row.total > 0) {
            // The pot crossed its idle TTL while no sweep could observe it
            // (downtime, or a crash before the next sweep tick). Durably
            // retire it now: without the watermark, a same-key resurrection
            // followed by another restart would re-absorb this dead pot's
            // spend. All of the pot's rows are strictly older than nowMs,
            // so the inclusive watermark bound stays safe.
            this.persistence.recordBucketGc(budget.name, row.bucket_key, nowMs)
          }
        }
      }
    }

    // Removal observed at boot: a meta row whose name is not configured was
    // removed while the proxy was down (a live removal writes its tombstone
    // in reconcile). Retire whatever the current epoch accrued so a later
    // re-add starts fresh, exactly like a live removal. Idempotent: after
    // the bump no rows exist at or above the new epoch, so later boots skip
    // the write.
    for (const [name, meta] of metaByName) {
      if (this.budgets.has(name)) continue
      const maxEventEpoch = this.persistence.maxEventEpoch(name)
      if (maxEventEpoch < meta.epoch) continue
      this.persistence.writeMeta({ ...meta, epoch: Math.max(meta.epoch, maxEventEpoch) + 1 })
    }
  }

  /**
   * Swap budget configs on hot-reload. Identity is the NAME: removed names
   * drop their live buckets; a changed `{limit, currency, window, key}` tuple
   * resets the budget's buckets (a different pool or scope structure);
   * everything else — contributors, on_exceed — applies to the accrued state
   * as-is, because those edits do not change what was already spent.
   *
   * Persist-before-swap: every epoch this reload mints lands in
   * `budget_meta` in ONE transaction BEFORE any memory changes. A throw
   * rejects the whole reload — the caller keeps the previous config — so
   * disk and memory can never diverge; a failed reload simply never
   * happened, and no later restart can misread it. (A swallow-and-continue
   * posture here would let an A→B reload with a failed flush resurrect the
   * retired A pot after a revert-and-restart.)
   *
   * Removed names mint too: an in-flight charge frozen before the removal
   * must go stale, or its commit would recreate hidden bucket state for a
   * budget that no longer exists — and without the on-disk tombstone, a
   * restart with the budget back in the config would resurrect the
   * pre-removal pot that the removal had reset. Generations for removed
   * names are kept (not deleted) so a later re-add keeps counting up.
   *
   * @throws When the epoch flush fails; the engine is unchanged.
   */
  reconcile(next: readonly CompiledBudget[]): void {
    const nextByName = new Map(next.map((budget) => [budget.name, budget]))

    // Phase 1 — compute every pot reset this swap needs, mutating nothing.
    const mints: Array<{ name: string; tuple: CompiledBudget; epoch: number }> = []
    for (const [name, budget] of nextByName) {
      const current = this.budgets.get(name)
      if (!current || tupleChanged(current, budget)) {
        // New name or a different pool: reset state and invalidate any
        // in-flight charges frozen under the old generation.
        mints.push({ name, tuple: budget, epoch: this.nextEpoch(name) })
      }
    }
    for (const [name, removed] of this.budgets) {
      if (nextByName.has(name)) continue
      mints.push({ name, tuple: removed, epoch: this.nextEpoch(name) })
    }

    // Phase 2 — durability, all-or-nothing.
    if (this.persistence && mints.length > 0) {
      this.persistence.writeMetaBatch(mints.map((mint) => metaOf(mint.tuple, mint.epoch)))
    }

    // Phase 3 — memory: pure Map operations, nothing here can throw.
    for (const mint of mints) {
      this.state.delete(mint.name)
      this.generations.set(mint.name, mint.epoch)
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
          if (nowMs - bucket.lastActivityMs > budget.window.idleTtlMs) {
            // Watermark before eviction: replaying without it would let a
            // later resurrection of the same key re-absorb pre-GC spend
            // after a restart. If the watermark cannot be written, keep the
            // pot and retry on the next sweep — an over-held bucket is
            // recoverable, silently revived spend is not.
            if (this.persistence) {
              try {
                this.persistence.recordBucketGc(name, key, nowMs)
              } catch (err) {
                // eslint-disable-next-line no-console -- Intentional operational warning
                console.error(
                  `[helio] Budget "${name}": failed to record the GC watermark for ` +
                    `"${key}"; keeping the idle pot until the next sweep:`,
                  err,
                )
                continue
              }
            }
            buckets.delete(key)
          }
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

  /**
   * The next epoch for a name: one past the highest that memory, the meta
   * row, or the rows themselves have seen. Pure — the caller applies it to
   * `generations` only after the mint is durable. The meta consult matters
   * for names this process has no memory of (a hot-reload re-add after a
   * restart); the rows consult is a backstop against historical divergence
   * (rows at an epoch no meta row records) — minting from memory or meta
   * alone could collide into an epoch that already has rows and replay them
   * into a different pot.
   */
  private nextEpoch(name: string): number {
    const memory = this.generations.get(name) ?? 0
    const disk = this.persistence
      ? Math.max(this.persistence.readMeta(name)?.epoch ?? 0, this.persistence.maxEventEpoch(name))
      : 0
    return Math.max(memory, disk) + 1
  }

  /**
   * The key format is part of the ON-DISK contract: hydrate rebuilds buckets
   * from `budget_events.bucket_key` verbatim, so renaming any segment here
   * would strand every persisted bucket of an unchanged tuple as an
   * unreachable ghost (displayed, never charged). Changing the format
   * requires folding a format version into the epoch decision.
   */
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

function metaOf(budget: CompiledBudget, epoch: number): BudgetMetaRow {
  return {
    budget_name: budget.name,
    limit_amount: budget.limit,
    currency: budget.currency,
    window: budget.windowRaw,
    key: budget.key,
    epoch,
  }
}

/** The on-disk spelling of {@link tupleChanged}: meta row vs compiled budget. */
function metaTupleChanged(meta: BudgetMetaRow, budget: CompiledBudget): boolean {
  return (
    meta.limit_amount !== budget.limit ||
    meta.currency !== budget.currency ||
    meta.window !== budget.windowRaw ||
    meta.key !== budget.key
  )
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
