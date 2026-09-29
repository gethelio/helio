import type {
  McpForwarder,
  McpForwarderWithInternal,
  McpRequest,
  McpResponse,
} from '../mcp/types.js'

// ---------------------------------------------------------------------------
// The one tools/list step shared by the annotation prime and helio scan
// ---------------------------------------------------------------------------

/** The synthetic request both callers send; the id names the caller in upstream logs. */
const SYNTHETIC_TOOLS_LIST: McpRequest = {
  jsonrpc: '2.0',
  id: 'helio-prime-annotations',
  method: 'tools/list',
}

/**
 * What one internal `tools/list` produced: the whole response for any status
 * below 400 (the caller judges the payload, with `classifyPrimeFailure` when
 * it is unusable), or the classified reason for an HTTP error.
 */
export type ListToolsResult =
  | { readonly ok: true; readonly response: McpResponse }
  | { readonly ok: false; readonly reason: string }

/**
 * Send one `tools/list` to the upstream outside the governed path, on the
 * forwarder's managed internal session when it has one (`forwardInternal`),
 * so session-enforcing servers accept it. An HTTP error, or a throw, leaves
 * that internal session in an unknown state: it is reset here, once, before
 * the result is returned or the same error object is rethrown (its `code`
 * and `cause` intact for the caller's diagnosis).
 */
export async function listToolsInternal(forwarder: McpForwarder): Promise<ListToolsResult> {
  const internal: McpForwarderWithInternal = forwarder
  let response: McpResponse
  try {
    const result =
      typeof internal.forwardInternal === 'function'
        ? await internal.forwardInternal(SYNTHETIC_TOOLS_LIST)
        : await forwarder.forward(SYNTHETIC_TOOLS_LIST)
    response = result.response
  } catch (error) {
    internal.resetInternalSession?.()
    throw error
  }
  // An HTTP error is never a usable tools/list, even if the error body
  // happens to contain a result.tools-shaped payload.
  if (response.status >= 400) {
    internal.resetInternalSession?.()
    return { ok: false, reason: classifyPrimeFailure(response) }
  }
  return { ok: true, response }
}

/** Produce an actionable reason when a tools/list response is unusable. */
export function classifyPrimeFailure(response: McpResponse): string {
  if (response.status >= 400) {
    return `upstream returned HTTP ${String(response.status)} to tools/list (session/initialize may be required)`
  }
  const rawBody = response.body
  if (typeof rawBody !== 'object' || rawBody === null) {
    return `upstream tools/list returned a non-JSON body (content-type ${response.headers['content-type'] ?? 'unknown'})`
  }
  const body = rawBody as Record<string, unknown>
  const error = body['error']
  if (typeof error === 'string') {
    // Non-conforming upstreams sometimes return a bare string error.
    return `upstream tools/list returned a JSON-RPC error: ${error}`
  }
  if (error !== null && typeof error === 'object') {
    const message = (error as Record<string, unknown>)['message']
    if (typeof message === 'string') {
      return `upstream tools/list returned a JSON-RPC error: ${message}`
    }
  }
  return 'upstream tools/list response was missing result.tools'
}
