// ---------------------------------------------------------------------------
// ToolBaselineStore: SQLite persistence for tool definition baselines
// (issue #60).
//
// Owns the tool_baselines table inside the EXISTING audit database on the
// AuditStore's open handle (the BudgetLedger precedent): one connection, one
// WAL domain, one file-permission hardening pass. A baseline is keyed state,
// one row per door and tool, replaced only by an operator's acceptance; the
// retention sweep never touches it.
//
// Storage detail: the singular door is stored as '' because SQLite treats
// NULLs in a non-INTEGER primary key as distinct, so a nullable `upstream`
// would not enforce (upstream, tool). Every read surface maps '' back to
// null; configured upstream names cannot be empty, so the sentinel cannot
// collide with a real door.
// ---------------------------------------------------------------------------

import Database from 'better-sqlite3'
import type { Database as DatabaseType, Statement } from 'better-sqlite3'
import { StartupError } from '../startup-error.js'

// ---------------------------------------------------------------------------
// Schema DDL
// ---------------------------------------------------------------------------

const CREATE_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS tool_baselines (
  upstream        TEXT NOT NULL DEFAULT '',
  tool            TEXT NOT NULL,
  fingerprint     TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  first_seen      TEXT NOT NULL,
  last_confirmed  TEXT NOT NULL,
  accepted_at     TEXT,
  accepted_by     TEXT,
  PRIMARY KEY (upstream, tool)
);
`

const TABLE = 'tool_baselines'

/** The `pragma table_info` row shape used by the schema assertion. */
interface ColumnInfo {
  readonly name: string
  readonly type: string
  readonly notnull: number
  readonly pk: number
}

function describeColumn(column: ColumnInfo): string {
  return `"${column.type}${column.notnull ? ' NOT NULL' : ''}${column.pk ? ' PRIMARY KEY' : ''}"`
}

const INSERT_NEW_SQL = `
INSERT INTO tool_baselines (upstream, tool, fingerprint, definition_json, first_seen, last_confirmed)
VALUES (@upstream, @tool, @fingerprint, @definition_json, @at, @at)
ON CONFLICT (upstream, tool) DO NOTHING
`

const CONFIRM_SQL = `
UPDATE tool_baselines SET last_confirmed = @at WHERE upstream = @upstream AND tool = @tool
`

const REPLACE_SQL = `
INSERT INTO tool_baselines (
  upstream, tool, fingerprint, definition_json, first_seen, last_confirmed, accepted_at, accepted_by
) VALUES (
  @upstream, @tool, @fingerprint, @definition_json, @at, @at, @at, @accepted_by
)
ON CONFLICT (upstream, tool) DO UPDATE SET
  fingerprint = excluded.fingerprint,
  definition_json = excluded.definition_json,
  last_confirmed = excluded.last_confirmed,
  accepted_at = excluded.accepted_at,
  accepted_by = excluded.accepted_by
