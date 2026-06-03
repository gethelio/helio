/**
 * Operator-facing guidance for an unreachable upstream MCP server.
 *
 * Node's `fetch` (undici) collapses every transport-level failure into a
 * terse `TypeError: fetch failed`, hiding the URL and the real cause behind a
 * nested `.cause`. When Helio surfaces that verbatim — for example while
 * priming the annotation cache at startup — operators see "fetch failed" with
 * no hint that the actual problem is "nothing is listening at upstream.url".
 * This helper translates those failures into a clear, URL-aware message.
 */

/** Docs link surfaced when the upstream MCP server cannot be reached. */
const UPSTREAM_DOCS_URL = 'https://github.com/gethelio/helio/blob/main/docs/getting-started.md'

/**
 * System-level error codes that mean the upstream server could not be reached
 * at the transport layer (DNS, TCP connect, or socket reset) — as opposed to
 * an application-level error returned by a server that did respond.
 */
const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
])

/**
 * Walk the `.cause` chain of a thrown error to find the first string `code`.
 * undici nests the real system error one or more levels below the wrapper.
 */
function extractErrorCode(error: unknown): string | undefined {
  let current: unknown = error
  for (let depth = 0; depth < 5 && current != null; depth += 1) {
    if (typeof current === 'object' && 'code' in current) {
      const code = (current as { code?: unknown }).code
      if (typeof code === 'string') return code
    }
    current = (current as { cause?: unknown }).cause
  }
  return undefined
}

/**
 * If `error` indicates the upstream server is unreachable at the transport
 * level, return a clear operator-facing Error that names the URL and points to
 * the docs. Returns `null` for anything that does not look like a connection
 * failure, so callers can rethrow the original error unchanged.
 */
export function describeUnreachableUpstream(error: unknown, url: string): Error | null {
  const code = extractErrorCode(error)
  // The generic undici wrapper with no extractable code is still a transport
  // failure (DNS/connect/socket); treat it as unreachable.
  const isGenericFetchFailure = error instanceof TypeError && error.message === 'fetch failed'

  if (code !== undefined) {
    if (!UNREACHABLE_CODES.has(code)) return null
  } else if (!isGenericFetchFailure) {
    return null
  }

  const codeSuffix = code ? ` (${code})` : ''
  return new Error(
    `Upstream MCP server at ${url} is unreachable${codeSuffix} — is it running? ` +
      `Helio proxies an existing MCP server: set upstream.url in helio.yaml to a ` +
      `reachable server, or start the server it points at. See ${UPSTREAM_DOCS_URL}`,
  )
}
