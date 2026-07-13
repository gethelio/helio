// ---------------------------------------------------------------------------
// BudgetLedger — SQLite persistence for budget spend (issue #14).
//
// Owns the budget_meta / budget_events / budget_bucket_gc tables inside the
// EXISTING audit database: the ledger receives the AuditStore's open handle,
// so there is one connection, one WAL domain, and one file-permission
// hardening pass. Writes are synchronous at record time (money-grade
// durability, no buffering); commitAll wraps every row of one call in a
// single transaction — a throw means nothing persisted, matching the
// BudgetLedgerSink contract the engine enforces its memory-after-commit
// ordering against.
//
// The ledger is storage only: replay policy (window lookback, idle-TTL
// liveness, epoch bumping) lives in BudgetEngine.hydrate().
// ---------------------------------------------------------------------------

import Database from 'better-sqlite3'
import type { Database as DatabaseType, Statement } from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { LIST_MAX_PAGE_SIZE } from '../audit/store.js'
import type {
  BudgetLedgerRow,
  BudgetMetaRow,
  BudgetPersistence,
  BudgetReplayBucket,
  BudgetReplayEvent,
} from './engine.js'

// ---------------------------------------------------------------------------
// Schema DDL — clean-break convention (store.ts precedent): CREATE IF NOT
// EXISTS plus a required-column assertion with the delete-the-db recovery
// message. No migration framework pre-1.0.
// ---------------------------------------------------------------------------

const CREATE_TABLES_DDL = `
CREATE TABLE IF NOT EXISTS budget_meta (
  budget_name  TEXT PRIMARY KEY,
  limit_amount REAL NOT NULL,
  currency     TEXT NOT NULL,
  window       TEXT NOT NULL,
  key          TEXT NOT NULL,
  epoch        INTEGER NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS budget_events (
  id              TEXT PRIMARY KEY,
  budget_name     TEXT NOT NULL,
  epoch           INTEGER NOT NULL,
  bucket_key      TEXT NOT NULL,
  kind            TEXT NOT NULL,
  amount          REAL NOT NULL,
  currency        TEXT NOT NULL,
  tool_name       TEXT NOT NULL,
  origin          TEXT NOT NULL,
  audit_record_id TEXT,
  timestamp       TEXT NOT NULL,
  timestamp_ms    INTEGER NOT NULL,
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS budget_bucket_gc (
  budget_name  TEXT NOT NULL,
  bucket_key   TEXT NOT NULL,
  gc_after_ms  INTEGER NOT NULL,
  PRIMARY KEY (budget_name, bucket_key)
);
`

const CREATE_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_budget_events_replay
  ON budget_events (budget_name, epoch, bucket_key, timestamp_ms);
CREATE INDEX IF NOT EXISTS idx_budget_events_timestamp_ms
  ON budget_events (timestamp_ms);
`

const BUDGET_TABLES = ['budget_meta', 'budget_events', 'budget_bucket_gc'] as const

/** The `pragma table_info` row shape used by the schema assertion. */
interface ColumnInfo {
  readonly name: string
  readonly type: string
  readonly notnull: number
  readonly pk: number
}

const INSERT_EVENT_SQL = `
INSERT INTO budget_events (
  id, budget_name, epoch, bucket_key, kind, amount, currency,
  tool_name, origin, audit_record_id, timestamp, timestamp_ms, created_at
) VALUES (
  @id, @budget_name, @epoch, @bucket_key, @kind, @amount, @currency,
  @tool_name, @origin, @audit_record_id, @timestamp, @timestamp_ms, @created_at
)
`

const UPSERT_META_SQL = `
INSERT INTO budget_meta (budget_name, limit_amount, currency, window, key, epoch, updated_at)
VALUES (@budget_name, @limit_amount, @currency, @window, @key, @epoch, @updated_at)
ON CONFLICT (budget_name) DO UPDATE SET
  limit_amount = excluded.limit_amount,
  currency     = excluded.currency,
  window       = excluded.window,
  key          = excluded.key,
  epoch        = excluded.epoch,
  updated_at   = excluded.updated_at
`

const UPSERT_GC_SQL = `
INSERT INTO budget_bucket_gc (budget_name, bucket_key, gc_after_ms)
VALUES (@budget_name, @bucket_key, @gc_after_ms)
ON CONFLICT (budget_name, bucket_key) DO UPDATE SET
  gc_after_ms = excluded.gc_after_ms
