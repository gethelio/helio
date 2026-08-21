/**
 * Merge the three header sources that feed an upstream request, normalizing
 * every name to lower-case so case-only duplicates collapse to one header.
 *
 * Precedence (later wins): base defaults → caller-forwarded → static config.
 * Static `upstream.headers` deliberately override caller-forwarded headers so
 * a downstream client cannot clobber an operator-provided credential such as
 * `Authorization`.
 *
 * Note: reserved names such as `Mcp-Session-Id` pass through this fold
 * like any other key. Stripping them is each caller's own business: the
 * Streamable HTTP send() and the SSE message POSTs delete
 * `mcp-session-id` after the merge, then stamp their own value only
 * when a session id exists. The same two send paths also re-stamp
 * `content-type: application/json` over whatever survived the fold and
 * drop a merged `content-length`, so the wire always describes the body
 * they themselves serialize.
 */
export function mergeUpstreamHeaders(
  base: Record<string, string>,
  forwarded: Record<string, string>,
  staticHeaders: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {}
  const apply = (headers: Record<string, string>) => {
    for (const [name, value] of Object.entries(headers)) {
      out[name.toLowerCase()] = value
    }
  }
  apply(base)
  apply(forwarded)
  apply(staticHeaders)
  return out
}
