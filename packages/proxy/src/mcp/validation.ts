import { z } from 'zod'

// ---------------------------------------------------------------------------
// JSON-RPC request envelope schema
// ---------------------------------------------------------------------------

const jsonRpcRequestSchema = z.looseObject({
  jsonrpc: z.literal('2.0'),
  method: z.string(),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  params: z.unknown().optional(),
})

export interface ParsedJsonRpcRequest {
  readonly jsonrpc: '2.0'
  readonly method: string
  readonly id?: string | number | null
  readonly params?: unknown
}

/**
 * Safely extract the JSON-RPC `id` field, returning `null` for invalid types.
 */
export function extractId(raw: unknown): string | number | null {
  if (raw === null) return null
  if (typeof raw === 'string' || typeof raw === 'number') return raw
  return null
}

/**
 * Validate that a parsed JSON body is a well-formed JSON-RPC 2.0 request.
 * Returns an error message string if invalid, or `null` if valid.
 */
export function validateJsonRpc(body: unknown): string | null {
  const parsed = parseJsonRpcRequest(body)
  return parsed.success ? null : parsed.message
}

export type JsonRpcParseResult =
  | { success: true; request: ParsedJsonRpcRequest }
  | { success: false; id: string | number | null; message: string }

/**
 * Parse a JSON-RPC request envelope using Zod while preserving the transport
 * error messages expected by existing clients and tests.
 */
export function parseJsonRpcRequest(body: unknown): JsonRpcParseResult {
  if (Array.isArray(body)) {
    return { success: false, id: null, message: 'batch requests not supported' }
  }
  if (body === null || typeof body !== 'object') {
    return { success: false, id: null, message: 'request body must be a JSON object' }
  }

  const parsed = jsonRpcRequestSchema.safeParse(body)
  if (!parsed.success) {
    const obj = body as Record<string, unknown>

    // Preserve existing human-readable messages for the core envelope fields.
    for (const issue of parsed.error.issues) {
      const firstPath = issue.path[0]
      if (firstPath === 'jsonrpc') {
        return {
          success: false,
          id: extractId(obj['id']),
          message: 'missing or invalid "jsonrpc" field (must be "2.0")',
        }
      }
      if (firstPath === 'method') {
        return {
          success: false,
          id: extractId(obj['id']),
          message: 'missing or invalid "method" field (must be a string)',
        }
      }
      if (firstPath === 'id') {
        return {
          success: false,
          id: null,
          message: 'invalid "id" field (must be string, number, or null)',
        }
      }
    }

    return {
      success: false,
      id: extractId(obj['id']),
      message: 'invalid JSON-RPC request',
    }
  }

  return {
    success: true,
    request: {
      jsonrpc: parsed.data.jsonrpc,
      method: parsed.data.method,
      ...(parsed.data.id !== undefined && { id: extractId(parsed.data.id) }),
      ...(parsed.data.params !== undefined && { params: parsed.data.params }),
    },
  }
}
