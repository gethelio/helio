import { createHash, timingSafeEqual } from 'node:crypto'

/**
 * Constant-time verification of a `Bearer <secret>` Authorization header.
 *
 * Both sides are hashed to a fixed 32-byte SHA-256 digest before the
 * timing-safe comparison, so the underlying `timingSafeEqual` call is
 * always invoked with equal-length buffers. That removes the
 * `a.length === b.length` short-circuit that would otherwise leak the
 * expected token length through a fast-exit on the common "wrong length"
 * case.
 *
 * Returns `false` if the header is missing, the expected secret is
 * missing/empty, the header does not carry the "Bearer " prefix, or the
 * provided token does not match the expected value.
 */
export function verifyBearer(
  authHeader: string | undefined,
  expected: string | undefined,
): boolean {
  if (!authHeader || !expected) return false

  const expectedHeader = `Bearer ${expected}`
  const actualDigest = createHash('sha256').update(authHeader).digest()
  const expectedDigest = createHash('sha256').update(expectedHeader).digest()

  return timingSafeEqual(actualDigest, expectedDigest)
}
