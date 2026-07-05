// ---------------------------------------------------------------------------
// Audit record types — the canonical shape of every audit log entry.
// ---------------------------------------------------------------------------

/** A single audit log entry recording a tool call and its governance outcome. */
export interface AuditRecord {
  /** Unique record identifier (UUID v4). */
  readonly id: string
  /** ISO 8601 timestamp of when the tool call was received by the proxy. */
  readonly timestamp: string
  /** MCP session ID from the Mcp-Session-Id header, if present. */
  readonly session_id: string | null
  /** Agent identifier from config or request header, if present. */
  readonly agent_id: string | null
  /** Runtime environment label configured on proxy startup, if set. */
  readonly environment: string | null
  /** The name of the tool that was called. */
  readonly tool_name: string
  /** The arguments passed to the tool call. */
  readonly tool_input: Record<string, unknown>
  /** The policy engine's decision: allow, deny, require_approval, etc. */
  readonly policy_decision: string
  /** Structured block reason (when blocked), e.g. evidence_expired. */
  readonly block_reason: string | null
  /** Name of the policy rule that matched, if any. */
  readonly matched_rule: string | null
  /** Index of the matched rule in config order, if any. */
  readonly matched_rule_index: number | null
  /** Evidence context from the evidence grounding system. */
  readonly evidence_chain: Record<string, unknown> | null
  /** Approval workflow status: pending, approved, denied, timeout. */
  readonly approval_status: string | null
  /** Identity of the approver, if approval was granted. */
  readonly approved_by: string | null
  /**
   * Upstream MCP server response. When `audit.include_responses` is true,
   * this is the full JSON-RPC response body. When false, a {@link ResponseSummary}
   * with only success/error status and content types. Null for denied calls
   * (no upstream request was made).
   */
  readonly upstream_response: unknown
  /** Error message from upstream, if the call failed. */
  readonly upstream_error: string | null
  /** HTTP status code returned by upstream, if a response was received. */
  readonly upstream_http_status: number | null
  /** Time in milliseconds the upstream request took. */
  readonly upstream_latency_ms: number | null
  /** End-to-end time from request receipt to final response. */
  readonly total_duration_ms: number
  /** Time spent waiting in the approval queue, if applicable. */
  readonly approval_wait_ms: number
  /** Proxy compute time excluding approval waits and upstream processing. */
  readonly proxy_compute_ms: number
  /** Whether the tool was flagged as potentially destructive (destructiveHint). */
  readonly flagged_destructive: boolean
  /** Whether this record was produced in dry-run mode. */
  readonly dry_run: boolean
  /**
   * Record category discriminator (issues #12/#16). `'tool_call'` is the
   * default for governed tool calls; `'drift_event'` for tool-definition drift
   * records; `'install_scan'` for sideband install evaluations; and
   * `'evaluation_expired'` for sideband evaluations whose `/audit` never
   * arrived (the bypass/tamper signal — block_reason stays null so they do not
   * count as enforcement blocks).
   */
  readonly record_kind: 'tool_call' | 'drift_event' | 'install_scan' | 'evaluation_expired'
  /**
   * Enforcement origin: `'mcp'` for the proxy path, or an adapter-supplied
   * origin string (e.g. `'openclaw'`) for sideband-governed calls. Surfaces
   * the enforcement-grade ladder (structural vs host-enforced) per record.
   */
  readonly origin: string
  /**
   * Adapter-supplied context object (reserved keys: `channel_id`, `sender_id`,
   * `sender_name`, `conversation_id`). Null for MCP-origin records. Backs
   * `match.metadata.*` (#13) and the dashboard metadata columns (#16).
   */
  readonly metadata: Record<string, unknown> | null
  /** ISO 8601 timestamp of when the record was persisted. */
  readonly created_at: string
}

// ---------------------------------------------------------------------------
// Query types for the dashboard API.
// ---------------------------------------------------------------------------

