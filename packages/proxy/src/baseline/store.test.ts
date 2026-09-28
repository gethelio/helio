import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import type { Database as DatabaseType } from 'better-sqlite3'
import { ToolBaselineStore } from './store.js'
import { AuditStore } from '../audit/store.js'
import { BudgetLedger } from '../budget/ledger.js'
import { StartupError } from '../startup-error.js'
import { canonicalize } from '../util/canonical-json.js'
import { auditBackedDb } from '../__tests__/helpers/audit-backed-db.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const GET_STATUS = {
  name: 'get_status',
  description: 'Report the current server status',
  annotations: { readOnlyHint: true, destructiveHint: false },
}
const DELETE_RECORD = {
  name: 'delete_record',
  description: 'Delete a record',
  annotations: { destructiveHint: true },
}

function row(definition: Record<string, unknown>) {
  return { tool: definition['name'] as string, definition, fingerprint: canonicalize(definition) }
}

const SEEN_AT = '2026-09-28T10:00:00.000Z'
const CONFIRMED_AT = '2026-09-28T11:00:00.000Z'
const ACCEPTED_AT = '2026-09-28T12:00:00.000Z'

function columns(db: DatabaseType, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name)
}

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fileDb(): { path: string; db: DatabaseType } {
  const dir = mkdtempSync(join(tmpdir(), 'helio-baseline-store-'))
  tempDirs.push(dir)
  const path = join(dir, 'helio-audit.db')
  return { path, db: new Database(path) }
}

