import { describe, it, expect, afterEach } from 'vitest'
import type { AddressInfo } from 'node:net'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import type { ServerType } from '@hono/node-server'
import { SseUpstreamForwarder } from './sse-forwarder.js'
import type { McpRequest } from '../mcp/types.js'

// ---------------------------------------------------------------------------
// Mock SSE upstream server
// ---------------------------------------------------------------------------

interface MockSseServer {
  server: ServerType
  port: number
  /** Captured POST bodies for assertions. */
  receivedBodies: unknown[]
  /** Captured POST request headers (lowercased names) for assertions. */
  receivedHeaders: Record<string, string>[]
}

/**
 * Create a mock MCP server that speaks SSE transport.
 * GET / returns SSE stream with endpoint event.
 * POST /messages accepts JSON-RPC and pushes response on the SSE stream.
 */
function createMockSseServer(postStatus: number = 202): MockSseServer {
  const receivedBodies: unknown[] = []
  const receivedHeaders: Record<string, string>[] = []
  const app = new Hono()

  // Store SSE writers by session (for simplicity, just use a single writer)
  const writers: WritableStreamDefaultWriter<Uint8Array>[] = []
  const encoder = new TextEncoder()

  app.get('/', () => {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
    const writer = writable.getWriter()
    writers.push(writer)

    // Send endpoint event with relative URL
    const endpointEvent = `event: endpoint\ndata: /messages\n\n`
    void writer.write(encoder.encode(endpointEvent))

    return new Response(readable, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      },
    })
  })

  app.post('/messages', async (c) => {
    const body: { id?: string | number | null; method?: string } = await c.req.json()
    receivedBodies.push(body)
    receivedHeaders.push(Object.fromEntries(c.req.raw.headers))

    if (body.id !== undefined && postStatus === 202) {
      const response = JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result: { method: body.method },
      })
      const messageEvent = `event: message\ndata: ${response}\n\n`
      // Write to all active SSE streams (ignore errors from closed streams)
      for (const writer of writers) {
        void writer.write(encoder.encode(messageEvent)).catch(() => {})
      }
    }

    return c.body(null, postStatus as 202 | 500)
  })

  const server = serve({ fetch: app.fetch, port: 0 })
  const port = (server.address() as AddressInfo).port

  return { server, port, receivedBodies, receivedHeaders }
}

function closeServer(server: ServerType): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}

function makeRequest(id: number, method: string): McpRequest {
  return { jsonrpc: '2.0', id, method }
}

