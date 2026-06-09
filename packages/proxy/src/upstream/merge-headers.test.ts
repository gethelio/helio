import { describe, it, expect } from 'vitest'
import { mergeUpstreamHeaders } from './merge-headers.js'

describe('mergeUpstreamHeaders', () => {
  it('lowercases all header names', () => {
    const merged = mergeUpstreamHeaders({ 'Content-Type': 'application/json' }, {}, {})
    expect(merged).toEqual({ 'content-type': 'application/json' })
  })

  it('forwarded headers override base defaults', () => {
    const merged = mergeUpstreamHeaders(
      { accept: 'application/json' },
      { accept: 'text/plain' },
      {},
    )
    expect(merged['accept']).toBe('text/plain')
  })

  it('static headers win over caller-forwarded headers (case-insensitive)', () => {
    const merged = mergeUpstreamHeaders(
      {},
      { authorization: 'Bearer caller' },
      { Authorization: 'Bearer static' },
    )
    expect(merged['authorization']).toBe('Bearer static')
    expect(merged).not.toHaveProperty('Authorization')
  })

  it('merges disjoint headers from all three sources', () => {
    const merged = mergeUpstreamHeaders(
      { 'content-type': 'application/json' },
      { 'x-trace': 't1' },
      { authorization: 'Bearer s' },
    )
    expect(merged).toEqual({
      'content-type': 'application/json',
      'x-trace': 't1',
      authorization: 'Bearer s',
    })
  })
})
