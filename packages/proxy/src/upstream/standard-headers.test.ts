import { describe, it, expect } from 'vitest'
import {
  buildStandardRequestHeaders,
  needsSentinelEncoding,
  encodeSentinelValue,
  MCP_NAME_MAX_BYTES,
} from './standard-headers.js'

describe('needsSentinelEncoding', () => {
  it('does not require encoding for visible ASCII with no leading/trailing whitespace', () => {
    expect(needsSentinelEncoding('us-west1')).toBe(false)
  })

  it('requires encoding for non-ASCII characters', () => {
    expect(needsSentinelEncoding('Hello, 世界')).toBe(true)
  })

  it('requires encoding for a value with a newline', () => {
    expect(needsSentinelEncoding('line1\nline2')).toBe(true)
  })

  it('requires encoding when the value looks like the sentinel wrapper', () => {
    expect(needsSentinelEncoding('=?base64?literal?=')).toBe(true)
  })

  it('requires encoding for the minimal overlapping sentinel', () => {
    expect(needsSentinelEncoding('=?base64?=')).toBe(true)
  })

  it('does not require encoding for an interior space', () => {
    expect(needsSentinelEncoding('a b')).toBe(false)
  })

  it('does not require encoding for an interior tab', () => {
    expect(needsSentinelEncoding('a\tb')).toBe(false)
  })

  it('requires encoding for a leading space', () => {
    expect(needsSentinelEncoding(' a')).toBe(true)
  })

  it('requires encoding for a trailing space', () => {
    expect(needsSentinelEncoding('a ')).toBe(true)
  })

  it('requires encoding for a leading tab', () => {
    expect(needsSentinelEncoding('\ta')).toBe(true)
  })

  it('requires encoding for a trailing tab', () => {
    expect(needsSentinelEncoding('a\t')).toBe(true)
  })

  it('does not require encoding for an empty string', () => {
    expect(needsSentinelEncoding('')).toBe(false)
  })
})

describe('encodeSentinelValue', () => {
  // Spec Value Encoding examples table, verbatim.
  it('encodes multi-byte UTF-8 text', () => {
    expect(encodeSentinelValue('Hello, 世界')).toBe('=?base64?SGVsbG8sIOS4lueVjA==?=')
  })

  it('encodes leading and trailing spaces', () => {
    expect(encodeSentinelValue(' padded ')).toBe('=?base64?IHBhZGRlZCA=?=')
  })

  it('encodes an embedded newline', () => {
    expect(encodeSentinelValue('line1\nline2')).toBe('=?base64?bGluZTEKbGluZTI=?=')
  })

  it('encodes a value that already looks like the sentinel wrapper', () => {
    expect(encodeSentinelValue('=?base64?literal?=')).toBe('=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?=')
  })

  it('encodes the minimal overlapping sentinel', () => {
    expect(encodeSentinelValue('=?base64?=')).toBe('=?base64?PT9iYXNlNjQ/PQ==?=')
  })
})

