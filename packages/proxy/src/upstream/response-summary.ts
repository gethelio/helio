/**
 * Lightweight summary of a stored tool outcome.
 *
 * Used when `audit.include_responses` is false to record what happened
 * (success/error, content shape) without storing the full body. Two
 * shapes feed it: the MCP door stores a JSON-RPC response envelope
 * ({@link extractResponseSummary}), the sideband door stores the adapter's
 * bare tool result ({@link summarizeToolResult}). On an envelope summary
 * `has_error` means a JSON-RPC `error` member was present; on a sideband
 * summary it means the adapter reported `status: error`, and `error_code`
 * is always null because a bare result carries no JSON-RPC code.
 */
export interface ResponseSummary {
  readonly success: boolean
  readonly has_error: boolean
  readonly error_code: number | null
  readonly content_types: string[]
  readonly content_count: number
}

/**
 * Extract a privacy-safe summary from an upstream MCP response body.
 *
 * Inspects the JSON-RPC structure to determine success/error status and,
 * for successful MCP `tools/call` results, extracts the content type list
 * from the standard `result.content[]` array.
 */
export function extractResponseSummary(body: unknown): ResponseSummary {
  if (body == null || typeof body !== 'object') {
    return {
      success: false,
      has_error: false,
      error_code: null,
      content_types: [],
      content_count: 0,
    }
  }

  const obj = body as Record<string, unknown>

  // Detect JSON-RPC error
  let hasError = false
  let errorCode: number | null = null
  const error = obj['error']
  if (error != null && typeof error === 'object') {
    hasError = true
    const code = (error as Record<string, unknown>)['code']
    errorCode = typeof code === 'number' ? code : null
  }

  const success = obj['result'] !== undefined && !hasError

  // Extract MCP content types from result.content[]; a failed envelope
  // keeps an empty content list even when a result was present
  const { contentTypes, contentCount } = success
    ? walkContent(obj['result'])
    : { contentTypes: [], contentCount: 0 }

  return {
    success,
    has_error: hasError,
    error_code: errorCode,
    content_types: contentTypes,
    content_count: contentCount,
  }
}

/**
 * Summarize a bare MCP tool result, the shape the sideband door stores
 * from an adapter's `/audit` report.
 *
 * A bare result has no JSON-RPC envelope, so its outcome comes from the
 * caller: `failed` is true when the adapter reported `status: error`
 * (the row's `upstream_error` is set). `isError` on the result is not
 * read, matching the envelope reading of `result.isError`. Content types
 * are still counted on a failed result, since the adapter supplied them.
 */
export function summarizeToolResult(result: unknown, failed: boolean): ResponseSummary {
  const { contentTypes, contentCount } = walkContent(result)
  return {
    success: !failed,
    has_error: failed,
    error_code: null,
    content_types: contentTypes,
    content_count: contentCount,
  }
}

// ---------------------------------------------------------------------------
// Content walk shared by both summarizers
// ---------------------------------------------------------------------------

/**
 * Read the MCP content type list from a tool result's `content[]` array.
 * Anything that is not an object with an array `content` yields no types.
 */
function walkContent(result: unknown): {
  readonly contentTypes: string[]
  readonly contentCount: number
} {
  if (result == null || typeof result !== 'object') {
    return { contentTypes: [], contentCount: 0 }
  }
  const content = (result as Record<string, unknown>)['content']
  if (!Array.isArray(content)) {
    return { contentTypes: [], contentCount: 0 }
  }
  const types = new Set<string>()
  for (const item of content) {
    if (
      item != null &&
      typeof item === 'object' &&
      typeof (item as Record<string, unknown>)['type'] === 'string'
    ) {
      types.add((item as Record<string, unknown>)['type'] as string)
    }
  }
  return { contentTypes: [...types].sort(), contentCount: content.length }
}