`

const REPLAY_DURATION_SQL = `
SELECT bucket_key, amount, timestamp_ms
FROM budget_events
WHERE budget_name = ? AND epoch = ? AND timestamp_ms > ?
ORDER BY timestamp_ms ASC, rowid ASC
`

// Last activity comes from ALL rows of the epoch (MAX timestamp), while the
// sum counts only rows past the bucket's idle-GC watermark: a pot that was
// collected and later resurrected under the same key must not re-absorb
// pre-GC spend on the next restart.
//
// The sum bound is calibrated against the engine's in-memory semantics:
// INCLUSIVE of the watermark millisecond, because a post-GC spend can land
// in the same tick as the sweep while every pre-GC row is strictly older
// than the watermark by the idle-TTL inequality (ts <= lastActivity <
// gcTime - ttl < gcTime). Liveness policy (idle-TTL) is applied by the
// engine, which is why every bucket of the epoch is returned.
const REPLAY_SESSION_SQL = `
SELECT e.bucket_key AS bucket_key,
       SUM(CASE WHEN e.timestamp_ms >= COALESCE(g.gc_after_ms, 0) THEN e.amount ELSE 0 END) AS total,
       MAX(e.timestamp_ms) AS last_activity_ms
FROM budget_events e
LEFT JOIN budget_bucket_gc g
  ON g.budget_name = e.budget_name AND g.bucket_key = e.bucket_key
WHERE e.budget_name = ? AND e.epoch = ?
GROUP BY e.bucket_key
ORDER BY e.bucket_key ASC
`

// Newest first on timestamp_ms — the same event-time axis replay and
// retention filter on — with rowid breaking same-millisecond ties by insert
// order. No epoch filter: the listing is spend HISTORY ("where did the money
// go"), and money that moved under a since-retired config tuple still moved;
// retention bounds the depth.
const LIST_EVENTS_SQL = `
SELECT id, budget_name, bucket_key, kind, amount, currency, tool_name,
       origin, audit_record_id, timestamp, timestamp_ms, created_at
