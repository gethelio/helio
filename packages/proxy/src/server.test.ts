import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { createApp, startSidebandServer } from './server.js'
import type { HelioConfig } from './config/index.js'
import type { McpForwarder, McpRequest, McpResponse } from './mcp/types.js'

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

const minimalConfig = {
  version: '1',
  upstream: {
    url: 'http://localhost:8080',
    transport: 'streamable-http',
    connect_timeout: '10s',
    request_timeout: '30s',
    forward_headers: [],
    headers: {},
  },
  listen: { port: 3000, host: '127.0.0.1' },
  dashboard: {
    enabled: false,
    port: 3100,
    host: '127.0.0.1',
    allow_open_mode: false,
    sse_heartbeat_interval: '30s',
  },
  policies: { default: 'allow', dry_run: false, rules: [] },
  approval: { timeout: '300s', default_on_timeout: 'deny', channels: [] },
  audit: {
    storage: 'sqlite',
    path: './helio-audit.db',
    retention: '90d',
    include_responses: true,
  },
  sdk: { enabled: false, port: 3200, host: '127.0.0.1', evaluation_ttl: '10m' },
  budgets: [],
} as HelioConfig

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createApp', () => {
  it('responds to GET /healthz with 200', async () => {
    const forwarder = createMockForwarder({
      status: 200,
      headers: {},
      body: {},
    })
    const app = createApp(minimalConfig, forwarder)

    const res = await app.request('/healthz')

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual({ status: 'ok' })
  })

  it('routes POST /mcp to the forwarder', async () => {
    const forwarder = createMockForwarder({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: { jsonrpc: '2.0', id: 1, result: { tools: [] } },
    })
    const app = createApp(minimalConfig, forwarder)

    const res = await app.request('/mcp', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      headers: { 'Content-Type': 'application/json' },
    })

    expect(res.status).toBe(200)
    expect(forwarder.calls).toHaveLength(1)
    expect(forwarder.calls[0]?.method).toBe('tools/list')
  })

  it('routes GET /sse to the SSE transport', async () => {
    const forwarder = createMockForwarder({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: { jsonrpc: '2.0', id: 1, result: {} },
    })
    const app = createApp(minimalConfig, forwarder)

    const res = await app.request('/sse')

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream')
  })

  it('returns 404 for unknown routes', async () => {
    const forwarder = createMockForwarder({
      status: 200,
      headers: {},
      body: {},
    })
    const app = createApp(minimalConfig, forwarder)

    const res = await app.request('/unknown-path')

    expect(res.status).toBe(404)
  })

  // ---------------------------------------------------------------------------
  // Approval REST API is no longer mounted on the main MCP app.
  // ---------------------------------------------------------------------------

  it('POST /approvals/:id/approve returns 404 on the main MCP app', async () => {
    const forwarder = createMockForwarder({ status: 200, headers: {}, body: {} })
    const app = createApp(minimalConfig, forwarder)

    const res = await app.request('/approvals/any-ticket/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approved_by: 'attacker' }),
    })

    expect(res.status).toBe(404)
  })

  it('POST /approvals/:id/deny returns 404 on the main MCP app', async () => {
    const forwarder = createMockForwarder({ status: 200, headers: {}, body: {} })
    const app = createApp(minimalConfig, forwarder)

    const res = await app.request('/approvals/any-ticket/deny', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ denied_by: 'attacker' }),
    })

    expect(res.status).toBe(404)
  })

  it('GET /approvals returns 404 on the main MCP app', async () => {
    const forwarder = createMockForwarder({ status: 200, headers: {}, body: {} })
    const app = createApp(minimalConfig, forwarder)

    const res = await app.request('/approvals')

    expect(res.status).toBe(404)
  })

  // ---------------------------------------------------------------------------
  // Rate and spend limit read endpoints live exclusively on the dashboard
  // sideband (/api/limits). An agent speaking /mcp must not be able to
  // enumerate operational limit state from the same origin.
  // ---------------------------------------------------------------------------

  it('GET /rate-limits returns 404 on the main MCP app', async () => {
    const forwarder = createMockForwarder({ status: 200, headers: {}, body: {} })
    const app = createApp(minimalConfig, forwarder)

    const res = await app.request('/rate-limits')

    expect(res.status).toBe(404)
  })

  it('GET /spend-limits returns 404 on the main MCP app', async () => {
    const forwarder = createMockForwarder({ status: 200, headers: {}, body: {} })
    const app = createApp(minimalConfig, forwarder)

    const res = await app.request('/spend-limits')

    expect(res.status).toBe(404)
  })

  it('POST /rate-limits returns 404 on the main MCP app', async () => {
    const forwarder = createMockForwarder({ status: 200, headers: {}, body: {} })
    const app = createApp(minimalConfig, forwarder)

    const res = await app.request('/rate-limits', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })

    expect(res.status).toBe(404)
  })

  it('POST /spend-limits returns 404 on the main MCP app', async () => {
    const forwarder = createMockForwarder({ status: 200, headers: {}, body: {} })
    const app = createApp(minimalConfig, forwarder)

    const res = await app.request('/spend-limits', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })

    expect(res.status).toBe(404)
  })
})

describe('startSidebandServer', () => {
  it('closes within bounded time when a long-lived request is active', async () => {
    const app = new Hono()
    app.get('/hold', async () => {
      await new Promise<void>(() => {})
      return new Response('ok')
    })

    const port = 45_000 + Math.floor(Math.random() * 10_000)
    const handle = startSidebandServer(app, port, '127.0.0.1')
    const holdRequest = fetch(`http://127.0.0.1:${String(port)}/hold`)
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50)
    })

    const startedAt = Date.now()
    await handle.close()
    const elapsedMs = Date.now() - startedAt

    expect(elapsedMs).toBeLessThan(3_000)
    await holdRequest.catch(() => {
      // Expected: shutdown may close the request stream abruptly.
    })
  })
})
