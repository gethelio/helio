// ---------------------------------------------------------------------------
// Canonical JSON — deterministic, key-sorted serialization.
//
// Used wherever two structurally-equal values must produce the same string:
// tool-definition fingerprinting for drift detection (annotation-cache) and
// idempotency hashing of /audit payloads (sideband governance, issue #12, D5).
// ---------------------------------------------------------------------------

/** Deterministic JSON encoding with recursively sorted object keys. */
export function canonicalize(value: unknown): string {
  // JSON.stringify returns undefined for top-level `undefined` at runtime even
  // though its TS overloads type the return as `string` for non-undefined
  // inputs. The explicit widening annotation keeps the coalesce legitimate.
  const encoded: string | undefined = JSON.stringify(sortKeysDeep(value))
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- see above: runtime diverges from TS overload
  return encoded ?? ''
}

/** Recursively sort object keys so structurally-equal values encode equally. */
export function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) {
      // Object.defineProperty (not assignment) so a JSON-parsed "__proto__"
      // key becomes an own property instead of silently setting the
      // prototype — otherwise content under that key never registers, a blind
      // spot in a security control.
      Object.defineProperty(out, key, {
        value: sortKeysDeep(source[key]),
        enumerable: true,
        writable: true,
        configurable: true,
      })
    }
    return out
  }
  return value
}
