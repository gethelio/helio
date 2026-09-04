import { describe, it, expect, afterEach } from 'vitest'
import {
  DashboardEventBus,
  actionEventFromRecord,
  approvalRequestedEvent,
  limitWarningEvent,
  dashboardEventCallbacks,
} from './event-bus.js'
import type {
  ActionEvent,
  ApprovalRequestedEvent,
  LimitWarningEvent,
  PolicyReloadEvent,
  DashboardEventType,
  DashboardEvents,
} from './event-bus.js'
import { ApprovalQueue } from '../approval/queue.js'
import { buildPolicyReloadRecord } from '../audit/policy-reload.js'
import type { AuditRecordInput } from '../audit/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type InsertRecord = AuditRecordInput

function makeRecord(overrides: Partial<InsertRecord> = {}): InsertRecord {
  const defaults: InsertRecord = {
    timestamp: '2026-04-02T12:00:00Z',
    session_id: null,
    session_source: null,
    protocol_version: null,
    upstream: null,
    agent_id: null,
    environment: null,
    tool_name: 'test_tool',
    tool_input: { key: 'value' },
    policy_decision: 'allow',
    block_reason: null,
    matched_rule: null,
    matched_rule_index: null,
    evidence_chain: null,
    approval_status: null,
    approved_by: null,
    upstream_response: null,
    upstream_error: null,
    upstream_http_status: 200,
    upstream_latency_ms: 10,
    total_duration_ms: 5,
    approval_wait_ms: 0,
    proxy_compute_ms: 5,
    flagged_destructive: false,
    dry_run: false,
    record_kind: 'tool_call',
    origin: 'mcp',
    metadata: null,
  }
  return { ...defaults, ...overrides }
}

