import { describe, it, expect, afterEach, vi } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { bareTargetFailureLine, configTargetFailureLine } from './failure-line.js'
import { describeUnreachableUpstream } from '../upstream/connection-error.js'
import { UpstreamSessionManager } from '../upstream/upstream-session-manager.js'
import { SseUpstreamForwarder } from '../upstream/sse-forwarder.js'

const LABEL = 'http://host/mcp?key=${API_KEY}'
const originalFetch = globalThis.fetch

afterEach(() => {
  vi.restoreAllMocks()
  globalThis.fetch = originalFetch
})

/** Stub `fetch` by JSON-RPC method; methods without a handler answer an empty 202. */
function stubUpstream(handlers: Record<string, () => Response>): void {
  globalThis.fetch = ((_input: unknown, init?: RequestInit) => {
    const raw = typeof init?.body === 'string' ? init.body : '{}'
    const method = (JSON.parse(raw) as { method?: string }).method ?? ''
    const handler = handlers[method]
    return Promise.resolve(handler ? handler() : new Response(null, { status: 202 }))
  }) as typeof fetch
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (err) {
    return err
  }
  throw new Error('expected a rejection')
}

function fetchFailed(code: string): TypeError {
  const wrapper = new TypeError('fetch failed')
  ;(wrapper as { cause?: unknown }).cause = Object.assign(new Error('connect failed'), { code })
  return wrapper
}

describe('configTargetFailureLine', () => {
  it('names the code from the error or its cause chain and never the message', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const unreachable = describeUnreachableUpstream(
      fetchFailed('ECONNREFUSED'),
      'http://host/mcp?key=sekrit',
    )
    expect(configTargetFailureLine(LABEL, unreachable)).toBe(
      'Error: cannot list tools on http://host/mcp?key=${API_KEY} (ECONNREFUSED)',
    )
    const spawn = Object.assign(new Error('spawn /opt/sekrit/bin ENOENT'), { code: 'ENOENT' })
    expect(configTargetFailureLine('${BIN}', spawn)).toBe(
      'Error: cannot list tools on ${BIN} (ENOENT)',
    )
    const denied = Object.assign(new Error('spawn /opt/sekrit/bin EACCES'), { code: 'EACCES' })
    expect(configTargetFailureLine('${BIN}', denied)).toBe(
      'Error: cannot list tools on ${BIN} (EACCES)',
    )
  })

  it('takes HTTP 400 from the Error ensureInternalSession throws when initialize is answered 400', async () => {
    // Stand-in: an empty 202 to server/discover (legacy), then a 400 to initialize.
    stubUpstream({
      'server/discover': () => new Response(null, { status: 202 }),
      initialize: () => new Response('nope', { status: 400 }),
    })
    const mgr = new UpstreamSessionManager({ url: 'http://up/mcp?key=sekrit', staticHeaders: {} })
    const err = await rejection(mgr.ensureInternalSession())
    expect((err as Error).message).toMatch(/initialize failed/)
    expect(configTargetFailureLine(LABEL, err)).toBe(
      'Error: cannot list tools on http://host/mcp?key=${API_KEY} (HTTP 400)',
    )
  })

  it('takes HTTP 401 from the Error the SSE forwarder rejects with on a not-ok connect', async () => {
    // Stand-in: a raw node:http server whose GET answers 401.
    const server = createServer((_req, res) => {
      res.writeHead(401, { 'content-type': 'text/plain' })
      res.end('unauthorized')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    try {
      const sse = new SseUpstreamForwarder({ url: `http://127.0.0.1:${String(port)}/sse` })
      const err = await rejection(sse.connect())
      expect((err as Error).message).toMatch(/SSE connection failed/)
      expect(configTargetFailureLine(LABEL, err)).toBe(
        'Error: cannot list tools on http://host/mcp?key=${API_KEY} (HTTP 401)',
      )
      await sse.close()
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
      })
    }
  })

  it('says timeout from the Error the session manager builds when initialize times out', async () => {
    // Stand-in: an empty 202 to server/discover, then a TimeoutError from initialize.
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
    const err = await rejection(mgr.ensureInternalSession())
    expect((err as Error).message).toMatch(/initialize timed out after 1234ms/)
    expect(configTargetFailureLine(LABEL, err)).toBe(
      'Error: cannot list tools on http://host/mcp?key=${API_KEY} (timeout)',
    )
  })

  it('reads the stdio pending-request timeout sentence as timeout too', () => {
    expect(
      configTargetFailureLine(
        '${BIN}',
        new Error('request helio-prime-annotations timed out after 1000ms'),
      ),
    ).toBe('Error: cannot list tools on ${BIN} (timeout)')
  })

  it('never takes a token from a server sentence after JSON-RPC error: or modern MCP error', () => {
    expect(
      configTargetFailureLine(
        LABEL,
        new Error('upstream tools/list returned a JSON-RPC error: HTTP 500'),
      ),
    ).toBe('Error: cannot list tools on http://host/mcp?key=${API_KEY}')
    expect(
      configTargetFailureLine(
        LABEL,
        new Error('upstream initialize returned JSON-RPC error: expected HTTP 200, got HTTP 500'),
      ),
    ).toBe('Error: cannot list tools on http://host/mcp?key=${API_KEY}')
    expect(
      configTargetFailureLine(LABEL, new Error('modern MCP error -32000: timed out after 1000ms')),
    ).toBe('Error: cannot list tools on http://host/mcp?key=${API_KEY}')
    expect(
      configTargetFailureLine(
        LABEL,
        'upstream returned HTTP 400 to tools/list (session/initialize may be required)',
      ),
    ).toBe('Error: cannot list tools on http://host/mcp?key=${API_KEY} (HTTP 400)')
  })

  it('keeps a JSON-RPC message carrying a secret off the line', () => {
    const line = configTargetFailureLine(
      LABEL,
      new Error(
        'upstream tools/list returned a JSON-RPC error: bad token sekrit for http://host/mcp?key=sekrit',
      ),
    )
    expect(line).toBe('Error: cannot list tools on http://host/mcp?key=${API_KEY}')
    expect(line).not.toContain('sekrit')
  })

  it('stays bare for the code-less transport sentences and a non-Error value', () => {
    for (const message of [
      'stdio forwarder is dead (max retries exceeded)',
      'SSE response has no body',
      'upstream initialize returned non-JSON body',
      'SSE connection timed out after 10000ms while waiting for endpoint',
    ]) {
      const line = configTargetFailureLine('${BIN}', new Error(message))
      expect(line, message).toBe(
        message.includes('timed out after')
          ? 'Error: cannot list tools on ${BIN} (timeout)'
          : 'Error: cannot list tools on ${BIN}',
      )
    }
    expect(configTargetFailureLine('${BIN}', 42)).toBe('Error: cannot list tools on ${BIN}')
  })
})

describe('bareTargetFailureLine', () => {
  it('prints the label and the transport message for a bare URL', () => {
    expect(bareTargetFailureLine('http://127.0.0.1:1/mcp', new Error('boom'))).toBe(
      'Error: cannot list tools on http://127.0.0.1:1/mcp: boom',
    )
    expect(bareTargetFailureLine('http://127.0.0.1:1/mcp', 'a reason string')).toBe(
      'Error: cannot list tools on http://127.0.0.1:1/mcp: a reason string',
    )
  })
})
