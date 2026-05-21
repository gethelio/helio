/**
 * Clamp a number to an inclusive `[min, max]` range.
 *
 * Used by list endpoints and store queries to enforce pagination limits.
 */
export function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

/**
 * Parse a query-string integer value and clamp it to `[min, max]`.
 *
 * Returns `fallback` when `value` is `undefined` or not a parseable integer.
 * Used by Hono route handlers to sanitize `?limit=…` / `?offset=…` style
 * query parameters before passing them to the underlying store.
 */
export function clampInt(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback
  const n = parseInt(value, 10)
  if (Number.isNaN(n)) return fallback
  return clamp(n, min, max)
}
