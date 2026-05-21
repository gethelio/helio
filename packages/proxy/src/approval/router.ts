import type { ApprovalChannel, ApprovalOutcome, ApprovalTicket } from './types.js'
import type { ApprovalQueue } from './queue.js'
import type { CompiledPolicyRule } from '../policy/types.js'

// ---------------------------------------------------------------------------
// ApprovalRouter — orchestrates the approval workflow.
//
// When the policy engine returns `require_approval`, the governed forwarder
// calls `router.submit()` which:
// 1. Creates a ticket in the approval queue
// 2. Notifies the configured channel (fire-and-forget)
// 3. Returns a Promise that resolves when the ticket is approved, denied,
//    or times out
//
// The Promise-based hold pattern keeps the MCP HTTP request open until a
// human decision arrives (via REST API) or the timeout fires.
// ---------------------------------------------------------------------------

/** Internal state for a pending approval. */
interface PendingApproval {
  readonly resolve: (outcome: ApprovalOutcome) => void
  readonly timer: ReturnType<typeof setTimeout>
  readonly escalationTimer?: ReturnType<typeof setTimeout>
}

/** Options for constructing an ApprovalRouter. */
export interface ApprovalRouterOptions {
  /** Default timeout (ms) when no rule-level timeout is specified. */
  readonly defaultTimeoutMs: number
  /** What to do when a timeout fires: 'allow' forwards upstream, 'deny' blocks. */
  readonly defaultOnTimeout: 'allow' | 'deny'
  /** Map of channel-type → channel implementation. */
  readonly channels: Map<string, ApprovalChannel>
  /** The approval queue for ticket storage. */
  readonly queue: ApprovalQueue
  /** Clock function for testable time. Defaults to `Date.now`. */
  readonly now?: () => number
  /** Optional callback when a new approval ticket is submitted. */
  readonly onSubmit?: (ticket: ApprovalTicket) => void
  /** Optional callback when a ticket is resolved (approved, denied, break_glass, timeout, client_disconnected, shutdown_cancelled). */
  readonly onResolve?: (ticket: ApprovalTicket) => void
  /** Optional callback when channel notification delivery fails. */
  readonly onNotifyFailure?: (event: ApprovalNotifyFailureEvent) => void
}

/** Payload emitted when approval-channel notification delivery fails. */
export interface ApprovalNotifyFailureEvent {
  readonly ticket_id: string
  readonly channel: string
  readonly phase: 'initial' | 'escalation'
  readonly error: string
}

/** Parameters for submitting an approval request. */
export interface ApprovalSubmitParams {
  readonly tool_name: string
  readonly tool_input: Record<string, unknown>
  readonly matched_rule: CompiledPolicyRule | undefined
  readonly session_id: string | null
}

export class ApprovalRouter {
  private readonly defaultTimeoutMs: number
  readonly defaultOnTimeout: 'allow' | 'deny'
  private readonly channels: Map<string, ApprovalChannel>
  private readonly queue: ApprovalQueue
  private readonly now: () => number
  private readonly onSubmit: ((ticket: ApprovalTicket) => void) | undefined
  private readonly onResolve: ((ticket: ApprovalTicket) => void) | undefined
  private readonly onNotifyFailure: ((event: ApprovalNotifyFailureEvent) => void) | undefined
  private readonly pending = new Map<string, PendingApproval>()
  private closed = false

  constructor(options: ApprovalRouterOptions) {
    this.defaultTimeoutMs = options.defaultTimeoutMs
    this.defaultOnTimeout = options.defaultOnTimeout
    this.channels = options.channels
    this.queue = options.queue
    this.now = options.now ?? Date.now
    this.onSubmit = options.onSubmit
    this.onResolve = options.onResolve
    this.onNotifyFailure = options.onNotifyFailure
  }

  /**
   * Submit a tool call for approval. Returns a Promise that resolves
   * when the approval is granted, denied, or times out.
   *
   * The governed forwarder `await`s this Promise while the HTTP request
   * is held open.
   */
  async submit(params: ApprovalSubmitParams, abortSignal?: AbortSignal): Promise<ApprovalOutcome> {
    if (this.closed) {
      return { status: 'denied', resolvedBy: 'system', reason: 'Router is closed', ticketId: '' }
    }

    const rule = params.matched_rule
    const timeoutMs = rule?.approval?.timeoutMs ?? this.defaultTimeoutMs
    const channelName = rule?.approval?.channel ?? 'dashboard'

    // Create ticket in the queue
    const ticket = this.queue.add({
      tool_name: params.tool_name,
      tool_input: params.tool_input,
      matched_rule: rule?.name ?? null,
      rule_index: rule?.index ?? null,
      channel_name: channelName,
      session_id: params.session_id,
      timeout_ms: timeoutMs,
    })

    this.onSubmit?.(ticket)

    // Create the hold Promise
    const outcome = await new Promise<ApprovalOutcome>((resolve) => {
      let settled = false
      let removeAbortListener = () => {}

      const settle = (finalOutcome: ApprovalOutcome) => {
        if (settled) return
        settled = true
        removeAbortListener()
        resolve(finalOutcome)
      }

      // Set the timeout timer
      const timer = setTimeout(() => {
        this.finalizePending(ticket.id, { status: 'timeout', ticketId: ticket.id, timeoutMs })
      }, timeoutMs)
      timer.unref()

      // Escalation timer — fires before timeout to re-notify via delegates
      let escalationTimer: ReturnType<typeof setTimeout> | undefined
      const delegates = rule?.approval?.delegates
      const escalationAfterMs = rule?.approval?.escalationAfterMs

      if (
        escalationAfterMs !== undefined &&
        escalationAfterMs > 0 &&
        escalationAfterMs < timeoutMs
      ) {
        escalationTimer = setTimeout(() => {
          if (!this.pending.has(ticket.id)) return // Already resolved
          const targets = delegates?.length ? [...delegates] : [channelName]
          for (const target of targets) {
            const ch = this.channels.get(target)
            if (ch) {
              void ch.notify(ticket).catch((err: unknown) => {
                this.reportNotifyFailure(ticket.id, target, 'escalation', err)
              })
            } else {
              this.reportNotifyFailure(ticket.id, target, 'escalation', 'channel not found')
            }
          }
          ticket.escalated_at = new Date(this.now()).toISOString()
          ticket.escalated_to = [...targets]
        }, escalationAfterMs)
        escalationTimer.unref()
      }

      this.pending.set(ticket.id, { resolve: settle, timer, escalationTimer })

      if (abortSignal) {
        if (abortSignal.aborted) {
          this.finalizePending(ticket.id, {
            status: 'client_disconnected',
            ticketId: ticket.id,
          })
        } else {
          const onAbort = () => {
            this.finalizePending(ticket.id, {
              status: 'client_disconnected',
              ticketId: ticket.id,
            })
          }
          removeAbortListener = () => {
            abortSignal.removeEventListener('abort', onAbort)
          }
          abortSignal.addEventListener('abort', onAbort, { once: true })
        }
      }

      // Notify the channel (fire-and-forget — don't block on notification)
      const channel = this.channels.get(channelName)
      if (channel) {
        void channel.notify(ticket).catch((err: unknown) => {
          this.reportNotifyFailure(ticket.id, channelName, 'initial', err)
        })
      } else {
        this.reportNotifyFailure(ticket.id, channelName, 'initial', 'channel not found')
      }
    })

    return outcome
  }

