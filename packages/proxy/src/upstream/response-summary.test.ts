import { describe, it, expect } from 'vitest'
import { extractResponseSummary } from './response-summary.js'

describe('extractResponseSummary', () => {
  it('extracts content types from a successful MCP tools/call response', () => {
    const body = {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: 'Sunny, 22°C in London' }],
      },
    }
    const summary = extractResponseSummary(body)
    expect(summary.success).toBe(true)
    expect(summary.has_error).toBe(false)
    expect(summary.error_code).toBeNull()
    expect(summary.content_types).toEqual(['text'])
    expect(summary.content_count).toBe(1)
  })

  it('extracts multiple content types sorted alphabetically', () => {
    const body = {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [
          { type: 'text', text: 'caption' },
          { type: 'image', data: 'base64...' },
          { type: 'text', text: 'more text' },
        ],
      },
    }
    const summary = extractResponseSummary(body)
    expect(summary.success).toBe(true)
    expect(summary.content_types).toEqual(['image', 'text'])
    expect(summary.content_count).toBe(3)
  })

  it('handles JSON-RPC error response', () => {
    const body = {
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32601, message: 'Method not found' },
    }
    const summary = extractResponseSummary(body)
    expect(summary.success).toBe(false)
    expect(summary.has_error).toBe(true)
    expect(summary.error_code).toBe(-32601)
    expect(summary.content_types).toEqual([])
    expect(summary.content_count).toBe(0)
  })

  it('returns safe defaults for null body', () => {
    const summary = extractResponseSummary(null)
    expect(summary.success).toBe(false)
    expect(summary.has_error).toBe(false)
    expect(summary.error_code).toBeNull()
    expect(summary.content_types).toEqual([])
    expect(summary.content_count).toBe(0)
  })

  it('returns safe defaults for non-object body', () => {
    const summary = extractResponseSummary('not an object')
    expect(summary.success).toBe(false)
    expect(summary.has_error).toBe(false)
    expect(summary.content_types).toEqual([])
  })

  it('handles successful result without content array', () => {
    const body = {
      jsonrpc: '2.0',
      id: 1,
      result: { tools: [{ name: 'get_weather' }] },
    }
    const summary = extractResponseSummary(body)
    expect(summary.success).toBe(true)
    expect(summary.has_error).toBe(false)
    expect(summary.content_types).toEqual([])
    expect(summary.content_count).toBe(0)
  })

  it('treats response with both result and error as error', () => {
    const body = {
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: 'data' }] },
      error: { code: -32000, message: 'partial failure' },
    }
    const summary = extractResponseSummary(body)
    expect(summary.success).toBe(false)
    expect(summary.has_error).toBe(true)
    expect(summary.error_code).toBe(-32000)
    expect(summary.content_types).toEqual([])
    expect(summary.content_count).toBe(0)
  })

  it('handles error with non-numeric code', () => {
    const body = {
      jsonrpc: '2.0',
      id: 1,
      error: { code: 'invalid', message: 'bad' },
    }
    const summary = extractResponseSummary(body)
    expect(summary.has_error).toBe(true)
    expect(summary.error_code).toBeNull()
  })

  it('handles content items missing type field', () => {
    const body = {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: 'ok' }, { data: 'no type field' }],
      },
    }
    const summary = extractResponseSummary(body)
    expect(summary.content_types).toEqual(['text'])
    expect(summary.content_count).toBe(2)
  })
})
