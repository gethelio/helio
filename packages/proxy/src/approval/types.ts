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

/**
 * One breached budget's context on a break-glass approval ticket (issue #14).
 *
 * DTO: snake_case because it rides {@link ApprovalTicket}, which is emitted
 * verbatim over REST and webhooks. `spent` is the accrued spend BEFORE the
 * attempted charge; `window` is the raw config string ("1h" | "session").
 */
export interface BudgetBreachContext {
  readonly name: string
  readonly limit: number
  readonly spent: number
  readonly attempted_amount: number
  readonly currency: string
  readonly window: string
}

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
  /**
   * Every budget the call breached, when this is a break-glass (budget) or
   * merged rule+budget ticket (issue #14). Its presence marks the ticket as
   * budget-context: one approval covers every listed overage, the approval is
   * scope-once by definition (issue #127 interlock — a `scope: "always"`
   * resolution grants nothing beyond this call), and timeout fails closed.
   */
  readonly breached_budgets?: readonly BudgetBreachContext[]
  status: ApprovalStatus
  resolved_at?: string
  resolved_by?: string
  denial_reason?: string
  break_glass_reason?: string
  escalated_at?: string
  escalated_to?: string[]
  notification_failures?: ApprovalNotificationFailure[]
}

/**
 * Approval context snapshotted at resolution time for the audit record.
 * Emitted as `evidence_chain.approval` only when it has content (a denial
 * reason or an escalation) — plain approvals do not produce the block.
 * Shared by the MCP path (governed forwarder) and the sideband path
 * (governance service) so both emit the same wire shape.
 */
export interface ApprovalAuditContext {
  readonly ticket_id: string
  readonly denial_reason?: string
  readonly escalated_at?: string
  readonly escalated_to?: string[]
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
