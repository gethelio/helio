import { describe, it, expect } from 'vitest'
import { normalizeUpstreamOutcome } from './response-normalizer.js'
import type { McpResponse } from '../mcp/types.js'

function makeUpstreamResponse(
  body: unknown,
  status = 200,
  contentType = 'application/json',
): McpResponse {
  return {
    status,
    headers: { 'content-type': contentType },
    body,
  }
}

describe('normalizeUpstreamOutcome', () => {
  it('passes through valid JSON-RPC success body and normalizes HTTP status to 200', () => {
    const outcome = normalizeUpstreamOutcome({
      requestId: 7,
      upstreamResponse: makeUpstreamResponse({ jsonrpc: '2.0', id: 7, result: { ok: true } }, 500),
    })

    expect(outcome.httpStatus).toBe(200)
    expect(outcome.wrapped).toBe(false)
    expect(outcome.body).toEqual({ jsonrpc: '2.0', id: 7, result: { ok: true } })
  })

  it('passes through valid JSON-RPC error body unchanged', () => {
    const outcome = normalizeUpstreamOutcome({
      requestId: 11,
      upstreamResponse: makeUpstreamResponse(
        { jsonrpc: '2.0', id: 11, error: { code: -32042, message: 'upstream denied' } },
        404,
      ),
    })

    expect(outcome.httpStatus).toBe(200)
    expect(outcome.wrapped).toBe(false)
    expect(outcome.body).toEqual({
      jsonrpc: '2.0',
      id: 11,
      error: { code: -32042, message: 'upstream denied' },
    })
  })

  it('wraps non-JSON-RPC upstream body and excludes raw body excerpt', () => {
    const outcome = normalizeUpstreamOutcome({
      requestId: 1009,
      upstreamResponse: makeUpstreamResponse('upstream failed', 500, 'text/plain'),
    })

    const body = outcome.body as { error?: { code?: number; data?: Record<string, unknown> } }
    const error = body.error as { code: number; data: Record<string, unknown> }

    expect(outcome.httpStatus).toBe(200)
    expect(outcome.wrapped).toBe(true)
    expect(error.code).toBe(-32603)
    expect(error.data['failure_class']).toBe('upstream_invalid_jsonrpc')
    expect(error.data['upstream_http_status']).toBe(500)
    expect(error.data['upstream_content_type']).toBe('text/plain')
    expect(error.data['upstream_body_type']).toBe('string')
    expect(error.data['upstream_body_excerpt']).toBeUndefined()
  })

  it('wraps forwarding exceptions with upstream_forward_error class', () => {
    const outcome = normalizeUpstreamOutcome({
      requestId: 42,
      forwardingError: new Error('upstream request timed out after 30000ms'),
    })
    const body = outcome.body as { error?: { code?: number; data?: Record<string, unknown> } }
    const error = body.error as { code: number; data: Record<string, unknown> }

    expect(outcome.httpStatus).toBe(200)
    expect(outcome.wrapped).toBe(true)
    expect(error.code).toBe(-32603)
    expect(error.data['failure_class']).toBe('upstream_forward_error')
    expect(error.data['failure_reason']).toContain('timed out')
  })

  it('treats response id mismatch as invalid upstream response in strict mode', () => {
    const outcome = normalizeUpstreamOutcome({
      requestId: 5,
      upstreamResponse: makeUpstreamResponse({ jsonrpc: '2.0', id: 999, result: { ok: true } }),
    })
    const body = outcome.body as { error?: { data?: Record<string, unknown> } }
    const error = body.error as { data: Record<string, unknown> }

    expect(outcome.wrapped).toBe(true)
    expect(error.data['failure_class']).toBe('upstream_id_mismatch')
    expect(error.data['expected_request_id']).toBe(5)
    expect(error.data['upstream_response_id']).toBe(999)
  })

  it('wraps upstream JSON-RPC response missing id for non-notification requests', () => {
    const outcome = normalizeUpstreamOutcome({
      requestId: 5,
      upstreamResponse: makeUpstreamResponse({ jsonrpc: '2.0', result: { ok: true } }),
    })
    const body = outcome.body as { error?: { data?: Record<string, unknown> } }
    const error = body.error as { data: Record<string, unknown> }

    expect(outcome.wrapped).toBe(true)
    expect(error.data['failure_class']).toBe('upstream_invalid_jsonrpc')
    expect(error.data['invalid_reason']).toBe('missing_response_id')
  })

  it('does not enforce id match for notification-style requests without request id', () => {
    const outcome = normalizeUpstreamOutcome({
      requestId: undefined,
      upstreamResponse: makeUpstreamResponse({ jsonrpc: '2.0', id: 123, result: { ok: true } }),
    })

    expect(outcome.wrapped).toBe(false)
    expect(outcome.body).toEqual({ jsonrpc: '2.0', id: 123, result: { ok: true } })
  })
})
