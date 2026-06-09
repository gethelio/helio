import { mergeUpstreamHeaders } from './merge-headers.js'
import { describeUnreachableUpstream } from './connection-error.js'

/** Protocol version Helio offers when it owns the upstream session. */
export const HELIO_MCP_PROTOCOL_VERSION = '2025-06-18'

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
    // Drain the initialize body so the connection is free for reuse.
    await res.text().catch(() => undefined)

    // Per spec, the client confirms with notifications/initialized.
    const notifyHeaders = { ...headers }
    if (sessionId) notifyHeaders['mcp-session-id'] = sessionId
    notifyHeaders['mcp-protocol-version'] = HELIO_MCP_PROTOCOL_VERSION
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
    await notifyRes.text().catch(() => undefined)

    // protocolVersion is the version Helio offered, not the upstream-negotiated
    // value (the initialize body is drained unread); reconcile when needed.
    return { sessionId, protocolVersion: HELIO_MCP_PROTOCOL_VERSION }
  }
}
