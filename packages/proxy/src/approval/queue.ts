import { randomUUID } from 'node:crypto'
import type { ApprovalTicket, ApprovalStatus } from './types.js'

// ---------------------------------------------------------------------------
// ApprovalQueue — in-memory storage for approval tickets.
//
// Tickets are created when the approval router holds a request pending
// human decision. The queue stores tickets and supports resolution,
// listing, and cleanup of old resolved tickets.
//
// Follows the EvidenceStore pattern: injectable clock, cleanup timer,
// close() for graceful teardown.
// ---------------------------------------------------------------------------

/** Options for constructing an ApprovalQueue. */
export interface ApprovalQueueOptions {
  /** Clock function for testable time. Defaults to `Date.now`. */
  readonly now?: () => number
  /** Interval (ms) between cleanup sweeps. 0 disables cleanup. Default: 60000. */
  readonly cleanupIntervalMs?: number
  /** How long (ms) to keep resolved tickets before cleanup. Default: 3600000 (1 hour). */
  readonly resolvedRetentionMs?: number
}

/** Filter options for listing tickets. */
export interface ApprovalListFilter {
  readonly status?: ApprovalStatus
}

export class ApprovalQueue {
  private readonly tickets = new Map<string, ApprovalTicket>()
  private readonly now: () => number
  private readonly resolvedRetentionMs: number
  private timer: ReturnType<typeof setInterval> | null = null
  private closed = false

  constructor(options: ApprovalQueueOptions = {}) {
    this.now = options.now ?? Date.now
    this.resolvedRetentionMs = options.resolvedRetentionMs ?? 3_600_000

    const intervalMs = options.cleanupIntervalMs ?? 60_000
    if (intervalMs > 0) {
      this.timer = setInterval(() => {
        this.cleanup()
      }, intervalMs)
      this.timer.unref()
    }
  }

  // -------------------------------------------------------------------------
  // Write operations
  // -------------------------------------------------------------------------

  /**
   * Create and store a new approval ticket.
   *
   * @returns the created ticket (with generated ID and timestamps).
   */
  add(params: {
    tool_name: string
    tool_input: Record<string, unknown>
    matched_rule: string | null
    rule_index: number | null
    channel_name: string
    session_id: string | null
    timeout_ms: number
  }): ApprovalTicket {
    if (this.closed) throw new Error('ApprovalQueue is closed')

    const now = this.now()
    const ticket: ApprovalTicket = {
      id: randomUUID(),
      tool_name: params.tool_name,
      tool_input: params.tool_input,
      matched_rule: params.matched_rule,
      rule_index: params.rule_index,
      channel_name: params.channel_name,
      session_id: params.session_id,
      requested_at: new Date(now).toISOString(),
      timeout_at: new Date(now + params.timeout_ms).toISOString(),
      timeout_ms: params.timeout_ms,
      status: 'pending',
      notification_failures: [],
    }

    this.tickets.set(ticket.id, ticket)
    return ticket
  }

  // -------------------------------------------------------------------------
  // Read operations
  // -------------------------------------------------------------------------

  /** Get a ticket by ID. Returns undefined if not found. */
  get(id: string): ApprovalTicket | undefined {
    return this.tickets.get(id)
  }

  /** List tickets, optionally filtered by status. */
  list(filter?: ApprovalListFilter): ApprovalTicket[] {
    const results: ApprovalTicket[] = []
    for (const ticket of this.tickets.values()) {
      if (filter?.status && ticket.status !== filter.status) continue
      results.push(ticket)
    }
    return results
  }

  /** Shortcut: list only pending tickets. */
  listPending(): ApprovalTicket[] {
    return this.list({ status: 'pending' })
  }

  // -------------------------------------------------------------------------
  // Resolution
  // -------------------------------------------------------------------------

  /**
   * Resolve a pending ticket.
   *
   * @returns `true` if the ticket was resolved, `false` if not found or
   *          already resolved (no double-resolution).
   */
  resolve(
    id: string,
    status:
      | 'approved'
      | 'denied'
      | 'timeout'
      | 'break_glass'
      | 'client_disconnected'
      | 'shutdown_cancelled',
    resolvedBy?: string,
    options?: { denial_reason?: string; break_glass_reason?: string },
  ): boolean {
    const ticket = this.tickets.get(id)
    if (!ticket || ticket.status !== 'pending') return false

    ticket.status = status
    ticket.resolved_at = new Date(this.now()).toISOString()
    if (resolvedBy) ticket.resolved_by = resolvedBy
    if (options?.denial_reason) ticket.denial_reason = options.denial_reason
    if (options?.break_glass_reason) ticket.break_glass_reason = options.break_glass_reason

    return true
  }

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  /** Remove resolved tickets older than the retention period. */
  cleanup(): void {
    const cutoff = this.now() - this.resolvedRetentionMs

    for (const [id, ticket] of this.tickets) {
      if (ticket.status === 'pending') continue
      if (ticket.resolved_at && new Date(ticket.resolved_at).getTime() < cutoff) {
        this.tickets.delete(id)
      }
    }
  }

  /** Clear the cleanup timer and mark the queue as closed. */
  close(): void {
    this.closed = true
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}
