import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import type { Database as DatabaseType } from 'better-sqlite3'
import { BudgetLedger } from './ledger.js'
import type { BudgetLedgerRow, BudgetMetaRow } from './engine.js'
import { AuditStore } from '../audit/index.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ledgerRow(overrides: Partial<BudgetLedgerRow> = {}): BudgetLedgerRow {
  return {
    budget_name: 'daily-cap',
    bucket_key: 'budget:daily-cap:global',
    kind: 'spend',
    amount: 25,
    currency: 'USD',
    tool_name: 'stripe_charge',
    origin: 'mcp',
    audit_record_id: 'audit-1',
    timestamp: '2026-07-10T12:00:00.000Z',
    timestamp_ms: 1_000_000,
    generation: 1,
    ...overrides,
  }
}

function metaRow(overrides: Partial<BudgetMetaRow> = {}): BudgetMetaRow {
  return {
    budget_name: 'daily-cap',
    limit_amount: 100,
    currency: 'USD',
    window: '24h',
    key: 'global',
    epoch: 1,
    ...overrides,
  }
}

function createLedger(database?: DatabaseType) {
  const db = database ?? new Database(':memory:')
  let time = 5_000_000
  const ledger = new BudgetLedger({ database: db, now: () => time })
  const advance = (ms: number) => {
    time += ms
  }
  return { ledger, db, advance }
}

function countEvents(db: DatabaseType): number {
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM budget_events').get() as {
    count: number
  }
  return count
}

// ---------------------------------------------------------------------------
// DDL and clean-break schema policy
// ---------------------------------------------------------------------------

