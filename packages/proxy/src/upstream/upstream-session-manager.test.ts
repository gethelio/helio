import { describe, it, expect, afterEach } from 'vitest'
import { UpstreamSessionManager } from './upstream-session-manager.js'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

function stubInitialize(sessionId: string): string[] {
  const methods: string[] = []
  globalThis.fetch = (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const raw = typeof init?.body === 'string' ? init.body : '{}'
    const body = JSON.parse(raw) as { method: string }
    methods.push(body.method)
    if (body.method === 'initialize') {
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
    return Promise.resolve(new Response(null, { status: 202 }))
  }
  return methods
}

describe('UpstreamSessionManager', () => {
  it('initializes once and persists the upstream session id', async () => {
    const methods = stubInitialize('U-123')
    const mgr = new UpstreamSessionManager({ url: 'http://up/mcp', staticHeaders: {} })

    const s1 = await mgr.ensureInternalSession()
    const s2 = await mgr.ensureInternalSession()

    expect(s1.sessionId).toBe('U-123')
    expect(s2.sessionId).toBe('U-123')
    expect(methods).toEqual(['initialize', 'notifications/initialized'])
  })

  it('coalesces concurrent first callers onto a single initialize', async () => {
    const methods = stubInitialize('U-Coalesce')
    const mgr = new UpstreamSessionManager({ url: 'http://up/mcp', staticHeaders: {} })

    const [s1, s2] = await Promise.all([mgr.ensureInternalSession(), mgr.ensureInternalSession()])

    expect(s1.sessionId).toBe('U-Coalesce')
    expect(s2.sessionId).toBe('U-Coalesce')
    expect(methods.filter((m) => m === 'initialize')).toHaveLength(1)
  })

  it('reports a timeout with the configured duration when initialize times out', async () => {
    globalThis.fetch = (): Promise<Response> => {
      const timeoutError = new Error('The operation was aborted due to timeout')
      timeoutError.name = 'TimeoutError'
      return Promise.reject(timeoutError)
    }

    const mgr = new UpstreamSessionManager({
      url: 'http://up/mcp',
      staticHeaders: {},
      requestTimeoutMs: 1234,
    })
    await expect(mgr.ensureInternalSession()).rejects.toThrow(/initialize timed out after 1234ms/)
  })

  it('re-initializes after the session is invalidated', async () => {
    const methods = stubInitialize('U-456')
    const mgr = new UpstreamSessionManager({ url: 'http://up/mcp', staticHeaders: {} })

    await mgr.ensureInternalSession()
    mgr.invalidateInternalSession()
    await mgr.ensureInternalSession()

    expect(methods.filter((m) => m === 'initialize')).toHaveLength(2)
  })

  it('clears inflight after initialize failure so a later call can retry', async () => {
    let calls = 0
    globalThis.fetch = (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const raw = typeof init?.body === 'string' ? init.body : '{}'
      const body = JSON.parse(raw) as { method: string }
      if (body.method === 'initialize') {
        calls += 1
        if (calls === 1) {
          return Promise.resolve(new Response('boom', { status: 500 }))
        }
        return Promise.resolve(
          new Response(JSON.stringify({ jsonrpc: '2.0', id: 0, result: {} }), {
            status: 200,
            headers: { 'content-type': 'application/json', 'mcp-session-id': 'U-Retry' },
          }),
        )
      }
      return Promise.resolve(new Response(null, { status: 202 }))
    }

    const mgr = new UpstreamSessionManager({ url: 'http://up/mcp', staticHeaders: {} })
    await expect(mgr.ensureInternalSession()).rejects.toThrow(/initialize failed/i)
    await expect(mgr.ensureInternalSession()).resolves.toMatchObject({ sessionId: 'U-Retry' })
  })

  it('fails initialization when notifications/initialized fails', async () => {
    globalThis.fetch = (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const raw = typeof init?.body === 'string' ? init.body : '{}'
      const body = JSON.parse(raw) as { method: string }
      if (body.method === 'initialize') {
        return Promise.resolve(
          new Response(JSON.stringify({ jsonrpc: '2.0', id: 0, result: {} }), {
            status: 200,
            headers: { 'content-type': 'application/json', 'mcp-session-id': 'U-1' },
          }),
        )
      }
      return Promise.resolve(new Response('nope', { status: 500 }))
    }

    const mgr = new UpstreamSessionManager({ url: 'http://up/mcp', staticHeaders: {} })
    await expect(mgr.ensureInternalSession()).rejects.toThrow(/notifications\/initialized failed/i)
  })
})
