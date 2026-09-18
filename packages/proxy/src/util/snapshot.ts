/**
 * Snapshot a caller-owned value before a store keeps it (issues #192
 * and #379). `structuredClone` first: it keeps cycles, `Date`, `Map`,
 * and BigInt. A value it refuses (a function, a symbol, a `Proxy`, an
 * object with a `toJSON`) falls back to the JSON form, which is what the
 * wire would carry; that tier calls a caller's own `toJSON` once. A
 * value neither can serialize (a throwing getter, a throwing `toJSON`)
 * is returned as is: the store then aliases the caller's object, which
 * is the documented residual, and nothing on the HTTP routes could
 * serialize such a value either. Never throws: a snapshot failure must
 * not block a write or a decision already made.
 */
export function snapshotValue<T>(value: T): T {
  try {
    return structuredClone(value)
  } catch {
    // fall through
  }
  try {
    return JSON.parse(JSON.stringify(value)) as T
  } catch {
    return value
  }
}
