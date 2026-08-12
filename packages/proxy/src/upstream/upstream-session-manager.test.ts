import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { UpstreamSessionManager, ERA_PROBE_BACKOFF_MS } from './upstream-session-manager.js'

const originalFetch = globalThis.fetch
const loggedLines: string[] = []

beforeEach(() => {
  loggedLines.length = 0
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    loggedLines.push(args.map((arg) => String(arg)).join(' '))
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  globalThis.fetch = originalFetch
})

/** The JSON-RPC request body shape the stub recovers from a fetch call. */
interface RecordedBody {
  readonly method: string
  readonly id?: unknown
  readonly params?: { readonly _meta?: Record<string, unknown> }
}

/** One upstream request the stub observed. */
interface UpstreamCall {
  readonly method: string
  readonly headers: Record<string, string>
  readonly body: RecordedBody
}

type UpstreamHandler = (
  body: RecordedBody,
  headers: Record<string, string>,
) => Response | Promise<Response>

/**
 * Stub `fetch` with a JSON-RPC method dispatcher, recording every call.
 * Methods without a handler answer `202`-empty (a real SDK unknown-method
 * shape). A handler that throws simulates a fetch-level failure; a handler
 * returning a promise keeps the request in flight until it settles.
 */
function stubUpstream(handlers: Record<string, UpstreamHandler>): UpstreamCall[] {
  const calls: UpstreamCall[] = []
  globalThis.fetch = (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const raw = typeof init?.body === 'string' ? init.body : '{}'
    const body = JSON.parse(raw) as RecordedBody
    const headers = { ...((init?.headers ?? {}) as Record<string, string>) }
    calls.push({ method: body.method, headers, body })
    const handler = handlers[body.method]
    try {
      return Promise.resolve(handler ? handler(body, headers) : new Response(null, { status: 202 }))
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
  }
  return calls
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function jsonRpcResult(result: Record<string, unknown>, status = 200): Response {
  return jsonResponse({ jsonrpc: '2.0', id: 'helio-era-probe', result }, status)
}

function jsonRpcError(error: Record<string, unknown>, status = 200): Response {
  return jsonResponse({ jsonrpc: '2.0', id: 'helio-era-probe', error }, status)
}

function sseResponse(body: string | ReadableStream<Uint8Array>): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/** A stream that accepts a reader and then never delivers anything. */
function neverClosingStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    pull() {
      return new Promise<void>(() => undefined)
    },
  })
}

/**
 * A stream that delivers more than MAX_SSE_SCAN_BYTES (256 KiB) of SSE
 * comment lines — a leading `:` is valid SSE syntax that `parseSseChunk`
 * ignores — so it never produces a matching envelope. Only the byte cap can
 * end the scan.
 */
function oversizedSseStream(): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const chunk = encoder.encode(':' + 'x'.repeat(64 * 1024) + '\n') // 64 KiB+ per chunk
  const chunkCount = 5 // 5 * 64 KiB > 256 KiB MAX_SSE_SCAN_BYTES
  let sent = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= chunkCount) {
        controller.close()
        return
      }
      controller.enqueue(chunk)
      sent += 1
    },
  })
}

/** A legacy `initialize` responder, optionally minting a session id. */
function legacyInitializeHandler(
  sessionId?: string,
  protocolVersion = '2025-06-18',
): UpstreamHandler {
  return () => {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (sessionId) headers['mcp-session-id'] = sessionId
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 0, result: { protocolVersion } }), {
      status: 200,
      headers,
    })
  }
}

/** A legacy upstream: `server/discover` is unknown, `initialize` works. */
function stubLegacyUpstream(sessionId: string): UpstreamCall[] {
  return stubUpstream({
    'server/discover': () => new Response(null, { status: 202 }),
    initialize: legacyInitializeHandler(sessionId),
  })
}

/** The message of an expected rejection, so several assertions can share it. */
async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('expected the promise to reject')
}

function methodsOf(calls: readonly UpstreamCall[]): string[] {
  return calls.map((call) => call.method)
}