`

const LOAD_SQL = `
SELECT upstream, tool, fingerprint, definition_json, first_seen, last_confirmed, accepted_at, accepted_by
FROM tool_baselines WHERE upstream = ? ORDER BY tool
`

const FINGERPRINT_SQL = 'SELECT fingerprint FROM tool_baselines WHERE upstream = ? AND tool = ?'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One persisted baseline as the door reads it back at boot. */
export interface ToolBaselineRow {
  /** The configured upstream name, or null on a singular door. */
  readonly upstream: string | null
  readonly tool: string
  /** The parsed tool definition the fingerprint was computed from. */
  readonly definition: Record<string, unknown>
  readonly fingerprint: string
  readonly first_seen: string
  readonly last_confirmed: string
  readonly accepted_at: string | null
  readonly accepted_by: string | null
}

/** A baseline to insert on first sight. */
export interface NewToolBaseline {
  readonly tool: string
  readonly definition: Record<string, unknown>
  readonly fingerprint: string
}

/** The replacement an operator's acceptance writes. */
export interface ToolBaselineReplacement {
  readonly definition: Record<string, unknown>
  readonly fingerprint: string
  readonly acceptedBy: string
  readonly at: string
}

/**
 * What the governed forwarder needs from a baseline store, so the policy
 * layer never imports SQLite. `upstream` is the configured upstream name, or
 * undefined on a singular door. Every method is synchronous.
 */
export interface BaselinePersistence {
  /** The door's persisted baselines, ordered by tool name. */
  load(upstream: string | undefined): readonly ToolBaselineRow[]
  /**
   * Insert baselines for tools seen for the first time, in ONE transaction
   * (all or nothing). An existing row is never overwritten. Returns the
   * number of rows inserted.
   */
  insertNew(upstream: string | undefined, rows: readonly NewToolBaseline[], at: string): number
  /** Move `last_confirmed` for tools whose live definition matched the baseline. */
  confirm(upstream: string | undefined, tools: readonly string[], at: string): void
  /**
   * Replace a baseline with an accepted definition, keeping `first_seen`.
   * Returns the previous fingerprint, or undefined when no row existed.
   */
  replace(
    upstream: string | undefined,
    tool: string,
    replacement: ToolBaselineReplacement,
  ): string | undefined
}

export interface ToolBaselineStoreOptions {
  /** The audit store's open database handle (AuditStore.database). */
  readonly database: DatabaseType
}

interface RawRow {
  readonly upstream: string
  readonly tool: string
  readonly fingerprint: string
  readonly definition_json: string
  readonly first_seen: string
  readonly last_confirmed: string
  readonly accepted_at: string | null
  readonly accepted_by: string | null
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** Map the door name to its storage key: '' for the singular door. */
function storageKey(upstream: string | undefined): string {
  return upstream ?? ''
}

/** Persists tool definition baselines in the audit database. */
export class ToolBaselineStore implements BaselinePersistence {
  private readonly db: DatabaseType
  private readonly loadStmt: Statement
  private readonly fingerprintStmt: Statement
  private readonly insertNewTxn: (
    upstream: string,
    rows: readonly NewToolBaseline[],
    at: string,
  ) => number
  private readonly confirmTxn: (upstream: string, tools: readonly string[], at: string) => void
  private readonly replaceTxn: (
    upstream: string,
    tool: string,
    replacement: ToolBaselineReplacement,
  ) => string | undefined

  constructor(options: ToolBaselineStoreOptions) {
    this.db = options.database
    this.db.exec(CREATE_TABLE_DDL)
    this.assertRequiredSchema()

    this.loadStmt = this.db.prepare(LOAD_SQL)
    this.fingerprintStmt = this.db.prepare(FINGERPRINT_SQL)
    const insertStmt = this.db.prepare(INSERT_NEW_SQL)
    const confirmStmt = this.db.prepare(CONFIRM_SQL)
    const replaceStmt = this.db.prepare(REPLACE_SQL)

    this.insertNewTxn = this.db.transaction(
      (upstream: string, rows: readonly NewToolBaseline[], at: string) => {
        let inserted = 0
        for (const row of rows) {
          inserted += insertStmt.run({
            upstream,
            tool: row.tool,
            fingerprint: row.fingerprint,
            definition_json: JSON.stringify(row.definition),
            at,
          }).changes
        }
        return inserted
      },
    )
    this.confirmTxn = this.db.transaction(
      (upstream: string, tools: readonly string[], at: string) => {
        for (const tool of tools) confirmStmt.run({ upstream, tool, at })
      },
    )
    this.replaceTxn = this.db.transaction(
      (upstream: string, tool: string, replacement: ToolBaselineReplacement) => {
        const previous = this.fingerprintStmt.get(upstream, tool) as
          | { fingerprint: string }
          | undefined
        replaceStmt.run({
          upstream,
          tool,
          fingerprint: replacement.fingerprint,
          definition_json: JSON.stringify(replacement.definition),
          at: replacement.at,
          accepted_by: replacement.acceptedBy,
        })
        return previous?.fingerprint
      },
    )
  }

  /**
   * Validate the on-disk table against the canonical DDL executed in a
   * scratch database: names, declared types, NOT NULL and PRIMARY KEY must
   * match; extra columns are tolerated. On a mismatch the boot is refused
   * and the table is left exactly as found. Dropping or recreating it here
   * would re-baseline every tool at the next prime, which is the laundering
   * persistence exists to stop; the operator drops it knowingly instead.
   */
  private assertRequiredSchema(): void {
    const canonical = new Database(':memory:')
    const mismatches: string[] = []
    try {
      canonical.exec(CREATE_TABLE_DDL)
      const expected = canonical.pragma(`table_info(${TABLE})`) as ColumnInfo[]
      const live = new Map(
        (this.db.pragma(`table_info(${TABLE})`) as ColumnInfo[]).map((col) => [col.name, col]),
      )
      for (const column of expected) {
        const actual = live.get(column.name)
        if (!actual) {
          mismatches.push(`${TABLE}.${column.name} (missing)`)
          continue
        }
        if (
          actual.type !== column.type ||
          actual.notnull !== column.notnull ||
          actual.pk !== column.pk
        ) {
          mismatches.push(
            `${TABLE}.${column.name} (found ${describeColumn(actual)}, ` +
              `expected ${describeColumn(column)})`,
          )
        }
      }
    } finally {
      canonical.close()
    }
    if (mismatches.length === 0) return

    const dbPath = this.db.name
    throw new StartupError(
      `[helio] Tool baselines schema mismatch in ${dbPath}: ${mismatches.join(', ')}. ` +
        'This table was created by a different Helio build. ' +
        `Drop it (sqlite3 ${dbPath} 'DROP TABLE ${TABLE}'; every tool re-baselines at the next start) ` +
        'or run the build that created it; audit records and budget ledger rows are untouched.',
    )
  }

  // -------------------------------------------------------------------------
  // BaselinePersistence
  // -------------------------------------------------------------------------

  load(upstream: string | undefined): readonly ToolBaselineRow[] {
    const rows = this.loadStmt.all(storageKey(upstream)) as RawRow[]
    return rows.map((row) => ({
      upstream: row.upstream === '' ? null : row.upstream,
      tool: row.tool,
      definition: JSON.parse(row.definition_json) as Record<string, unknown>,
      fingerprint: row.fingerprint,
      first_seen: row.first_seen,
      last_confirmed: row.last_confirmed,
      accepted_at: row.accepted_at,
      accepted_by: row.accepted_by,
    }))
  }

  insertNew(upstream: string | undefined, rows: readonly NewToolBaseline[], at: string): number {
    if (rows.length === 0) return 0
    return this.insertNewTxn(storageKey(upstream), rows, at)
  }

  confirm(upstream: string | undefined, tools: readonly string[], at: string): void {
    if (tools.length === 0) return
    this.confirmTxn(storageKey(upstream), tools, at)
  }

  replace(
    upstream: string | undefined,
    tool: string,
    replacement: ToolBaselineReplacement,
  ): string | undefined {
    return this.replaceTxn(storageKey(upstream), tool, replacement)
  }
}
