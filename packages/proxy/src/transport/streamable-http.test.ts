import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import { createStreamableHttpRoute } from './streamable-http.js'
import { compileSessionIdentity } from '../mcp/session-resolver.js'
import type { McpForwarder, McpRequest, McpResponse, JsonRpcResponse } from '../mcp/types.js'
import type { StreamableHttpRouteOptions } from './streamable-http.js'

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

function mountRoute(forwarder: McpForwarder, options: StreamableHttpRouteOptions = {}): Hono {
  const app = new Hono()
  app.route('/mcp', createStreamableHttpRoute(forwarder, options))
  return app
}

function postMcp(app: Hono, body: unknown, headers: Record<string, string> = {}) {
  return app.request('/mcp', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('streamable-http transport', () => {
  const okResponse: McpResponse = {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: { jsonrpc: '2.0', id: 1, result: { tools: [] } },
  }

  it('forwards a valid JSON-RPC request and returns the response', async () => {
    const forwarder = createMockForwarder(okResponse)
    const app = mountRoute(forwarder)

    const res = await postMcp(app, { jsonrpc: '2.0', id: 1, method: 'tools/list' })

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual({ jsonrpc: '2.0', id: 1, result: { tools: [] } })
    expect(forwarder.calls).toHaveLength(1)
    expect(forwarder.calls[0]?.method).toBe('tools/list')
  })

  it('passes params to the forwarder', async () => {
    const forwarder = createMockForwarder(okResponse)
    const app = mountRoute(forwarder)

    await postMcp(app, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'get_weather', arguments: { city: 'London' } },
    })

    expect(forwarder.calls[0]?.params).toEqual({
      name: 'get_weather',
      arguments: { city: 'London' },
    })
  })

  it('returns 202 with empty body for notifications and forwards fire-and-forget', async () => {
    const forwarder = createMockForwarder(okResponse)
    const app = mountRoute(forwarder)

    const res = await postMcp(app, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    })

    expect(res.status).toBe(202)
    expect(await res.text()).toBe('')
    expect(forwarder.calls).toHaveLength(1)
    expect(forwarder.calls[0]?.method).toBe('notifications/initialized')
    expect(forwarder.calls[0]?.id).toBeUndefined()
    expect(forwarder.calls[0]?.signal).toBeUndefined()
  })

  it('returns 202 with empty body for notifications with params', async () => {
    const forwarder = createMockForwarder(okResponse)
    const app = mountRoute(forwarder)

    const res = await postMcp(app, {
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 'req-1', reason: 'client_abort' },
    })

    expect(res.status).toBe(202)
    expect(await res.text()).toBe('')
    expect(forwarder.calls).toHaveLength(1)
    expect(forwarder.calls[0]?.method).toBe('notifications/cancelled')
    expect(forwarder.calls[0]?.params).toEqual({ requestId: 'req-1', reason: 'client_abort' })
    expect(forwarder.calls[0]?.id).toBeUndefined()
    expect(forwarder.calls[0]?.signal).toBeUndefined()
  })

  it('returns 202 for notifications even when upstream forwarding fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const forwarder = createThrowingForwarder()
    const app = mountRoute(forwarder)

    const res = await postMcp(app, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    })

    expect(res.status).toBe(202)
    expect(await res.text()).toBe('')

    // Allow the fire-and-forget rejection handler to run.
    await Promise.resolve()
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[helio] Upstream notification forward failed'),
    )
    errorSpy.mockRestore()
  })

  it('resolves x-helio-session-id as the governance session (source: header)', async () => {
    const forwarder = createMockForwarder(okResponse)
    const app = mountRoute(forwarder)

    await postMcp(
      app,
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { 'x-helio-session-id': 'run-a' },
    )

    expect(forwarder.calls[0]?.session).toEqual({ id: 'run-a', source: 'header' })
    expect(forwarder.calls[0]?.transportSessionId).toBeUndefined()
  })

  it('resolves a lone Mcp-Session-Id via legacy_header and keeps it as transportSessionId', async () => {
    const forwarder = createMockForwarder(okResponse)
    const app = mountRoute(forwarder)

    await postMcp(
      app,
      { jsonrpc: '2.0', id: 1, method: 'initialize' },
      {
        'Mcp-Session-Id': 'session-abc-123',
      },
    )

    expect(forwarder.calls[0]?.session).toEqual({
      id: 'session-abc-123',
      source: 'legacy_header',
    })
    expect(forwarder.calls[0]?.transportSessionId).toBe('session-abc-123')
  })

  it('prefers the identity header over the legacy transport id', async () => {
    const forwarder = createMockForwarder(okResponse)
    const app = mountRoute(forwarder)

    await postMcp(
      app,
      { jsonrpc: '2.0', id: 1, method: 'tools/call' },
      { 'x-helio-session-id': 'run-a', 'Mcp-Session-Id': 'legacy-9' },
    )

    expect(forwarder.calls[0]?.session).toEqual({ id: 'run-a', source: 'header' })
    expect(forwarder.calls[0]?.transportSessionId).toBe('legacy-9')
  })

  it('respects a custom compiled identity chain passed via options', async () => {
    const forwarder = createMockForwarder(okResponse)
    const app = mountRoute(forwarder, {
      session: compileSessionIdentity({
        identity: [{ source: 'header', name: 'x-team-session' }],
        on_unresolved: 'deny',
      }),
    })

    await postMcp(
      app,
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { 'x-team-session': 'team-1', 'Mcp-Session-Id': 'ignored-legacy' },
    )

    expect(forwarder.calls[0]?.session).toEqual({ id: 'team-1', source: 'header' })
    expect(forwarder.calls[0]?.transportSessionId).toBe('ignored-legacy')
  })

  it('leaves session and transportSessionId undefined when no session headers are present', async () => {
    const forwarder = createMockForwarder(okResponse)
    const app = mountRoute(forwarder)

    await postMcp(app, { jsonrpc: '2.0', id: 1, method: 'tools/list' })

    expect(forwarder.calls[0]?.session).toBeUndefined()
    expect(forwarder.calls[0]?.transportSessionId).toBeUndefined()
  })

  it('passes downstream request abort signal to forwarder', async () => {
    const forwarder = createMockForwarder(okResponse)
    const app = mountRoute(forwarder)

    await postMcp(app, { jsonrpc: '2.0', id: 1, method: 'tools/list' })

    expect(forwarder.calls[0]?.signal).toBeDefined()
    expect(forwarder.calls[0]?.signal).toBeInstanceOf(AbortSignal)
  })

  it('copies allowed response headers from forwarder to HTTP response', async () => {
    const forwarder = createMockForwarder({
      status: 200,
      headers: {
        'content-type': 'application/json',
        'mcp-session-id': 'new-session-456',
      },
      body: { jsonrpc: '2.0', id: 1, result: {} },
    })
    const app = mountRoute(forwarder)

    const res = await postMcp(app, { jsonrpc: '2.0', id: 1, method: 'initialize' })

    expect(res.headers.get('mcp-session-id')).toBe('new-session-456')
  })

  it('filters out non-allowlisted upstream response headers', async () => {
    const forwarder = createMockForwarder({
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-internal-trace': 'secret-123',
        'x-upstream-version': '1.0',
      },
      body: { jsonrpc: '2.0', id: 1, result: {} },
    })
    const app = mountRoute(forwarder)

    const res = await postMcp(app, { jsonrpc: '2.0', id: 1, method: 'tools/list' })

    expect(res.headers.get('x-internal-trace')).toBeNull()
    expect(res.headers.get('x-upstream-version')).toBeNull()
  })

  it('returns 415 when Content-Type is not application/json', async () => {
    const forwarder = createMockForwarder(okResponse)
    const app = mountRoute(forwarder)

    const res = await app.request('/mcp', {
      method: 'POST',
      body: 'not json',
      headers: { 'Content-Type': 'text/plain' },
    })

    expect(res.status).toBe(415)
    const json = (await res.json()) as JsonRpcResponse
    expect(json.error?.code).toBe(-32600)
    expect(forwarder.calls).toHaveLength(0)
  })

  // A CORS-safelisted Content-Type needs no preflight, so a browser can send
  // one cross-site without the target's cooperation. Matching the header as a
  // substring let such a request satisfy the JSON requirement by smuggling the
  // token into a parameter, putting the MCP endpoint within reach of any web
  // page. The essence (the part before ';') is what must be compared.
  it.each([
    'text/plain;x=application/json',
    'text/plain; charset=application/json',
    'multipart/form-data; boundary=application/json',
    'application/x-www-form-urlencoded;v=application/json',
    // The ordinary form of a safelisted type, which carries no smuggled token.
    // Guards against a future rewrite that admits the essence itself.
    'text/plain;charset=utf-8',
  ])('returns 415 for CORS-safelisted Content-Type %s', async (contentType) => {
    const forwarder = createMockForwarder(okResponse)
    const app = mountRoute(forwarder)

    const res = await app.request('/mcp', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      headers: { 'Content-Type': contentType },
    })

    expect(res.status).toBe(415)
    expect(forwarder.calls).toHaveLength(0)
  })

  it.each([
    'application/json',
    'application/json; charset=utf-8',
    'APPLICATION/JSON',
    '  application/json  ',
  ])('accepts Content-Type %s', async (contentType) => {
    const forwarder = createMockForwarder(okResponse)
    const app = mountRoute(forwarder)

    const res = await app.request('/mcp', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      headers: { 'Content-Type': contentType },
    })

    expect(res.status).toBe(200)
    expect(forwarder.calls).toHaveLength(1)
  })

  it('returns 415 when Content-Type is absent', async () => {
    const forwarder = createMockForwarder(okResponse)
    const app = mountRoute(forwarder)

    const res = await app.request('/mcp', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })

    expect(res.status).toBe(415)
    expect(forwarder.calls).toHaveLength(0)
  })

  it('returns -32700 parse error for malformed JSON', async () => {
    const forwarder = createMockForwarder(okResponse)
    const app = mountRoute(forwarder)

    const res = await app.request('/mcp', {
      method: 'POST',
      body: '{bad json!!!',
      headers: { 'Content-Type': 'application/json' },
    })

    expect(res.status).toBe(400)
    const json = (await res.json()) as JsonRpcResponse
    expect(json.error?.code).toBe(-32700)
    expect(forwarder.calls).toHaveLength(0)
  })

  it('returns -32600 for missing jsonrpc field', async () => {
    const forwarder = createMockForwarder(okResponse)
    const app = mountRoute(forwarder)

    const res = await postMcp(app, { method: 'tools/list' })

    expect(res.status).toBe(400)
    const json = (await res.json()) as JsonRpcResponse
    expect(json.error?.code).toBe(-32600)
    expect(json.error?.message).toContain('jsonrpc')
  })

  it('returns -32600 for missing method field', async () => {
    const forwarder = createMockForwarder(okResponse)
    const app = mountRoute(forwarder)

    const res = await postMcp(app, { jsonrpc: '2.0', id: 1 })

    expect(res.status).toBe(400)
    const json = (await res.json()) as JsonRpcResponse
    expect(json.error?.code).toBe(-32600)
    expect(json.error?.message).toContain('method')
  })

  it('returns -32600 for batch requests (arrays)', async () => {
    const forwarder = createMockForwarder(okResponse)
    const app = mountRoute(forwarder)

    const res = await postMcp(app, [
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { jsonrpc: '2.0', id: 2, method: 'ping' },
    ])

    expect(res.status).toBe(400)
    const json = (await res.json()) as JsonRpcResponse
    expect(json.error?.code).toBe(-32600)
    expect(json.error?.message).toContain('batch')
  })

  it('returns -32603 when forwarder throws', async () => {
    const forwarder = createThrowingForwarder()
    const app = mountRoute(forwarder)

    const res = await postMcp(app, { jsonrpc: '2.0', id: 1, method: 'tools/list' })

    expect(res.status).toBe(200)
    const json = (await res.json()) as JsonRpcResponse
    expect(json.error?.code).toBe(-32603)
    expect(json.error?.message).toContain('upstream')
    const data = json.error?.data as Record<string, unknown>
    expect(data['failure_class']).toBe('upstream_forward_error')
  })

  it('wraps upstream text/plain failures into JSON-RPC internal error', async () => {
    const forwarder = createMockForwarder({
      status: 500,
      headers: {
        'content-type': 'text/plain',
      },
      body: 'upstream failed',
    })
    const app = mountRoute(forwarder)

    const res = await postMcp(app, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect(res.status).toBe(200)

    const json = (await res.json()) as JsonRpcResponse
    expect(json.error?.code).toBe(-32603)
    const data = json.error?.data as Record<string, unknown>
    expect(data['failure_class']).toBe('upstream_invalid_jsonrpc')
    expect(data['upstream_http_status']).toBe(500)
    expect(data['upstream_content_type']).toBe('text/plain')
    expect(data['upstream_body_excerpt']).toBeUndefined()
  })

  it('passes through valid upstream JSON-RPC errors', async () => {
    const forwarder = createMockForwarder({
      status: 500,
      headers: {
        'content-type': 'application/json',
      },
      body: {
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32042, message: 'upstream denied' },
      },
    })
    const app = mountRoute(forwarder)

    const res = await postMcp(app, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect(res.status).toBe(200)

    const json = (await res.json()) as JsonRpcResponse
    expect(json).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32042, message: 'upstream denied' },
    })
  })

  it('wraps mismatched upstream JSON-RPC response ids', async () => {
    const forwarder = createMockForwarder({
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
      body: {
        jsonrpc: '2.0',
        id: 2,
        result: { tools: [] },
      },
    })
    const app = mountRoute(forwarder)

    const res = await postMcp(app, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect(res.status).toBe(200)

    const json = (await res.json()) as JsonRpcResponse
    expect(json.error?.code).toBe(-32603)
    const data = json.error?.data as Record<string, unknown>
    expect(data['failure_class']).toBe('upstream_id_mismatch')
    expect(data['expected_request_id']).toBe(1)
    expect(data['upstream_response_id']).toBe(2)
  })

  it('forwards Authorization header in McpRequest.headers', async () => {
    const forwarder = createMockForwarder(okResponse)
    const app = mountRoute(forwarder)

    await postMcp(
      app,
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      {
        Authorization: 'Bearer my-token',
      },
    )

    expect(forwarder.calls[0]?.headers?.['authorization']).toBe('Bearer my-token')
  })

  it('does not forward X-* custom headers unless explicitly allowlisted', async () => {
    const forwarder = createMockForwarder(okResponse)
    const app = mountRoute(forwarder)

    await postMcp(
      app,
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      {
        'X-Request-Id': 'req-123',
        'X-Trace-Id': 'trace-456',
      },
    )

    expect(forwarder.calls[0]?.headers?.['x-request-id']).toBeUndefined()
    expect(forwarder.calls[0]?.headers?.['x-trace-id']).toBeUndefined()
  })

  it('forwards allowlisted X-* custom headers in McpRequest.headers', async () => {
    const forwarder = createMockForwarder(okResponse)
    const app = mountRoute(forwarder, {
      forwardHeadersAllowlist: ['x-request-id'],
    })

    await postMcp(
      app,
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      {
        'X-Request-Id': 'req-123',
        'X-Trace-Id': 'trace-456',
      },
    )

    expect(forwarder.calls[0]?.headers?.['x-request-id']).toBe('req-123')
    expect(forwarder.calls[0]?.headers?.['x-trace-id']).toBeUndefined()
  })

  it('does not set headers field when no forwarding headers are present', async () => {
    const forwarder = createMockForwarder(okResponse)
    const app = mountRoute(forwarder)

    await postMcp(app, { jsonrpc: '2.0', id: 1, method: 'tools/list' })

    expect(forwarder.calls[0]?.headers).toBeUndefined()
  })

  describe('origin validation (issue #213)', () => {
    it('rejects a hostile Origin with 403 and never calls the forwarder', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const forwarder = createMockForwarder(okResponse)
      const app = mountRoute(forwarder)

      const res = await postMcp(
        app,
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        { origin: 'https://evil.example' },
      )

      expect(res.status).toBe(403)
      expect(forwarder.calls).toHaveLength(0)
      errorSpy.mockRestore()
    })

    it('rejects OPTIONS /mcp with a hostile Origin', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const forwarder = createMockForwarder(okResponse)
      const app = mountRoute(forwarder)

      const res = await app.request('/mcp', {
        method: 'OPTIONS',
        headers: { origin: 'https://evil.example' },
      })

      expect(res.status).toBe(403)
      expect(forwarder.calls).toHaveLength(0)
      errorSpy.mockRestore()
    })

    it('forwards a request whose Origin is allowlisted', async () => {
      const forwarder = createMockForwarder(okResponse)
      const app = mountRoute(forwarder, { allowedOrigins: ['http://localhost:5173'] })

      const res = await postMcp(
        app,
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        { origin: 'http://localhost:5173' },
      )

      expect(res.status).toBe(200)
      expect(forwarder.calls).toHaveLength(1)
    })

    it('emits no Access-Control-Allow-Origin even for an allowlisted Origin', async () => {
      // Pins that allowed_origins is not CORS support: the request passes,
      // but a browser still cannot read the response.
      const forwarder = createMockForwarder(okResponse)
      const app = mountRoute(forwarder, { allowedOrigins: ['http://localhost:5173'] })

      const res = await postMcp(
        app,
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        { origin: 'http://localhost:5173' },
      )

      expect(res.headers.get('access-control-allow-origin')).toBeNull()
    })

    it('still forwards requests without an Origin header', async () => {
      const forwarder = createMockForwarder(okResponse)
      const app = mountRoute(forwarder, { allowedOrigins: [] })

      const res = await postMcp(app, { jsonrpc: '2.0', id: 1, method: 'tools/list' })

      expect(res.status).toBe(200)
      expect(forwarder.calls).toHaveLength(1)
    })
  })
})