describe('UpstreamSessionManager', () => {
  it('detects a modern server via server/discover and establishes a handshakeless session', async () => {
    const calls = stubUpstream({
      'server/discover': () =>
        jsonRpcResult({
          resultType: 'complete',
          supportedVersions: ['2026-07-28'],
          capabilities: {},
          ttlMs: 3_600_000,
          cacheScope: 'public',
        }),
    })
    const mgr = new UpstreamSessionManager({ url: 'http://up/mcp', staticHeaders: {} })

    const s = await mgr.ensureInternalSession()

    expect(s).toEqual({ sessionId: undefined, protocolVersion: '2026-07-28', era: 'modern' })
    expect(methodsOf(calls)).toEqual(['server/discover']) // no initialize
    const probe = calls[0]
    expect(probe?.headers['mcp-method']).toBe('server/discover')
    expect(probe?.headers['mcp-protocol-version']).toBe('2026-07-28')
    expect(probe?.headers['mcp-session-id']).toBeUndefined()
    expect(probe?.body.params?._meta?.['io.modelcontextprotocol/protocolVersion']).toBe(
      '2026-07-28',
    )
    expect(probe?.body.params?._meta?.['io.modelcontextprotocol/clientCapabilities']).toEqual({})
  })

  it('falls back to initialize when discover gets -32601 over 200 (sessionless legacy)', async () => {
    const calls = stubUpstream({
      'server/discover': () => jsonRpcError({ code: -32601, message: 'Method not found' }),
      initialize: legacyInitializeHandler(undefined, '2025-06-18'),
    })
    const mgr = new UpstreamSessionManager({ url: 'http://up/mcp', staticHeaders: {} })

    const session = await mgr.ensureInternalSession()

    expect(session).toEqual({
      sessionId: undefined,
      protocolVersion: '2025-06-18',
      era: 'legacy',
    })
    expect(methodsOf(calls)).toEqual(['server/discover', 'initialize', 'notifications/initialized'])
  })

  it('falls back to initialize when discover gets 400 with a non-modern body (session-enforcing legacy)', async () => {
    const calls = stubUpstream({
      'server/discover': () =>
        new Response('Bad Request: Missing session ID', {
          status: 400,
          headers: { 'content-type': 'text/plain' },
        }),
      initialize: legacyInitializeHandler('U-session-enforcing'),
    })
    const mgr = new UpstreamSessionManager({ url: 'http://up/mcp', staticHeaders: {} })

    const session = await mgr.ensureInternalSession()

    expect(session).toEqual({
      sessionId: 'U-session-enforcing',
      protocolVersion: '2025-06-18',
      era: 'legacy',
    })
    expect(methodsOf(calls)).toEqual(['server/discover', 'initialize', 'notifications/initialized'])
  })

  it.each([
    [-32020, 'HeaderMismatch: Mcp-Method does not match the request'],
    [-32021, 'MissingRequiredClientCapability: io.modelcontextprotocol/clientCapabilities missing'],
  ])(
    'treats 400 with a modern error body (%i) as modern and does NOT fall back',
    async (code, message) => {
      const calls = stubUpstream({
        'server/discover': () => jsonRpcError({ code, message }, 400),
        initialize: legacyInitializeHandler('U-never-used'),
      })
      const mgr = new UpstreamSessionManager({ url: 'http://up/mcp', staticHeaders: {} })
      const label = message.split(':')[0]

      const rejected = await rejectionMessage(mgr.ensureInternalSession())

      expect(rejected).toContain(String(code))
      expect(rejected).toContain(label)
      expect(methodsOf(calls)).toEqual(['server/discover'])

      // The refusal caches no era: a second call re-probes from scratch rather
      // than reusing a cached conclusion, and still never reaches initialize.
      const secondRejected = await rejectionMessage(mgr.ensureInternalSession())

      expect(secondRejected).toContain(String(code))
      expect(secondRejected).toContain(label)
      expect(methodsOf(calls)).toEqual(['server/discover', 'server/discover'])
    },
  )

  it('tries initialize once when a modern server supports no version Helio speaks', async () => {
    const calls = stubUpstream({
      'server/discover': () =>
        jsonRpcResult({ supportedVersions: ['2027-01-01'], capabilities: {} }),
      initialize: legacyInitializeHandler('U-dual-era'),
    })
    const mgr = new UpstreamSessionManager({ url: 'http://up/mcp', staticHeaders: {} })

    const session = await mgr.ensureInternalSession()

    expect(session).toEqual({
      sessionId: 'U-dual-era',
      protocolVersion: '2025-06-18',
      era: 'legacy',
    })
    expect(methodsOf(calls)).toEqual(['server/discover', 'initialize', 'notifications/initialized'])

    // The same probe against a server with no legacy handshake at all.
    const strictCalls = stubUpstream({
      'server/discover': () =>
        jsonRpcResult({ supportedVersions: ['2027-01-01'], capabilities: {} }),
      initialize: () => new Response('not found', { status: 404 }),
    })
    const strict = new UpstreamSessionManager({ url: 'http://up/mcp', staticHeaders: {} })

    const message = await rejectionMessage(strict.ensureInternalSession())

    expect(message).toContain('2027-01-01')
    expect(message).toContain('2026-07-28')
    expect(message).toContain('HTTP 404')
    expect(strictCalls.filter((call) => call.method === 'initialize')).toHaveLength(1)
  })

  it('runs the dual-era salvage from a -32022 UnsupportedProtocolVersionError', async () => {
    const calls = stubUpstream({
      'server/discover': () =>
        jsonRpcError(
          {
            code: -32022,
            message: 'UnsupportedProtocolVersionError',
            data: { supported: ['2027-01-01'], requested: '2026-07-28' },
          },
          400,
        ),
      initialize: legacyInitializeHandler('U-salvaged'),
    })
    const mgr = new UpstreamSessionManager({ url: 'http://up/mcp', staticHeaders: {} })

    const session = await mgr.ensureInternalSession()

    expect(session).toEqual({
      sessionId: 'U-salvaged',
      protocolVersion: '2025-06-18',
      era: 'legacy',
    })
    expect(methodsOf(calls)).toEqual(['server/discover', 'initialize', 'notifications/initialized'])

    const strictCalls = stubUpstream({
      'server/discover': () =>
        jsonRpcError(
          {
            code: -32022,
            message: 'UnsupportedProtocolVersionError',
            data: { supported: ['2027-01-01'], requested: '2026-07-28' },
          },
          400,
        ),
      initialize: () => new Response('not found', { status: 404 }),
    })
    const strict = new UpstreamSessionManager({ url: 'http://up/mcp', staticHeaders: {} })

    const message = await rejectionMessage(strict.ensureInternalSession())

    expect(message).toContain('2027-01-01')
    expect(message).toContain('2026-07-28')
    expect(strictCalls.filter((call) => call.method === 'initialize')).toHaveLength(1)
  })

  it('makes no era conclusion on 401/timeout — the error propagates and the next call re-probes', async () => {
    let probes = 0
    const calls = stubUpstream({
      'server/discover': () => {
        probes += 1
        if (probes === 1) return new Response('unauthorized', { status: 401 })
        if (probes === 2) {
          const timeoutError = new Error('The operation was aborted due to timeout')
          timeoutError.name = 'TimeoutError'
          throw timeoutError
        }
        return jsonRpcResult({ supportedVersions: ['2026-07-28'], capabilities: {} })
      },
      initialize: legacyInitializeHandler('U-never-used'),
    })
    const mgr = new UpstreamSessionManager({
      url: 'http://up/mcp',
      staticHeaders: {},
      requestTimeoutMs: 1500,
    })

    await expect(mgr.ensureInternalSession()).rejects.toThrow(
      /server\/discover probe failed: HTTP 401/,
    )
    await expect(mgr.ensureInternalSession()).rejects.toThrow(
      /server\/discover probe timed out after 1500ms/,
    )
    await expect(mgr.ensureInternalSession()).resolves.toMatchObject({ era: 'modern' })
    expect(methodsOf(calls)).toEqual(['server/discover', 'server/discover', 'server/discover'])
  })

  it('caches the era and re-probes after invalidateInternalSession()', async () => {
    const calls = stubUpstream({
      'server/discover': () =>
        jsonRpcResult({ supportedVersions: ['2026-07-28'], capabilities: {} }),
    })
    const mgr = new UpstreamSessionManager({ url: 'http://up/mcp', staticHeaders: {} })

    await mgr.ensureInternalSession()
    await mgr.ensureInternalSession()
    expect(calls.filter((call) => call.method === 'server/discover')).toHaveLength(1)

    mgr.invalidateInternalSession()
    await mgr.ensureInternalSession()
    expect(calls.filter((call) => call.method === 'server/discover')).toHaveLength(2)
  })

  it('classifies 200 + a non-modern JSON-RPC error (e.g. -32000) as legacy and initializes', async () => {
    const calls = stubUpstream({
      'server/discover': () => jsonRpcError({ code: -32000, message: 'server not initialized' }),
      initialize: legacyInitializeHandler('U-not-initialized'),
    })
    const mgr = new UpstreamSessionManager({ url: 'http://up/mcp', staticHeaders: {} })

    const session = await mgr.ensureInternalSession()

    expect(session.era).toBe('legacy')
    expect(session.sessionId).toBe('U-not-initialized')
    expect(methodsOf(calls)).toEqual(['server/discover', 'initialize', 'notifications/initialized'])
  })

  it('classifies a 2xx result without supportedVersions as legacy fallback (misrouted endpoint)', async () => {
    const calls = stubUpstream({
      // A JSON-RPC result that is not a DiscoverResult: no supportedVersions.
      'server/discover': () => jsonRpcResult({ serverInfo: { name: 'not-mcp' } }),
      initialize: legacyInitializeHandler('U-misrouted'),
    })
    const mgr = new UpstreamSessionManager({ url: 'http://up/mcp', staticHeaders: {} })

    const session = await mgr.ensureInternalSession()

    expect(session.era).toBe('legacy')
    expect(session.sessionId).toBe('U-misrouted')
    expect(methodsOf(calls)).toEqual(['server/discover', 'initialize', 'notifications/initialized'])
  })

  it('classifies a 2xx body with neither result nor error as legacy fallback (non-MCP endpoint)', async () => {
    const calls = stubUpstream({
      'server/discover': () => jsonResponse({ status: 'ok', service: 'not-mcp' }),
      initialize: legacyInitializeHandler('U-non-mcp'),
    })
    const mgr = new UpstreamSessionManager({ url: 'http://up/mcp', staticHeaders: {} })

    const session = await mgr.ensureInternalSession()

    expect(session.era).toBe('legacy')
    expect(session.sessionId).toBe('U-non-mcp')
    expect(methodsOf(calls)).toEqual(['server/discover', 'initialize', 'notifications/initialized'])
  })

  it('classifies a 202-empty probe response as legacy fallback (SDK unknown-method shape)', async () => {
    const calls = stubUpstream({
      'server/discover': () => new Response(null, { status: 202 }),
      initialize: legacyInitializeHandler('U-202-empty'),
    })
    const mgr = new UpstreamSessionManager({ url: 'http://up/mcp', staticHeaders: {} })

    const session = await mgr.ensureInternalSession()

    expect(session.era).toBe('legacy')
    expect(session.sessionId).toBe('U-202-empty')
    expect(methodsOf(calls)).toEqual(['server/discover', 'initialize', 'notifications/initialized'])
  })

  it('detects modern from an SSE-framed server/discover response', async () => {
    const calls = stubUpstream({
      'server/discover': () =>
        sseResponse(
          'event: message\ndata: ' +
            JSON.stringify({
              jsonrpc: '2.0',
              id: 'helio-era-probe',
              result: { supportedVersions: ['2026-07-28'], capabilities: {} },
            }) +
            '\n\n',
        ),
      initialize: legacyInitializeHandler('U-never-used'),
    })
    const mgr = new UpstreamSessionManager({ url: 'http://up/mcp', staticHeaders: {} })

    const session = await mgr.ensureInternalSession()

    expect(session).toEqual({ sessionId: undefined, protocolVersion: '2026-07-28', era: 'modern' })
    expect(methodsOf(calls)).toEqual(['server/discover'])
  })

  it('classifies an SSE stream that closes without a matching envelope as legacy fallback', async () => {
    const calls = stubUpstream({
      'server/discover': () =>
        sseResponse('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/message"}\n\n'),
      initialize: legacyInitializeHandler('U-sse-closed'),
    })
    const mgr = new UpstreamSessionManager({ url: 'http://up/mcp', staticHeaders: {} })

    const session = await mgr.ensureInternalSession()

    expect(session.era).toBe('legacy')
    expect(session.sessionId).toBe('U-sse-closed')
    expect(methodsOf(calls)).toEqual(['server/discover', 'initialize', 'notifications/initialized'])
  })

  it('treats a stalled SSE probe body as no era conclusion, rejecting within requestTimeoutMs', async () => {
    const calls = stubUpstream({
      'server/discover': () => sseResponse(neverClosingStream()),
      initialize: legacyInitializeHandler('U-never-used'),
    })
    const mgr = new UpstreamSessionManager({
      url: 'http://up/mcp',
      staticHeaders: {},
      requestTimeoutMs: 50,
    })

    await expect(mgr.ensureInternalSession()).rejects.toThrow(
      /server\/discover probe SSE response timed out after 50ms/,
    )
    expect(methodsOf(calls)).toEqual(['server/discover'])

    // No era was cached, so the next call re-probes rather than assuming legacy.
    await expect(mgr.ensureInternalSession()).rejects.toThrow(/server\/discover probe/)
    expect(methodsOf(calls)).toEqual(['server/discover', 'server/discover'])
  })

  it('treats an SSE probe body exceeding the byte cap as no era conclusion, rejecting and re-probing', async () => {
    const calls = stubUpstream({
      'server/discover': () => sseResponse(oversizedSseStream()),
      initialize: legacyInitializeHandler('U-never-used'),
    })
    const mgr = new UpstreamSessionManager({ url: 'http://up/mcp', staticHeaders: {} })

    const message = await rejectionMessage(mgr.ensureInternalSession())

    expect(message).toContain('exceeded')
    expect(message).toContain('262144')
    expect(methodsOf(calls)).toEqual(['server/discover']) // no initialize

    // No era was cached, so the next call re-probes rather than assuming legacy.
    const secondMessage = await rejectionMessage(mgr.ensureInternalSession())

    expect(secondMessage).toContain('exceeded')
    expect(methodsOf(calls)).toEqual(['server/discover', 'server/discover'])
  })

  it('logs one era-detected line per probe conclusion', async () => {
    stubUpstream({
      'server/discover': () =>
        jsonRpcResult({ supportedVersions: ['2026-07-28'], capabilities: {} }),
    })
    const modern = new UpstreamSessionManager({ url: 'http://up/mcp', staticHeaders: {} })

    await modern.ensureInternalSession()
    await modern.ensureInternalSession()

    expect(
      loggedLines.filter((line) =>
        /Upstream MCP era detected: modern \(2026-07-28, via server\/discover\)/.test(line),
      ),
    ).toHaveLength(1)

    stubLegacyUpstream('U-logged')
    const legacy = new UpstreamSessionManager({ url: 'http://up/mcp', staticHeaders: {} })

    await legacy.ensureInternalSession()

    expect(
      loggedLines.filter((line) =>
        /Upstream MCP era detected: legacy \(initialize handshake\)/.test(line),
      ),
    ).toHaveLength(1)
  })

  it('initializes once and persists the upstream session id', async () => {
    const calls = stubLegacyUpstream('U-123')
    const mgr = new UpstreamSessionManager({ url: 'http://up/mcp', staticHeaders: {} })

    const s1 = await mgr.ensureInternalSession()
    const s2 = await mgr.ensureInternalSession()

    expect(s1.sessionId).toBe('U-123')
    expect(s2.sessionId).toBe('U-123')
    expect(methodsOf(calls)).toEqual(['server/discover', 'initialize', 'notifications/initialized'])
  })

  it('coalesces concurrent first callers onto a single initialize', async () => {
    const calls = stubLegacyUpstream('U-Coalesce')
    const mgr = new UpstreamSessionManager({ url: 'http://up/mcp', staticHeaders: {} })

    const [s1, s2] = await Promise.all([mgr.ensureInternalSession(), mgr.ensureInternalSession()])

    expect(s1.sessionId).toBe('U-Coalesce')
    expect(s2.sessionId).toBe('U-Coalesce')
    expect(calls.filter((call) => call.method === 'server/discover')).toHaveLength(1)
    expect(calls.filter((call) => call.method === 'initialize')).toHaveLength(1)
  })

  it('stores negotiated protocol version and uses it for notifications/initialized', async () => {
    const calls = stubUpstream({
      'server/discover': () => new Response(null, { status: 202 }),
      initialize: legacyInitializeHandler('U-negotiated', '2025-03-26'),
    })
    const mgr = new UpstreamSessionManager({ url: 'http://up/mcp', staticHeaders: {} })

    const session = await mgr.ensureInternalSession()

    expect(session.protocolVersion).toBe('2025-03-26')
    expect(
      calls
        .filter((call) => call.method === 'notifications/initialized')
        .map((call) => call.headers['mcp-protocol-version']),
    ).toEqual(['2025-03-26'])
  })

  // -------------------------------------------------------------------------
  // Standard header ownership (issue #217) — staticHeaders win the merge in
  // both call sites below, so a lying constructor value would otherwise
  // override the truthful header Helio owns.
  // -------------------------------------------------------------------------

  it('era probe POST carries the truthful mcp-method even with lying staticHeaders', async () => {
    const calls = stubUpstream({
      'server/discover': () =>
        jsonRpcResult({ supportedVersions: ['2026-07-28'], capabilities: {} }),
    })
    const mgr = new UpstreamSessionManager({
      url: 'http://up/mcp',
      staticHeaders: { 'mcp-method': 'lie', 'mcp-name': 'lie' },
    })

    await mgr.ensureInternalSession()

    const probe = calls.filter((call) => call.method === 'server/discover')
    expect(probe.map((call) => call.headers['mcp-method'])).toEqual(['server/discover'])
    expect(probe[0]?.headers['mcp-name']).toBeUndefined()
  })

  it('legacy initialize and notifications/initialized carry neither mcp-method nor mcp-name, even with lying staticHeaders', async () => {
    const calls = stubUpstream({
      'server/discover': () => new Response(null, { status: 202 }),
      initialize: legacyInitializeHandler('U-lying-headers'),
    })
    const mgr = new UpstreamSessionManager({
      url: 'http://up/mcp',
      staticHeaders: { 'mcp-method': 'lie', 'mcp-name': 'lie' },
    })

    await mgr.ensureInternalSession()

    for (const method of ['initialize', 'notifications/initialized']) {
      const call = calls.find((c) => c.method === method)
      expect(call?.headers['mcp-method']).toBeUndefined()
      expect(call?.headers['mcp-name']).toBeUndefined()
    }
  })

  it('reports a timeout with the configured duration when initialize times out', async () => {
    stubUpstream({
      'server/discover': () => new Response(null, { status: 202 }),
      initialize: () => {
        const timeoutError = new Error('The operation was aborted due to timeout')
        timeoutError.name = 'TimeoutError'
        throw timeoutError
      },
    })

    const mgr = new UpstreamSessionManager({
      url: 'http://up/mcp',
      staticHeaders: {},
      requestTimeoutMs: 1234,
    })
    await expect(mgr.ensureInternalSession()).rejects.toThrow(/initialize timed out after 1234ms/)
  })

  it('re-initializes after the session is invalidated', async () => {
    const calls = stubLegacyUpstream('U-456')
    const mgr = new UpstreamSessionManager({ url: 'http://up/mcp', staticHeaders: {} })

    await mgr.ensureInternalSession()
    mgr.invalidateInternalSession()
    await mgr.ensureInternalSession()

    expect(calls.filter((call) => call.method === 'initialize')).toHaveLength(2)
  })

  it('clears inflight after initialize failure so a later call can retry', async () => {
    let initializes = 0
    const calls = stubUpstream({
      'server/discover': () => new Response(null, { status: 202 }),
      initialize: (body, headers) => {
        initializes += 1
        if (initializes === 1) return new Response('boom', { status: 500 })
        return legacyInitializeHandler('U-Retry')(body, headers)
      },
    })

    const mgr = new UpstreamSessionManager({ url: 'http://up/mcp', staticHeaders: {} })
    await expect(mgr.ensureInternalSession()).rejects.toThrow(/initialize failed/i)
    await expect(mgr.ensureInternalSession()).resolves.toMatchObject({ sessionId: 'U-Retry' })
    // The failed initialize cached no era, so the retry re-probes.
    expect(calls.filter((call) => call.method === 'server/discover')).toHaveLength(2)
  })

  it('fails initialization when initialize returns HTTP 200 with JSON-RPC error', async () => {
    let initializes = 0
    stubUpstream({
      'server/discover': () => new Response(null, { status: 202 }),
      initialize: (body, headers) => {
        initializes += 1
        if (initializes === 1) {
          return jsonResponse({
            jsonrpc: '2.0',
            id: 0,
            error: { code: -32000, message: 'session bootstrap denied' },
          })
        }
        return legacyInitializeHandler('U-AfterError')(body, headers)
      },
    })

    const mgr = new UpstreamSessionManager({ url: 'http://up/mcp', staticHeaders: {} })
    await expect(mgr.ensureInternalSession()).rejects.toThrow(/initialize returned JSON-RPC error/i)
    await expect(mgr.ensureInternalSession()).resolves.toMatchObject({ sessionId: 'U-AfterError' })
    expect(initializes).toBe(2)
  })

  it('fails initialization when notifications/initialized fails', async () => {
    stubUpstream({
      'server/discover': () => new Response(null, { status: 202 }),
      initialize: legacyInitializeHandler('U-1'),
      'notifications/initialized': () => new Response('nope', { status: 500 }),
    })

    const mgr = new UpstreamSessionManager({ url: 'http://up/mcp', staticHeaders: {} })
    await expect(mgr.ensureInternalSession()).rejects.toThrow(/notifications\/initialized failed/i)
  })

  it('fails initialization when notifications/initialized returns JSON-RPC error', async () => {
    stubUpstream({
      'server/discover': () => new Response(null, { status: 202 }),
      initialize: legacyInitializeHandler('U-1'),
      'notifications/initialized': () =>
        jsonResponse({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'notification rejected' },
        }),
    })

    const mgr = new UpstreamSessionManager({ url: 'http://up/mcp', staticHeaders: {} })
    await expect(mgr.ensureInternalSession()).rejects.toThrow(
      /notifications\/initialized returned JSON-RPC error/i,
    )
  })

  it('fails initialization when notifications/initialized SSE stream contains a JSON-RPC error', async () => {
    stubUpstream({
      'server/discover': () => new Response(null, { status: 202 }),
      initialize: legacyInitializeHandler('U-1'),
      'notifications/initialized': () =>
        sseResponse(
          'event: message\ndata: {"jsonrpc":"2.0","error":{"code":-32000,"message":"sse rejected"}}\n\n',
        ),
    })

    const mgr = new UpstreamSessionManager({ url: 'http://up/mcp', staticHeaders: {} })
    await expect(mgr.ensureInternalSession()).rejects.toThrow(
      /notifications\/initialized returned JSON-RPC error: sse rejected/i,
    )
  })

  it('times out when notifications/initialized SSE stream never closes', async () => {
    stubUpstream({
      'server/discover': () => new Response(null, { status: 202 }),
      initialize: legacyInitializeHandler('U-1'),
      'notifications/initialized': () => sseResponse(neverClosingStream()),
    })

    const mgr = new UpstreamSessionManager({
      url: 'http://up/mcp',
      staticHeaders: {},
      requestTimeoutMs: 25,
    })
    await expect(mgr.ensureInternalSession()).rejects.toThrow(
      /notifications\/initialized SSE response timed out after 25ms/i,
    )
  })
})

