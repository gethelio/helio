import { describe, it, expect } from 'vitest'
import { verifyBearer } from './bearer.js'

describe('verifyBearer', () => {
  const secret = 'correct-horse-battery-staple'

  it('returns true for a matching "Bearer <secret>" header', () => {
    expect(verifyBearer(`Bearer ${secret}`, secret)).toBe(true)
  })

  it('returns false for a missing/empty header', () => {
    expect(verifyBearer('', secret)).toBe(false)
    expect(verifyBearer(undefined, secret)).toBe(false)
  })

  it('returns false for the wrong secret', () => {
    expect(verifyBearer('Bearer wrong', secret)).toBe(false)
  })

  it('returns false when the header is a prefix of the expected token', () => {
    // Pre-fix, the `a.length === b.length` short-circuit leaked the fact that
    // a shorter header is never equal, in constant time but with a fast exit.
    // After the fix both sides are hashed to a fixed length, so there is no
    // length-dependent early exit — the function still returns false here.
    expect(verifyBearer('Bearer correct-horse-batte', secret)).toBe(false)
  })

  it('returns false when the header is longer than the expected token', () => {
    expect(verifyBearer(`Bearer ${secret}extra`, secret)).toBe(false)
  })

  it('returns false for a plain token without the Bearer prefix', () => {
    // We require the full "Bearer <secret>" form, not a bare token.
    expect(verifyBearer(secret, secret)).toBe(false)
  })

  it('returns false when the expected secret is empty or undefined', () => {
    expect(verifyBearer('Bearer anything', '')).toBe(false)
    expect(verifyBearer('Bearer anything', undefined)).toBe(false)
  })
})
