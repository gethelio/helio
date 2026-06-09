import { describe, it, expect, afterEach } from 'vitest'
import { StreamableHttpForwarder } from './streamable-http-forwarder.js'
import type { McpRequest } from '../mcp/types.js'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

function req(overrides: Partial<McpRequest> = {}): McpRequest {
  return { jsonrpc: '2.0', id: 1, method: 'tools/list', ...overrides }
}

// ---------------------------------------------------------------------------
// Base tests (from spec)
// ---------------------------------------------------------------------------

describe('StreamableHttpForwarder', () => {
  it('parses an application/json POST response', async () => {
    globalThis.fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [] } }), {
          headers: { 'content-type': 'application/json' },
        }),
      )
    const fwd = new StreamableHttpForwarder({ url: 'http://up/mcp' })
    const { response } = await fwd.forward(req({ sessionId: 'S1' }))
    expect((response.body as { result: unknown }).result).toEqual({ tools: [] })
  })

  it('parses a text/event-stream POST response', async () => {
    globalThis.fetch = () =>
      Promise.resolve(
        new Response('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        }),
      )
    const fwd = new StreamableHttpForwarder({ url: 'http://up/mcp' })
    const { response } = await fwd.forward(req({ sessionId: 'S1' }))
    expect((response.body as { result: unknown }).result).toEqual({ tools: [] })
  })

  it('sends MCP-Protocol-Version on forwarded requests', async () => {
    let seen: Record<string, string> = {}
    globalThis.fetch = (_u, init) => {
      seen = (init?.headers as Record<string, string> | undefined) ?? {}
      return Promise.resolve(
        new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), {
          headers: { 'content-type': 'application/json' },
        }),
      )
    }
    const fwd = new StreamableHttpForwarder({ url: 'http://up/mcp' })
    await fwd.forward(req({ sessionId: 'S1' }))
    expect(seen['mcp-protocol-version']).toBeDefined()
    expect(seen['mcp-session-id']).toBe('S1')
  })

  it('relays the upstream Mcp-Session-Id response header', async () => {
    globalThis.fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), {
          headers: { 'content-type': 'application/json', 'mcp-session-id': 'U-new' },
        }),
      )
    const fwd = new StreamableHttpForwarder({ url: 'http://up/mcp' })
    const { response } = await fwd.forward(req({ method: 'initialize', sessionId: undefined }))
    expect(response.headers['mcp-session-id']).toBe('U-new')
  })

  // -------------------------------------------------------------------------
  // Regression 1: initialize forwarded without protocol header or injected session
  // -------------------------------------------------------------------------

  it('forwards initialize without mcp-protocol-version and without mcp-session-id', async () => {
    let seen: Record<string, string> = {}
    globalThis.fetch = (_u, init) => {
      seen = (init?.headers as Record<string, string> | undefined) ?? {}
      return Promise.resolve(
        new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), {
          headers: { 'content-type': 'application/json' },
        }),
      )
    }
    const fwd = new StreamableHttpForwarder({ url: 'http://up/mcp' })
    await fwd.forward(req({ method: 'initialize', sessionId: undefined }))
    expect(seen['mcp-protocol-version']).toBeUndefined()
    expect(seen['mcp-session-id']).toBeUndefined()
  })

  // -------------------------------------------------------------------------
  // Regression 2: passthrough 404 surfaces as raw response (no throw)
  // -------------------------------------------------------------------------

  it('surfaces a passthrough 404 as a raw response without throwing', async () => {
    globalThis.fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            error: { code: -32001, message: 'session not found' },
          }),
          { status: 404, headers: { 'content-type': 'application/json' } },
        ),
      )
    const fwd = new StreamableHttpForwarder({ url: 'http://up/mcp' })
    const { response } = await fwd.forward(req({ sessionId: 'S1' }))
    expect(response.status).toBe(404)
  })

  // -------------------------------------------------------------------------
  // Regression 3: internal 404 triggers exactly one re-init retry
  // -------------------------------------------------------------------------

  it('retries exactly once on a managed-session 404, carrying the new session id', async () => {
    // Tracks per-method call counts
    let initCount = 0
    const toolsListSessions: string[] = []

    globalThis.fetch = (_u: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const raw = typeof init?.body === 'string' ? init.body : '{}'
      const body = JSON.parse(raw) as { method: string }
      const hdrs = (init?.headers ?? {}) as Record<string, string>

      if (body.method === 'initialize') {
        initCount += 1
        const sessionId = initCount === 1 ? 'U-1' : 'U-2'
        return Promise.resolve(
          new Response(
            JSON.stringify({ jsonrpc: '2.0', id: 0, result: { protocolVersion: '2025-06-18' } }),
            {
              status: 200,
              headers: { 'content-type': 'application/json', 'mcp-session-id': sessionId },
            },
          ),
        )
      }

      if (body.method === 'notifications/initialized') {
        return Promise.resolve(new Response(null, { status: 202 }))
      }

      // tools/list: first call → 404; subsequent → 200
      toolsListSessions.push(hdrs['mcp-session-id'] ?? '')
      if (toolsListSessions.length === 1) {
        return Promise.resolve(new Response(null, { status: 404 }))
      }
      return Promise.resolve(
        new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
    }

    const fwd = new StreamableHttpForwarder({ url: 'http://up/mcp' })
    const result = await fwd.forwardInternal(req())

    expect((result.response.body as { result: unknown }).result).toEqual({ tools: [] })
    expect(initCount).toBe(2)
    // The retried call must carry the freshly minted session U-2
    expect(toolsListSessions[1]).toBe('U-2')
  })

  // -------------------------------------------------------------------------
  // Regression 4: internal double-404 propagates (no infinite loop)
  // -------------------------------------------------------------------------

  it('propagates error on double-404 with exactly 2 initialize calls', async () => {
    let initCount = 0

    globalThis.fetch = (_u: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const raw = typeof init?.body === 'string' ? init.body : '{}'
      const body = JSON.parse(raw) as { method: string }

      if (body.method === 'initialize') {
        initCount += 1
        const sessionId = `U-${String(initCount)}`
        return Promise.resolve(
          new Response(
            JSON.stringify({ jsonrpc: '2.0', id: 0, result: { protocolVersion: '2025-06-18' } }),
            {
              status: 200,
              headers: { 'content-type': 'application/json', 'mcp-session-id': sessionId },
            },
          ),
        )
      }

      if (body.method === 'notifications/initialized') {
        return Promise.resolve(new Response(null, { status: 202 }))
      }

      // All tools/list → 404
      return Promise.resolve(new Response(null, { status: 404 }))
    }

    const fwd = new StreamableHttpForwarder({ url: 'http://up/mcp' })
    await expect(fwd.forwardInternal(req())).rejects.toThrow(/session/)
    expect(initCount).toBe(2)
  })

  // -------------------------------------------------------------------------
  // Regression 5: SSE notification response (no id) does not wait on matching id
  // -------------------------------------------------------------------------

  it('resolves SSE notification response without waiting for a matching id', async () => {
    globalThis.fetch = () =>
      Promise.resolve(
        new Response(
          'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      )
    const fwd = new StreamableHttpForwarder({ url: 'http://up/mcp' })
    const { response } = await fwd.forward(
      req({ id: undefined, method: 'notifications/progress', sessionId: 'S1' }),
    )
    expect(response.body).toEqual({ jsonrpc: '2.0' })
  })

  // -------------------------------------------------------------------------
  // Regression 6: static headers win; caller headers pass through for non-overlapping keys
  // -------------------------------------------------------------------------

  it('static headers win over caller headers; non-overlapping caller headers pass through', async () => {
    let seen: Record<string, string> = {}
    globalThis.fetch = (_u, init) => {
      seen = (init?.headers as Record<string, string> | undefined) ?? {}
      return Promise.resolve(
        new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), {
          headers: { 'content-type': 'application/json' },
        }),
      )
    }
    const fwd = new StreamableHttpForwarder({
      url: 'http://up/mcp',
      headers: { authorization: 'Bearer cfg' },
    })
    await fwd.forward(
      req({ sessionId: 'S1', headers: { Authorization: 'Bearer caller', 'x-trace': 't1' } }),
    )
    // Static config wins — caller cannot override Authorization
    expect(seen['authorization']).toBe('Bearer cfg')
    // Non-overlapping caller header passes through
    expect(seen['x-trace']).toBe('t1')
  })
})
