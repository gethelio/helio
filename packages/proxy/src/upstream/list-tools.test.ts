import { describe, it, expect, vi } from 'vitest'
import { classifyPrimeFailure, listToolsInternal } from './list-tools.js'
import type { ForwardResult, McpResponse } from '../mcp/types.js'

function result(response: McpResponse): ForwardResult {
  return { response, durationMs: 1 }
}

const TOOLS_BODY = { jsonrpc: '2.0', id: 'x', result: { tools: [{ name: 'a' }] } }

describe('listToolsInternal', () => {
  it('prefers forwardInternal and returns the whole response for a 2xx', async () => {
    const response: McpResponse = {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: TOOLS_BODY,
    }
    const inner = {
      forward: vi.fn(),
      forwardInternal: vi.fn().mockResolvedValue(result(response)),
      resetInternalSession: vi.fn(),
    }
    const listed = await listToolsInternal(inner)
    expect(listed).toEqual({ ok: true, response })
    expect(inner.forwardInternal).toHaveBeenCalledOnce()
    expect(inner.forwardInternal.mock.calls[0]?.[0]).toMatchObject({ method: 'tools/list' })
    expect(inner.forward).not.toHaveBeenCalled()
    expect(inner.resetInternalSession).not.toHaveBeenCalled()
  })

  it('falls back to forward when the forwarder has no internal path', async () => {
    const response: McpResponse = { status: 200, headers: {}, body: TOOLS_BODY }
    const inner = { forward: vi.fn().mockResolvedValue(result(response)) }
    const listed = await listToolsInternal(inner)
    expect(listed).toEqual({ ok: true, response })
    expect(inner.forward).toHaveBeenCalledOnce()
  })

  it('returns a 2xx without result.tools as ok, leaving the payload judgment to the caller', async () => {
    const response: McpResponse = {
      status: 200,
      headers: { 'content-type': 'text/plain' },
      body: 'plain text',
    }
    const inner = { forward: vi.fn().mockResolvedValue(result(response)) }
    const listed = await listToolsInternal(inner)
    expect(listed.ok).toBe(true)
    if (listed.ok) expect(classifyPrimeFailure(listed.response)).toContain('text/plain')
  })

  it('resets the internal session once and classifies an HTTP error', async () => {
    const inner = {
      forward: vi.fn(),
      forwardInternal: vi
        .fn()
        .mockResolvedValue(result({ status: 400, headers: {}, body: { error: 'session' } })),
      resetInternalSession: vi.fn(),
    }
    const listed = await listToolsInternal(inner)
    expect(listed).toEqual({
      ok: false,
      reason: 'upstream returned HTTP 400 to tools/list (session/initialize may be required)',
    })
    expect(inner.resetInternalSession).toHaveBeenCalledOnce()
  })

  it('resets the internal session once and rethrows the same error object on a throw', async () => {
    const boom = Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' })
    const inner = {
      forward: vi.fn(),
      forwardInternal: vi.fn().mockRejectedValue(boom),
      resetInternalSession: vi.fn(),
    }
    let caught: unknown
    try {
      await listToolsInternal(inner)
    } catch (err) {
      caught = err
    }
    expect(caught).toBe(boom)
    expect(inner.resetInternalSession).toHaveBeenCalledOnce()
  })
})

describe('classifyPrimeFailure', () => {
  it('names the HTTP status, the content type, the JSON-RPC error or the missing field', () => {
    expect(classifyPrimeFailure({ status: 500, headers: {}, body: {} })).toBe(
      'upstream returned HTTP 500 to tools/list (session/initialize may be required)',
    )
    expect(
      classifyPrimeFailure({
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: '<html>',
      }),
    ).toBe('upstream tools/list returned a non-JSON body (content-type text/html)')
    expect(classifyPrimeFailure({ status: 200, headers: {}, body: null })).toBe(
      'upstream tools/list returned a non-JSON body (content-type unknown)',
    )
    expect(classifyPrimeFailure({ status: 200, headers: {}, body: { error: 'bare' } })).toBe(
      'upstream tools/list returned a JSON-RPC error: bare',
    )
    expect(
      classifyPrimeFailure({
        status: 200,
        headers: {},
        body: { error: { message: 'Not initialized' } },
      }),
    ).toBe('upstream tools/list returned a JSON-RPC error: Not initialized')
    expect(classifyPrimeFailure({ status: 200, headers: {}, body: { result: {} } })).toBe(
      'upstream tools/list response was missing result.tools',
    )
  })
})
