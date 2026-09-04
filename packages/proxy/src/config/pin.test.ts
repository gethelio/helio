import { describe, it, expect } from 'vitest'
import { normalizeConfigPin, readConfigPin } from './pin.js'

const HEX = 'AbCdEf0123456789'.repeat(4)

describe('normalizeConfigPin (issue #341)', () => {
  it('accepts bare hex and the sha256: prefix in any case, trimmed, and lowercases', () => {
    expect(normalizeConfigPin(HEX)).toBe(HEX.toLowerCase())
    expect(normalizeConfigPin(`  sha256:${HEX}\n`)).toBe(HEX.toLowerCase())
    expect(normalizeConfigPin(`SHA256:${HEX.toLowerCase()}`)).toBe(HEX.toLowerCase())
  })

  it('rejects anything that is not 64 hex characters', () => {
    expect(normalizeConfigPin('')).toBeNull()
    expect(normalizeConfigPin('sha256:')).toBeNull()
    expect(normalizeConfigPin(HEX.slice(1))).toBeNull()
    expect(normalizeConfigPin(`${HEX}0`)).toBeNull()
    expect(normalizeConfigPin(`sha512:${HEX}`)).toBeNull()
    expect(normalizeConfigPin('g'.repeat(64))).toBeNull()
  })
})

describe('readConfigPin', () => {
  it('distinguishes unset, invalid (empty included), and set', () => {
    expect(readConfigPin({})).toEqual({ status: 'unset' })
    expect(readConfigPin({ HELIO_CONFIG_SHA256: '' })).toEqual({ status: 'invalid', raw: '' })
    expect(readConfigPin({ HELIO_CONFIG_SHA256: 'nope' })).toEqual({
      status: 'invalid',
      raw: 'nope',
    })
    expect(readConfigPin({ HELIO_CONFIG_SHA256: `sha256:${HEX}` })).toEqual({
      status: 'set',
      sha256: HEX.toLowerCase(),
    })
  })
})
