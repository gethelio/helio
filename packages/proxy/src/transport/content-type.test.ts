import { describe, it, expect } from 'vitest'
import { isJsonContentType } from './content-type.js'

describe('isJsonContentType', () => {
  it.each([
    'application/json',
    'application/json; charset=utf-8',
    'application/json;charset=utf-8',
  ])('accepts %s', (header) => {
    expect(isJsonContentType(header)).toBe(true)
  })

  it.each(['APPLICATION/JSON', 'Application/Json', 'application/JSON; charset=UTF-8'])(
    'accepts %s, since media types compare case insensitively',
    (header) => {
      expect(isJsonContentType(header)).toBe(true)
    },
  )

  it.each(['  application/json  ', '\tapplication/json', 'application/json '])(
    'accepts %s, ignoring surrounding whitespace',
    (header) => {
      expect(isJsonContentType(header)).toBe(true)
    },
  )

  // The vulnerability class this function exists to close: these media types
  // are CORS-safelisted, so a browser sends them cross-site with no preflight.
  // Smuggling the JSON token into a parameter must not satisfy the check.
  it.each([
    'text/plain;x=application/json',
    'text/plain; charset=application/json',
    'multipart/form-data; boundary=application/json',
    'application/x-www-form-urlencoded;v=application/json',
    'text/plain;application/json',
    'text/plain;charset=utf-8',
    'multipart/form-data; boundary=abc123',
  ])('rejects CORS-safelisted %s', (header) => {
    expect(isJsonContentType(header)).toBe(false)
  })

  it.each([undefined, '', '   ', ';', 'application/json extra', 'xapplication/json'])(
    'rejects %s',
    (header) => {
      expect(isJsonContentType(header)).toBe(false)
    },
  )

  it('rejects the +json structured suffix family, which MCP does not use', () => {
    expect(isJsonContentType('application/ld+json')).toBe(false)
    expect(isJsonContentType('application/problem+json')).toBe(false)
  })

  // Fetch comma-joins duplicate headers, so a caller cannot pair a safelisted
  // media type with a second application/json value to slip past the check.
  it.each(['application/json, text/plain', 'text/plain, application/json'])(
    'rejects comma-joined duplicate header %s',
    (header) => {
      expect(isJsonContentType(header)).toBe(false)
    },
  )
})
