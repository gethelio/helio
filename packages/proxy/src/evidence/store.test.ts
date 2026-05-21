import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EvidenceStore } from './store.js'
import type { EvidenceEntry } from './types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a store with a controllable clock and no cleanup timer. */
function createStore(options?: {
  ttl?: number
  now?: () => number
  cleanupIntervalMs?: number
  sessionInactivityMs?: number
  allowedEvidenceKeys?: readonly string[]
}) {
  let time = 1_000_000
  const clock = options?.now ?? (() => time)
  const advance = (ms: number) => {
    time += ms
  }

  const store = new EvidenceStore({
    defaultTtlSeconds: options?.ttl ?? 300,
    cleanupIntervalMs: options?.cleanupIntervalMs ?? 0, // disabled by default in tests
    sessionInactivityMs: options?.sessionInactivityMs ?? 3_600_000,
    allowedEvidenceKeys: options?.allowedEvidenceKeys,
    now: clock,
  })

  return { store, advance, getTime: () => time }
}

/** Get evidence and assert it exists. */
function mustGetEvidence(store: EvidenceStore, session_id: string, key: string): EvidenceEntry {
  const entry = store.getEvidence(session_id, key)
  expect(entry).toBeDefined()
  return entry as EvidenceEntry
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EvidenceStore', () => {
  // -----------------------------------------------------------------------
  // putEvidence + getEvidence
  // -----------------------------------------------------------------------

  describe('putEvidence and getEvidence', () => {
    it('stores and retrieves an evidence entry', () => {
      const { store } = createStore()
      store.putEvidence('s1', {
        evidence_key: 'orders.lookup',
        data: { orderId: 123 },
        tool_name: 'get_order',
      })

      const entry = mustGetEvidence(store, 's1', 'orders.lookup')
      expect(entry.evidence_key).toBe('orders.lookup')
      expect(entry.data).toEqual({ orderId: 123 })
      expect(entry.tool_name).toBe('get_order')
      expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    })

    it('overwrites an existing evidence entry with the same key', () => {
      const { store } = createStore()
      store.putEvidence('s1', {
        evidence_key: 'orders.lookup',
        data: { orderId: 1 },
        tool_name: 'get_order',
      })
      store.putEvidence('s1', {
        evidence_key: 'orders.lookup',
        data: { orderId: 2 },
        tool_name: 'get_order_v2',
      })

      const entry = mustGetEvidence(store, 's1', 'orders.lookup')
      expect(entry.data).toEqual({ orderId: 2 })
      expect(entry.tool_name).toBe('get_order_v2')
    })

    it('isolates evidence between sessions', () => {
      const { store } = createStore()
      store.putEvidence('s1', {
        evidence_key: 'key1',
        data: 'a',
        tool_name: 'tool_a',
      })
      store.putEvidence('s2', {
        evidence_key: 'key1',
        data: 'b',
        tool_name: 'tool_b',
      })

      expect(mustGetEvidence(store, 's1', 'key1').data).toBe('a')
      expect(mustGetEvidence(store, 's2', 'key1').data).toBe('b')
    })

    it('applies the default TTL', () => {
      const { store } = createStore({ ttl: 60 })
      store.putEvidence('s1', {
        evidence_key: 'k',
        data: null,
        tool_name: 't',
      })

      const entry = mustGetEvidence(store, 's1', 'k')
      // expires_at = now (1_000_000) + 60 * 1000 = 1_060_000
      expect(entry.expires_at).toBe(1_060_000)
    })

    it('returns undefined for missing session', () => {
      const { store } = createStore()
      expect(store.getEvidence('nonexistent', 'key')).toBeUndefined()
    })

    it('returns undefined for missing evidence key', () => {
      const { store } = createStore()
      store.putEvidence('s1', {
        evidence_key: 'exists',
        data: 1,
        tool_name: 't',
      })
      expect(store.getEvidence('s1', 'missing')).toBeUndefined()
    })
  })

  // -----------------------------------------------------------------------
  // TTL expiry
  // -----------------------------------------------------------------------

  describe('TTL expiry', () => {
    it('returns undefined for expired evidence (lazy eviction)', () => {
      const { store, advance } = createStore({ ttl: 5 })
      store.putEvidence('s1', {
        evidence_key: 'k',
        data: 'val',
        tool_name: 't',
      })

      expect(store.getEvidence('s1', 'k')).toBeDefined()

      advance(5_001) // past the 5s TTL
      expect(store.getEvidence('s1', 'k')).toBeUndefined()
    })

    it('deletes the entry from the map on lazy eviction', () => {
      const { store, advance } = createStore({ ttl: 1 })
      store.putEvidence('s1', {
        evidence_key: 'k',
        data: null,
        tool_name: 't',
      })

      expect(store.evidenceCount('s1')).toBe(1)

      advance(1_001)
      store.getEvidence('s1', 'k') // triggers lazy eviction

      expect(store.evidenceCount('s1')).toBe(0)
    })

    it('respects custom TTL per entry', () => {
      const { store, advance } = createStore({ ttl: 300 })
      store.putEvidence('s1', {
        evidence_key: 'short',
        data: null,
        tool_name: 't',
        ttl_seconds: 2,
      })
      store.putEvidence('s1', {
        evidence_key: 'long',
        data: null,
        tool_name: 't',
        ttl_seconds: 600,
      })

      advance(3_000) // 3s — past short TTL, within long TTL
      expect(store.getEvidence('s1', 'short')).toBeUndefined()
      expect(store.getEvidence('s1', 'long')).toBeDefined()
    })

    it('entry at exact expiry boundary is treated as expired', () => {
      const { store, advance } = createStore({ ttl: 10 })
      store.putEvidence('s1', {
        evidence_key: 'k',
        data: null,
        tool_name: 't',
      })

      advance(10_000) // exactly at expiry
      expect(store.getEvidence('s1', 'k')).toBeUndefined()
    })
  })

  // -----------------------------------------------------------------------
  // putContext + getContext
  // -----------------------------------------------------------------------

  describe('putContext and getContext', () => {
    it('stores and retrieves a context value', () => {
      const { store } = createStore()
      store.putContext('s1', 'agent_id', 'support-bot')

      expect(store.getContext('s1', 'agent_id')).toBe('support-bot')
    })

    it('overwrites an existing context key', () => {
      const { store } = createStore()
      store.putContext('s1', 'task', 'old')
      store.putContext('s1', 'task', 'new')

      expect(store.getContext('s1', 'task')).toBe('new')
    })

    it('context is independent of evidence', () => {
      const { store } = createStore()
      store.putContext('s1', 'key', 'value')

      expect(store.getEvidence('s1', 'key')).toBeUndefined()
      expect(store.getContext('s1', 'key')).toBe('value')
    })

    it('context has no TTL', () => {
      const { store, advance } = createStore({ ttl: 1 })
      store.putContext('s1', 'persistent', true)

      advance(999_999_999) // way past any TTL
      expect(store.getContext('s1', 'persistent')).toBe(true)
    })

    it('returns undefined for missing session', () => {
      const { store } = createStore()
      expect(store.getContext('nonexistent', 'key')).toBeUndefined()
    })

    it('returns undefined for missing context key', () => {
      const { store } = createStore()
      store.putContext('s1', 'exists', 1)
      expect(store.getContext('s1', 'missing')).toBeUndefined()
    })
  })

  // -----------------------------------------------------------------------
  // getSessionState
  // -----------------------------------------------------------------------

  describe('getSessionState', () => {
    it('returns combined evidence and context', () => {
      const { store } = createStore()
      store.putEvidence('s1', {
        evidence_key: 'orders.lookup',
        data: { id: 1 },
        tool_name: 'get_order',
      })
      store.putContext('s1', 'agent_id', 'bot-1')

      const state = store.getSessionState('s1')
      expect(state.session_id).toBe('s1')
      expect(state.evidence['orders.lookup']).toBeDefined()
      expect((state.evidence['orders.lookup'] as EvidenceEntry).data).toEqual({ id: 1 })
      expect(state.context['agent_id']).toBe('bot-1')
    })

    it('excludes expired evidence', () => {
      const { store, advance } = createStore({ ttl: 5 })
      store.putEvidence('s1', {
        evidence_key: 'expired',
        data: null,
        tool_name: 't',
        ttl_seconds: 1,
      })
      store.putEvidence('s1', {
        evidence_key: 'valid',
        data: null,
        tool_name: 't',
        ttl_seconds: 600,
      })

      advance(2_000) // past the 1s TTL, within 600s
      const state = store.getSessionState('s1')

      expect(state.evidence['expired']).toBeUndefined()
      expect(state.evidence['valid']).toBeDefined()
    })

    it('does not evict expired evidence during state read', () => {
      const { store, advance } = createStore({ ttl: 1 })
      store.putEvidence('s1', {
        evidence_key: 'expired',
        data: null,
        tool_name: 't',
      })

      advance(2_000)
      const state = store.getSessionState('s1')

      expect(state.evidence['expired']).toBeUndefined()
      expect(store.evidenceCount('s1')).toBe(1)
      expect(store.hasSeenEvidence('s1', 'expired')).toBe(true)
    })

    it('returns empty state for unknown session', () => {
      const { store } = createStore()
      const state = store.getSessionState('unknown')

      expect(state.session_id).toBe('unknown')
      expect(state.evidence).toEqual({})
      expect(state.context).toEqual({})
    })

    it('includes completed tools in state', () => {
      const { store } = createStore()
      store.recordToolCall('s1', 'get_order', true)
      store.recordToolCall('s1', 'verify_customer', false)

      const state = store.getSessionState('s1')
      expect(state.completed_tools).toHaveLength(2)

      const names = state.completed_tools.map((t) => t.tool_name)
      expect(names).toContain('get_order')
      expect(names).toContain('verify_customer')

      const order = state.completed_tools.find((t) => t.tool_name === 'get_order')
      expect(order?.succeeded).toBe(true)

      const verify = state.completed_tools.find((t) => t.tool_name === 'verify_customer')
      expect(verify?.succeeded).toBe(false)
    })

    it('context persists after all evidence expires', () => {
      const { store, advance } = createStore({ ttl: 1 })
      store.putEvidence('s1', {
        evidence_key: 'k',
        data: null,
        tool_name: 't',
      })
      store.putContext('s1', 'persistent', 'yes')

      advance(2_000)
      const state = store.getSessionState('s1')

      expect(Object.keys(state.evidence)).toHaveLength(0)
      expect(state.context['persistent']).toBe('yes')
    })
  })

  // -----------------------------------------------------------------------
  // hasEvidence
  // -----------------------------------------------------------------------

  describe('hasEvidence', () => {
    it('returns true for valid evidence', () => {
      const { store } = createStore()
      store.putEvidence('s1', {
        evidence_key: 'k',
        data: null,
        tool_name: 't',
      })
      expect(store.hasEvidence('s1', 'k')).toBe(true)
    })

    it('returns false for expired evidence', () => {
      const { store, advance } = createStore({ ttl: 1 })
      store.putEvidence('s1', {
        evidence_key: 'k',
        data: null,
        tool_name: 't',
      })

      advance(2_000)
      expect(store.hasEvidence('s1', 'k')).toBe(false)
    })

    it('returns false for missing evidence key', () => {
      const { store } = createStore()
      store.putEvidence('s1', {
        evidence_key: 'exists',
        data: null,
        tool_name: 't',
      })
      expect(store.hasEvidence('s1', 'missing')).toBe(false)
    })

    it('returns false for unknown session', () => {
      const { store } = createStore()
      expect(store.hasEvidence('unknown', 'k')).toBe(false)
    })
  })

  describe('hasSeenEvidence', () => {
    it('returns true after evidence expires', () => {
      const { store, advance } = createStore({ ttl: 1 })
      store.putEvidence('s1', {
        evidence_key: 'k',
        data: null,
        tool_name: 't',
      })

      advance(2_000)
      expect(store.getEvidence('s1', 'k')).toBeUndefined()
      expect(store.hasSeenEvidence('s1', 'k')).toBe(true)
    })

    it('returns false for unknown key', () => {
      const { store } = createStore()
      expect(store.hasSeenEvidence('s1', 'missing')).toBe(false)
    })
  })

  describe('evidence key allowlist', () => {
    it('stores only allowlisted keys when configured', () => {
      const { store } = createStore({ allowedEvidenceKeys: ['allowed.key'] })
      store.putEvidence('s1', {
        evidence_key: 'allowed.key',
        data: 1,
        tool_name: 't',
      })
      store.putEvidence('s1', {
        evidence_key: 'ignored.key',
        data: 2,
        tool_name: 't',
      })

      expect(store.hasSeenEvidence('s1', 'allowed.key')).toBe(true)
      expect(store.hasSeenEvidence('s1', 'ignored.key')).toBe(false)
      expect(store.getEvidence('s1', 'allowed.key')).toBeDefined()
      expect(store.getEvidence('s1', 'ignored.key')).toBeUndefined()
    })

    it('returns structured rejection diagnostics for unknown keys', () => {
      const { store } = createStore({ allowedEvidenceKeys: ['allowed.a', 'allowed.b'] })
      const result = store.putEvidence('s1', {
        evidence_key: 'rejected.key',
        data: null,
        tool_name: 't',
      })

      expect(result).toEqual({
        stored: false,
        reason: 'key_not_in_policy_allowlist',
        rejectedKey: 'rejected.key',
        allowlist: {
          allowedKeys: ['allowed.a', 'allowed.b'],
          allowedKeyCount: 2,
          truncated: false,
        },
      })
    })

    it('caps allowlist diagnostics at 20 keys with truncation metadata', () => {
      const allowed = Array.from({ length: 25 }, (_, i) => `allowed.${String(i)}`)
      const { store } = createStore({ allowedEvidenceKeys: allowed })
      const result = store.putEvidence('s1', {
        evidence_key: 'rejected.key',
        data: null,
        tool_name: 't',
      })

      expect(result.stored).toBe(false)
      if (result.stored) return
      if (result.reason !== 'key_not_in_policy_allowlist') return
      expect(result.allowlist.allowedKeys).toHaveLength(20)
      expect(result.allowlist.allowedKeyCount).toBe(25)
      expect(result.allowlist.truncated).toBe(true)
    })

    it('warns once per key and then emits bounded suppression summaries', () => {
      const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const { store } = createStore({ allowedEvidenceKeys: ['allowed.key'] })
      try {
        store.putEvidence('s1', {
          evidence_key: 'repeat.key',
          data: null,
          tool_name: 't',
        })
        store.putEvidence('s1', {
          evidence_key: 'repeat.key',
          data: null,
          tool_name: 't',
        })

        for (let i = 0; i < 21; i += 1) {
          store.putEvidence('s1', {
            evidence_key: `unique.${String(i)}`,
            data: null,
            tool_name: 't',
          })
        }

        expect(logSpy).toHaveBeenCalledTimes(21)
        expect(logSpy.mock.calls[0]?.[0]).toContain('Evidence rejected')
        const lastCall: unknown = logSpy.mock.calls[logSpy.mock.calls.length - 1]?.[0]
        expect(typeof lastCall).toBe('string')
        if (typeof lastCall !== 'string') return
        expect(lastCall).toContain('suppressing additional unique keys')
      } finally {
        logSpy.mockRestore()
      }
    })

    it('updates allowlist dynamically', () => {
      const { store } = createStore({ allowedEvidenceKeys: ['a'] })
      store.putEvidence('s1', { evidence_key: 'a', data: 1, tool_name: 't' })
      store.putEvidence('s1', { evidence_key: 'b', data: 2, tool_name: 't' })
      store.setAllowedEvidenceKeys(['b'])
      store.putEvidence('s1', { evidence_key: 'b', data: 3, tool_name: 't' })

      expect(store.getEvidence('s1', 'a')).toBeDefined()
      expect(store.getEvidence('s1', 'b')?.data).toBe(3)
      expect(store.hasSeenEvidence('s1', 'b')).toBe(true)
    })
  })

  // -----------------------------------------------------------------------
  // recordToolCall + hasCompletedTool
  // -----------------------------------------------------------------------

  describe('recordToolCall and hasCompletedTool', () => {
    it('records and checks a tool call', () => {
      const { store } = createStore()
      store.recordToolCall('s1', 'get_order', true)

      expect(store.hasCompletedTool('s1', 'get_order')).toBe(true)
    })

    it('tracks multiple tools independently', () => {
      const { store } = createStore()
      store.recordToolCall('s1', 'get_order', true)
      store.recordToolCall('s1', 'get_customer', false)

      expect(store.hasCompletedTool('s1', 'get_order')).toBe(true)
      expect(store.hasCompletedTool('s1', 'get_customer')).toBe(true)
      expect(store.hasCompletedTool('s1', 'send_email')).toBe(false)
    })

    it('isolates tool calls between sessions', () => {
      const { store } = createStore()
      store.recordToolCall('s1', 'get_order', true)

      expect(store.hasCompletedTool('s1', 'get_order')).toBe(true)
      expect(store.hasCompletedTool('s2', 'get_order')).toBe(false)
    })

    it('records both success and failure outcomes', () => {
      const { store } = createStore()
      store.recordToolCall('s1', 'tool_ok', true)
      store.recordToolCall('s1', 'tool_fail', false)

      // Both count as "completed" regardless of outcome
      expect(store.hasCompletedTool('s1', 'tool_ok')).toBe(true)
      expect(store.hasCompletedTool('s1', 'tool_fail')).toBe(true)
    })

    it('hasSuccessfulTool distinguishes succeeded calls from failed ones', () => {
      const { store } = createStore()
      store.recordToolCall('s1', 'tool_ok', true)
      store.recordToolCall('s1', 'tool_fail', false)

      expect(store.hasSuccessfulTool('s1', 'tool_ok')).toBe(true)
      expect(store.hasSuccessfulTool('s1', 'tool_fail')).toBe(false)
      expect(store.hasSuccessfulTool('s1', 'never_called')).toBe(false)
      expect(store.hasSuccessfulTool('nonexistent', 'tool_ok')).toBe(false)
    })

    it('hasSuccessfulTool treats success as sticky once recorded', () => {
      const { store, advance } = createStore()
      store.recordToolCall('s1', 'get_order', true)
      advance(1_000)
      // A later failed retry must not revoke an earlier success — dependency
      // chains would otherwise flake whenever an agent re-invoked a satisfied
      // tool with a bad argument.
      store.recordToolCall('s1', 'get_order', false)

      expect(store.hasSuccessfulTool('s1', 'get_order')).toBe(true)
      expect(store.hasCompletedTool('s1', 'get_order')).toBe(true)
    })

    it('hasSuccessfulTool upgrades from false to true on a later success', () => {
      const { store, advance } = createStore()
      store.recordToolCall('s1', 'get_order', false)
      advance(1_000)
      store.recordToolCall('s1', 'get_order', true)

      expect(store.hasSuccessfulTool('s1', 'get_order')).toBe(true)
    })

    it('overwrites previous call for the same tool (latest wins)', () => {
      const { store, advance } = createStore()
      store.recordToolCall('s1', 'get_order', false)
      advance(1_000)
      store.recordToolCall('s1', 'get_order', true)

      // Still completed
      expect(store.hasCompletedTool('s1', 'get_order')).toBe(true)
    })

    it('returns false for unknown session', () => {
      const { store } = createStore()
      expect(store.hasCompletedTool('nonexistent', 'tool')).toBe(false)
    })

    it('ignores writes after close', () => {
      const { store } = createStore()
      store.close()
      store.recordToolCall('s1', 'tool', true)
      expect(store.sessionCount).toBe(0)
    })
  })

  // -----------------------------------------------------------------------
  // peekEvidence
  // -----------------------------------------------------------------------

  describe('peekEvidence', () => {
    it('returns valid entry same as getEvidence', () => {
      const { store } = createStore()
      store.putEvidence('s1', {
        evidence_key: 'k',
        data: 'val',
        tool_name: 't',
      })

      const peeked = store.peekEvidence('s1', 'k')
      const got = store.getEvidence('s1', 'k')
      expect(peeked).toEqual(got)
    })

    it('returns expired entry without evicting it', () => {
      const { store, advance } = createStore({ ttl: 1 })
      store.putEvidence('s1', {
        evidence_key: 'k',
        data: 'expired-data',
        tool_name: 't',
      })

      advance(2_000)

      // peekEvidence returns the entry even though it's expired
      const peeked = store.peekEvidence('s1', 'k')
      expect(peeked).toBeDefined()
      expect(peeked?.data).toBe('expired-data')

      // Verify the entry was NOT evicted
      expect(store.evidenceCount('s1')).toBe(1)
    })

    it('returns undefined for truly missing key', () => {
      const { store } = createStore()
      store.putEvidence('s1', {
        evidence_key: 'exists',
        data: null,
        tool_name: 't',
      })

      expect(store.peekEvidence('s1', 'missing')).toBeUndefined()
    })

    it('returns undefined for unknown session', () => {
      const { store } = createStore()
      expect(store.peekEvidence('nonexistent', 'k')).toBeUndefined()
    })
  })

  // -----------------------------------------------------------------------
  // cleanup
  // -----------------------------------------------------------------------

  describe('cleanup', () => {
    it('removes expired evidence entries', () => {
      const { store, advance } = createStore({ ttl: 5 })
      store.putEvidence('s1', {
        evidence_key: 'k',
        data: null,
        tool_name: 't',
      })

      advance(6_000)
      store.cleanup()

      expect(store.evidenceCount('s1')).toBe(0)
    })

    it('keeps seen-only sessions until inactivity TTL', () => {
      const { store, advance } = createStore({ ttl: 1 })
      store.putEvidence('s1', {
        evidence_key: 'k',
        data: null,
        tool_name: 't',
      })

      advance(2_000)
      store.cleanup()

      expect(store.sessionCount).toBe(1)
      expect(store.hasSeenEvidence('s1', 'k')).toBe(true)
    })

    it('evicts seen-only sessions after inactivity TTL', () => {
      const { store, advance } = createStore({ ttl: 1, sessionInactivityMs: 5_000 })
      store.putEvidence('s1', {
        evidence_key: 'k',
        data: null,
        tool_name: 't',
      })

      advance(2_000)
      store.cleanup()
      expect(store.sessionCount).toBe(1)

      advance(5_001)
      store.cleanup()
      expect(store.sessionCount).toBe(0)
    })

    it('keeps live evidence entries', () => {
      const { store, advance } = createStore({ ttl: 600 })
      store.putEvidence('s1', {
        evidence_key: 'live',
        data: 'still here',
        tool_name: 't',
      })

      advance(1_000)
      store.cleanup()

      expect(mustGetEvidence(store, 's1', 'live').data).toBe('still here')
    })

    it('keeps sessions that still have context', () => {
      const { store, advance } = createStore({ ttl: 1 })
      store.putEvidence('s1', {
        evidence_key: 'k',
        data: null,
        tool_name: 't',
      })
      store.putContext('s1', 'agent_id', 'bot')

      advance(2_000)
      store.cleanup()

      expect(store.sessionCount).toBe(1)
      expect(store.getContext('s1', 'agent_id')).toBe('bot')
    })

    it('keeps sessions with only tool history', () => {
      const { store, advance } = createStore({ ttl: 1 })
      store.putEvidence('s1', {
        evidence_key: 'k',
        data: null,
        tool_name: 't',
      })
      store.recordToolCall('s1', 'get_order', true)

      advance(2_000)
      store.cleanup()

      // Session kept because of tool history
      expect(store.sessionCount).toBe(1)
      expect(store.hasCompletedTool('s1', 'get_order')).toBe(true)
    })

    it('evicts context-only sessions after inactivity TTL', () => {
      const { store, advance } = createStore({ sessionInactivityMs: 5_000 })
      store.putContext('s1', 'agent_id', 'bot')

      advance(5_001)
      store.cleanup()

      expect(store.sessionCount).toBe(0)
    })

    it('keeps context/tool-only sessions alive when recently accessed', () => {
      const { store, advance } = createStore({ sessionInactivityMs: 5_000 })
      store.putContext('s1', 'agent_id', 'bot')
      store.recordToolCall('s1', 'lookup', true)

      advance(4_000)
      expect(store.getContext('s1', 'agent_id')).toBe('bot')
      advance(2_000)
      store.cleanup()

      expect(store.sessionCount).toBe(1)
    })

    it('handles empty store gracefully', () => {
      const { store } = createStore()
      expect(() => {
        store.cleanup()
      }).not.toThrow()
      expect(store.sessionCount).toBe(0)
    })
  })

  // -----------------------------------------------------------------------
  // cleanup timer
  // -----------------------------------------------------------------------

  describe('cleanup timer', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('runs cleanup at the configured interval', () => {
      let time = 1_000_000
      const store = new EvidenceStore({
        defaultTtlSeconds: 1,
        cleanupIntervalMs: 500,
        now: () => time,
      })

      store.putEvidence('s1', {
        evidence_key: 'k',
        data: null,
        tool_name: 't',
      })

      // Advance past TTL
      time += 2_000

      // Advance the timer
      vi.advanceTimersByTime(500)

      // Expired live evidence is evicted, but seen-only session state is kept.
      expect(store.sessionCount).toBe(1)
      expect(store.evidenceCount('s1')).toBe(0)
      expect(store.seenEvidenceCount('s1')).toBe(1)

      store.close()
    })
  })

  // -----------------------------------------------------------------------
  // close
  // -----------------------------------------------------------------------

  describe('close', () => {
    it('clears all state', () => {
      const { store } = createStore()
      store.putEvidence('s1', {
        evidence_key: 'k',
        data: null,
        tool_name: 't',
      })
      store.putContext('s1', 'key', 'val')

      store.close()

      expect(store.sessionCount).toBe(0)
    })

    it('is idempotent', () => {
      const { store } = createStore()
      store.close()
      expect(() => {
        store.close()
      }).not.toThrow()
    })

    it('ignores writes after close', () => {
      const { store } = createStore()
      store.close()

      const evidenceResult = store.putEvidence('s1', {
        evidence_key: 'k',
        data: null,
        tool_name: 't',
      })
      const contextResult = store.putContext('s1', 'key', 'val')

      expect(store.sessionCount).toBe(0)
      expect(evidenceResult).toEqual({ stored: false, reason: 'closed' })
      expect(contextResult).toEqual({ stored: false, reason: 'closed' })
    })
  })

  // -----------------------------------------------------------------------
  // sessionCount + evidenceCount + seenEvidenceCount
  // -----------------------------------------------------------------------

  describe('sessionCount and evidenceCount', () => {
    it('tracks session count correctly', () => {
      const { store } = createStore()
      expect(store.sessionCount).toBe(0)

      store.putEvidence('s1', {
        evidence_key: 'k',
        data: null,
        tool_name: 't',
      })
      expect(store.sessionCount).toBe(1)

      store.putEvidence('s2', {
        evidence_key: 'k',
        data: null,
        tool_name: 't',
      })
      expect(store.sessionCount).toBe(2)
    })

    it('tracks evidence count per session', () => {
      const { store } = createStore()
      store.putEvidence('s1', {
        evidence_key: 'a',
        data: null,
        tool_name: 't',
      })
      store.putEvidence('s1', {
        evidence_key: 'b',
        data: null,
        tool_name: 't',
      })

      expect(store.evidenceCount('s1')).toBe(2)
      expect(store.evidenceCount('s2')).toBe(0)
    })

    it('context-only sessions are counted', () => {
      const { store } = createStore()
      store.putContext('s1', 'key', 'val')

      expect(store.sessionCount).toBe(1)
      expect(store.evidenceCount('s1')).toBe(0)
    })

    it('tracks seen evidence count independently from live evidence', () => {
      const { store, advance } = createStore({ ttl: 1 })
      store.putEvidence('s1', {
        evidence_key: 'a',
        data: null,
        tool_name: 't',
      })
      expect(store.seenEvidenceCount('s1')).toBe(1)
      expect(store.evidenceCount('s1')).toBe(1)

      advance(2_000)
      expect(store.getEvidence('s1', 'a')).toBeUndefined()
      expect(store.seenEvidenceCount('s1')).toBe(1)
      expect(store.evidenceCount('s1')).toBe(0)
    })
  })
})
