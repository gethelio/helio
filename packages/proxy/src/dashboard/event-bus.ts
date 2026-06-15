import { EventEmitter } from 'node:events'
import type { AuditRecord } from '../audit/types.js'

// ---------------------------------------------------------------------------
// DashboardEventBus — typed event emitter for real-time dashboard updates.
//
// Provides a pub/sub mechanism for pushing governance events to connected
// SSE clients. Components (AuditWriter, ApprovalRouter, limiters) emit
// events via callbacks wired in the CLI startup, and the SSE endpoint
// subscribes via onAny().
// ---------------------------------------------------------------------------

/** Payload for an action event (new tool call processed). */
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
  readonly record_kind: AuditRecord['record_kind']
  readonly origin: string
}

/** Payload for an approval_requested event. */
export interface ApprovalRequestedEvent {
  readonly ticket_id: string
  readonly tool_name: string
  readonly channel: string
  readonly requested_at: string
}

/** Payload for an approval_resolved event. */
export interface ApprovalResolvedEvent {
  readonly ticket_id: string
  readonly status: string
  readonly resolved_by?: string
  readonly resolved_at: string
}

/** Payload for a limit_warning event (approaching threshold). */
export interface LimitWarningEvent {
  readonly key: string
  readonly type: 'rate' | 'spend'
  readonly current: number
  readonly limit: number
  readonly utilization: number
}

/** Payload for approval notification delivery failures. */
export interface ApprovalNotificationFailedEvent {
  readonly ticket_id: string
  readonly channel: string
  readonly phase: 'initial' | 'escalation'
  readonly error: string
}

/** Map of event type names to their payload types. */
export interface DashboardEvents {
  action: ActionEvent
  approval_requested: ApprovalRequestedEvent
  approval_resolved: ApprovalResolvedEvent
  limit_warning: LimitWarningEvent
  approval_notification_failed: ApprovalNotificationFailedEvent
}

/** Union of all dashboard event type names. */
export type DashboardEventType = keyof DashboardEvents

/** All known event type names, used internally for iteration. */
const EVENT_TYPES: readonly DashboardEventType[] = [
  'action',
  'approval_requested',
  'approval_resolved',
  'limit_warning',
  'approval_notification_failed',
]

/**
 * Typed event bus for dashboard real-time updates.
 *
 * Wraps Node's `EventEmitter` with type-safe emit/on/off methods and an
 * `onAny()` helper that subscribes to all event types at once (used by the
 * SSE endpoint).
 */
export class DashboardEventBus {
  private readonly emitter = new EventEmitter()

  constructor() {
    // Allow many concurrent SSE clients without Node warning
    this.emitter.setMaxListeners(100)
  }

  /** Emit a typed event to all listeners. */
  emit<K extends DashboardEventType>(event: K, data: DashboardEvents[K]): void {
    this.emitter.emit(event, data)
  }

  /** Subscribe to a specific event type. */
  on<K extends DashboardEventType>(event: K, listener: (data: DashboardEvents[K]) => void): void {
    this.emitter.on(event, listener as (...args: unknown[]) => void)
  }

  /** Unsubscribe from a specific event type. */
  off<K extends DashboardEventType>(event: K, listener: (data: DashboardEvents[K]) => void): void {
    this.emitter.off(event, listener as (...args: unknown[]) => void)
  }

  /**
   * Subscribe to ALL event types. The listener receives the event type name
   * and the payload for each event.
   *
   * @returns An unsubscribe function that removes all listeners at once.
   */
  onAny(
    listener: (event: DashboardEventType, data: DashboardEvents[DashboardEventType]) => void,
  ): () => void {
    const handlers = EVENT_TYPES.map((type) => {
      const handler = (data: DashboardEvents[typeof type]) => {
        listener(type, data)
      }
      this.emitter.on(type, handler as (...args: unknown[]) => void)
      return { type, handler }
    })

    return () => {
      for (const { type, handler } of handlers) {
        this.emitter.off(type, handler as (...args: unknown[]) => void)
      }
    }
  }

  /** Remove all listeners and release resources. */
  close(): void {
    this.emitter.removeAllListeners()
  }
}
