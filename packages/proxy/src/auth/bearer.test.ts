import { describe, it, expect } from 'vitest'
import { isSecretDigest, secretDigest, verifyBearer } from './bearer.js'

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

describe('stored digest form', () => {
  const plaintext = 'f'.repeat(64)
  const digest = secretDigest(plaintext)

  it('recognizes only sha256: plus 64 lowercase hex', () => {
    expect(isSecretDigest(digest)).toBe(true)
    expect(isSecretDigest(plaintext)).toBe(false)
    expect(isSecretDigest(`sha256:${'F'.repeat(64)}`)).toBe(false)
    expect(isSecretDigest(`sha256:${'a'.repeat(63)}`)).toBe(false)
    expect(isSecretDigest(`sha256:${'z'.repeat(64)}`)).toBe(false)
  })

  it('derives the digest the configuration reference documents', () => {
    expect(secretDigest('your-secret')).toBe(
      'sha256:ef1ea5dd2b28d2c127ffb41c522ac19787f408c19195cc2bebb41e227f664e86',
    )
  })

  it('verifies the plaintext bearer against a stored digest', () => {
    expect(verifyBearer(`Bearer ${plaintext}`, digest)).toBe(true)
  })

  it('rejects the digest itself presented as the bearer', () => {
    expect(verifyBearer(`Bearer ${digest}`, digest)).toBe(false)
  })

  it('rejects a wrong plaintext against a stored digest', () => {
    expect(verifyBearer(`Bearer ${'e'.repeat(64)}`, digest)).toBe(false)
  })

  it('still verifies a bare hex plaintext against itself', () => {
    expect(verifyBearer(`Bearer ${plaintext}`, plaintext)).toBe(true)
  })
})
