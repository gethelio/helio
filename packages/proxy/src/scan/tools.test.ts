import { describe, it, expect } from 'vitest'
import { surfaceToolsFromList } from './tools.js'

function body(tools: unknown[]): unknown {
  return { jsonrpc: '2.0', id: 1, result: { tools } }
}

describe('surfaceToolsFromList', () => {
  it('keeps objects with a string name in list order, never drifted, with both hint views equal', () => {
    const listed = surfaceToolsFromList(
      body([
        { name: 'b', annotations: { readOnlyHint: true, title: 'ignored' } },
        { name: 'a', inputSchema: { type: 'object' } },
        { name: 'c', annotations: { destructiveHint: false } },
      ]),
    )
    expect(listed).not.toBeNull()
    expect(listed?.tools.map((tool) => tool.name)).toEqual(['b', 'a', 'c'])
    expect(listed?.tools[0]).toEqual({
      name: 'b',
      annotations: { readOnlyHint: true },
      current_annotations: { readOnlyHint: true },
      drifted: false,
    })
    expect(listed?.tools[1]?.annotations).toBeUndefined()
    expect(listed?.tools[2]?.annotations).toEqual({ destructiveHint: false })
    expect(listed?.duplicates).toEqual([])
    expect(listed?.skipped).toBe(0)
  })

  it('keeps the first occurrence of a repeated name with its annotations read as unset', () => {
    const listed = surfaceToolsFromList(
      body([
        { name: 'dup', annotations: { readOnlyHint: true } },
        { name: 'solo' },
        { name: 'dup', annotations: { destructiveHint: false } },
        { name: 'dup' },
      ]),
    )
    expect(listed?.tools.map((tool) => tool.name)).toEqual(['dup', 'solo'])
    expect(listed?.tools[0]?.annotations).toBeUndefined()
    expect(listed?.tools[0]?.current_annotations).toBeUndefined()
    expect(listed?.tools[0]?.drifted).toBe(false)
    expect(listed?.duplicates).toEqual([{ name: 'dup', count: 3 }])
  })

  it('skips non-object entries, nameless entries and non-string names, counting them', () => {
    const listed = surfaceToolsFromList(
      body(['string', null, 7, { annotations: {} }, { name: 42 }, { name: 'ok' }]),
    )
    expect(listed?.tools.map((tool) => tool.name)).toEqual(['ok'])
    expect(listed?.skipped).toBe(5)
  })

  it('exposes the first occurrence definition per name for the candidate walk', () => {
    const schema = { type: 'object', properties: { amount: { type: 'number' } } }
    const listed = surfaceToolsFromList(
      body([
        { name: 'pay', inputSchema: schema },
        { name: 'pay', inputSchema: { type: 'object' } },
      ]),
    )
    expect(listed?.definitions.get('pay')).toEqual({ name: 'pay', inputSchema: schema })
  })

  it('returns null for a body that is not a tools/list result', () => {
    expect(surfaceToolsFromList({ result: { notTools: true } })).toBeNull()
    expect(surfaceToolsFromList('plain text')).toBeNull()
    expect(surfaceToolsFromList({ error: { message: 'Not initialized' } })).toBeNull()
  })
})
