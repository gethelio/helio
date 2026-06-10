import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { UpstreamForwarder } from './forwarder.js'
import type { McpRequest } from '../mcp/types.js'

/* eslint-disable @typescript-eslint/no-deprecated -- compatibility tests cover deprecated alias behavior */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CapturedCall {
  url: string | URL | Request
  method: string | undefined
  headers: Record<string, string>
  body: string | undefined
  signal: AbortSignal | null
}

function makeRequest(overrides: Partial<McpRequest> = {}): McpRequest {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
    ...overrides,
  }
}

function makeFetchResponse(body: unknown, status = 200, headers?: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

/**
 * Install a capturing fetch stub and return the capture array.
 * Each call records the URL, method, headers, and body.
 */
function installCapturingFetch(response: Response): { calls: CapturedCall[]; restore: () => void } {
  const calls: CapturedCall[] = []
  const original = globalThis.fetch

  globalThis.fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const hdrs: Record<string, string> = {}
    if (init?.headers && typeof init.headers === 'object' && !Array.isArray(init.headers)) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
        hdrs[k] = v
      }
    }
    calls.push({
      url: input,
      method: init?.method,
      headers: hdrs,
      body: typeof init?.body === 'string' ? init.body : undefined,
      signal: (init?.signal as AbortSignal | undefined) ?? null,
    })
    return Promise.resolve(response.clone())
  }

  return {
    calls,
    restore: () => {
      globalThis.fetch = original
    },
  }
}

