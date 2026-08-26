import { EventEmitter } from 'node:events'
import type { AuditRecord } from '../audit/types.js'
import type { ApprovalTicket } from '../approval/types.js'
import type { BudgetBreachEvent, BudgetCommitEvent } from '../budget/engine.js'
import type { RateLimitKeyState } from '../policy/rate-limiter.js'
import type { SpendLimitKeyState } from '../policy/spend-limiter.js'
import { upstreamFromLimitKey } from '../policy/bucket-key.js'

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
  /** Identity strategy that produced session_id (issue #218), or null. */
  readonly session_source: string | null
  /** The client's verbatim MCP-Protocol-Version wire claim (issue #219), or null. */
  readonly protocol_version: string | null
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
  /** Upstream attribution from the audit record (issue #292), or null. */
  readonly upstream: string | null
}

/** Payload for an approval_requested event. */
export interface ApprovalRequestedEvent {
  readonly ticket_id: string
  readonly tool_name: string
  readonly channel: string
  readonly requested_at: string
  /** Upstream attribution from the ticket (issue #292), or null. */
  readonly upstream: string | null
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
  /**
   * Upstream name parsed from a partitioned bucket key (issue #292), or
   * null — session keys, singular tool keys, and sideband keys have no door.
   */
  readonly upstream: string | null
}

/** Payload for approval notification delivery failures. */
export interface ApprovalNotificationFailedEvent {
  readonly ticket_id: string
  readonly channel: string
  readonly phase: 'initial' | 'escalation'
  readonly error: string
}

/**
 * Payload for a budget_update event: one committed charge with post-record
 * numbers (issue #14). The engine's commit-event DTO is already snake_case
 * wire shape, so it is emitted verbatim. `utilization` drives dashboard
 * thresholds — there is no separate budget warning event.
 */
export type BudgetUpdateEvent = BudgetCommitEvent

/**
 * Payload for a budget_breached event: a peek denied the call or raised the
 * composite break-glass ticket (issue #14). Emitted verbatim from the
 * engine's breach-event DTO.
 */
export type BudgetBreachedEvent = BudgetBreachEvent

/** Map of event type names to their payload types. */
export interface DashboardEvents {
  action: ActionEvent
  approval_requested: ApprovalRequestedEvent
  approval_resolved: ApprovalResolvedEvent
  limit_warning: LimitWarningEvent
  approval_notification_failed: ApprovalNotificationFailedEvent
  budget_update: BudgetUpdateEvent
  budget_breached: BudgetBreachedEvent
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
  'budget_update',
  'budget_breached',
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

// ---------------------------------------------------------------------------
// Shared event mappers + callback factory (issue #292).
//
// The record→event and ticket→event projections used to live inline in the
// composition roots (cli.ts and the e2e harness) as drifting near-twins.
// They are extracted here — from cli.ts, the production authority — so both
// homes consume ONE implementation and the projections are unit-testable.
// ---------------------------------------------------------------------------

/** Map a persisted audit record (the writer's callback shape) to an ActionEvent. */
export function actionEventFromRecord(
  record: Omit<AuditRecord, 'id' | 'created_at'>,
  id: string,
): ActionEvent {
  return {
    id,
    tool_name: record.tool_name,
    policy_decision: record.policy_decision,
    block_reason: record.block_reason,
    approval_status: record.approval_status,
    session_id: record.session_id,
    session_source: record.session_source,
    protocol_version: record.protocol_version,
    agent_id: record.agent_id,
    environment: record.environment,
    timestamp: record.timestamp,
    total_duration_ms: record.total_duration_ms,
    approval_wait_ms: record.approval_wait_ms,
    proxy_compute_ms: record.proxy_compute_ms,
    flagged_destructive: record.flagged_destructive,
    dry_run: record.dry_run,
    matched_rule: record.matched_rule,
    matched_rule_index: record.matched_rule_index,
    record_kind: record.record_kind,
    origin: record.origin,
    upstream: record.upstream,
  }
}

/**
 * Map an approval ticket to an ApprovalRequestedEvent. The parameter is
 * duck-typed to the fields the mapper reads — not `ApprovalTicket`, whose
 * optional `upstream` lands in a later commit; the ticket stays structurally
 * assignable before and after, so nothing retargets when it does.
 */
export function approvalRequestedEvent(ticket: {
  id: string
  tool_name: string
  channel_name: string
  requested_at: string
  upstream?: string
}): ApprovalRequestedEvent {
  return {
    ticket_id: ticket.id,
    tool_name: ticket.tool_name,
    channel: ticket.channel_name,
    requested_at: ticket.requested_at,
    upstream: ticket.upstream ?? null,
  }
}

/** Build a LimitWarningEvent from a limiter warning, parsing the key's door. */
export function limitWarningEvent(
  type: LimitWarningEvent['type'],
  key: string,
  current: number,
  limit: number,
): LimitWarningEvent {
  return {
    key,
    type,
    current,
    limit,
    utilization: current / limit,
    upstream: upstreamFromLimitKey(key),
  }
}

/**
 * The four bus callbacks this ticket's events flow through, typed as the
 * consuming constructors' option shapes so wiring them is an ordinary
 * (compiler-checked) assignment. Wire by EXPLICIT ASSIGNMENT from a
 * `const cbs = dashboardEventCallbacks(bus)` binding — never a spread —
 * in every composition home; the source-guard test pins that form.
 * `approval_resolved`, notification failures, and the engine's budget
 * passthroughs stay inline in the homes: they are verbatim projections of
 * unchanged or engine-owned shapes.
 */
export function dashboardEventCallbacks(bus: DashboardEventBus): {
  onPersist: (record: Omit<AuditRecord, 'id' | 'created_at'>, id: string) => void
  onApprovalSubmit: (ticket: ApprovalTicket) => void
  onRateWarning: (state: RateLimitKeyState) => void
  onSpendWarning: (state: SpendLimitKeyState) => void
} {
  return {
    onPersist: (record, id) => {
      bus.emit('action', actionEventFromRecord(record, id))
    },
    onApprovalSubmit: (ticket) => {
      bus.emit('approval_requested', approvalRequestedEvent(ticket))
    },
    onRateWarning: (state) => {
      bus.emit('limit_warning', limitWarningEvent('rate', state.key, state.current, state.limit))
    },
    onSpendWarning: (state) => {
      bus.emit(
        'limit_warning',
        limitWarningEvent('spend', state.key, state.current_spend, state.limit),
      )
    },
  }
}