describe('BudgetLedger DDL', () => {
  it('creates the three budget tables in the given database', () => {
    const { db } = createLedger()
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>
    const names = tables.map((t) => t.name)
    expect(names).toContain('budget_meta')
    expect(names).toContain('budget_events')
    expect(names).toContain('budget_bucket_gc')
  })

  it('is idempotent: constructing twice on the same database is safe', () => {
    const { db, ledger } = createLedger()
    ledger.commitAll([ledgerRow()])
    expect(() => new BudgetLedger({ database: db })).not.toThrow()
    expect(countEvents(db)).toBe(1)
  })

  it('rejects a stale budget_events schema with the delete-the-db recovery message', () => {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE budget_events (id TEXT PRIMARY KEY, budget_name TEXT NOT NULL)')
    expect(() => new BudgetLedger({ database: db })).toThrow(/Delete/)
  })

  it('rejects a stale budget_meta schema missing the key column', () => {
    const db = new Database(':memory:')
    db.exec(
      'CREATE TABLE budget_meta (budget_name TEXT PRIMARY KEY, limit_amount REAL NOT NULL, ' +
        'currency TEXT NOT NULL, window TEXT NOT NULL, epoch INTEGER NOT NULL, updated_at TEXT NOT NULL)',
    )
    expect(() => new BudgetLedger({ database: db })).toThrow(/Delete/)
  })

  it('rejects a stale budget_meta schema missing updated_at', () => {
    const db = new Database(':memory:')
    db.exec(
      'CREATE TABLE budget_meta (budget_name TEXT PRIMARY KEY, limit_amount REAL NOT NULL, ' +
        'currency TEXT NOT NULL, window TEXT NOT NULL, key TEXT NOT NULL, epoch INTEGER NOT NULL)',
    )
    expect(() => new BudgetLedger({ database: db })).toThrow(/Delete/)
  })

  it('rejects a column whose declared type drifted (timestamp_ms TEXT)', () => {
    // Name-only validation would pass this schema, and TEXT affinity turns
    // every timestamp comparison lexicographic ('900' > '1000'), silently
    // resurrecting expired spend on replay.
    const db = new Database(':memory:')
    db.exec(
      `CREATE TABLE budget_events (
        id TEXT PRIMARY KEY, budget_name TEXT NOT NULL, epoch INTEGER NOT NULL,
        bucket_key TEXT NOT NULL, kind TEXT NOT NULL, amount REAL NOT NULL,
        currency TEXT NOT NULL, tool_name TEXT NOT NULL, origin TEXT NOT NULL,
        audit_record_id TEXT, timestamp TEXT NOT NULL, timestamp_ms TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
    )
    expect(() => new BudgetLedger({ database: db })).toThrow(/timestamp_ms/)
  })

  it('rejects a column that lost its NOT NULL constraint', () => {
    // A nullable amount would let a NaN bind slip through the transactional
    // rollback contract instead of failing the batch.
    const db = new Database(':memory:')
    db.exec(
      `CREATE TABLE budget_events (
        id TEXT PRIMARY KEY, budget_name TEXT NOT NULL, epoch INTEGER NOT NULL,
        bucket_key TEXT NOT NULL, kind TEXT NOT NULL, amount REAL,
        currency TEXT NOT NULL, tool_name TEXT NOT NULL, origin TEXT NOT NULL,
        audit_record_id TEXT, timestamp TEXT NOT NULL, timestamp_ms INTEGER NOT NULL,
        created_at TEXT NOT NULL
      )`,
    )
    expect(() => new BudgetLedger({ database: db })).toThrow(/amount/)
  })

  it('rejects a table whose primary key drifted', () => {
    const db = new Database(':memory:')
    db.exec(
      // budget_bucket_gc without the composite (budget_name, bucket_key) PK:
      // the watermark upsert's ON CONFLICT target would not exist.
      `CREATE TABLE budget_bucket_gc (
        budget_name TEXT NOT NULL, bucket_key TEXT NOT NULL, gc_after_ms INTEGER NOT NULL
      )`,
    )
    expect(() => new BudgetLedger({ database: db })).toThrow(/budget_bucket_gc/)
  })

  it.skipIf(process.platform === 'win32')(
    'leaves the audit db file permissions at 0o600 (shared-connection hardening)',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'helio-budget-ledger-'))
      const dbPath = join(dir, 'audit.db')
      const store = new AuditStore({
        path: dbPath,
        retention: '90d',
        includeResponses: true,
        cleanupIntervalMs: 0,
      })
      try {
        const ledger = new BudgetLedger({ database: store.database })
        ledger.commitAll([ledgerRow()])
        expect(statSync(dbPath).mode & 0o777).toBe(0o600)
        for (const suffix of ['-wal', '-shm'] as const) {
          expect(statSync(dbPath + suffix).mode & 0o777).toBe(0o600)
        }
      } finally {
        store.close()
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )
})

// ---------------------------------------------------------------------------
// commitAll — the transactional sink
// ---------------------------------------------------------------------------

describe('BudgetLedger.commitAll', () => {
  it('persists one row per charge with every column and a generated id', () => {
    const { ledger, db, advance } = createLedger()
    ledger.commitAll([
      ledgerRow(),
      ledgerRow({ budget_name: 'weekly', bucket_key: 'budget:weekly:global', generation: 3 }),
    ])
    advance(2_000)
    ledger.commitAll([ledgerRow({ budget_name: 'later' })])

    const rows = db.prepare('SELECT * FROM budget_events ORDER BY budget_name').all() as Array<
      Record<string, unknown>
    >
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({
      budget_name: 'daily-cap',
      epoch: 1,
      bucket_key: 'budget:daily-cap:global',
      kind: 'spend',
      amount: 25,
      currency: 'USD',
      tool_name: 'stripe_charge',
      origin: 'mcp',
      audit_record_id: 'audit-1',
      timestamp: '2026-07-10T12:00:00.000Z',
      timestamp_ms: 1_000_000,
    })
    // The charge's generation is the row's epoch.
    expect(rows[2]?.['epoch']).toBe(3)
    // Generated per row: UUID ids, insert-time created_at from the clock.
    expect(rows[0]?.['id']).toMatch(/^[0-9a-f-]{36}$/)
    expect(rows[0]?.['id']).not.toBe(rows[2]?.['id'])
    expect(rows[0]?.['created_at']).toBe(new Date(5_000_000).toISOString())
    expect(rows[1]?.['created_at']).toBe(new Date(5_002_000).toISOString())
  })

  it('is transactional: a poisoned row rolls back the whole batch', () => {
    const { ledger, db } = createLedger()
    // NaN binds as NULL, violating the NOT NULL constraint on amount — a
    // genuine mid-batch insert failure.
    expect(() => {
      ledger.commitAll([ledgerRow(), ledgerRow({ budget_name: 'weekly', amount: NaN })])
    }).toThrow()
    expect(countEvents(db)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// budget_meta
// ---------------------------------------------------------------------------

describe('BudgetLedger meta', () => {
  it('returns undefined for a budget with no meta row', () => {
    const { ledger } = createLedger()
    expect(ledger.readMeta('daily-cap')).toBeUndefined()
  })

  it('round-trips the identity tuple and epoch', () => {
    const { ledger } = createLedger()
    ledger.writeMeta(metaRow({ window: 'session', key: 'session', epoch: 4 }))
    expect(ledger.readMeta('daily-cap')).toEqual({
      budget_name: 'daily-cap',
      limit_amount: 100,
      currency: 'USD',
      window: 'session',
      key: 'session',
      epoch: 4,
    })
  })

  it('upserts: a second write for the same budget replaces the row', () => {
    const { ledger, db } = createLedger()
    ledger.writeMeta(metaRow())
    ledger.writeMeta(metaRow({ limit_amount: 250, epoch: 2 }))
    expect(ledger.readMeta('daily-cap')?.limit_amount).toBe(250)
    expect(ledger.readMeta('daily-cap')?.epoch).toBe(2)
    const { count } = db.prepare('SELECT COUNT(*) AS count FROM budget_meta').get() as {
      count: number
    }
    expect(count).toBe(1)
  })

  it('writeMetaBatch is transactional: a second-write fault rolls back the first', () => {
    const { ledger } = createLedger()
    // A non-transactional loop would leave the first upsert behind. NaN
    // binds as NULL and violates the NOT NULL constraint on limit_amount —
    // a genuine failure on the batch's SECOND statement.
    expect(() => {
      ledger.writeMetaBatch([
        metaRow({ budget_name: 'a' }),
        metaRow({ budget_name: 'b', limit_amount: NaN }),
      ])
    }).toThrow()
    expect(ledger.readMeta('a')).toBeUndefined()
  })

  it('writeMetaBatch rollback restores pre-existing rows the batch had updated', () => {
    const { ledger } = createLedger()
    ledger.writeMeta(metaRow({ budget_name: 'a', epoch: 1 }))

    // The batch UPDATES 'a' to epoch 2, then dies on the poisoned 'b': the
    // rollback must restore 'a' to epoch 1, not leave the half-applied mint.
    expect(() => {
      ledger.writeMetaBatch([
        metaRow({ budget_name: 'a', limit_amount: 500, epoch: 2 }),
        metaRow({ budget_name: 'b', limit_amount: NaN }),
      ])
    }).toThrow()
    expect(ledger.readMeta('a')).toMatchObject({ limit_amount: 100, epoch: 1 })
  })
})

// ---------------------------------------------------------------------------
// Replay queries
// ---------------------------------------------------------------------------

describe('BudgetLedger.replayDurationEvents', () => {
  it('returns only rows inside the lookback, at the given epoch, in time order', () => {
    const { ledger } = createLedger()
    ledger.commitAll([
      ledgerRow({ timestamp_ms: 900 }), // outside lookback
      ledgerRow({ timestamp_ms: 2_000 }),
      ledgerRow({ timestamp_ms: 1_500 }),
      ledgerRow({ timestamp_ms: 3_000, generation: 2 }), // old/other epoch
      ledgerRow({ budget_name: 'other', timestamp_ms: 2_500 }), // other budget
    ])

    const events = ledger.replayDurationEvents('daily-cap', 1, 1_000)
    expect(events.map((e) => e.timestamp_ms)).toEqual([1_500, 2_000])
    expect(events[0]).toEqual({
      bucket_key: 'budget:daily-cap:global',
      amount: 25,
      timestamp_ms: 1_500,
    })
  })

  it('excludes a row at exactly the lookback bound (memory-eviction parity)', () => {
    // spentOf/evictExpired keep entries with `ts > windowStart` strictly; a
    // row at exactly `now - window` is expired on both sides.
    const { ledger } = createLedger()
    ledger.commitAll([ledgerRow({ timestamp_ms: 1_000 })])
    expect(ledger.replayDurationEvents('daily-cap', 1, 1_000)).toEqual([])
  })
})

describe('BudgetLedger.replaySessionBuckets', () => {
  it('returns every bucket of the epoch with totals and last activity', () => {
    const { ledger } = createLedger()
    ledger.commitAll([
      ledgerRow({ bucket_key: 'budget:daily-cap:session:a', timestamp_ms: 5_000, amount: 10 }),
      ledgerRow({ bucket_key: 'budget:daily-cap:session:a', timestamp_ms: 7_000, amount: 15 }),
      ledgerRow({ bucket_key: 'budget:daily-cap:session:b', timestamp_ms: 1_000, amount: 99 }),
    ])

    // Liveness (idle-TTL) is the engine's policy: the store reports every
    // bucket, including ones the engine will judge dead.
    const buckets = ledger.replaySessionBuckets('daily-cap', 1)
    expect(buckets).toEqual([
      { bucket_key: 'budget:daily-cap:session:a', total: 25, last_activity_ms: 7_000 },
      { bucket_key: 'budget:daily-cap:session:b', total: 99, last_activity_ms: 1_000 },
    ])
  })

  it('filters rows before the GC watermark but keeps last activity from all rows', () => {
    const { ledger } = createLedger()
    const key = 'budget:daily-cap:session:s1'
    // spend → idle-GC (watermark) → same session id resurrects → new spend.
    ledger.commitAll([ledgerRow({ bucket_key: key, timestamp_ms: 1_000, amount: 40 })])
    ledger.recordBucketGc('daily-cap', key, 3_000)
    ledger.commitAll([ledgerRow({ bucket_key: key, timestamp_ms: 5_000, amount: 7 })])

    const buckets = ledger.replaySessionBuckets('daily-cap', 1)
    expect(buckets).toEqual([{ bucket_key: key, total: 7, last_activity_ms: 5_000 }])
  })

  it('keeps a post-GC spend that shares the watermark millisecond', () => {
    const { ledger } = createLedger()
    const key = 'budget:daily-cap:session:s1'
    // A resurrecting spend can land in the same tick as the sweep that
    // evicted the pot; pre-GC rows are always strictly older than the
    // watermark (idle-TTL inequality), so the inclusive bound is safe.
    ledger.commitAll([ledgerRow({ bucket_key: key, timestamp_ms: 1_000, amount: 40 })])
    ledger.recordBucketGc('daily-cap', key, 3_000)
    ledger.commitAll([ledgerRow({ bucket_key: key, timestamp_ms: 3_000, amount: 7 })])

    const buckets = ledger.replaySessionBuckets('daily-cap', 1)
    expect(buckets).toEqual([{ bucket_key: key, total: 7, last_activity_ms: 3_000 }])
  })

  it('ignores rows from other epochs', () => {
    const { ledger } = createLedger()
    const key = 'budget:daily-cap:session:s1'
    ledger.commitAll([
      ledgerRow({ bucket_key: key, timestamp_ms: 5_000, amount: 40, generation: 1 }),
      ledgerRow({ bucket_key: key, timestamp_ms: 6_000, amount: 5, generation: 2 }),
    ])
    expect(ledger.replaySessionBuckets('daily-cap', 2)).toEqual([
      { bucket_key: key, total: 5, last_activity_ms: 6_000 },
    ])
  })
})

describe('BudgetLedger.maxEventEpoch', () => {
  it('returns 0 for a budget with no rows and the max epoch otherwise', () => {
    const { ledger } = createLedger()
    expect(ledger.maxEventEpoch('daily-cap')).toBe(0)
    ledger.commitAll([
      ledgerRow({ generation: 1 }),
      ledgerRow({ generation: 3 }),
      ledgerRow({ budget_name: 'other', generation: 9 }),
    ])
    expect(ledger.maxEventEpoch('daily-cap')).toBe(3)
  })
})

describe('BudgetLedger.readAllMeta', () => {
  it('returns every meta row, configured or not', () => {
    const { ledger } = createLedger()
    ledger.writeMeta(metaRow())
    ledger.writeMeta(metaRow({ budget_name: 'retired', epoch: 4 }))
    expect(
      ledger
        .readAllMeta()
        .map((m) => m.budget_name)
        .sort(),
    ).toEqual(['daily-cap', 'retired'])
  })
})

// ---------------------------------------------------------------------------
// GC watermarks
// ---------------------------------------------------------------------------

describe('BudgetLedger.recordBucketGc', () => {
  it('upserts: a later GC replaces the watermark for the same bucket', () => {
    const { ledger, db } = createLedger()
    ledger.recordBucketGc('daily-cap', 'budget:daily-cap:session:s1', 1_000)
    ledger.recordBucketGc('daily-cap', 'budget:daily-cap:session:s1', 9_000)

    const rows = db.prepare('SELECT * FROM budget_bucket_gc').all() as Array<
      Record<string, unknown>
    >
    expect(rows).toEqual([
      {
        budget_name: 'daily-cap',
        bucket_key: 'budget:daily-cap:session:s1',
        gc_after_ms: 9_000,
      },
    ])
  })
})

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

describe('BudgetLedger.purgeExpired', () => {
  it('deletes events older than the cutoff and keeps newer ones', () => {
    const { ledger, db } = createLedger()
    ledger.commitAll([
      ledgerRow({ timestamp_ms: 1_000 }),
      ledgerRow({ timestamp_ms: 2_000 }),
      ledgerRow({ timestamp_ms: 9_000 }),
    ])

    ledger.purgeExpired(5_000)

    const remaining = db.prepare('SELECT timestamp_ms FROM budget_events').all() as Array<{
      timestamp_ms: number
    }>
    expect(remaining.map((r) => r.timestamp_ms)).toEqual([9_000])
  })

  it('prunes GC watermarks older than the cutoff (finding 4)', () => {
    const { ledger, db } = createLedger()
    ledger.recordBucketGc('daily-cap', 'budget:daily-cap:session:old', 1_000)
    ledger.recordBucketGc('daily-cap', 'budget:daily-cap:session:new', 9_000)

    ledger.purgeExpired(5_000)

    const rows = db.prepare('SELECT bucket_key FROM budget_bucket_gc').all() as Array<{
      bucket_key: string
    }>
    expect(rows.map((r) => r.bucket_key)).toEqual(['budget:daily-cap:session:new'])
  })

  it('purges on the audit sweep through the same hook wiring the CLI registers', () => {
    // The composed contract: AuditStore computes one cutoff per sweep and
    // the hook feeds cutoff.ms to the ledger — the exact closure cli.ts
    // registers. An axis mixup (iso vs ms) would purge nothing or everything.
    const store = new AuditStore({
      path: ':memory:',
      retention: '90d',
      includeResponses: true,
      cleanupIntervalMs: 0,
    })
    try {
      const ledger = new BudgetLedger({ database: store.database })
      store.onRetentionSweep((cutoff) => {
        ledger.purgeExpired(cutoff.ms)
      })
      ledger.commitAll([
        ledgerRow({ timestamp_ms: 1_000 }), // ancient: far past any retention
        ledgerRow({ budget_name: 'fresh', timestamp_ms: Date.now() }),
      ])

      store.runRetentionSweep()

      const rows = store.database.prepare('SELECT budget_name FROM budget_events').all() as Array<{
        budget_name: string
      }>
      expect(rows.map((r) => r.budget_name)).toEqual(['fresh'])
    } finally {
      store.close()
    }
  })

  it('bounds the watermark table under session-bucket churn', () => {
    const { ledger, db } = createLedger()
    // Many sender-keyed session pots cycle through GC; each sweep prunes the
    // watermarks that fell out of the retention window, so the table stays
    // bounded by churn-within-retention, not lifetime churn.
    for (let round = 0; round < 20; round++) {
      for (let i = 0; i < 50; i++) {
        ledger.recordBucketGc(
          'daily-cap',
          `budget:daily-cap:sender:r${String(round)}-s${String(i)}`,
          round * 100,
        )
      }
      ledger.purgeExpired(round * 100 - 250)
    }
    const { count } = db.prepare('SELECT COUNT(*) AS count FROM budget_bucket_gc').get() as {
      count: number
    }
    // Only the last ~3 rounds' watermarks survive the final cutoff.
    expect(count).toBeLessThanOrEqual(3 * 50)
  })
})

// ---------------------------------------------------------------------------
// WAL co-existence with a second connection (the CLI-export pattern)
// ---------------------------------------------------------------------------

describe('BudgetLedger WAL co-existence', () => {
  it('serves a concurrent read-only connection while committing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'helio-budget-wal-'))
    const dbPath = join(dir, 'audit.db')
    const store = new AuditStore({
      path: dbPath,
      retention: '90d',
      includeResponses: true,
      cleanupIntervalMs: 0,
    })
    let second: DatabaseType | undefined
    try {
      const ledger = new BudgetLedger({ database: store.database })
      ledger.commitAll([ledgerRow()])

      second = new Database(dbPath, { readonly: true })
      const { count } = second.prepare('SELECT COUNT(*) AS count FROM budget_events').get() as {
        count: number
      }
      expect(count).toBe(1)

      // The first connection keeps writing while the second stays open, and
      // a fresh read on the export connection sees the post-open commit.
      ledger.commitAll([ledgerRow({ budget_name: 'weekly' })])
      expect(countEvents(store.database)).toBe(2)
      expect(
        (second.prepare('SELECT COUNT(*) AS count FROM budget_events').get() as { count: number })
          .count,
      ).toBe(2)
    } finally {
      second?.close()
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
