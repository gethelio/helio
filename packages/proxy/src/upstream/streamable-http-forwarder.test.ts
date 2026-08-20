import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { StreamableHttpForwarder } from './streamable-http-forwarder.js'
import { MCP_NAME_MAX_BYTES } from './standard-headers.js'
import { ERA_PROBE_BACKOFF_MS } from './upstream-session-manager.js'
import type { McpRequest } from '../mcp/types.js'

const originalFetch = globalThis.fetch

beforeEach(() => {
  // Establishing the internal session logs one era-detected line per probe.
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  globalThis.fetch = originalFetch
})

function req(overrides: Partial<McpRequest> = {}): McpRequest {
  return { jsonrpc: '2.0', id: 1, method: 'tools/list', ...overrides }
}

/**
 * A forwarder pinned to the legacy era. These tests' subject is legacy-leg
 * relay behavior; the pin keeps their generic fetch mocks from having to
 * answer the auto-mode server/discover probe, whose accidental legacy
 * classification would prove nothing. Era interplay is exercised explicitly
 * in the issue #219 describes below, and legacy parity under a PROBE-CACHED
 * era (not just a pin) is proven in the legacy-parity describe.
 */
function legacyPinnedForwarder(): StreamableHttpForwarder {
  return new StreamableHttpForwarder({ url: 'http://up/mcp', protocolVersion: '2025-06-18' })
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
    const fwd = legacyPinnedForwarder()
    const { response } = await fwd.forward(req({ transportSessionId: 'S1' }))
    expect((response.body as { result: unknown }).result).toEqual({ tools: [] })
  })

  it('parses a text/event-stream POST response', async () => {
    globalThis.fetch = () =>
      Promise.resolve(
        new Response('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        }),
      )
    const fwd = legacyPinnedForwarder()
    const { response } = await fwd.forward(req({ transportSessionId: 'S1' }))
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
    const fwd = legacyPinnedForwarder()
    await fwd.forward(req({ transportSessionId: 'S1' }))
    expect(seen['mcp-protocol-version']).toBeDefined()
    expect(seen['mcp-session-id']).toBe('S1')
  })

  it('does not override downstream-supplied mcp-protocol-version', async () => {
    let seen: Record<string, string> = {}
    globalThis.fetch = (_u, init) => {
      seen = (init?.headers as Record<string, string> | undefined) ?? {}
      return Promise.resolve(
        new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), {
          headers: { 'content-type': 'application/json' },
        }),
      )
    }
    const fwd = legacyPinnedForwarder()
    await fwd.forward(
      req({
        transportSessionId: 'S1',
        headers: { 'mcp-protocol-version': '2025-03-26' },
      }),
    )
    expect(seen['mcp-protocol-version']).toBe('2025-03-26')
  })

  it('never sends a resolved governance session upstream as Mcp-Session-Id', async () => {
    // The FastMCP-corruption regression: session-enforcing upstreams 400/404
    // any id they did not mint, so only the verbatim transport relay may
    // reach the wire — on both forward branches.
    let seen: Record<string, string> = {}
    globalThis.fetch = (_u, init) => {
      seen = (init?.headers as Record<string, string> | undefined) ?? {}
      return Promise.resolve(
        new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), {
          headers: { 'content-type': 'application/json' },
        }),
      )
    }
    const fwd = legacyPinnedForwarder()

    await fwd.forward(req({ session: { id: 'run-a', source: 'header' } }))
    expect(seen['mcp-session-id']).toBeUndefined()

    await fwd.forward(req({ method: 'initialize', session: { id: 'run-a', source: 'header' } }))
    expect(seen['mcp-session-id']).toBeUndefined()
  })

  it('relays the upstream Mcp-Session-Id response header', async () => {
    globalThis.fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), {
          headers: { 'content-type': 'application/json', 'mcp-session-id': 'U-new' },
        }),
      )
    const fwd = legacyPinnedForwarder()
    const { response } = await fwd.forward(
      req({ method: 'initialize', transportSessionId: undefined }),
    )
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
    const fwd = legacyPinnedForwarder()
    await fwd.forward(req({ method: 'initialize', transportSessionId: undefined }))
    expect(seen['mcp-protocol-version']).toBeUndefined()
    expect(seen['mcp-session-id']).toBeUndefined()
  })

  // -------------------------------------------------------------------------
  // Issue #288: a caller-supplied mcp-session-id merged from McpRequest
  // headers (or constructor statics) must never ship on the legacy leg —
  // the wire value comes only from the transport relay field (relayed) or
  // the manager-minted session (internal).
  // -------------------------------------------------------------------------

  describe('legacy-leg caller-supplied mcp-session-id (issue #288)', () => {
    it('never forwards a caller-supplied mcp-session-id on a legacy relay with no transport id', async () => {
      const calls = stubRelayUpstream({ 'tools/list': okResult() })
      const fwd = legacyPinnedForwarder()

      await fwd.forward(req({ headers: { 'mcp-session-id': 'caller-forged' } }))

      const relay = callsOf(calls, 'tools/list')[0]
      expect(relay?.headers['mcp-session-id']).toBeUndefined()
    })

    it('never forwards a caller-supplied Mcp-Session-Id whatever its key casing', async () => {
      const calls = stubRelayUpstream({ 'tools/list': okResult() })
      const fwd = legacyPinnedForwarder()

      await fwd.forward(req({ headers: { 'Mcp-Session-Id': 'caller-forged-cased' } }))

      const relay = callsOf(calls, 'tools/list')[0]
      expect(relay?.headers['mcp-session-id']).toBeUndefined()
      // Pin (green pre-fix): the merge lower-cases every key, so a cased
      // duplicate can never ship alongside the lower-cased one.
      expect(relay?.headers['Mcp-Session-Id']).toBeUndefined()
    })

    it('never forwards a constructor static-header mcp-session-id on the legacy leg', async () => {
      const calls = stubRelayUpstream({ 'tools/list': okResult() })
      const fwd = new StreamableHttpForwarder({
        url: 'http://up/mcp',
        protocolVersion: '2025-06-18',
        headers: { 'mcp-session-id': 'static-forged' },
      })

      await fwd.forward(req())

      const relay = callsOf(calls, 'tools/list')[0]
      expect(relay?.headers['mcp-session-id']).toBeUndefined()
    })

    it('still sends the transport session id when a caller header rode the same request', async () => {
      // Characterization pin (green pre-fix): the transport relay id wins
      // over caller residue, so any residue clear must run before the
      // transport stamp or this pin flips.
      const calls = stubRelayUpstream({ 'tools/list': okResult() })
      const fwd = legacyPinnedForwarder()

      await fwd.forward(
        req({ transportSessionId: 'S1', headers: { 'mcp-session-id': 'caller-forged' } }),
      )

      const relay = callsOf(calls, 'tools/list')[0]
      expect(relay?.headers['mcp-session-id']).toBe('S1')
    })

    it('never forwards a caller-supplied mcp-session-id on an internal send to a sessionless legacy upstream', async () => {
      // The sessionless fixture is load-bearing: a minting upstream's id
      // would be stamped over the caller residue at the send site and mask
      // the leak. The 202 on notifications/initialized is load-bearing too —
      // without it the legacy establish throws before send() ever runs.
      const calls = stubRelayUpstream({
        'server/discover': () =>
          jsonEnvelope({
            jsonrpc: '2.0',
            id: 'helio-era-probe',
            error: { code: -32601, message: 'Method not found' },
          }),
        initialize: () =>
          jsonEnvelope({ jsonrpc: '2.0', id: 0, result: { protocolVersion: '2025-06-18' } }),
        'notifications/initialized': () => new Response(null, { status: 202 }),
        'tools/list': okResult(),
      })
      const fwd = new StreamableHttpForwarder({ url: 'http://up/mcp' })

      await fwd.forwardInternal(req({ headers: { 'mcp-session-id': 'caller-forged' } }))

      const relay = callsOf(calls, 'tools/list')[0]
      expect(relay?.headers['mcp-session-id']).toBeUndefined()
    })
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
    const fwd = legacyPinnedForwarder()
    const { response } = await fwd.forward(req({ transportSessionId: 'S1' }))
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

      // A legacy upstream: the era probe hits an unimplemented method.
      if (body.method === 'server/discover') {
        return Promise.resolve(new Response(null, { status: 202 }))
      }

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

  it('uses the negotiated internal protocol version on managed-session requests', async () => {
    const seenProtocolHeaders: string[] = []
    globalThis.fetch = (_u: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const raw = typeof init?.body === 'string' ? init.body : '{}'
      const body = JSON.parse(raw) as { method: string }
      const headers = (init?.headers ?? {}) as Record<string, string>

      // A legacy upstream: the era probe hits an unimplemented method.
      if (body.method === 'server/discover') {
        return Promise.resolve(new Response(null, { status: 202 }))
      }
      if (body.method === 'initialize') {
        return Promise.resolve(
          new Response(
            JSON.stringify({ jsonrpc: '2.0', id: 0, result: { protocolVersion: '2025-03-26' } }),
            {
              status: 200,
              headers: { 'content-type': 'application/json', 'mcp-session-id': 'U-1' },
            },
          ),
        )
      }
      if (body.method === 'notifications/initialized') {
        return Promise.resolve(new Response(null, { status: 202 }))
      }

      seenProtocolHeaders.push(headers['mcp-protocol-version'] ?? '')
      return Promise.resolve(
        new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
    }

    const fwd = new StreamableHttpForwarder({ url: 'http://up/mcp' })
    await fwd.forwardInternal(req())
    expect(seenProtocolHeaders).toEqual(['2025-03-26'])
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
    const fwd = legacyPinnedForwarder()
    const { response } = await fwd.forward(
      req({ id: undefined, method: 'notifications/progress', transportSessionId: 'S1' }),
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
      protocolVersion: '2025-06-18',
    })
    await fwd.forward(
      req({
        transportSessionId: 'S1',
        headers: { Authorization: 'Bearer caller', 'x-trace': 't1' },
      }),
    )
    // Static config wins — caller cannot override Authorization
    expect(seen['authorization']).toBe('Bearer cfg')
    // Non-overlapping caller header passes through
    expect(seen['x-trace']).toBe('t1')
  })

  // -------------------------------------------------------------------------
  // Standard request headers (issue #217)
  // -------------------------------------------------------------------------

  it('relayed tools/call carries mcp-method and mcp-name mirroring the body', async () => {
    let seen: Record<string, string> = {}
    globalThis.fetch = (_u, init) => {
      seen = (init?.headers as Record<string, string> | undefined) ?? {}
      return Promise.resolve(
        new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), {
          headers: { 'content-type': 'application/json' },
        }),
      )
    }
    const fwd = legacyPinnedForwarder()
    await fwd.forward(
      req({
        method: 'tools/call',
        params: { name: 'get_weather', arguments: {} },
        transportSessionId: 'S1',
      }),
    )
    expect(seen['mcp-method']).toBe('tools/call')
    expect(seen['mcp-name']).toBe('get_weather')
  })

  it('relayed prompts/get carries mcp-method and mcp-name mirroring the body', async () => {
    let seen: Record<string, string> = {}
    globalThis.fetch = (_u, init) => {
      seen = (init?.headers as Record<string, string> | undefined) ?? {}
      return Promise.resolve(
        new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), {
          headers: { 'content-type': 'application/json' },
        }),
      )
    }
    const fwd = legacyPinnedForwarder()
    await fwd.forward(
      req({
        method: 'prompts/get',
        params: { name: 'daily_summary' },
        transportSessionId: 'S1',
      }),
    )
    expect(seen['mcp-method']).toBe('prompts/get')
    expect(seen['mcp-name']).toBe('daily_summary')
  })

  it('relayed resources/read carries mcp-method and mcp-name from params.uri', async () => {
    let seen: Record<string, string> = {}
    globalThis.fetch = (_u, init) => {
      seen = (init?.headers as Record<string, string> | undefined) ?? {}
      return Promise.resolve(
        new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), {
          headers: { 'content-type': 'application/json' },
        }),
      )
    }
    const fwd = legacyPinnedForwarder()
    await fwd.forward(
      req({
        method: 'resources/read',
        params: { uri: 'file:///tmp/notes.txt' },
        transportSessionId: 'S1',
      }),
    )
    expect(seen['mcp-method']).toBe('resources/read')
    expect(seen['mcp-name']).toBe('file:///tmp/notes.txt')
  })

  it('relayed tools/list carries mcp-method and no mcp-name', async () => {
    let seen: Record<string, string> = {}
    globalThis.fetch = (_u, init) => {
      seen = (init?.headers as Record<string, string> | undefined) ?? {}
      return Promise.resolve(
        new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), {
          headers: { 'content-type': 'application/json' },
        }),
      )
    }
    const fwd = legacyPinnedForwarder()
    await fwd.forward(req({ method: 'tools/list', transportSessionId: 'S1' }))
    expect(seen['mcp-method']).toBe('tools/list')
    expect(seen['mcp-name']).toBeUndefined()
  })

  it('a relayed notification carries mcp-method mirroring its method', async () => {
    let seen: Record<string, string> = {}
    globalThis.fetch = (_u, init) => {
      seen = (init?.headers as Record<string, string> | undefined) ?? {}
      return Promise.resolve(
        new Response(JSON.stringify({ jsonrpc: '2.0' }), {
          headers: { 'content-type': 'application/json' },
        }),
      )
    }
    const fwd = legacyPinnedForwarder()
    await fwd.forward(
      req({ id: undefined, method: 'notifications/initialized', transportSessionId: 'S1' }),
    )
    expect(seen['mcp-method']).toBe('notifications/initialized')
  })

  it('omits mcp-method when a caller-injected value cannot survive the guard', async () => {
    let seen: Record<string, string> = {}
    globalThis.fetch = (_u, init) => {
      seen = (init?.headers as Record<string, string> | undefined) ?? {}
      return Promise.resolve(
        new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), {
          headers: { 'content-type': 'application/json' },
        }),
      )
    }
    const fwd = legacyPinnedForwarder()
    await fwd.forward(
      req({
        method: 'héllo',
        transportSessionId: 'S1',
        headers: { 'mcp-method': 'lie' },
      }),
    )
    expect(seen['mcp-method']).toBeUndefined()
  })

  it('omits mcp-name when a caller-injected value has no name-bearing method to attach to', async () => {
    let seen: Record<string, string> = {}
    globalThis.fetch = (_u, init) => {
      seen = (init?.headers as Record<string, string> | undefined) ?? {}
      return Promise.resolve(
        new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), {
          headers: { 'content-type': 'application/json' },
        }),
      )
    }
    const fwd = legacyPinnedForwarder()
    await fwd.forward(
      req({
        method: 'tools/list',
        transportSessionId: 'S1',
        headers: { 'mcp-name': 'lie' },
      }),
    )
    expect(seen['mcp-name']).toBeUndefined()
  })

  it('omits mcp-name when a caller-injected value cannot survive the byte cap', async () => {
    let seen: Record<string, string> = {}
    globalThis.fetch = (_u, init) => {
      seen = (init?.headers as Record<string, string> | undefined) ?? {}
      return Promise.resolve(
        new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), {
          headers: { 'content-type': 'application/json' },
        }),
      )
    }
    const fwd = legacyPinnedForwarder()
    await fwd.forward(
      req({
        method: 'resources/read',
        params: { uri: 'x'.repeat(MCP_NAME_MAX_BYTES + 1) },
        transportSessionId: 'S1',
        headers: { 'mcp-name': 'small-lie' },
      }),
    )
    expect(seen['mcp-name']).toBeUndefined()
  })

  it('ignores caller-injected mcp-method/mcp-name in favor of the body-true values', async () => {
    let seen: Record<string, string> = {}
    globalThis.fetch = (_u, init) => {
      seen = (init?.headers as Record<string, string> | undefined) ?? {}
      return Promise.resolve(
        new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), {
          headers: { 'content-type': 'application/json' },
        }),
      )
    }
    const fwd = legacyPinnedForwarder()
    await fwd.forward(
      req({
        method: 'tools/call',
        params: { name: 'get_weather', arguments: {} },
        transportSessionId: 'S1',
        headers: { 'mcp-method': 'lie', 'mcp-name': 'lie' },
      }),
    )
    expect(seen['mcp-method']).toBe('tools/call')
    expect(seen['mcp-name']).toBe('get_weather')
  })

  // -------------------------------------------------------------------------
  // Modern (2026-07-28) internal sends
  // -------------------------------------------------------------------------

  it('sends conforming modern internal requests (headers + _meta, no session id)', async () => {
    let seenHeaders: Record<string, string> = {}
    let seenBody: { method: string; params?: Record<string, unknown> } | undefined

    globalThis.fetch = (_u: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const raw = typeof init?.body === 'string' ? init.body : '{}'
      const body = JSON.parse(raw) as { method: string; params?: Record<string, unknown> }
      const headers = (init?.headers ?? {}) as Record<string, string>

      if (body.method === 'server/discover') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 'helio-era-probe',
              result: { supportedVersions: ['2026-07-28'] },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        )
      }

      seenHeaders = headers
      seenBody = body
      return Promise.resolve(
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 'helio-prime-annotations',
            result: { tools: [], resultType: 'complete', ttlMs: 60000, cacheScope: 'private' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
    }

    const fwd = new StreamableHttpForwarder({ url: 'http://up/mcp' })
    await fwd.forwardInternal(req({ id: 'helio-prime-annotations' }))

    expect(seenHeaders['mcp-method']).toBe('tools/list')
    expect(seenHeaders['mcp-protocol-version']).toBe('2026-07-28')
    expect(seenHeaders['mcp-session-id']).toBeUndefined()
    const meta = seenBody?.params?.['_meta'] as Record<string, unknown> | undefined
    expect(meta?.['io.modelcontextprotocol/protocolVersion']).toBe('2026-07-28')
  })

  it('stamps standard headers on legacy internal requests, otherwise byte-identical to today', async () => {
    let seenHeaders: Record<string, string> = {}
    let seenBody: { method: string; params?: unknown } | undefined

    globalThis.fetch = (_u: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const raw = typeof init?.body === 'string' ? init.body : '{}'
      const body = JSON.parse(raw) as { method: string; params?: unknown }
      const headers = (init?.headers ?? {}) as Record<string, string>

      // A legacy upstream: the era probe hits an unimplemented method.
      if (body.method === 'server/discover') {
        return Promise.resolve(new Response(null, { status: 202 }))
      }
      if (body.method === 'initialize') {
        return Promise.resolve(
          new Response(
            JSON.stringify({ jsonrpc: '2.0', id: 0, result: { protocolVersion: '2025-06-18' } }),
            {
              status: 200,
              headers: { 'content-type': 'application/json', 'mcp-session-id': 'U-1' },
            },
          ),
        )
      }
      if (body.method === 'notifications/initialized') {
        return Promise.resolve(new Response(null, { status: 202 }))
      }

      seenHeaders = headers
      seenBody = body
      return Promise.resolve(
        new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
    }

    const fwd = new StreamableHttpForwarder({ url: 'http://up/mcp' })
    await fwd.forwardInternal(req())

    expect(seenHeaders['mcp-session-id']).toBe('U-1')
    expect(seenHeaders['mcp-protocol-version']).toBe('2025-06-18')
    expect(seenHeaders['mcp-method']).toBe('tools/list')
    expect(seenBody?.params).toBeUndefined()
  })

  it('relays with modern semantics under a modern era cached by internal traffic', async () => {
    // Before issue #219 relays stayed legacy-versioned no matter the era;
    // now a cached modern era makes the relay leg modern too: version
    // header stamped, _meta injected, and no wire session id sent upstream.
    let seenHeaders: Record<string, string> = {}
    let seenBody: { method: string; params?: Record<string, unknown> } | undefined
    let probeCount = 0

    globalThis.fetch = (_u: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const raw = typeof init?.body === 'string' ? init.body : '{}'
      const body = JSON.parse(raw) as { method: string; params?: Record<string, unknown> }
      const headers = (init?.headers ?? {}) as Record<string, string>

      if (body.method === 'server/discover') {
        probeCount += 1
        return Promise.resolve(
          new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 'helio-era-probe',
              result: { supportedVersions: ['2026-07-28'] },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        )
      }

      seenHeaders = headers
      seenBody = body
      return Promise.resolve(
        new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
    }

    const fwd = new StreamableHttpForwarder({ url: 'http://up/mcp' })
    // Prime a modern internal session first, so a cached modern era exists.
    await fwd.forwardInternal(req({ id: 'prime' }))

    await fwd.forward(req({ transportSessionId: 'S1' }))

    expect(probeCount).toBe(1) // the relay reused the cached era
    expect(seenHeaders['mcp-session-id']).toBeUndefined()
    expect(seenHeaders['mcp-protocol-version']).toBe('2026-07-28')
    expect(seenHeaders['mcp-method']).toBe('tools/list')
    const meta = seenBody?.params?.['_meta'] as Record<string, unknown> | undefined
    expect(meta?.['io.modelcontextprotocol/protocolVersion']).toBe('2026-07-28')
  })

  // -------------------------------------------------------------------------
  // External review round 3, F1: the modern send() path must derive
  // mcp-name from the EXACT object it serializes onto the wire, not from
  // `request.params` — the modern branch rewrites params into a new spread
  // object (with an injected `_meta`), so a `toJSON` on the original params
  // that is inherited, non-enumerable, or reads `this._meta` can make the
  // header and the body disagree if the header is derived from the wrong
  // object. Each case below primes a modern internal session, then sends a
  // name-bearing `tools/call` and reads the name back out of the ACTUAL
  // parsed wire body (never a hard-coded literal) to prove agreement.
  // -------------------------------------------------------------------------

  /** Prime a modern-era forwarder and capture the next internal send's wire. */
  async function sendModernToolsCall(
    params: unknown,
  ): Promise<{ headers: Record<string, string>; body: { params?: Record<string, unknown> } }> {
    let seenHeaders: Record<string, string> = {}
    let seenBody: { params?: Record<string, unknown> } | undefined

    globalThis.fetch = (_u: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const raw = typeof init?.body === 'string' ? init.body : '{}'
      const parsed = JSON.parse(raw) as { method: string; params?: Record<string, unknown> }
      const headers = (init?.headers ?? {}) as Record<string, string>

      if (parsed.method === 'server/discover') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 'helio-era-probe',
              result: { supportedVersions: ['2026-07-28'] },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        )
      }

      if (parsed.method === 'tools/call') {
        seenHeaders = headers
        seenBody = parsed
      }
      return Promise.resolve(
        new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
    }

    const fwd = new StreamableHttpForwarder({ url: 'http://up/mcp' })
    // Prime the modern era with an unrelated (name-less) internal call first.
    await fwd.forwardInternal(req({ id: 'prime' }))
    await fwd.forwardInternal(req({ id: 2, method: 'tools/call', params }))

    if (!seenBody) throw new Error('tools/call was never observed on the wire')
    return { headers: seenHeaders, body: seenBody }
  }

  it('agrees header with body when params has an inherited (prototype) toJSON', async () => {
    // Object spread copies only OWN enumerable properties, so the inherited
    // toJSON on `proto` never reaches the outbound spread object.
    const proto = { toJSON: () => ({ name: 'from-proto' }) }
    const params = Object.create(proto) as Record<string, unknown>
    params['name'] = 'own'

    const { headers, body } = await sendModernToolsCall(params)
    const bodyName = body.params?.['name']
    expect(typeof bodyName).toBe('string')
    expect(headers['mcp-name']).toBe(bodyName)
    // Not copied onto the spread object, so it cannot win either side.
    expect(bodyName).not.toBe('from-proto')
    // _meta survives on the wire: no toJSON reached the outbound object, so
    // serialization is the plain spread object, mirror intact.
    expect(
      (body.params?.['_meta'] as Record<string, unknown> | undefined)?.[
        'io.modelcontextprotocol/protocolVersion'
      ],
    ).toBe('2026-07-28')
  })

  it('agrees header with body when params has an own non-enumerable toJSON', async () => {
    // Object spread copies only ENUMERABLE own properties, so a
    // non-enumerable toJSON never reaches the outbound spread object either.
    const params: Record<string, unknown> = { name: 'live' }
    Object.defineProperty(params, 'toJSON', {
      value: () => ({ name: 'hidden' }),
      enumerable: false,
      writable: true,
      configurable: true,
    })

    const { headers, body } = await sendModernToolsCall(params)
    const bodyName = body.params?.['name']
    expect(typeof bodyName).toBe('string')
    expect(headers['mcp-name']).toBe(bodyName)
    expect(bodyName).not.toBe('hidden')
    // _meta survives on the wire: no toJSON reached the outbound object.
    expect(
      (body.params?.['_meta'] as Record<string, unknown> | undefined)?.[
        'io.modelcontextprotocol/protocolVersion'
      ],
    ).toBe('2026-07-28')
  })

  it('agrees header with body when params has an own-enumerable toJSON reading this._meta', async () => {
    // An own-enumerable toJSON IS copied by the spread (functions are values
    // like any other), so it runs on the outbound object at serialization
    // time — with `this` bound to that object, `_meta` included. Because
    // JSON.stringify substitutes a toJSON's return value for the whole
    // object, the wire `params` becomes exactly that return value (so the
    // literal `_meta` key is not itself expected on the wire here — the
    // name value it produces IS the proof `_meta` was present on `this`
    // at call time, which is what the header must agree with).
    const params: Record<string, unknown> = {
      name: 'ignored',
      toJSON(this: Record<string, unknown>) {
        return { name: this['_meta'] ? 'with-meta' : 'no-meta' }
      },
    }

    const { headers, body } = await sendModernToolsCall(params)
    const bodyName = body.params?.['name']
    expect(bodyName).toBe('with-meta')
    expect(headers['mcp-name']).toBe(bodyName)
  })

  it('resetInternalSession() forces a fresh era probe on the next internal request', async () => {
    let discoverCount = 0

    globalThis.fetch = (_u: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const raw = typeof init?.body === 'string' ? init.body : '{}'
      const body = JSON.parse(raw) as { method: string }

      if (body.method === 'server/discover') {
        discoverCount += 1
        return Promise.resolve(
          new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 'helio-era-probe',
              result: { supportedVersions: ['2026-07-28'] },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        )
      }

      return Promise.resolve(
        new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
    }

    const fwd = new StreamableHttpForwarder({ url: 'http://up/mcp' })
    await fwd.forwardInternal(req())
    expect(discoverCount).toBe(1)

    // Cached: a second internal call does not re-probe.
    await fwd.forwardInternal(req())
    expect(discoverCount).toBe(1)

    fwd.resetInternalSession()
    await fwd.forwardInternal(req())
    expect(discoverCount).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Era-aware relay leg (issue #219)
// ---------------------------------------------------------------------------

/** One upstream POST the dispatching stub observed. */
interface RelayCall {
  readonly method: string
  readonly headers: Record<string, string>
  readonly body: Record<string, unknown>
}

type RelayHandler = (
  body: Record<string, unknown>,
  headers: Record<string, string>,
) => Response | Promise<Response>

/**
 * Stub `fetch` with a JSON-RPC method dispatcher, recording every call.
 * Methods without a handler answer `202`-empty.
 */
function stubRelayUpstream(handlers: Record<string, RelayHandler>): RelayCall[] {
  const calls: RelayCall[] = []
  globalThis.fetch = (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const raw = typeof init?.body === 'string' ? init.body : '{}'
    const body = JSON.parse(raw) as Record<string, unknown>
    const headers = { ...((init?.headers ?? {}) as Record<string, string>) }
    const method = body['method'] as string
    calls.push({ method, headers, body })
    const handler = handlers[method]
    try {
      return Promise.resolve(handler ? handler(body, headers) : new Response(null, { status: 202 }))
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
  }
  return calls
}

function jsonEnvelope(
  payload: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

/** A modern server/discover answer, optionally carrying capture fields. */
function modernDiscover(extra: Record<string, unknown> = {}): RelayHandler {
  return () =>
    jsonEnvelope({
      jsonrpc: '2.0',
      id: 'helio-era-probe',
      result: {
        resultType: 'complete',
        supportedVersions: ['2026-07-28'],
        capabilities: {},
        ...extra,
      },
    })
}

function okResult(id: unknown = 1): RelayHandler {
  return () => jsonEnvelope({ jsonrpc: '2.0', id, result: {} })
}

function callsOf(calls: readonly RelayCall[], method: string): RelayCall[] {
  return calls.filter((call) => call.method === method)
}

describe('StreamableHttpForwarder era-aware relay leg (issue #219)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('stamps 2026-07-28 and injects a full _meta mirror on a modern relay with no client _meta', async () => {
    const calls = stubRelayUpstream({
      'server/discover': modernDiscover(),
      'tools/call': okResult(),
    })
    const fwd = new StreamableHttpForwarder({ url: 'http://up/mcp' })

    await fwd.forward(
      req({
        method: 'tools/call',
        params: { name: 'get_weather', arguments: {} },
        transportSessionId: 'S1',
      }),
    )

    const relay = callsOf(calls, 'tools/call')[0]
    expect(relay?.headers['mcp-protocol-version']).toBe('2026-07-28')
    expect(relay?.headers['mcp-method']).toBe('tools/call')
    expect(relay?.headers['mcp-name']).toBe('get_weather')
    const params = relay?.body['params'] as Record<string, unknown>
    const meta = params['_meta'] as Record<string, unknown>
    expect(meta['io.modelcontextprotocol/protocolVersion']).toBe('2026-07-28')
    expect(meta['io.modelcontextprotocol/clientCapabilities']).toEqual({})
    expect(meta['io.modelcontextprotocol/clientInfo']).toEqual({
      name: 'helio-proxy',
      version: '0',
    })
    expect(params['name']).toBe('get_weather')
  })

  it("passes a modern client's clientInfo/clientCapabilities through and overrides only protocolVersion", async () => {
    const calls = stubRelayUpstream({
      'server/discover': modernDiscover(),
      'tools/call': okResult(),
    })
    const fwd = new StreamableHttpForwarder({ url: 'http://up/mcp' })

    await fwd.forward(
      req({
        method: 'tools/call',
        params: {
          name: 'get_weather',
          arguments: {},
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2099-01-01',
            'io.modelcontextprotocol/clientCapabilities': { elicitation: {} },
            'io.modelcontextprotocol/clientInfo': { name: 'real-client', version: '3.2' },
          },
        },
      }),
    )

    const meta = (callsOf(calls, 'tools/call')[0]?.body['params'] as Record<string, unknown>)[
      '_meta'
    ] as Record<string, unknown>
    expect(meta['io.modelcontextprotocol/protocolVersion']).toBe('2026-07-28')
    expect(meta['io.modelcontextprotocol/clientCapabilities']).toEqual({ elicitation: {} })
    expect(meta['io.modelcontextprotocol/clientInfo']).toEqual({
      name: 'real-client',
      version: '3.2',
    })
  })

  it('fills only the missing keys on a partial client _meta and keeps custom keys', async () => {
    const calls = stubRelayUpstream({
      'server/discover': modernDiscover(),
      'tools/call': okResult(),
    })
    const fwd = new StreamableHttpForwarder({ url: 'http://up/mcp' })

    await fwd.forward(
      req({
        method: 'tools/call',
        params: {
          name: 'get_weather',
          arguments: {},
          _meta: {
            'io.modelcontextprotocol/clientInfo': { name: 'real-client', version: '3.2' },
            'example.com/trace': 'T-1',
          },
        },
      }),
    )

    const meta = (callsOf(calls, 'tools/call')[0]?.body['params'] as Record<string, unknown>)[
      '_meta'
    ] as Record<string, unknown>
    expect(meta['io.modelcontextprotocol/protocolVersion']).toBe('2026-07-28')
    expect(meta['io.modelcontextprotocol/clientCapabilities']).toEqual({})
    expect(meta['io.modelcontextprotocol/clientInfo']).toEqual({
      name: 'real-client',
      version: '3.2',
    })
    expect(meta['example.com/trace']).toBe('T-1')
  })

  it('derives mcp-name from the exact merged outbound object (wire truth)', async () => {
    // An own-enumerable toJSON survives the merge spread and runs on the
    // OUTBOUND object at serialization time, _meta included; the header must
    // agree with what that toJSON actually put on the wire.
    const calls = stubRelayUpstream({
      'server/discover': modernDiscover(),
      'tools/call': okResult(),
    })
    const fwd = new StreamableHttpForwarder({ url: 'http://up/mcp' })

    const params: Record<string, unknown> = {
      name: 'ignored',
      toJSON(this: Record<string, unknown>) {
        return { name: this['_meta'] ? 'with-meta' : 'no-meta' }
      },
    }
    await fwd.forward(req({ method: 'tools/call', params }))

    const relay = callsOf(calls, 'tools/call')[0]
    const bodyName = (relay?.body['params'] as Record<string, unknown>)['name']
    expect(bodyName).toBe('with-meta')
    expect(relay?.headers['mcp-name']).toBe(bodyName)
  })

  it.each([
    ['array', [1, 2, 3]],
    ['primitive', 42],
  ])('refuses %s params proxy-side on the modern leg without fetching', async (_kind, params) => {
    const calls = stubRelayUpstream({
      'server/discover': modernDiscover(),
    })
    const fwd = new StreamableHttpForwarder({ url: 'http://up/mcp' })

    await expect(fwd.forward(req({ method: 'tools/call', params }))).rejects.toThrow(
      /^helio refused to forward: /,
    )
    expect(callsOf(calls, 'tools/call')).toHaveLength(0)
  })

  it.each([
    ['array', [1, 2, 3]],
    ['primitive', 42],
  ])('forwards %s params verbatim on the legacy leg', async (_kind, params) => {
    let seenParams: unknown
    stubRelayUpstream({
      'tools/call': (body) => {
        seenParams = body['params']
        return jsonEnvelope({ jsonrpc: '2.0', id: 1, result: {} })
      },
    })
    const fwd = legacyPinnedForwarder()

    await fwd.forward(req({ method: 'tools/call', params }))

    expect(seenParams).toEqual(params)
  })

  it('synthesizes the initialize result from the captured DiscoverResult and never forwards it', async () => {
    const calls = stubRelayUpstream({
      'server/discover': modernDiscover({
        capabilities: { tools: {}, prompts: {} },
        instructions: 'Use the search tool before the fetch tool.',
      }),
    })
    const fwd = new StreamableHttpForwarder({ url: 'http://up/mcp' })

    const { response } = await fwd.forward(
      req({ method: 'initialize', id: 7, transportSessionId: undefined }),
    )

    expect(callsOf(calls, 'initialize')).toHaveLength(0) // upstream never sees it
    expect(response.status).toBe(200)
    expect(response.headers['mcp-session-id']).toBeUndefined()
    expect(response.body).toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {}, prompts: {} },
        serverInfo: { name: 'helio-proxy', version: '0' },
        instructions: 'Use the search tool before the fetch tool.',
      },
    })
  })

  it('falls back to { tools: {} } and no instructions when nothing was captured (modern pin)', async () => {
    const calls = stubRelayUpstream({})
    const fwd = new StreamableHttpForwarder({ url: 'http://up/mcp', protocolVersion: '2026-07-28' })

    const { response } = await fwd.forward(req({ method: 'initialize', id: 1 }))

    expect(calls).toHaveLength(0) // pin: no probe, and initialize never forwarded
    const result = (response.body as { result: Record<string, unknown> }).result
    expect(result['capabilities']).toEqual({ tools: {} })
    expect(result['protocolVersion']).toBe('2025-06-18')
    expect('instructions' in result).toBe(false)
  })

  it('swallows notifications/initialized on the modern leg with the minimal success envelope', async () => {
    const calls = stubRelayUpstream({
      'server/discover': modernDiscover(),
    })
    const fwd = new StreamableHttpForwarder({ url: 'http://up/mcp' })

    const { response } = await fwd.forward(
      req({ id: undefined, method: 'notifications/initialized', transportSessionId: 'S1' }),
    )

    expect(callsOf(calls, 'notifications/initialized')).toHaveLength(0)
    expect(response.body).toEqual({ jsonrpc: '2.0' })
  })

  it('relays other notifications on the modern leg', async () => {
    const calls = stubRelayUpstream({
      'server/discover': modernDiscover(),
      'notifications/progress': () => new Response(null, { status: 202 }),
    })
    const fwd = new StreamableHttpForwarder({ url: 'http://up/mcp' })

    await fwd.forward(req({ id: undefined, method: 'notifications/progress', params: {} }))

    expect(callsOf(calls, 'notifications/progress')).toHaveLength(1)
  })

  it('never sends the wire Mcp-Session-Id upstream on a modern relay, however it arrived', async () => {
    const calls = stubRelayUpstream({
      'server/discover': modernDiscover(),
      'tools/list': okResult(),
    })
    const fwd = new StreamableHttpForwarder({ url: 'http://up/mcp' })

    await fwd.forward(
      req({ transportSessionId: 'S1', headers: { 'mcp-session-id': 'S1-injected' } }),
    )

    const relay = callsOf(calls, 'tools/list')[0]
    expect(relay?.headers['mcp-session-id']).toBeUndefined()
  })

  it('strips the response mcp-session-id on the modern leg (JSON branch)', async () => {
    stubRelayUpstream({
      'server/discover': modernDiscover(),
      'tools/list': () =>
        jsonEnvelope({ jsonrpc: '2.0', id: 1, result: {} }, 200, { 'mcp-session-id': 'U-evil' }),
    })
    const fwd = new StreamableHttpForwarder({ url: 'http://up/mcp' })

    const { response } = await fwd.forward(req({ transportSessionId: 'S1' }))

    expect(response.headers['mcp-session-id']).toBeUndefined()
    expect(response.headers['content-type']).toContain('application/json')
  })

  it('strips the response mcp-session-id on the modern leg (SSE branch)', async () => {
    stubRelayUpstream({
      'server/discover': modernDiscover(),
      'tools/list': () =>
        new Response('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream', 'mcp-session-id': 'U-evil' },
        }),
    })
    const fwd = new StreamableHttpForwarder({ url: 'http://up/mcp' })

    const { response } = await fwd.forward(req({ transportSessionId: 'S1' }))

    expect(response.headers['mcp-session-id']).toBeUndefined()
    expect(response.headers['content-type']).toContain('text/event-stream')
  })

  it('strips the response mcp-session-id on the modern leg (SSE notification sub-branch)', async () => {
    // The id-less notification path copies all upstream headers verbatim
    // and returns before the id-matched SSE read — the strip must cover it
    // too, or a non-conformant modern upstream's session echo would leak
    // through the route allowlist on relayed notifications.
    stubRelayUpstream({
      'server/discover': modernDiscover(),
      'notifications/progress': () =>
        new Response('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/other"}\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream', 'mcp-session-id': 'U-evil' },
        }),
    })
    const fwd = new StreamableHttpForwarder({ url: 'http://up/mcp' })

    const { response } = await fwd.forward(
      req({ id: undefined, method: 'notifications/progress', params: {} }),
    )

    expect(response.headers['mcp-session-id']).toBeUndefined()
    expect(response.headers['content-type']).toContain('text/event-stream')
    expect(response.body).toEqual({ jsonrpc: '2.0' })
  })

  it('heals a misclassified-legacy era via a relayed initialize 404, re-probing only after the window (issue #219)', async () => {
    vi.useFakeTimers()
    let probes = 0
    const calls = stubRelayUpstream({
      'server/discover': (body, headers) => {
        probes += 1
        // A transient non-JSON 200 misclassifies the modern-only upstream
        // as legacy; every later probe answers the truth.
        if (probes === 1) {
          return new Response('warming up', {
            status: 200,
            headers: { 'content-type': 'text/plain' },
          })
        }
        return modernDiscover()(body, headers)
      },
      // The modern-only upstream answers the retired handshake with 404.
      initialize: () => new Response(null, { status: 404 }),
      'tools/list': okResult(),
    })
    const fwd = new StreamableHttpForwarder({ url: 'http://up/mcp' })

    // Probe misclassifies legacy; the relayed initialize is forwarded
    // verbatim and 404s. The failed response still flows to the client.
    const first = await fwd.forward(req({ method: 'initialize', id: 1 }))
    expect(first.response.status).toBe(404)
    expect(callsOf(calls, 'initialize')).toHaveLength(1)

    // The 404 falsified the legacy era: cleared + backoff armed. Relays
    // inside the window presume legacy WITHOUT probing.
    await fwd.forward(req({ method: 'tools/list', transportSessionId: 'S1' }))
    expect(probes).toBe(1)

    // The FIRST relay after the window re-probes and goes modern — all
    // without any internal/establish() traffic.
    vi.advanceTimersByTime(ERA_PROBE_BACKOFF_MS + 1)
    await fwd.forward(req({ method: 'tools/list', transportSessionId: 'S1' }))
    expect(probes).toBe(2)
    const healed = callsOf(calls, 'tools/list')[1]
    expect(healed?.headers['mcp-protocol-version']).toBe('2026-07-28')
    expect(
      ((healed?.body['params'] as Record<string, unknown>)['_meta'] as Record<string, unknown>)[
        'io.modelcontextprotocol/protocolVersion'
      ],
    ).toBe('2026-07-28')
  })

  it('heals a misclassified-legacy era via a modern-only error code on any relayed method (issue #219)', async () => {
    vi.useFakeTimers()
    let probes = 0
    let toolCalls = 0
    const calls = stubRelayUpstream({
      'server/discover': (body, headers) => {
        probes += 1
        if (probes === 1) {
          return new Response('warming up', {
            status: 200,
            headers: { 'content-type': 'text/plain' },
          })
        }
        return modernDiscover()(body, headers)
      },
      'tools/call': () => {
        toolCalls += 1
        if (toolCalls === 1) {
          return jsonEnvelope({
            jsonrpc: '2.0',
            id: 1,
            error: {
              code: -32020,
              message: 'HeaderMismatch: missing MCP-Protocol-Version 2026-07-28',
            },
          })
        }
        return jsonEnvelope({ jsonrpc: '2.0', id: 1, result: {} })
      },
    })
    const fwd = new StreamableHttpForwarder({ url: 'http://up/mcp' })

    // Legacy-presumed relay rejected with a modern-only code: the error
    // still flows to the client, the era clears, the backoff arms.
    const first = await fwd.forward(
      req({ method: 'tools/call', params: { name: 't', arguments: {} } }),
    )
    expect((first.response.body as { error?: { code: number } }).error?.code).toBe(-32020)

    // Inside the window: legacy presumed, no probe.
    await fwd.forward(req({ method: 'tools/list' }))
    expect(probes).toBe(1)

    // After the window: re-probe, modern, and the same call now conforms.
    vi.advanceTimersByTime(ERA_PROBE_BACKOFF_MS + 1)
    await fwd.forward(req({ method: 'tools/call', params: { name: 't', arguments: {} } }))
    expect(probes).toBe(2)
    expect(callsOf(calls, 'tools/call')[1]?.headers['mcp-protocol-version']).toBe('2026-07-28')
  })

  it('refuses a non-header-safe method proxy-side on the modern leg without fetching', async () => {
    const calls = stubRelayUpstream({
      'server/discover': modernDiscover(),
    })
    const fwd = new StreamableHttpForwarder({ url: 'http://up/mcp' })

    await expect(fwd.forward(req({ method: 'héllo' }))).rejects.toThrow(
      /^helio refused to forward: .*Mcp-Method/,
    )
    expect(calls.filter((call) => call.method !== 'server/discover')).toHaveLength(0)
  })

  it('refuses an over-cap name proxy-side on the modern leg without fetching', async () => {
    const calls = stubRelayUpstream({
      'server/discover': modernDiscover(),
    })
    const fwd = new StreamableHttpForwarder({ url: 'http://up/mcp' })

    await expect(
      fwd.forward(
        req({ method: 'resources/read', params: { uri: 'x'.repeat(MCP_NAME_MAX_BYTES + 1) } }),
      ),
    ).rejects.toThrow(/^helio refused to forward: .*Mcp-Name/)
    expect(callsOf(calls, 'resources/read')).toHaveLength(0)
  })

  it('keeps the non-string-name omission an omission on the modern leg', async () => {
    const calls = stubRelayUpstream({
      'server/discover': modernDiscover(),
      'tools/call': okResult(),
    })
    const fwd = new StreamableHttpForwarder({ url: 'http://up/mcp' })

    await fwd.forward(req({ method: 'tools/call', params: { name: 42, arguments: {} } }))

    const relay = callsOf(calls, 'tools/call')[0]
    expect(relay?.headers['mcp-method']).toBe('tools/call')
    expect(relay?.headers['mcp-name']).toBeUndefined()
  })

  it('proceeds legacy end-to-end when the probe fails (per-request presumption)', async () => {
    const calls = stubRelayUpstream({
      'server/discover': () => new Response('unauthorized', { status: 401 }),
      'tools/list': okResult(),
    })
    const fwd = new StreamableHttpForwarder({ url: 'http://up/mcp' })

    const { response } = await fwd.forward(req({ transportSessionId: 'S1' }))

    expect((response.body as { result: unknown }).result).toEqual({})
    const relay = callsOf(calls, 'tools/list')[0]
    expect(relay?.headers['mcp-protocol-version']).toBe('2025-06-18')
    expect(relay?.headers['mcp-session-id']).toBe('S1')
    expect(relay?.body['params']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Legacy-leg parity (issue #219): the full legacy send shape, proven under an
// explicit pin AND under a probe-cached legacy era — by construction, not by
// a generic mock's accidental classification.
// ---------------------------------------------------------------------------

describe('StreamableHttpForwarder legacy-leg parity (issue #219)', () => {
  interface LegacyArm {
    readonly name: string
    readonly build: () => { fwd: StreamableHttpForwarder; calls: RelayCall[] }
    readonly expectedProbes: number
  }

  const arms: LegacyArm[] = [
    {
      name: 'explicit 2025-06-18 pin',
      build: () => {
        const calls = stubRelayUpstream({
          'tools/call': () =>
            jsonEnvelope({ jsonrpc: '2.0', id: 1, result: {} }, 200, { 'mcp-session-id': 'U-1' }),
          initialize: () =>
            jsonEnvelope(
              { jsonrpc: '2.0', id: 9, result: { protocolVersion: '2025-06-18' } },
              200,
              {
                'mcp-session-id': 'U-minted',
              },
            ),
        })
        return {
          fwd: new StreamableHttpForwarder({ url: 'http://up/mcp', protocolVersion: '2025-06-18' }),
          calls,
        }
      },
      expectedProbes: 0,
    },
    {
      name: 'probe-cached legacy era (intentional 202-empty discover)',
      build: () => {
        const calls = stubRelayUpstream({
          // INTENTIONAL legacy classification: the SDK unknown-method shape.
          'server/discover': () => new Response(null, { status: 202 }),
          'tools/call': () =>
            jsonEnvelope({ jsonrpc: '2.0', id: 1, result: {} }, 200, { 'mcp-session-id': 'U-1' }),
          initialize: () =>
            jsonEnvelope(
              { jsonrpc: '2.0', id: 9, result: { protocolVersion: '2025-06-18' } },
              200,
              {
                'mcp-session-id': 'U-minted',
              },
            ),
        })
        return { fwd: new StreamableHttpForwarder({ url: 'http://up/mcp' }), calls }
      },
      expectedProbes: 1,
    },
  ]

  it.each(arms.map((arm) => [arm.name, arm] as const))(
    'sends the full legacy relay shape under %s',
    async (_name, arm) => {
      const { fwd, calls } = arm.build()

      const params = { name: 'get_weather', arguments: { city: 'Berlin' } }
      const { response } = await fwd.forward(
        req({
          method: 'tools/call',
          params,
          transportSessionId: 'S1',
          headers: { 'x-trace': 't1' },
        }),
      )

      const relay = callsOf(calls, 'tools/call')[0]
      expect(relay?.headers['mcp-protocol-version']).toBe('2025-06-18')
      expect(relay?.headers['mcp-session-id']).toBe('S1')
      expect(relay?.headers['mcp-method']).toBe('tools/call')
      expect(relay?.headers['mcp-name']).toBe('get_weather')
      expect(relay?.headers['x-trace']).toBe('t1')
      // Params forwarded verbatim: no _meta injection on the legacy leg.
      expect(relay?.body['params']).toEqual(params)
      // The upstream session echo relays downstream untouched.
      expect(response.headers['mcp-session-id']).toBe('U-1')
      expect(callsOf(calls, 'server/discover')).toHaveLength(arm.expectedProbes)
    },
  )

  it.each(arms.map((arm) => [arm.name, arm] as const))(
    'forwards initialize verbatim with no version stamp under %s',
    async (_name, arm) => {
      const { fwd, calls } = arm.build()

      const { response } = await fwd.forward(
        req({ method: 'initialize', id: 9, params: { protocolVersion: '2025-03-26' } }),
      )

      const relay = callsOf(calls, 'initialize')[0]
      expect(relay?.headers['mcp-protocol-version']).toBeUndefined()
      expect(relay?.headers['mcp-session-id']).toBeUndefined()
      expect(relay?.body['params']).toEqual({ protocolVersion: '2025-03-26' })
      expect(response.headers['mcp-session-id']).toBe('U-minted')
    },
  )
})
