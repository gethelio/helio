import type { McpForwarder, McpRequest, ForwardResult, McpResponse } from '../mcp/types.js'
import { parseUpstreamResponse } from './response.js'
import { readSseJsonRpcResponse } from './sse-parse.js'
import { mergeUpstreamHeaders } from './merge-headers.js'
import {
  buildStandardRequestHeaders,
  encodedNameValue,
  isHeaderSafeMethod,
  MCP_NAME_MAX_BYTES,
} from './standard-headers.js'
import { describeUnreachableUpstream } from './connection-error.js'
import {
  UpstreamSessionManager,
  HELIO_MCP_LEGACY_PROTOCOL_VERSION,
  HELIO_MCP_MODERN_PROTOCOL_VERSION,
  MCP_META_PROTOCOL_VERSION_KEY,
  MCP_MODERN_ONLY_ERROR_CODES,
  buildInternalMeta,
  type UpstreamEra,
  type UpstreamProtocolVersionPin,
} from './upstream-session-manager.js'

/** The spec-mandated modern answer to the retired initialize handshake. */
const JSON_RPC_METHOD_NOT_FOUND = -32601

/**
 * The session shape `send()` needs. `forwardInternal()` passes a real
 * `UpstreamSession`; `forward()` supplies the transport session id plus the
 * era `resolveRelayEra()` concluded — `era: 'modern'` alone switches the
 * send to modern semantics, on both paths.
 */
interface SendSession {
  readonly sessionId: string | undefined
  readonly protocolVersion: string | undefined
  readonly era?: UpstreamEra
}

export interface StreamableHttpForwarderOptions {
  /** The upstream MCP server URL (e.g. "http://localhost:8080/mcp"). */
  url: string
  /** Static headers to include on every upstream request (e.g. API keys). */
  headers?: Record<string, string>
  /** Maximum time to wait for an upstream request before aborting. */
  requestTimeoutMs?: number
  /** `upstream.protocol_version`: `auto` (default) probes; a dated pin skips it. */
  protocolVersion?: UpstreamProtocolVersionPin
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
      protocolVersion: options.protocolVersion,
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
    const era = await this.sessions.resolveRelayEra()

    if (era === 'modern') {
      // The modern upstream retired the handshake: it answers a forwarded
      // `initialize` with 404/-32601 and never expects the confirmation
      // notification. Helio bridges the legacy client instead.
      if (request.method === 'initialize') {
        return this.synthesizeInitializeResult(request)
      }
      if (request.method === 'notifications/initialized') {
        return this.swallowInitializedNotification()
      }
      // Modern relay: no wire session id upstream (modern servers neither
      // mint nor honor one) — `send()` handles the version stamp, the
      // `_meta` mirror, and the response session-echo strip.
      return this.send(request, {
        sessionId: undefined,
        protocolVersion: undefined,
        era: 'modern',
      })
    }

    // Era legacy (cached, pinned, or presumed): byte-for-byte today's
    // behavior, plus the falsification inspection on the outcome.
    //
    // `initialize` is transport machinery: forward verbatim, never inject a
    // managed session, and let the response's Mcp-Session-Id flow downstream.
    // Only the verbatim transport session id ever reaches the wire — a
    // proxy-resolved governance id would be rejected by session-enforcing
    // upstreams that never minted it (issue #218).
    const result =
      request.method === 'initialize'
        ? await this.send(request, {
            sessionId: request.transportSessionId,
            protocolVersion: undefined,
          })
        : // Downstream-driven and external sessionless callers alike are
          // transparent passthrough: forward whatever session the caller did
          // (or did not) supply.
          await this.send(request, {
            sessionId: request.transportSessionId,
            protocolVersion: HELIO_MCP_LEGACY_PROTOCOL_VERSION,
          })

