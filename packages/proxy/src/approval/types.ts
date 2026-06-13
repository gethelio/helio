// ---------------------------------------------------------------------------
// Approval types — data structures for the approval workflow.
//
// ApprovalTickets are created when a policy decision is `require_approval`.
// The router holds the HTTP request until the ticket is resolved (approved,
// denied, or timed out). ApprovalOutcome is what the governed forwarder
// receives back to decide whether to forward upstream or return feedback.
// ---------------------------------------------------------------------------

/** Possible states of an approval ticket. */
export type ApprovalStatus =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'timeout'
  | 'break_glass'
  | 'client_disconnected'
  | 'shutdown_cancelled'
  /**
   * The approver's native UI cancelled the request (e.g. an OpenClaw
   * `/approve` dialog dismissed without a decision). Distinct from
   * `client_disconnected`, which the router reserves for the requesting agent
   * aborting the held MCP request. Sideband (native) approvals only. (#12.)
   */
  | 'cancelled'

/** A failed attempt to deliver an approval notification. */
export interface ApprovalNotificationFailure {
  readonly channel: string
  readonly phase: 'initial' | 'escalation'
  readonly error: string
  readonly failed_at: string
}

/**
 * An approval ticket representing a held tools/call request waiting for a
 * human decision.
 *
 * DTO: field names are snake_case because this type is emitted directly
 * over REST `/api/approvals` and webhook payloads. `JSON.stringify(ticket)`
 * produces the wire shape without a mapping layer. Strictly internal types
 * in this file (e.g. `ApprovalOutcome`) remain idiomatic camelCase.
 */
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
  status: ApprovalStatus
  resolved_at?: string
  resolved_by?: string
  denial_reason?: string
  break_glass_reason?: string
  escalated_at?: string
  escalated_to?: string[]
  notification_failures?: ApprovalNotificationFailure[]
}

/** What the approval router returns to the governed forwarder. */
export type ApprovalOutcome =
  | { readonly status: 'approved'; readonly resolvedBy: string; readonly ticketId: string }
  | {
      readonly status: 'denied'
      readonly resolvedBy: string
      readonly reason?: string
      readonly ticketId: string
    }
  | { readonly status: 'timeout'; readonly ticketId: string; readonly timeoutMs: number }
  | { readonly status: 'client_disconnected'; readonly ticketId: string }
  | { readonly status: 'shutdown_cancelled'; readonly ticketId: string }
  | {
      readonly status: 'break_glass'
      readonly resolvedBy: string
      readonly reason: string
      readonly ticketId: string
    }

/**
 * Channel interface for approval notifications.
 *
 * Channels are responsible for notifying approvers when a new ticket
 * is created. The actual resolution happens via the REST API or the
 * channel's own callback mechanism.
 */
export interface ApprovalChannel {
  /** Channel type identifier (e.g. 'dashboard', 'webhook', 'slack'). */
  readonly type: string
  /** Send a notification about a new approval request. Fire-and-forget. */
  notify(ticket: ApprovalTicket): Promise<void>
}