function makeActionEvent(overrides: Partial<ActionEvent> = {}): ActionEvent {
  const defaults: ActionEvent = {
    id: 'evt-1',
    tool_name: 'test_tool',
    policy_decision: 'allow',
    block_reason: null,
    approval_status: null,
    session_id: null,
    session_source: null,
    protocol_version: null,
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
    upstream: null,
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
      upstream: null,
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
      upstream: null,
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
      upstream: null,
    })
    bus.emit('budget_breached', {
      name: 'daily-cap',
      bucket_key: 'budget:daily-cap:global',
      on_exceed: 'deny',
      attempted_amount: 80,
      spent: 45,
      limit: 100,
      currency: 'USD',
      upstream: null,
    })
    bus.emit('policy_reload', {
      id: 'evt-reload',
      at: '2026-04-02T12:02:00Z',
      outcome: 'applied',
      config_path: '/etc/helio/helio.yaml',
      sha256_before: 'a'.repeat(64),
      sha256_after: 'b'.repeat(64),
      rule_count_before: 1,
      rule_count_after: 1,
      default_action_before: 'allow',
      default_action_after: 'allow',
      budget_count_before: 0,
      budget_count_after: 0,
      rules_removed: [],
      restart_required_paths: [],
      error: null,
    })

    expect(received).toHaveLength(8)
    expect(received[0]).toMatchObject({ event: 'action' })
    expect(received[1]).toMatchObject({ event: 'approval_requested' })
    expect(received[2]).toMatchObject({ event: 'approval_resolved' })
    expect(received[3]).toMatchObject({ event: 'limit_warning' })
    expect(received[4]).toMatchObject({ event: 'approval_notification_failed' })
    expect(received[5]).toMatchObject({ event: 'budget_update' })
    expect(received[6]).toMatchObject({ event: 'budget_breached' })
    expect(received[7]).toMatchObject({ event: 'policy_reload' })
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
      upstream: null,
    }
    const breach = {
      name: 'daily-cap',
      bucket_key: 'budget:daily-cap:global',
      on_exceed: 'require_approval' as const,
      attempted_amount: 30,
      spent: 90,
      limit: 100,
      currency: 'USD',
      upstream: null,
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

// ---------------------------------------------------------------------------
// Shared event mappers + callback factory (issue #292) — the projections the
// composition roots (cli.ts, the e2e harness) wire onto the bus.
// ---------------------------------------------------------------------------

describe('actionEventFromRecord (issue #292)', () => {
  it('maps every field the cli wiring mapped, including protocol_version passthrough', () => {
    const record = makeRecord({
      tool_name: 'send_email',
      session_id: 'run-a',
      session_source: 'header',
      protocol_version: '2026-07-28',
      matched_rule: 'r1',
      matched_rule_index: 0,
    })

    expect(actionEventFromRecord(record, 'evt-42')).toEqual({
      id: 'evt-42',
      tool_name: 'send_email',
      policy_decision: 'allow',
      block_reason: null,
      approval_status: null,
      session_id: 'run-a',
      session_source: 'header',
      protocol_version: '2026-07-28',
      agent_id: null,
      environment: null,
      timestamp: '2026-04-02T12:00:00Z',
      total_duration_ms: 5,
      approval_wait_ms: 0,
      proxy_compute_ms: 5,
      flagged_destructive: false,
      dry_run: false,
      matched_rule: 'r1',
      matched_rule_index: 0,
      record_kind: 'tool_call',
      origin: 'mcp',
      upstream: null,
    })
  })

  it('carries the record upstream through when set', () => {
    const event = actionEventFromRecord(makeRecord({ upstream: 'github' }), 'evt-1')
    expect(event.upstream).toBe('github')
  })
})

describe('approvalRequestedEvent (issue #292)', () => {
  it('maps the five-field ticket projection, upstream flowing through when present', () => {
    // The param is duck-typed to the fields the mapper reads, not
    // ApprovalTicket, whose upstream is optional-absent — the ticket
    // stays structurally assignable with or without the key.
    const named = approvalRequestedEvent({
      id: 't-1',
      tool_name: 'send_payment',
      channel_name: 'slack',
      requested_at: '2026-04-02T12:00:00Z',
      upstream: 'github',
    })
    expect(named).toEqual({
      ticket_id: 't-1',
      tool_name: 'send_payment',
      channel: 'slack',
      requested_at: '2026-04-02T12:00:00Z',
      upstream: 'github',
    })

    const unnamed = approvalRequestedEvent({
      id: 't-2',
      tool_name: 'send_payment',
      channel_name: 'slack',
      requested_at: '2026-04-02T12:00:00Z',
    })
    expect(unnamed.upstream).toBeNull()
  })
})

describe('limitWarningEvent (issue #292)', () => {
  it('parses upstream from partitioned keys and computes utilization', () => {
    const named = limitWarningEvent('rate', 'upstream:github:tool:x:rule:0', 1, 2)
    expect(named).toEqual({
      key: 'upstream:github:tool:x:rule:0',
      type: 'rate',
      current: 1,
      limit: 2,
      utilization: 0.5,
      upstream: 'github',
    })

    const singular = limitWarningEvent('spend', 'tool:x:rule:0', 45, 100)
    expect(singular.upstream).toBeNull()
    expect(singular.utilization).toBe(0.45)
  })
})

describe('dashboardEventCallbacks (issue #292)', () => {
  let bus: DashboardEventBus | null = null

  afterEach(() => {
    bus?.close()
    bus = null
  })

  it('wires records, tickets, and limiter states onto the bus through the mappers', () => {
    bus = new DashboardEventBus()
    const cbs = dashboardEventCallbacks(bus)
    const actions: ActionEvent[] = []
    const approvals: ApprovalRequestedEvent[] = []
    const warnings: LimitWarningEvent[] = []
    bus.on('action', (e) => actions.push(e))
    bus.on('approval_requested', (e) => approvals.push(e))
    bus.on('limit_warning', (e) => warnings.push(e))

    // onPersist takes the writer's callback shape: (record, id).
    cbs.onPersist(makeRecord(), 'evt-9')
    expect(actions[0]?.id).toBe('evt-9')
    expect(actions[0]?.tool_name).toBe('test_tool')
    expect(actions[0]?.upstream).toBeNull()

    // onApprovalSubmit takes a REAL queue-built ApprovalTicket.
    const queue = new ApprovalQueue({ cleanupIntervalMs: 0 })
    try {
      const ticket = queue.add({
        tool_name: 'send_payment',
        tool_input: { amount: 5 },
        matched_rule: 'needs-approval',
        rule_index: 0,
        channel_name: 'slack',
        session_id: 'run-a',
        timeout_ms: 60_000,
      })
      cbs.onApprovalSubmit(ticket)
      expect(approvals[0]?.ticket_id).toBe(ticket.id)
      expect(approvals[0]?.channel).toBe('slack')
      expect(approvals[0]?.upstream).toBeNull()

      // Named path: a spread VARIABLE carrying upstream (an extra property
      // on a variable is assignable where a fresh literal is not) — this
      // observes the factory's passthrough before tickets carry the field.
      const named = { ...ticket, upstream: 'github' }
      cbs.onApprovalSubmit(named)
      expect(approvals[1]?.upstream).toBe('github')
    } finally {
      queue.close()
    }

    // onRateWarning reads state.current; onSpendWarning reads current_spend.
    cbs.onRateWarning({
      key: 'upstream:github:tool:x:rule:0',
      current: 9,
      limit: 10,
      window_ms: 60_000,
      reset_at_ms: 1_000,
    })
    expect(warnings[0]).toEqual({
      key: 'upstream:github:tool:x:rule:0',
      type: 'rate',
      current: 9,
      limit: 10,
      utilization: 0.9,
      upstream: 'github',
    })

    cbs.onSpendWarning({
      key: 'tool:x:rule:0',
      current_spend: 45,
      limit: 100,
      currency: 'USD',
      window_ms: 60_000,
      reset_at_ms: 1_000,
    })
    expect(warnings[1]).toEqual({
      key: 'tool:x:rule:0',
      type: 'spend',
      current: 45,
      limit: 100,
      utilization: 0.45,
      upstream: null,
    })
  })

  it('emits policy_reload beside action for a reload record, and action alone otherwise (issue #341)', () => {
    bus = new DashboardEventBus()
    const cbs = dashboardEventCallbacks(bus)
    const actions: ActionEvent[] = []
    const reloads: PolicyReloadEvent[] = []
    bus.on('action', (e) => actions.push(e))
    bus.on('policy_reload', (e) => reloads.push(e))

    const record = buildPolicyReloadRecord(
      {
        configPath: '/etc/helio/helio.yaml',
        outcome: 'rejected_invalid',
        sha256Before: 'a'.repeat(64),
        sha256After: 'b'.repeat(64),
        ruleCountBefore: 1,
        ruleCountAfter: null,
        defaultActionBefore: 'allow',
        defaultActionAfter: null,
        budgetCountBefore: 0,
        budgetCountAfter: null,
        rulesRemoved: [],
        restartRequiredPaths: [],
        error: 'YAML parse error in /etc/helio/helio.yaml: bad indentation',
      },
      'prod',
    )
    cbs.onPersist(record, 'evt-reload')
    expect(actions).toHaveLength(1)
    expect(actions[0]?.record_kind).toBe('policy_reload')
    expect(actions[0]?.block_reason).toBe('rejected_invalid')
    expect(reloads).toEqual([
      {
        id: 'evt-reload',
        at: record.timestamp,
        outcome: 'rejected_invalid',
        config_path: '/etc/helio/helio.yaml',
        sha256_before: 'a'.repeat(64),
        sha256_after: 'b'.repeat(64),
        rule_count_before: 1,
        rule_count_after: null,
        default_action_before: 'allow',
        default_action_after: null,
        budget_count_before: 0,
        budget_count_after: null,
        rules_removed: [],
        restart_required_paths: [],
        error: 'YAML parse error in /etc/helio/helio.yaml: bad indentation',
      },
    ])

    cbs.onPersist(makeRecord(), 'evt-call')
    expect(actions).toHaveLength(2)
    expect(reloads).toHaveLength(1)
  })
})
