import { describe, it, expect, vi } from 'vitest'
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
    protocol_version: 'auto',
    connect_timeout: '10s',
    request_timeout: '30s',
    forward_headers: [],
    headers: {},
  },
  listen: { port: 3000, host: '127.0.0.1', allowed_origins: [] },
  dashboard: {
    enabled: false,
    port: 3100,
    host: '127.0.0.1',
    allow_open_mode: false,
    sse_heartbeat_interval: '30s',
  },
  session: {
    identity: [{ source: 'header', name: 'x-helio-session-id' }, { source: 'legacy_header' }],
    on_unresolved: 'deny',
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

  it('throws on a named multi-upstream config (issue #293)', () => {
    // Library-level darkness: an embedder handing createApp a named config
    // must get a loud pointer at createMultiApp, never a silent single-mount
    // app serving only one of the declared upstreams.
    const named = {
      version: '1',
      upstreams: [
        {
          name: 'files',
          url: 'http://localhost:8081/mcp',
          transport: 'streamable-http',
          protocol_version: 'auto',
          connect_timeout: '10s',
          request_timeout: '30s',
          forward_headers: [],
          headers: {},
        },
      ],
      listen: { port: 3000, host: '127.0.0.1', allowed_origins: [] },
      dashboard: {
        enabled: false,
        port: 3100,
        host: '127.0.0.1',
        allow_open_mode: false,
        sse_heartbeat_interval: '30s',
      },
      session: {
        identity: [{ source: 'header', name: 'x-helio-session-id' }, { source: 'legacy_header' }],
        on_unresolved: 'deny',
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
    const forwarder = createMockForwarder({ status: 200, headers: {}, body: {} })

    expect(() => createApp(named, forwarder)).toThrow(
      'createApp serves a single-upstream (upstream:) config only. Named multi-upstream ' +
        'configs are composed by createMultiApp.',
    )
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

  // ---------------------------------------------------------------------------
  // Origin validation on the MCP transports (issue #213)
  // ---------------------------------------------------------------------------

  describe('origin validation (issue #213)', () => {
    const hostileOrigin = 'https://evil.example'
    const okResponse: McpResponse = {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: { jsonrpc: '2.0', id: 1, result: { tools: [] } },
    }

    it('rejects a hostile Origin on every MCP mount and method with zero forwarder calls', async () => {
      // Behavioral coverage test (D3): a guard registered after the handlers
      // still shows up in route-table introspection but never runs, so this
      // must assert behavior against the wired app, not route structure.
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const forwarder = createMockForwarder(okResponse)
      const app = createApp(minimalConfig, forwarder)

      const mcpMounts = ['/mcp', '/sse']
      const methods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD']
      for (const mount of mcpMounts) {
        for (const method of methods) {
          const init: RequestInit = {
            method,
            headers: { origin: hostileOrigin, 'content-type': 'application/json' },
          }
          if (method !== 'GET' && method !== 'HEAD') {
            init.body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
          }
          const res = await app.request(mount, init)
          expect(res.status, `${method} ${mount}`).toBe(403)
        }
      }
      expect(forwarder.calls).toHaveLength(0)
      errorSpy.mockRestore()
    })

    it.each([
      ['an uppercase header name', { ORIGIN: 'https://evil.example' }],
      ['a mixed-case header name', { OrIgIn: 'https://evil.example' }],
      ['an empty header value', { origin: '' }],
    ])('rejects a hostile Origin sent with %s', async (_label, originHeader) => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const forwarder = createMockForwarder(okResponse)
      const app = createApp(minimalConfig, forwarder)

      const res = await app.request('/mcp', {
        method: 'POST',
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        headers: { 'content-type': 'application/json', ...originHeader },
      })

      expect(res.status).toBe(403)
      expect(forwarder.calls).toHaveLength(0)
      errorSpy.mockRestore()
    })

    it.each(['/mcp/', '/mcp?sessionId=abc', '/sse/', '/sse?sessionId=abc'])(
      'rejects a hostile Origin on the path variant %s',
      async (path) => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        const forwarder = createMockForwarder(okResponse)
        const app = createApp(minimalConfig, forwarder)

        const res = await app.request(path, {
          method: 'POST',
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
          headers: { 'content-type': 'application/json', origin: hostileOrigin },
        })

        expect(res.status).toBe(403)
        expect(forwarder.calls).toHaveLength(0)
        errorSpy.mockRestore()
      },
    )

    it('keeps GET /healthz reachable with a hostile Origin', async () => {
      const forwarder = createMockForwarder(okResponse)
      const app = createApp(minimalConfig, forwarder)

      const res = await app.request('/healthz', {
        headers: { origin: hostileOrigin },
      })

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ status: 'ok' })
    })

    it('keeps /slack/actions unguarded (signature verification protects it)', async () => {
      const forwarder = createMockForwarder(okResponse)
      const slackActionApp = new Hono()
      slackActionApp.post('/', (c) => c.json({ reached: true }))
      const app = createApp(minimalConfig, forwarder, { slackActionApp })

      const res = await app.request('/slack/actions', {
        method: 'POST',
        headers: { origin: hostileOrigin, 'content-type': 'application/x-www-form-urlencoded' },
        body: 'payload=%7B%7D',
      })

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ reached: true })
    })

    it('threads listen.allowed_origins from config to both transports', async () => {
      const forwarder = createMockForwarder(okResponse)
      const config = {
        ...minimalConfig,
        listen: { ...minimalConfig.listen, allowed_origins: ['http://localhost:5173'] },
      } as HelioConfig
      const app = createApp(config, forwarder)

      const mcpRes = await app.request('/mcp', {
        method: 'POST',
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        headers: { 'Content-Type': 'application/json', origin: 'http://localhost:5173' },
      })
      expect(mcpRes.status).toBe(200)
      expect(forwarder.calls).toHaveLength(1)

      const sseRes = await app.request('/sse', {
        headers: { origin: 'http://localhost:5173' },
      })
      expect(sseRes.status).toBe(200)
      expect(sseRes.headers.get('content-type')).toBe('text/event-stream')
    })
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
