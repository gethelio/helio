import { describe, it, expect } from 'vitest'
import { ApprovalQueue } from './queue.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Default params for creating a ticket. */
function ticketParams(overrides?: Partial<Parameters<ApprovalQueue['add']>[0]>) {
  return {
    tool_name: 'create_payment',
    tool_input: { amount: 5000, currency: 'GBP' },
    matched_rule: 'approve-payments',
    rule_index: 0,
    channel_name: 'dashboard',
    session_id: 's1',
    timeout_ms: 300_000,
    ...overrides,
  }
}

/** Get a ticket by ID and assert it exists. */
function mustGet(queue: ApprovalQueue, id: string) {
  const ticket = queue.get(id)
  expect(ticket).toBeDefined()
  return ticket as NonNullable<typeof ticket>
}

/** Create a queue with a controllable clock and no cleanup timer. */
function createQueue(options?: { resolvedRetentionMs?: number }) {
  let time = 1_000_000
  const advance = (ms: number) => {
    time += ms
  }

  const queue = new ApprovalQueue({
    now: () => time,
    cleanupIntervalMs: 0, // disabled in tests
    resolvedRetentionMs: options?.resolvedRetentionMs,
  })

  return { queue, advance, getTime: () => time }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ApprovalQueue', () => {
  // -----------------------------------------------------------------------
  // add + get
  // -----------------------------------------------------------------------

  describe('add and get', () => {
    it('creates a ticket with a UUID and pending status', () => {
      const { queue } = createQueue()
      const ticket = queue.add(ticketParams())

      expect(ticket.id).toBeDefined()
      expect(ticket.id).toMatch(/^[0-9a-f-]{36}$/)
      expect(ticket.status).toBe('pending')
      expect(ticket.tool_name).toBe('create_payment')
      expect(ticket.tool_input).toEqual({ amount: 5000, currency: 'GBP' })
      expect(ticket.matched_rule).toBe('approve-payments')
      expect(ticket.rule_index).toBe(0)
      expect(ticket.channel_name).toBe('dashboard')
      expect(ticket.session_id).toBe('s1')
      expect(ticket.timeout_ms).toBe(300_000)
    })

    it('sets requested_at and timeout_at based on the clock', () => {
      const { queue } = createQueue()
      const ticket = queue.add(ticketParams())

      expect(ticket.requested_at).toBe(new Date(1_000_000).toISOString())
      expect(ticket.timeout_at).toBe(new Date(1_000_000 + 300_000).toISOString())
    })

    it('retrieves a stored ticket by ID', () => {
      const { queue } = createQueue()
      const ticket = queue.add(ticketParams())
      const retrieved = mustGet(queue, ticket.id)

      expect(retrieved.id).toBe(ticket.id)
    })

    it('returns undefined for an unknown ID', () => {
      const { queue } = createQueue()
      expect(queue.get('nonexistent')).toBeUndefined()
    })

    it('stores multiple tickets independently', () => {
      const { queue } = createQueue()
      const t1 = queue.add(ticketParams({ tool_name: 'tool_a' }))
      const t2 = queue.add(ticketParams({ tool_name: 'tool_b' }))

      expect(t1.id).not.toBe(t2.id)
      expect(mustGet(queue, t1.id).tool_name).toBe('tool_a')
      expect(mustGet(queue, t2.id).tool_name).toBe('tool_b')
    })

    it('stores breached budget context on break-glass tickets (issue #14)', () => {
      const { queue } = createQueue()
      const breached = [
        {
          name: 'daily-cap',
          limit: 50,
          spent: 49,
          attempted_amount: 5,
          currency: 'USD',
          window: '24h',
        },
        {
          name: 'weekly',
          limit: 500,
          spent: 498,
          attempted_amount: 5,
          currency: 'USD',
          window: '7d',
        },
      ]
      const ticket = queue.add(ticketParams({ breached_budgets: breached }))

      expect(mustGet(queue, ticket.id).breached_budgets).toEqual(breached)
    })

    it('leaves breached_budgets absent on plain rule tickets', () => {
      const { queue } = createQueue()
      const ticket = queue.add(ticketParams())
      expect('breached_budgets' in mustGet(queue, ticket.id)).toBe(false)
    })
  })

  // -----------------------------------------------------------------------
  // resolve
  // -----------------------------------------------------------------------

  describe('resolve', () => {
    it('resolves a pending ticket as approved', () => {
      const { queue } = createQueue()
      const ticket = queue.add(ticketParams())

      const result = queue.resolve(ticket.id, 'approved', 'alice')

      expect(result).toBe(true)
      const updated = mustGet(queue, ticket.id)
      expect(updated.status).toBe('approved')
      expect(updated.resolved_by).toBe('alice')
      expect(updated.resolved_at).toBeDefined()
    })

    it('resolves a pending ticket as denied with a reason', () => {
      const { queue } = createQueue()
      const ticket = queue.add(ticketParams())

      const result = queue.resolve(ticket.id, 'denied', 'bob', { denial_reason: 'Too risky' })

      expect(result).toBe(true)
      const updated = mustGet(queue, ticket.id)
      expect(updated.status).toBe('denied')
      expect(updated.resolved_by).toBe('bob')
      expect(updated.denial_reason).toBe('Too risky')
    })

    it('resolves a pending ticket as timeout', () => {
      const { queue, advance } = createQueue()
      const ticket = queue.add(ticketParams())
      advance(300_001)

      const result = queue.resolve(ticket.id, 'timeout')

      expect(result).toBe(true)
      const updated = mustGet(queue, ticket.id)
      expect(updated.status).toBe('timeout')
      expect(updated.resolved_at).toBeDefined()
    })

    it('resolves a pending ticket as shutdown_cancelled', () => {
      const { queue } = createQueue()
      const ticket = queue.add(ticketParams())

      const result = queue.resolve(ticket.id, 'shutdown_cancelled')

      expect(result).toBe(true)
      const updated = mustGet(queue, ticket.id)
      expect(updated.status).toBe('shutdown_cancelled')
      expect(updated.resolved_at).toBeDefined()
    })

    it('resolves a pending ticket as break_glass with reason', () => {
      const { queue } = createQueue()
      const ticket = queue.add(ticketParams())

      const result = queue.resolve(ticket.id, 'break_glass', 'admin', {
        break_glass_reason: 'Emergency fix',
      })

      expect(result).toBe(true)
      const updated = mustGet(queue, ticket.id)
      expect(updated.status).toBe('break_glass')
      expect(updated.resolved_by).toBe('admin')
      expect(updated.break_glass_reason).toBe('Emergency fix')
      expect(updated.resolved_at).toBeDefined()
    })

    it('returns false for a non-existent ticket', () => {
      const { queue } = createQueue()
      expect(queue.resolve('nonexistent', 'approved', 'alice')).toBe(false)
    })

    it('returns false when resolving an already-resolved ticket', () => {
      const { queue } = createQueue()
      const ticket = queue.add(ticketParams())
      queue.resolve(ticket.id, 'approved', 'alice')

      // Second resolution attempt should fail
      expect(queue.resolve(ticket.id, 'denied', 'bob')).toBe(false)
      // Status should remain approved
      expect(mustGet(queue, ticket.id).status).toBe('approved')
    })
  })

  // -----------------------------------------------------------------------
  // list
  // -----------------------------------------------------------------------

  describe('list', () => {
    it('returns an empty array when no tickets exist', () => {
      const { queue } = createQueue()
      expect(queue.list()).toHaveLength(0)
    })

    it('returns all tickets when no filter is given', () => {
      const { queue } = createQueue()
      queue.add(ticketParams({ tool_name: 'tool_a' }))
      queue.add(ticketParams({ tool_name: 'tool_b' }))

      expect(queue.list()).toHaveLength(2)
    })

    it('filters by status', () => {
      const { queue } = createQueue()
      const t1 = queue.add(ticketParams({ tool_name: 'tool_a' }))
      queue.add(ticketParams({ tool_name: 'tool_b' }))
      queue.resolve(t1.id, 'approved', 'alice')

      expect(queue.list({ status: 'pending' })).toHaveLength(1)
      expect(queue.list({ status: 'approved' })).toHaveLength(1)
      expect(queue.list({ status: 'denied' })).toHaveLength(0)
    })

    it('listPending returns only pending tickets', () => {
      const { queue } = createQueue()
      const t1 = queue.add(ticketParams({ tool_name: 'tool_a' }))
      queue.add(ticketParams({ tool_name: 'tool_b' }))
      queue.resolve(t1.id, 'approved', 'alice')

      const pending = queue.listPending()
      expect(pending).toHaveLength(1)
      expect(pending).toEqual([expect.objectContaining({ tool_name: 'tool_b' })])
    })
  })

  // -----------------------------------------------------------------------
  // cleanup
  // -----------------------------------------------------------------------

  describe('cleanup', () => {
    it('removes resolved tickets older than the retention period', () => {
      const { queue, advance } = createQueue({ resolvedRetentionMs: 60_000 })
      const ticket = queue.add(ticketParams())
      queue.resolve(ticket.id, 'approved', 'alice')

      // Not yet past retention
      advance(59_000)
      queue.cleanup()
      expect(queue.get(ticket.id)).toBeDefined()

      // Past retention
      advance(2_000)
      queue.cleanup()
      expect(queue.get(ticket.id)).toBeUndefined()
    })

    it('keeps pending tickets regardless of age', () => {
      const { queue, advance } = createQueue({ resolvedRetentionMs: 60_000 })
      const ticket = queue.add(ticketParams())

      advance(120_000)
      queue.cleanup()
      const retrieved = mustGet(queue, ticket.id)
      expect(retrieved.status).toBe('pending')
    })

    it('keeps recently resolved tickets', () => {
      const { queue } = createQueue({ resolvedRetentionMs: 60_000 })
      const ticket = queue.add(ticketParams())
      queue.resolve(ticket.id, 'denied', 'bob')

      queue.cleanup()
      expect(queue.get(ticket.id)).toBeDefined()
    })
  })

  // -----------------------------------------------------------------------
  // close
  // -----------------------------------------------------------------------

  describe('close', () => {
    it('prevents adding new tickets after close', () => {
      const { queue } = createQueue()
      queue.close()

      expect(() => queue.add(ticketParams())).toThrow('ApprovalQueue is closed')
    })
  })
})
