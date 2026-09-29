import type { ToolAnnotationHints } from './types.js'

// ---------------------------------------------------------------------------
// One definition of a valid tool entry, shared by the annotation cache (the
// governed path's drift baselines) and helio scan (issue #299).
// ---------------------------------------------------------------------------

/** The four MCP hint keys `matchAnnotations` reads. */
export const HINT_KEYS = [
  'readOnlyHint',
  'destructiveHint',
  'idempotentHint',
  'openWorldHint',
] as const

/**
 * Pick the four hints onto a fresh object. A present key is copied whatever
 * its value (a nested object value is shared, a stated residual that
 * `matchAnnotations` never dereferences); an absent source stays undefined.
 */
export function pickHints(
  source: ToolAnnotationHints | undefined,
): ToolAnnotationHints | undefined {
  if (source === undefined) return undefined
  const picked: Record<string, unknown> = {}
  for (const key of HINT_KEYS) {
    if (key in source) picked[key] = source[key]
  }
  return picked as ToolAnnotationHints
}

/** Extract the annotations object from a raw tool definition. */
export function extractAnnotations(tool: Record<string, unknown>): ToolAnnotationHints | undefined {
  const annotations = tool['annotations']
  return annotations && typeof annotations === 'object'
    ? (annotations as ToolAnnotationHints)
    : undefined
}

/**
 * Extract the tools array from a JSON-RPC response body.
 *
 * Expected shape: `{ result: { tools: [...] } }`
 * Returns null if the shape doesn't match.
 */
export function extractTools(body: unknown): unknown[] | null {
  if (typeof body !== 'object' || body === null) return null
  const b = body as Record<string, unknown>
  const result = b['result']
  if (typeof result !== 'object' || result === null) return null
  const r = result as Record<string, unknown>
  const tools = r['tools']
  if (!Array.isArray(tools)) return null
  return tools as unknown[]
}
