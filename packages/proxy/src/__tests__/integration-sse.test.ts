import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import type { AddressInfo } from 'node:net'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import type { ServerType } from '@hono/node-server'
import { createApp } from '../server.js'
import { SseUpstreamForwarder } from '../upstream/sse-forwarder.js'
import { startOnDynamicPort, makeConfig, closeServer } from './helpers/test-utils.js'
import type { ManagedServer } from './helpers/test-utils.js'

// ---------------------------------------------------------------------------
// Mock SSE upstream — speaks the SSE wire protocol with real MCP responses
// ---------------------------------------------------------------------------

interface MockSseUpstream {
  server: ServerType
  port: number
}

/**
 * Create a mock MCP server that speaks SSE transport.
 * Returns actual MCP-style responses for tools/list, tools/call, etc.
 */
function createMockSseUpstream(): MockSseUpstream {
  const app = new Hono()
  const writers: WritableStreamDefaultWriter<Uint8Array>[] = []
  const encoder = new TextEncoder()

  // Tool definitions matching the real MCP test server
  const tools = [
    { name: 'get_weather', description: 'Get the current weather for a city' },
    { name: 'send_email', description: 'Send an email to a recipient' },
    { name: 'create_payment', description: 'Create a payment' },
    { name: 'delete_record', description: 'Delete a record by ID' },
  ]

  app.get('/', () => {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
    const writer = writable.getWriter()
    writers.push(writer)

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
    const body: { id?: string | number; method?: string; params?: Record<string, unknown> } =
      await c.req.json()

    if (body.id !== undefined) {
      let result: unknown

      switch (body.method) {
        case 'tools/list':
          result = { tools }
          break
        case 'tools/call': {
          const name = body.params?.['name'] as string | undefined
          const args = body.params?.['arguments'] as Record<string, unknown> | undefined
          if (name === 'get_weather') {
            result = {
              content: [{ type: 'text', text: `Sunny, 22°C in ${String(args?.['city'])}` }],
            }
          } else {
            result = { content: [{ type: 'text', text: `Called ${String(name)}` }] }
          }
          break
        }
        default:
          result = {}
      }

      const response = JSON.stringify({ jsonrpc: '2.0', id: body.id, result })
      const messageEvent = `event: message\ndata: ${response}\n\n`
      for (const writer of writers) {
        void writer.write(encoder.encode(messageEvent)).catch(() => {})
      }
    }

    return c.body(null, 202)
  })

  const server = serve({ fetch: app.fetch, port: 0 })
  const port = (server.address() as AddressInfo).port

  return { server, port }
}

// ---------------------------------------------------------------------------
// SSE client helpers
// ---------------------------------------------------------------------------

interface SseClientSession {
  sessionId: string
  postUrl: string
  reader: ReadableStreamDefaultReader<Uint8Array>
  abort: () => void
}

/**
 * Establish an SSE session with the proxy:
 * 1. GET /sse to get the event stream
 * 2. Parse the endpoint event to extract sessionId
 */
async function establishSseSession(
  proxyPort: number,
  controller?: AbortController,
): Promise<SseClientSession> {
  const ac = controller ?? new AbortController()
  const response = await fetch(`http://127.0.0.1:${String(proxyPort)}/sse`, {
    signal: ac.signal,
  })
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe('text/event-stream')

  if (!response.body) throw new Error('SSE response has no body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()

  // Read until we get the endpoint event
  let buffer = ''
  let sessionId = ''

  while (!sessionId) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- ReadableStreamDefaultReader.read() types
    const { done, value } = await reader.read()
    if (done) throw new Error('SSE stream ended before endpoint event')
    buffer += decoder.decode(value as Uint8Array, { stream: true })

    const parts = buffer.split('\n\n')
    buffer = parts.pop() ?? ''

    for (const part of parts) {
      if (part.includes('event: endpoint')) {
        const dataMatch = part.match(/data: \?sessionId=([a-f0-9-]+)/)
        if (dataMatch?.[1]) {
          sessionId = dataMatch[1]
        }
      }
    }
  }

  const postUrl = `http://127.0.0.1:${String(proxyPort)}/sse?sessionId=${sessionId}`
  return {
    sessionId,
    postUrl,
    reader,
    abort: () => {
      ac.abort()
    },
  }
}

