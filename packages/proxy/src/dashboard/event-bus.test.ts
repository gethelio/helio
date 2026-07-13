import { describe, it, expect, afterEach } from 'vitest'
import { DashboardEventBus } from './event-bus.js'
import type { ActionEvent, DashboardEventType, DashboardEvents } from './event-bus.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeActionEvent(overrides: Partial<ActionEvent> = {}): ActionEvent {
  const defaults: ActionEvent = {
    id: 'evt-1',
    tool_name: 'test_tool',
    policy_decision: 'allow',
    block_reason: null,
    approval_status: null,
    session_id: null,
    agent_id: null,
    environment: null,
    timestamp: '2026-04-02T12:00:00Z',
    total_duration_ms: 5,
    approval_wait_ms: 0,
    proxy_compute_ms: 5,
    flagged_destructive: false,
    dry_run: false,
    matched_rule: null,
    matched_rule_index: null,
    record_kind: 'tool_call',
    origin: 'mcp',
  }
  return {
    ...defaults,
    ...overrides,
    environment: overrides.environment ?? defaults.environment,
    matched_rule_index: overrides.matched_rule_index ?? defaults.matched_rule_index,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DashboardEventBus', () => {
  let bus: DashboardEventBus | null = null

  afterEach(() => {
    if (bus) {
      bus.close()
      bus = null
    }
  })

  it('emits and receives typed events', () => {
    bus = new DashboardEventBus()
    const received: unknown[] = []

    bus.on('action', (data) => received.push(data))

    const payload = makeActionEvent({
      tool_name: 'send_email',
      session_id: 'sess-1',
    })
    bus.emit('action', payload)

    expect(received).toHaveLength(1)
    expect(received[0]).toEqual(payload)
  })

  it('supports multiple listeners on the same event', () => {
    bus = new DashboardEventBus()
    let count = 0

    bus.on('action', () => count++)
    bus.on('action', () => count++)

    bus.emit('action', makeActionEvent({ policy_decision: 'deny' }))

    expect(count).toBe(2)
  })

  it('unsubscribes with off()', () => {
    bus = new DashboardEventBus()
    const received: unknown[] = []
    const listener = (data: unknown) => received.push(data)

    bus.on('action', listener)
    bus.emit('action', makeActionEvent({ tool_name: 'a' }))
    expect(received).toHaveLength(1)

    bus.off('action', listener)
    bus.emit('action', makeActionEvent({ tool_name: 'b' }))
    expect(received).toHaveLength(1) // No new event
  })

  it('onAny() receives all event types', () => {
    bus = new DashboardEventBus()
    const received: Array<{
      event: DashboardEventType
      data: DashboardEvents[DashboardEventType]
    }> = []

    bus.onAny((event, data) => received.push({ event, data }))

    bus.emit('action', makeActionEvent())
    bus.emit('approval_requested', {
      ticket_id: 't-1',
      tool_name: 'send_payment',
      channel: 'slack',
      requested_at: '2026-04-02T12:00:00Z',
    })
    bus.emit('approval_resolved', {
      ticket_id: 't-1',
      status: 'approved',
      resolved_by: 'admin',
      resolved_at: '2026-04-02T12:01:00Z',
    })
    bus.emit('limit_warning', {
      key: 'tool:send_email',
      type: 'rate',
      current: 90,
      limit: 100,
      utilization: 0.9,
    })
    bus.emit('approval_notification_failed', {
      ticket_id: 't-1',
      channel: 'webhook',
      phase: 'initial',
      error: 'connection refused',
    })
    bus.emit('budget_update', {
      name: 'daily-cap',
      bucket_key: 'budget:daily-cap:global',
      kind: 'spend',
      amount: 5,
      spent: 45,
      remaining: 55,
      limit: 100,
      currency: 'USD',
      utilization: 0.45,
    })
    bus.emit('budget_breached', {
      name: 'daily-cap',
      bucket_key: 'budget:daily-cap:global',
      on_exceed: 'deny',
      attempted_amount: 80,
      spent: 45,
      limit: 100,
      currency: 'USD',
    })

    expect(received).toHaveLength(7)
    expect(received[0]).toMatchObject({ event: 'action' })
    expect(received[1]).toMatchObject({ event: 'approval_requested' })
    expect(received[2]).toMatchObject({ event: 'approval_resolved' })
    expect(received[3]).toMatchObject({ event: 'limit_warning' })
    expect(received[4]).toMatchObject({ event: 'approval_notification_failed' })
    expect(received[5]).toMatchObject({ event: 'budget_update' })
    expect(received[6]).toMatchObject({ event: 'budget_breached' })
  })

  it('budget events round-trip typed payloads (#14 PR 4)', () => {
    bus = new DashboardEventBus()
    const updates: unknown[] = []
    const breaches: unknown[] = []
    bus.on('budget_update', (e) => updates.push(e))
    bus.on('budget_breached', (e) => breaches.push(e))

    const update = {
      name: 'daily-cap',
      bucket_key: 'budget:daily-cap:global',
      kind: 'approved_overage' as const,
      amount: 30,
      spent: 120,
      remaining: 0,
      limit: 100,
      currency: 'USD',
      utilization: 1.2,
    }
    const breach = {
      name: 'daily-cap',
      bucket_key: 'budget:daily-cap:global',
      on_exceed: 'require_approval' as const,
      attempted_amount: 30,
      spent: 90,
      limit: 100,
      currency: 'USD',
    }
    bus.emit('budget_update', update)
    bus.emit('budget_breached', breach)

    expect(updates).toEqual([update])
    expect(breaches).toEqual([breach])
  })

  it('onAny() returns an unsubscribe function', () => {
    bus = new DashboardEventBus()
    let count = 0

    const unsubscribe = bus.onAny(() => count++)

    bus.emit('action', makeActionEvent())
    expect(count).toBe(1)

    unsubscribe()

    bus.emit('action', makeActionEvent({ tool_name: 'test2', policy_decision: 'deny' }))
    expect(count).toBe(1) // No new event after unsubscribe
  })

  it('action event carries origin and record_kind (#16)', () => {
    bus = new DashboardEventBus()
    const received: ActionEvent[] = []
    bus.on('action', (e) => received.push(e))
    bus.emit('action', makeActionEvent({ origin: 'openclaw', record_kind: 'install_scan' }))
    const evt = received[0]
    expect(evt?.origin).toBe('openclaw')
    expect(evt?.record_kind).toBe('install_scan')
  })

  it('close() removes all listeners', () => {
    bus = new DashboardEventBus()
    let count = 0

    bus.on('action', () => count++)
    bus.onAny(() => count++)

    bus.close()

    bus.emit('action', makeActionEvent())
    expect(count).toBe(0)
    bus = null // Already closed
  })
})
