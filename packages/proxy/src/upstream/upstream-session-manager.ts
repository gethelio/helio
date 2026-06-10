import { mergeUpstreamHeaders } from './merge-headers.js'
import { describeUnreachableUpstream } from './connection-error.js'
import { parseSseChunk, readSseJsonRpcResponse } from './sse-parse.js'

/** Protocol version Helio offers when it owns the upstream session. */
export const HELIO_MCP_PROTOCOL_VERSION = '2025-06-18'
const MAX_SSE_ERROR_SCAN_BYTES = 256 * 1024

/** A live upstream session Helio established for its own sessionless requests. */
export interface UpstreamSession {
  readonly sessionId: string | undefined
  readonly protocolVersion: string
}

export interface UpstreamSessionManagerOptions {
  url: string
  staticHeaders: Record<string, string>
  requestTimeoutMs?: number
}

/**
 * Owns the `initialize` handshake for Helio-internal requests that arrive
 * without a downstream session (startup annotation prime, internal maintenance).
 * One internal session is established lazily and reused until invalidated
 * (e.g. upstream 404).
 */
export class UpstreamSessionManager {
  private readonly url: string
  private readonly staticHeaders: Record<string, string>
  private readonly requestTimeoutMs: number
  private internal: UpstreamSession | undefined
  private inflight: Promise<UpstreamSession> | undefined

  constructor(options: UpstreamSessionManagerOptions) {
    this.url = options.url
    this.staticHeaders = options.staticHeaders
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000
  }

  /** Return the internal session, performing the handshake once if needed. */
  ensureInternalSession(): Promise<UpstreamSession> {
    if (this.internal) return Promise.resolve(this.internal)
    // Collapse concurrent first-callers onto a single initialize.
    this.inflight ??= this.initialize()
      .then((session) => {
        this.internal = session
        return session
      })
      .finally(() => {
        this.inflight = undefined
      })
    return this.inflight
  }

  /**
   * Drop the cached internal session so the next call re-initializes.
   * Does not cancel any in-flight initialize.
   */
  invalidateInternalSession(): void {
    this.internal = undefined
  }

  /** Convert a fetch failure into an actionable error for the given step. */
  private describeFetchFailure(error: unknown, step: string): Error {
    if (error instanceof Error && error.name === 'TimeoutError') {
      return new Error(`upstream ${step} timed out after ${String(this.requestTimeoutMs)}ms`)
    }
    return (
      describeUnreachableUpstream(error, this.url) ??
      (error instanceof Error ? error : new Error(String(error)))
    )
  }

  private async initialize(): Promise<UpstreamSession> {
    const headers = mergeUpstreamHeaders(
      {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      {},
      this.staticHeaders,
    )

    const initBody = {
      jsonrpc: '2.0' as const,
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: HELIO_MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'helio-proxy', version: '0' },
      },
    }