/** Fields available for filtering audit record queries. */
export interface AuditQueryFilters {
  /** Filter by tool name (exact match). */
  readonly tool_name?: string
  /** Filter by policy decision (exact match). */
  readonly policy_decision?: string
  /** Filter by block reason (exact match). */
  readonly block_reason?: string
  /** Filter by whether a call was blocked (block_reason non-null). */
  readonly blocked?: boolean
  /** Filter by session ID (exact match). */
  readonly session_id?: string
  /** Filter by agent ID (exact match). */
  readonly agent_id?: string
  /** Include only records created at or after this ISO 8601 timestamp. */
  readonly from?: string
  /** Include only records created at or before this ISO 8601 timestamp. */
  readonly to?: string
  /** Include only records flagged as destructive (true) or not (false). */
  readonly flagged_destructive?: boolean
  /** Include only dry-run records (true) or non-dry-run records (false). */
  readonly dry_run?: boolean
  /** Filter by record kind (tool_call / drift_event / install_scan / evaluation_expired). */
  readonly record_kind?: string
  /** Filter by enforcement origin (e.g. 'mcp', 'openclaw'). */
  readonly origin?: string
  /** Filter by metadata.channel_id (adapter-supplied; JSON-extracted, substring match). */
  readonly channel_id?: string
  /** Filter by metadata.sender_id (adapter-supplied; JSON-extracted, substring match). */
  readonly sender_id?: string
  /** Include only records where upstream HTTP status is >= this value. */
  readonly upstream_status_min?: number
  /** Include only records where upstream HTTP status is <= this value. */
  readonly upstream_status_max?: number
}

/** Pagination options for list queries. */
export interface AuditPaginationOptions {
  /** Maximum number of records to return (default: 50, max: 1,000 — `LIST_MAX_PAGE_SIZE`). */
  readonly limit?: number
  /** Number of records to skip (default: 0). */
  readonly offset?: number
  /** Sort order by created_at (default: 'desc'). */
  readonly order?: 'asc' | 'desc'
}

/** Paginated result set from a list query. */
export interface AuditListResult {
  readonly records: readonly AuditRecord[]
  readonly total: number
  readonly limit: number
  readonly offset: number
}

// ---------------------------------------------------------------------------
// Aggregate types — for dashboard analytics.
// ---------------------------------------------------------------------------

/** Time-bucket aggregation for dashboard charts. */
export interface AuditTimeBucket {
  /** ISO 8601 timestamp for the start of the bucket. */
  readonly bucket: string
  /** Number of records in this bucket. */
  readonly count: number
}

/** Aggregated statistics for the dashboard. */
export interface AuditAggregateStats {
  /** Total number of records in the time range. */
  readonly total: number
  /** Total records that resolved without a block (`block_reason IS NULL`), excluding drift events. */
  readonly allowed_total: number
  /** Total records that resolved with a block (`block_reason IS NOT NULL`). */
  readonly blocked_total: number
  /** Total records produced in dry-run mode (`dry_run = 1`). */
  readonly dry_run_total: number
  /** Total records produced in applied mode (`dry_run = 0`). */
  readonly applied_total: number
  /** Counts grouped by policy decision. */
  readonly by_decision: ReadonlyArray<{
    readonly decision: string
    readonly count: number
  }>
  /** Counts grouped by block reason for blocked records only. */
  readonly by_block_reason: ReadonlyArray<{
    readonly reason: string
    readonly count: number
  }>
  /** Top tools by call count (max 10). */
  readonly top_tools: ReadonlyArray<{
    readonly tool_name: string
    readonly count: number
  }>
  /** Approval rate (approved / total require_approval decisions), or null if none. */
  readonly approval_rate: number | null
  /** Records per hour over the time range. */
  readonly per_hour: readonly AuditTimeBucket[]
}

// ---------------------------------------------------------------------------
// Store options — constructor config for the AuditStore.
// ---------------------------------------------------------------------------

/** Options for constructing an AuditStore. */
export interface AuditStoreOptions {
  /** Path to the SQLite database file (use ':memory:' for in-memory). */
  readonly path: string
  /** Retention duration string (e.g. "90d"). Records older than this are purged. */
  readonly retention: string
  /** Whether to store upstream response bodies. */
  readonly includeResponses: boolean
  /** Interval in milliseconds for retention cleanup (default: 86_400_000 = 24h). Set to 0 to disable. */
  readonly cleanupIntervalMs?: number
}
