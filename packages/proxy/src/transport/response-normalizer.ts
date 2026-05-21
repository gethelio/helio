import { INTERNAL_ERROR } from '../mcp/types.js'
import type { JsonRpcResponse, McpResponse } from '../mcp/types.js'

/**
 * Input for normalizing an upstream forwarding outcome into a JSON-RPC response.
 */
export interface NormalizeUpstreamOutcomeArgs {
  /** JSON-RPC id from the downstream request (undefined for notifications). */
  readonly requestId: string | number | null | undefined
  /** Parsed upstream response when forwarding succeeds. */
  readonly upstreamResponse?: McpResponse
  /** Forwarding exception when upstream request fails before receiving a response. */
  readonly forwardingError?: Error
}

/**
 * Result of response normalization used by transport handlers.
 */
export interface NormalizeUpstreamOutcomeResult {
  /** HTTP status for the transport response (always 200 for normalized JSON-RPC). */
  readonly httpStatus: 200
  /** JSON-RPC response body returned to the client. */
  readonly body: JsonRpcResponse
  /** Whether the normalizer wrapped the upstream outcome into an internal error. */
  readonly wrapped: boolean
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function isValidJsonRpcId(value: unknown): value is string | number | null {
  return value === null || typeof value === 'string' || typeof value === 'number'
}

function getJsonRpcId(value: unknown): string | number | null | undefined {
  if (!isObject(value) || !Object.prototype.hasOwnProperty.call(value, 'id')) return undefined
  const id = value['id']
  return isValidJsonRpcId(id) ? id : undefined
}

function isValidJsonRpcError(value: unknown): boolean {
  if (!isObject(value)) return false
  return typeof value['code'] === 'number' && typeof value['message'] === 'string'
}

function isValidJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  if (!isObject(value)) return false
  if (value['jsonrpc'] !== '2.0') return false

  if (Object.prototype.hasOwnProperty.call(value, 'id') && !isValidJsonRpcId(value['id'])) {
    return false
  }

  const hasResult = Object.prototype.hasOwnProperty.call(value, 'result')
  const hasError = Object.prototype.hasOwnProperty.call(value, 'error')
  if ((hasResult && hasError) || (!hasResult && !hasError)) return false

  if (hasError && !isValidJsonRpcError(value['error'])) return false
  return true
}

function makeWrappedError(
  requestId: string | number | null | undefined,
  message: string,
  data: Record<string, unknown>,
): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id: requestId ?? null,
    error: {
      code: INTERNAL_ERROR,
      message,
      data,
    },
  }
}

/**
 * Normalize upstream responses and forwarding errors into a consistent JSON-RPC envelope.
 *
 * Transport routes call this helper after forwarding. Valid JSON-RPC upstream responses
 * pass through (with transport status normalized to HTTP 200). Malformed upstream payloads,
 * id mismatches, and forwarding exceptions are wrapped as JSON-RPC internal errors.
 */
export function normalizeUpstreamOutcome(
  args: NormalizeUpstreamOutcomeArgs,
): NormalizeUpstreamOutcomeResult {
  if (args.forwardingError) {
    return {
      httpStatus: 200,
      wrapped: true,
      body: makeWrappedError(args.requestId, 'upstream forwarding failed', {
        failure_class: 'upstream_forward_error',
        failure_reason: args.forwardingError.message,
      }),
    }
  }

  if (!args.upstreamResponse) {
    return {
      httpStatus: 200,
      wrapped: true,
      body: makeWrappedError(args.requestId, 'upstream forwarding failed', {
        failure_class: 'upstream_forward_error',
        failure_reason: 'missing upstream response',
      }),
    }
  }

  const upstream = args.upstreamResponse
  const upstreamContentType = upstream.headers['content-type'] ?? null

  if (!isValidJsonRpcResponse(upstream.body)) {
    return {
      httpStatus: 200,
      wrapped: true,
      body: makeWrappedError(args.requestId, 'upstream returned invalid JSON-RPC response', {
        failure_class: 'upstream_invalid_jsonrpc',
        upstream_http_status: upstream.status,
        upstream_content_type: upstreamContentType,
        upstream_body_type: typeof upstream.body,
      }),
    }
  }

  if (args.requestId !== undefined) {
    const upstreamId = getJsonRpcId(upstream.body)
    if (upstreamId === undefined) {
      return {
        httpStatus: 200,
        wrapped: true,
        body: makeWrappedError(args.requestId, 'upstream returned invalid JSON-RPC response', {
          failure_class: 'upstream_invalid_jsonrpc',
          upstream_http_status: upstream.status,
          upstream_content_type: upstreamContentType,
          upstream_body_type: typeof upstream.body,
          invalid_reason: 'missing_response_id',
        }),
      }
    }
    const expectedId = args.requestId ?? null
    if (upstreamId !== expectedId) {
      return {
        httpStatus: 200,
        wrapped: true,
        body: makeWrappedError(args.requestId, 'upstream response id mismatch', {
          failure_class: 'upstream_id_mismatch',
          expected_request_id: expectedId,
          upstream_response_id: upstreamId,
        }),
      }
    }
  }

  return {
    httpStatus: 200,
    wrapped: false,
    body: upstream.body,
  }
}