function fetchFailed(code: string): TypeError {
  const wrapper = new TypeError('fetch failed')
  ;(wrapper as { cause?: unknown }).cause = Object.assign(new Error('connect failed'), { code })
  return wrapper
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SseUpstreamForwarder', () => {
  let mock: MockSseServer | null = null
  let forwarder: SseUpstreamForwarder | null = null

  afterEach(async () => {
    if (forwarder) {
      await forwarder.close()
      forwarder = null
    }
    if (mock) {
      await closeServer(mock.server)
      mock = null
    }
  })

  it('connects and learns POST URL from endpoint event', async () => {
    mock = createMockSseServer()
    forwarder = new SseUpstreamForwarder({
      url: `http://127.0.0.1:${String(mock.port)}/`,
    })

    await forwarder.connect()

    // If connect() resolves, the endpoint was received
    const result = await forwarder.forward(makeRequest(1, 'tools/list'))
    expect(result.response.status).toBe(200)
  })

  it('forwards a request and receives response via SSE', async () => {
    mock = createMockSseServer()
    forwarder = new SseUpstreamForwarder({
      url: `http://127.0.0.1:${String(mock.port)}/`,
    })
    await forwarder.connect()

    const result = await forwarder.forward(makeRequest(1, 'tools/list'))

    expect(result.response.body).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { method: 'tools/list' },
    })
  })

  it('measures durationMs', async () => {
    mock = createMockSseServer()
    forwarder = new SseUpstreamForwarder({
      url: `http://127.0.0.1:${String(mock.port)}/`,
    })
    await forwarder.connect()

    const result = await forwarder.forward(makeRequest(1, 'ping'))

    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(result.durationMs).toBeLessThan(5000)
  })

  it('strips session fields and headers from the POST body', async () => {
    mock = createMockSseServer()
    forwarder = new SseUpstreamForwarder({
      url: `http://127.0.0.1:${String(mock.port)}/`,
    })
    await forwarder.connect()

    const request: McpRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      transportSessionId: 'session-123',
      session: { id: 'run-a', source: 'header' },
      headers: { authorization: 'Bearer token' },
    }
    await forwarder.forward(request)

    const sent = mock.receivedBodies[0] as Record<string, unknown>
    expect(sent).not.toHaveProperty('session')
    expect(sent).not.toHaveProperty('transportSessionId')
    expect(sent).not.toHaveProperty('headers')
    expect(sent).toHaveProperty('method', 'tools/list')
  })

  it('sends only transportSessionId upstream as Mcp-Session-Id, never the resolved session', async () => {
    mock = createMockSseServer()
    forwarder = new SseUpstreamForwarder({
      url: `http://127.0.0.1:${String(mock.port)}/`,
    })
    await forwarder.connect()

    await forwarder.forward({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      session: { id: 'run-a', source: 'header' },
    })
    expect(mock.receivedHeaders[0]?.['mcp-session-id']).toBeUndefined()

    await forwarder.forward({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      transportSessionId: 'wire-77',
    })
    expect(mock.receivedHeaders[1]?.['mcp-session-id']).toBe('wire-77')
  })

  it('strips caller-supplied mcp-method and mcp-name from the request POST', async () => {
    mock = createMockSseServer()
    forwarder = new SseUpstreamForwarder({
      url: `http://127.0.0.1:${String(mock.port)}/`,
    })
    await forwarder.connect()

    // Mixed-case Mcp-Name proves the strip runs after the merge lower-cases names.
    await forwarder.forward({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      headers: { 'mcp-method': 'lie', 'Mcp-Name': 'lie-name' },
    })

    expect(mock.receivedHeaders[0]?.['mcp-method']).toBeUndefined()
    expect(mock.receivedHeaders[0]?.['mcp-name']).toBeUndefined()
    expect(mock.receivedBodies[0]).toMatchObject({ method: 'tools/list' })
  })

  it('strips caller-supplied mcp-method and mcp-name from the notification POST', async () => {
    mock = createMockSseServer()
    forwarder = new SseUpstreamForwarder({
      url: `http://127.0.0.1:${String(mock.port)}/`,
    })
    await forwarder.connect()

    await forwarder.forward({
      jsonrpc: '2.0',
      method: 'notifications/ping',
      headers: { 'mcp-method': 'lie', 'Mcp-Name': 'lie-name' },
    })

    expect(mock.receivedHeaders[0]?.['mcp-method']).toBeUndefined()
    expect(mock.receivedHeaders[0]?.['mcp-name']).toBeUndefined()
  })

  it('never sends a caller-supplied mcp-session-id header', async () => {
    mock = createMockSseServer()
    forwarder = new SseUpstreamForwarder({
      url: `http://127.0.0.1:${String(mock.port)}/`,
    })
    await forwarder.connect()

    await forwarder.forward({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      headers: { 'mcp-session-id': 'caller-forged' },
    })

    expect(mock.receivedHeaders[0]?.['mcp-session-id']).toBeUndefined()
  })

  it('sends transportSessionId even when a caller mcp-session-id header is present', async () => {
    mock = createMockSseServer()
    forwarder = new SseUpstreamForwarder({
      url: `http://127.0.0.1:${String(mock.port)}/`,
    })
    await forwarder.connect()

    await forwarder.forward({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      transportSessionId: 'wire-real',
      headers: { 'mcp-session-id': 'caller-forged' },
    })

    expect(mock.receivedHeaders[0]?.['mcp-session-id']).toBe('wire-real')
  })

  it('re-stamps application/json over a caller-supplied content-type on the request POST', async () => {
    mock = createMockSseServer()
    forwarder = new SseUpstreamForwarder({
      url: `http://127.0.0.1:${String(mock.port)}/`,
    })
    await forwarder.connect()

    await forwarder.forward({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      headers: { 'content-type': 'text/evil' },
    })

    expect(mock.receivedHeaders[0]?.['content-type']).toBe('application/json')
  })

  it('re-stamps application/json over a caller-supplied content-type on the notification POST', async () => {
    mock = createMockSseServer()
    forwarder = new SseUpstreamForwarder({
      url: `http://127.0.0.1:${String(mock.port)}/`,
    })
    await forwarder.connect()

    await forwarder.forward({
      jsonrpc: '2.0',
      method: 'notifications/ping',
      headers: { 'content-type': 'text/evil' },
    })

    expect(mock.receivedHeaders[0]?.['content-type']).toBe('application/json')
  })

  it('re-stamps application/json over a constructor static-header content-type', async () => {
    mock = createMockSseServer()
    forwarder = new SseUpstreamForwarder({
      url: `http://127.0.0.1:${String(mock.port)}/`,
      headers: { 'content-type': 'text/plain' },
    })
    await forwarder.connect()

    await forwarder.forward({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    })

    expect(mock.receivedHeaders[0]?.['content-type']).toBe('application/json')
  })

  it('re-stamps application/json whatever the caller content-type key casing', async () => {
    // Mirrors the mixed-case pin above: the re-stamp runs after the merge
    // lower-cases names, so a cased key cannot dodge it.
    mock = createMockSseServer()
    forwarder = new SseUpstreamForwarder({
      url: `http://127.0.0.1:${String(mock.port)}/`,
    })
    await forwarder.connect()

    await forwarder.forward({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      headers: { 'Content-Type': 'text/evil' },
    })

    expect(mock.receivedHeaders[0]?.['content-type']).toBe('application/json')
  })

  it('drops a caller-supplied content-length so the wire carries the computed truthful length', async () => {
    mock = createMockSseServer()
    // The 1500ms pin is load-bearing: pre-fix, undici honors the caller's
    // content-length promise and the POST never transmits, so the run must
    // die as this forwarder's own named timeout rejection — not Vitest's
    // generic 5s test timeout. Real time on purpose: AbortSignal.timeout
    // ignores fake timers.
    forwarder = new SseUpstreamForwarder({
      url: `http://127.0.0.1:${String(mock.port)}/`,
      requestTimeoutMs: 1500,
    })
    await forwarder.connect()

    await forwarder.forward({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      headers: { 'content-length': '5' },
    })

    // The stub keeps parsed JSON only; stringify of the parsed body is
    // byte-identical to the wire body for this envelope, so the truthful
    // computed length is recoverable from it.
    expect(mock.receivedHeaders[0]?.['content-length']).toBe(
      String(Buffer.byteLength(JSON.stringify(mock.receivedBodies[0]))),
    )
  })

  it('passes legitimate caller and static headers through untouched', async () => {
    mock = createMockSseServer()
    forwarder = new SseUpstreamForwarder({
      url: `http://127.0.0.1:${String(mock.port)}/`,
      headers: { 'x-static': 'from-config' },
    })
    await forwarder.connect()

    await forwarder.forward({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      headers: { authorization: 'Bearer tok', 'x-trace': 'abc' },
    })

    expect(mock.receivedHeaders[0]?.['authorization']).toBe('Bearer tok')
    expect(mock.receivedHeaders[0]?.['x-trace']).toBe('abc')
    expect(mock.receivedHeaders[0]?.['x-static']).toBe('from-config')
    expect(mock.receivedHeaders[0]?.['content-type']).toBe('application/json')
  })

  it('passes a caller-supplied mcp-protocol-version through', async () => {
    mock = createMockSseServer()
    forwarder = new SseUpstreamForwarder({
      url: `http://127.0.0.1:${String(mock.port)}/`,
    })
    await forwarder.connect()

    // Pins that the strip covers only mcp-method/mcp-name/mcp-session-id
    // (content-type is a re-stamp and content-length a drop, not strips):
    // mcp-protocol-version is a passthrough of a caller value, NOT Helio
    // stamping — stripping it here would make this deprecated leg stricter
    // than the streamable legacy leg, which documentedly preserves a
    // caller-preset value. Any surviving value pins the behavior; the
    // specific string is incidental.
    await forwarder.forward({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      headers: { 'mcp-protocol-version': '2026-07-28' },
    })

    expect(mock.receivedHeaders[0]?.['mcp-protocol-version']).toBe('2026-07-28')
  })

  it('rejects forward when not connected', async () => {
    forwarder = new SseUpstreamForwarder({ url: 'http://127.0.0.1:1/' })

    await expect(forwarder.forward(makeRequest(1, 'ping'))).rejects.toThrow('not connected')
  })

  it('close can be called cleanly after connect', async () => {
    mock = createMockSseServer()
    forwarder = new SseUpstreamForwarder({
      url: `http://127.0.0.1:${String(mock.port)}/`,
    })
    await forwarder.connect()
    await forwarder.close()
    forwarder = null

    // After close, forward should reject
    const closed = new SseUpstreamForwarder({ url: 'http://127.0.0.1:1/' })
    await expect(closed.forward(makeRequest(1, 'ping'))).rejects.toThrow('not connected')
  })

  it('handles relative endpoint URLs', async () => {
    mock = createMockSseServer()
    // The mock server sends `data: /messages` (relative URL)
    forwarder = new SseUpstreamForwarder({
      url: `http://127.0.0.1:${String(mock.port)}/`,
    })
    await forwarder.connect()

    // If we can forward, the relative URL was resolved correctly
    const result = await forwarder.forward(makeRequest(1, 'ping'))
    expect(result.response.status).toBe(200)
  })

  it('handles concurrent requests', async () => {
    mock = createMockSseServer()
    forwarder = new SseUpstreamForwarder({
      url: `http://127.0.0.1:${String(mock.port)}/`,
    })
    await forwarder.connect()

    const results = await Promise.all([
      forwarder.forward(makeRequest(1, 'tools/list')),
      forwarder.forward(makeRequest(2, 'tools/call')),
      forwarder.forward(makeRequest(3, 'initialize')),
    ])

    expect(results).toHaveLength(3)
    for (const [i, result] of results.entries()) {
      expect(result.response.body).toHaveProperty('id', i + 1)
    }
  })

  it('treats id: null as a request id (not a notification)', async () => {
    mock = createMockSseServer()
    forwarder = new SseUpstreamForwarder({
      url: `http://127.0.0.1:${String(mock.port)}/`,
    })
    await forwarder.connect()

    const request: McpRequest = { jsonrpc: '2.0', id: null, method: 'tools/list' }
    const result = await forwarder.forward(request)

    expect(result.response.body).toEqual({
      jsonrpc: '2.0',
      id: null,
      result: { method: 'tools/list' },
    })
    expect(mock.receivedBodies).toHaveLength(1)
    expect(mock.receivedBodies[0]).toMatchObject({ id: null, method: 'tools/list' })
  })

  it('rejects a request when upstream POST fails and cleans pending state', async () => {
    mock = createMockSseServer(500)
    forwarder = new SseUpstreamForwarder({
      url: `http://127.0.0.1:${String(mock.port)}/`,
    })
    await forwarder.connect()

    await expect(forwarder.forward(makeRequest(1, 'tools/list'))).rejects.toThrow(
      'upstream request POST failed: HTTP 500',
    )
  })

  it('translates request POST fetch failures into actionable unreachable guidance', async () => {
    mock = createMockSseServer()
    forwarder = new SseUpstreamForwarder({
      url: `http://127.0.0.1:${String(mock.port)}/`,
    })
    await forwarder.connect()

    const originalFetch = globalThis.fetch
    globalThis.fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const method = (
        init?.method ?? (input instanceof Request ? input.method : 'GET')
      ).toUpperCase()
      if (method === 'POST') {
        return Promise.reject(fetchFailed('ECONNREFUSED'))
      }
      return originalFetch(input, init)
    }

    try {
      await expect(forwarder.forward(makeRequest(1, 'tools/list'))).rejects.toThrow(
        /is unreachable \(ECONNREFUSED\) — is it running\?/,
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('translates notification POST fetch failures into actionable unreachable guidance', async () => {
    mock = createMockSseServer()
    forwarder = new SseUpstreamForwarder({
      url: `http://127.0.0.1:${String(mock.port)}/`,
    })
    await forwarder.connect()

    const originalFetch = globalThis.fetch
    globalThis.fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const method = (
        init?.method ?? (input instanceof Request ? input.method : 'GET')
      ).toUpperCase()
      if (method === 'POST') {
        return Promise.reject(fetchFailed('ECONNREFUSED'))
      }
      return originalFetch(input, init)
    }

    try {
      const notification: McpRequest = { jsonrpc: '2.0', method: 'notifications/ping' }
      await expect(forwarder.forward(notification)).rejects.toThrow(
        /is unreachable \(ECONNREFUSED\) — is it running\?/,
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('rejects immediately when downstream signal is already aborted', async () => {
    mock = createMockSseServer()
    forwarder = new SseUpstreamForwarder({
      url: `http://127.0.0.1:${String(mock.port)}/`,
    })
    await forwarder.connect()

    const controller = new AbortController()
    controller.abort()
    const request: McpRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      signal: controller.signal,
    }

    await expect(forwarder.forward(request)).rejects.toThrow('request aborted by downstream client')
  })

  it('surfaces connect timeout with explicit message', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = () => {
      const timeoutError = new Error('connect timeout')
      timeoutError.name = 'TimeoutError'
      return Promise.reject(timeoutError)
    }

    try {
      forwarder = new SseUpstreamForwarder({
        url: 'http://127.0.0.1:65535/',
        connectTimeoutMs: 1234,
      })
      await expect(forwarder.connect()).rejects.toThrow('timed out after 1234ms')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
