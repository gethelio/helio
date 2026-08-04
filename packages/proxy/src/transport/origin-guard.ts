import type { MiddlewareHandler } from 'hono'
import { INVALID_REQUEST, makeJsonRpcErrorWithoutId } from '../mcp/types.js'

// Rejection-log bounds. The origin is fully attacker-chosen on a public-facing
// path, so both the dedupe set and the logged string must be capped — an
// unbounded set is a memory vector, an unbounded string a log-flooding one.
// Mirrors the evidence-store rejection-warning pattern (evidence/store.ts).
const MAX_UNIQUE_ORIGIN_WARNINGS = 20
const SUPPRESSED_WARNING_SUMMARY_INTERVAL = 50
const LOGGED_ORIGIN_MAX_LENGTH = 256

/**
 * Create middleware that enforces the MCP Origin allowlist (issue #213).
 *
 * Any request carrying an `Origin` header not exactly present in
 * `allowedOrigins` is refused with 403 and a JSON-RPC error body that omits
 * `id` (the request was never parsed) and does not echo the origin back.
 * Requests without an `Origin` header pass through untouched — legitimate
 * MCP clients are non-browser processes and never send one.
 *
 * Register this BEFORE the route handlers: Hono runs middleware in
 * registration order, and a guard registered after `app.post('/')` never
 * runs for matched requests.
 */
export function createOriginGuard(allowedOrigins: readonly string[]): MiddlewareHandler {
  const allowed = new Set(allowedOrigins)
  const warnedOrigins = new Set<string>()
  let suppressedWarningCount = 0

  const logRejection = (origin: string): void => {
    const displayOrigin =
      origin.length > LOGGED_ORIGIN_MAX_LENGTH
        ? `${origin.slice(0, LOGGED_ORIGIN_MAX_LENGTH)}… (truncated)`
        : origin
    if (warnedOrigins.has(displayOrigin)) return
    if (warnedOrigins.size < MAX_UNIQUE_ORIGIN_WARNINGS) {
      warnedOrigins.add(displayOrigin)
      // eslint-disable-next-line no-console -- operational error logging
      console.error(`[helio] Rejected request with disallowed Origin: ${displayOrigin}`)
      return
    }
    // Past the cap the origin is not recorded, so repeats of the same one keep
    // counting: this tallies suppressed rejections, not distinct origins.
    suppressedWarningCount += 1
    if (
      suppressedWarningCount === 1 ||
      suppressedWarningCount % SUPPRESSED_WARNING_SUMMARY_INTERVAL === 0
    ) {
      // eslint-disable-next-line no-console -- operational error logging
      console.error(
        `[helio] Origin rejection warnings: logged ${String(MAX_UNIQUE_ORIGIN_WARNINGS)} distinct origins and are suppressing the rest (${String(suppressedWarningCount)} further rejections so far).`,
      )
    }
  }

  return async (c, next) => {
    const origin = c.req.header('origin')
    if (origin !== undefined && !allowed.has(origin)) {
      logRejection(origin)
      return c.json(makeJsonRpcErrorWithoutId(INVALID_REQUEST, 'Origin not allowed'), 403)
    }
    await next()
  }
}
