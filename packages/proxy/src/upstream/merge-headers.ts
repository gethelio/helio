/**
 * The Accept value every upstream POST leg advertises: the two response
 * framings Helio itself parses on those legs (issue #304).
 */
export const UPSTREAM_POST_ACCEPT = 'application/json, text/event-stream'

/**
 * The Accept value the SSE connect GET advertises: the connect requires an
 * event stream and can consume nothing else (issue #304).
 */
export const UPSTREAM_SSE_CONNECT_ACCEPT = 'text/event-stream'

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
 * they themselves serialize. The `accept` advertisement is owned the
 * same way (issue #304): the Streamable HTTP send(), the era probe, the
 * legacy `initialize` POSTs, and the SSE connect GET re-stamp their
 * leg's truthful value after the fold, while the SSE message POSTs
 * delete a merged `accept` outright — Helio asserts nothing there, so
 * only the runtime's own default reaches the wire.
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
