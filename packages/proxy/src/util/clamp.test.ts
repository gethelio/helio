import { describe, it, expect } from 'vitest'
import { clamp, clampInt } from './clamp.js'

// ---------------------------------------------------------------------------
// clamp
// ---------------------------------------------------------------------------

describe('clamp', () => {
  it('returns n unchanged when within [min, max]', () => {
    expect(clamp(50, 1, 100)).toBe(50)
  })

  it('clamps below-min input up to min', () => {
    expect(clamp(-5, 0, 100)).toBe(0)
  })

  it('clamps above-max input down to max', () => {
    expect(clamp(500, 1, 100)).toBe(100)
  })

  it('returns the bound itself when n equals min or max', () => {
    expect(clamp(1, 1, 100)).toBe(1)
    expect(clamp(100, 1, 100)).toBe(100)
  })
})

// ---------------------------------------------------------------------------
// clampInt
// ---------------------------------------------------------------------------

describe('clampInt', () => {
  it('returns fallback when value is undefined', () => {
    expect(clampInt(undefined, 50, 1, 1000)).toBe(50)
  })

  it('returns fallback when value is an empty string', () => {
    // Browsers submit empty form fields as `?foo=`, producing "" here.
    // parseInt("") is NaN — the guard must catch it and return the fallback
    // rather than letting NaN flow through to callers (e.g. better-sqlite3
    // binding, which would 500 on NaN).
    expect(clampInt('', 50, 1, 1000)).toBe(50)
  })

  it('returns fallback when value is non-numeric garbage', () => {
    expect(clampInt('abc', 50, 1, 1000)).toBe(50)
  })

  it('returns the parsed integer when within range', () => {
    expect(clampInt('42', 50, 1, 1000)).toBe(42)
  })

  it('preserves "0" as 0', () => {
    // The dashboard sends explicit `?offset=0` for page 1 after fcf314e.
    // A truthy-check regression (`if (!value) return fallback`) would break
    // this case — pin it.
    expect(clampInt('0', 0, 0, Number.MAX_SAFE_INTEGER)).toBe(0)
  })

  it('clamps below-min input up to min', () => {
    expect(clampInt('-10', 0, 0, 1000)).toBe(0)
  })

  it('clamps above-max input down to max', () => {
    expect(clampInt('10000', 50, 1, 1000)).toBe(1000)
  })

  it('truncates float-like strings via parseInt semantics', () => {
    // Documents current behavior: parseInt("3.7", 10) === 3. A silent swap
    // to Number() or parseFloat() would change this, so pin it.
    expect(clampInt('3.7', 50, 1, 1000)).toBe(3)
  })
})
