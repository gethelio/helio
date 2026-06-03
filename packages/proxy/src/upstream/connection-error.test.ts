import { describe, it, expect } from 'vitest'
import { describeUnreachableUpstream } from './connection-error.js'

const URL = 'http://localhost:8080/mcp'

/** Build an undici-style `fetch failed` error wrapping a coded system cause. */
function fetchFailed(code: string): TypeError {
  const wrapper = new TypeError('fetch failed')
  ;(wrapper as { cause?: unknown }).cause = Object.assign(new Error('connect failed'), { code })
  return wrapper
}

describe('describeUnreachableUpstream', () => {
  it('names the URL and the cause code for ECONNREFUSED', () => {
    const result = describeUnreachableUpstream(fetchFailed('ECONNREFUSED'), URL)
    expect(result).toBeInstanceOf(Error)
    expect(result?.message).toContain(URL)
    expect(result?.message).toContain('ECONNREFUSED')
    expect(result?.message).toContain('is it running?')
    expect(result?.message).toContain('upstream.url')
  })

  it.each(['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'EHOSTUNREACH', 'ETIMEDOUT'])(
    'recognises %s as unreachable',
    (code) => {
      expect(describeUnreachableUpstream(fetchFailed(code), URL)).toBeInstanceOf(Error)
    },
  )

  it('treats a bare "fetch failed" with no extractable code as unreachable', () => {
    expect(describeUnreachableUpstream(new TypeError('fetch failed'), URL)).toBeInstanceOf(Error)
  })

  it('returns null for an application error from a server that did respond', () => {
    expect(describeUnreachableUpstream(new Error('upstream returned 500'), URL)).toBeNull()
  })

  it('returns null for a coded error that is not a connection failure', () => {
    const err = Object.assign(new Error('parse error'), { code: 'ERR_INVALID_JSON' })
    expect(describeUnreachableUpstream(err, URL)).toBeNull()
  })

  it('returns null for a non-error value', () => {
    expect(describeUnreachableUpstream('boom', URL)).toBeNull()
  })
})
