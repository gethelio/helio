import type { ToolAnnotationHints } from './types.js'

/**
 * Cache for tool annotations extracted from MCP tools/list responses.
 *
 * The proxy populates this cache by intercepting tools/list responses from
 * the upstream MCP server. Cached annotations are used to build the
 * MatchContext for policy evaluation on subsequent tools/call requests.
 */
export class ToolAnnotationCache {
  private cache = new Map<string, ToolAnnotationHints | undefined>()

  /** Number of tools currently cached. */
  get size(): number {
    return this.cache.size
  }

  /**
   * Update the cache from a tools/list JSON-RPC response body.
   *
   * Performs a full replacement — tools that existed in the previous cache
   * but are absent from the new response are removed. This correctly handles
   * tool list changes (additions, removals, annotation updates).
   *
   * @returns `true` if the response body was a valid tools/list response and
   *   the cache was updated, `false` if the body shape was unexpected.
   */
  update(responseBody: unknown): boolean {
    const tools = extractTools(responseBody)
    if (!tools) return false

    this.cache.clear()
    for (const tool of tools) {
      if (typeof tool !== 'object' || tool === null) continue
      const t = tool as Record<string, unknown>
      const name = t['name']
      if (typeof name !== 'string') continue

      const annotations = t['annotations']
      if (annotations && typeof annotations === 'object') {
        this.cache.set(name, annotations as ToolAnnotationHints)
      } else {
        // Tool exists but has no annotations — store as undefined
        // (distinct from "tool not in cache")
        this.cache.set(name, undefined)
      }
    }

    return true
  }

  /** Get cached annotations for a tool. Returns `undefined` if the tool is not in the cache. */
  get(toolName: string): ToolAnnotationHints | undefined {
    return this.cache.get(toolName)
  }

  /** Check whether a tool exists in the cache (regardless of whether it has annotations). */
  has(toolName: string): boolean {
    return this.cache.has(toolName)
  }
}

/**
 * Extract the tools array from a JSON-RPC response body.
 *
 * Expected shape: `{ result: { tools: [...] } }`
 * Returns null if the shape doesn't match.
 */
function extractTools(body: unknown): unknown[] | null {
  if (typeof body !== 'object' || body === null) return null
  const b = body as Record<string, unknown>
  const result = b['result']
  if (typeof result !== 'object' || result === null) return null
  const r = result as Record<string, unknown>
  const tools = r['tools']
  if (!Array.isArray(tools)) return null
  return tools as unknown[]
}
