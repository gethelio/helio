import { describe, it, expect } from 'vitest'
import { SpendLimiter } from './spend-limiter.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createLimiter(options?: { cleanupIntervalMs?: number }) {
  let time = 1_000_000
  const advance = (ms: number) => {
    time += ms
  }

  const limiter = new SpendLimiter({
    now: () => time,
    cleanupIntervalMs: options?.cleanupIntervalMs ?? 0,
  })

  return { limiter, advance, getTime: () => time }
}

// ---------------------------------------------------------------------------
// SpendLimiter
// ---------------------------------------------------------------------------

describe('SpendLimiter', () => {
  describe('check', () => {
    it('allows spend within limit', () => {
      const { limiter } = createLimiter()

      const r1 = limiter.check({ key: 'tool:pay', amount: 100, limit: 500, windowMs: 60_000 })
      expect(r1.allowed).toBe(true)
      expect(r1.currentSpend).toBe(100)
      expect(r1.limit).toBe(500)
    })

    it('allows multiple spends up to limit', () => {
      const { limiter } = createLimiter()

      limiter.check({ key: 'tool:pay', amount: 200, limit: 500, windowMs: 60_000 })
      const r2 = limiter.check({ key: 'tool:pay', amount: 300, limit: 500, windowMs: 60_000 })
      expect(r2.allowed).toBe(true)
      expect(r2.currentSpend).toBe(500)
    })

    it('blocks when cumulative spend would exceed limit', () => {
      const { limiter } = createLimiter()

      limiter.check({ key: 'tool:pay', amount: 400, limit: 500, windowMs: 60_000 })

      const blocked = limiter.check({ key: 'tool:pay', amount: 200, limit: 500, windowMs: 60_000 })
      expect(blocked.allowed).toBe(false)
      expect(blocked.currentSpend).toBe(400)
      expect(blocked.limit).toBe(500)
    })

    it('blocks when single spend exceeds limit', () => {
      const { limiter } = createLimiter()

      const blocked = limiter.check({ key: 'tool:pay', amount: 600, limit: 500, windowMs: 60_000 })
      expect(blocked.allowed).toBe(false)
      expect(blocked.currentSpend).toBe(0)
    })

    it('slides window — spend allowed after expiry', () => {
      const { limiter, advance } = createLimiter()

      // Spend the full budget
      limiter.check({ key: 'tool:pay', amount: 500, limit: 500, windowMs: 60_000 })

      // Blocked right now
      expect(
        limiter.check({ key: 'tool:pay', amount: 100, limit: 500, windowMs: 60_000 }).allowed,
      ).toBe(false)

      // Advance past the window
      advance(60_001)

      // Should be allowed again
      const result = limiter.check({ key: 'tool:pay', amount: 100, limit: 500, windowMs: 60_000 })
      expect(result.allowed).toBe(true)
      expect(result.currentSpend).toBe(100)
    })

    it('computes resetAtMs correctly', () => {
      const { limiter, getTime } = createLimiter()

      const r1 = limiter.check({ key: 'tool:a', amount: 100, limit: 500, windowMs: 10_000 })
      // resetAtMs = oldest entry timestamp (now) + windowMs
      expect(r1.resetAtMs).toBe(getTime() + 10_000)
    })

    it('computes resetAtMs on blocked call', () => {
      const { limiter, getTime, advance } = createLimiter()

      limiter.check({ key: 'tool:a', amount: 400, limit: 500, windowMs: 10_000 })
      const firstCallTime = getTime()
      advance(2_000)
      limiter.check({ key: 'tool:a', amount: 100, limit: 500, windowMs: 10_000 })

      const blocked = limiter.check({ key: 'tool:a', amount: 100, limit: 500, windowMs: 10_000 })
      expect(blocked.allowed).toBe(false)
      // resetAtMs should be the first entry's timestamp + window
      expect(blocked.resetAtMs).toBe(firstCallTime + 10_000)
    })

    it('isolates different keys', () => {
      const { limiter } = createLimiter()

      // Spend full budget on key A
      limiter.check({ key: 'tool:a', amount: 500, limit: 500, windowMs: 60_000 })
      expect(
        limiter.check({ key: 'tool:a', amount: 1, limit: 500, windowMs: 60_000 }).allowed,
      ).toBe(false)

      // Key B should still have full budget
      const result = limiter.check({ key: 'tool:b', amount: 300, limit: 500, windowMs: 60_000 })
      expect(result.allowed).toBe(true)
      expect(result.currentSpend).toBe(300)
    })

    it('does not consume budget on blocked spend', () => {
      const { limiter } = createLimiter()

      limiter.check({ key: 'tool:a', amount: 400, limit: 500, windowMs: 60_000 })

      // Multiple blocked attempts should not increase spend
      const b1 = limiter.check({ key: 'tool:a', amount: 200, limit: 500, windowMs: 60_000 })
      const b2 = limiter.check({ key: 'tool:a', amount: 200, limit: 500, windowMs: 60_000 })
      const b3 = limiter.check({ key: 'tool:a', amount: 200, limit: 500, windowMs: 60_000 })

      expect(b1.currentSpend).toBe(400)
      expect(b2.currentSpend).toBe(400)
      expect(b3.currentSpend).toBe(400)
    })

    it('partially slides window — only expired entries removed', () => {
      const { limiter, advance } = createLimiter()

      limiter.check({ key: 'tool:a', amount: 200, limit: 500, windowMs: 10_000 })
      advance(5_000)
      limiter.check({ key: 'tool:a', amount: 200, limit: 500, windowMs: 10_000 })
      advance(5_000)

      // First entry (200) is right at the edge, second (200) still valid
      advance(1)

      // First entry expired. Current spend = 200. Should allow 300 more.
      const result = limiter.check({ key: 'tool:a', amount: 250, limit: 500, windowMs: 10_000 })
      expect(result.allowed).toBe(true)
      expect(result.currentSpend).toBe(450) // 200 remaining + 250 new
    })

    it('allows exact limit spend', () => {
      const { limiter } = createLimiter()

      const result = limiter.check({ key: 'tool:a', amount: 500, limit: 500, windowMs: 60_000 })
      expect(result.allowed).toBe(true)
      expect(result.currentSpend).toBe(500)
    })

    it('handles fractional amounts', () => {
      const { limiter } = createLimiter()

      limiter.check({ key: 'tool:a', amount: 99.99, limit: 100, windowMs: 60_000 })

      const result = limiter.check({ key: 'tool:a', amount: 0.01, limit: 100, windowMs: 60_000 })
      expect(result.allowed).toBe(true)
      expect(result.currentSpend).toBeCloseTo(100)
    })
  })

  describe('peek', () => {
    it('returns allowed state without consuming budget', () => {
      const { limiter } = createLimiter()

      const peek1 = limiter.peek({ key: 'tool:pay', amount: 100, limit: 500, windowMs: 60_000 })
      expect(peek1.allowed).toBe(true)

      // peek again — same result, budget not consumed
      const peek2 = limiter.peek({ key: 'tool:pay', amount: 100, limit: 500, windowMs: 60_000 })
      expect(peek2.allowed).toBe(true)

      // real check should still succeed (no budget consumed by peeks)
      const r1 = limiter.check({ key: 'tool:pay', amount: 100, limit: 500, windowMs: 60_000 })
      expect(r1.allowed).toBe(true)
      expect(r1.currentSpend).toBe(100)
    })

    it('returns blocked state when limit would be exceeded', () => {
      const { limiter } = createLimiter()

      // Consume 400 of 500 budget
      limiter.check({ key: 'tool:pay', amount: 400, limit: 500, windowMs: 60_000 })

      // peek for 200 more — should be blocked
      const peek = limiter.peek({ key: 'tool:pay', amount: 200, limit: 500, windowMs: 60_000 })
      expect(peek.allowed).toBe(false)
      expect(peek.currentSpend).toBe(400)
      expect(peek.limit).toBe(500)
    })
  })

  describe('invalid amount', () => {
    it('check rejects negative amount with reason', () => {
      const { limiter } = createLimiter()

      const result = limiter.check({
        key: 'tool:pay',
        amount: -100,
        limit: 500,
        windowMs: 60_000,
      })
      expect(result.allowed).toBe(false)
      expect(result.reason).toBe('invalid_amount')
    })

    it('check rejects NaN with reason', () => {
      const { limiter } = createLimiter()

      const result = limiter.check({
        key: 'tool:pay',
        amount: Number.NaN,
        limit: 500,
        windowMs: 60_000,
      })
      expect(result.allowed).toBe(false)
      expect(result.reason).toBe('invalid_amount')
    })

    it('check rejects Infinity and -Infinity', () => {
      const { limiter } = createLimiter()

      const inf = limiter.check({
        key: 'tool:pay',
        amount: Number.POSITIVE_INFINITY,
        limit: 500,
        windowMs: 60_000,
      })
      const negInf = limiter.check({
        key: 'tool:pay',
        amount: Number.NEGATIVE_INFINITY,
        limit: 500,
        windowMs: 60_000,
      })
      expect(inf.allowed).toBe(false)
      expect(inf.reason).toBe('invalid_amount')
      expect(negInf.allowed).toBe(false)
      expect(negInf.reason).toBe('invalid_amount')
    })

    it('check still allows zero amount (legitimate $0 preauth)', () => {
      const { limiter } = createLimiter()

      const result = limiter.check({ key: 'tool:pay', amount: 0, limit: 500, windowMs: 60_000 })
      expect(result.allowed).toBe(true)
      expect(result.reason).toBeUndefined()
      expect(result.currentSpend).toBe(0)
    })

    it('peek rejects negative and non-finite amounts symmetrically', () => {
      const { limiter } = createLimiter()

      for (const amount of [-100, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        const result = limiter.peek({ key: 'tool:pay', amount, limit: 500, windowMs: 60_000 })
        expect(result.allowed).toBe(false)
        expect(result.reason).toBe('invalid_amount')
      }
    })

    it('invalid check does not create a bucket for an unknown key', () => {
      const { limiter } = createLimiter()

      limiter.check({ key: 'tool:new', amount: -100, limit: 500, windowMs: 60_000 })
      // Bucket was never created — listKeyStates stays empty
      expect(limiter.listKeyStates()).toEqual([])
    })

    it('negative amount does not corrupt bucket budget', () => {
      const { limiter } = createLimiter()

      // Step 1: seed the bucket with a legitimate spend
      const seed = limiter.check({
        key: 'tool:pay',
        amount: 500,
        limit: 1000,
        windowMs: 60_000,
      })
      expect(seed.allowed).toBe(true)
      expect(seed.currentSpend).toBe(500)

      // Step 2: attack with a large negative-amount payload
      const attack = limiter.check({
        key: 'tool:pay',
        amount: -9_999_999,
        limit: 1000,
        windowMs: 60_000,
      })
      expect(attack.allowed).toBe(false)
      expect(attack.reason).toBe('invalid_amount')
      // Bucket state must be unchanged from step 1
      expect(attack.currentSpend).toBe(500)
      expect(limiter.getKeyState('tool:pay')?.current_spend).toBe(500)

      // Step 3: a legitimate follow-up should consume budget normally
      const followUp = limiter.check({
        key: 'tool:pay',
        amount: 400,
        limit: 1000,
        windowMs: 60_000,
      })
      expect(followUp.allowed).toBe(true)
      expect(followUp.currentSpend).toBe(900)

      // Step 4: a call that would exceed the budget is correctly denied
      const overflow = limiter.check({
        key: 'tool:pay',
        amount: 200,
        limit: 1000,
        windowMs: 60_000,
      })
      expect(overflow.allowed).toBe(false)
      // Bucket still at 900 — overflow attempts do not consume budget
      expect(limiter.getKeyState('tool:pay')?.current_spend).toBe(900)
    })
  })

  describe('setCurrency', () => {
    it('sets currency on existing bucket', () => {
      const { limiter } = createLimiter()

      limiter.check({ key: 'tool:a', amount: 100, limit: 500, windowMs: 60_000 })
      limiter.setCurrency('tool:a', 'GBP')

      const state = limiter.getKeyState('tool:a')
      expect(state?.currency).toBe('GBP')
    })

    it('does nothing for unknown key', () => {
      const { limiter } = createLimiter()
      // Should not throw
      limiter.setCurrency('nonexistent', 'USD')
    })
  })

  describe('getKeyState', () => {
    it('returns undefined for unknown key', () => {
      const { limiter } = createLimiter()
      expect(limiter.getKeyState('nonexistent')).toBeUndefined()
    })

    it('returns current state for a tracked key', () => {
      const { limiter, getTime } = createLimiter()

      limiter.check({ key: 'tool:a', amount: 100, limit: 500, windowMs: 30_000 })
      limiter.check({ key: 'tool:a', amount: 150, limit: 500, windowMs: 30_000 })
      limiter.setCurrency('tool:a', 'USD')

      const state = limiter.getKeyState('tool:a')
      expect(state).toEqual({
        key: 'tool:a',
        current_spend: 250,
        limit: 500,
        currency: 'USD',
        window_ms: 30_000,
        reset_at_ms: getTime() + 30_000,
      })
    })

    it('returns undefined after all entries expire', () => {
      const { limiter, advance } = createLimiter()

      limiter.check({ key: 'tool:a', amount: 100, limit: 500, windowMs: 10_000 })
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

      limiter.check({ key: 'tool:a', amount: 100, limit: 500, windowMs: 60_000 })
      limiter.check({ key: 'session:xyz', amount: 50, limit: 200, windowMs: 30_000 })

      const states = limiter.listKeyStates()
      expect(states).toHaveLength(2)
      expect(states.map((s) => s.key).sort()).toEqual(['session:xyz', 'tool:a'])
    })

    it('excludes keys with all expired entries', () => {
      const { limiter, advance } = createLimiter()

      limiter.check({ key: 'tool:a', amount: 100, limit: 500, windowMs: 10_000 })
      limiter.check({ key: 'tool:b', amount: 50, limit: 500, windowMs: 60_000 })

      advance(10_001)

      const states = limiter.listKeyStates()
      expect(states).toHaveLength(1)
      expect(states[0]?.key).toBe('tool:b')
    })
  })

  describe('cleanup', () => {
    it('removes expired entries and empty buckets', () => {
      const { limiter, advance } = createLimiter()

      limiter.check({ key: 'tool:a', amount: 100, limit: 500, windowMs: 10_000 })
      limiter.check({ key: 'tool:b', amount: 50, limit: 500, windowMs: 60_000 })

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

      limiter.check({ key: 'tool:a', amount: 100, limit: 500, windowMs: 60_000 })
      limiter.check({ key: 'tool:b', amount: 50, limit: 500, windowMs: 60_000 })

      limiter.reset()

      expect(limiter.listKeyStates()).toEqual([])
      // Spend should be allowed again
      const result = limiter.check({ key: 'tool:a', amount: 100, limit: 500, windowMs: 60_000 })
      expect(result.allowed).toBe(true)
      expect(result.currentSpend).toBe(100)
    })
  })

  // ---------------------------------------------------------------------------
  // reconcile — compare-and-evict per bucket on hot-reload
  // ---------------------------------------------------------------------------

  describe('reconcile', () => {
    it('preserves bucket state when the matching config is unchanged', () => {
      const { limiter } = createLimiter()

      limiter.check({ key: 'tool:pay', amount: 300, limit: 1000, windowMs: 3_600_000 })
      limiter.setCurrency('tool:pay', 'USD')
      expect(limiter.getKeyState('tool:pay')?.current_spend).toBe(300)

      limiter.reconcile([{ limit: 1000, currency: 'USD', windowMs: 3_600_000 }])

      const state = limiter.getKeyState('tool:pay')
      expect(state?.current_spend).toBe(300)
      expect(state?.limit).toBe(1000)
      expect(state?.currency).toBe('USD')
      expect(state?.window_ms).toBe(3_600_000)
    })

    it('evicts a bucket when its limit changed', () => {
      const { limiter } = createLimiter()

      limiter.check({ key: 'tool:pay', amount: 300, limit: 1000, windowMs: 3_600_000 })
      limiter.setCurrency('tool:pay', 'USD')

      limiter.reconcile([{ limit: 500, currency: 'USD', windowMs: 3_600_000 }])

      expect(limiter.getKeyState('tool:pay')).toBeUndefined()
    })

    it('evicts a bucket when its currency changed', () => {
      const { limiter } = createLimiter()

      limiter.check({ key: 'tool:pay', amount: 300, limit: 1000, windowMs: 3_600_000 })
      limiter.setCurrency('tool:pay', 'USD')

      // Same limit, same window, but switched USD → EUR — different budget pool
      limiter.reconcile([{ limit: 1000, currency: 'EUR', windowMs: 3_600_000 }])

      expect(limiter.getKeyState('tool:pay')).toBeUndefined()
    })

    it('evicts a bucket when its windowMs changed', () => {
      const { limiter } = createLimiter()

      limiter.check({ key: 'tool:pay', amount: 300, limit: 1000, windowMs: 3_600_000 })
      limiter.setCurrency('tool:pay', 'USD')

      limiter.reconcile([{ limit: 1000, currency: 'USD', windowMs: 1_800_000 }])

      expect(limiter.getKeyState('tool:pay')).toBeUndefined()
    })

    it('evicts a bucket when no tuple in the new policy matches', () => {
      const { limiter } = createLimiter()

      limiter.check({ key: 'tool:pay', amount: 300, limit: 1000, windowMs: 3_600_000 })
      limiter.setCurrency('tool:pay', 'USD')

      limiter.reconcile([{ limit: 2000, currency: 'EUR', windowMs: 86_400_000 }])

      expect(limiter.getKeyState('tool:pay')).toBeUndefined()
    })

    it('evicts all buckets when reconciled with an empty tuple set', () => {
      const { limiter } = createLimiter()

      limiter.check({ key: 'tool:a', amount: 100, limit: 1000, windowMs: 60_000 })
      limiter.setCurrency('tool:a', 'USD')
      limiter.check({ key: 'tool:b', amount: 50, limit: 500, windowMs: 30_000 })
      limiter.setCurrency('tool:b', 'USD')

      limiter.reconcile([])

      expect(limiter.listKeyStates()).toEqual([])
    })

    it('preserves some buckets while evicting others based on per-bucket config', () => {
      const { limiter } = createLimiter()

      limiter.check({ key: 'tool:pay', amount: 300, limit: 1000, windowMs: 3_600_000 })
      limiter.setCurrency('tool:pay', 'USD')
      limiter.check({ key: 'tool:refund', amount: 50, limit: 200, windowMs: 3_600_000 })
      limiter.setCurrency('tool:refund', 'USD')

      // New policy keeps tool:pay's tuple, drops tool:refund's
      limiter.reconcile([{ limit: 1000, currency: 'USD', windowMs: 3_600_000 }])

      expect(limiter.getKeyState('tool:pay')?.current_spend).toBe(300)
      expect(limiter.getKeyState('tool:refund')).toBeUndefined()
    })

    it('is a no-op when there are no buckets', () => {
      const { limiter } = createLimiter()

      expect(() => {
        limiter.reconcile([{ limit: 1000, currency: 'USD', windowMs: 3_600_000 }])
      }).not.toThrow()
      expect(limiter.listKeyStates()).toEqual([])
    })
  })

  describe('close', () => {
    it('clears all state and is idempotent', () => {
      const { limiter } = createLimiter()

      limiter.check({ key: 'tool:a', amount: 100, limit: 500, windowMs: 60_000 })
      limiter.close()

      expect(limiter.listKeyStates()).toEqual([])

      // Double close should not throw
      limiter.close()
    })
  })

  // -------------------------------------------------------------------------
  // record() — unconditional commit path for the sideband /audit endpoint
  // (issue #12, D3). The spend already happened, so this always appends —
  // even past the limit — and throws on invalid amounts (which must have been
  // rejected at /evaluate; reaching record() with one is a logic bug).
  // -------------------------------------------------------------------------

  describe('record', () => {
    it('appends even when the spend exceeds the limit', () => {
      const { limiter } = createLimiter()

      limiter.check({ key: 'tool:pay', amount: 18, limit: 20, windowMs: 60_000 })
      // A spend of 5 would exceed via check() and be rejected, but it executed.
      const r = limiter.record({ key: 'tool:pay', amount: 5, limit: 20, windowMs: 60_000 })
      expect(r.currentSpend).toBe(23)
      expect(r.allowed).toBe(false) // over limit, but recorded
      expect(limiter.getKeyState('tool:pay')?.current_spend).toBe(23)
    })

    it('creates the bucket on first record', () => {
      const { limiter } = createLimiter()

      const r = limiter.record({ key: 'tool:new', amount: 4.5, limit: 20, windowMs: 60_000 })
      expect(r.currentSpend).toBe(4.5)
      expect(r.allowed).toBe(true)
      expect(limiter.getKeyState('tool:new')?.current_spend).toBe(4.5)
    })

    it('evicts expired entries before appending', () => {
      const { limiter, advance } = createLimiter()

      limiter.record({ key: 'tool:s', amount: 10, limit: 20, windowMs: 1_000 })
      advance(2_000)
      const r = limiter.record({ key: 'tool:s', amount: 3, limit: 20, windowMs: 1_000 })
      expect(r.currentSpend).toBe(3)
    })

    it('throws on a negative or non-finite amount', () => {
      const { limiter } = createLimiter()

      expect(() => limiter.record({ key: 'k', amount: -1, limit: 20, windowMs: 1_000 })).toThrow(
        RangeError,
      )
      expect(() => limiter.record({ key: 'k', amount: NaN, limit: 20, windowMs: 1_000 })).toThrow(
        RangeError,
      )
      expect(() =>
        limiter.record({ key: 'k', amount: Infinity, limit: 20, windowMs: 1_000 }),
      ).toThrow(RangeError)
      // No bucket state was created by the rejected attempts.
      expect(limiter.getKeyState('k')).toBeUndefined()
    })

    it('emits onWarning while within the limit but not past it', () => {
      const time = 1_000_000
      const warnings: number[] = []
      const limiter = new SpendLimiter({
        now: () => time,
        cleanupIntervalMs: 0,
        warningThreshold: 0.8,
        onWarning: (s) => warnings.push(s.current_spend),
      })

      limiter.record({ key: 'tool:w', amount: 10, limit: 20, windowMs: 60_000 }) // 10/20
      expect(warnings).toHaveLength(0)
      limiter.record({ key: 'tool:w', amount: 6, limit: 20, windowMs: 60_000 }) // 16/20 -> 0.8
      expect(warnings).toEqual([16])
      limiter.record({ key: 'tool:w', amount: 10, limit: 20, windowMs: 60_000 }) // 26/20 over
      expect(warnings).toEqual([16]) // no warning on the over-limit append
    })
  })
})