function openAudit(path: string): AuditStore {
  return new AuditStore({ path, retention: '90d', includeResponses: true, cleanupIntervalMs: 0 })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ToolBaselineStore', () => {
  it('creates the tool_baselines table on the audit handle and is idempotent on a second open', () => {
    const { path, db } = fileDb()
    db.close()
    const first = openAudit(path)
    const store = new ToolBaselineStore({ database: first.database })
    store.insertNew(undefined, [row(GET_STATUS)], SEEN_AT)
    first.close()

    const second = openAudit(path)
    const reopened = new ToolBaselineStore({ database: second.database })
    expect(columns(second.database, 'tool_baselines')).toEqual([
      'upstream',
      'tool',
      'fingerprint',
      'definition_json',
      'first_seen',
      'last_confirmed',
      'accepted_at',
      'accepted_by',
    ])
    expect(reopened.load(undefined).map((r) => r.tool)).toEqual(['get_status'])
    second.close()
  })

  it('stores the singular door as an empty-string sentinel that the primary key enforces', () => {
    const db = auditBackedDb()
    const store = new ToolBaselineStore({ database: db })
    store.insertNew(undefined, [row(GET_STATUS)], SEEN_AT)
    expect(() =>
      db
        .prepare(
          `INSERT INTO tool_baselines (upstream, tool, fingerprint, definition_json, first_seen, last_confirmed)
           VALUES ('', 'get_status', 'x', '{}', ?, ?)`,
        )
        .run(SEEN_AT, SEEN_AT),
    ).toThrow(/UNIQUE|PRIMARY KEY/)
    const raw = db.prepare('SELECT upstream FROM tool_baselines').all() as { upstream: string }[]
    expect(raw).toEqual([{ upstream: '' }])
  })

  it('load maps the sentinel to null and parses the definition back to its fingerprint', () => {
    const db = auditBackedDb()
    const store = new ToolBaselineStore({ database: db })
    store.insertNew(undefined, [row(GET_STATUS)], SEEN_AT)
    store.insertNew('github', [row(DELETE_RECORD)], CONFIRMED_AT)

    const singular = store.load(undefined)
    expect(singular).toEqual([
      {
        upstream: null,
        tool: 'get_status',
        definition: GET_STATUS,
        fingerprint: canonicalize(GET_STATUS),
        first_seen: SEEN_AT,
        last_confirmed: SEEN_AT,
        accepted_at: null,
        accepted_by: null,
      },
    ])
    const [only] = singular
    expect(only && canonicalize(only.definition)).toBe(only?.fingerprint)

    const named = store.load('github')
    expect(named.map((r) => [r.upstream, r.tool])).toEqual([['github', 'delete_record']])
    expect(store.load('files')).toEqual([])
  })

  it('insertNew never overwrites an existing row and reports how many it inserted', () => {
    const db = auditBackedDb()
    const store = new ToolBaselineStore({ database: db })
    store.insertNew(undefined, [row(GET_STATUS)], SEEN_AT)

    const changed = { ...GET_STATUS, description: 'changed' }
    const inserted = store.insertNew(undefined, [row(changed), row(DELETE_RECORD)], CONFIRMED_AT)
    expect(inserted).toBe(1)
    const rows = store.load(undefined)
    expect(rows.map((r) => [r.tool, r.first_seen])).toEqual([
      ['delete_record', CONFIRMED_AT],
      ['get_status', SEEN_AT],
    ])
    expect(rows.find((r) => r.tool === 'get_status')?.definition).toEqual(GET_STATUS)
  })

  it('confirm moves last_confirmed only, for the named tools of one door', () => {
    const db = auditBackedDb()
    const store = new ToolBaselineStore({ database: db })
    store.insertNew(undefined, [row(GET_STATUS), row(DELETE_RECORD)], SEEN_AT)
    store.insertNew('github', [row(GET_STATUS)], SEEN_AT)

    store.confirm(undefined, ['get_status'], CONFIRMED_AT)

    const singular = store.load(undefined)
    expect(singular.map((r) => [r.tool, r.first_seen, r.last_confirmed])).toEqual([
      ['delete_record', SEEN_AT, SEEN_AT],
      ['get_status', SEEN_AT, CONFIRMED_AT],
    ])
    expect(store.load('github')[0]?.last_confirmed).toBe(SEEN_AT)
  })

  it('replace keeps first_seen, sets the acceptance columns and returns the previous fingerprint', () => {
    const db = auditBackedDb()
    const store = new ToolBaselineStore({ database: db })
    store.insertNew(undefined, [row(GET_STATUS)], SEEN_AT)
    const changed = { ...GET_STATUS, description: 'changed' }

    const previous = store.replace(undefined, 'get_status', {
      definition: changed,
      fingerprint: canonicalize(changed),
      acceptedBy: 'oli',
      at: ACCEPTED_AT,
    })

    expect(previous).toBe(canonicalize(GET_STATUS))
    expect(store.load(undefined)).toEqual([
      {
        upstream: null,
        tool: 'get_status',
        definition: changed,
        fingerprint: canonicalize(changed),
        first_seen: SEEN_AT,
        last_confirmed: ACCEPTED_AT,
        accepted_at: ACCEPTED_AT,
        accepted_by: 'oli',
      },
    ])
  })

  it('replace on a tool with no row inserts it and returns undefined', () => {
    const db = auditBackedDb()
    const store = new ToolBaselineStore({ database: db })
    const previous = store.replace('github', 'get_status', {
      definition: GET_STATUS,
      fingerprint: canonicalize(GET_STATUS),
      acceptedBy: 'api',
      at: ACCEPTED_AT,
    })
    expect(previous).toBeUndefined()
    const [only] = store.load('github')
    expect(only?.first_seen).toBe(ACCEPTED_AT)
    expect(only?.accepted_by).toBe('api')
  })

  it('refuses the boot on a missing column, naming the table only', () => {
    const { path, db } = fileDb()
    db.exec(`CREATE TABLE tool_baselines (
      upstream TEXT NOT NULL DEFAULT '',
      tool TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      PRIMARY KEY (upstream, tool)
    )`)
    let error: unknown
    try {
      new ToolBaselineStore({ database: db })
    } catch (err) {
      error = err
    }
    expect(error).toBeInstanceOf(StartupError)
    const message = (error as Error).message
    expect(message).toBe(
      `[helio] Tool baselines schema mismatch in ${path}: tool_baselines.definition_json (missing), ` +
        'tool_baselines.first_seen (missing), tool_baselines.last_confirmed (missing), ' +
        'tool_baselines.accepted_at (missing), tool_baselines.accepted_by (missing). ' +
        'This table was created by a different Helio build. ' +
        `Drop it (sqlite3 ${path} 'DROP TABLE tool_baselines'; every tool re-baselines at the next start) ` +
        'or run the build that created it; audit records and budget ledger rows are untouched.',
    )
    expect(message).not.toMatch(/Delete/)
    // The table is left exactly as found: never dropped or recreated.
    expect(columns(db, 'tool_baselines')).toEqual(['upstream', 'tool', 'fingerprint'])
    db.close()
  })

  it('refuses the boot on a retyped column', () => {
    const { db } = fileDb()
    db.exec(`CREATE TABLE tool_baselines (
      upstream TEXT NOT NULL DEFAULT '',
      tool TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      definition_json BLOB NOT NULL,
      first_seen TEXT NOT NULL,
      last_confirmed TEXT NOT NULL,
      accepted_at TEXT,
      accepted_by TEXT,
      PRIMARY KEY (upstream, tool)
    )`)
    expect(() => new ToolBaselineStore({ database: db })).toThrow(
      /tool_baselines\.definition_json \(found "BLOB NOT NULL", expected "TEXT NOT NULL"\)/,
    )
    db.close()
  })

  it('tolerates an extra column', () => {
    const { db } = fileDb()
    db.exec(`CREATE TABLE tool_baselines (
      upstream TEXT NOT NULL DEFAULT '',
      tool TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      definition_json TEXT NOT NULL,
      first_seen TEXT NOT NULL,
      last_confirmed TEXT NOT NULL,
      accepted_at TEXT,
      accepted_by TEXT,
      future_column TEXT,
      PRIMARY KEY (upstream, tool)
    )`)
    const store = new ToolBaselineStore({ database: db })
    store.insertNew(undefined, [row(GET_STATUS)], SEEN_AT)
    expect(store.load(undefined).map((r) => r.tool)).toEqual(['get_status'])
    db.close()
  })

  it('is untouched by the audit retention sweep', () => {
    const audit = new AuditStore({
      path: ':memory:',
      retention: '1s',
      includeResponses: true,
      cleanupIntervalMs: 0,
    })
    const store = new ToolBaselineStore({ database: audit.database })
    store.insertNew(undefined, [row(GET_STATUS)], '2020-01-01T00:00:00.000Z')
    audit.runRetentionSweep()
    expect(store.load(undefined).map((r) => r.tool)).toEqual(['get_status'])
    audit.close()
  })
})