// ---------------------------------------------------------------------------
// Relay era resolution (issue #219): pins, resolveRelayEra(), the two-sided
// re-probe rule, and the probe-time DiscoverResult capture.
// ---------------------------------------------------------------------------

/** A resolvable/rejectable gate for holding a probe in flight. */
function deferredResponse() {
  let resolve!: (value: Response) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<Response>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function modernDiscoverHandler(extra: Record<string, unknown> = {}): UpstreamHandler {
  return () =>
    jsonRpcResult({
      resultType: 'complete',
      supportedVersions: ['2026-07-28'],
      capabilities: {},
      ttlMs: 3_600_000,
      cacheScope: 'public',
      ...extra,
    })
}

function discoverCallsOf(calls: readonly UpstreamCall[]): UpstreamCall[] {
  return calls.filter((call) => call.method === 'server/discover')
}

function eraClearedLines(): string[] {
  return loggedLines.filter((line) => /Upstream MCP era cleared/.test(line))
}

describe('UpstreamSessionManager relay era resolution (issue #219)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('pinned modern skips the probe in establish() and mints the handshakeless session', async () => {
    const calls = stubUpstream({})
    const mgr = new UpstreamSessionManager({
      url: 'http://up/mcp',
      staticHeaders: {},
      protocolVersion: '2026-07-28',
    })

    const session = await mgr.ensureInternalSession()

    expect(session).toEqual({ sessionId: undefined, protocolVersion: '2026-07-28', era: 'modern' })
    expect(calls).toHaveLength(0)
    expect(loggedLines.filter((line) => /era detected/.test(line))).toHaveLength(0)
  })

  it('pinned legacy skips the probe in establish() and goes straight to initialize', async () => {
    const calls = stubUpstream({ initialize: legacyInitializeHandler('U-pinned') })
    const mgr = new UpstreamSessionManager({
      url: 'http://up/mcp',
      staticHeaders: {},
      protocolVersion: '2025-06-18',
    })

    const session = await mgr.ensureInternalSession()

    expect(session).toEqual({ sessionId: 'U-pinned', protocolVersion: '2025-06-18', era: 'legacy' })
    expect(methodsOf(calls)).toEqual(['initialize', 'notifications/initialized'])
    expect(loggedLines.filter((line) => /era detected/.test(line))).toHaveLength(0)
  })

  it.each([
    ['2026-07-28', 'modern'],
    ['2025-06-18', 'legacy'],
  ] as const)('resolveRelayEra() returns the %s pin without probing', async (pin, era) => {
    const calls = stubUpstream({})
    const mgr = new UpstreamSessionManager({
      url: 'http://up/mcp',
      staticHeaders: {},
      protocolVersion: pin,
    })

    await expect(mgr.resolveRelayEra()).resolves.toBe(era)

    expect(calls).toHaveLength(0)
  })

  it('probes once, caches modern, and returns the cached era on later calls', async () => {
    const calls = stubUpstream({ 'server/discover': modernDiscoverHandler() })
    const mgr = new UpstreamSessionManager({ url: 'http://up/mcp', staticHeaders: {} })

    await expect(mgr.resolveRelayEra()).resolves.toBe('modern')
    await expect(mgr.resolveRelayEra()).resolves.toBe('modern')

    expect(methodsOf(calls)).toEqual(['server/discover'])
  })

  it('caches legacy from probe classification alone, never running initialize', async () => {
    const calls = stubUpstream({
      'server/discover': () => new Response(null, { status: 202 }),
      initialize: legacyInitializeHandler('U-never-used'),
    })
    const mgr = new UpstreamSessionManager({ url: 'http://up/mcp', staticHeaders: {} })

    await expect(mgr.resolveRelayEra()).resolves.toBe('legacy')
    await expect(mgr.resolveRelayEra()).resolves.toBe('legacy')

    expect(methodsOf(calls)).toEqual(['server/discover'])
  })

  it('caches legacy from the -32022 salvage classification (action semantics)', async () => {
    const calls = stubUpstream({
      'server/discover': () =>
        jsonRpcError(
          {
            code: -32022,
            message: 'UnsupportedProtocolVersionError',
            data: { supported: ['2027-01-01'], requested: '2026-07-28' },
          },
          400,
        ),
    })
    const mgr = new UpstreamSessionManager({ url: 'http://up/mcp', staticHeaders: {} })

    await expect(mgr.resolveRelayEra()).resolves.toBe('legacy')
    await expect(mgr.resolveRelayEra()).resolves.toBe('legacy')

    expect(methodsOf(calls)).toEqual(['server/discover'])
  })

  it('shares one in-flight probe between resolveRelayEra() and establish()', async () => {
    const calls = stubUpstream({ 'server/discover': modernDiscoverHandler() })
    const mgr = new UpstreamSessionManager({ url: 'http://up/mcp', staticHeaders: {} })

    const [era, session] = await Promise.all([mgr.resolveRelayEra(), mgr.ensureInternalSession()])

    expect(era).toBe('modern')
    expect(session.era).toBe('modern')
    expect(methodsOf(calls)).toEqual(['server/discover'])
    expect(loggedLines.filter((line) => /era detected: modern/.test(line))).toHaveLength(1)
  })

  it('coalesces concurrent relay callers onto a single probe', async () => {
    const calls = stubUpstream({ 'server/discover': modernDiscoverHandler() })
    const mgr = new UpstreamSessionManager({ url: 'http://up/mcp', staticHeaders: {} })

    const eras = await Promise.all([
      mgr.resolveRelayEra(),
      mgr.resolveRelayEra(),
      mgr.resolveRelayEra(),
    ])

    expect(eras).toEqual(['modern', 'modern', 'modern'])
    expect(methodsOf(calls)).toEqual(['server/discover'])
  })

  it('presumes legacy on probe failure, caches nothing, and heals on the first relay after the window', async () => {
    vi.useFakeTimers()
    let probes = 0
    const calls = stubUpstream({
      'server/discover': (body, headers) => {
        probes += 1
        if (probes === 1) return new Response('unauthorized', { status: 401 })
        return modernDiscoverHandler()(body, headers)
      },
    })
    const mgr = new UpstreamSessionManager({ url: 'http://up/mcp', staticHeaders: {} })

    await expect(mgr.resolveRelayEra()).resolves.toBe('legacy')

    // Inside the window relays presume legacy without waiting or probing.
    vi.advanceTimersByTime(ERA_PROBE_BACKOFF_MS - 1)
    await expect(mgr.resolveRelayEra()).resolves.toBe('legacy')
    expect(discoverCallsOf(calls)).toHaveLength(1)

    // The FIRST relay after the window re-probes: heal latency <= the window.
    vi.advanceTimersByTime(2)
    await expect(mgr.resolveRelayEra()).resolves.toBe('modern')
    expect(discoverCallsOf(calls)).toHaveLength(2)
  })

  it('treats a modern-refusal probe (-32020) as probe failure on the relay path: legacy presumed, backoff armed', async () => {
    vi.useFakeTimers()
    const calls = stubUpstream({
      'server/discover': () => jsonRpcError({ code: -32020, message: 'HeaderMismatch' }, 400),
    })
    const mgr = new UpstreamSessionManager({ url: 'http://up/mcp', staticHeaders: {} })

    await expect(mgr.resolveRelayEra()).resolves.toBe('legacy')
    await expect(mgr.resolveRelayEra()).resolves.toBe('legacy')
    expect(discoverCallsOf(calls)).toHaveLength(1)

    vi.advanceTimersByTime(ERA_PROBE_BACKOFF_MS + 1)
    await expect(mgr.resolveRelayEra()).resolves.toBe('legacy')
    expect(discoverCallsOf(calls)).toHaveLength(2)
  })

  it('joins an in-flight probe after backoff expiry instead of presuming legacy alongside it (R1 F2)', async () => {
    vi.useFakeTimers()
    const gate = deferredResponse()
    let probes = 0
    const calls = stubUpstream({
      'server/discover': () => {
        probes += 1
        if (probes === 1) return new Response('unauthorized', { status: 401 })
        return gate.promise
      },
    })
    const mgr = new UpstreamSessionManager({ url: 'http://up/mcp', staticHeaders: {} })

    await expect(mgr.resolveRelayEra()).resolves.toBe('legacy') // arms the backoff
    vi.advanceTimersByTime(ERA_PROBE_BACKOFF_MS + 1)

    const starter = mgr.resolveRelayEra() // starts probe 2, held in flight
    const joiner = mgr.resolveRelayEra() // must JOIN it, not presume legacy
    gate.resolve(
      jsonResponse({
        jsonrpc: '2.0',
        id: 'helio-era-probe',
        result: { supportedVersions: ['2026-07-28'], capabilities: {} },
      }),
    )

    await expect(starter).resolves.toBe('modern')
    await expect(joiner).resolves.toBe('modern')
    expect(discoverCallsOf(calls)).toHaveLength(2)
  })

  it('join-on-throw returns the legacy presumption and never starts a second probe (R2 F3)', async () => {
    const gate = deferredResponse()
    const calls = stubUpstream({
      'server/discover': () => gate.promise,
    })
    const mgr = new UpstreamSessionManager({ url: 'http://up/mcp', staticHeaders: {} })

    const starter = mgr.resolveRelayEra()
    const joiner = mgr.resolveRelayEra()
    gate.reject(new Error('socket hang up'))

    await expect(starter).resolves.toBe('legacy')
    await expect(joiner).resolves.toBe('legacy')
    expect(discoverCallsOf(calls)).toHaveLength(1)

    // The shared attempt's failure armed the backoff for later callers too.
    await expect(mgr.resolveRelayEra()).resolves.toBe('legacy')
    expect(discoverCallsOf(calls)).toHaveLength(1)
  })

  it('clears the era and arms the backoff when the legacy fast path initialize fails, throttling the relay-driven loop to the window (R4 F1)', async () => {
    vi.useFakeTimers()
    const calls = stubUpstream({
      'server/discover': () => new Response(null, { status: 202 }),
      initialize: () => new Response('boom', { status: 500 }),
    })
    const mgr = new UpstreamSessionManager({ url: 'http://up/mcp', staticHeaders: {} })

    // A relay probe caches legacy without a proven initialize...
    await expect(mgr.resolveRelayEra()).resolves.toBe('legacy')
    expect(methodsOf(calls)).toEqual(['server/discover'])

    // ...the cached era feeds establish()'s fast path (no re-probe), whose
    // initialize fails: the internal door clears AND arms.
    await expect(mgr.ensureInternalSession()).rejects.toThrow(/initialize failed/)
    expect(methodsOf(calls)).toEqual(['server/discover', 'initialize'])
    expect(eraClearedLines()).toHaveLength(1)

    // Relays inside the window presume legacy WITHOUT probing: the loop is
    // throttled to the window, not the relay request rate.
    await expect(mgr.resolveRelayEra()).resolves.toBe('legacy')
    await expect(mgr.resolveRelayEra()).resolves.toBe('legacy')
    expect(methodsOf(calls)).toEqual(['server/discover', 'initialize'])

    // establish() alone stays backoff-free: the prime cadence may probe
    // within the window.
    await expect(mgr.ensureInternalSession()).rejects.toThrow(/initialize failed/)
    expect(methodsOf(calls)).toEqual([
      'server/discover',
      'initialize',
      'server/discover',
      'initialize',
    ])

    // The FIRST relay after the window re-probes.
    vi.advanceTimersByTime(ERA_PROBE_BACKOFF_MS + 1)
    await expect(mgr.resolveRelayEra()).resolves.toBe('legacy')
    expect(discoverCallsOf(calls)).toHaveLength(3)
  })

  it('falsification clears cached legacy, arms the backoff, and throttles even a successful re-probe (R2 F2)', async () => {
    vi.useFakeTimers()
    const calls = stubUpstream({
      'server/discover': () => new Response(null, { status: 202 }),
    })
    const mgr = new UpstreamSessionManager({ url: 'http://up/mcp', staticHeaders: {} })

    await expect(mgr.resolveRelayEra()).resolves.toBe('legacy')
    expect(discoverCallsOf(calls)).toHaveLength(1)

    mgr.clearFalsifiedLegacyEra('relayed initialize was answered with HTTP 404')
    expect(eraClearedLines()).toHaveLength(1)
    expect(eraClearedLines()[0]).toContain('relayed initialize was answered with HTTP 404')

    // Falsify -> re-probe is throttled to the window, NOT every-request.
    await expect(mgr.resolveRelayEra()).resolves.toBe('legacy')
    await expect(mgr.resolveRelayEra()).resolves.toBe('legacy')
    expect(discoverCallsOf(calls)).toHaveLength(1)

    // After the window one successful re-probe re-caches...
    vi.advanceTimersByTime(ERA_PROBE_BACKOFF_MS + 1)
    await expect(mgr.resolveRelayEra()).resolves.toBe('legacy')
    await expect(mgr.resolveRelayEra()).resolves.toBe('legacy')
    expect(discoverCallsOf(calls)).toHaveLength(2)

    // ...and a second falsification restarts the throttled cycle.
    mgr.clearFalsifiedLegacyEra('relayed response carried modern-only JSON-RPC error -32020')
    await expect(mgr.resolveRelayEra()).resolves.toBe('legacy')
    expect(discoverCallsOf(calls)).toHaveLength(2)
    expect(eraClearedLines()).toHaveLength(2)
  })

  it('falsification no-ops on a cached modern era', async () => {
    const calls = stubUpstream({ 'server/discover': modernDiscoverHandler() })
    const mgr = new UpstreamSessionManager({ url: 'http://up/mcp', staticHeaders: {} })

    await expect(mgr.resolveRelayEra()).resolves.toBe('modern')
    mgr.clearFalsifiedLegacyEra('should never clear modern')

    expect(eraClearedLines()).toHaveLength(0)
    await expect(mgr.resolveRelayEra()).resolves.toBe('modern')
    expect(discoverCallsOf(calls)).toHaveLength(1)
  })

  it('falsification no-ops on an uncached era and arms nothing', async () => {
    const calls = stubUpstream({ 'server/discover': modernDiscoverHandler() })
    const mgr = new UpstreamSessionManager({ url: 'http://up/mcp', staticHeaders: {} })

    mgr.clearFalsifiedLegacyEra('nothing cached yet')

    expect(eraClearedLines()).toHaveLength(0)
    // Nothing was armed: the next relay probes immediately.
    await expect(mgr.resolveRelayEra()).resolves.toBe('modern')
    expect(discoverCallsOf(calls)).toHaveLength(1)
  })

  it('falsification no-ops under a pin', async () => {
    const calls = stubUpstream({})
    const mgr = new UpstreamSessionManager({
      url: 'http://up/mcp',
      staticHeaders: {},
      protocolVersion: '2025-06-18',
    })

    mgr.clearFalsifiedLegacyEra('pins are never cleared')

    expect(eraClearedLines()).toHaveLength(0)
    await expect(mgr.resolveRelayEra()).resolves.toBe('legacy')
    expect(calls).toHaveLength(0)
  })

  it('captures DiscoverResult capabilities and instructions on modern classification', async () => {
    stubUpstream({
      'server/discover': modernDiscoverHandler({
        capabilities: { tools: {}, prompts: {} },
        instructions: 'Use the search tool before the fetch tool.',
      }),
    })
    const mgr = new UpstreamSessionManager({ url: 'http://up/mcp', staticHeaders: {} })

    await expect(mgr.resolveRelayEra()).resolves.toBe('modern')

    expect(mgr.getDiscoverCapture()).toEqual({
      capabilities: { tools: {}, prompts: {} },
      instructions: 'Use the search tool before the fetch tool.',
    })
  })

  it('leaves the capture fields empty when the fresh DiscoverResult lacks them', async () => {
    stubUpstream({
      'server/discover': () => jsonRpcResult({ supportedVersions: ['2026-07-28'] }),
    })
    const mgr = new UpstreamSessionManager({ url: 'http://up/mcp', staticHeaders: {} })

    await expect(mgr.resolveRelayEra()).resolves.toBe('modern')

    expect(mgr.getDiscoverCapture()).toEqual({ capabilities: undefined, instructions: undefined })
  })

  it('holds no capture under a modern pin', async () => {
    stubUpstream({})
    const mgr = new UpstreamSessionManager({
      url: 'http://up/mcp',
      staticHeaders: {},
      protocolVersion: '2026-07-28',
    })

    await expect(mgr.resolveRelayEra()).resolves.toBe('modern')
    await mgr.ensureInternalSession()

    expect(mgr.getDiscoverCapture()).toBeUndefined()
  })

  it('invalidateInternalSession() drops the capture without arming the backoff (R5 N2)', async () => {
    const calls = stubUpstream({
      'server/discover': modernDiscoverHandler({ instructions: 'be gentle' }),
    })
    const mgr = new UpstreamSessionManager({ url: 'http://up/mcp', staticHeaders: {} })

    await expect(mgr.resolveRelayEra()).resolves.toBe('modern')
    expect(mgr.getDiscoverCapture()).toBeDefined()

    mgr.invalidateInternalSession()

    expect(mgr.getDiscoverCapture()).toBeUndefined()
    expect(eraClearedLines()).toHaveLength(0)
    // Invalidation is session lifecycle, not falsification: no backoff, the
    // next relay re-probes (and re-captures) immediately.
    await expect(mgr.resolveRelayEra()).resolves.toBe('modern')
    expect(discoverCallsOf(calls)).toHaveLength(2)
    expect(mgr.getDiscoverCapture()).toEqual({ capabilities: {}, instructions: 'be gentle' })
  })
})
