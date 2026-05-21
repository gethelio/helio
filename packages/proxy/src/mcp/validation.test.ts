import { describe, it, expect } from 'vitest'
import { extractId, validateJsonRpc } from './validation.js'

// ---------------------------------------------------------------------------
// extractId
// ---------------------------------------------------------------------------

describe('extractId', () => {
  it('returns a string id as-is', () => {
    expect(extractId('abc')).toBe('abc')
  })

  it('returns a number id as-is', () => {
    expect(extractId(42)).toBe(42)
  })

  it('returns null for null', () => {
    expect(extractId(null)).toBeNull()
  })

  it('returns null for undefined', () => {
    expect(extractId(undefined)).toBeNull()
  })

  it('returns null for boolean', () => {
    expect(extractId(true)).toBeNull()
  })

  it('returns null for object', () => {
    expect(extractId({ id: 1 })).toBeNull()
  })

  it('returns 0 for falsy number', () => {
    expect(extractId(0)).toBe(0)
  })

  it('returns empty string for falsy string', () => {
    expect(extractId('')).toBe('')
  })
})

// ---------------------------------------------------------------------------
// validateJsonRpc
// ---------------------------------------------------------------------------

describe('validateJsonRpc', () => {
  it('returns null for a valid request', () => {
    expect(validateJsonRpc({ jsonrpc: '2.0', method: 'tools/call' })).toBeNull()
  })

  it('rejects batch requests (arrays)', () => {
    expect(validateJsonRpc([{ jsonrpc: '2.0', method: 'tools/call' }])).toBe(
      'batch requests not supported',
    )
  })

  it('rejects null body', () => {
    expect(validateJsonRpc(null)).toBe('request body must be a JSON object')
  })

  it('rejects non-object primitives', () => {
    expect(validateJsonRpc('hello')).toBe('request body must be a JSON object')
    expect(validateJsonRpc(42)).toBe('request body must be a JSON object')
    expect(validateJsonRpc(true)).toBe('request body must be a JSON object')
  })

  it('rejects missing jsonrpc field', () => {
    expect(validateJsonRpc({ method: 'tools/call' })).toBe(
      'missing or invalid "jsonrpc" field (must be "2.0")',
    )
  })

  it('rejects wrong jsonrpc version', () => {
    expect(validateJsonRpc({ jsonrpc: '1.0', method: 'tools/call' })).toBe(
      'missing or invalid "jsonrpc" field (must be "2.0")',
    )
  })

  it('rejects missing method field', () => {
    expect(validateJsonRpc({ jsonrpc: '2.0' })).toBe(
      'missing or invalid "method" field (must be a string)',
    )
  })

  it('rejects non-string method', () => {
    expect(validateJsonRpc({ jsonrpc: '2.0', method: 123 })).toBe(
      'missing or invalid "method" field (must be a string)',
    )
  })

  it('accepts request with extra fields', () => {
    expect(
      validateJsonRpc({ jsonrpc: '2.0', method: 'tools/call', id: 1, params: { tool: 'x' } }),
    ).toBeNull()
  })

  it('accepts request with params object', () => {
    expect(validateJsonRpc({ jsonrpc: '2.0', method: 'tools/list', params: {} })).toBeNull()
  })

  it('accepts request with id: null', () => {
    expect(validateJsonRpc({ jsonrpc: '2.0', id: null, method: 'tools/list' })).toBeNull()
  })

  it('rejects invalid id type', () => {
    expect(validateJsonRpc({ jsonrpc: '2.0', method: 'tools/list', id: { bad: true } })).toBe(
      'invalid "id" field (must be string, number, or null)',
    )
  })
})
