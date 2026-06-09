import type { JsonRpcResponse } from '../mcp/types.js'

export interface SseParserState {
  event: string
  data: string
  remainder: string
}

export type SseEventHandler = (event: string, data: string) => void

/**
 * Process a chunk of SSE text, calling `onEvent` for each complete event.
 * Returns updated parser state for the next chunk.
 */
export function parseSseChunk(
  chunk: string,
  state: SseParserState,
  onEvent: SseEventHandler,
): SseParserState {
  let { event, data, remainder } = state
  const text = remainder + chunk
  const lines = text.split('\n')
  remainder = lines.pop() ?? ''

  for (const rawLine of lines) {
    // Per the SSE spec, lines may end with \r\n — strip the trailing \r.
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line === '') {
      // Blank line = end of event
      if (event || data) {
        onEvent(event, data)
        event = ''
        data = ''
      }
    } else if (line.startsWith('event: ')) {
      event = line.slice(7)
    } else if (line.startsWith('data: ')) {
      data = data ? data + '\n' + line.slice(6) : line.slice(6)
    }
    // Ignore id:, retry:, and comment lines (starting with :)
  }

  return { event, data, remainder }
}

/**
 * Read a Streamable HTTP POST response whose body is an SSE stream, returning
 * the first `message` event that is a JSON-RPC response for `requestId`.
 *
 * Unlike the long-lived `sse` transport GET stream, the POST response stream
 * carries the reply and then closes. Server-initiated notifications (no `id`)
 * are ignored here.
 */
export async function readSseJsonRpcResponse(
  res: Response,
  requestId: string | number | null,
): Promise<JsonRpcResponse> {
  if (!res.body) {
    throw new Error('upstream SSE response had no body')
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let state: SseParserState = { event: '', data: '', remainder: '' }
  let found: JsonRpcResponse | undefined

  const onEvent: SseEventHandler = (event, data) => {
    if (event && event !== 'message') return
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      return
    }
    if (parsed === null || typeof parsed !== 'object') return
    const id = (parsed as Record<string, unknown>)['id']
    if (id === requestId) {
      found = parsed as JsonRpcResponse
    }
  }

  const processChunk = (chunk: string): void => {
    state = parseSseChunk(chunk, state, onEvent)
  }

  for (;;) {
    const result = await reader.read()
    if (result.value !== undefined) {
      const chunk = result.value as Uint8Array
      processChunk(decoder.decode(chunk, { stream: true }))
      if (found) {
        await reader.cancel().catch(() => undefined)
        return found
      }
    }
    if (result.done) {
      const tail = decoder.decode()
      if (tail) {
        processChunk(tail)
        if (found) return found
      }
      break
    }
  }

  throw new Error(
    `upstream SSE stream closed with no JSON-RPC response for id ${String(requestId)}`,
  )
}
