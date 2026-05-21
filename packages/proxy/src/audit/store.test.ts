import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { AuditStore } from './store.js'
import type { AuditRecord } from './types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type InsertRecord = Omit<AuditRecord, 'id' | 'created_at'>

function makeRecord(overrides: Partial<InsertRecord> = {}): InsertRecord {
  const defaults: InsertRecord = {
    timestamp: new Date().toISOString(),
    session_id: null,
    agent_id: null,
    environment: null,
    tool_name: 'test_tool',
    tool_input: { key: 'value' },
    policy_decision: 'allow',
    block_reason: null,
    matched_rule: null,
    matched_rule_index: null,
    evidence_chain: null,
    approval_status: null,
    approved_by: null,
    upstream_response: { result: 'ok' },
    upstream_error: null,
    upstream_http_status: 200,
    upstream_latency_ms: 10,
    total_duration_ms: 15,
    approval_wait_ms: 0,
    proxy_compute_ms: 5,
    flagged_destructive: false,
    dry_run: false,
  }
  return {
    ...defaults,
    ...overrides,
    environment: overrides.environment ?? defaults.environment,
    matched_rule_index: overrides.matched_rule_index ?? defaults.matched_rule_index,
  }
}

function createStore(overrides: { includeResponses?: boolean } = {}): AuditStore {
  return new AuditStore({
    path: ':memory:',
    retention: '90d',
    includeResponses: overrides.includeResponses ?? true,
    cleanupIntervalMs: 0,
  })
}

