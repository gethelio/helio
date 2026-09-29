import { describe, it, expect } from 'vitest'
import { HINT_KEYS, extractAnnotations, extractTools, pickHints } from './tool-definitions.js'

describe('HINT_KEYS', () => {
  it('names the four MCP hints matchAnnotations reads', () => {
    expect([...HINT_KEYS]).toEqual([
      'readOnlyHint',
      'destructiveHint',
      'idempotentHint',
      'openWorldHint',
    ])
  })
})

describe('pickHints', () => {
  it('copies only the four hints onto a fresh object and keeps a present key whatever its value', () => {
    const source = { readOnlyHint: true, destructiveHint: { nested: true }, title: 'x' }
    const picked = pickHints(source as never)
    expect(picked).toEqual({ readOnlyHint: true, destructiveHint: { nested: true } })
    expect(picked).not.toBe(source)
    expect(Object.keys(picked ?? {})).not.toContain('title')
  })

  it('returns undefined for an absent source', () => {
    expect(pickHints(undefined)).toBeUndefined()
  })
})

describe('extractAnnotations', () => {
  it('reads an object annotations value and nothing else', () => {
    expect(extractAnnotations({ name: 't', annotations: { readOnlyHint: true } })).toEqual({
      readOnlyHint: true,
    })
    expect(extractAnnotations({ name: 't', annotations: 'yes' })).toBeUndefined()
    expect(extractAnnotations({ name: 't', annotations: null })).toBeUndefined()
    expect(extractAnnotations({ name: 't' })).toBeUndefined()
  })
})

describe('extractTools', () => {
  it('returns the tools array of a tools/list body and null for any other shape', () => {
    expect(extractTools({ result: { tools: [{ name: 'a' }] } })).toEqual([{ name: 'a' }])
    expect(extractTools({ result: { tools: [] } })).toEqual([])
    expect(extractTools({ result: { notTools: true } })).toBeNull()
    expect(extractTools({ result: { tools: 'nope' } })).toBeNull()
    expect(extractTools({ error: { message: 'x' } })).toBeNull()
    expect(extractTools('text')).toBeNull()
    expect(extractTools(null)).toBeNull()
  })
})
