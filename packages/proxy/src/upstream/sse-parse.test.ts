import { describe, it, expect } from 'vitest'
import { parseSseChunk, readSseJsonRpcResponse } from './sse-parse.js'

describe('parseSseChunk', () => {
  it('emits a complete event on a blank-line boundary', () => {
    const events: Array<{ event: string; data: string }> = []
    parseSseChunk(
      'event: message\ndata: {"id":1}\n\n',
      { event: '', data: '', remainder: '' },
      (event, data) => events.push({ event, data }),
    )
    expect(events).toEqual([{ event: 'message', data: '{"id":1}' }])
  })

  it('reassembles an event split across chunks', () => {
    const events: Array<{ event: string; data: string }> = []
    let state = { event: '', data: '', remainder: '' }
    state = parseSseChunk('event: message\ndata: {"id":', state, (event, data) =>
      events.push({ event, data }),
    )
    parseSseChunk('1}\n\n', state, (event, data) => events.push({ event, data }))
    expect(events).toEqual([{ event: 'message', data: '{"id":1}' }])
  })

  it('handles CRLF line endings', () => {
    const events: Array<{ event: string; data: string }> = []
    parseSseChunk(
      'event: message\r\ndata: {"id":1}\r\n\r\n',
      { event: '', data: '', remainder: '' },
      (event, data) => events.push({ event, data }),
    )
    expect(events).toEqual([{ event: 'message', data: '{"id":1}' }])
  })

  it('accepts event/data fields with no space after colon', () => {
    const events: Array<{ event: string; data: string }> = []
    parseSseChunk(
      'event:message\ndata:{"id":1}\n\n',
      { event: '', data: '', remainder: '' },
      (event, data) => events.push({ event, data }),
    )
    expect(events).toEqual([{ event: 'message', data: '{"id":1}' }])
  })
})

describe('readSseJsonRpcResponse', () => {
  it('returns the message event matching the request id', async () => {
    const stream = new Response(
      'event: message\ndata: {"jsonrpc":"2.0","id":7,"result":{"ok":true}}\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    )
    const msg = await readSseJsonRpcResponse(stream, 7)
    expect(msg).toEqual({ jsonrpc: '2.0', id: 7, result: { ok: true } })
  })

  it('accepts default message events without an event line', async () => {
    const stream = new Response('data: {"jsonrpc":"2.0","id":7,"result":{"ok":true}}\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    })
    const msg = await readSseJsonRpcResponse(stream, 7)
    expect(msg).toEqual({ jsonrpc: '2.0', id: 7, result: { ok: true } })
  })

  it('returns JSON-RPC error responses with a matching id', async () => {
    const stream = new Response(
      'event: message\ndata: {"jsonrpc":"2.0","id":7,"error":{"code":-32600,"message":"bad"}}\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    )
    const msg = await readSseJsonRpcResponse(stream, 7)
    expect(msg).toEqual({
      jsonrpc: '2.0',
      id: 7,
      error: { code: -32600, message: 'bad' },
    })
  })

  it('ignores non-message event types (e.g. server heartbeats)', async () => {
    const stream = new Response(
      'event: ping\ndata: {}\n\n' +
        'event: message\ndata: {"jsonrpc":"2.0","id":7,"result":{"ok":true}}\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    )
    const msg = await readSseJsonRpcResponse(stream, 7)
    expect(msg).toEqual({ jsonrpc: '2.0', id: 7, result: { ok: true } })
  })

  it('skips notification events and returns the matching response', async () => {
    const stream = new Response(
      'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n' +
        'event: message\ndata: {"jsonrpc":"2.0","id":7,"result":{"ok":true}}\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    )
    const msg = await readSseJsonRpcResponse(stream, 7)
    expect(msg).toEqual({ jsonrpc: '2.0', id: 7, result: { ok: true } })
  })

  it('reads a response split across multiple stream chunks', async () => {
    const payload = 'event: message\ndata: {"jsonrpc":"2.0","id":7,"result":{"ok":true}}\n\n'
    const encoder = new TextEncoder()
    const chunks = [payload.slice(0, 20), payload.slice(20)]
    let index = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index < chunks.length) {
          controller.enqueue(encoder.encode(chunks[index]))
          index += 1
          return
        }
        controller.close()
      },
    })
    const stream = new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    const msg = await readSseJsonRpcResponse(stream, 7)
    expect(msg).toEqual({ jsonrpc: '2.0', id: 7, result: { ok: true } })
  })

  it('throws when the stream closes without a matching response', async () => {
    const stream = new Response('event: message\ndata: {"jsonrpc":"2.0","method":"x"}\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    })
    await expect(readSseJsonRpcResponse(stream, 7)).rejects.toThrow(/no JSON-RPC response/i)
  })
})
