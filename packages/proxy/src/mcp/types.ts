// ---------------------------------------------------------------------------
// JSON-RPC 2.0 error codes
// ---------------------------------------------------------------------------

/** JSON-RPC parse error — invalid JSON received. */
export const PARSE_ERROR = -32700

/** JSON-RPC invalid request — not a valid JSON-RPC request object. */
export const INVALID_REQUEST = -32600

/** JSON-RPC internal error — unexpected server-side failure. */
export const INTERNAL_ERROR = -32603

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

/** A parsed MCP request enriched with session context. */
export interface McpRequest extends JsonRpcRequest {
  /** MCP session ID extracted from the `Mcp-Session-Id` header. */
  sessionId?: string
  /** Per-request headers to forward to upstream (e.g. Authorization, X-* headers). */
  headers?: Record<string, string>
  /** Abort signal tied to the downstream client request lifecycle. */
  signal?: AbortSignal
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
 */
export interface McpForwarderWithInternal extends McpForwarder {
  forwardInternal?(request: McpRequest): Promise<ForwardResult>
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
