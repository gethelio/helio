// ---------------------------------------------------------------------------
// JSON-RPC 2.0 error codes
// ---------------------------------------------------------------------------

/** JSON-RPC parse error — invalid JSON received. */
export const PARSE_ERROR = -32700

/** JSON-RPC invalid request — not a valid JSON-RPC request object. */
export const INVALID_REQUEST = -32600

/** JSON-RPC invalid params — the request's params are structurally invalid. */
export const INVALID_PARAMS = -32602

/** JSON-RPC internal error — unexpected server-side failure. */
export const INTERNAL_ERROR = -32603

/**
 * MCP 2026-07-28 HeaderMismatch — a standard request header
 * (`MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`) is missing when
 * required or disagrees with the body field it mirrors. Emitted by Helio's
 * own inbound door (issue #226) and by modern upstream servers.
 */
export const HEADER_MISMATCH = -32020

// ---------------------------------------------------------------------------
// JSON-RPC types
// ---------------------------------------------------------------------------

/** A JSON-RPC 2.0 request object. */
export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number | null
  method: string
  params?: unknown
}

/** A JSON-RPC 2.0 error object. */
export interface JsonRpcErrorData {
  code: number
  message: string
  data?: unknown
}

/** A JSON-RPC 2.0 response object. */
export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id?: string | number | null
  result?: unknown
  error?: JsonRpcErrorData
}

// ---------------------------------------------------------------------------
// MCP types
// ---------------------------------------------------------------------------

/** Resolved governance session identity (issue #218). */
export interface ResolvedSession {
  readonly id: string
  /** Strategy that produced it — recorded in the audit trail. */
  readonly source: 'header' | 'meta' | 'legacy_header' | 'transport'
}

/** A parsed MCP request enriched with session context. */
export interface McpRequest extends JsonRpcRequest {
  /** Proxy-resolved governance session identity (undefined when no strategy matched). */
  session?: ResolvedSession
  /** Verbatim Mcp-Session-Id from the wire. Transport relay ONLY — never governance. */
  transportSessionId?: string
  /**
   * The client's verbatim MCP-Protocol-Version wire claim (issue #219) —
   * captured raw, with no validation or normalization, for the audit trail.
   * It is the CLIENT'S claim, not the upstream era and not a checked fact.
   * Streamable HTTP only: the header postdates the deprecated SSE transport,
   * and stdio has no headers, so both leave it unset.
   */
  protocolVersion?: string
  /** Per-request headers to forward to upstream (e.g. Authorization, X-* headers). */
  headers?: Record<string, string>
  /** Abort signal tied to the downstream client request lifecycle. */
  signal?: AbortSignal
}

/**
 * An inbound request rejected by the header/body agreement door (issue
 * #226), as protocol facts: what the body said, what the headers claimed,
 * and why they disagree. Deliberately camelCase and transport-free (no Hono
 * types, no audit field names) — the audit-record mapping lives solely in
 * `buildHeaderMismatchAuditRecord` on the audit side.
 */
export interface HeaderMismatchRejection {
  /** Human-readable mismatch reason; echoed values are display-capped. */
  readonly reason: string
  /** The body's JSON-RPC method. */
  readonly method: string
  /** The body's params, verbatim as parsed. */
  readonly params?: unknown
  /**
   * The body's name-bearing string field (`params.name` / `params.uri`),
   * when the method defines one and the body carries a string value.
   */
  readonly bodyName?: string
  /** The client's verbatim MCP-Protocol-Version wire claim, if any. */
  readonly protocolVersion?: string
  /** The inbound marker headers that were present, verbatim as received. */
  readonly headers: Readonly<Record<string, string>>
  /** Proxy-resolved governance session identity, when a strategy matched. */
  readonly session?: ResolvedSession
  /** Time from route-handler entry to rejection, in milliseconds. */
  readonly durationMs: number
}

/** The response returned by an MCP forwarder. */
export interface McpResponse {
  status: number
  headers: Record<string, string>
  body: unknown
}

/** The result of forwarding an MCP request, including timing metadata. */
export interface ForwardResult {
  response: McpResponse
  /** Time in milliseconds the upstream request took. */
  durationMs: number
}

/** Interface for forwarding MCP requests to an upstream server. */
export interface McpForwarder {
  forward(request: McpRequest): Promise<ForwardResult>
}

/**
 * Optional extension for forwarders that support Helio-internal routing.
 *
 * `forwardInternal` is used by startup/maintenance paths (e.g. annotation
 * cache priming) that may require transport-specific session handling.
 * `resetInternalSession` lets those same callers self-heal after a failed
 * attempt: drop the managed internal session (and any cached era) so the
 * next internal call re-probes from scratch instead of retrying against
 * whatever state caused the failure.
 */
export interface McpForwarderWithInternal extends McpForwarder {
  forwardInternal?(request: McpRequest): Promise<ForwardResult>
  resetInternalSession?: () => void
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a well-formed JSON-RPC 2.0 error response. */
export function makeJsonRpcError(
  id: string | number | null | undefined,
  code: number,
  message: string,
): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code, message },
  }
}

/**
 * Build a JSON-RPC 2.0 error response with the `id` member omitted entirely.
 *
 * The MCP 2026-07-28 error-response type declares `id` as optional and does
 * not permit `null`, so rejections issued before any request is parsed (no
 * id exists yet) must leave the member out rather than emit `id: null`.
 */
export function makeJsonRpcErrorWithoutId(code: number, message: string): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    error: { code, message },
  }
}
