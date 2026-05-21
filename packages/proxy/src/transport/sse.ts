import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { z } from 'zod'
import { PARSE_ERROR, INVALID_REQUEST, makeJsonRpcError } from '../mcp/types.js'
import type { McpForwarder, McpRequest } from '../mcp/types.js'
import { parseJsonRpcRequest } from '../mcp/validation.js'
import { buildForwardHeaders } from './forward-headers.js'
import { normalizeUpstreamOutcome } from './response-normalizer.js'

const encoder = new TextEncoder()

// Stale-session sweeper tuning. Mirrors the dashboard SSE sweep in
// dashboard/api.ts: a session that has not had a successful write in
// STALE_THRESHOLD_MS (~3 missed heartbeats at 30s cadence) is evicted so
// the session map cannot grow unboundedly when clients disappear without
// a clean abort signal.
const STALE_THRESHOLD_MS = 90_000
const SWEEP_INTERVAL_MS = 60_000

interface SseSession {
  writer: WritableStreamDefaultWriter<Uint8Array>
  lastActivity: number
}

/** Options for SSE route request-forwarding behavior. */
export interface SseRouteOptions {
  /** Caller `x-*` headers that may be forwarded upstream. */
  readonly forwardHeadersAllowlist?: readonly string[]
}

const ssePostQuerySchema = z.object({
  sessionId: z.string().min(1),
})

/** Format an SSE event string. */
function sseEvent(event: string, data: string): string {
  return `event: ${event}\ndata: ${data}\n\n`
}

/**
 * Create a Hono sub-app that handles MCP SSE transport.
 *
 * Older MCP clients connect via GET to establish an SSE stream, then
 * POST JSON-RPC messages. Responses are pushed back through the SSE stream.
 */
export function createSseRoute(forwarder: McpForwarder, options: SseRouteOptions = {}): Hono {
  const sessions = new Map<string, SseSession>()
  const app = new Hono()
  const forwardHeaderAllowlist = options.forwardHeadersAllowlist ?? []

  const writeSessionEvent = (sessionId: string, eventPayload: string): void => {
    const session = sessions.get(sessionId)
    if (!session) return
    session.lastActivity = Date.now()

    void session.writer.write(encoder.encode(eventPayload)).catch(() => {
      sessions.delete(sessionId)
      void session.writer.close().catch(() => {
        // Expected if the writer is already closed.
      })
    })
  }

  const sweepInterval = setInterval(() => {
    const now = Date.now()
    for (const [id, session] of sessions) {
      if (now - session.lastActivity > STALE_THRESHOLD_MS) {
        sessions.delete(id)
        void session.writer.close().catch(() => {
          // Expected if the writer is already closed.
        })
      }
    }
  }, SWEEP_INTERVAL_MS)
  sweepInterval.unref()

  // SSE connection — client establishes the event stream
  app.get('/', (c) => {
    const sessionId = randomUUID()
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
    const writer = writable.getWriter()

    sessions.set(sessionId, { writer, lastActivity: Date.now() })

    // Send the endpoint event so the client knows where to POST
    const endpointData = sseEvent('endpoint', `?sessionId=${sessionId}`)
    writeSessionEvent(sessionId, endpointData)

    // Clean up on disconnect
    c.req.raw.signal.addEventListener('abort', () => {
      sessions.delete(sessionId)
      void writer.close().catch(() => {
        // Expected on client disconnect — writer already closed
      })
    })

    return new Response(readable, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      },
    })
  })

  // Message endpoint — client POSTs JSON-RPC requests here
  app.post('/', async (c) => {
    const parsedQuery = ssePostQuerySchema.safeParse(c.req.query())
    if (!parsedQuery.success) {
      return c.json(
        makeJsonRpcError(null, INVALID_REQUEST, 'missing sessionId query parameter'),
        400,
      )
    }
    const sessionId = parsedQuery.data.sessionId

    const session = sessions.get(sessionId)
    if (!session) {
      return c.json(makeJsonRpcError(null, INVALID_REQUEST, 'unknown session'), 404)
    }

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
      const errorEvent = sseEvent('message', JSON.stringify(normalized.body))
      writeSessionEvent(sessionId, errorEvent)
      return c.body(null, 202)
    }

    // Write response to SSE stream
    const normalized = normalizeUpstreamOutcome({
      requestId: id,
      upstreamResponse: result.response,
    })
    const messageEvent = sseEvent('message', JSON.stringify(normalized.body))
    writeSessionEvent(sessionId, messageEvent)

    return c.body(null, 202)
  })

  return app
}
