import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { AuditStore, EXPORT_MAX_RECORDS, migrateAuditUpstreamColumn } from './store.js'
import { StartupError } from '../startup-error.js'
import type { AuditRecord } from './types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type InsertRecord = Omit<AuditRecord, 'id' | 'created_at'>

function makeRecord(overrides: Partial<InsertRecord> = {}): InsertRecord {
  const defaults: InsertRecord = {
    timestamp: new Date().toISOString(),
    session_id: null,
    session_source: null,
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
    record_kind: 'tool_call',
    origin: 'mcp',
    metadata: null,
    protocol_version: null,
    upstream: null,
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
        ).toThrow(
          /Audit DB schema mismatch: missing required columns .*"block_reason".*Delete ".*audit\.db".*then restart Helio\./,
        )
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('throws a StartupError on a schema mismatch, for the CLI clean-exit path (issue #233)', () => {
      const dir = mkdtempSync(join(tmpdir(), 'helio-audit-startup-error-'))
      const dbPath = join(dir, 'audit.db')
      const legacyDb = new Database(dbPath)
      // MANY required columns missing: a DB missing only `upstream` is
      // silently repaired on open (the #292 additive exception) and would
      // never reach the mismatch throw.
      legacyDb.exec(
        'CREATE TABLE audit_records (' +
          'id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, tool_name TEXT NOT NULL, ' +
          'policy_decision TEXT NOT NULL, matched_rule TEXT, tool_input TEXT, ' +
          'flagged_destructive INTEGER, dry_run INTEGER)',
      )
      legacyDb.close()

      try {
        let caught: unknown
        try {
          new AuditStore({
            path: dbPath,
            retention: '90d',
            includeResponses: true,
            cleanupIntervalMs: 0,
          })
        } catch (err) {
          caught = err
        }
        expect(caught).toBeInstanceOf(StartupError)
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
        ).toThrow(
          /Audit DB schema mismatch: missing required columns .*"upstream_http_status".*Delete ".*audit\.db".*then restart Helio\./,
        )
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('fails fast when a pre-0.12 schema is missing session_source (issue #218)', () => {
      const dir = mkdtempSync(join(tmpdir(), 'helio-audit-migrate-session-source-'))
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
  upstream_http_status INTEGER,
  upstream_latency_ms REAL,
  total_duration_ms REAL NOT NULL,
  approval_wait_ms  REAL NOT NULL DEFAULT 0,
  proxy_compute_ms  REAL NOT NULL,
  flagged_destructive INTEGER NOT NULL DEFAULT 0,
  dry_run           INTEGER NOT NULL DEFAULT 0,
  record_kind       TEXT NOT NULL DEFAULT 'tool_call',
  origin            TEXT NOT NULL DEFAULT 'mcp',
  metadata          TEXT,
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
        ).toThrow(
          /Audit DB schema mismatch: missing required columns .*"session_source".*Delete ".*audit\.db".*then restart Helio\./,
        )
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('fails fast when a pre-#219 schema is missing protocol_version', () => {
      const dir = mkdtempSync(join(tmpdir(), 'helio-audit-migrate-protocol-version-'))
      const dbPath = join(dir, 'audit.db')
      const legacyDb = new Database(dbPath)
      legacyDb
        .prepare(
          `
CREATE TABLE IF NOT EXISTS audit_records (
  id                TEXT PRIMARY KEY,
  timestamp         TEXT NOT NULL,
  session_id        TEXT,
  session_source    TEXT,
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
  upstream_http_status INTEGER,
  upstream_latency_ms REAL,
  total_duration_ms REAL NOT NULL,
  approval_wait_ms  REAL NOT NULL DEFAULT 0,
  proxy_compute_ms  REAL NOT NULL,
  flagged_destructive INTEGER NOT NULL DEFAULT 0,
  dry_run           INTEGER NOT NULL DEFAULT 0,
  record_kind       TEXT NOT NULL DEFAULT 'tool_call',
  origin            TEXT NOT NULL DEFAULT 'mcp',
  metadata          TEXT,
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
        ).toThrow(
          /Audit DB schema mismatch: missing required columns .*"protocol_version".*Delete ".*audit\.db".*then restart Helio\./,
        )
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('round-trips protocol_version through insert, get, and list (issue #219)', () => {
      const store = createStore()
      const claimedId = store.insert(makeRecord({ protocol_version: '2026-07-28' }))
      store.insert(makeRecord({ protocol_version: 'not-a-version' }))
      store.insert(makeRecord({ protocol_version: null }))

      expect(store.get(claimedId)?.protocol_version).toBe('2026-07-28')
      const versions = store.list({}, { order: 'asc' }).records.map((r) => r.protocol_version)
      expect(versions).toEqual(['2026-07-28', 'not-a-version', null])

      store.close()
    })

    it('round-trips session_source through insert and list (issue #218)', () => {
      const store = new AuditStore({
        path: ':memory:',
        retention: '90d',
        includeResponses: true,
        cleanupIntervalMs: 0,
      })
      try {
        store.insert(makeRecord({ session_id: 'run-a', session_source: 'header' }))
        store.insert(makeRecord({ session_id: 'oc-1', session_source: 'sideband' }))
        store.insert(makeRecord({ session_id: null, session_source: null }))

        const sources = store.list().records.map((record) => record.session_source)
        expect(new Set(sources)).toEqual(new Set(['header', 'sideband', null]))
      } finally {
        store.close()
      }
    })

    it('filters by session_source with exact match; null rows never match (issue #250)', () => {
      const store = createStore()
      try {
        store.insert(makeRecord({ session_id: 'run-a', session_source: 'header' }))
        store.insert(makeRecord({ session_id: 'oc-1', session_source: 'meta' }))
        store.insert(makeRecord({ session_id: null, session_source: null }))

        const result = store.list({ session_source: 'header' })
        expect(result.total).toBe(1)
        expect(result.records[0]?.session_source).toBe('header')
      } finally {
        store.close()
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
  // upstream column + one-time additive migration (issue #292)
  // -------------------------------------------------------------------------

  describe('upstream column and additive migration (issue #292)', () => {
    // The exact v0.12.0 shipped schema (29 columns, no `upstream`) — the one
    // population the ratified additive-migration exception applies to.
    const V012_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS audit_records (
  id                TEXT PRIMARY KEY,
  timestamp         TEXT NOT NULL,
  session_id        TEXT,
  session_source    TEXT,
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
  upstream_http_status INTEGER,
  upstream_latency_ms REAL,
  total_duration_ms REAL NOT NULL,
  approval_wait_ms  REAL NOT NULL DEFAULT 0,
  proxy_compute_ms  REAL NOT NULL,
  flagged_destructive INTEGER NOT NULL DEFAULT 0,
  dry_run           INTEGER NOT NULL DEFAULT 0,
  record_kind       TEXT NOT NULL DEFAULT 'tool_call',
  origin            TEXT NOT NULL DEFAULT 'mcp',
  metadata          TEXT,
  protocol_version  TEXT,
  created_at        TEXT NOT NULL
);`

    /** Create a v0.12.0-schema database file holding one pre-existing row. */
    function createV012Fixture(prefix: string): { dir: string; dbPath: string } {
      const dir = mkdtempSync(join(tmpdir(), prefix))
      const dbPath = join(dir, 'audit.db')
      const legacyDb = new Database(dbPath)
      legacyDb.exec(V012_TABLE_DDL)
      legacyDb
        .prepare(
          `INSERT INTO audit_records (id, timestamp, tool_name, tool_input, policy_decision,
             total_duration_ms, proxy_compute_ms, created_at)
           VALUES ('pre-1', '2026-08-01T00:00:00.000Z', 'legacy_tool', '{}', 'allow', 1, 1,
             '2026-08-01T00:00:00.000Z')`,
        )
        .run()
      legacyDb.close()
      return { dir, dbPath }
    }

    it('round-trips upstream through insert, get, and list', () => {
      const record = insertAndGet(store, makeRecord({ upstream: 'github' }))
      expect(record.upstream).toBe('github')
      expect(store.list().records[0]?.upstream).toBe('github')
    })

    it('stores null upstream as null (singular mode)', () => {
      const record = insertAndGet(store, makeRecord({ upstream: null }))
      expect(record.upstream).toBeNull()
    })

    it('migrates a v0.12.0 database in place with a one-time stderr notice', () => {
      const { dir, dbPath } = createV012Fixture('helio-audit-upstream-migrate-')
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      errorSpy.mockClear()
      let migrated: AuditStore | null = null
      try {
        migrated = new AuditStore({
          path: dbPath,
          retention: '90d',
          includeResponses: true,
          cleanupIntervalMs: 0,
        })
        expect(errorSpy).toHaveBeenCalledWith('[helio] Audit DB migrated: added column "upstream"')

        // The pre-existing row reads back with upstream null — no backfill.
        const listed = migrated.list({}, { order: 'asc' }).records
        expect(listed[0]?.tool_name).toBe('legacy_tool')
        expect(listed[0]?.upstream).toBeNull()

        // A fresh insert works against the migrated schema.
        const id = migrated.insert(makeRecord({ upstream: 'github' }))
        expect(migrated.get(id)?.upstream).toBe('github')
      } finally {
        migrated?.close()
        errorSpy.mockRestore()
      }

      // The migrated file's column order matches the fresh DDL: upstream LAST,
      // so positional consumers agree across both populations.
      const probeDb = new Database(dbPath)
      try {
        const names = (probeDb.pragma('table_info(audit_records)') as Array<{ name: string }>).map(
          (row) => row.name,
        )
        expect(names[names.length - 1]).toBe('upstream')
      } finally {
        probeDb.close()
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('does not log again on a second open of an already-migrated database', () => {
      const { dir, dbPath } = createV012Fixture('helio-audit-upstream-remigrate-')
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      errorSpy.mockClear()
      const options = {
        path: dbPath,
        retention: '90d',
        includeResponses: true,
        cleanupIntervalMs: 0,
      }
      try {
        const first = new AuditStore(options)
        first.close()
        expect(errorSpy).toHaveBeenCalledWith('[helio] Audit DB migrated: added column "upstream"')

        errorSpy.mockClear()
        const second = new AuditStore(options)
        second.close()
        expect(errorSpy).not.toHaveBeenCalledWith(
          '[helio] Audit DB migrated: added column "upstream"',
        )
      } finally {
        errorSpy.mockRestore()
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('filters by upstream with exact match; null rows never match', () => {
      store.insert(makeRecord({ upstream: 'github' }))
      store.insert(makeRecord({ upstream: null }))
      const result = store.list({ upstream: 'github' })
      expect(result.total).toBe(1)
      expect(result.records[0]?.upstream).toBe('github')
    })

    it('recovers when a second opener wins the probe-then-ALTER race', () => {
      // Part 1 — the helper itself: dbA probes, then a second connection
      // lands the ALTER first; dbA's own ALTER throws duplicate-column and
      // the helper recovers by re-probing instead of crashing the open.
      const { dir, dbPath } = createV012Fixture('helio-audit-upstream-race-')
      const dbA = new Database(dbPath)
      const dbB = new Database(dbPath)
      const realExec = dbA.exec.bind(dbA)
      const execSpy = vi.spyOn(dbA, 'exec').mockImplementationOnce((sql: string) => {
        dbB.exec(sql) // the race winner lands the column first
        return realExec(sql) // the lost race: throws duplicate column name
      })
      try {
        expect(migrateAuditUpstreamColumn(dbA)).toBe(false)
        const names = (dbA.pragma('table_info(audit_records)') as Array<{ name: string }>).map(
          (row) => row.name,
        )
        expect(names).toContain('upstream')
      } finally {
        execSpy.mockRestore()
        dbA.close()
        dbB.close()
      }

      // Part 2 — the constructor on the post-race file: the skip-if-present
      // gate finds nothing missing, so there is no migration log and the
      // store reads and writes normally. (The catch path itself is pinned at
      // the helper above; the constructor is pinned on both boolean
      // outcomes — log-on-true elsewhere, no-log-on-false here.)
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      errorSpy.mockClear()
      let racedStore: AuditStore | null = null
      try {
        racedStore = new AuditStore({
          path: dbPath,
          retention: '90d',
          includeResponses: true,
          cleanupIntervalMs: 0,
        })
        expect(errorSpy).not.toHaveBeenCalledWith(
          '[helio] Audit DB migrated: added column "upstream"',
        )
        const id = racedStore.insert(makeRecord())
        expect(racedStore.get(id)).toBeDefined()
        const rows = racedStore.list().records
        expect(rows.length).toBeGreaterThanOrEqual(2)
        expect(rows.every((row) => row.upstream === null)).toBe(true)
      } finally {
        racedStore?.close()
        errorSpy.mockRestore()
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('still clean-breaks a pre-0.12 database without ALTERing it', () => {
      const dir = mkdtempSync(join(tmpdir(), 'helio-audit-upstream-pre012-'))
      const dbPath = join(dir, 'audit.db')
      const legacyDb = new Database(dbPath)
      legacyDb.exec(`
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
  upstream_http_status INTEGER,
  upstream_latency_ms REAL,
  total_duration_ms REAL NOT NULL,
  approval_wait_ms  REAL NOT NULL DEFAULT 0,
  proxy_compute_ms  REAL NOT NULL,
  flagged_destructive INTEGER NOT NULL DEFAULT 0,
  dry_run           INTEGER NOT NULL DEFAULT 0,
  record_kind       TEXT NOT NULL DEFAULT 'tool_call',
  origin            TEXT NOT NULL DEFAULT 'mcp',
  metadata          TEXT,
  created_at        TEXT NOT NULL
);`)
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
        ).toThrow(/session_source/)

        // No schema change: the migration gate must never ALTER a pre-0.12
        // file it is about to refuse. There is no store instance after the
        // throw, so probe with a raw connection. (WAL/SHM sidecars
        // legitimately exist on this path.)
        const probeDb = new Database(dbPath)
        try {
          const names = (
            probeDb.pragma('table_info(audit_records)') as Array<{ name: string }>
          ).map((row) => row.name)
          expect(names).not.toContain('upstream')
        } finally {
          probeDb.close()
        }
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
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

    it('round-trips record_kind, origin, and metadata (issue #12)', () => {
      const metadata = { channel_id: 'C1', sender_id: 'U7', nested: { a: 1 } }
      const record = insertAndGet(
        store,
        makeRecord({ record_kind: 'install_scan', origin: 'openclaw', metadata }),
      )
      expect(record.record_kind).toBe('install_scan')
      expect(record.origin).toBe('openclaw')
      expect(record.metadata).toEqual(metadata)
    })

    it('stores null metadata as null, not the string "null"', () => {
      const record = insertAndGet(store, makeRecord({ metadata: null }))
      expect(record.metadata).toBeNull()
    })

    it('filters by record_kind and origin', () => {
      store.insert(makeRecord({ record_kind: 'tool_call', origin: 'mcp' }))
      store.insert(makeRecord({ record_kind: 'install_scan', origin: 'openclaw' }))
      store.insert(makeRecord({ record_kind: 'install_scan', origin: 'openclaw' }))

      expect(store.list({ record_kind: 'install_scan' }).total).toBe(2)
      expect(store.list({ origin: 'mcp' }).total).toBe(1)
      expect(store.list({ origin: 'openclaw' }).total).toBe(2)
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
  // List for export
  // -------------------------------------------------------------------------

  describe('listForExport', () => {
    it('returns more than 1000 records in one call', () => {
      const records = Array.from({ length: 1500 }, () => makeRecord())
      store.insertBatch(records)
      const result = store.listForExport({}, 1500)
      expect(result.records).toHaveLength(1500)
      expect(result.total).toBe(1500)
    })

    it('defaults to the export maximum', () => {
      store.insert(makeRecord())
      const result = store.listForExport()
      expect(result.limit).toBe(EXPORT_MAX_RECORDS)
    })

    it('clamps limit to the export maximum', () => {
      store.insert(makeRecord())
      const result = store.listForExport({}, 20_000)
      expect(result.limit).toBe(EXPORT_MAX_RECORDS)
    })

    it('clamps limit to a minimum of 1', () => {
      store.insert(makeRecord())
      store.insert(makeRecord())
      const result = store.listForExport({}, 0)
      expect(result.records).toHaveLength(1)
      expect(result.limit).toBe(1)
    })

    it('returns records oldest-first', () => {
      store.insert(makeRecord(), '2024-12-01T00:00:00.000Z')
      store.insert(makeRecord(), '2024-01-01T00:00:00.000Z')
      const result = store.listForExport()
      expect(result.records[0]?.created_at).toBe('2024-01-01T00:00:00.000Z')
      expect(result.records[1]?.created_at).toBe('2024-12-01T00:00:00.000Z')
    })

    // SQLite happens to return equal-created_at rows in rowid order on the
    // query plans in use today; the explicit `rowid` tiebreaker in query()
    // turns that planner accident into a contract. These tests pin the
    // contract — insertion order within ties, in both sort directions, and
    // under a filtered plan that goes through a secondary index — so a future
    // query-plan or schema change cannot silently reorder ties or move the
    // cut point of a capped export.
    it('breaks created_at ties deterministically in insertion order', () => {
      const ts = '2024-06-01T00:00:00.000Z'
      store.insert(makeRecord({ tool_name: 'before' }), '2024-01-01T00:00:00.000Z')
      for (const name of ['tie_a', 'tie_b', 'tie_c']) {
        store.insert(makeRecord({ tool_name: name }), ts)
      }
      store.insert(makeRecord({ tool_name: 'after' }), '2024-12-01T00:00:00.000Z')

      const expected = ['before', 'tie_a', 'tie_b', 'tie_c', 'after']
      const first = store.listForExport()
      const second = store.listForExport()
      expect(first.records.map((r) => r.tool_name)).toEqual(expected)
      expect(second.records.map((r) => r.tool_name)).toEqual(expected)
    })

    it('keeps tie order deterministic under a secondary-index filter plan', () => {
      const ts = '2024-06-01T00:00:00.000Z'
      for (const name of ['tie_a', 'tie_b', 'tie_c']) {
        store.insert(makeRecord({ tool_name: name, policy_decision: 'deny' }), ts)
        store.insert(makeRecord({ tool_name: `skip_${name}`, policy_decision: 'allow' }), ts)
      }

      const result = store.listForExport({ policy_decision: 'deny' })
      expect(result.records.map((r) => r.tool_name)).toEqual(['tie_a', 'tie_b', 'tie_c'])
    })

    it('reverses tie order for descending list() reads', () => {
      const ts = '2024-06-01T00:00:00.000Z'
      for (const name of ['tie_a', 'tie_b', 'tie_c']) {
        store.insert(makeRecord({ tool_name: name }), ts)
      }

      const result = store.list({}, { order: 'desc' })
      expect(result.records.map((r) => r.tool_name)).toEqual(['tie_c', 'tie_b', 'tie_a'])
    })

    it('applies filters', () => {
      store.insert(makeRecord({ policy_decision: 'deny', block_reason: 'policy_denied' }))
      store.insert(makeRecord())
      const result = store.listForExport({ policy_decision: 'deny' })
      expect(result.records).toHaveLength(1)
      expect(result.records[0]?.policy_decision).toBe('deny')
      expect(result.total).toBe(1)
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
      expect(stats.top_tools[0]).toEqual({ tool_name: 'alpha', upstream: null, count: 3 })
      expect(stats.top_tools[1]).toEqual({ tool_name: 'beta', upstream: null, count: 2 })
      expect(stats.top_tools[2]).toEqual({ tool_name: 'gamma', upstream: null, count: 1 })
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

  describe('aggregate with drift-event records', () => {
    it('excludes tool_drift records from allowed_total and top_tools', () => {
      const s = createStore()
      s.insert(
        makeRecord({ tool_name: 'get_weather', policy_decision: 'allow', block_reason: null }),
      ) // a normal allowed call
      s.insert(
        makeRecord({
          tool_name: 'send_email',
          policy_decision: 'tool_drift',
          block_reason: null,
          tool_input: {},
        }),
      )
      s.insert(
        makeRecord({
          tool_name: 'send_email',
          policy_decision: 'tool_drift_reverted',
          block_reason: null,
          tool_input: {},
        }),
      )

      const stats = s.aggregate()
      expect(stats.total).toBe(3) // drift events remain visible in totals
      expect(stats.allowed_total).toBe(1) // but do not count as allowed calls
      expect(stats.blocked_total).toBe(0)
      expect(stats.top_tools).toEqual([{ tool_name: 'get_weather', upstream: null, count: 1 }])
      expect(stats.by_decision).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ decision: 'tool_drift', count: 1 }),
          expect.objectContaining({ decision: 'tool_drift_reverted', count: 1 }),
        ]),
      )

      s.close()
    })

    it('excludes rejected records from top_tools but keeps them in totals and by_decision', () => {
      const s = createStore()
      s.insert(
        makeRecord({ tool_name: 'get_weather', policy_decision: 'allow', block_reason: null }),
      ) // a normal allowed call
      s.insert(
        makeRecord({
          tool_name: '<nameless>',
          policy_decision: 'rejected',
          block_reason: 'missing_tool_name',
        }),
      )

      const stats = s.aggregate()
      expect(stats.total).toBe(2) // rejected records remain visible in totals
      expect(stats.allowed_total).toBe(1) // rejected is not an allowed call
      expect(stats.blocked_total).toBe(1) // rejected has a non-null block_reason
      expect(stats.top_tools).toEqual([{ tool_name: 'get_weather', upstream: null, count: 1 }])
      expect(stats.by_decision).toEqual(
        expect.arrayContaining([expect.objectContaining({ decision: 'rejected', count: 1 })]),
      )
      expect(stats.by_block_reason).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ reason: 'missing_tool_name', count: 1 }),
        ]),
      )

      s.close()
    })
  })

  describe('aggregate upstream dimension (issue #297)', () => {
    it('keeps same-named tools on different upstreams as distinct top_tools rows', () => {
      const s = createStore()
      try {
        s.insert(makeRecord({ tool_name: 'search', upstream: 'alpha' }))
        s.insert(makeRecord({ tool_name: 'search', upstream: 'alpha' }))
        s.insert(makeRecord({ tool_name: 'search', upstream: 'alpha' }))
        s.insert(makeRecord({ tool_name: 'search', upstream: 'beta' }))
        s.insert(makeRecord({ tool_name: 'search', upstream: 'beta' }))
        s.insert(makeRecord({ tool_name: 'fetch', upstream: 'beta' }))

        const stats = s.aggregate()
        // All counts distinct, so ORDER BY count DESC fully pins the array.
        expect(stats.top_tools).toEqual([
          { tool_name: 'search', upstream: 'alpha', count: 3 },
          { tool_name: 'search', upstream: 'beta', count: 2 },
          { tool_name: 'fetch', upstream: 'beta', count: 1 },
        ])
      } finally {
        s.close()
      }
    })

    it('applies the upstream filter to every sub-aggregate; null rows never match', () => {
      const s = createStore()
      try {
        s.insert(makeRecord({ tool_name: 'search', upstream: 'alpha', policy_decision: 'allow' }))
        s.insert(makeRecord({ tool_name: 'search', upstream: 'alpha', policy_decision: 'allow' }))
        s.insert(
          makeRecord({
            tool_name: 'search',
            upstream: 'alpha',
            policy_decision: 'deny',
            block_reason: 'policy_denied',
          }),
        )
        s.insert(makeRecord({ tool_name: 'fetch', upstream: 'beta', policy_decision: 'allow' }))
        s.insert(makeRecord({ tool_name: 'fetch', upstream: null, policy_decision: 'allow' }))

        const stats = s.aggregate(undefined, undefined, { upstream: 'alpha' })
        expect(stats.total).toBe(3)
        expect(stats.allowed_total).toBe(2)
        expect(stats.blocked_total).toBe(1)
        expect(stats.top_tools).toEqual([{ tool_name: 'search', upstream: 'alpha', count: 3 }])
        expect(stats.by_decision).toEqual(
          expect.arrayContaining([
            { decision: 'allow', count: 2 },
            { decision: 'deny', count: 1 },
          ]),
        )
        expect(stats.by_block_reason).toEqual([{ reason: 'policy_denied', count: 1 }])
      } finally {
        s.close()
      }
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
  // Retention sweep hooks (issue #14 — budget ledger co-residence)
  // -------------------------------------------------------------------------

  describe('runRetentionSweep', () => {
    it('purges expired audit records like purgeExpired', () => {
      store.insert(makeRecord(), '2020-01-01T00:00:00.000Z')
      store.insert(makeRecord()) // recent
      store.runRetentionSweep()
      expect(store.count()).toBe(1)
    })

    it('fires registered hooks with the sweep cutoff in both spellings', () => {
      const cutoffs: Array<{ iso: string; ms: number }> = []
      store.onRetentionSweep((cutoff) => {
        cutoffs.push(cutoff)
      })

      const before = Date.now()
      store.runRetentionSweep()
      const after = Date.now()

      expect(cutoffs).toHaveLength(1)
      const cutoff = cutoffs[0]
      if (!cutoff) throw new Error('hook did not fire')
      // retention is 90d in this store; the cutoff is now - retention,
      // computed once per sweep and shared with every hook.
      const retentionMs = 90 * 24 * 60 * 60 * 1000
      expect(cutoff.ms).toBeGreaterThanOrEqual(before - retentionMs)
      expect(cutoff.ms).toBeLessThanOrEqual(after - retentionMs)
      expect(cutoff.iso).toBe(new Date(cutoff.ms).toISOString())
    })

    it('isolates a throwing hook: the purge and other hooks still run', () => {
      const seen: string[] = []
      store.onRetentionSweep(() => {
        seen.push('first')
        throw new Error('hook bug')
      })
      store.onRetentionSweep(() => {
        seen.push('second')
      })
      store.insert(makeRecord(), '2020-01-01T00:00:00.000Z')

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        expect(() => {
          store.runRetentionSweep()
        }).not.toThrow()
      } finally {
        errorSpy.mockRestore()
      }
      expect(seen).toEqual(['first', 'second'])
      expect(store.count()).toBe(0)
    })
  })

  // -------------------------------------------------------------------------
  // List – metadata filters
  // -------------------------------------------------------------------------

  describe('list – metadata filters', () => {
    it('filters by metadata.channel_id – positive match', () => {
      const store = createStore()
      store.insert(
        makeRecord({ origin: 'openclaw', metadata: { channel_id: 'C123', sender_id: 'U1' } }),
      )
      store.insert(
        makeRecord({ origin: 'openclaw', metadata: { channel_id: 'C999', sender_id: 'U2' } }),
      )
      store.insert(makeRecord({ origin: 'mcp', metadata: null }))

      const result = store.list({ channel_id: 'C123' })
      expect(result.total).toBe(1)
      expect(result.records[0]?.metadata).toEqual({ channel_id: 'C123', sender_id: 'U1' })
    })

    it('filters by metadata.channel_id – excludes records with null metadata', () => {
      const store = createStore()
      store.insert(
        makeRecord({ origin: 'openclaw', metadata: { channel_id: 'C123', sender_id: 'U1' } }),
      )
      store.insert(makeRecord({ origin: 'mcp', metadata: null }))

      // The mcp record has no channel_id in metadata; filtering by C999 must return nothing
      const result = store.list({ channel_id: 'C999' })
      expect(result.total).toBe(0)
    })

    it('filters by metadata.sender_id', () => {
      const store = createStore()
      store.insert(
        makeRecord({ origin: 'openclaw', metadata: { channel_id: 'C1', sender_id: 'U_alice' } }),
      )
      store.insert(
        makeRecord({ origin: 'openclaw', metadata: { channel_id: 'C1', sender_id: 'U_bob' } }),
      )

      const result = store.list({ sender_id: 'U_alice' })
      expect(result.total).toBe(1)
      expect(result.records[0]?.metadata).toMatchObject({ sender_id: 'U_alice' })
    })

    it('combines channel_id and sender_id filters (AND composition)', () => {
      const store = createStore()
      const aliceId = store.insert(
        makeRecord({ origin: 'openclaw', metadata: { channel_id: 'C1', sender_id: 'U_alice' } }),
      )
      const bobId = store.insert(
        makeRecord({ origin: 'openclaw', metadata: { channel_id: 'C1', sender_id: 'U_bob' } }),
      )
      // Insert a bob record in a different channel to confirm channel filter is respected
      store.insert(
        makeRecord({ origin: 'openclaw', metadata: { channel_id: 'C2', sender_id: 'U_bob' } }),
      )

      const result = store.list({ channel_id: 'C1', sender_id: 'U_bob' })
      expect(result.total).toBe(1)
      expect(result.records[0]?.id).toBe(bobId)
      // alice's record must not appear
      expect(result.records.find((r) => r.id === aliceId)).toBeUndefined()
    })

    it('matches origin by substring (partial input narrows as you type)', () => {
      const store = createStore()
      store.insert(makeRecord({ origin: 'openclaw' }))
      store.insert(makeRecord({ origin: 'mcp' }))

      // A partial slug ("open") must match "openclaw" — substring, not exact.
      const result = store.list({ origin: 'open' })
      expect(result.total).toBe(1)
      expect(result.records[0]?.origin).toBe('openclaw')
    })

    it('matches metadata.channel_id/sender_id by substring', () => {
      const store = createStore()
      store.insert(
        makeRecord({
          origin: 'openclaw',
          metadata: { channel_id: 'C-eng-releases', sender_id: 'U-alice' },
        }),
      )
      store.insert(
        makeRecord({ origin: 'openclaw', metadata: { channel_id: 'C-ops', sender_id: 'U-bob' } }),
      )

      expect(store.list({ channel_id: 'eng' }).total).toBe(1)
      expect(store.list({ sender_id: 'alice' }).records[0]?.metadata).toMatchObject({
        sender_id: 'U-alice',
      })
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
