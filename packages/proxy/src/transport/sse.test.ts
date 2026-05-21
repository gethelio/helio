import { describe, it, expect, vi, afterEach } from 'vitest'
import { Hono } from 'hono'
import { createSseRoute } from './sse.js'
import type { McpForwarder, McpRequest, McpResponse, JsonRpcResponse } from '../mcp/types.js'
import type { SseRouteOptions } from './sse.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockForwarder(response: McpResponse): McpForwarder & { calls: McpRequest[] } {
  const calls: McpRequest[] = []
  return {
    calls,
    forward(req: McpRequest) {
      calls.push(req)
      return Promise.resolve({ response, durationMs: 0 })
    },
  }
}

function createThrowingForwarder(): McpForwarder {
  return {
    forward() {
      return Promise.reject(new Error('upstream exploded'))
    },
  }
}

function mountRoute(forwarder: McpForwarder, options: SseRouteOptions = {}): Hono {
  const app = new Hono()
  app.route('/sse', createSseRoute(forwarder, options))
  return app
}

/** Parse SSE events from a Response body. */
async function readSseEvents(
  response: Response,
  maxEvents = 10,
): Promise<Array<{ event: string; data: string }>> {
  const events: Array<{ event: string; data: string }> = []
  const reader = response.body?.getReader()
  if (!reader) return events

  const decoder = new TextDecoder()
  let buffer = ''

  while (events.length < maxEvents) {
    const chunk = await (reader as ReadableStreamDefaultReader<Uint8Array>).read()
    if (chunk.done) break
    buffer += decoder.decode(chunk.value, { stream: true })

    // Parse complete SSE events (delimited by double newline)
    const parts = buffer.split('\n\n')
    buffer = parts.pop() ?? ''

    for (const part of parts) {
      if (part.trim().length === 0) continue
      let event = ''
      let data = ''
      for (const line of part.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7)
        else if (line.startsWith('data: ')) data = line.slice(6)
      }
      if (event || data) events.push({ event, data })
    }
  }

  reader.releaseLock()
  return events
}

async function readSseEventsWithTimeout(
  response: Response,
  maxEvents: number,
  timeoutMs: number,
): Promise<Array<{ event: string; data: string }>> {
  return Promise.race([
    readSseEvents(response, maxEvents),
    new Promise<Array<{ event: string; data: string }>>((resolve) => {
      setTimeout(() => {
        resolve([])
      }, timeoutMs)
    }),
  ])
}

/** Extract sessionId from an SSE endpoint event's data field. */
function extractSessionId(endpointData: string): string {
  const match = endpointData.match(/sessionId=([a-f0-9-]+)/)
  return match?.[1] ?? ''
}

