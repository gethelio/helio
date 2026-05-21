import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { PARSE_ERROR, INVALID_REQUEST, makeJsonRpcError } from '../mcp/types.js'
import type { McpForwarder, McpRequest } from '../mcp/types.js'
import { parseJsonRpcRequest } from '../mcp/validation.js'
import { buildForwardHeaders } from './forward-headers.js'
import { normalizeUpstreamOutcome } from './response-normalizer.js'

const MCP_SESSION_HEADER = 'mcp-session-id'

/** Headers allowed to pass from upstream response to the client. */
const ALLOWED_RESPONSE_HEADERS = new Set(['content-type', 'mcp-session-id'])

/** Options for streamable transport request forwarding behavior. */
export interface StreamableHttpRouteOptions {
  /** Caller `x-*` headers that may be forwarded upstream. */
  readonly forwardHeadersAllowlist?: readonly string[]
}

/**
 * Create a Hono sub-app that handles MCP Streamable HTTP transport.
 *
 * Accepts JSON-RPC POST requests, validates the envelope, extracts the
 * MCP session ID, and delegates to the provided forwarder.
 */
export function createStreamableHttpRoute(
  forwarder: McpForwarder,
  options: StreamableHttpRouteOptions = {},
): Hono {
  const app = new Hono()
  const forwardHeaderAllowlist = options.forwardHeadersAllowlist ?? []

  app.post('/', async (c) => {
    // Require JSON content type
    const contentType = c.req.header('content-type') ?? ''
    if (!contentType.includes('application/json')) {
      return c.json(
        makeJsonRpcError(null, INVALID_REQUEST, 'Content-Type must be application/json'),
        415,
      )
    }

    // Parse JSON body
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json(makeJsonRpcError(null, PARSE_ERROR, 'invalid JSON'), 400)
    }

    // Validate JSON-RPC envelope
    const parsedRequest = parseJsonRpcRequest(body)
    if (!parsedRequest.success) {
      return c.json(makeJsonRpcError(parsedRequest.id, INVALID_REQUEST, parsedRequest.message), 400)
    }

    const id = parsedRequest.request.id
    const method = parsedRequest.request.method
    const params = parsedRequest.request.params

    // Extract MCP session ID
    const sessionId = c.req.header(MCP_SESSION_HEADER)

    const forwardHeaders = buildForwardHeaders(c.req.raw.headers, forwardHeaderAllowlist)

    // Build MCP request
    const mcpRequest: McpRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
      sessionId,
      headers: forwardHeaders,
      signal: c.req.raw.signal,
    }

    // JSON-RPC notifications (no id) are fire-and-forget.
    // Forward upstream without tying to the downstream abort lifecycle, and
    // return 202 Accepted with an empty body.
    if (id === undefined) {
      const notificationRequest: McpRequest = { ...mcpRequest, signal: undefined }
      void forwarder.forward(notificationRequest).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        // eslint-disable-next-line no-console -- operational error logging
        console.error(`[helio] Upstream notification forward failed (${method}): ${message}`)
      })
      return c.body(null, 202)
    }

    // Forward to upstream
    let result
    try {
      result = await forwarder.forward(mcpRequest)
    } catch (err) {
      const forwardingError = err instanceof Error ? err : new Error(String(err))
      // eslint-disable-next-line no-console -- operational error logging
      console.error('[helio] Upstream forwarding failed:', forwardingError.message)
      const normalized = normalizeUpstreamOutcome({ requestId: id, forwardingError })
      return c.json(normalized.body, normalized.httpStatus)
    }

    // Write allowed response headers
    const { response } = result
    for (const [key, value] of Object.entries(response.headers)) {
      if (ALLOWED_RESPONSE_HEADERS.has(key.toLowerCase())) {
        c.header(key, value)
      }
    }
    const normalized = normalizeUpstreamOutcome({ requestId: id, upstreamResponse: response })
    return c.json(normalized.body, normalized.httpStatus as ContentfulStatusCode)
  })

  return app
}
