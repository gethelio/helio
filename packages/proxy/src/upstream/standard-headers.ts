/**
 * Compute the MCP spec revision 2026-07-28 "standard request headers" for a
 * single Streamable HTTP POST: `Mcp-Method` mirrors the JSON-RPC `method` on
 * every request, and `Mcp-Name` mirrors `params.name` / `params.uri` on the
 * three methods the spec singles out. Header names are lower-case literals
 * to match the outbound merge convention (`merge-headers.ts`); names are
 * case-insensitive on the wire.
 */

const SENTINEL_PREFIX = '=?base64?'
const SENTINEL_SUFFIX = '?='

// Best-effort harm reduction, not a guarantee: this cap is per-header, while
// server limits are typically a TOTAL header-block budget (Node's default
// `maxHeaderSize` is 16 KB). A sub-cap name plus a multi-KB `Authorization`
// can still trip an upstream limit; 8 KB just leaves headroom inside Node's
// default. Revisit when relays become modern-versioned (#219): against a
// 2026-07-28 upstream, omitting `mcp-name` on a name-bearing method is a
// guaranteed `-32020` rejection, no longer the harmless fallback it is today.
// No config surface on purpose — it is a constant, not a tuning knob.
export const MCP_NAME_MAX_BYTES = 8192

// A Map, not a plain object literal: `method` is attacker-controlled input,
// and a plain-object lookup resolves inherited Object.prototype keys (e.g.
// `method === '__proto__'` returns `Object.prototype` itself, which is
// truthy and then coerces to the string key `"[object Object]"` when used
// to index `params`). A Map has no prototype chain to leak through, so
// `.get()` returns `undefined` for every method outside this table.
const NAME_SOURCE_FIELD = new Map<string, 'name' | 'uri'>([
  ['tools/call', 'name'],
  ['prompts/get', 'name'],
  ['resources/read', 'uri'],
])

/**
 * True iff the spec's Value Encoding rules require wrapping `value` in the
 * `=?base64?...?=` sentinel before it is safe to stamp on `Mcp-Name`.
 */
export function needsSentinelEncoding(value: string): boolean {
  const hasUnsafeChar = /[^\t\x20-\x7E]/.test(value)
  const hasEdgeWhitespace = /^[ \t]/.test(value) || /[ \t]$/.test(value)
  const looksLikeSentinel = value.startsWith(SENTINEL_PREFIX) && value.endsWith(SENTINEL_SUFFIX)
  return hasUnsafeChar || hasEdgeWhitespace || looksLikeSentinel
}

/** Wrap `value` in the sentinel, base64-encoding its UTF-8 bytes. */
export function encodeSentinelValue(value: string): string {
  return `${SENTINEL_PREFIX}${Buffer.from(value, 'utf8').toString('base64')}${SENTINEL_SUFFIX}`
}

function extractName(method: string, params: unknown): string | undefined {
  const field = NAME_SOURCE_FIELD.get(method)
  if (!field || typeof params !== 'object' || params === null || Array.isArray(params)) {
    return undefined
  }
  const raw = (params as Record<string, unknown>)[field]
  return typeof raw === 'string' ? raw : undefined
}

export function buildStandardRequestHeaders(
  method: string,
  params: unknown,
): Record<string, string> {
  // The guard below exists to stop a header from silently lying about the
  // body, not merely to avoid a thrown fetch error. Verified empirically on
  // Node 24: undici trims leading/trailing whitespace from header values
  // without erroring (`' padded '` arrives as `'padded'`, a mismatch a
  // strict validator rejects and a routing intermediary can silently
  // mis-trust instead), and Latin-1-range non-ASCII (e.g. `héllo`, 0xE9)
  // transmits unthrown as a raw Latin-1 byte that a UTF-8-decoding server
  // reads as mojibake. Only characters above 0xFF and CR/LF/NUL throw a
  // TypeError, so narrowing this to "whatever doesn't throw" would let both
  // cases back in. The spec defines sentinel encoding for `Mcp-Name` only —
  // there is no encoded form for `Mcp-Method` — so the only spec-conformant
  // options are stamp-verbatim or omit; omitting here (rather than throwing)
  // preserves today's forwardability for methods outside the visible-ASCII
  // token set.
  if (!/^[\x21-\x7E]+$/.test(method)) {
    return {}
  }

  const headers: Record<string, string> = { 'mcp-method': method }

  const name = extractName(method, params)
  if (name !== undefined) {
    const value = needsSentinelEncoding(name) ? encodeSentinelValue(name) : name
    if (Buffer.byteLength(value) <= MCP_NAME_MAX_BYTES) {
      headers['mcp-name'] = value
    }
  }

  return headers
}
