/**
 * Build the per-request header map that is allowed to cross the proxy
 * boundary and be forwarded to upstream MCP servers.
 *
 * Rules:
 * - `authorization` is always forwarded when present.
 * - Caller-supplied custom headers are forwarded only when they are in
 *   the explicit allowlist (case-insensitive).
 * - Only `x-*` custom headers are eligible for allowlisting.
 */
export function buildForwardHeaders(
  requestHeaders: Headers,
  allowlist: readonly string[],
): Record<string, string> | undefined {
  const forwardHeaders: Record<string, string> = {}
  const allowed = new Set(allowlist.map((name) => name.toLowerCase()))

  const authorization = requestHeaders.get('authorization')
  if (authorization) {
    forwardHeaders['authorization'] = authorization
  }

  requestHeaders.forEach((value, key) => {
    const normalized = key.toLowerCase()
    if (!normalized.startsWith('x-')) return
    if (!allowed.has(normalized)) return
    forwardHeaders[normalized] = value
  })

  return Object.keys(forwardHeaders).length > 0 ? forwardHeaders : undefined
}
