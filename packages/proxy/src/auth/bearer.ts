import { createHash, timingSafeEqual } from 'node:crypto'

const BEARER_PREFIX = 'Bearer '

/** The stored-digest form of a bearer secret: `sha256:` plus 64 lowercase hex. */
const DIGEST_PATTERN = /^sha256:([0-9a-f]{64})$/

/** True when `value` is the stored-digest form (`sha256:<64 lowercase hex>`). */
export function isSecretDigest(value: string): boolean {
  return DIGEST_PATTERN.test(value)
}

/**
 * The stored-digest form of a plaintext secret: `sha256:` plus the lowercase
 * hex SHA-256 of the UTF-8 plaintext.
 *
 * Plain SHA-256 with no salt and no KDF is adequate here because every secret
 * Helio generates (`helio init`, `helio secret`) is 256 bits of CSPRNG output,
 * an API token rather than a human-chosen password: there is nothing for a
 * dictionary or a rainbow table to find. Revisit this if operators are ever
 * allowed to choose a memorable secret.
 *
 * A plaintext that itself has this shape is indistinguishable from a digest
 * and is treated as one, so it can no longer be presented. Helio never
 * generates a plaintext of that shape.
 */
export function secretDigest(plaintext: string): string {
  return `sha256:${createHash('sha256').update(plaintext, 'utf-8').digest('hex')}`
}

/**
 * Constant-time verification of a `Bearer <secret>` Authorization header.
 *
 * The presented token is hashed to a fixed 32-byte SHA-256 digest and compared
 * with `timingSafeEqual` against the stored side, which is either a stored
 * digest (`sha256:<hex>`, decoded) or the SHA-256 of a stored plaintext. Both
 * paths compare equal-length buffers, so the `a.length === b.length`
 * short-circuit never leaks the expected token length, and the branch is
 * chosen by the stored value's shape, never by the presented value.
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
  if (!authHeader.startsWith(BEARER_PREFIX)) return false

  const presented = authHeader.slice(BEARER_PREFIX.length)
  const storedHex = DIGEST_PATTERN.exec(expected)?.[1]
  const expectedDigest =
    storedHex !== undefined
      ? Buffer.from(storedHex, 'hex')
      : createHash('sha256').update(expected, 'utf-8').digest()
  const actualDigest = createHash('sha256').update(presented, 'utf-8').digest()

  return timingSafeEqual(actualDigest, expectedDigest)
}
