import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { UpstreamSessionManager } from './upstream-session-manager.js'

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

type UpstreamHandler = (body: RecordedBody, headers: Record<string, string>) => Response

/**
 * Stub `fetch` with a JSON-RPC method dispatcher, recording every call.
 * Methods without a handler answer `202`-empty (a real SDK unknown-method
 * shape). A handler that throws simulates a fetch-level failure.
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
