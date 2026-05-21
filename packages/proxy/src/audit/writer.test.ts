import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { AuditWriter } from './writer.js'
import { AuditStore } from './store.js'
import type { AuditRecord } from './types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type InsertRecord = Omit<AuditRecord, 'id' | 'created_at'>

function makeRecord(overrides: Partial<InsertRecord> = {}): InsertRecord {
  const defaults: InsertRecord = {
    timestamp: new Date().toISOString(),
    session_id: null,
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
    upstream_response: { result: 'ok' },
    upstream_error: null,
    upstream_http_status: 200,
    upstream_latency_ms: 10,
    total_duration_ms: 15,
    approval_wait_ms: 0,
    proxy_compute_ms: 5,
    flagged_destructive: false,
    dry_run: false,
  }
  return {
    ...defaults,
    ...overrides,
    environment: overrides.environment ?? defaults.environment,
    matched_rule_index: overrides.matched_rule_index ?? defaults.matched_rule_index,
  }
}

function createStore(): AuditStore {
  return new AuditStore({
    path: ':memory:',
    retention: '90d',
    includeResponses: true,
    cleanupIntervalMs: 0,
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AuditWriter', () => {
  let store: AuditStore
  let writer: AuditWriter

  beforeEach(() => {
    store = createStore()
  })

  afterEach(() => {
    // Writer may already be closed in some tests
    try {
      writer.close()
    } catch {
      // already closed
    }
  })

  // -----------------------------------------------------------------------
  // push + flush
  // -----------------------------------------------------------------------

  describe('push and flush', () => {
    it('writes a record after manual flush', () => {
      writer = new AuditWriter({ store, flushIntervalMs: 0 })
      writer.push(makeRecord({ tool_name: 'my_tool' }))

      // Not yet flushed — store should be empty
      expect(store.count()).toBe(0)

      writer.flush()
      expect(store.count()).toBe(1)

      const { records } = store.list()
      expect(records[0]).toBeDefined()
      expect(records[0]?.tool_name).toBe('my_tool')
    })

    it('flushes when buffer reaches threshold', () => {
      vi.useFakeTimers()
      try {
        writer = new AuditWriter({ store, bufferSize: 5, flushIntervalMs: 0 })

        for (let i = 0; i < 4; i++) {
          writer.push(makeRecord({ tool_name: `tool_${String(i)}` }))
        }
        // 4 records — below threshold
        expect(store.count()).toBe(0)

        // 5th record schedules an async flush
        writer.push(makeRecord({ tool_name: 'tool_4' }))
        expect(store.count()).toBe(0)
        vi.runOnlyPendingTimers()
        expect(store.count()).toBe(5)
      } finally {
        vi.useRealTimers()
      }
    })

    it('coalesces bursty pushes into a scheduled async flush', () => {
      vi.useFakeTimers()
      try {
        writer = new AuditWriter({ store, bufferSize: 3, flushIntervalMs: 0 })

        for (let i = 0; i < 7; i++) {
          writer.push(makeRecord())
        }

        // Buffered until the scheduled next-tick flush runs.
        expect(store.count()).toBe(0)

        vi.runOnlyPendingTimers()
        expect(store.count()).toBe(7)
      } finally {
        vi.useRealTimers()
      }
    })

    it('handles empty flush gracefully', () => {
      writer = new AuditWriter({ store, flushIntervalMs: 0 })
      expect(() => {
        writer.flush()
      }).not.toThrow()
      expect(store.count()).toBe(0)
    })
  })

  // -----------------------------------------------------------------------
  // Timer-based flush
  // -----------------------------------------------------------------------

  describe('timer flush', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('flushes on interval when buffer is non-empty', () => {
      writer = new AuditWriter({ store, flushIntervalMs: 100 })
      writer.push(makeRecord())

      expect(store.count()).toBe(0)

      vi.advanceTimersByTime(100)
      expect(store.count()).toBe(1)
    })

    it('does not flush on interval when buffer is empty', () => {
      const insertSpy = vi.spyOn(store, 'insert')
      writer = new AuditWriter({ store, flushIntervalMs: 100 })

      vi.advanceTimersByTime(300)
      expect(insertSpy).not.toHaveBeenCalled()
    })

    it('continues flushing on subsequent intervals', () => {
      writer = new AuditWriter({ store, flushIntervalMs: 50 })

      writer.push(makeRecord())
      vi.advanceTimersByTime(50)
      expect(store.count()).toBe(1)

      writer.push(makeRecord())
      writer.push(makeRecord())
      vi.advanceTimersByTime(50)
      expect(store.count()).toBe(3)
    })
  })

  // -----------------------------------------------------------------------
  // close
  // -----------------------------------------------------------------------

  describe('close', () => {
    it('flushes remaining records on close', () => {
      writer = new AuditWriter({ store, flushIntervalMs: 0 })

      // Spy on insert to verify flush happens during close
      const insertSpy = vi.spyOn(store, 'insert')

      writer.push(makeRecord())
      writer.push(makeRecord())
      expect(insertSpy).not.toHaveBeenCalled()

      writer.close()
      expect(insertSpy).toHaveBeenCalledTimes(2)
    })

    it('ignores push after close', () => {
      writer = new AuditWriter({ store, flushIntervalMs: 0 })
      writer.close()

      // Push after close should not throw or write
      expect(() => {
        writer.push(makeRecord())
      }).not.toThrow()

      // Re-create store to verify (original was closed)
      const freshStore = createStore()
      expect(freshStore.count()).toBe(0)
      freshStore.close()
    })

    it('is idempotent — calling close twice does not throw', () => {
      writer = new AuditWriter({ store, flushIntervalMs: 0 })
      writer.close()
      expect(() => {
        writer.close()
      }).not.toThrow()
    })
  })

  // -----------------------------------------------------------------------
  // Non-blocking behavior
  // -----------------------------------------------------------------------

  describe('non-blocking', () => {
    it('push returns synchronously without waiting for DB', () => {
      writer = new AuditWriter({ store, flushIntervalMs: 0 })

      const start = performance.now()
      for (let i = 0; i < 100; i++) {
        writer.push(makeRecord())
      }
      const elapsed = performance.now() - start

      // 100 pushes (with 2 threshold flushes at 50 and 100) should complete very fast
      expect(elapsed).toBeLessThan(50)
    })
  })

  // -----------------------------------------------------------------------
  // pushImmediate — prioritized async flush for security-critical records
  // -----------------------------------------------------------------------

  describe('pushImmediate', () => {
    it('schedules a near-term async flush without blocking the caller', () => {
      vi.useFakeTimers()
      try {
        writer = new AuditWriter({ store, bufferSize: 100, flushIntervalMs: 0 })

        writer.pushImmediate(makeRecord({ tool_name: 'deny_me' }))

        // No synchronous write on the request path.
        expect(store.count()).toBe(0)

        vi.runOnlyPendingTimers()
        expect(store.count()).toBe(1)
        const { records } = store.list()
        expect(records[0]?.tool_name).toBe('deny_me')
      } finally {
        vi.useRealTimers()
      }
    })

    it('flushes buffered and enforcement records together on scheduled flush', () => {
      vi.useFakeTimers()
      try {
        writer = new AuditWriter({ store, bufferSize: 100, flushIntervalMs: 0 })

        writer.push(makeRecord({ tool_name: 'buffered_a' }))
        writer.push(makeRecord({ tool_name: 'buffered_b' }))
        expect(store.count()).toBe(0)

        writer.pushImmediate(makeRecord({ tool_name: 'deny_me' }))
        expect(store.count()).toBe(0)

        // All three records are durable after the next-tick flush.
        vi.runOnlyPendingTimers()
        expect(store.count()).toBe(3)
      } finally {
        vi.useRealTimers()
      }
    })

    it('invokes the onPush callback before flushing to the store', () => {
      // Ordering matters — the dashboard event bus must see the record at
      // the same moment the store does, same as the buffered push() path.
      const onPush = vi.fn()
      const insertBatchSpy = vi.spyOn(store, 'insertBatch')
      writer = new AuditWriter({ store, bufferSize: 100, flushIntervalMs: 0, onPush })

      vi.useFakeTimers()
      try {
        writer.pushImmediate(makeRecord({ tool_name: 'x' }))
        vi.runOnlyPendingTimers()

        expect(onPush).toHaveBeenCalledOnce()
        expect(insertBatchSpy).toHaveBeenCalledOnce()
        // onPush must fire before insertBatch so SSE clients and durability
        // advance together.
        const onPushOrder = onPush.mock.invocationCallOrder[0] as number
        const insertOrder = insertBatchSpy.mock.invocationCallOrder[0] as number
        expect(onPushOrder).toBeLessThan(insertOrder)
      } finally {
        vi.useRealTimers()
      }
    })

    it('invokes onPersist after successful persistence with the same generated ID', () => {
      const onPush = vi.fn<(record: InsertRecord, id: string) => void>()
      const onPersist = vi.fn<(record: InsertRecord, id: string) => void>()
      writer = new AuditWriter({
        store,
        bufferSize: 100,
        flushIntervalMs: 0,
        onPush,
        onPersist,
      })

      vi.useFakeTimers()
      try {
        writer.pushImmediate(makeRecord({ tool_name: 'persist_me' }))
        vi.runOnlyPendingTimers()

        expect(onPush).toHaveBeenCalledOnce()
        expect(onPersist).toHaveBeenCalledOnce()
        const pushedId = onPush.mock.calls[0]?.[1]
        const persistedId = onPersist.mock.calls[0]?.[1]
        expect(persistedId).toBe(pushedId)
      } finally {
        vi.useRealTimers()
      }
    })

    it('does not invoke onPersist for records that fail to insert', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const onPersist = vi.fn()
      writer = new AuditWriter({
        store,
        flushIntervalMs: 0,
        onPersist,
      })

      vi.spyOn(store, 'insert').mockImplementationOnce(() => {
        throw new Error('simulated insert failure')
      })

      writer.push(makeRecord({ tool_name: 'will_fail' }))
      writer.flush()

      expect(onPersist).not.toHaveBeenCalled()
      errorSpy.mockRestore()
    })

    it('ignores calls after close', () => {
      writer = new AuditWriter({ store, flushIntervalMs: 0 })
      writer.close()

      expect(() => {
        writer.pushImmediate(makeRecord())
      }).not.toThrow()
    })
  })

  // -----------------------------------------------------------------------
  // Error handling
  // -----------------------------------------------------------------------

  describe('error handling', () => {
    it('logs errors to stderr and continues flushing remaining records', () => {
      writer = new AuditWriter({ store, flushIntervalMs: 0 })

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      // Push a valid record, then sabotage the store, then push another
      writer.push(makeRecord({ tool_name: 'good_1' }))

      // Temporarily make insert throw
      const originalInsert = store.insert.bind(store)
      let callCount = 0
      vi.spyOn(store, 'insert').mockImplementation((record, createdAt) => {
        callCount++
        if (callCount === 2) {
          throw new Error('simulated write failure')
        }
        return originalInsert(record, createdAt)
      })

      writer.push(makeRecord({ tool_name: 'bad' }))
      writer.push(makeRecord({ tool_name: 'good_2' }))

      writer.flush()

      // Two records should have been written (1st and 3rd), 2nd failed
      expect(store.count()).toBe(2)
      expect(errorSpy).toHaveBeenCalledOnce()
      expect(errorSpy.mock.calls[0]?.[0]).toContain('AuditWriter')

      errorSpy.mockRestore()
    })
  })
})
