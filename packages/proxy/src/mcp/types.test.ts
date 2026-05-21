import { describe, it, expect } from 'vitest'
import { makeJsonRpcError, PARSE_ERROR, INVALID_REQUEST, INTERNAL_ERROR } from './types.js'

describe('makeJsonRpcError', () => {
  it('builds a valid JSON-RPC error response', () => {
    const result = makeJsonRpcError(1, INTERNAL_ERROR, 'something broke')
    expect(result).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32603, message: 'something broke' },
    })
  })

  it('sets id to null when undefined', () => {
    const result = makeJsonRpcError(undefined, PARSE_ERROR, 'bad json')
    expect(result.id).toBeNull()
  })

  it('preserves string ids', () => {
    const result = makeJsonRpcError('req-42', INVALID_REQUEST, 'missing method')
    expect(result.id).toBe('req-42')
  })

  it('preserves null ids', () => {
    const result = makeJsonRpcError(null, INTERNAL_ERROR, 'error')
    expect(result.id).toBeNull()
  })
})

describe('error code constants', () => {
  it('matches JSON-RPC spec values', () => {
    expect(PARSE_ERROR).toBe(-32700)
    expect(INVALID_REQUEST).toBe(-32600)
    expect(INTERNAL_ERROR).toBe(-32603)
  })
})
