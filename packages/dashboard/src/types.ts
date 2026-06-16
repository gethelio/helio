// ---------------------------------------------------------------------------
// Dashboard API response types.
//
// These mirror the shapes returned by the proxy's dashboard REST API and
// SSE event stream. Defined here (not imported from @gethelio/proxy) to
// keep the packages decoupled at the API contract boundary.
// ---------------------------------------------------------------------------

// -- Health ------------------------------------------------------------------

export interface AuthSessionResponse {
  readonly auth_required: boolean
  readonly authenticated: boolean
  readonly expires_at?: string
  readonly csrf_token?: string
}

export interface HealthResponse {
  readonly status: string
  readonly version: string
  readonly uptime: number
}

// -- Audit -------------------------------------------------------------------

export interface AuditRecord {
  readonly id: string
  readonly timestamp: string
  readonly session_id: string | null
  readonly agent_id: string | null
  readonly environment: string | null
  readonly tool_name: string
  readonly tool_input: Record<string, unknown>
  readonly policy_decision: string
  readonly block_reason: string | null
  readonly matched_rule: string | null
  readonly matched_rule_index: number | null
  readonly evidence_chain: Record<string, unknown> | null
  readonly approval_status: string | null
  readonly approved_by: string | null
  readonly upstream_response: unknown
  readonly upstream_error: string | null
  readonly upstream_http_status: number | null
  readonly upstream_latency_ms: number | null
  readonly total_duration_ms: number
  readonly approval_wait_ms: number
  readonly proxy_compute_ms: number
  readonly flagged_destructive: boolean
  readonly dry_run: boolean
  readonly created_at: string
  readonly record_kind: 'tool_call' | 'drift_event' | 'install_scan' | 'evaluation_expired'
  readonly origin: string
  readonly metadata: Record<string, unknown> | null
}

export interface AuditListResponse {
  readonly data: readonly AuditRecord[]
  readonly total: number
  readonly limit: number
  readonly offset: number
}

export interface AuditRecordResponse {
  readonly data: AuditRecord
}

// -- Feed (same shape as AuditListResponse) ----------------------------------

export type FeedResponse = AuditListResponse

// -- Approvals ---------------------------------------------------------------

export type ApprovalStatus =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'timeout'
  | 'break_glass'
  | 'client_disconnected'
  | 'shutdown_cancelled'
  | 'cancelled'

export interface ApprovalTicket {
  readonly id: string
  readonly tool_name: string
  readonly tool_input: Record<string, unknown>
  readonly matched_rule: string | null
  readonly rule_index: number | null
  readonly channel_name: string
  readonly session_id: string | null
  readonly requested_at: string
  readonly timeout_at: string
  readonly timeout_ms: number
  readonly status: ApprovalStatus
  readonly resolved_at?: string
  readonly resolved_by?: string
  readonly denial_reason?: string
  readonly break_glass_reason?: string
  readonly escalated_at?: string
  readonly escalated_to?: readonly string[]
  readonly notification_failures?: readonly ApprovalNotificationFailure[]
}

export interface ApprovalsResponse {
  readonly data: readonly ApprovalTicket[]
  readonly total: number
  readonly limit: number
  readonly offset: number
}

// -- Limits ------------------------------------------------------------------

export interface RateLimitKeyState {
  readonly key: string
  readonly current: number
  readonly limit: number
  readonly window_ms: number
  readonly reset_at_ms: number
}

export interface SpendLimitKeyState {
  readonly key: string
  readonly current_spend: number
  readonly limit: number
  readonly currency: string
  readonly window_ms: number
  readonly reset_at_ms: number
}

export interface LimitsResponse {
  readonly rate_limits: readonly RateLimitKeyState[]
  readonly spend_limits: readonly SpendLimitKeyState[]
}

// -- Analytics ---------------------------------------------------------------

export interface TimeBucket {
  readonly bucket: string
  readonly count: number
}

export interface DecisionCount {
  readonly decision: string
  readonly count: number
}

export interface ToolCount {
  readonly tool_name: string
  readonly count: number
}

export interface AnalyticsResponse {
  readonly total: number
  readonly allowed_total?: number
  readonly by_decision: readonly DecisionCount[]
  readonly blocked_total?: number
  readonly dry_run_total?: number
  readonly applied_total?: number
  readonly by_block_reason?: ReadonlyArray<{ reason: string; count: number }>
  readonly top_tools: readonly ToolCount[]
  readonly approval_rate: number | null
  readonly per_hour: readonly TimeBucket[]
}

// -- Evidence ----------------------------------------------------------------

export interface EvidenceResponse {
  readonly data: unknown
}

// -- SSE Events --------------------------------------------------------------

export interface ActionEvent {
  readonly id: string
  readonly tool_name: string
  readonly policy_decision: string
  readonly block_reason: string | null
  readonly approval_status: string | null
  readonly session_id: string | null
  readonly agent_id: string | null
  readonly environment: string | null
  readonly timestamp: string
  readonly total_duration_ms: number
  readonly approval_wait_ms: number
  readonly proxy_compute_ms: number
  readonly flagged_destructive: boolean
  readonly dry_run: boolean
  readonly matched_rule: string | null
  readonly matched_rule_index: number | null
  // record_kind + origin let the live Feed render an origin/kind chip. metadata is
  // intentionally omitted here — the Feed fetches the full AuditRecord on card expand.
  readonly record_kind: AuditRecord['record_kind']
  readonly origin: string
}

export interface ApprovalRequestedEvent {
  readonly ticket_id: string
  readonly tool_name: string
  readonly channel: string
  readonly requested_at: string
}

export interface ApprovalResolvedEvent {
  readonly ticket_id: string
  readonly status: string
  readonly resolved_by?: string
  readonly resolved_at: string
}

export interface ApprovalNotificationFailure {
  readonly channel: string
  readonly phase: 'initial' | 'escalation'
  readonly error: string
  readonly failed_at: string
}

export interface ApprovalNotificationFailedEvent {
  readonly ticket_id: string
  readonly channel: string
  readonly phase: 'initial' | 'escalation'
  readonly error: string
}

export interface LimitWarningEvent {
  readonly key: string
  readonly type: 'rate' | 'spend'
  readonly current: number
  readonly limit: number
  readonly utilization: number
}

export type DashboardEventType =
  | 'action'
  | 'approval_requested'
  | 'approval_resolved'
  | 'approval_notification_failed'
  | 'limit_warning'

export interface DashboardEventMap {
  action: ActionEvent
  approval_requested: ApprovalRequestedEvent
  approval_resolved: ApprovalResolvedEvent
  approval_notification_failed: ApprovalNotificationFailedEvent
  limit_warning: LimitWarningEvent
}
