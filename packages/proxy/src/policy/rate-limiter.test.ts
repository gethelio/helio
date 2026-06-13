import { describe, it, expect } from 'vitest'
import { RateLimiter } from './rate-limiter.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createLimiter(options?: { cleanupIntervalMs?: number }) {
  let time = 1_000_000
  const advance = (ms: number) => {
    time += ms
  }

  const limiter = new RateLimiter({
    now: () => time,
    cleanupIntervalMs: options?.cleanupIntervalMs ?? 0,
  })

  return { limiter, advance, getTime: () => time }
}

// ---------------------------------------------------------------------------
// RateLimiter
// ---------------------------------------------------------------------------

describe('RateLimiter', () => {
  describe('check', () => {
    it('allows calls within limit', () => {
      const { limiter } = createLimiter()

      const r1 = limiter.check({ key: 'tool:weather', maxCalls: 3, windowMs: 60_000 })
      expect(r1.allowed).toBe(true)
      expect(r1.current).toBe(1)
      expect(r1.limit).toBe(3)

      const r2 = limiter.check({ key: 'tool:weather', maxCalls: 3, windowMs: 60_000 })
      expect(r2.allowed).toBe(true)
      expect(r2.current).toBe(2)

      const r3 = limiter.check({ key: 'tool:weather', maxCalls: 3, windowMs: 60_000 })
      expect(r3.allowed).toBe(true)
      expect(r3.current).toBe(3)
    })

    it('blocks calls exceeding limit', () => {
      const { limiter } = createLimiter()

      for (let i = 0; i < 3; i++) {
        limiter.check({ key: 'tool:weather', maxCalls: 3, windowMs: 60_000 })
      }

      const blocked = limiter.check({ key: 'tool:weather', maxCalls: 3, windowMs: 60_000 })
      expect(blocked.allowed).toBe(false)
      expect(blocked.current).toBe(3)
      expect(blocked.limit).toBe(3)
    })

    it('slides window — calls allowed after expiry', () => {
      const { limiter, advance } = createLimiter()

      // Fill the limit
      for (let i = 0; i < 3; i++) {
        limiter.check({ key: 'tool:weather', maxCalls: 3, windowMs: 60_000 })
      }

      // Blocked right now
      expect(limiter.check({ key: 'tool:weather', maxCalls: 3, windowMs: 60_000 }).allowed).toBe(
        false,
      )

      // Advance past the window
      advance(60_001)

      // Should be allowed again
      const result = limiter.check({ key: 'tool:weather', maxCalls: 3, windowMs: 60_000 })
      expect(result.allowed).toBe(true)
      expect(result.current).toBe(1)
    })

    it('computes resetAtMs correctly', () => {
      const { limiter, getTime } = createLimiter()

      const r1 = limiter.check({ key: 'tool:a', maxCalls: 2, windowMs: 10_000 })
      // resetAtMs = oldest timestamp (now) + windowMs
      expect(r1.resetAtMs).toBe(getTime() + 10_000)

      limiter.check({ key: 'tool:a', maxCalls: 2, windowMs: 10_000 })

      const blocked = limiter.check({ key: 'tool:a', maxCalls: 2, windowMs: 10_000 })
      expect(blocked.allowed).toBe(false)
      // resetAtMs should be the first call's timestamp + window
      expect(blocked.resetAtMs).toBe(getTime() + 10_000)
    })

    it('isolates different keys', () => {
      const { limiter } = createLimiter()

      // Fill key A
      for (let i = 0; i < 2; i++) {
        limiter.check({ key: 'tool:a', maxCalls: 2, windowMs: 60_000 })
      }
      expect(limiter.check({ key: 'tool:a', maxCalls: 2, windowMs: 60_000 }).allowed).toBe(false)

      // Key B should still be available
      const result = limiter.check({ key: 'tool:b', maxCalls: 2, windowMs: 60_000 })
      expect(result.allowed).toBe(true)
      expect(result.current).toBe(1)
    })

    it('does not increment counter on blocked calls', () => {
      const { limiter } = createLimiter()

      for (let i = 0; i < 2; i++) {
        limiter.check({ key: 'tool:a', maxCalls: 2, windowMs: 60_000 })
      }

      // Multiple blocked attempts should not increase the count
      const b1 = limiter.check({ key: 'tool:a', maxCalls: 2, windowMs: 60_000 })
      const b2 = limiter.check({ key: 'tool:a', maxCalls: 2, windowMs: 60_000 })
      const b3 = limiter.check({ key: 'tool:a', maxCalls: 2, windowMs: 60_000 })

      expect(b1.current).toBe(2)
      expect(b2.current).toBe(2)
      expect(b3.current).toBe(2)
    })

    it('partially slides window — only expired timestamps removed', () => {
      const { limiter, advance } = createLimiter()

      limiter.check({ key: 'tool:a', maxCalls: 3, windowMs: 10_000 })
      advance(5_000)
      limiter.check({ key: 'tool:a', maxCalls: 3, windowMs: 10_000 })
      advance(5_000)
      limiter.check({ key: 'tool:a', maxCalls: 3, windowMs: 10_000 })

      // All 3 slots used, but first one is right at the edge
      advance(1)

      // First timestamp expired, so we should be at 2 calls now
      const result = limiter.check({ key: 'tool:a', maxCalls: 3, windowMs: 10_000 })
      expect(result.allowed).toBe(true)
      expect(result.current).toBe(3) // 2 remaining + 1 new
    })
  })

  describe('peek', () => {
    it('returns allowed state without consuming budget', () => {
      const { limiter } = createLimiter()

      const peek1 = limiter.peek({ key: 'tool:weather', maxCalls: 3, windowMs: 60_000 })
      expect(peek1.allowed).toBe(true)

      // peek again — should still be allowed because peek does not consume
      const peek2 = limiter.peek({ key: 'tool:weather', maxCalls: 3, windowMs: 60_000 })
      expect(peek2.allowed).toBe(true)

      // real check should still succeed (budget not consumed by peeks)
      const r1 = limiter.check({ key: 'tool:weather', maxCalls: 3, windowMs: 60_000 })
      expect(r1.allowed).toBe(true)
      expect(r1.current).toBe(1)
    })

    it('returns blocked state when limit is reached', () => {
      const { limiter } = createLimiter()

      // Consume all 2 slots
      limiter.check({ key: 'tool:weather', maxCalls: 2, windowMs: 60_000 })
      limiter.check({ key: 'tool:weather', maxCalls: 2, windowMs: 60_000 })

      // peek should show blocked
      const peek = limiter.peek({ key: 'tool:weather', maxCalls: 2, windowMs: 60_000 })
      expect(peek.allowed).toBe(false)
      expect(peek.current).toBe(2)
      expect(peek.limit).toBe(2)
    })
  })

  describe('getKeyState', () => {
    it('returns undefined for unknown key', () => {
      const { limiter } = createLimiter()
      expect(limiter.getKeyState('nonexistent')).toBeUndefined()
    })

    it('returns current state for a tracked key', () => {
      const { limiter, getTime } = createLimiter()

      limiter.check({ key: 'tool:a', maxCalls: 5, windowMs: 30_000 })
      limiter.check({ key: 'tool:a', maxCalls: 5, windowMs: 30_000 })

      const state = limiter.getKeyState('tool:a')
      expect(state).toEqual({
        key: 'tool:a',
        current: 2,
        limit: 5,
        window_ms: 30_000,
        reset_at_ms: getTime() + 30_000,
      })
    })

    it('returns undefined after all entries expire', () => {
      const { limiter, advance } = createLimiter()

      limiter.check({ key: 'tool:a', maxCalls: 5, windowMs: 10_000 })
      advance(10_001)

      expect(limiter.getKeyState('tool:a')).toBeUndefined()
    })
  })

  describe('listKeyStates', () => {
    it('returns empty array when no keys tracked', () => {
      const { limiter } = createLimiter()
      expect(limiter.listKeyStates()).toEqual([])
    })

    it('returns all tracked keys', () => {
      const { limiter } = createLimiter()

      limiter.check({ key: 'tool:a', maxCalls: 5, windowMs: 60_000 })
      limiter.check({ key: 'session:xyz', maxCalls: 10, windowMs: 30_000 })

      const states = limiter.listKeyStates()
      expect(states).toHaveLength(2)
      expect(states.map((s) => s.key).sort()).toEqual(['session:xyz', 'tool:a'])
    })

    it('excludes keys with all expired entries', () => {
      const { limiter, advance } = createLimiter()

      limiter.check({ key: 'tool:a', maxCalls: 5, windowMs: 10_000 })
      limiter.check({ key: 'tool:b', maxCalls: 5, windowMs: 60_000 })

      advance(10_001)

      const states = limiter.listKeyStates()
      expect(states).toHaveLength(1)
      expect(states[0]?.key).toBe('tool:b')
    })
  })

  describe('cleanup', () => {
    it('removes expired timestamps and empty buckets', () => {
      const { limiter, advance } = createLimiter()

      limiter.check({ key: 'tool:a', maxCalls: 5, windowMs: 10_000 })
      limiter.check({ key: 'tool:b', maxCalls: 5, windowMs: 60_000 })

      advance(10_001)
      limiter.cleanup()

      // tool:a should be gone (expired), tool:b should remain
      expect(limiter.getKeyState('tool:a')).toBeUndefined()
      expect(limiter.getKeyState('tool:b')).toBeDefined()
    })
  })

  describe('reset', () => {
    it('clears all state', () => {
      const { limiter } = createLimiter()

      limiter.check({ key: 'tool:a', maxCalls: 2, windowMs: 60_000 })
      limiter.check({ key: 'tool:b', maxCalls: 2, windowMs: 60_000 })

      limiter.reset()

      expect(limiter.listKeyStates()).toEqual([])
      // Calls should be allowed again
      const result = limiter.check({ key: 'tool:a', maxCalls: 2, windowMs: 60_000 })
      expect(result.allowed).toBe(true)
      expect(result.current).toBe(1)
    })
  })

  // ---------------------------------------------------------------------------
  // reconcile — compare-and-evict per bucket on hot-reload
  // ---------------------------------------------------------------------------

  describe('reconcile', () => {
    it('preserves bucket state when the matching config is unchanged', () => {
      const { limiter } = createLimiter()

      // Seed three calls against a 10-call / 60s window
      for (let i = 0; i < 3; i++) {
        limiter.check({ key: 'tool:send_email', maxCalls: 10, windowMs: 60_000 })
      }
      expect(limiter.getKeyState('tool:send_email')?.current).toBe(3)

      // Reconcile with the same config tuple — bucket must stay intact
      limiter.reconcile([{ maxCalls: 10, windowMs: 60_000 }])

      const state = limiter.getKeyState('tool:send_email')
      expect(state?.current).toBe(3)
      expect(state?.limit).toBe(10)
      expect(state?.window_ms).toBe(60_000)
    })

    it('evicts a bucket when its maxCalls changed', () => {
      const { limiter } = createLimiter()

      for (let i = 0; i < 3; i++) {
        limiter.check({ key: 'tool:send_email', maxCalls: 10, windowMs: 60_000 })
      }

      // New policy has maxCalls=5 instead of 10 — bucket is stale, evict it
      limiter.reconcile([{ maxCalls: 5, windowMs: 60_000 }])

      expect(limiter.getKeyState('tool:send_email')).toBeUndefined()
    })

    it('evicts a bucket when its windowMs changed', () => {
      const { limiter } = createLimiter()

      for (let i = 0; i < 3; i++) {
        limiter.check({ key: 'tool:send_email', maxCalls: 10, windowMs: 60_000 })
      }

      // Same maxCalls but different window — still a config change, evict
      limiter.reconcile([{ maxCalls: 10, windowMs: 30_000 }])

      expect(limiter.getKeyState('tool:send_email')).toBeUndefined()
    })

    it('evicts a bucket when no tuple in the new policy matches', () => {
      const { limiter } = createLimiter()

      limiter.check({ key: 'tool:send_email', maxCalls: 10, windowMs: 60_000 })

      // Reconcile with a tuple that doesn't match — removed rule case
      limiter.reconcile([{ maxCalls: 20, windowMs: 30_000 }])

      expect(limiter.getKeyState('tool:send_email')).toBeUndefined()
    })

    it('evicts all buckets when reconciled with an empty tuple set', () => {
      const { limiter } = createLimiter()

      limiter.check({ key: 'tool:a', maxCalls: 10, windowMs: 60_000 })
      limiter.check({ key: 'tool:b', maxCalls: 5, windowMs: 30_000 })

      limiter.reconcile([])

      expect(limiter.listKeyStates()).toEqual([])
    })

    it('preserves some buckets while evicting others based on per-bucket config', () => {
      const { limiter } = createLimiter()

      // Two buckets under different rules
      limiter.check({ key: 'tool:send_email', maxCalls: 10, windowMs: 60_000 })
      limiter.check({ key: 'tool:send_email', maxCalls: 10, windowMs: 60_000 })
      limiter.check({ key: 'tool:delete_record', maxCalls: 3, windowMs: 10_000 })

      // New policy keeps the send_email rule but drops delete_record's tuple
      limiter.reconcile([{ maxCalls: 10, windowMs: 60_000 }])

      expect(limiter.getKeyState('tool:send_email')?.current).toBe(2)
      expect(limiter.getKeyState('tool:delete_record')).toBeUndefined()
    })

    it('is a no-op when there are no buckets', () => {
      const { limiter } = createLimiter()

      expect(() => {
        limiter.reconcile([{ maxCalls: 10, windowMs: 60_000 }])
      }).not.toThrow()
      expect(limiter.listKeyStates()).toEqual([])
    })

    it('ignores duplicate tuples in the new policy set', () => {
      const { limiter } = createLimiter()

      limiter.check({ key: 'tool:a', maxCalls: 10, windowMs: 60_000 })

      limiter.reconcile([
        { maxCalls: 10, windowMs: 60_000 },
        { maxCalls: 10, windowMs: 60_000 },
      ])

      expect(limiter.getKeyState('tool:a')?.current).toBe(1)
    })
  })

  describe('close', () => {
    it('clears all state and is idempotent', () => {
      const { limiter } = createLimiter()

      limiter.check({ key: 'tool:a', maxCalls: 2, windowMs: 60_000 })
      limiter.close()

      expect(limiter.listKeyStates()).toEqual([])

      // Double close should not throw
      limiter.close()
    })
  })

  // -------------------------------------------------------------------------
  // record() — unconditional commit path for the sideband /audit endpoint
  // (issue #12, D3). The external call already executed, so unlike check()
  // this always appends, even when the bucket is already at/over the limit.
  // -------------------------------------------------------------------------

  describe('record', () => {
    it('appends even when already at/over the limit', () => {
      const { limiter } = createLimiter()

      // Fill to the limit via check().
      limiter.check({ key: 'tool:send', maxCalls: 2, windowMs: 60_000 })
      limiter.check({ key: 'tool:send', maxCalls: 2, windowMs: 60_000 })
      expect(limiter.check({ key: 'tool:send', maxCalls: 2, windowMs: 60_000 }).allowed).toBe(false)

      // record() commits past the limit — the call really happened.
      const r = limiter.record({ key: 'tool:send', maxCalls: 2, windowMs: 60_000 })
      expect(r.current).toBe(3)
      expect(r.allowed).toBe(false) // over limit, but recorded
      expect(limiter.getKeyState('tool:send')?.current).toBe(3)
    })

    it('creates the bucket on first record', () => {
      const { limiter } = createLimiter()

      const r = limiter.record({ key: 'tool:fresh', maxCalls: 5, windowMs: 60_000 })
      expect(r.current).toBe(1)
      expect(r.allowed).toBe(true)
      expect(limiter.getKeyState('tool:fresh')?.current).toBe(1)
    })

    it('evicts expired timestamps before appending', () => {
      const { limiter, advance } = createLimiter()

      limiter.record({ key: 'tool:t', maxCalls: 3, windowMs: 1_000 })
      advance(2_000) // first entry now expired
      const r = limiter.record({ key: 'tool:t', maxCalls: 3, windowMs: 1_000 })
      expect(r.current).toBe(1)
    })

    it('emits onWarning while within the limit', () => {
      const time = 1_000_000
      const warnings: Array<{ current: number }> = []
      const limiter = new RateLimiter({
        now: () => time,
        cleanupIntervalMs: 0,
        warningThreshold: 0.8,
        onWarning: (s) => warnings.push({ current: s.current }),
      })

      limiter.record({ key: 'tool:w', maxCalls: 5, windowMs: 60_000 }) // 1/5
      limiter.record({ key: 'tool:w', maxCalls: 5, windowMs: 60_000 }) // 2/5
      limiter.record({ key: 'tool:w', maxCalls: 5, windowMs: 60_000 }) // 3/5
      expect(warnings).toHaveLength(0)
      limiter.record({ key: 'tool:w', maxCalls: 5, windowMs: 60_000 }) // 4/5 -> 0.8
      expect(warnings).toEqual([{ current: 4 }])
    })

    it('does NOT emit onWarning on over-limit appends (no flood)', () => {
      const time = 1_000_000
      const warnings: number[] = []
      const limiter = new RateLimiter({
        now: () => time,
        cleanupIntervalMs: 0,
        warningThreshold: 0.8,
        onWarning: (s) => warnings.push(s.current),
      })

      limiter.record({ key: 'tool:flood', maxCalls: 1, windowMs: 60_000 }) // 1/1 -> warns
      limiter.record({ key: 'tool:flood', maxCalls: 1, windowMs: 60_000 }) // 2/1 over
      limiter.record({ key: 'tool:flood', maxCalls: 1, windowMs: 60_000 }) // 3/1 over
      expect(warnings).toEqual([1]) // only the within-limit append warned
    })
  })
})
