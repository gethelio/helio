import type { McpForwarder, McpRequest, ForwardResult } from '../mcp/types.js'
import { parseUpstreamResponse } from './response.js'

/** Options for constructing an UpstreamForwarder. */
export interface UpstreamForwarderOptions {
  /** The upstream MCP server URL (e.g. "http://localhost:8080/mcp"). */
  url: string
  /** Static headers to include on every upstream request (e.g. API keys). */
  headers?: Record<string, string>
  /** Maximum time to wait for an upstream request before aborting. */
  requestTimeoutMs?: number
}

/**
 * Forward MCP requests to an upstream server via HTTP.
 *
 * Sends JSON-RPC POST requests to the configured URL, passes through
 * session IDs and per-request headers, and captures request timing.
 */
export class UpstreamForwarder implements McpForwarder {
  private readonly url: string
  private readonly staticHeaders: Record<string, string>
  private readonly requestTimeoutMs: number

  constructor(options: UpstreamForwarderOptions) {
    this.url = options.url
    this.staticHeaders = options.headers ?? {}
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000
  }

  async forward(request: McpRequest): Promise<ForwardResult> {
    const requestHeaders = request.headers ?? {}
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...this.staticHeaders,
      ...requestHeaders,
    }

    if (request.sessionId) {
      headers['mcp-session-id'] = request.sessionId
    }

    // Build a clean JSON-RPC body — strip MCP-level fields (sessionId, headers)
    const body: Record<string, unknown> = {
      jsonrpc: request.jsonrpc,
      method: request.method,
    }
    if (request.id !== undefined) body['id'] = request.id
    if (request.params !== undefined) body['params'] = request.params

    const start = performance.now()
    const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs)
    const requestSignal = request.signal
    const signal = requestSignal ? AbortSignal.any([requestSignal, timeoutSignal]) : timeoutSignal
    let res: Response
    try {
      res = await fetch(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      })
    } catch (error) {
      const isTimeout = error instanceof Error && error.name === 'TimeoutError'
      if (requestSignal?.aborted) {
        throw new Error('request aborted by downstream client')
      }
      if (isTimeout) {
        throw new Error(`upstream request timed out after ${String(this.requestTimeoutMs)}ms`)
      }
      throw error
    }
    const durationMs = performance.now() - start

    const contentType = res.headers.get('content-type') ?? ''
    if (contentType.includes('text/event-stream')) {
      throw new Error(
        'upstream returned text/event-stream; streamable-http passthrough is not supported in v0.1',
      )
    }

    const response = await parseUpstreamResponse(res)
    return { response, durationMs }
  }
}
