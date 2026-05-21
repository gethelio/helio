import { describe, it, expect } from 'vitest'
import { parseUpstreamResponse } from './response.js'

describe('parseUpstreamResponse', () => {
  it('parses a JSON response into McpResponse', async () => {
    const body = { jsonrpc: '2.0', id: 1, result: { tools: [] } }
    const res = new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })

    const mcpRes = await parseUpstreamResponse(res)

    expect(mcpRes.status).toBe(200)
    expect(mcpRes.body).toEqual(body)
    expect(mcpRes.headers['content-type']).toBe('application/json')
  })

  it('captures all response headers', async () => {
    const res = new Response('{}', {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'mcp-session-id': 'sess-123',
        'x-custom': 'value',
      },
    })

    const mcpRes = await parseUpstreamResponse(res)

    expect(mcpRes.headers['content-type']).toBe('application/json')
    expect(mcpRes.headers['mcp-session-id']).toBe('sess-123')
    expect(mcpRes.headers['x-custom']).toBe('value')
  })

  it('falls back to text body for non-JSON content-type', async () => {
    const res = new Response('plain text response', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    })

    const mcpRes = await parseUpstreamResponse(res)

    expect(mcpRes.body).toBe('plain text response')
  })

  it('preserves error status codes', async () => {
    const body = { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'not found' } }
    const res = new Response(JSON.stringify(body), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    })

    const mcpRes = await parseUpstreamResponse(res)

    expect(mcpRes.status).toBe(404)
    expect(mcpRes.body).toEqual(body)
  })

  it('handles response with no content-type as text', async () => {
    const res = new Response('some body', { status: 200 })

    const mcpRes = await parseUpstreamResponse(res)

    expect(mcpRes.body).toBe('some body')
  })

  it('falls back to raw text when content-type is JSON but body is malformed', async () => {
    const res = new Response('not valid json{{{', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })

    const mcpRes = await parseUpstreamResponse(res)

    expect(mcpRes.status).toBe(200)
    expect(mcpRes.body).toBe('not valid json{{{')
  })
})