FROM budget_events
WHERE budget_name = ?
ORDER BY timestamp_ms DESC, rowid DESC
LIMIT ? OFFSET ?
`

const COUNT_EVENTS_SQL = 'SELECT COUNT(*) AS total FROM budget_events WHERE budget_name = ?'

/** Default page size for {@link BudgetLedger.listEvents}. */
const LIST_EVENTS_DEFAULT_LIMIT = 50

/**
 * One `budget_events` row as listed by `GET /api/budgets/:name/events` —
 * the table columns minus `epoch` (internal replay bookkeeping), snake_case
 * verbatim. `budget_name` stays in the row so a page is self-describing.
 */
export interface BudgetEventRecord {
  readonly id: string
  readonly budget_name: string
  readonly bucket_key: string
  readonly kind: 'spend' | 'approved_overage'
  readonly amount: number
  readonly currency: string
  readonly tool_name: string
  readonly origin: string
  readonly audit_record_id: string | null
  readonly timestamp: string
  readonly timestamp_ms: number
  readonly created_at: string
}

/** One page of a budget's event history plus the unpaginated total. */
export interface BudgetEventsPage {
  readonly events: readonly BudgetEventRecord[]
  readonly total: number
}

function describeColumn(column: ColumnInfo): string {
  return `"${column.type}${column.notnull ? ' NOT NULL' : ''}${column.pk ? ' PRIMARY KEY' : ''}"`
}

export interface BudgetLedgerOptions {
  /**
   * The audit store's open database handle (AuditStore.database). The ledger
   * co-locates its tables there and never opens, closes, or re-hardens the
   * connection — that all stays with the store.
   */
  readonly database: DatabaseType
  /** Clock function for testable time (created_at stamps). Defaults to `Date.now`. */
  readonly now?: () => number
}

export class BudgetLedger implements BudgetPersistence {
  private readonly db: DatabaseType
  private readonly now: () => number
  private readonly insertEventStmt: Statement
  private readonly upsertMetaStmt: Statement
  private readonly upsertGcStmt: Statement
  private readonly readMetaStmt: Statement
  private readonly readAllMetaStmt: Statement
  private readonly maxEventEpochStmt: Statement
  private readonly replayDurationStmt: Statement
  private readonly replaySessionStmt: Statement
  private readonly listEventsStmt: Statement
  private readonly countEventsStmt: Statement
  private readonly commitTxn: (rows: readonly BudgetLedgerRow[]) => void
  private readonly writeMetaTxn: (metas: readonly BudgetMetaRow[]) => void
  private readonly purgeTxn: (cutoffMs: number) => { events: number; watermarks: number }

  constructor(options: BudgetLedgerOptions) {
    this.db = options.database
    this.now = options.now ?? Date.now

    this.db.exec(CREATE_TABLES_DDL)
    this.assertRequiredSchema()
    this.db.exec(CREATE_INDEX_DDL)

    this.insertEventStmt = this.db.prepare(INSERT_EVENT_SQL)
    this.upsertMetaStmt = this.db.prepare(UPSERT_META_SQL)
    this.upsertGcStmt = this.db.prepare(UPSERT_GC_SQL)
    this.readMetaStmt = this.db.prepare(
      'SELECT budget_name, limit_amount, currency, window, key, epoch FROM budget_meta WHERE budget_name = ?',
    )
    this.readAllMetaStmt = this.db.prepare(
      'SELECT budget_name, limit_amount, currency, window, key, epoch FROM budget_meta',
    )
    this.maxEventEpochStmt = this.db.prepare(
      'SELECT COALESCE(MAX(epoch), 0) AS epoch FROM budget_events WHERE budget_name = ?',
    )
    this.replayDurationStmt = this.db.prepare(REPLAY_DURATION_SQL)
    this.replaySessionStmt = this.db.prepare(REPLAY_SESSION_SQL)
    this.listEventsStmt = this.db.prepare(LIST_EVENTS_SQL)
    this.countEventsStmt = this.db.prepare(COUNT_EVENTS_SQL)

    // One transaction for both DELETEs: a crash between them must not be
    // able to drop a watermark while its guarded rows survive.
    const purgeEventsStmt = this.db.prepare('DELETE FROM budget_events WHERE timestamp_ms < ?')
    const purgeGcStmt = this.db.prepare('DELETE FROM budget_bucket_gc WHERE gc_after_ms < ?')
    this.purgeTxn = this.db.transaction((cutoffMs: number) => ({
      events: purgeEventsStmt.run(cutoffMs).changes,
      watermarks: purgeGcStmt.run(cutoffMs).changes,
    }))

    this.writeMetaTxn = this.db.transaction((metas: readonly BudgetMetaRow[]) => {
      for (const meta of metas) this.writeMeta(meta)
    })

    this.commitTxn = this.db.transaction((rows: readonly BudgetLedgerRow[]) => {
      const createdAt = new Date(this.now()).toISOString()
      for (const row of rows) {
        this.insertEventStmt.run({
          id: randomUUID(),
          budget_name: row.budget_name,
          epoch: row.generation,
          bucket_key: row.bucket_key,
          kind: row.kind,
          amount: row.amount,
          currency: row.currency,
          tool_name: row.tool_name,
          origin: row.origin,
          audit_record_id: row.audit_record_id,
          timestamp: row.timestamp,
          timestamp_ms: row.timestamp_ms,
          created_at: createdAt,
        })
      }
    })
  }

  /**
   * Validate the on-disk budget schema against the canonical DDL — column
   * NAMES, declared TYPES, NOT NULL constraints, and PRIMARY KEYS — with the
   * same clean-break recovery contract as the audit table (store.ts):
   * pre-1.0 local databases are deleted, not migrated. Types matter beyond
   * presence: a `timestamp_ms` with TEXT affinity would make every replay
   * and retention comparison lexicographic ('900' > '1000'), silently
   * resurrecting expired spend. The canonical shape is derived by executing
   * the DDL itself in a scratch database, so the assertion cannot drift
   * from what the DDL creates. Extra columns in the live table are
   * tolerated (forward compatibility, matching the audit store's posture).
   */
  private assertRequiredSchema(): void {
    const canonical = new Database(':memory:')
    let mismatches: string[]
    try {
      canonical.exec(CREATE_TABLES_DDL)
      mismatches = []
      for (const table of BUDGET_TABLES) {
        const expected = canonical.pragma(`table_info(${table})`) as ColumnInfo[]
        const live = new Map(
          (this.db.pragma(`table_info(${table})`) as ColumnInfo[]).map((col) => [col.name, col]),
        )
        for (const column of expected) {
          const actual = live.get(column.name)
          if (!actual) {
            mismatches.push(`${table}.${column.name} (missing)`)
            continue
          }
          if (
            actual.type !== column.type ||
            actual.notnull !== column.notnull ||
            actual.pk !== column.pk
          ) {
            mismatches.push(
              `${table}.${column.name} (found ${describeColumn(actual)}, ` +
                `expected ${describeColumn(column)})`,
            )
          }
        }
      }
    } finally {
      canonical.close()
    }
    if (mismatches.length === 0) return

    const dbPath = this.db.name
    throw new Error(
      '[helio] Budget ledger schema mismatch: incompatible columns ' +
        `${mismatches.join(', ')}. ` +
        `This local database was created by an older Helio build. ` +
        `Delete "${dbPath}", "${dbPath}-wal", and "${dbPath}-shm", then restart Helio.`,
    )
  }

  // -------------------------------------------------------------------------
  // BudgetPersistence
  // -------------------------------------------------------------------------

  /** Persist every row of one call in a single transaction (all or nothing). */
  commitAll(rows: readonly BudgetLedgerRow[]): void {
    this.commitTxn(rows)
  }

  readMeta(budgetName: string): BudgetMetaRow | undefined {
    return this.readMetaStmt.get(budgetName) as BudgetMetaRow | undefined
  }

  readAllMeta(): readonly BudgetMetaRow[] {
    return this.readAllMetaStmt.all() as BudgetMetaRow[]
  }

  maxEventEpoch(budgetName: string): number {
    const { epoch } = this.maxEventEpochStmt.get(budgetName) as { epoch: number }
    return epoch
  }

  writeMeta(meta: BudgetMetaRow): void {
    this.upsertMetaStmt.run({
      budget_name: meta.budget_name,
      limit_amount: meta.limit_amount,
      currency: meta.currency,
      window: meta.window,
      key: meta.key,
      epoch: meta.epoch,
      updated_at: new Date(this.now()).toISOString(),
    })
  }

  /** All of one reload's epoch mints in a single transaction (all or nothing). */
  writeMetaBatch(metas: readonly BudgetMetaRow[]): void {
    this.writeMetaTxn(metas)
  }

  replayDurationEvents(
    budgetName: string,
    epoch: number,
    sinceMs: number,
  ): readonly BudgetReplayEvent[] {
    return this.replayDurationStmt.all(budgetName, epoch, sinceMs) as BudgetReplayEvent[]
  }

  replaySessionBuckets(budgetName: string, epoch: number): readonly BudgetReplayBucket[] {
    return this.replaySessionStmt.all(budgetName, epoch) as BudgetReplayBucket[]
  }

  recordBucketGc(budgetName: string, bucketKey: string, gcAfterMs: number): void {
    this.upsertGcStmt.run({
      budget_name: budgetName,
      bucket_key: bucketKey,
      gc_after_ms: gcAfterMs,
    })
  }

  // -------------------------------------------------------------------------
  // Dashboard read surface
  // -------------------------------------------------------------------------

  /**
   * One page of a budget's spend history for the dashboard, newest first.
   * `limit` defaults to 50 and clamps to `LIST_MAX_PAGE_SIZE`; `offset`
   * floors at 0. An unknown budget name simply lists nothing (names are
   * config, not secrets — no 404 semantics on hot-reload races).
   */
  listEvents(budgetName: string, page: { limit?: number; offset?: number }): BudgetEventsPage {
    const limit = Math.min(
      Math.max(Math.trunc(page.limit ?? LIST_EVENTS_DEFAULT_LIMIT), 1),
      LIST_MAX_PAGE_SIZE,
    )
    const offset = Math.max(Math.trunc(page.offset ?? 0), 0)
    const events = this.listEventsStmt.all(budgetName, limit, offset) as BudgetEventRecord[]
    const { total } = this.countEventsStmt.get(budgetName) as { total: number }
    return { events, total }
  }

  // -------------------------------------------------------------------------
  // Retention
  // -------------------------------------------------------------------------

  /**
   * Purge events past the retention cutoff (event-time milliseconds — the
   * same axis every replay query filters on, so the retention bound and the
   * replay bound cannot diverge). Watermarks older than the cutoff prune
   * with the same statement's cutoff: every row such a watermark could
   * filter has `timestamp_ms <= gc_after_ms < cutoffMs` and is deleted here
   * too, so the watermark guards nothing and is safe to drop.
   *
   * Called from the audit store's retention sweep (one sweep schedule); the
   * cutoff is computed once per sweep by the store.
   */
  purgeExpired(cutoffMs: number): { events: number; watermarks: number } {
    return this.purgeTxn(cutoffMs)
  }
}
