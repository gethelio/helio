import { PendingRequests } from '../mcp/pending-requests.js'
import { describeUnreachableUpstream } from './connection-error.js'
import { mergeUpstreamHeaders } from './merge-headers.js'
import type {
  McpForwarder,
  McpRequest,
  McpResponse,
  ForwardResult,
  JsonRpcResponse,
} from '../mcp/types.js'

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000

function buildRequestSignal(request: McpRequest, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  return request.signal ? AbortSignal.any([request.signal, timeoutSignal]) : timeoutSignal
}

/** Options for constructing an SseUpstreamForwarder. */
export interface SseUpstreamForwarderOptions {
  /** The upstream SSE server URL (e.g. "http://localhost:8080/sse"). */
  url: string
  /** Static headers to include on every request. */
  headers?: Record<string, string>
  /** Timeout in milliseconds for individual requests. */
  requestTimeoutMs?: number
  /** Timeout in milliseconds while establishing the SSE connection. */
  connectTimeoutMs?: number
}

// ---------------------------------------------------------------------------
// SSE line-based parser
// ---------------------------------------------------------------------------

interface SseParserState {
  event: string
  data: string
  remainder: string
}

type SseEventHandler = (event: string, data: string) => void

/**
 * Process a chunk of SSE text, calling `onEvent` for each complete event.
 * Returns updated parser state for the next chunk.
 */