/** Insert + get with assertion that the record exists. */
function insertAndGet(s: AuditStore, record: InsertRecord, createdAt?: string): AuditRecord {
  const id = s.insert(record, createdAt)
  const result = s.get(id)
  expect(result).toBeDefined()
  return result as AuditRecord
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AuditStore', () => {
  let store: AuditStore

  beforeEach(() => {
    store = createStore()
  })

  afterEach(() => {
    store.close()
  })

  // -------------------------------------------------------------------------
  // Constructor
  // -------------------------------------------------------------------------

  describe('constructor', () => {
    it('creates the database and table successfully', () => {
      expect(() => createStore()).not.toThrow()
    })

    it('is idempotent when called on an existing schema', () => {
      // Creating a second store on :memory: is a separate DB, so instead
      // verify that the first store can be used immediately after construction
      const id = store.insert(makeRecord())
      expect(store.get(id)).toBeDefined()
    })

    it('creates the canonical duration schema', () => {
      const dir = mkdtempSync(join(tmpdir(), 'helio-audit-migrate-'))
      const dbPath = join(dir, 'audit.db')
      const fileStore = new AuditStore({
        path: dbPath,
        retention: '90d',
        includeResponses: true,
        cleanupIntervalMs: 0,
      })

      try {
        const schemaDb = new Database(dbPath)
        try {
          const schemaRows = schemaDb.pragma('table_info(audit_records)') as Array<{ name: string }>
          expect(schemaRows.map((row) => row.name)).toEqual(
            expect.arrayContaining([
              'total_duration_ms',
              'approval_wait_ms',
              'proxy_compute_ms',
              'upstream_http_status',
            ]),
          )
        } finally {
          schemaDb.close()
        }
      } finally {
        fileStore.close()
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('fails fast with actionable guidance for stale local schemas', () => {
      const dir = mkdtempSync(join(tmpdir(), 'helio-audit-stale-'))
      const dbPath = join(dir, 'audit.db')
      const legacyDb = new Database(dbPath)
      legacyDb
        .prepare(
          `
CREATE TABLE IF NOT EXISTS audit_records (
  id                TEXT PRIMARY KEY,
  timestamp         TEXT NOT NULL,
  session_id        TEXT,
  agent_id          TEXT,
  tool_name         TEXT NOT NULL,
  tool_input        TEXT NOT NULL,
  policy_decision   TEXT NOT NULL,
  matched_rule      TEXT,
  evidence_chain    TEXT,
  approval_status   TEXT,
  approved_by       TEXT,
  upstream_response TEXT,
  upstream_error    TEXT,
  upstream_latency_ms REAL,
  proxy_latency_ms  REAL NOT NULL,
  flagged_destructive INTEGER NOT NULL DEFAULT 0,
  dry_run           INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL
);`,
        )
        .run()
      legacyDb.close()

      try {
        expect(
          () =>
            new AuditStore({
              path: dbPath,
              retention: '90d',
              includeResponses: true,
              cleanupIntervalMs: 0,
            }),
        ).toThrowError(
          /Audit DB schema mismatch: missing required columns .*"block_reason".*Delete ".*audit\.db".*then restart Helio\./,
        )
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('fails fast when legacy schema is missing upstream_http_status', () => {
      const dir = mkdtempSync(join(tmpdir(), 'helio-audit-migrate-upstream-status-'))
      const dbPath = join(dir, 'audit.db')
      const legacyDb = new Database(dbPath)
      legacyDb
        .prepare(
          `
CREATE TABLE IF NOT EXISTS audit_records (
  id                TEXT PRIMARY KEY,
  timestamp         TEXT NOT NULL,
  session_id        TEXT,
  agent_id          TEXT,
  environment       TEXT,
  tool_name         TEXT NOT NULL,
  tool_input        TEXT NOT NULL,
  policy_decision   TEXT NOT NULL,
  block_reason      TEXT,
  matched_rule      TEXT,
  matched_rule_index INTEGER,
  evidence_chain    TEXT,
  approval_status   TEXT,
  approved_by       TEXT,
  upstream_response TEXT,
  upstream_error    TEXT,
  upstream_latency_ms REAL,
  total_duration_ms REAL NOT NULL,
  approval_wait_ms  REAL NOT NULL DEFAULT 0,
  proxy_compute_ms  REAL NOT NULL,
  flagged_destructive INTEGER NOT NULL DEFAULT 0,
  dry_run           INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL
);`,
        )
        .run()
      legacyDb.close()

      try {
        expect(
          () =>
            new AuditStore({
              path: dbPath,
              retention: '90d',
              includeResponses: true,
              cleanupIntervalMs: 0,
            }),
        ).toThrowError(
          /Audit DB schema mismatch: missing required columns .*"upstream_http_status".*Delete ".*audit\.db".*then restart Helio\./,
        )
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it.runIf(process.platform !== 'win32')(
      'creates the audit database file with 0600 permissions',
      () => {
        // Write to a tempdir path so we can stat the file on disk. The audit
        // database is the sole record of every governance decision — it must
        // not be world- or group-readable regardless of the operator's umask.
        const dir = mkdtempSync(join(tmpdir(), 'helio-audit-perm-'))
        const dbPath = join(dir, 'audit.db')
        const fileStore = new AuditStore({
          path: dbPath,
          retention: '90d',
          includeResponses: true,
          cleanupIntervalMs: 0,
        })
        try {
          // Force a second write so the -wal and -shm sidecar files are
          // guaranteed to exist. WAL mode creates them on the first write
          // transaction, which the constructor's purgeExpired() triggers.
          fileStore.insert(makeRecord())

          const mainMode = statSync(dbPath).mode & 0o777
          expect(mainMode).toBe(0o600)

          // The WAL and SHM files land on disk as soon as any write
          // transaction runs. Both must also be 0o600.
          for (const suffix of ['-wal', '-shm'] as const) {
            const mode = statSync(dbPath + suffix).mode & 0o777
            expect(mode).toBe(0o600)
          }
        } finally {
          fileStore.close()
          rmSync(dir, { recursive: true, force: true })
        }
      },
    )
  })

  // -------------------------------------------------------------------------
  // Insert
  // -------------------------------------------------------------------------

  describe('insert', () => {
    it('returns a UUID', () => {
      const id = store.insert(makeRecord())
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    })

    it('auto-generates created_at timestamp', () => {
      const record = insertAndGet(store, makeRecord())
      expect(record.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    })

    it('serializes and deserializes tool_input as JSON', () => {
      const input = { nested: { deep: [1, 2, 3] }, flag: true }
      const record = insertAndGet(store, makeRecord({ tool_input: input }))
      expect(record.tool_input).toEqual(input)
    })

    it('stores upstream_response when includeResponses is true', () => {
      const response = { status: 'ok', data: [1, 2] }
      const record = insertAndGet(store, makeRecord({ upstream_response: response }))
      expect(record.upstream_response).toEqual(response)
    })

    it('stores response summary when includeResponses is false', () => {
      const noResponseStore = createStore({ includeResponses: false })
      try {
        const record = insertAndGet(
          noResponseStore,
          makeRecord({
            upstream_response: {
              jsonrpc: '2.0',
              id: 1,
              result: { content: [{ type: 'text', text: 'ok' }] },
            },
          }),
        )
        const summary = record.upstream_response as Record<string, unknown>
        expect(summary['success']).toBe(true)
        expect(summary['has_error']).toBe(false)
        expect(summary['content_types']).toEqual(['text'])
        expect(summary['content_count']).toBe(1)
      } finally {
        noResponseStore.close()
      }
    })

    it('stores null when includeResponses is false and upstream_response is null', () => {
      const noResponseStore = createStore({ includeResponses: false })
      try {
        const record = insertAndGet(noResponseStore, makeRecord({ upstream_response: null }))
        expect(record.upstream_response).toBeNull()
      } finally {
        noResponseStore.close()
      }
    })

    it('summary contains error info for failed upstream response', () => {
      const noResponseStore = createStore({ includeResponses: false })
      try {
        const record = insertAndGet(
          noResponseStore,
          makeRecord({
            upstream_response: {
              jsonrpc: '2.0',
              id: 1,
              error: { code: -32601, message: 'Method not found' },
            },
          }),
        )
        const summary = record.upstream_response as Record<string, unknown>
        expect(summary['success']).toBe(false)
        expect(summary['has_error']).toBe(true)
        expect(summary['error_code']).toBe(-32601)
      } finally {
        noResponseStore.close()
      }
    })

    it('preserves the createdAt override', () => {
      const past = '2020-01-01T00:00:00.000Z'
      const record = insertAndGet(store, makeRecord(), past)
      expect(record.created_at).toBe(past)
    })

    it('converts dry_run boolean to integer and back', () => {
      const record = insertAndGet(store, makeRecord({ dry_run: true }))
      expect(record.dry_run).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // Get
  // -------------------------------------------------------------------------

  describe('get', () => {
    it('returns a record by ID', () => {
      const record = insertAndGet(
        store,
        makeRecord({
          tool_name: 'my_tool',
          policy_decision: 'deny',
          matched_rule: 'block-all',
        }),
      )
      expect(record.tool_name).toBe('my_tool')
      expect(record.policy_decision).toBe('deny')
      expect(record.matched_rule).toBe('block-all')
    })

    it('returns undefined for non-existent ID', () => {
      expect(store.get('00000000-0000-0000-0000-000000000000')).toBeUndefined()
    })
  })

  // -------------------------------------------------------------------------
  // List
  // -------------------------------------------------------------------------

  describe('list', () => {
    it('returns all records when no filters specified', () => {
      store.insert(makeRecord())
      store.insert(makeRecord())
      store.insert(makeRecord())
      const result = store.list()
      expect(result.total).toBe(3)
      expect(result.records).toHaveLength(3)
    })

    it('filters by tool_name', () => {
      store.insert(makeRecord({ tool_name: 'alpha' }))
      store.insert(makeRecord({ tool_name: 'beta' }))
      store.insert(makeRecord({ tool_name: 'alpha' }))
      const result = store.list({ tool_name: 'alpha' })
      expect(result.total).toBe(2)
      expect(result.records.every((r) => r.tool_name === 'alpha')).toBe(true)
    })

    it('filters by policy_decision', () => {
      store.insert(makeRecord({ policy_decision: 'allow' }))
      store.insert(makeRecord({ policy_decision: 'deny' }))
      store.insert(makeRecord({ policy_decision: 'deny' }))
      const result = store.list({ policy_decision: 'deny' })
      expect(result.total).toBe(2)
    })

    it('filters by block_reason', () => {
      store.insert(makeRecord({ policy_decision: 'deny', block_reason: 'evidence_missing' }))
      store.insert(makeRecord({ policy_decision: 'deny', block_reason: 'evidence_expired' }))
      store.insert(makeRecord({ policy_decision: 'deny', block_reason: 'evidence_missing' }))
      const result = store.list({ block_reason: 'evidence_missing' })
      expect(result.total).toBe(2)
      expect(result.records.every((r) => r.block_reason === 'evidence_missing')).toBe(true)
    })

    it('filters blocked=true using non-null block_reason', () => {
      store.insert(makeRecord({ policy_decision: 'allow', block_reason: null }))
      store.insert(makeRecord({ policy_decision: 'deny', block_reason: 'policy_denied' }))
      store.insert(makeRecord({ policy_decision: 'rate_limit', block_reason: 'rate_limited' }))
      const result = store.list({ blocked: true })
      expect(result.total).toBe(2)
      expect(result.records.every((r) => r.block_reason !== null)).toBe(true)
    })

    it('filters blocked=false using null block_reason', () => {
      store.insert(makeRecord({ policy_decision: 'allow', block_reason: null }))
      store.insert(makeRecord({ policy_decision: 'deny', block_reason: 'policy_denied' }))
      const result = store.list({ blocked: false })
      expect(result.total).toBe(1)
      expect(result.records.every((r) => r.block_reason === null)).toBe(true)
    })

    it('filters by session_id', () => {
      store.insert(makeRecord({ session_id: 'session-1' }))
      store.insert(makeRecord({ session_id: 'session-2' }))
      const result = store.list({ session_id: 'session-1' })
      expect(result.total).toBe(1)
      expect(result.records[0]?.session_id).toBe('session-1')
    })

    it('filters by time range with from and to', () => {
      store.insert(makeRecord(), '2024-01-01T00:00:00.000Z')
      store.insert(makeRecord(), '2024-06-15T00:00:00.000Z')
      store.insert(makeRecord(), '2024-12-31T00:00:00.000Z')
      const result = store.list({
        from: '2024-03-01T00:00:00.000Z',
        to: '2024-09-01T00:00:00.000Z',
      })
      expect(result.total).toBe(1)
    })

    it('filters by dry_run', () => {
      store.insert(makeRecord({ dry_run: true }))
      store.insert(makeRecord({ dry_run: false }))
      store.insert(makeRecord({ dry_run: true }))
      const result = store.list({ dry_run: true })
      expect(result.total).toBe(2)
      expect(result.records.every((r) => r.dry_run)).toBe(true)
    })

    it('filters by upstream_status_min', () => {
      store.insert(makeRecord({ upstream_http_status: 200 }))
      store.insert(makeRecord({ upstream_http_status: 404 }))
      store.insert(makeRecord({ upstream_http_status: 500 }))
      store.insert(makeRecord({ upstream_http_status: null }))
      const result = store.list({ upstream_status_min: 500 })
      expect(result.total).toBe(1)
      expect(result.records[0]?.upstream_http_status).toBe(500)
    })

    it('filters by upstream_status_max', () => {
      store.insert(makeRecord({ upstream_http_status: 200 }))
      store.insert(makeRecord({ upstream_http_status: 404 }))
      store.insert(makeRecord({ upstream_http_status: 500 }))
      const result = store.list({ upstream_status_max: 404 })
      expect(result.total).toBe(2)
      expect(result.records.every((r) => (r.upstream_http_status ?? 0) <= 404)).toBe(true)
    })

    it('combines multiple filters', () => {
      store.insert(makeRecord({ tool_name: 'alpha', policy_decision: 'allow' }))
      store.insert(makeRecord({ tool_name: 'alpha', policy_decision: 'deny' }))
      store.insert(makeRecord({ tool_name: 'beta', policy_decision: 'allow' }))
      const result = store.list({ tool_name: 'alpha', policy_decision: 'allow' })
      expect(result.total).toBe(1)
    })

    it('paginates with limit and offset', () => {
      for (let i = 0; i < 10; i++) {
        store.insert(makeRecord({ tool_name: `tool_${String(i)}` }))
      }
      const page1 = store.list({}, { limit: 3, offset: 0 })
      const page2 = store.list({}, { limit: 3, offset: 3 })
      expect(page1.records).toHaveLength(3)
      expect(page2.records).toHaveLength(3)
      expect(page1.total).toBe(10)
      expect(page2.total).toBe(10)
      // No overlap between pages
      const ids1 = new Set(page1.records.map((r) => r.id))
      expect(page2.records.every((r) => !ids1.has(r.id))).toBe(true)
    })

    it('defaults to descending order by created_at', () => {
      store.insert(makeRecord(), '2024-01-01T00:00:00.000Z')
      store.insert(makeRecord(), '2024-06-01T00:00:00.000Z')
      store.insert(makeRecord(), '2024-12-01T00:00:00.000Z')
      const result = store.list()
      expect(result.records[0]?.created_at).toBe('2024-12-01T00:00:00.000Z')
      expect(result.records[2]?.created_at).toBe('2024-01-01T00:00:00.000Z')
    })

    it('supports ascending order', () => {
      store.insert(makeRecord(), '2024-01-01T00:00:00.000Z')
      store.insert(makeRecord(), '2024-12-01T00:00:00.000Z')
      const result = store.list({}, { order: 'asc' })
      expect(result.records[0]?.created_at).toBe('2024-01-01T00:00:00.000Z')
    })

    it('clamps limit to maximum of 1000', () => {
      store.insert(makeRecord())
      const result = store.list({}, { limit: 5000 })
      expect(result.limit).toBe(1000)
    })

    it('returns correct total regardless of pagination', () => {
      for (let i = 0; i < 10; i++) {
        store.insert(makeRecord())
      }
      const result = store.list({}, { limit: 3 })
      expect(result.records).toHaveLength(3)
      expect(result.total).toBe(10)
    })
  })

  // -------------------------------------------------------------------------
  // Count
  // -------------------------------------------------------------------------

  describe('count', () => {
    it('counts all records', () => {
      store.insert(makeRecord())
      store.insert(makeRecord())
      expect(store.count()).toBe(2)
    })

    it('counts with filters', () => {
      store.insert(makeRecord({ policy_decision: 'allow' }))
      store.insert(makeRecord({ policy_decision: 'deny' }))
      store.insert(makeRecord({ policy_decision: 'deny' }))
      expect(store.count({ policy_decision: 'deny' })).toBe(2)
    })
  })

  // -------------------------------------------------------------------------
  // Aggregate
  // -------------------------------------------------------------------------

  describe('aggregate', () => {
    it('returns correct total', () => {
      store.insert(makeRecord())
      store.insert(makeRecord())
      store.insert(makeRecord())
      const stats = store.aggregate()
      expect(stats.total).toBe(3)
    })

    it('groups by policy_decision', () => {
      store.insert(makeRecord({ policy_decision: 'allow' }))
      store.insert(makeRecord({ policy_decision: 'allow' }))
      store.insert(makeRecord({ policy_decision: 'deny' }))
      const stats = store.aggregate()
      expect(stats.by_decision).toEqual(
        expect.arrayContaining([
          { decision: 'allow', count: 2 },
          { decision: 'deny', count: 1 },
        ]),
      )
    })

    it('returns blocked totals and reason buckets', () => {
      store.insert(makeRecord({ policy_decision: 'allow', block_reason: null }))
      store.insert(makeRecord({ policy_decision: 'deny', block_reason: 'policy_denied' }))
      store.insert(makeRecord({ policy_decision: 'rate_limit', block_reason: 'rate_limited' }))
      store.insert(makeRecord({ policy_decision: 'rate_limit', block_reason: 'rate_limited' }))
      const stats = store.aggregate()
      expect(stats.allowed_total).toBe(1)
      expect(stats.blocked_total).toBe(3)
      expect(stats.by_block_reason).toEqual(
        expect.arrayContaining([
          { reason: 'policy_denied', count: 1 },
          { reason: 'rate_limited', count: 2 },
        ]),
      )
    })

    it('returns dry-run and applied totals', () => {
      store.insert(makeRecord({ dry_run: false, block_reason: null }))
      store.insert(makeRecord({ dry_run: false, block_reason: 'policy_denied' }))
      store.insert(makeRecord({ dry_run: true, block_reason: null }))
      const stats = store.aggregate()
      expect(stats.total).toBe(3)
      expect(stats.dry_run_total).toBe(1)
      expect(stats.applied_total).toBe(2)
      expect(stats.allowed_total).toBe(2)
      expect(stats.blocked_total).toBe(1)
    })

    it('returns top tools sorted by count', () => {
      store.insert(makeRecord({ tool_name: 'alpha' }))
      store.insert(makeRecord({ tool_name: 'alpha' }))
      store.insert(makeRecord({ tool_name: 'alpha' }))
      store.insert(makeRecord({ tool_name: 'beta' }))
      store.insert(makeRecord({ tool_name: 'beta' }))
      store.insert(makeRecord({ tool_name: 'gamma' }))
      const stats = store.aggregate()
      expect(stats.top_tools[0]).toEqual({ tool_name: 'alpha', count: 3 })
      expect(stats.top_tools[1]).toEqual({ tool_name: 'beta', count: 2 })
      expect(stats.top_tools[2]).toEqual({ tool_name: 'gamma', count: 1 })
    })

    it('calculates approval rate', () => {
      store.insert(
        makeRecord({
          policy_decision: 'require_approval',
          approval_status: 'approved',
        }),
      )
      store.insert(
        makeRecord({
          policy_decision: 'require_approval',
          approval_status: 'approved',
        }),
      )
      store.insert(
        makeRecord({
          policy_decision: 'require_approval',
          approval_status: 'denied',
        }),
      )
      const stats = store.aggregate()
      // 2 approved out of 3 require_approval
      expect(stats.approval_rate).toBeCloseTo(2 / 3)
    })

    it('returns null approval_rate when no require_approval decisions', () => {
      store.insert(makeRecord({ policy_decision: 'allow' }))
      const stats = store.aggregate()
      expect(stats.approval_rate).toBeNull()
    })

    it('groups records by hour', () => {
      store.insert(makeRecord(), '2024-06-15T10:05:00.000Z')
      store.insert(makeRecord(), '2024-06-15T10:30:00.000Z')
      store.insert(makeRecord(), '2024-06-15T11:15:00.000Z')
      const stats = store.aggregate()
      expect(stats.per_hour).toHaveLength(2)
      const hour10 = stats.per_hour.find((b) => b.bucket.includes('T10:'))
      const hour11 = stats.per_hour.find((b) => b.bucket.includes('T11:'))
      expect(hour10?.count).toBe(2)
      expect(hour11?.count).toBe(1)
    })

    it('filters by time range', () => {
      store.insert(makeRecord(), '2024-01-01T00:00:00.000Z')
      store.insert(makeRecord(), '2024-06-15T00:00:00.000Z')
      store.insert(makeRecord(), '2024-12-31T00:00:00.000Z')
      const stats = store.aggregate('2024-03-01T00:00:00.000Z', '2024-09-01T00:00:00.000Z')
      expect(stats.total).toBe(1)
    })
  })

  // -------------------------------------------------------------------------
  // Purge
  // -------------------------------------------------------------------------

  describe('purgeExpired', () => {
    it('deletes records older than retention period', () => {
      // Insert a record backdated to well before the 90d retention
      store.insert(makeRecord(), '2020-01-01T00:00:00.000Z')
      store.insert(makeRecord()) // recent
      expect(store.count()).toBe(2)
      const deleted = store.purgeExpired()
      expect(deleted).toBe(1)
      expect(store.count()).toBe(1)
    })

    it('preserves records within retention period', () => {
      store.insert(makeRecord()) // recent
      const deleted = store.purgeExpired()
      expect(deleted).toBe(0)
      expect(store.count()).toBe(1)
    })

    it('returns count of deleted records', () => {
      store.insert(makeRecord(), '2019-01-01T00:00:00.000Z')
      store.insert(makeRecord(), '2019-06-01T00:00:00.000Z')
      store.insert(makeRecord(), '2019-12-01T00:00:00.000Z')
      const deleted = store.purgeExpired()
      expect(deleted).toBe(3)
    })
  })

  // -------------------------------------------------------------------------
  // Close
  // -------------------------------------------------------------------------

  describe('close', () => {
    it('closes the database gracefully', () => {
      store.insert(makeRecord())
      expect(() => {
        store.close()
      }).not.toThrow()
      // Create a new store so afterEach doesn't double-close
      store = createStore()
    })
  })

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  describe('edge cases', () => {
    it('handles empty database gracefully', () => {
      expect(store.list().records).toHaveLength(0)
      expect(store.list().total).toBe(0)
      expect(store.count()).toBe(0)
      const stats = store.aggregate()
      expect(stats.total).toBe(0)
      expect(stats.allowed_total).toBe(0)
      expect(stats.by_decision).toHaveLength(0)
      expect(stats.blocked_total).toBe(0)
      expect(stats.dry_run_total).toBe(0)
      expect(stats.applied_total).toBe(0)
      expect(stats.by_block_reason).toHaveLength(0)
      expect(stats.top_tools).toHaveLength(0)
      expect(stats.approval_rate).toBeNull()
      expect(stats.per_hour).toHaveLength(0)
    })

    it('handles records with all nullable fields set to null', () => {
      const record = insertAndGet(
        store,
        makeRecord({
          session_id: null,
          agent_id: null,
          matched_rule: null,
          evidence_chain: null,
          approval_status: null,
          approved_by: null,
          upstream_response: null,
          upstream_error: null,
          upstream_http_status: null,
          upstream_latency_ms: null,
        }),
      )
      expect(record.session_id).toBeNull()
      expect(record.agent_id).toBeNull()
      expect(record.matched_rule).toBeNull()
      expect(record.evidence_chain).toBeNull()
      expect(record.upstream_response).toBeNull()
      expect(record.upstream_error).toBeNull()
      expect(record.upstream_latency_ms).toBeNull()
    })

    it('handles large tool_input objects', () => {
      const largeInput: Record<string, unknown> = {}
      for (let i = 0; i < 100; i++) {
        largeInput[`key_${String(i)}`] = { nested: Array.from({ length: 10 }, (_, j) => j) }
      }
      const record = insertAndGet(store, makeRecord({ tool_input: largeInput }))
      expect(record.tool_input).toEqual(largeInput)
    })

    it('handles special characters in string fields', () => {
      const record = insertAndGet(
        store,
        makeRecord({
          tool_name: 'tool "with" quotes',
          matched_rule: "rule's with 'apostrophes'",
          upstream_error: 'error\nwith\nnewlines\tand\ttabs',
          session_id: 'unicode-session',
        }),
      )
      expect(record.tool_name).toBe('tool "with" quotes')
      expect(record.matched_rule).toBe("rule's with 'apostrophes'")
      expect(record.upstream_error).toBe('error\nwith\nnewlines\tand\ttabs')
      expect(record.session_id).toBe('unicode-session')
    })
  })
})