  /**
   * Approve a pending ticket. Resolves the held Promise so the governed
   * forwarder can forward the request upstream.
   *
   * @returns `true` if the ticket was approved, `false` if not found or
   *          already resolved.
   */
  approve(ticketId: string, approvedBy: string): boolean {
    return this.finalizePending(ticketId, {
      status: 'approved',
      resolvedBy: approvedBy,
      ticketId,
    })
  }

  /**
   * Deny a pending ticket. Resolves the held Promise so the governed
   * forwarder can return structured denial feedback.
   *
   * @returns `true` if the ticket was denied, `false` if not found or
   *          already resolved.
   */
  deny(ticketId: string, deniedBy: string, reason?: string): boolean {
    return this.finalizePending(ticketId, {
      status: 'denied',
      resolvedBy: deniedBy,
      reason,
      ticketId,
    })
  }

  /**
   * Break-glass override: force-approve a pending ticket, bypassing the
   * normal approval flow. The event is prominently flagged in the audit trail.
   *
   * @returns `true` if the ticket was resolved, `false` if not found or
   *          already resolved.
   */
  breakGlass(ticketId: string, resolvedBy: string, reason: string): boolean {
    return this.finalizePending(ticketId, {
      status: 'break_glass',
      resolvedBy,
      reason,
      ticketId,
    })
  }

  /** Clean up all pending timers and resolve all pending promises. */
  close(): void {
    this.closed = true
    for (const ticketId of [...this.pending.keys()]) {
      this.finalizePending(ticketId, {
        status: 'shutdown_cancelled',
        ticketId,
      })
    }
  }

  private finalizePending(ticketId: string, outcome: ApprovalOutcome): boolean {
    const entry = this.pending.get(ticketId)
    if (!entry) return false

    clearTimeout(entry.timer)
    if (entry.escalationTimer) clearTimeout(entry.escalationTimer)
    this.pending.delete(ticketId)

    switch (outcome.status) {
      case 'approved':
        this.queue.resolve(ticketId, 'approved', outcome.resolvedBy)
        break
      case 'denied':
        this.queue.resolve(ticketId, 'denied', outcome.resolvedBy, {
          denial_reason: outcome.reason,
        })
        break
      case 'timeout':
        this.queue.resolve(ticketId, 'timeout')
        break
      case 'break_glass':
        this.queue.resolve(ticketId, 'break_glass', outcome.resolvedBy, {
          break_glass_reason: outcome.reason,
        })
        break
      case 'client_disconnected':
        this.queue.resolve(ticketId, 'client_disconnected')
        break
      case 'shutdown_cancelled':
        this.queue.resolve(ticketId, 'shutdown_cancelled')
        break
    }

    entry.resolve(outcome)
    const ticket = this.queue.get(ticketId)
    if (ticket) this.onResolve?.(ticket)
    return true
  }

  private reportNotifyFailure(
    ticketId: string,
    channel: string,
    phase: 'initial' | 'escalation',
    err: unknown,
  ): void {
    const message = err instanceof Error ? err.message : String(err)
    const ticket = this.queue.get(ticketId)
    if (ticket) {
      const failure = {
        channel,
        phase,
        error: message,
        failed_at: new Date(this.now()).toISOString(),
      } as const
      const existing = ticket.notification_failures ?? []
      // Keep only the most recent delivery failures per ticket.
      ticket.notification_failures = [...existing.slice(-9), failure]
    }
    // eslint-disable-next-line no-console -- Operational warning for failed notifications
    console.error(
      `[helio] ${phase === 'initial' ? 'Approval' : 'Escalation'} notification failed for "${channel}" (ticket: ${ticketId}): ${message}`,
    )
    this.onNotifyFailure?.({
      ticket_id: ticketId,
      channel,
      phase,
      error: message,
    })
  }
}