function parseSseChunk(
  chunk: string,
  state: SseParserState,
  onEvent: SseEventHandler,
): SseParserState {
  let { event, data, remainder } = state
  const text = remainder + chunk
  const lines = text.split('\n')
  remainder = lines.pop() ?? ''

  for (const line of lines) {
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

// ---------------------------------------------------------------------------
// SseUpstreamForwarder
// ---------------------------------------------------------------------------

/**
 * Forward MCP requests to an upstream server that speaks SSE transport.
 *
 * Connects via GET to establish an SSE stream, learns the POST endpoint
 * from the `endpoint` event, and correlates responses via JSON-RPC `id`.
 */
export class SseUpstreamForwarder implements McpForwarder {
  private readonly url: string
  private readonly staticHeaders: Record<string, string>
  private readonly pending: PendingRequests
  private readonly requestTimeoutMs: number
  private readonly connectTimeoutMs: number

  private postUrl: string | null = null
  private abortController: AbortController | null = null
  private connected = false

  constructor(options: SseUpstreamForwarderOptions) {
    this.url = options.url
    this.staticHeaders = options.headers ?? {}
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
    this.pending = new PendingRequests(this.requestTimeoutMs)
  }

  /** Connect to the upstream SSE server and learn the POST endpoint. */
  connect(): Promise<void> {
    const controller = new AbortController()
    this.abortController = controller

    return new Promise<void>((resolve, reject) => {
      let resolved = false

      fetch(this.url, {
        headers: {
          accept: 'text/event-stream',
          ...this.staticHeaders,
        },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(this.connectTimeoutMs)]),
      })
        .then((res) => {
          if (!res.ok) {
            reject(new Error(`SSE connection failed: HTTP ${String(res.status)}`))
            return
          }
          if (!res.body) {
            reject(new Error('SSE response has no body'))
            return
          }

          this.consumeStream(res.body, (event, data) => {
            if (event === 'endpoint' && !resolved) {
              this.postUrl = this.resolveEndpointUrl(data)
              this.connected = true
              resolved = true
              resolve()
            } else if (event === 'message') {
              this.onMessage(data)
            }
          })
        })
        .catch((err: unknown) => {
          if (!resolved) {
            const asError = err instanceof Error ? err : new Error(String(err))
            if (asError.name === 'TimeoutError') {
              reject(
                new Error(
                  `SSE connection timed out after ${String(this.connectTimeoutMs)}ms while waiting for endpoint`,
                ),
              )
              return
            }
            reject(describeUnreachableUpstream(err, this.url) ?? asError)
          }
        })
    })
  }

  async forward(request: McpRequest): Promise<ForwardResult> {
    if (!this.connected || !this.postUrl) {
      throw new Error('SSE forwarder not connected')
    }

    // Build clean JSON-RPC body (strip MCP-level fields)
    const body: Record<string, unknown> = {
      jsonrpc: request.jsonrpc,
      method: request.method,
    }
    if (request.id !== undefined) body['id'] = request.id
    if (request.params !== undefined) body['params'] = request.params

    const headers = mergeUpstreamHeaders(
      { 'content-type': 'application/json' },
      request.headers ?? {},
      this.staticHeaders,
    )

    if (request.sessionId) {
      headers['mcp-session-id'] = request.sessionId
    }

    const start = performance.now()

    const signal = buildRequestSignal(request, this.requestTimeoutMs)

    // Notifications (missing id) — fire and forget
    if (request.id === undefined) {
      let res: Response
      try {
        res = await fetch(this.postUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal,
        })
      } catch (error) {
        const asError = error instanceof Error ? error : new Error(String(error))
        const isTimeout = asError.name === 'TimeoutError'
        if (request.signal?.aborted) {
          throw new Error('request aborted by downstream client')
        }
        if (isTimeout) {
          throw new Error(
            `upstream notification POST timed out after ${String(this.requestTimeoutMs)}ms`,
          )
        }
        throw describeUnreachableUpstream(error, this.postUrl) ?? asError
      }
      if (!res.ok) {
        throw new Error(`upstream notification POST failed: HTTP ${String(res.status)}`)
      }
      const durationMs = performance.now() - start
      const response: McpResponse = {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: { jsonrpc: '2.0' },
      }
      return { response, durationMs }
    }

    // Request with id — POST and wait for SSE response
    const requestId = request.id
    const responsePromise = this.pending.add(requestId)
    let removeAbortListener = () => {}
    if (request.signal) {
      if (request.signal.aborted) {
        const abortError = new Error('request aborted by downstream client')
        this.pending.reject(requestId, abortError)
        await responsePromise.catch(() => {
          // Ensure the rejected pending promise is observed before rethrowing.
        })
        throw abortError
      }
      const onAbort = () => {
        this.pending.reject(requestId, new Error('request aborted by downstream client'))
      }
      removeAbortListener = () => {
        request.signal?.removeEventListener('abort', onAbort)
      }
      request.signal.addEventListener('abort', onAbort, { once: true })
    }

    try {
      const postRes = await fetch(this.postUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      })
      if (!postRes.ok) {
        throw new Error(`upstream request POST failed: HTTP ${String(postRes.status)}`)
      }
    } catch (error) {
      const asError = error instanceof Error ? error : new Error(String(error))
      const isTimeout = asError.name === 'TimeoutError'
      const isAborted = request.signal?.aborted === true
      const networkFailure = describeUnreachableUpstream(error, this.postUrl) ?? asError
      const postFailure = isTimeout
        ? new Error(`upstream request POST timed out after ${String(this.requestTimeoutMs)}ms`)
        : networkFailure
      this.pending.reject(
        requestId,
        isAborted ? new Error('request aborted by downstream client') : postFailure,
      )
      await responsePromise.catch(() => {
        // Ensure the rejected pending promise is observed before rethrowing.
      })
      throw isAborted ? new Error('request aborted by downstream client') : postFailure
    }

    let jsonRpcResponse: JsonRpcResponse
    try {
      jsonRpcResponse = await responsePromise
    } finally {
      removeAbortListener()
    }
    const durationMs = performance.now() - start

    const response: McpResponse = {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: jsonRpcResponse,
    }
    return { response, durationMs }
  }

  /** Close the SSE connection and reject all pending requests. */
  close(): Promise<void> {
    this.connected = false
    this.abortController?.abort()
    this.pending.rejectAll(new Error('SSE forwarder closing'))
    return Promise.resolve()
  }

  /** Resolve a potentially relative endpoint URL against the upstream base URL. */
  private resolveEndpointUrl(data: string): string {
    const trimmed = data.trim()
    try {
      // Try as absolute URL first
      new URL(trimmed)
      return trimmed
    } catch {
      // Relative — resolve against the upstream URL
      return new URL(trimmed, this.url).href
    }
  }

  /** Consume the SSE ReadableStream, parsing events. */
  private consumeStream(body: ReadableStream<Uint8Array>, onEvent: SseEventHandler): void {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let state: SseParserState = { event: '', data: '', remainder: '' }

    const read = (): void => {
      reader
        .read()
        .then(({ done, value }) => {
          if (done) {
            this.connected = false
            this.pending.rejectAll(new Error('SSE stream ended'))
            return
          }
          state = parseSseChunk(decoder.decode(value, { stream: true }), state, onEvent)
          read()
        })
        .catch((err: unknown) => {
          // AbortError is expected on close()
          const isAbort = err instanceof Error && err.name === 'AbortError'
          if (!isAbort) {
            this.connected = false
            this.pending.rejectAll(err instanceof Error ? err : new Error(String(err)))
          }
        })
    }
    read()
  }

  /** Handle a `message` event from the SSE stream. */
  private onMessage(data: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      // Non-JSON SSE event data — ignore
      return
    }
    if (parsed === null || typeof parsed !== 'object') return
    const obj = parsed as Record<string, unknown>
    const id = obj['id']
    if (typeof id === 'string' || typeof id === 'number' || id === null) {
      this.pending.resolve(id, parsed as JsonRpcResponse)
    }
  }
}