    this.inspectLegacyRelayOutcome(request, result.response)
    return result
  }

  /**
   * The dual-era bridge (relay leg, modern era): a modern-only server
   * answers the retired `initialize` handshake with 404/-32601, so Helio
   * synthesizes the legacy InitializeResult locally from the upstream's own
   * probe-time DiscoverResult. No `mcp-session-id` response header — the
   * legacy spec permits sessionless servers, and the downstream stays
   * sessionless. The synthesized protocolVersion is always the current
   * legacy revision, even for a client that offered an older one.
   */
  private synthesizeInitializeResult(request: McpRequest): ForwardResult {
    const capture = this.sessions.getDiscoverCapture()
    const result: Record<string, unknown> = {
      protocolVersion: HELIO_MCP_LEGACY_PROTOCOL_VERSION,
      capabilities: capture?.capabilities ?? { tools: {} },
      // NOT copied from upstream: the 2026-07-28 DiscoverResult has no
      // serverInfo field at all, and the bridge is Helio's own construct —
      // matching buildInternalMeta()'s identity.
      serverInfo: { name: 'helio-proxy', version: '0' },
    }
    if (capture?.instructions !== undefined) {
      result['instructions'] = capture.instructions
    }
    const response: McpResponse = {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: { jsonrpc: '2.0', id: request.id ?? null, result },
    }
    return { response, durationMs: 0 }
  }

  /**
   * The modern upstream removed `notifications/initialized`; answer the
   * same minimal success envelope the SSE-notification path returns.
   */
  private swallowInitializedNotification(): ForwardResult {
    const response: McpResponse = { status: 200, headers: {}, body: { jsonrpc: '2.0' } }
    return { response, durationMs: 0 }
  }

  /**
   * The relay-side era falsification door (issue #219): a legacy-leg relay whose answer only a
   * modern server gives clears the cached legacy era (the manager no-ops on
   * pins, uncached eras, and cached modern). The response still flows to the
   * client unchanged — no in-place retry.
   */
  private inspectLegacyRelayOutcome(request: McpRequest, response: McpResponse): void {
    const errorCode = readJsonRpcErrorCode(response.body)
    if (errorCode !== undefined && MCP_MODERN_ONLY_ERROR_CODES.has(errorCode)) {
      this.sessions.clearFalsifiedLegacyEra(
        `a relayed response carried the modern-only JSON-RPC error ${String(errorCode)}`,
      )
      return
    }
    if (
      request.method === 'initialize' &&
      (response.status === 404 || errorCode === JSON_RPC_METHOD_NOT_FOUND)
    ) {
      this.sessions.clearFalsifiedLegacyEra(
        response.status === 404
          ? 'a relayed initialize was answered with HTTP 404'
          : 'a relayed initialize was answered with JSON-RPC -32601',
      )
    }
  }

  /**
   * Helio-internal execution path (startup prime / internal maintenance) that
   * may borrow the proxy-managed internal session.
   */
  async forwardInternal(request: McpRequest): Promise<ForwardResult> {
    const session = await this.sessions.ensureInternalSession()
    try {
      return await this.send(request, session, /* internalManaged */ true)
    } catch (error) {
      if (error instanceof UpstreamSessionExpiredError) {
        this.sessions.invalidateInternalSession()
        const fresh = await this.sessions.ensureInternalSession()
        return this.send(request, fresh, /* internalManaged */ true)
      }
      throw error
    }
  }

  /** Drop the managed internal session AND the cached era; next internal call re-probes. */
  resetInternalSession(): void {
    this.sessions.invalidateInternalSession()
  }

  private async send(
    request: McpRequest,
    session: SendSession,
    internalManaged = false,
  ): Promise<ForwardResult> {
    // Standard request headers — `mcp-method`, and `mcp-name` on the three
    // name-bearing methods — are stamped on every outbound POST from send(),
    // relay and internal alike, derived from the request's own body. The
    // modern (2026-07-28) version header and `_meta` mirror apply to every
    // modern-era send: internal traffic and, since the relay leg became
    // era-aware, relayed client traffic too.
    const modern = session.era === 'modern'

    // Compute the exact object that will be assigned to `body['params']`
    // ONCE, up front, so the standard-headers helper below and the body
    // assignment further down both read the SAME reference. The modern
    // branch rewrites params into a brand-new object (spread + injected
    // `_meta`) rather than forwarding `request.params` verbatim — deriving
    // the header from `request.params` instead would let an inherited or
    // non-enumerable `toJSON` on the original (dropped by the spread, since
    // object spread copies only own-enumerable properties) or a
    // `_meta`-reading `toJSON` (which only sees `_meta` on the NEW object)
    // diverge the header from whatever actually gets serialized onto the
    // wire. In the legacy branch `outboundParams` is `request.params`
    // itself, so behavior there is unchanged.
    let outboundParams: unknown
    if (modern) {
      // Present-but-not-plain-object params (an array — legal JSON-RPC
      // by-position params — or a primitive) cannot carry the spec-required
      // `_meta` mirror: spreading would silently corrupt them into a
      // numeric-keyed object, and forwarding without the mirror guarantees
      // an opaque upstream rejection. Refuse proxy-side with the reason.
      if (request.params !== undefined && !isPlainObject(request.params)) {
        throw new Error(
          'helio refused to forward: MCP 2026-07-28 requires the _meta mirror inside ' +
            'params, which cannot be attached to array or primitive params; send object ' +
            'params or none',
        )
      }
      const params = request.params ?? {}
      // A non-object `_meta` is non-conformant to begin with; the required
      // mirror replaces it rather than being spread into nonsense.
      const rawMeta = params['_meta']
      const existingMeta = isPlainObject(rawMeta) ? rawMeta : {}
      // Per-key merge: the protocol version is ALWAYS Helio's (it must equal
      // the stamped header — agreement holds by construction); a client's
      // own clientCapabilities/clientInfo pass through when present, so
      // capability-gated upstream behavior stays reachable for modern
      // clients; Helio's identity fills the gaps for legacy clients.
      const internalMeta = buildInternalMeta()
      const clientCapabilities = existingMeta['io.modelcontextprotocol/clientCapabilities']
      const clientInfo = existingMeta['io.modelcontextprotocol/clientInfo']
      outboundParams = {
        ...params,
        _meta: {
          ...existingMeta,
          [MCP_META_PROTOCOL_VERSION_KEY]: HELIO_MCP_MODERN_PROTOCOL_VERSION,
          'io.modelcontextprotocol/clientCapabilities':
            clientCapabilities !== undefined
              ? clientCapabilities
              : internalMeta['io.modelcontextprotocol/clientCapabilities'],
          'io.modelcontextprotocol/clientInfo':
            clientInfo !== undefined
              ? clientInfo
              : internalMeta['io.modelcontextprotocol/clientInfo'],
        },
      }
    } else {
      outboundParams = request.params
    }

    // On the modern leg the two silent omission fallbacks stop being safe:
    // a missing `Mcp-Method` or `Mcp-Name` is a guaranteed -32020 from a
    // 2026-07-28 upstream, strictly worse than a clear proxy-side refusal.
    // Both checks read the SAME inputs the stamping below reads. The legacy
    // leg keeps omission (an ignored header is a harmless fallback there),
    // and a non-string name stays an omission on both legs — the body
    // carries no string value for the header to mirror.
    if (modern) {
      if (!isHeaderSafeMethod(request.method)) {
        throw new Error(
          'helio refused to forward: the request method cannot be carried in the ' +
            'Mcp-Method header that MCP 2026-07-28 requires (it contains characters ' +
            'outside the visible-ASCII token set), so the upstream is guaranteed to ' +
            'reject the request',
        )
      }
      const nameValue = encodedNameValue(request.method, outboundParams)
      if (nameValue !== undefined && Buffer.byteLength(nameValue) > MCP_NAME_MAX_BYTES) {
        throw new Error(
          `helio refused to forward: params.name/uri exceeds the ` +
            `${String(MCP_NAME_MAX_BYTES)}-byte Mcp-Name header cap after encoding, and ` +
            'MCP 2026-07-28 requires the header on this method; shorten the name or uri',
        )
      }
    }

    const headers = mergeUpstreamHeaders(
      {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      request.headers ?? {},
      this.staticHeaders,
    )
    // An internal modern session never mints or echoes a session id (see
    // UpstreamSessionManager#modernSession) and modern relays pass
    // sessionId: undefined, so this never fires on a modern send.
    if (session.sessionId) headers['mcp-session-id'] = session.sessionId
    if (modern) {
      // Modern servers neither mint nor honor session ids: whatever the
      // downstream presented (transport field or raw header), none of it
      // may reach the wire.
      delete headers['mcp-session-id']
      headers['mcp-protocol-version'] = HELIO_MCP_MODERN_PROTOCOL_VERSION
    } else if (session.protocolVersion && headers['mcp-protocol-version'] === undefined) {
      headers['mcp-protocol-version'] = session.protocolVersion
    }
    // Omission must be authoritative: an absent key means Helio chose not to
    // mirror, never that a caller-supplied value survived the merge above.
    delete headers['mcp-method']
    delete headers['mcp-name']
    Object.assign(headers, buildStandardRequestHeaders(request.method, outboundParams))

    const body: Record<string, unknown> = {
      jsonrpc: request.jsonrpc,
      method: request.method,
    }
    if (request.id !== undefined) body['id'] = request.id
    if (modern) {
      body['params'] = outboundParams
    } else if (request.params !== undefined) {
      body['params'] = outboundParams
    }

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
    if (internalManaged && res.status === 404 && session.sessionId) {
      await res.text().catch(() => undefined)
      throw new UpstreamSessionExpiredError()
    }

    const contentType = res.headers.get('content-type') ?? ''
    if (contentType.includes('text/event-stream')) {
      const responseHeaders: Record<string, string> = {}
      res.headers.forEach((value, key) => {
        responseHeaders[key] = value
      })
      // A conformant modern upstream never sets mcp-session-id; a
      // non-conformant one must not teach the downstream client a session
      // Helio will not relay back. This SSE branch copies ALL upstream
      // headers verbatim, so without the strip here the header would leak
      // through the route allowlist whenever a modern upstream answers
      // text/event-stream — the strip must cover BOTH response branches.
      if (modern) delete responseHeaders['mcp-session-id']
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
    // The JSON-branch half of the modern response strip (see the SSE branch
    // above for the rationale).
    if (modern) delete response.headers['mcp-session-id']
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

/** Plain object: what the `_meta` mirror can be attached to. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The JSON-RPC error code of a parsed response body, when one exists. */
function readJsonRpcErrorCode(body: unknown): number | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const error = (body as Record<string, unknown>)['error']
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as Record<string, unknown>)['code']
  return typeof code === 'number' ? code : undefined
}