    let res: Response
    try {
      res = await fetch(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(initBody),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      })
    } catch (error) {
      throw this.describeFetchFailure(error, 'initialize')
    }

    if (!res.ok) {
      throw new Error(`upstream initialize failed: HTTP ${String(res.status)}`)
    }

    const sessionId = res.headers.get('mcp-session-id') ?? undefined
    const initializeEnvelope = await this.readRequiredJsonRpcEnvelope(
      res,
      initBody.id,
      'initialize',
    )
    const initializeError = extractJsonRpcErrorMessage(initializeEnvelope)
    if (initializeError) {
      throw new Error(`upstream initialize returned JSON-RPC error: ${initializeError}`)
    }
    const negotiatedProtocolVersion = extractNegotiatedProtocolVersion(initializeEnvelope)

    // Per spec, the client confirms with notifications/initialized.
    const notifyHeaders = { ...headers }
    if (sessionId) notifyHeaders['mcp-session-id'] = sessionId
    notifyHeaders['mcp-protocol-version'] = negotiatedProtocolVersion
    const notifyRes = await fetch(this.url, {
      method: 'POST',
      headers: notifyHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    }).catch((error: unknown) => {
      throw this.describeFetchFailure(error, 'notifications/initialized')
    })
    if (!notifyRes.ok) {
      throw new Error(`upstream notifications/initialized failed: HTTP ${String(notifyRes.status)}`)
    }
    const notifyError = await this.readOptionalJsonRpcError(notifyRes)
    if (notifyError) {
      throw new Error(`upstream notifications/initialized returned JSON-RPC error: ${notifyError}`)
    }

    return { sessionId, protocolVersion: negotiatedProtocolVersion }
  }

  private async readRequiredJsonRpcEnvelope(
    res: Response,
    requestId: string | number | null,
    step: string,
  ): Promise<Record<string, unknown>> {
    const contentType = res.headers.get('content-type') ?? ''
    if (contentType.includes('text/event-stream')) {
      const payload = await readSseJsonRpcResponse(res, requestId)
      return payload as unknown as Record<string, unknown>
    }

    const raw = await res.text()
    if (!raw.trim()) {
      throw new Error(`upstream ${step} returned an empty body`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error(`upstream ${step} returned non-JSON body`)
    }
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error(`upstream ${step} returned non-object JSON`)
    }
    return parsed as Record<string, unknown>
  }

  private async readOptionalJsonRpcError(res: Response): Promise<string | undefined> {
    const contentType = res.headers.get('content-type') ?? ''
    if (contentType.includes('text/event-stream')) {
      if (!res.body) return undefined
      let errorMessage: string | undefined
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let state = { event: '', data: '', remainder: '' }
      let scannedBytes = 0
      const deadline = Date.now() + this.requestTimeoutMs

      const onEvent = (event: string, data: string): void => {
        if (errorMessage) return
        if (event && event !== 'message') return
        let parsed: unknown
        try {
          parsed = JSON.parse(data)
        } catch {
          return
        }
        if (typeof parsed !== 'object' || parsed === null) return
        errorMessage = extractJsonRpcErrorMessage(parsed as Record<string, unknown>)
      }

      for (;;) {
        const remainingMs = deadline - Date.now()
        if (remainingMs <= 0) {
          await reader.cancel().catch(() => undefined)
          throw new Error(
            `upstream notifications/initialized SSE response timed out after ${String(this.requestTimeoutMs)}ms`,
          )
        }
        let chunk: SseReadChunk
        try {
          chunk = await readSseChunkWithTimeout(reader, remainingMs)
        } catch {
          await reader.cancel().catch(() => undefined)
          throw new Error(
            `upstream notifications/initialized SSE response timed out after ${String(this.requestTimeoutMs)}ms`,
          )
        }
        const { done, value } = chunk
        if (value !== undefined) {
          scannedBytes += value.byteLength
          if (scannedBytes > MAX_SSE_ERROR_SCAN_BYTES) {
            await reader.cancel().catch(() => undefined)
            throw new Error(
              `upstream notifications/initialized SSE response exceeded ${String(MAX_SSE_ERROR_SCAN_BYTES)} bytes`,
            )
          }
          state = parseSseChunk(decoder.decode(value, { stream: true }), state, onEvent)
          if (errorMessage) {
            await reader.cancel().catch(() => undefined)
            return errorMessage
          }
        }
        if (done) {
          const tail = decoder.decode()
          if (tail) {
            state = parseSseChunk(tail, state, onEvent)
          }
          return errorMessage
        }
      }
    }

    const raw = await res.text()
    if (!raw.trim()) return undefined
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return undefined
    }
    if (typeof parsed !== 'object' || parsed === null) return undefined
    return extractJsonRpcErrorMessage(parsed as Record<string, unknown>)
  }
}

async function readSseChunkWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<SseReadChunk> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race<unknown>([
      reader.read() as Promise<unknown>,
      new Promise<unknown>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`sse read timed out after ${String(timeoutMs)}ms`))
        }, timeoutMs)
      }),
    ])
    if (!isSseReadChunk(result)) {
      throw new Error('upstream notifications/initialized SSE response returned invalid chunk')
    }
    return result
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
  }
}

interface SseReadChunk {
  readonly done: boolean
  readonly value: Uint8Array | undefined
}

function isSseReadChunk(value: unknown): value is SseReadChunk {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { done?: unknown; value?: unknown }
  if (typeof candidate.done !== 'boolean') return false
  if (candidate.value === undefined) return true
  return candidate.value instanceof Uint8Array
}

function extractJsonRpcErrorMessage(payload: Record<string, unknown>): string | undefined {
  const error = payload['error']
  if (typeof error === 'string') return error
  if (typeof error !== 'object' || error === null) return undefined
  const message = (error as Record<string, unknown>)['message']
  if (typeof message === 'string' && message.trim()) return message
  return 'unknown JSON-RPC error'
}

function extractNegotiatedProtocolVersion(payload: Record<string, unknown>): string {
  const result = payload['result']
  if (typeof result !== 'object' || result === null) {
    return HELIO_MCP_PROTOCOL_VERSION
  }
  const protocolVersion = (result as Record<string, unknown>)['protocolVersion']
  return typeof protocolVersion === 'string' && protocolVersion.trim()
    ? protocolVersion
    : HELIO_MCP_PROTOCOL_VERSION
}