const toolsListResult = { jsonrpc: '2.0', id: 1, result: { tools: [] } }

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('UpstreamForwarder', () => {
  let calls: CapturedCall[]
  let restore: () => void

  beforeEach(() => {
    const capture = installCapturingFetch(makeFetchResponse(toolsListResult))
    calls = capture.calls
    restore = capture.restore
  })

  afterEach(() => {
    restore()
  })

  it('sends a POST to the configured upstream URL', async () => {
    const forwarder = new UpstreamForwarder({ url: 'http://upstream:8080/mcp' })

    await forwarder.forward(makeRequest())

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('http://upstream:8080/mcp')
    expect(calls[0]?.method).toBe('POST')
  })

  it('sets content-type to application/json', async () => {
    const forwarder = new UpstreamForwarder({ url: 'http://upstream/mcp' })

    await forwarder.forward(makeRequest())

    expect(calls[0]?.headers['content-type']).toBe('application/json')
  })

  it('includes static headers from constructor', async () => {
    const forwarder = new UpstreamForwarder({
      url: 'http://upstream/mcp',
      headers: { 'x-api-key': 'secret-key' },
    })

    await forwarder.forward(makeRequest())

    expect(calls[0]?.headers['x-api-key']).toBe('secret-key')
  })

  it('forwards sessionId as Mcp-Session-Id header', async () => {
    const forwarder = new UpstreamForwarder({ url: 'http://upstream/mcp' })

    await forwarder.forward(makeRequest({ sessionId: 'sess-42' }))

    expect(calls[0]?.headers['mcp-session-id']).toBe('sess-42')
  })

  it('does not set Mcp-Session-Id when sessionId is absent', async () => {
    const forwarder = new UpstreamForwarder({ url: 'http://upstream/mcp' })

    await forwarder.forward(makeRequest({ sessionId: undefined }))

    expect(calls[0]?.headers['mcp-session-id']).toBeUndefined()
  })

  it('forwards per-request headers from McpRequest.headers', async () => {
    const forwarder = new UpstreamForwarder({ url: 'http://upstream/mcp' })

    await forwarder.forward(makeRequest({ headers: { authorization: 'Bearer tok123' } }))

    expect(calls[0]?.headers['authorization']).toBe('Bearer tok123')
  })

  it('static config headers override caller-forwarded headers', async () => {
    const forwarder = new UpstreamForwarder({
      url: 'http://upstream/mcp',
      headers: { Authorization: 'Bearer static-token' },
    })

    await forwarder.forward(makeRequest({ headers: { authorization: 'Bearer caller-token' } }))

    expect(calls[0]?.headers['authorization']).toBe('Bearer static-token')
    expect(calls[0]?.headers).not.toHaveProperty('Authorization')
  })

  it('omits sessionId and headers from the JSON-RPC body', async () => {
    const forwarder = new UpstreamForwarder({ url: 'http://upstream/mcp' })

    await forwarder.forward(
      makeRequest({ sessionId: 'sess-1', headers: { authorization: 'Bearer x' } }),
    )

    const body = JSON.parse(calls[0]?.body ?? '{}') as Record<string, unknown>
    expect(body).toEqual({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect(body).not.toHaveProperty('sessionId')
    expect(body).not.toHaveProperty('headers')
  })

  it('omits id from body when undefined', async () => {
    const forwarder = new UpstreamForwarder({ url: 'http://upstream/mcp' })

    await forwarder.forward(makeRequest({ id: undefined }))

    const body = JSON.parse(calls[0]?.body ?? '{}') as Record<string, unknown>
    expect(body).not.toHaveProperty('id')
  })

  it('includes params in body when present', async () => {
    const forwarder = new UpstreamForwarder({ url: 'http://upstream/mcp' })

    await forwarder.forward(makeRequest({ method: 'tools/call', params: { name: 'get_weather' } }))

    const body = JSON.parse(calls[0]?.body ?? '{}') as Record<string, unknown>
    expect(body).toHaveProperty('params')
    expect(body['params']).toEqual({ name: 'get_weather' })
  })

  it('returns durationMs in ForwardResult', async () => {
    const forwarder = new UpstreamForwarder({ url: 'http://upstream/mcp' })

    const result = await forwarder.forward(makeRequest())
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('lets fetch errors propagate', async () => {
    restore()
    globalThis.fetch = () => Promise.reject(new Error('network failure'))

    const forwarder = new UpstreamForwarder({ url: 'http://upstream/mcp' })

    await expect(forwarder.forward(makeRequest())).rejects.toThrow('network failure')
  })

  it('translates a connection-refused fetch failure into actionable guidance', async () => {
    restore()
    globalThis.fetch = () => {
      const wrapper = new TypeError('fetch failed')
      ;(wrapper as { cause?: unknown }).cause = Object.assign(new Error('connect'), {
        code: 'ECONNREFUSED',
      })
      return Promise.reject(wrapper)
    }

    const forwarder = new UpstreamForwarder({ url: 'http://localhost:8080/mcp' })

    await expect(forwarder.forward(makeRequest())).rejects.toThrow(
      /Upstream MCP server at http:\/\/localhost:8080\/mcp is unreachable \(ECONNREFUSED\) — is it running\?/,
    )
  })

  it('uses a composed request signal when downstream signal is present', async () => {
    const forwarder = new UpstreamForwarder({ url: 'http://upstream/mcp' })
    const controller = new AbortController()
    await forwarder.forward(makeRequest({ signal: controller.signal }))
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal)
  })

  it('maps downstream aborts to client-aborted errors', async () => {
    restore()
    globalThis.fetch = () => {
      const abortError = new Error('aborted')
      abortError.name = 'AbortError'
      return Promise.reject(abortError)
    }

    const controller = new AbortController()
    controller.abort()
    const forwarder = new UpstreamForwarder({ url: 'http://upstream/mcp' })
    await expect(forwarder.forward(makeRequest({ signal: controller.signal }))).rejects.toThrow(
      'request aborted by downstream client',
    )
  })

  it('surfaces timeout with explicit request-timeout message', async () => {
    restore()
    globalThis.fetch = () => {
      const timeoutError = new Error('timeout')
      timeoutError.name = 'TimeoutError'
      return Promise.reject(timeoutError)
    }
    const forwarder = new UpstreamForwarder({ url: 'http://upstream/mcp', requestTimeoutMs: 1234 })
    await expect(forwarder.forward(makeRequest())).rejects.toThrow(
      'upstream request timed out after 1234ms',
    )
  })

  it('parses upstream text/event-stream responses', async () => {
    restore()
    const original = globalThis.fetch
    globalThis.fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const hdrs: Record<string, string> = {}
      if (init?.headers && typeof init.headers === 'object' && !Array.isArray(init.headers)) {
        for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
          hdrs[k] = v
        }
      }
      calls.push({
        url: input,
        method: init?.method,
        headers: hdrs,
        body: typeof init?.body === 'string' ? init.body : undefined,
        signal: (init?.signal as AbortSignal | undefined) ?? null,
      })
      return Promise.resolve(
        new Response('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
      )
    }
    restore = () => {
      globalThis.fetch = original
    }

    const forwarder = new UpstreamForwarder({ url: 'http://upstream/mcp' })
    const result = await forwarder.forward(makeRequest())
    expect((result.response.body as { result: unknown }).result).toEqual({ tools: [] })
  })

  it('parses upstream JSON response into McpResponse', async () => {
    restore()
    const upstream = { jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'test' }] } }
    const capture = installCapturingFetch(
      makeFetchResponse(upstream, 200, { 'mcp-session-id': 'sess-99' }),
    )
    calls = capture.calls
    restore = capture.restore

    const forwarder = new UpstreamForwarder({ url: 'http://upstream/mcp' })
    const result = await forwarder.forward(makeRequest())

    expect(result.response.status).toBe(200)
    expect(result.response.body).toEqual(upstream)
    expect(result.response.headers['mcp-session-id']).toBe('sess-99')
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })
})
