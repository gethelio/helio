import { describe, it, expect, vi, afterEach } from 'vitest'
import { ApprovalRouter } from './router.js'
import { ApprovalQueue } from './queue.js'
import type { ApprovalChannel, ApprovalTicket } from './types.js'
import type { CompiledPolicyRule } from '../policy/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a mock channel that records notifications. */
function mockChannel(type = 'dashboard'): ApprovalChannel & { calls: ApprovalTicket[] } {
  const calls: ApprovalTicket[] = []
  return {
    type,
    calls,
    notify(ticket: ApprovalTicket) {
      calls.push(ticket)
      return Promise.resolve()
    },
  }
}

/** Minimal compiled rule for tests. */
function makeRule(overrides?: Partial<CompiledPolicyRule>): CompiledPolicyRule {
  return {
    index: 0,
    name: 'test-rule',
    match: {},
    action: 'require_approval',
    ...overrides,
  }
}

/** Default submit params. */
function submitParams(overrides?: Partial<Parameters<ApprovalRouter['submit']>[0]>) {
  return {
    tool_name: 'create_payment',
    tool_input: { amount: 5000 },
    matched_rule: makeRule(),
    session_id: 's1',
    ...overrides,
  }
}

/** Create a router with controllable timeout (using vi.useFakeTimers). */
function createRouter(options?: {
  defaultTimeoutMs?: number
  defaultOnTimeout?: 'allow' | 'deny'
  channels?: Map<string, ApprovalChannel>
  onResolve?: (ticket: ApprovalTicket) => void
  onNotifyFailure?: (event: {
    ticket_id: string
    channel: string
    phase: 'initial' | 'escalation'
    error: string
  }) => void
}) {
  const queue = new ApprovalQueue({ cleanupIntervalMs: 0 })
  const channel = mockChannel()
  const channels = options?.channels ?? new Map([['dashboard', channel]])

  const router = new ApprovalRouter({
    defaultTimeoutMs: options?.defaultTimeoutMs ?? 300_000,
    defaultOnTimeout: options?.defaultOnTimeout ?? 'deny',
    channels,
    queue,
    onResolve: options?.onResolve,
    onNotifyFailure: options?.onNotifyFailure,
  })

  return { router, queue, channel }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ApprovalRouter', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  // -----------------------------------------------------------------------
  // submit + approve
  // -----------------------------------------------------------------------

  describe('submit and approve', () => {
    it('creates a ticket and returns a pending promise that resolves on approve', async () => {
      const { router, queue } = createRouter()

      const promise = router.submit(submitParams())

      // Ticket should be in the queue
      const pending = queue.listPending()
      expect(pending).toHaveLength(1)
      const ticketId = pending[0]?.id as string

      // Approve it
      const approved = router.approve(ticketId, 'alice')
      expect(approved).toBe(true)

      const outcome = await promise
      expect(outcome.status).toBe('approved')
      expect(outcome.ticketId).toBe(ticketId)
      if (outcome.status === 'approved') {
        expect(outcome.resolvedBy).toBe('alice')
      }
    })

    it('notifies the configured channel on submit', async () => {
      const { router, channel } = createRouter()

      const promise = router.submit(submitParams())
      const pending = channel.calls
      expect(pending).toHaveLength(1)
      expect(pending[0]?.tool_name).toBe('create_payment')

      // Clean up
      router.close()
      await promise
    })
  })

  // -----------------------------------------------------------------------
  // submit + deny
  // -----------------------------------------------------------------------

  describe('submit and deny', () => {
    it('resolves with denied status and reason', async () => {
      const { router, queue } = createRouter()

      const promise = router.submit(submitParams())
      const ticketId = queue.listPending()[0]?.id as string

      const denied = router.deny(ticketId, 'bob', 'Too risky')
      expect(denied).toBe(true)

      const outcome = await promise
      expect(outcome.status).toBe('denied')
      expect(outcome.ticketId).toBe(ticketId)
      if (outcome.status === 'denied') {
        expect(outcome.resolvedBy).toBe('bob')
        expect(outcome.reason).toBe('Too risky')
      }
    })
  })

  // -----------------------------------------------------------------------
  // timeout
  // -----------------------------------------------------------------------

  describe('timeout', () => {
    it('resolves with timeout status and timeoutMs when timer fires', async () => {
      vi.useFakeTimers()
      const { router } = createRouter({ defaultTimeoutMs: 5_000 })

      const promise = router.submit(submitParams())

      // Advance past timeout
      vi.advanceTimersByTime(5_001)

      const outcome = await promise
      expect(outcome.status).toBe('timeout')
      if (outcome.status === 'timeout') {
        expect(outcome.timeoutMs).toBe(5_000)
      }
    })

    it('uses rule-level timeout when specified', async () => {
      vi.useFakeTimers()
      const { router } = createRouter({ defaultTimeoutMs: 300_000 })

      const rule = makeRule({ approval: { channel: 'dashboard', timeoutMs: 2_000 } })
      const promise = router.submit(submitParams({ matched_rule: rule }))

      // Default timeout hasn't elapsed, but rule-level has
      vi.advanceTimersByTime(2_001)

      const outcome = await promise
      expect(outcome.status).toBe('timeout')
    })

    it('falls back to default timeout when rule has no timeout', async () => {
      vi.useFakeTimers()
      const { router } = createRouter({ defaultTimeoutMs: 3_000 })

      const rule = makeRule({ approval: { channel: 'dashboard' } })
      const promise = router.submit(submitParams({ matched_rule: rule }))

      vi.advanceTimersByTime(3_001)

      const outcome = await promise
      expect(outcome.status).toBe('timeout')
    })

    it('updates queue ticket status to timeout', async () => {
      vi.useFakeTimers()
      const { router, queue } = createRouter({ defaultTimeoutMs: 1_000 })

      const promise = router.submit(submitParams())
      const ticketId = queue.listPending()[0]?.id as string

      vi.advanceTimersByTime(1_001)
      await promise

      const ticket = queue.get(ticketId)
      expect(ticket?.status).toBe('timeout')
    })

    it('calls onResolve when a ticket times out', async () => {
      vi.useFakeTimers()
      const onResolve = vi.fn<(ticket: ApprovalTicket) => void>()
      const { router } = createRouter({ defaultTimeoutMs: 1_000, onResolve })

      const promise = router.submit(submitParams())
      vi.advanceTimersByTime(1_001)
      await promise

      expect(onResolve).toHaveBeenCalledTimes(1)
      expect(onResolve).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'timeout',
        }),
      )
    })
  })

  // -----------------------------------------------------------------------
  // client disconnect
  // -----------------------------------------------------------------------

  describe('client disconnect', () => {
    it('resolves with client_disconnected when submit signal is already aborted', async () => {
      const { router, queue } = createRouter()
      const controller = new AbortController()
      controller.abort()

      const outcome = await router.submit(submitParams(), controller.signal)
      expect(outcome.status).toBe('client_disconnected')

      const ticket = queue.get(outcome.ticketId)
      expect(ticket?.status).toBe('client_disconnected')
    })

    it('resolves with client_disconnected when signal aborts during pending hold', async () => {
      const { router, queue } = createRouter()
      const controller = new AbortController()

      const promise = router.submit(submitParams(), controller.signal)
      const ticketId = queue.listPending()[0]?.id as string
      controller.abort()

      const outcome = await promise
      expect(outcome.status).toBe('client_disconnected')
      expect(outcome.ticketId).toBe(ticketId)
      expect(queue.get(ticketId)?.status).toBe('client_disconnected')
    })

    it('settles idempotently when abort and approve race', async () => {
      const { router, queue } = createRouter()
      const controller = new AbortController()

      const promise = router.submit(submitParams(), controller.signal)
      const ticketId = queue.listPending()[0]?.id as string

      controller.abort()
      const approved = router.approve(ticketId, 'alice')
      const outcome = await promise

      expect(approved).toBe(false)
      expect(outcome.status).toBe('client_disconnected')
      expect(queue.get(ticketId)?.status).toBe('client_disconnected')
    })
  })

  // -----------------------------------------------------------------------
  // edge cases
  // -----------------------------------------------------------------------

  describe('edge cases', () => {
    it('approve on unknown ticket returns false', () => {
      const { router } = createRouter()
      expect(router.approve('nonexistent', 'alice')).toBe(false)
    })

    it('deny on unknown ticket returns false', () => {
      const { router } = createRouter()
      expect(router.deny('nonexistent', 'alice')).toBe(false)
    })

    it('approve on already-resolved ticket returns false', async () => {
      const { router, queue } = createRouter()

      const promise = router.submit(submitParams())
      const ticketId = queue.listPending()[0]?.id as string

      router.approve(ticketId, 'alice')
      await promise

      // Second attempt
      expect(router.approve(ticketId, 'bob')).toBe(false)
    })

    it('multiple concurrent approvals are isolated', async () => {
      const { router, queue } = createRouter()

      const promise1 = router.submit(submitParams({ tool_name: 'tool_a' }))
      const promise2 = router.submit(submitParams({ tool_name: 'tool_b' }))

      const pending = queue.listPending()
      expect(pending).toHaveLength(2)

      const id1 = pending.find((t) => t.tool_name === 'tool_a')?.id as string
      const id2 = pending.find((t) => t.tool_name === 'tool_b')?.id as string

      router.approve(id1, 'alice')
      router.deny(id2, 'bob')

      const outcome1 = await promise1
      const outcome2 = await promise2

      expect(outcome1.status).toBe('approved')
      expect(outcome2.status).toBe('denied')
    })

    it('uses the channel specified in the rule approval config', async () => {
      const webhookChannel = mockChannel('webhook')
      const dashboardChannel = mockChannel('dashboard')
      const channels = new Map<string, ApprovalChannel>([
        ['dashboard', dashboardChannel],
        ['webhook', webhookChannel],
      ])

      const { router } = createRouter({ channels })

      const rule = makeRule({ approval: { channel: 'webhook', timeoutMs: 5_000 } })
      const promise = router.submit(submitParams({ matched_rule: rule }))

      expect(webhookChannel.calls).toHaveLength(1)
      expect(dashboardChannel.calls).toHaveLength(0)

      // Clean up
      router.close()
      await promise
    })

    it('looks up channel by name when name differs from type', async () => {
      const namedChannel = mockChannel('webhook')
      const channels = new Map<string, ApprovalChannel>([
        ['dashboard', mockChannel('dashboard')],
        ['finance-approvals', namedChannel],
      ])

      const { router } = createRouter({ channels })

      const rule = makeRule({ approval: { channel: 'finance-approvals', timeoutMs: 5_000 } })
      const promise = router.submit(submitParams({ matched_rule: rule }))

      expect(namedChannel.calls).toHaveLength(1)

      router.close()
      await promise
    })

    it('defaults to dashboard channel when rule has no channel', async () => {
      const { router, channel } = createRouter()

      const rule = makeRule({ approval: undefined })
      const promise = router.submit(submitParams({ matched_rule: rule }))

      expect(channel.calls).toHaveLength(1)

      router.close()
      await promise
    })
  })

  // -----------------------------------------------------------------------
  // escalation
  // -----------------------------------------------------------------------

  describe('escalation', () => {
    it('notifies delegates after escalation_after duration', async () => {
      vi.useFakeTimers()
      const primaryChannel = mockChannel('dashboard')
      const delegateChannel = mockChannel('webhook')
      const channels = new Map<string, ApprovalChannel>([
        ['dashboard', primaryChannel],
        ['fallback', delegateChannel],
      ])

      const { router, queue } = createRouter({ channels, defaultTimeoutMs: 10_000 })

      const rule = makeRule({
        approval: {
          channel: 'dashboard',
          timeoutMs: 10_000,
          delegates: ['fallback'],
          escalationAfterMs: 3_000,
        },
      })
      const promise = router.submit(submitParams({ matched_rule: rule }))

      // Primary notified immediately
      expect(primaryChannel.calls).toHaveLength(1)
      expect(delegateChannel.calls).toHaveLength(0)

      // Advance past escalation but not timeout
      vi.advanceTimersByTime(3_001)

      // Delegate should now be notified
      expect(delegateChannel.calls).toHaveLength(1)
      expect(delegateChannel.calls[0]?.tool_name).toBe('create_payment')

      // Ticket should have escalation metadata
      const ticketId = queue.listPending()[0]?.id as string
      const ticket = queue.get(ticketId)
      expect(ticket?.escalated_at).toBeDefined()
      expect(ticket?.escalated_to).toEqual(['fallback'])

      // Clean up — advance to timeout
      vi.advanceTimersByTime(7_000)
      await promise
    })

    it('re-notifies primary channel when no delegates configured', async () => {
      vi.useFakeTimers()
      const primaryChannel = mockChannel('dashboard')
      const channels = new Map<string, ApprovalChannel>([['dashboard', primaryChannel]])

      const { router } = createRouter({ channels, defaultTimeoutMs: 10_000 })

      const rule = makeRule({
        approval: {
          channel: 'dashboard',
          timeoutMs: 10_000,
          escalationAfterMs: 3_000,
        },
      })
      const promise = router.submit(submitParams({ matched_rule: rule }))

      // 1 initial notification
      expect(primaryChannel.calls).toHaveLength(1)

      vi.advanceTimersByTime(3_001)

      // 2nd notification (escalation re-notifies same channel)
      expect(primaryChannel.calls).toHaveLength(2)

      router.close()
      await promise
    })

    it('does not fire escalation if ticket is approved before escalation_after', async () => {
      vi.useFakeTimers()
      const delegateChannel = mockChannel('webhook')
      const channels = new Map<string, ApprovalChannel>([
        ['dashboard', mockChannel('dashboard')],
        ['fallback', delegateChannel],
      ])

      const { router, queue } = createRouter({ channels, defaultTimeoutMs: 10_000 })

      const rule = makeRule({
        approval: {
          channel: 'dashboard',
          timeoutMs: 10_000,
          delegates: ['fallback'],
          escalationAfterMs: 5_000,
        },
      })
      const promise = router.submit(submitParams({ matched_rule: rule }))
      const ticketId = queue.listPending()[0]?.id as string

      // Approve before escalation fires
      vi.advanceTimersByTime(2_000)
      router.approve(ticketId, 'alice')

      const outcome = await promise
      expect(outcome.status).toBe('approved')

      // Advance past escalation — should not fire
      vi.advanceTimersByTime(4_000)
      expect(delegateChannel.calls).toHaveLength(0)
    })

    it('logs warning when escalation notification fails', async () => {
      vi.useFakeTimers()
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const failingChannel: ApprovalChannel = {
        type: 'webhook',
        notify: () => Promise.reject(new Error('webhook down')),
      }
      const channels = new Map<string, ApprovalChannel>([
        ['dashboard', mockChannel('dashboard')],
        ['failing', failingChannel],
      ])

      const { router } = createRouter({ channels, defaultTimeoutMs: 10_000 })

      const rule = makeRule({
        approval: {
          channel: 'dashboard',
          timeoutMs: 10_000,
          delegates: ['failing'],
          escalationAfterMs: 1_000,
        },
      })
      const promise = router.submit(submitParams({ matched_rule: rule }))

      // Advance past escalation to trigger the failing delegate
      vi.advanceTimersByTime(1_001)
      // Let the rejected promise flush
      await vi.advanceTimersByTimeAsync(0)

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Escalation notification failed for "failing"'),
      )

      errorSpy.mockRestore()
      router.close()
      await promise
    })

    it('logs warning when initial notification fails', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const failingChannel: ApprovalChannel = {
        type: 'dashboard',
        notify: () => Promise.reject(new Error('dashboard unreachable')),
      }
      const channels = new Map<string, ApprovalChannel>([['dashboard', failingChannel]])
      const { router } = createRouter({ channels })

      const promise = router.submit(submitParams())
      await Promise.resolve()

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Approval notification failed for "dashboard"'),
      )

      errorSpy.mockRestore()
      router.close()
      await promise
    })

    it('emits onNotifyFailure callback for initial and escalation delivery failures', async () => {
      vi.useFakeTimers()
      const failingChannel: ApprovalChannel = {
        type: 'dashboard',
        notify: () => Promise.reject(new Error('outage')),
      }
      const channels = new Map<string, ApprovalChannel>([['dashboard', failingChannel]])
      const onNotifyFailure =
        vi.fn<
          (event: {
            ticket_id: string
            channel: string
            phase: 'initial' | 'escalation'
            error: string
          }) => void
        >()
      const { router, queue } = createRouter({
        channels,
        defaultTimeoutMs: 5_000,
        onNotifyFailure,
      })

      const rule = makeRule({
        approval: {
          channel: 'dashboard',
          timeoutMs: 5_000,
          escalationAfterMs: 1_000,
        },
      })
      const promise = router.submit(submitParams({ matched_rule: rule }))

      // Initial notify rejection
      await vi.advanceTimersByTimeAsync(0)
      // Escalation notify rejection
      await vi.advanceTimersByTimeAsync(1_001)

      expect(onNotifyFailure).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'dashboard',
          phase: 'initial',
        }),
      )
      expect(onNotifyFailure).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'dashboard',
          phase: 'escalation',
        }),
      )

      const pendingTicket = queue.listPending()[0]
      expect(pendingTicket?.notification_failures).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            channel: 'dashboard',
            phase: 'initial',
            error: 'outage',
          }),
          expect.objectContaining({
            channel: 'dashboard',
            phase: 'escalation',
            error: 'outage',
          }),
        ]),
      )

      router.close()
      await promise
    })

    it('does not create escalation timer when escalationAfterMs >= timeoutMs', async () => {
      vi.useFakeTimers()
      const delegateChannel = mockChannel('webhook')
      const channels = new Map<string, ApprovalChannel>([
        ['dashboard', mockChannel('dashboard')],
        ['fallback', delegateChannel],
      ])

      const { router } = createRouter({ channels, defaultTimeoutMs: 5_000 })

      const rule = makeRule({
        approval: {
          channel: 'dashboard',
          timeoutMs: 5_000,
          delegates: ['fallback'],
          escalationAfterMs: 5_000, // Equal to timeout — should not create escalation timer
        },
      })
      const promise = router.submit(submitParams({ matched_rule: rule }))

      vi.advanceTimersByTime(5_001)
      await promise

      // Delegate should never be notified
      expect(delegateChannel.calls).toHaveLength(0)
    })
  })

  // -----------------------------------------------------------------------
  // break-glass
  // -----------------------------------------------------------------------

  describe('breakGlass', () => {
    it('resolves pending ticket with break_glass status', async () => {
      const { router, queue } = createRouter()

      const promise = router.submit(submitParams())
      const ticketId = queue.listPending()[0]?.id as string

      const resolved = router.breakGlass(ticketId, 'admin', 'Emergency override')
      expect(resolved).toBe(true)

      const outcome = await promise
      expect(outcome.status).toBe('break_glass')
      expect(outcome.ticketId).toBe(ticketId)
      if (outcome.status === 'break_glass') {
        expect(outcome.resolvedBy).toBe('admin')
        expect(outcome.reason).toBe('Emergency override')
      }

      // Queue ticket should be resolved with reason
      const ticket = queue.get(ticketId)
      expect(ticket?.status).toBe('break_glass')
      expect(ticket?.resolved_by).toBe('admin')
      expect(ticket?.break_glass_reason).toBe('Emergency override')
    })

    it('returns false for unknown ticket', () => {
      const { router } = createRouter()
      expect(router.breakGlass('nonexistent', 'admin', 'reason')).toBe(false)
    })

    it('returns false for already-resolved ticket', async () => {
      const { router, queue } = createRouter()

      const promise = router.submit(submitParams())
      const ticketId = queue.listPending()[0]?.id as string

      router.approve(ticketId, 'alice')
      await promise

      expect(router.breakGlass(ticketId, 'admin', 'reason')).toBe(false)
    })

    it('clears both timeout and escalation timers', async () => {
      vi.useFakeTimers()
      const delegateChannel = mockChannel('webhook')
      const channels = new Map<string, ApprovalChannel>([
        ['dashboard', mockChannel('dashboard')],
        ['fallback', delegateChannel],
      ])

      const { router, queue } = createRouter({ channels, defaultTimeoutMs: 10_000 })

      const rule = makeRule({
        approval: {
          channel: 'dashboard',
          timeoutMs: 10_000,
          delegates: ['fallback'],
          escalationAfterMs: 3_000,
        },
      })
      const promise = router.submit(submitParams({ matched_rule: rule }))
      const ticketId = queue.listPending()[0]?.id as string

      // Break-glass before escalation fires
      vi.advanceTimersByTime(1_000)
      router.breakGlass(ticketId, 'admin', 'Critical fix')
      await promise

      // Advance past both escalation and timeout — neither should fire
      vi.advanceTimersByTime(15_000)
      expect(delegateChannel.calls).toHaveLength(0)
    })
  })

  // -----------------------------------------------------------------------
  // close
  // -----------------------------------------------------------------------

  describe('close', () => {
    it('resolves all pending promises with shutdown_cancelled', async () => {
      const { router } = createRouter()

      const promise1 = router.submit(submitParams({ tool_name: 'tool_a' }))
      const promise2 = router.submit(submitParams({ tool_name: 'tool_b' }))

      router.close()

      const outcome1 = await promise1
      const outcome2 = await promise2

      expect(outcome1.status).toBe('shutdown_cancelled')
      expect(outcome2.status).toBe('shutdown_cancelled')
    })

    it('returns denied outcome for submissions after close', async () => {
      const { router } = createRouter()
      router.close()

      const outcome = await router.submit(submitParams())
      expect(outcome.status).toBe('denied')
    })
  })

  // -----------------------------------------------------------------------
  // Native (adapter-owned) tickets — issue #12, D10
  // -----------------------------------------------------------------------

  describe('native tickets', () => {
    function createNativeRouter() {
      const queue = new ApprovalQueue({ cleanupIntervalMs: 0 })
      const channel = mockChannel()
      const submitted: ApprovalTicket[] = []
      const resolved: ApprovalTicket[] = []
      const router = new ApprovalRouter({
        defaultTimeoutMs: 300_000,
        defaultOnTimeout: 'deny',
        channels: new Map([['dashboard', channel]]),
        queue,
        onSubmit: (t) => submitted.push(t),
        onResolve: (t) => resolved.push(t),
      })
      return { router, queue, channel, submitted, resolved }
    }

    it('creates a native:<origin> ticket and fires onSubmit but not the channel', () => {
      const { router, queue, channel, submitted } = createNativeRouter()

      const ticket = router.createNativeTicket({
        tool_name: 'send',
        tool_input: { text: 'hi' },
        matched_rule: makeRule(),
        session_id: 's1',
        origin: 'openclaw',
      })

      expect(ticket.channel_name).toBe('native:openclaw')
      expect(queue.get(ticket.id)?.status).toBe('pending')
      expect(submitted).toHaveLength(1) // approval_requested SSE flows
      expect(channel.calls).toHaveLength(0) // no double-notify
    })

    it('does not start a timeout timer (no auto-resolution)', () => {
      vi.useFakeTimers()
      const { router, queue } = createNativeRouter()
      const ticket = router.createNativeTicket({
        tool_name: 'send',
        tool_input: {},
        matched_rule: makeRule({ approval: { channel: 'dashboard', timeoutMs: 1000 } }),
        session_id: null,
        origin: 'openclaw',
      })
      vi.advanceTimersByTime(5000)
      expect(queue.get(ticket.id)?.status).toBe('pending') // never auto-timed-out
    })

    it('resolveNativeTicket resolves and fires onResolve', () => {
      const { router, queue, resolved } = createNativeRouter()
      const ticket = router.createNativeTicket({
        tool_name: 'send',
        tool_input: {},
        matched_rule: makeRule(),
        session_id: null,
        origin: 'openclaw',
      })

      const ok = router.resolveNativeTicket(ticket.id, 'approved', 'telegram:@oli')
      expect(ok).toBe(true)
      expect(queue.get(ticket.id)?.status).toBe('approved')
      expect(queue.get(ticket.id)?.resolved_by).toBe('telegram:@oli')
      expect(resolved).toHaveLength(1)
    })

    it('supports the cancelled resolution', () => {
      const { router, queue } = createNativeRouter()
      const ticket = router.createNativeTicket({
        tool_name: 'send',
        tool_input: {},
        matched_rule: makeRule(),
        session_id: null,
        origin: 'openclaw',
      })
      expect(router.resolveNativeTicket(ticket.id, 'cancelled')).toBe(true)
      expect(queue.get(ticket.id)?.status).toBe('cancelled')
    })

    it('refuses to resolve a router-managed (submit) ticket as native', async () => {
      const { router, queue } = createNativeRouter()
      const promise = router.submit(submitParams())
      const ticketId = queue.listPending()[0]?.id as string

      // The submit ticket is not native; resolveNativeTicket must refuse it so
      // the held promise is never left hanging.
      expect(router.resolveNativeTicket(ticketId, 'approved', 'x')).toBe(false)
      expect(queue.get(ticketId)?.status).toBe('pending')

      // Clean up the still-pending promise.
      router.approve(ticketId, 'admin')
      await promise
    })

    it('returns false for an unknown ticket id', () => {
      const { router } = createNativeRouter()
      expect(router.resolveNativeTicket('nope', 'approved')).toBe(false)
    })
  })

  // -----------------------------------------------------------------------
  // budget break-glass tickets (issue #14)
  // -----------------------------------------------------------------------

  describe('budget break-glass tickets (issue #14)', () => {
    const breached = [
      {
        name: 'daily-cap',
        limit: 50,
        spent: 49,
        attempted_amount: 5,
        currency: 'USD',
        window: '24h',
      },
    ]

    it('threads breached_budgets onto the queue ticket and the notification', async () => {
      const { router, queue, channel } = createRouter()

      const promise = router.submit(submitParams({ breached_budgets: breached }))
      const ticket = queue.listPending()[0]
      expect(ticket?.breached_budgets).toEqual(breached)
      expect(channel.calls[0]?.breached_budgets).toEqual(breached)

      router.close()
      await promise
    })

    it('the submit-level approval override wins over the matched rule config', async () => {
      const oncall = mockChannel('slack')
      const dashboard = mockChannel('dashboard')
      const channels = new Map<string, ApprovalChannel>([
        ['dashboard', dashboard],
        ['oncall', oncall],
      ])
      vi.useFakeTimers()
      const { router, queue } = createRouter({ channels, defaultTimeoutMs: 300_000 })

      // The matched rule (say, an allow rule that happens to carry approval
      // config) must NOT influence a budget ticket: the override is total.
      const rule = makeRule({ approval: { channel: 'dashboard', timeoutMs: 60_000 } })
      const promise = router.submit(
        submitParams({
          matched_rule: rule,
          breached_budgets: breached,
          approval: { channel: 'oncall', timeoutMs: 2_000 },
        }),
      )

      expect(oncall.calls).toHaveLength(1)
      expect(dashboard.calls).toHaveLength(0)
      expect(queue.listPending()[0]?.timeout_ms).toBe(2_000)

      vi.advanceTimersByTime(2_001)
      const outcome = await promise
      expect(outcome.status).toBe('timeout')
      if (outcome.status === 'timeout') expect(outcome.timeoutMs).toBe(2_000)
    })

    it('override escalation fires via the override delegates', async () => {
      const delegate = mockChannel('slack')
      const dashboard = mockChannel('dashboard')
      const channels = new Map<string, ApprovalChannel>([
        ['dashboard', dashboard],
        ['oncall-backup', delegate],
      ])
      vi.useFakeTimers()
      const { router, queue } = createRouter({ channels })

      const promise = router.submit(
        submitParams({
          matched_rule: undefined,
          breached_budgets: breached,
          approval: {
            channel: 'dashboard',
            timeoutMs: 10_000,
            delegates: ['oncall-backup'],
            escalationAfterMs: 1_000,
          },
        }),
      )

      vi.advanceTimersByTime(1_001)
      expect(delegate.calls).toHaveLength(1)
      const ticket = queue.listPending()[0]
      expect(ticket?.escalated_to).toEqual(['oncall-backup'])

      router.close()
      await promise
    })

    it('an override without a timeout falls back to the router default, not the rule', async () => {
      vi.useFakeTimers()
      const { router, queue } = createRouter({ defaultTimeoutMs: 7_000 })

      const rule = makeRule({ approval: { channel: 'dashboard', timeoutMs: 1_000 } })
      const promise = router.submit(
        submitParams({
          matched_rule: rule,
          breached_budgets: breached,
          approval: { channel: 'dashboard' },
        }),
      )

      expect(queue.listPending()[0]?.timeout_ms).toBe(7_000)
      router.close()
      await promise
    })

    it('createNativeTicket carries breached_budgets', () => {
      const { router } = createRouter()
      const ticket = router.createNativeTicket({
        tool_name: 'stripe_charge',
        tool_input: { amount: 5 },
        matched_rule: undefined,
        session_id: null,
        origin: 'openclaw',
        breached_budgets: breached,
      })
      expect(router.getTicket(ticket.id)?.breached_budgets).toEqual(breached)
    })
  })
})