// ---------------------------------------------------------------------------
// Migration from a v0.14.0 database
// ---------------------------------------------------------------------------

/**
 * The audit and budget ledger DDL of the v0.14.0 tag, verbatim: the fixture
 * is BUILT from it, never copied from a real file. v0.14.0 had no
 * tool_baselines table, so opening such a file with the current build is
 * the additive migration this table claims.
 */
const V0_14_0_DDL = `
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
  created_at        TEXT NOT NULL,
  upstream          TEXT,
  config_sha256     TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_created_at      ON audit_records (created_at);
CREATE INDEX IF NOT EXISTS idx_audit_tool_name        ON audit_records (tool_name);
CREATE INDEX IF NOT EXISTS idx_audit_policy_decision  ON audit_records (policy_decision);
CREATE INDEX IF NOT EXISTS idx_audit_session_id       ON audit_records (session_id);
CREATE INDEX IF NOT EXISTS idx_audit_block_reason     ON audit_records (block_reason);
CREATE INDEX IF NOT EXISTS idx_audit_upstream_status_created_at ON audit_records (upstream_http_status, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_record_kind     ON audit_records (record_kind);
CREATE INDEX IF NOT EXISTS idx_audit_origin          ON audit_records (origin);
CREATE INDEX IF NOT EXISTS idx_audit_upstream        ON audit_records (upstream);
CREATE INDEX IF NOT EXISTS idx_audit_config_sha256   ON audit_records (config_sha256);

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
CREATE INDEX IF NOT EXISTS idx_budget_events_replay
  ON budget_events (budget_name, epoch, bucket_key, timestamp_ms);
CREATE INDEX IF NOT EXISTS idx_budget_events_timestamp_ms
  ON budget_events (timestamp_ms);
`

