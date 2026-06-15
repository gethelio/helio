import Database from 'better-sqlite3'
import type { Database as DatabaseType, Statement } from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { chmodSync } from 'node:fs'
import { parseDuration } from '../config/schema.js'
import { extractResponseSummary } from '../upstream/response-summary.js'
import { clamp } from '../util/clamp.js'
import type {
  AuditRecord,
  AuditQueryFilters,
  AuditPaginationOptions,
  AuditListResult,
  AuditAggregateStats,
  AuditStoreOptions,
} from './types.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** policy_decision values that describe upstream definition changes, not tool calls. */
const DRIFT_EVENT_DECISIONS_SQL = "('tool_drift', 'tool_drift_reverted')"

// ---------------------------------------------------------------------------
// Schema DDL
// ---------------------------------------------------------------------------

const CREATE_TABLE_DDL = `
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
);
`

const CREATE_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_audit_created_at      ON audit_records (created_at);
CREATE INDEX IF NOT EXISTS idx_audit_tool_name        ON audit_records (tool_name);
CREATE INDEX IF NOT EXISTS idx_audit_policy_decision  ON audit_records (policy_decision);
CREATE INDEX IF NOT EXISTS idx_audit_session_id       ON audit_records (session_id);
CREATE INDEX IF NOT EXISTS idx_audit_block_reason     ON audit_records (block_reason);
CREATE INDEX IF NOT EXISTS idx_audit_upstream_status_created_at ON audit_records (upstream_http_status, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_record_kind     ON audit_records (record_kind);
CREATE INDEX IF NOT EXISTS idx_audit_origin          ON audit_records (origin);
`

const INSERT_SQL = `
INSERT INTO audit_records (
  id, timestamp, session_id, agent_id, environment, tool_name, tool_input,
  policy_decision, block_reason, matched_rule, matched_rule_index, evidence_chain, approval_status,
  approved_by, upstream_response, upstream_error, upstream_latency_ms,
  upstream_http_status,
  total_duration_ms, approval_wait_ms, proxy_compute_ms,
  flagged_destructive, dry_run, record_kind, origin, metadata, created_at
) VALUES (
  @id, @timestamp, @session_id, @agent_id, @environment, @tool_name, @tool_input,
  @policy_decision, @block_reason, @matched_rule, @matched_rule_index, @evidence_chain, @approval_status,
  @approved_by, @upstream_response, @upstream_error, @upstream_latency_ms,
  @upstream_http_status,
  @total_duration_ms, @approval_wait_ms, @proxy_compute_ms,
  @flagged_destructive, @dry_run, @record_kind, @origin, @metadata, @created_at
)
`

const REQUIRED_AUDIT_COLUMNS = [
  'environment',
  'block_reason',
  'matched_rule_index',
  'total_duration_ms',
  'approval_wait_ms',
  'proxy_compute_ms',
  'upstream_http_status',
  'record_kind',
  'origin',
  'metadata',
] as const

// ---------------------------------------------------------------------------
// Raw row type (what SQLite returns before deserialization)
// ---------------------------------------------------------------------------

interface RawAuditRow {
  id: string
  timestamp: string
  session_id: string | null
  agent_id: string | null
  environment: string | null
  tool_name: string
  tool_input: string
  policy_decision: string
  block_reason: string | null
  matched_rule: string | null
  matched_rule_index: number | null
  evidence_chain: string | null
  approval_status: string | null
  approved_by: string | null
  upstream_response: string | null
  upstream_error: string | null
  upstream_http_status: number | null
  upstream_latency_ms: number | null
  total_duration_ms: number
  approval_wait_ms: number
  proxy_compute_ms: number
  flagged_destructive: number
  dry_run: number
  record_kind: string
  origin: string
  metadata: string | null
  created_at: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deserializeRow(row: RawAuditRow): AuditRecord {
  return {
    id: row.id,
    timestamp: row.timestamp,
    session_id: row.session_id,
    agent_id: row.agent_id,
    environment: row.environment,
    tool_name: row.tool_name,
    tool_input: JSON.parse(row.tool_input) as Record<string, unknown>,
    policy_decision: row.policy_decision,
    block_reason: row.block_reason,
    matched_rule: row.matched_rule,
    matched_rule_index: row.matched_rule_index,
    evidence_chain: row.evidence_chain
      ? (JSON.parse(row.evidence_chain) as Record<string, unknown>)
      : null,
    approval_status: row.approval_status,
    approved_by: row.approved_by,
    upstream_response: row.upstream_response
      ? (JSON.parse(row.upstream_response) as unknown)
      : null,
    upstream_error: row.upstream_error,
    upstream_http_status: row.upstream_http_status,
    upstream_latency_ms: row.upstream_latency_ms,
    total_duration_ms: row.total_duration_ms,
    approval_wait_ms: row.approval_wait_ms,
    proxy_compute_ms: row.proxy_compute_ms,
    flagged_destructive: row.flagged_destructive === 1,
    dry_run: row.dry_run === 1,
    record_kind: row.record_kind as AuditRecord['record_kind'],
    origin: row.origin,
    metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : null,
    created_at: row.created_at,
  }
}

function buildWhereClause(filters: AuditQueryFilters): {
  clause: string
  params: unknown[]
} {
  const conditions: string[] = []
  const params: unknown[] = []

  if (filters.tool_name !== undefined) {
    conditions.push('tool_name LIKE ?')
    params.push(`%${filters.tool_name}%`)
  }
  if (filters.policy_decision !== undefined) {
    conditions.push('policy_decision = ?')
    params.push(filters.policy_decision)
  }
  if (filters.block_reason !== undefined) {
    conditions.push('block_reason = ?')
    params.push(filters.block_reason)
  }
  if (filters.blocked !== undefined) {
    conditions.push(filters.blocked ? 'block_reason IS NOT NULL' : 'block_reason IS NULL')
  }
  if (filters.record_kind !== undefined) {
    conditions.push('record_kind = ?')
    params.push(filters.record_kind)
  }
  if (filters.origin !== undefined) {
    conditions.push('origin = ?')
    params.push(filters.origin)
  }
  if (filters.channel_id !== undefined) {
    conditions.push("json_extract(metadata, '$.channel_id') = ?")
    params.push(filters.channel_id)
  }
  if (filters.sender_id !== undefined) {
    conditions.push("json_extract(metadata, '$.sender_id') = ?")
    params.push(filters.sender_id)
  }
  if (filters.session_id !== undefined) {
    conditions.push('session_id = ?')
    params.push(filters.session_id)
  }
  if (filters.agent_id !== undefined) {
    conditions.push('agent_id = ?')
    params.push(filters.agent_id)
  }
  if (filters.from !== undefined) {
    conditions.push('created_at >= ?')
    params.push(filters.from)
  }
  if (filters.to !== undefined) {
    conditions.push('created_at <= ?')
    params.push(filters.to)
  }
  if (filters.flagged_destructive !== undefined) {
    conditions.push('flagged_destructive = ?')
    params.push(filters.flagged_destructive ? 1 : 0)
  }
  if (filters.dry_run !== undefined) {
    conditions.push('dry_run = ?')
    params.push(filters.dry_run ? 1 : 0)
  }
  if (filters.upstream_status_min !== undefined) {
    conditions.push('upstream_http_status >= ?')
    params.push(filters.upstream_status_min)
  }
  if (filters.upstream_status_max !== undefined) {
    conditions.push('upstream_http_status <= ?')
    params.push(filters.upstream_status_max)
  }

  const clause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  return { clause, params }
}

/**
 * Tighten the permissions of the sqlite database file (and its WAL/SHM
 * sidecar files, if they already exist) to mode 0600. The audit DB contains
 * every governance decision the proxy has ever made — it must not be
 * readable by other local users regardless of the operator's umask.
 *
 * No-op on Windows and for the in-memory store.
 */
function restrictAuditFilePerms(dbPath: string): void {
  if (dbPath === ':memory:' || process.platform === 'win32') return
  try {
    chmodSync(dbPath, 0o600)
  } catch {
    // Best-effort: if the fs does not support POSIX perms, do not crash.
  }
  for (const suffix of ['-wal', '-shm'] as const) {
    try {
      chmodSync(dbPath + suffix, 0o600)
    } catch {
      // Sidecars are created lazily on first write; ignore ENOENT.
    }
  }
}

// ---------------------------------------------------------------------------
// AuditStore
// ---------------------------------------------------------------------------

/**
 * SQLite-backed audit record store.
 *
 * All read/write operations are synchronous (better-sqlite3 design).
 * The AuditWriter wraps this with a batching/buffering layer.
 */
export class AuditStore {
  private readonly db: DatabaseType
  private readonly insertStmt: Statement
  private readonly retentionMs: number
  private readonly includeResponses: boolean
  private cleanupTimer: ReturnType<typeof setInterval> | null = null

  constructor(options: AuditStoreOptions) {
    this.db = new Database(options.path)

    // WAL mode for better concurrent read/write performance
    this.db.pragma('journal_mode = WAL')
    // NORMAL synchronous is safe with WAL and faster than FULL
    this.db.pragma('synchronous = NORMAL')

    // Tighten before any schema writes so the main db file is never even
    // briefly world-readable.
    restrictAuditFilePerms(options.path)

    this.retentionMs = parseDuration(options.retention)
    this.includeResponses = options.includeResponses

    // Create table first, validate schema, then create indexes.
    // This preserves an explicit clean-break policy for incompatible
    // pre-1.0 local schemas.
    this.db.exec(CREATE_TABLE_DDL)
    this.assertRequiredSchema(options.path)
    this.db.exec(CREATE_INDEX_DDL)

    // Prepare the insert statement once
    this.insertStmt = this.db.prepare(INSERT_SQL)

    // Run initial cleanup. This transaction will create the WAL/SHM
    // sidecar files if they did not exist yet, so the second
    // restrictAuditFilePerms call below catches them.
    this.purgeExpired()
    restrictAuditFilePerms(options.path)

    // Schedule periodic cleanup. Also re-tightens file permissions in case
    // sqlite unlinked and recreated the WAL/SHM sidecars during a checkpoint,
    // which would otherwise let them drift back to umask defaults.
    const intervalMs = options.cleanupIntervalMs ?? 86_400_000
    if (intervalMs > 0) {
      this.cleanupTimer = setInterval(() => {
        this.purgeExpired()
        restrictAuditFilePerms(options.path)
      }, intervalMs)
      this.cleanupTimer.unref()
    }
  }

  /**
   * Validate that the on-disk audit schema contains all required canonical columns.
   *
   * This keeps the clean-break migration policy while surfacing an actionable
   * error for stale local databases instead of a low-level SQLite failure.
   */
  private assertRequiredSchema(dbPath: string): void {
    const rows = this.db.pragma('table_info(audit_records)') as Array<{ name: string }>
    const existing = new Set(rows.map((row) => row.name))
    const missing = REQUIRED_AUDIT_COLUMNS.filter((name) => !existing.has(name))
    if (missing.length === 0) return

    const quotedColumns = missing.map((name) => `"${name}"`).join(', ')
    throw new Error(
      '[helio] Audit DB schema mismatch: missing required columns ' +
        `${quotedColumns}. ` +
        `This local database was created by an older Helio build. ` +
        `Delete "${dbPath}", "${dbPath}-wal", and "${dbPath}-shm", then restart Helio.`,
    )
  }

  /**
   * Insert a single audit record. Returns the generated record ID.
   *
   * @param record - The record to insert (id and created_at are auto-generated).
   * @param createdAt - Optional override for the created_at timestamp (for testing).
   * @param id - Optional pre-generated ID (used by AuditWriter to share ID with SSE event bus).
   */
  insert(record: Omit<AuditRecord, 'id' | 'created_at'>, createdAt?: string, id?: string): string {
    const resolvedId = id ?? randomUUID()
    const now = createdAt ?? new Date().toISOString()

    this.insertStmt.run({
      id: resolvedId,
      timestamp: record.timestamp,
      session_id: record.session_id,
      agent_id: record.agent_id,
      environment: record.environment,
      tool_name: record.tool_name,
      tool_input: JSON.stringify(record.tool_input),
      policy_decision: record.policy_decision,
      block_reason: record.block_reason,
      matched_rule: record.matched_rule,
      matched_rule_index: record.matched_rule_index,
      evidence_chain: record.evidence_chain ? JSON.stringify(record.evidence_chain) : null,
      approval_status: record.approval_status,
      approved_by: record.approved_by,
      upstream_response:
        record.upstream_response != null
          ? this.includeResponses
            ? JSON.stringify(record.upstream_response)
            : JSON.stringify(extractResponseSummary(record.upstream_response))
          : null,
      upstream_error: record.upstream_error,
      upstream_http_status: record.upstream_http_status,
      upstream_latency_ms: record.upstream_latency_ms,
      total_duration_ms: record.total_duration_ms,
      approval_wait_ms: record.approval_wait_ms,
      proxy_compute_ms: record.proxy_compute_ms,
      flagged_destructive: record.flagged_destructive ? 1 : 0,
      dry_run: record.dry_run ? 1 : 0,
      record_kind: record.record_kind,
      origin: record.origin,
      metadata: record.metadata ? JSON.stringify(record.metadata) : null,
      created_at: now,
    })

    return resolvedId
  }

  /**
   * Insert multiple audit records in a single SQLite transaction.
   *
   * Significantly faster than calling `insert()` in a loop because SQLite
   * only syncs the WAL once per transaction. Records that fail to insert
   * are skipped (the error callback is invoked) without aborting the batch.
   *
   * @param records - The records to insert.
   * @param onError - Optional callback for per-record insert failures.
   * @param onPersist - Optional callback for per-record successful inserts.
   * @param ids - Optional pre-generated IDs (one per record). When provided,
   *   each ID is passed to `insert()` so the same UUID can be shared with
   *   the SSE event bus before the record is persisted.
   * @returns The number of records successfully inserted.
   */
  insertBatch(
    records: ReadonlyArray<Omit<AuditRecord, 'id' | 'created_at'>>,
    onError?: (record: Omit<AuditRecord, 'id' | 'created_at'>, err: unknown) => void,
    ids?: ReadonlyArray<string>,
    onPersist?: (record: Omit<AuditRecord, 'id' | 'created_at'>, id: string) => void,
  ): number {
    let inserted = 0
    this.db.transaction(() => {
      for (const [i, record] of records.entries()) {
        try {
          const insertedId = this.insert(record, undefined, ids?.[i])
          onPersist?.(record, insertedId)
          inserted++
        } catch (err) {
          if (onError) onError(record, err)
        }
      }
    })()
    return inserted
  }

  /** Get a single record by ID, or undefined if not found. */
  get(id: string): AuditRecord | undefined {
    const row = this.db.prepare('SELECT * FROM audit_records WHERE id = ?').get(id) as
      | RawAuditRow
      | undefined
    return row ? deserializeRow(row) : undefined
  }

  /** Query records with filters and pagination. */
  list(filters: AuditQueryFilters = {}, pagination: AuditPaginationOptions = {}): AuditListResult {
    const { clause, params } = buildWhereClause(filters)
    const limit = clamp(pagination.limit ?? 50, 1, 1000)
    const offset = Math.max(pagination.offset ?? 0, 0)
    const order = pagination.order === 'asc' ? 'ASC' : 'DESC'

    const { total } = this.db
      .prepare(`SELECT COUNT(*) as total FROM audit_records ${clause}`)
      .get(...params) as { total: number }

    const rows = this.db
      .prepare(
        `SELECT * FROM audit_records ${clause} ORDER BY created_at ${order} LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as RawAuditRow[]

    return {
      records: rows.map(deserializeRow),
      total,
      limit,
      offset,
    }
  }

  /** Count records matching the given filters. */
  count(filters: AuditQueryFilters = {}): number {
    const { clause, params } = buildWhereClause(filters)
    const result = this.db
      .prepare(`SELECT COUNT(*) as total FROM audit_records ${clause}`)
      .get(...params) as { total: number }
    return result.total
  }

  /** Get aggregate statistics for a time range. */
  aggregate(from?: string, to?: string): AuditAggregateStats {
    const rangeFilters: AuditQueryFilters = { from, to }
    const { clause, params } = buildWhereClause(rangeFilters)

    const totals = this.db
      .prepare(
        `SELECT
           COUNT(*) as total,
           COALESCE(SUM(CASE WHEN block_reason IS NULL AND policy_decision NOT IN ${DRIFT_EVENT_DECISIONS_SQL} THEN 1 ELSE 0 END), 0) as allowed_total,
           COALESCE(SUM(CASE WHEN block_reason IS NOT NULL THEN 1 ELSE 0 END), 0) as blocked_total,
           COALESCE(SUM(CASE WHEN dry_run = 1 THEN 1 ELSE 0 END), 0) as dry_run_total,
           COALESCE(SUM(CASE WHEN dry_run = 0 THEN 1 ELSE 0 END), 0) as applied_total
         FROM audit_records ${clause}`,
      )
      .get(...params) as {
      total: number
      allowed_total: number
      blocked_total: number
      dry_run_total: number
      applied_total: number
    }

    // By decision
    const by_decision = this.db
      .prepare(
        `SELECT policy_decision as decision, COUNT(*) as count
         FROM audit_records ${clause}
         GROUP BY policy_decision
         ORDER BY count DESC`,
      )
      .all(...params) as Array<{ decision: string; count: number }>

    const blockedClause = clause
      ? `${clause} AND block_reason IS NOT NULL`
      : 'WHERE block_reason IS NOT NULL'
    const by_block_reason = this.db
      .prepare(
        `SELECT block_reason as reason, COUNT(*) as count
         FROM audit_records ${blockedClause}
         GROUP BY block_reason
         ORDER BY count DESC`,
      )
      .all(...params) as Array<{ reason: string; count: number }>

    // Top tools (limit 10) — drift events are excluded: they describe definition
    // changes, not tool calls, and would inflate tool-usage rankings.
    const toolsClause = clause
      ? `${clause} AND policy_decision NOT IN ${DRIFT_EVENT_DECISIONS_SQL}`
      : `WHERE policy_decision NOT IN ${DRIFT_EVENT_DECISIONS_SQL}`
    const top_tools = this.db
      .prepare(
        `SELECT tool_name, COUNT(*) as count
         FROM audit_records ${toolsClause}
         GROUP BY tool_name
         ORDER BY count DESC
         LIMIT 10`,
      )
      .all(...params) as Array<{ tool_name: string; count: number }>

    // Approval rate
    const approvalFilters: AuditQueryFilters = {
      ...rangeFilters,
      policy_decision: 'require_approval',
    }
    const { clause: approvalClause, params: approvalParams } = buildWhereClause(approvalFilters)
    const approvalResult = this.db
      .prepare(
        `SELECT
           COUNT(CASE WHEN approval_status = 'approved' THEN 1 END) as approved,
           COUNT(*) as total_approval
         FROM audit_records ${approvalClause}`,
      )
      .get(...approvalParams) as { approved: number; total_approval: number }
    const approval_rate =
      approvalResult.total_approval > 0
        ? approvalResult.approved / approvalResult.total_approval
        : null

    // Per hour buckets
    const per_hour = this.db
      .prepare(
        `SELECT
           strftime('%Y-%m-%dT%H:00:00Z', created_at) as bucket,
           COUNT(*) as count
         FROM audit_records ${clause}
         GROUP BY bucket
         ORDER BY bucket ASC`,
      )
      .all(...params) as Array<{ bucket: string; count: number }>

    return {
      total: totals.total,
      allowed_total: totals.allowed_total,
      blocked_total: totals.blocked_total,
      dry_run_total: totals.dry_run_total,
      applied_total: totals.applied_total,
      by_decision,
      by_block_reason,
      top_tools,
      approval_rate,
      per_hour,
    }
  }

  /** Delete records older than the retention period. Returns the count of deleted records. */
  purgeExpired(): number {
    const cutoff = new Date(Date.now() - this.retentionMs).toISOString()
    const result = this.db.prepare('DELETE FROM audit_records WHERE created_at < ?').run(cutoff)
    return result.changes
  }

  /** Close the database and stop the cleanup timer. */
  close(): void {
    if (this.cleanupTimer !== null) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
    this.db.close()
  }
}