function postSse(
  app: Hono,
  sessionId: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return app.request(`/sse?sessionId=${sessionId}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SSE transport', () => {
  const okResponse: McpResponse = {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: { jsonrpc: '2.0', id: 1, result: { tools: [] } },
  }

  it('GET /sse returns SSE stream with endpoint event', async () => {
    const forwarder = createMockForwarder(okResponse)
    const app = mountRoute(forwarder)

    const res = await app.request('/sse')

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    expect(res.headers.get('cache-control')).toBe('no-cache')

    const events = await readSseEvents(res, 1)
    expect(events).toHaveLength(1)
    expect(events[0]?.event).toBe('endpoint')
    expect(events[0]?.data).toMatch(/\?sessionId=[a-f0-9-]+/)
  })

  it('POST with valid sessionId forwards request and returns 202', async () => {
    const forwarder = createMockForwarder(okResponse)
    const app = mountRoute(forwarder)

    // Establish SSE connection to get sessionId
    const sseRes = await app.request('/sse')
    const events = await readSseEvents(sseRes, 1)
    const sessionId = extractSessionId(events[0]?.data ?? '')

    const postRes = await postSse(app, sessionId, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    })

    expect(postRes.status).toBe(202)
    expect(forwarder.calls).toHaveLength(1)
    expect(forwarder.calls[0]?.method).toBe('tools/list')
    expect(forwarder.calls[0]?.sessionId).toBe(sessionId)
    expect(forwarder.calls[0]?.signal).toBeDefined()
    expect(forwarder.calls[0]?.signal).toBeInstanceOf(AbortSignal)
  })

  it('POST notification returns 202 with empty body and no SSE response envelope', async () => {
    const forwarder = createMockForwarder(okResponse)
    const app = mountRoute(forwarder)

    const sseRes = await app.request('/sse')
    const events = await readSseEvents(sseRes, 1)
    const sessionId = extractSessionId(events[0]?.data ?? '')

    const postRes = await postSse(app, sessionId, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    })

    expect(postRes.status).toBe(202)
    expect(await postRes.text()).toBe('')
    expect(forwarder.calls).toHaveLength(1)
    expect(forwarder.calls[0]?.method).toBe('notifications/initialized')
    expect(forwarder.calls[0]?.id).toBeUndefined()
    expect(forwarder.calls[0]?.signal).toBeUndefined()

    const messageEvents = await readSseEventsWithTimeout(sseRes, 1, 50)
    expect(messageEvents).toHaveLength(0)
  })

  it('POST notification returns 202 when forwarder throws and emits no SSE response envelope', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const forwarder = createThrowingForwarder()
    const app = mountRoute(forwarder)

    const sseRes = await app.request('/sse')
    const events = await readSseEvents(sseRes, 1)
    const sessionId = extractSessionId(events[0]?.data ?? '')

    const postRes = await postSse(app, sessionId, {
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 'req-1' },
    })

    expect(postRes.status).toBe(202)
    expect(await postRes.text()).toBe('')

    await Promise.resolve()
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[helio] Upstream notification forward failed'),
    )

    const messageEvents = await readSseEventsWithTimeout(sseRes, 1, 50)
    expect(messageEvents).toHaveLength(0)
    errorSpy.mockRestore()
  })

  it('POST with unknown sessionId returns 404', async () => {
    const forwarder = createMockForwarder(okResponse)
    const app = mountRoute(forwarder)

    const res = await postSse(app, 'nonexistent-session', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    })

    expect(res.status).toBe(404)
    const json = (await res.json()) as JsonRpcResponse
    expect(json.error?.message).toContain('unknown session')
    expect(forwarder.calls).toHaveLength(0)
  })

  it('POST without sessionId returns 400', async () => {
    const forwarder = createMockForwarder(okResponse)
    const app = mountRoute(forwarder)

    const res = await app.request('/sse', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      headers: { 'Content-Type': 'application/json' },
    })

    expect(res.status).toBe(400)
    const json = (await res.json()) as JsonRpcResponse
    expect(json.error?.message).toContain('sessionId')
  })

  it('returns 415 when Content-Type is not application/json', async () => {
    const forwarder = createMockForwarder(okResponse)
    const app = mountRoute(forwarder)

    const sseRes = await app.request('/sse')
    const events = await readSseEvents(sseRes, 1)
    const sessionId = extractSessionId(events[0]?.data ?? '')

    const res = await app.request(`/sse?sessionId=${sessionId}`, {
      method: 'POST',
      body: 'not json',
      headers: { 'Content-Type': 'text/plain' },
    })

    expect(res.status).toBe(415)
  })

  it('returns -32700 for malformed JSON', async () => {
    const forwarder = createMockForwarder(okResponse)
    const app = mountRoute(forwarder)

    const sseRes = await app.request('/sse')
    const events = await readSseEvents(sseRes, 1)
    const sessionId = extractSessionId(events[0]?.data ?? '')

    const res = await app.request(`/sse?sessionId=${sessionId}`, {
      method: 'POST',
      body: '{bad json!!!',
      headers: { 'Content-Type': 'application/json' },
    })

    expect(res.status).toBe(400)
    const json = (await res.json()) as JsonRpcResponse
    expect(json.error?.code).toBe(-32700)
  })

  it('returns -32600 for invalid JSON-RPC', async () => {
    const forwarder = createMockForwarder(okResponse)
    const app = mountRoute(forwarder)

    const sseRes = await app.request('/sse')
    const events = await readSseEvents(sseRes, 1)
    const sessionId = extractSessionId(events[0]?.data ?? '')

    const res = await postSse(app, sessionId, { method: 'tools/list' })

    expect(res.status).toBe(400)
    const json = (await res.json()) as JsonRpcResponse
    expect(json.error?.code).toBe(-32600)
  })

  it('emits normalized JSON-RPC error event when forwarder throws', async () => {
    const forwarder = createThrowingForwarder()
    const app = mountRoute(forwarder)

    const sseRes = await app.request('/sse')
    const events = await readSseEvents(sseRes, 1)
    const sessionId = extractSessionId(events[0]?.data ?? '')

    const res = await postSse(app, sessionId, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    })

    expect(res.status).toBe(202)
    const messageEvents = await readSseEvents(sseRes, 1)
    expect(messageEvents).toHaveLength(1)
    expect(messageEvents[0]?.event).toBe('message')
    const payload = JSON.parse(messageEvents[0]?.data ?? '{}') as JsonRpcResponse
    expect(payload.error?.code).toBe(-32603)
    const data = payload.error?.data as Record<string, unknown>
    expect(data['failure_class']).toBe('upstream_forward_error')
  })

  it('emits normalized JSON-RPC error for non-JSON-RPC upstream body', async () => {
    const forwarder = createMockForwarder({
      status: 500,
      headers: { 'content-type': 'text/plain' },
      body: 'upstream failed',
    })
    const app = mountRoute(forwarder)

    const sseRes = await app.request('/sse')
    const events = await readSseEvents(sseRes, 1)
    const sessionId = extractSessionId(events[0]?.data ?? '')

    const res = await postSse(app, sessionId, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    })

    expect(res.status).toBe(202)
    const messageEvents = await readSseEvents(sseRes, 1)
    const payload = JSON.parse(messageEvents[0]?.data ?? '{}') as JsonRpcResponse
    expect(payload.error?.code).toBe(-32603)
    const data = payload.error?.data as Record<string, unknown>
    expect(data['failure_class']).toBe('upstream_invalid_jsonrpc')
    expect(data['upstream_http_status']).toBe(500)
    expect(data['upstream_content_type']).toBe('text/plain')
  })

  it('forwards Authorization but not caller X-* headers by default', async () => {
    const forwarder = createMockForwarder(okResponse)
    const app = mountRoute(forwarder)

    const sseRes = await app.request('/sse')
    const events = await readSseEvents(sseRes, 1)
    const sessionId = extractSessionId(events[0]?.data ?? '')

    await postSse(
      app,
      sessionId,
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { Authorization: 'Bearer token', 'X-Request-Id': 'req-123' },
    )

    expect(forwarder.calls[0]?.headers?.['authorization']).toBe('Bearer token')
    expect(forwarder.calls[0]?.headers?.['x-request-id']).toBeUndefined()
  })

  it('forwards allowlisted caller X-* headers', async () => {
    const forwarder = createMockForwarder(okResponse)
    const app = mountRoute(forwarder, {
      forwardHeadersAllowlist: ['x-request-id'],
    })

    const sseRes = await app.request('/sse')
    const events = await readSseEvents(sseRes, 1)
    const sessionId = extractSessionId(events[0]?.data ?? '')

    await postSse(
      app,
      sessionId,
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { Authorization: 'Bearer token', 'X-Request-Id': 'req-123', 'X-Trace-Id': 'trace-456' },
    )

    expect(forwarder.calls[0]?.headers?.['authorization']).toBe('Bearer token')
    expect(forwarder.calls[0]?.headers?.['x-request-id']).toBe('req-123')
    expect(forwarder.calls[0]?.headers?.['x-trace-id']).toBeUndefined()
  })
})

describe('SSE transport — stale session sweeper', () => {
  const okResponse: McpResponse = {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: { jsonrpc: '2.0', id: 1, result: { tools: [] } },
  }

  afterEach(() => {
    vi.useRealTimers()
  })

  it('evicts sessions idle past the stale threshold', async () => {
    vi.useFakeTimers()
    const forwarder = createMockForwarder(okResponse)
    const app = mountRoute(forwarder)

    const sseRes = await app.request('/sse')
    const events = await readSseEvents(sseRes, 1)
    const sessionId = extractSessionId(events[0]?.data ?? '')
    expect(sessionId).not.toBe('')

    const live = await postSse(app, sessionId, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    })
    expect(live.status).toBe(202)

    // Advance well past the 90s stale threshold. Sweep fires every 60s.
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)

    const stale = await postSse(app, sessionId, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    })
    expect(stale.status).toBe(404)
    const json = (await stale.json()) as JsonRpcResponse
    expect(json.error?.message).toContain('unknown session')
  })

  it('keeps sessions alive while activity refreshes lastActivity', async () => {
    vi.useFakeTimers()
    const forwarder = createMockForwarder(okResponse)
    const app = mountRoute(forwarder)

    const sseRes = await app.request('/sse')
    const events = await readSseEvents(sseRes, 1)
    const sessionId = extractSessionId(events[0]?.data ?? '')

    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(30_000)
      const res = await postSse(app, sessionId, {
        jsonrpc: '2.0',
        id: i + 1,
        method: 'tools/list',
      })
      expect(res.status).toBe(202)
    }
  })
})