/** Read the next SSE message event from a reader. */
async function readNextSseMessage(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<Record<string, unknown>> {
  const decoder = new TextDecoder()
  let buffer = ''

  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) throw new Error('SSE stream ended before message event')
    buffer += decoder.decode(chunk.value, { stream: true })

    const parts = buffer.split('\n\n')
    buffer = parts.pop() ?? ''

    for (const part of parts) {
      if (part.includes('event: message')) {
        const dataMatch = part.match(/data: (.+)/)
        if (dataMatch?.[1]) {
          return JSON.parse(dataMatch[1]) as Record<string, unknown>
        }
      }
    }
  }
}

/** POST a JSON-RPC request to the proxy's SSE endpoint. */
function postSseRequest(
  postUrl: string,
  method: string,
  params?: unknown,
  id: number | string = 1,
): Promise<Response> {
  const payload: Record<string, unknown> = { jsonrpc: '2.0', id, method }
  if (params !== undefined) payload['params'] = params

  return fetch(postUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SSE integration', () => {
  let mockUpstream: MockSseUpstream
  let forwarder: SseUpstreamForwarder
  let proxy: ManagedServer
  let proxyPort: number
  const activeSessions: SseClientSession[] = []

  beforeAll(async () => {
    mockUpstream = createMockSseUpstream()

    forwarder = new SseUpstreamForwarder({
      url: `http://127.0.0.1:${String(mockUpstream.port)}/`,
    })
    await forwarder.connect()

    const config = makeConfig({
      upstream: {
        url: `http://127.0.0.1:${String(mockUpstream.port)}/`,
        transport: 'sse',
      },
    })

    const app = createApp(config, forwarder)
    proxy = startOnDynamicPort(app)
    proxyPort = proxy.port
  })

  afterAll(async () => {
    // Abort all SSE connections so the proxy server can close cleanly
    for (const session of activeSessions) {
      session.abort()
    }
    await proxy.close()
    await forwarder.close()
    await closeServer(mockUpstream.server)
  })

  it('GET /sse returns SSE stream with endpoint event', async () => {
    const session = await establishSseSession(proxyPort)
    activeSessions.push(session)
    expect(session.sessionId).toMatch(/^[a-f0-9-]+$/)
  })

  it('tools/list via SSE returns tools', async () => {
    const session = await establishSseSession(proxyPort)
    activeSessions.push(session)

    const postRes = await postSseRequest(session.postUrl, 'tools/list')
    expect(postRes.status).toBe(202)

    const message = await readNextSseMessage(session.reader)
    const result = message['result'] as { tools: { name: string }[] }
    const names = result.tools.map((t) => t.name).sort()
    expect(names).toEqual(['create_payment', 'delete_record', 'get_weather', 'send_email'])
  })

  it('tools/call get_weather via SSE returns response', async () => {
    const session = await establishSseSession(proxyPort)
    activeSessions.push(session)

    await postSseRequest(session.postUrl, 'tools/call', {
      name: 'get_weather',
      arguments: { city: 'Berlin' },
    })

    const message = await readNextSseMessage(session.reader)
    const result = message['result'] as { content: { text: string }[] }
    expect(result.content[0]?.text).toBe('Sunny, 22°C in Berlin')
  })

  it('multiple sequential requests on same session', async () => {
    const session = await establishSseSession(proxyPort)
    activeSessions.push(session)

    // Send 3 sequential requests
    for (let i = 1; i <= 3; i++) {
      await postSseRequest(session.postUrl, 'tools/list', undefined, i)
      const message = await readNextSseMessage(session.reader)
      expect(message['id']).toBe(i)
      expect(message['result']).toBeDefined()
    }
  })

  it('unknown session returns 404', async () => {
    const res = await fetch(`http://127.0.0.1:${String(proxyPort)}/sse?sessionId=nonexistent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })

    expect(res.status).toBe(404)
  })
})
