/**
 * Merge the three header sources that feed an upstream request, normalising
 * every name to lower-case so case-only duplicates collapse to one header.
 *
 * Precedence (later wins): base defaults → caller-forwarded → static config.
 * Static `upstream.headers` deliberately override caller-forwarded headers so
 * a downstream client cannot clobber an operator-provided credential such as
 * `Authorization`.
 *
 * Note: `Mcp-Session-Id` is applied by the forwarder after this merge and is
 * not passed through here.
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
