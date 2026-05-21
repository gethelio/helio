import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import { createStreamableHttpRoute } from './streamable-http.js'
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

  it('extracts Mcp-Session-Id header and passes to forwarder', async () => {
    const forwarder = createMockForwarder(okResponse)
    const app = mountRoute(forwarder)

    await postMcp(
      app,
      { jsonrpc: '2.0', id: 1, method: 'initialize' },
      {
        'Mcp-Session-Id': 'session-abc-123',
      },
    )

    expect(forwarder.calls[0]?.sessionId).toBe('session-abc-123')
  })

  it('passes undefined sessionId when header is absent', async () => {
    const forwarder = createMockForwarder(okResponse)
    const app = mountRoute(forwarder)

    await postMcp(app, { jsonrpc: '2.0', id: 1, method: 'tools/list' })

    expect(forwarder.calls[0]?.sessionId).toBeUndefined()
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
})
