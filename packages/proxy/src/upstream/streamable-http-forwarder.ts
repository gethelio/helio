import type { McpForwarder, McpRequest, ForwardResult, McpResponse } from '../mcp/types.js'
import { parseUpstreamResponse } from './response.js'
import { readSseJsonRpcResponse } from './sse-parse.js'
import { mergeUpstreamHeaders } from './merge-headers.js'
import { describeUnreachableUpstream } from './connection-error.js'
import { UpstreamSessionManager, HELIO_MCP_PROTOCOL_VERSION } from './upstream-session-manager.js'

export interface StreamableHttpForwarderOptions {
  /** The upstream MCP server URL (e.g. "http://localhost:8080/mcp"). */
  url: string
  /** Static headers to include on every upstream request (e.g. API keys). */
  headers?: Record<string, string>
  /** Maximum time to wait for an upstream request before aborting. */
  requestTimeoutMs?: number
}

/**
 * Spec-compliant upstream MCP Streamable HTTP client.
 *
 * Parses both `application/json` and `text/event-stream` POST responses, sends
 * the negotiated protocol version, relays the upstream session id back
 * downstream, and — for Helio-internal requests with no downstream session —
 * borrows an internally-managed session established via `initialize`.
 */
export class StreamableHttpForwarder implements McpForwarder {
  private readonly url: string
  private readonly staticHeaders: Record<string, string>
  private readonly requestTimeoutMs: number
  private readonly sessions: UpstreamSessionManager

  constructor(options: StreamableHttpForwarderOptions) {
    this.url = options.url
    this.staticHeaders = options.headers ?? {}
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000
    this.sessions = new UpstreamSessionManager({
      url: this.url,
      staticHeaders: this.staticHeaders,
      requestTimeoutMs: this.requestTimeoutMs,
    })
  }

  /** Lifecycle parity with sse/stdio. No eager connect — sessions are lazy. */
  connect(): Promise<void> {
    return Promise.resolve()
  }

  /** Lifecycle parity with sse/stdio. */
  close(): Promise<void> {
    this.sessions.invalidateInternalSession()
    return Promise.resolve()
  }

  async forward(request: McpRequest): Promise<ForwardResult> {
    // `initialize` is transport machinery: forward verbatim, never inject a
    // managed session, and let the response's Mcp-Session-Id flow downstream.
    if (request.method === 'initialize') {
      return this.send(request, request.sessionId, /* protocolHeader */ false)
    }

    // Downstream-driven and external sessionless callers alike are transparent
    // passthrough: forward whatever session the caller did (or did not) supply.
    return this.send(request, request.sessionId, true)
  }

  /**
   * Helio-internal execution path (startup prime / internal maintenance) that
   * may borrow the proxy-managed internal session.
   */
  async forwardInternal(request: McpRequest): Promise<ForwardResult> {
    const session = await this.sessions.ensureInternalSession()
    try {
      return await this.send(request, session.sessionId, true, /* internalManaged */ true)
    } catch (error) {
      if (error instanceof UpstreamSessionExpiredError) {
        this.sessions.invalidateInternalSession()
        const fresh = await this.sessions.ensureInternalSession()
        return this.send(request, fresh.sessionId, true, /* internalManaged */ true)
      }
      throw error
    }
  }

  private async send(
    request: McpRequest,
    sessionId: string | undefined,
    protocolHeader: boolean,
    internalManaged = false,
  ): Promise<ForwardResult> {
    const headers = mergeUpstreamHeaders(
      {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      request.headers ?? {},
      this.staticHeaders,
    )
    if (sessionId) headers['mcp-session-id'] = sessionId
    if (protocolHeader) headers['mcp-protocol-version'] = HELIO_MCP_PROTOCOL_VERSION

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
      res = await fetch(this.url, { method: 'POST', headers, body: JSON.stringify(body), signal })
    } catch (error) {
      const isTimeout = error instanceof Error && error.name === 'TimeoutError'
      if (requestSignal?.aborted) throw new Error('request aborted by downstream client')
      if (isTimeout) {
        throw new Error(`upstream request timed out after ${String(this.requestTimeoutMs)}ms`)
      }
      throw describeUnreachableUpstream(error, this.url) ?? error
    }
    // 404 on the internal managed session means it expired — signal retry.
    // Passthrough downstream sessions surface raw 404 to the caller, and so
    // does an internal request when the upstream never minted a session
    // (sessionless server): with no session to re-establish, a retry cannot
    // change the outcome, so the raw 404 flows to the prime classifier.
    if (internalManaged && res.status === 404 && sessionId) {
      await res.text().catch(() => undefined)
      throw new UpstreamSessionExpiredError()
    }

    const contentType = res.headers.get('content-type') ?? ''
    if (contentType.includes('text/event-stream')) {
      const responseHeaders: Record<string, string> = {}
      res.headers.forEach((value, key) => {
        responseHeaders[key] = value
      })
      if (request.id === undefined) {
        // Notifications have no response id to match. Cancel the stream
        // (which may be long-lived) and return a minimal success envelope
        // for transport consistency.
        await res.body?.cancel().catch(() => undefined)
        const response: McpResponse = {
          status: res.status,
          headers: responseHeaders,
          body: { jsonrpc: '2.0' },
        }
        return { response, durationMs: performance.now() - start }
      }
      const jsonRpc = await readSseJsonRpcResponse(res, request.id)
      const response: McpResponse = { status: res.status, headers: responseHeaders, body: jsonRpc }
      return { response, durationMs: performance.now() - start }
    }

    const response = await parseUpstreamResponse(res)
    return { response, durationMs: performance.now() - start }
  }
}

/** Internal signal that a managed upstream session expired (HTTP 404). */
class UpstreamSessionExpiredError extends Error {
  constructor() {
    super('upstream session expired (HTTP 404) for Helio-managed internal session')
    this.name = 'UpstreamSessionExpiredError'
  }
}
