import { describe, it, expect } from 'vitest'
import { ToolAnnotationCache } from './annotation-cache.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a valid tools/list JSON-RPC response body. */
function toolsListResponse(tools: Array<{ name: string; annotations?: Record<string, boolean> }>) {
  return {
    jsonrpc: '2.0',
    id: 1,
    result: { tools },
  }
}

// ---------------------------------------------------------------------------
// ToolAnnotationCache
// ---------------------------------------------------------------------------

describe('ToolAnnotationCache', () => {
  it('starts empty', () => {
    const cache = new ToolAnnotationCache()
    expect(cache.size).toBe(0)
    expect(cache.has('anything')).toBe(false)
  })

  it('updates from a valid tools/list response', () => {
    const cache = new ToolAnnotationCache()
    const ok = cache.update(
      toolsListResponse([
        { name: 'get_weather', annotations: { readOnlyHint: true } },
        { name: 'send_email', annotations: { readOnlyHint: false } },
      ]),
    )
    expect(ok).toBe(true)
    expect(cache.size).toBe(2)
    expect(cache.has('get_weather')).toBe(true)
    expect(cache.has('send_email')).toBe(true)
    expect(cache.get('get_weather')).toEqual({ readOnlyHint: true })
    expect(cache.get('send_email')).toEqual({ readOnlyHint: false })
  })

  it('stores tools without annotations as undefined', () => {
    const cache = new ToolAnnotationCache()
    cache.update(toolsListResponse([{ name: 'plain_tool' }]))
    expect(cache.size).toBe(1)
    expect(cache.has('plain_tool')).toBe(true)
    expect(cache.get('plain_tool')).toBeUndefined()
  })

  it('replaces entire cache on subsequent updates', () => {
    const cache = new ToolAnnotationCache()

    cache.update(
      toolsListResponse([
        { name: 'tool_a', annotations: { readOnlyHint: true } },
        { name: 'tool_b', annotations: { destructiveHint: true } },
      ]),
    )
    expect(cache.size).toBe(2)
    expect(cache.has('tool_a')).toBe(true)

    // Second update replaces — tool_a is gone
    cache.update(toolsListResponse([{ name: 'tool_c', annotations: { readOnlyHint: false } }]))
    expect(cache.size).toBe(1)
    expect(cache.has('tool_a')).toBe(false)
    expect(cache.has('tool_b')).toBe(false)
    expect(cache.has('tool_c')).toBe(true)
  })

  it('returns false for null body', () => {
    const cache = new ToolAnnotationCache()
    expect(cache.update(null)).toBe(false)
    expect(cache.size).toBe(0)
  })

  it('returns false for non-object body', () => {
    const cache = new ToolAnnotationCache()
    expect(cache.update('not an object')).toBe(false)
  })

  it('returns false for body without result', () => {
    const cache = new ToolAnnotationCache()
    expect(cache.update({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'fail' } })).toBe(
      false,
    )
  })

  it('returns false for result without tools array', () => {
    const cache = new ToolAnnotationCache()
    expect(cache.update({ jsonrpc: '2.0', id: 1, result: { prompts: [] } })).toBe(false)
  })

  it('returns false for result.tools that is not an array', () => {
    const cache = new ToolAnnotationCache()
    expect(cache.update({ jsonrpc: '2.0', id: 1, result: { tools: 'not-array' } })).toBe(false)
  })

  it('returns undefined for unknown tool names', () => {
    const cache = new ToolAnnotationCache()
    cache.update(toolsListResponse([{ name: 'known_tool' }]))
    expect(cache.get('unknown_tool')).toBeUndefined()
    expect(cache.has('unknown_tool')).toBe(false)
  })

  it('skips tools entries with non-string names', () => {
    const cache = new ToolAnnotationCache()
    cache.update({
      jsonrpc: '2.0',
      id: 1,
      result: {
        tools: [
          { name: 'valid_tool' },
          { name: 123 }, // non-string, should be skipped
          { noName: true }, // missing name, should be skipped
        ],
      },
    })
    expect(cache.size).toBe(1)
    expect(cache.has('valid_tool')).toBe(true)
  })

  it('skips non-object tool entries', () => {
    const cache = new ToolAnnotationCache()
    cache.update({
      jsonrpc: '2.0',
      id: 1,
      result: {
        tools: ['not-an-object', null, { name: 'valid_tool' }],
      },
    })
    expect(cache.size).toBe(1)
    expect(cache.has('valid_tool')).toBe(true)
  })
})