describe('ToolBaselineStore on a v0.14.0 database', () => {
  function seedV014(path: string): void {
    const db = new Database(path)
    db.exec(V0_14_0_DDL)
    const now = new Date().toISOString()
    const insertAudit = db.prepare(`
      INSERT INTO audit_records (
        id, timestamp, tool_name, tool_input, policy_decision, total_duration_ms,
        proxy_compute_ms, created_at, upstream, config_sha256
      ) VALUES (?, ?, ?, '{}', ?, 1, 1, ?, ?, ?)`)
    insertAudit.run('a1', now, 'get_status', 'allow', now, null, 'abc')
    insertAudit.run('a2', now, 'send_email', 'tool_drift', now, 'mail', 'abc')
    insertAudit.run('a3', now, 'send_email', 'deny', now, 'mail', 'abc')
    db.prepare(
      `INSERT INTO budget_meta (budget_name, limit_amount, currency, window, key, epoch, updated_at)
       VALUES ('daily', 100, 'USD', '24h', 'global', 1, ?)`,
    ).run(now)
    db.prepare(
      `INSERT INTO budget_events (id, budget_name, epoch, bucket_key, kind, amount, currency, tool_name,
        origin, audit_record_id, timestamp, timestamp_ms, created_at)
       VALUES ('e1', 'daily', 1, 'budget:daily:global', 'spend', 25, 'USD', 'stripe_charge', 'mcp', 'a1', ?, ?, ?)`,
    ).run(now, Date.now(), now)
    db.close()
  }

  function count(db: DatabaseType, table: string): number {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
  }

  it('adds the table additively and keeps every audit and ledger row', () => {
    const { path, db } = fileDb()
    db.close()
    seedV014(path)

    // First open with the current build: the audit store, the ledger and
    // the baseline store all open the same file, in production order.
    const audit = openAudit(path)
    const ledger = new BudgetLedger({ database: audit.database })
    const baselines = new ToolBaselineStore({ database: audit.database })
    expect(count(audit.database, 'audit_records')).toBe(3)
    expect(count(audit.database, 'budget_events')).toBe(1)
    expect(count(audit.database, 'budget_meta')).toBe(1)
    expect(ledger.readMeta('daily')?.epoch).toBe(1)
    expect(baselines.load(undefined)).toEqual([])
    baselines.insertNew('mail', [row(GET_STATUS)], SEEN_AT)
    audit.close()

    // Reopen: everything survives, the baseline included.
    const again = openAudit(path)
    new BudgetLedger({ database: again.database })
    const reopened = new ToolBaselineStore({ database: again.database })
    expect(count(again.database, 'audit_records')).toBe(3)
    expect(count(again.database, 'budget_events')).toBe(1)
    expect(count(again.database, 'budget_meta')).toBe(1)
    expect(reopened.load('mail').map((r) => [r.tool, r.first_seen])).toEqual([
      ['get_status', SEEN_AT],
    ])
    // The audit table's own columns are untouched: the v0.14.0 set, in order.
    expect(columns(again.database, 'audit_records').slice(-2)).toEqual([
      'upstream',
      'config_sha256',
    ])
    expect(columns(again.database, 'audit_records')).toHaveLength(31)
    again.close()
  })

  it('under persist_baselines: false the file keeps the v0.14.0 table set', () => {
    const { path, db } = fileDb()
    db.close()
    seedV014(path)
    // What `helio start` does under `false`: the store is never constructed.
    const audit = openAudit(path)
    new BudgetLedger({ database: audit.database })
    const tables = (
      audit.database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as { name: string }[]
    ).map((t) => t.name)
    expect(tables).toEqual(['audit_records', 'budget_bucket_gc', 'budget_events', 'budget_meta'])
    audit.close()
  })
})