describe('buildStandardRequestHeaders', () => {
  describe('method guard', () => {
    it('rejects a method with non-ASCII characters', () => {
      expect(buildStandardRequestHeaders('héllo', undefined)).toEqual({})
    })

    it('rejects a method containing a space', () => {
      expect(buildStandardRequestHeaders('a b', undefined)).toEqual({})
    })

    it('rejects a method containing a newline', () => {
      expect(buildStandardRequestHeaders('a\nb', undefined)).toEqual({})
    })

    it('rejects an empty method', () => {
      expect(buildStandardRequestHeaders('', undefined)).toEqual({})
    })

    it('stamps a normal method verbatim', () => {
      expect(buildStandardRequestHeaders('tools/list', undefined)).toEqual({
        'mcp-method': 'tools/list',
      })
    })
  })

  describe('name-bearing methods', () => {
    it('stamps mcp-name from params.name on tools/call', () => {
      expect(buildStandardRequestHeaders('tools/call', { name: 'search' })).toEqual({
        'mcp-method': 'tools/call',
        'mcp-name': 'search',
      })
    })

    it('stamps mcp-name from params.name on prompts/get', () => {
      expect(buildStandardRequestHeaders('prompts/get', { name: 'summarize' })).toEqual({
        'mcp-method': 'prompts/get',
        'mcp-name': 'summarize',
      })
    })

    it('ignores params.uri on prompts/get', () => {
      expect(buildStandardRequestHeaders('prompts/get', { uri: 'file:///prompt.md' })).toEqual({
        'mcp-method': 'prompts/get',
      })
    })

    it('stamps mcp-name from params.uri on resources/read', () => {
      expect(buildStandardRequestHeaders('resources/read', { uri: 'file:///data.txt' })).toEqual({
        'mcp-method': 'resources/read',
        'mcp-name': 'file:///data.txt',
      })
    })

    it('ignores params.name on resources/read', () => {
      expect(buildStandardRequestHeaders('resources/read', { name: 'data' })).toEqual({
        'mcp-method': 'resources/read',
      })
    })
  })

  describe('non-name methods and shapes', () => {
    it('does not stamp mcp-name for a non-name-bearing method even when params.name is present', () => {
      expect(buildStandardRequestHeaders('tools/list', { name: 'search' })).toEqual({
        'mcp-method': 'tools/list',
      })
    })

    it('does not resolve inherited Object.prototype keys as name-bearing methods', () => {
      expect(buildStandardRequestHeaders('__proto__', { '[object Object]': 'spoofed' })).toEqual({
        'mcp-method': '__proto__',
      })
    })

    it('does not treat "constructor" as a name-bearing method', () => {
      expect(buildStandardRequestHeaders('constructor', { name: 'spoofed' })).toEqual({
        'mcp-method': 'constructor',
      })
    })

    it('does not treat "toString" as a name-bearing method', () => {
      expect(buildStandardRequestHeaders('toString', { name: 'spoofed' })).toEqual({
        'mcp-method': 'toString',
      })
    })

    it('does not treat "hasOwnProperty" as a name-bearing method', () => {
      expect(buildStandardRequestHeaders('hasOwnProperty', { name: 'spoofed' })).toEqual({
        'mcp-method': 'hasOwnProperty',
      })
    })

    it('does not stamp mcp-name from an inherited (prototype-chain) name on tools/call', () => {
      const params = Object.create({ name: 'spoofed' }) as unknown
      expect(buildStandardRequestHeaders('tools/call', params)).toEqual({
        'mcp-method': 'tools/call',
      })
    })

    it('does not stamp mcp-name from an inherited (prototype-chain) uri on resources/read', () => {
      const params = Object.create({ uri: 'file:///x' }) as unknown
      expect(buildStandardRequestHeaders('resources/read', params)).toEqual({
        'mcp-method': 'resources/read',
      })
    })

    it('does not stamp mcp-name from an own but non-enumerable name on tools/call', () => {
      const params: Record<string, unknown> = {}
      Object.defineProperty(params, 'name', { value: 'spoofed', enumerable: false })
      expect(buildStandardRequestHeaders('tools/call', params)).toEqual({
        'mcp-method': 'tools/call',
      })
    })

    it('still stamps mcp-name from a normal own-enumerable name on tools/call', () => {
      expect(buildStandardRequestHeaders('tools/call', { name: 'search' })).toEqual({
        'mcp-method': 'tools/call',
        'mcp-name': 'search',
      })
    })

    it('still stamps mcp-name from a normal own-enumerable uri on resources/read', () => {
      expect(buildStandardRequestHeaders('resources/read', { uri: 'file:///data.txt' })).toEqual({
        'mcp-method': 'resources/read',
        'mcp-name': 'file:///data.txt',
      })
    })

    it('still stamps the empty literal when name is own-enumerable and empty', () => {
      expect(buildStandardRequestHeaders('tools/call', { name: '' })).toEqual({
        'mcp-method': 'tools/call',
        'mcp-name': '',
      })
    })

    it('does not throw and omits mcp-name when the source field is a number', () => {
      expect(buildStandardRequestHeaders('tools/call', { name: 42 })).toEqual({
        'mcp-method': 'tools/call',
      })
    })

    it('does not throw and omits mcp-name when the source field is an object', () => {
      expect(buildStandardRequestHeaders('tools/call', { name: {} })).toEqual({
        'mcp-method': 'tools/call',
      })
    })

    it('does not throw and omits mcp-name when the source field is null', () => {
      expect(buildStandardRequestHeaders('tools/call', { name: null })).toEqual({
        'mcp-method': 'tools/call',
      })
    })

    it('does not throw and omits mcp-name when params is null', () => {
      expect(buildStandardRequestHeaders('tools/call', null)).toEqual({
        'mcp-method': 'tools/call',
      })
    })

    it('does not throw and omits mcp-name when params is an array', () => {
      expect(buildStandardRequestHeaders('tools/call', ['search'])).toEqual({
        'mcp-method': 'tools/call',
      })
    })

    it('does not throw and omits mcp-name when params is a string', () => {
      expect(buildStandardRequestHeaders('tools/call', 'search')).toEqual({
        'mcp-method': 'tools/call',
      })
    })

    it('does not throw and omits mcp-name when params is a number', () => {
      expect(buildStandardRequestHeaders('tools/call', 42)).toEqual({
        'mcp-method': 'tools/call',
      })
    })

    it('does not throw and omits mcp-name when params is undefined', () => {
      expect(buildStandardRequestHeaders('tools/call', undefined)).toEqual({
        'mcp-method': 'tools/call',
      })
    })

    it('stamps only mcp-method for a notification with no params', () => {
      expect(buildStandardRequestHeaders('notifications/initialized', undefined)).toEqual({
        'mcp-method': 'notifications/initialized',
      })
    })
  })

  describe('value encoding end-to-end', () => {
    it('stamps a literal value with no encoding', () => {
      expect(buildStandardRequestHeaders('tools/call', { name: 'us-west1' })).toEqual({
        'mcp-method': 'tools/call',
        'mcp-name': 'us-west1',
      })
    })

    it('stamps the empty string literally', () => {
      expect(buildStandardRequestHeaders('tools/call', { name: '' })).toEqual({
        'mcp-method': 'tools/call',
        'mcp-name': '',
      })
    })

    it('stamps an interior space literally', () => {
      expect(buildStandardRequestHeaders('tools/call', { name: 'a b' })).toEqual({
        'mcp-method': 'tools/call',
        'mcp-name': 'a b',
      })
    })

    it('stamps an interior tab literally', () => {
      expect(buildStandardRequestHeaders('tools/call', { name: 'a\tb' })).toEqual({
        'mcp-method': 'tools/call',
        'mcp-name': 'a\tb',
      })
    })

    it('encodes a value with leading and trailing whitespace', () => {
      expect(buildStandardRequestHeaders('tools/call', { name: ' padded ' })).toEqual({
        'mcp-method': 'tools/call',
        'mcp-name': '=?base64?IHBhZGRlZCA=?=',
      })
    })
  })

  describe('8 KB cap boundary', () => {
    it('stamps mcp-name at exactly the 8192-byte cap', () => {
      const name = 'a'.repeat(MCP_NAME_MAX_BYTES)
      expect(buildStandardRequestHeaders('tools/call', { name })).toEqual({
        'mcp-method': 'tools/call',
        'mcp-name': name,
      })
    })

    it('omits mcp-name at 8193 bytes, one over the cap', () => {
      const name = 'a'.repeat(MCP_NAME_MAX_BYTES + 1)
      expect(buildStandardRequestHeaders('tools/call', { name })).toEqual({
        'mcp-method': 'tools/call',
      })
    })

    it('omits mcp-name when the raw value is under the cap but its encoded form exceeds it', () => {
      const name = 'a'.repeat(6200) + ' '
      expect(buildStandardRequestHeaders('tools/call', { name })).toEqual({
        'mcp-method': 'tools/call',
      })
    })
  })

  describe('params with a toJSON (mcp-name must mirror what JSON.stringify forwards)', () => {
    it('stamps the toJSON-rewritten name, not the live-object name, on tools/call', () => {
      const params = {
        name: 'header-truth',
        toJSON() {
          return { name: 'body-lie' }
        },
      }
      // The body Helio actually forwards (`{ params }` mirrors the relay
      // shape `body['params'] = request.params` before JSON.stringify).
      expect(JSON.stringify({ params })).toBe('{"params":{"name":"body-lie"}}')
      expect(buildStandardRequestHeaders('tools/call', params)).toEqual({
        'mcp-method': 'tools/call',
        'mcp-name': 'body-lie',
      })
    })

    it('omits mcp-name when toJSON drops the name field entirely', () => {
      const params = {
        name: 'still-in-header',
        toJSON() {
          return {}
        },
      }
      expect(JSON.stringify({ params })).toBe('{"params":{}}')
      expect(buildStandardRequestHeaders('tools/call', params)).toEqual({
        'mcp-method': 'tools/call',
      })
    })

    it('stamps the name from an inherited toJSON', () => {
      const params = Object.create({
        toJSON() {
          return { name: 'inh' }
        },
      }) as Record<string, unknown>
      params.name = 'own-name-not-used'
      expect(JSON.stringify({ params })).toBe('{"params":{"name":"inh"}}')
      expect(buildStandardRequestHeaders('tools/call', params)).toEqual({
        'mcp-method': 'tools/call',
        'mcp-name': 'inh',
      })
    })

    it('stamps the name from an own non-enumerable toJSON', () => {
      const params: Record<string, unknown> = { name: 'own-name-not-used' }
      Object.defineProperty(params, 'toJSON', {
        value: () => ({ name: 'ne' }),
        enumerable: false,
      })
      expect(JSON.stringify({ params })).toBe('{"params":{"name":"ne"}}')
      expect(buildStandardRequestHeaders('tools/call', params)).toEqual({
        'mcp-method': 'tools/call',
        'mcp-name': 'ne',
      })
    })

    it('stamps the toJSON-rewritten uri on resources/read', () => {
      const params = {
        uri: 'file:///a',
        toJSON() {
          return { uri: 'file:///b' }
        },
      }
      expect(JSON.stringify({ params })).toBe('{"params":{"uri":"file:///b"}}')
      expect(buildStandardRequestHeaders('resources/read', params)).toEqual({
        'mcp-method': 'resources/read',
        'mcp-name': 'file:///b',
      })
    })

    it('omits mcp-name and does not throw when toJSON itself throws', () => {
      const params = {
        name: 'unreachable',
        toJSON() {
          throw new Error('boom')
        },
      }
      expect(() => buildStandardRequestHeaders('tools/call', params)).not.toThrow()
      expect(buildStandardRequestHeaders('tools/call', params)).toEqual({
        'mcp-method': 'tools/call',
      })
    })
  })
})
