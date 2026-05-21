/**
 * Lightweight summary of an upstream JSON-RPC response.
 *
 * Used when `audit.include_responses` is false to record what happened
 * (success/error, content shape) without storing the full response body.
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

  // Extract MCP content types from result.content[]
  let contentTypes: string[] = []
  let contentCount = 0

  if (success) {
    const result = obj['result']
    if (result != null && typeof result === 'object') {
      const content = (result as Record<string, unknown>)['content']
      if (Array.isArray(content)) {
        contentCount = content.length
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
        contentTypes = [...types].sort()
      }
    }
  }

  return {
    success,
    has_error: hasError,
    error_code: errorCode,
    content_types: contentTypes,
    content_count: contentCount,
  }
}
