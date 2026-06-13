import { describe, it, expect, afterEach } from 'vitest'
import type { AddressInfo } from 'node:net'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import type { ServerType } from '@hono/node-server'
import { createApp } from '../server.js'
import { StreamableHttpForwarder } from './streamable-http-forwarder.js'
import type { HelioConfig } from '../config/index.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wait for a server to be listening and return the assigned port. */
function getPort(server: ServerType): number {
  const addr = server.address() as AddressInfo
  return addr.port
}

/** Start a Hono app on a dynamic port. Returns the server and port. */
function startOnDynamicPort(app: Hono): { server: ServerType; port: number } {
  const server = serve({ fetch: app.fetch, port: 0 })
  return { server, port: getPort(server) }
}

/** Close a server and return a promise. */
function closeServer(server: ServerType): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}

function makeConfig(upstreamUrl: string): HelioConfig {
  return {
    version: '1',
    upstream: {
      url: upstreamUrl,
      transport: 'streamable-http',
      connect_timeout: '10s',
      request_timeout: '30s',
      forward_headers: [],
      headers: {},
    },
    listen: { port: 0, host: '127.0.0.1' },
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
  } as HelioConfig
}

/** Create a mock upstream MCP server with canned responses. */
function createMockUpstream(): Hono {
  const app = new Hono()

  app.post('/mcp', async (c) => {
    const body: { method: string; id?: unknown } = await c.req.json()

    if (body.method === 'tools/list') {
      return c.json({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          tools: [
            {
              name: 'get_weather',
              description: 'Get the current weather',
              inputSchema: { type: 'object', properties: {} },
            },
            {
              name: 'send_email',
              description: 'Send an email',
              inputSchema: { type: 'object', properties: {} },
            },
          ],
        },
      })
    }

    if (body.method === 'tools/call') {
      return c.json({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          content: [{ type: 'text', text: 'sunny, 22°C' }],
        },
      })
    }

    if (body.method === 'initialize') {
      c.header('mcp-session-id', 'upstream-session-abc')
      return c.json({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          serverInfo: { name: 'mock-upstream', version: '1.0.0' },
        },
      })
    }

    return c.json({
      jsonrpc: '2.0',
      id: body.id,
      error: { code: -32601, message: 'method not found' },
    })
  })

  return app
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('upstream forwarder e2e', () => {
  const servers: ServerType[] = []

  afterEach(async () => {
    await Promise.all(servers.map(closeServer))
    servers.length = 0
  })

  it('forwards tools/list through the proxy and returns the upstream response', async () => {
    // Start mock upstream
    const upstream = startOnDynamicPort(createMockUpstream())
    servers.push(upstream.server)

    // Start proxy pointing at upstream
    const upstreamUrl = `http://127.0.0.1:${String(upstream.port)}/mcp`
    const forwarder = new StreamableHttpForwarder({ url: upstreamUrl })
    const proxyApp = createApp(makeConfig(upstreamUrl), forwarder)
    const proxy = startOnDynamicPort(proxyApp)
    servers.push(proxy.server)

    // Send tools/list through the proxy
    const res = await fetch(`http://127.0.0.1:${String(proxy.port)}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })

    expect(res.status).toBe(200)
    const json = (await res.json()) as { jsonrpc: string; id: number; result: { tools: unknown[] } }
    expect(json.jsonrpc).toBe('2.0')
    expect(json.id).toBe(1)
    expect(json.result.tools).toHaveLength(2)
  })

  it('forwards tools/call through the proxy', async () => {
    const upstream = startOnDynamicPort(createMockUpstream())
    servers.push(upstream.server)

    const upstreamUrl = `http://127.0.0.1:${String(upstream.port)}/mcp`
    const forwarder = new StreamableHttpForwarder({ url: upstreamUrl })
    const proxyApp = createApp(makeConfig(upstreamUrl), forwarder)
    const proxy = startOnDynamicPort(proxyApp)
    servers.push(proxy.server)

    const res = await fetch(`http://127.0.0.1:${String(proxy.port)}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'get_weather', arguments: {} },
      }),
    })

    expect(res.status).toBe(200)
    const json = (await res.json()) as { result: { content: { text: string }[] } }
    expect(json.result.content[0]?.text).toBe('sunny, 22°C')
  })

  it('passes Mcp-Session-Id from upstream back to the client', async () => {
    const upstream = startOnDynamicPort(createMockUpstream())
    servers.push(upstream.server)

    const upstreamUrl = `http://127.0.0.1:${String(upstream.port)}/mcp`
    const forwarder = new StreamableHttpForwarder({ url: upstreamUrl })
    const proxyApp = createApp(makeConfig(upstreamUrl), forwarder)
    const proxy = startOnDynamicPort(proxyApp)
    servers.push(proxy.server)

    const res = await fetch(`http://127.0.0.1:${String(proxy.port)}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('mcp-session-id')).toBe('upstream-session-abc')
  })

  it('returns normalized JSON-RPC error when upstream is unreachable', async () => {
    // Point at a port where nothing is listening
    const forwarder = new StreamableHttpForwarder({ url: 'http://127.0.0.1:19999/mcp' })
    const proxyApp = createApp(makeConfig('http://127.0.0.1:19999/mcp'), forwarder)
    const proxy = startOnDynamicPort(proxyApp)
    servers.push(proxy.server)

    const res = await fetch(`http://127.0.0.1:${String(proxy.port)}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })

    expect(res.status).toBe(200)
    const json = (await res.json()) as { error: { code: number; data?: Record<string, unknown> } }
    expect(json.error.code).toBe(-32603)
    expect(json.error.data?.['failure_class']).toBe('upstream_forward_error')
  })
})
