import { describe, it, expect } from 'vitest'
import { snapshotValue } from './snapshot.js'

// ---------------------------------------------------------------------------
// snapshotValue
// ---------------------------------------------------------------------------

describe('snapshotValue', () => {
  // T9 (a)
  it('returns a deep copy of a nested plain object', () => {
    const input: Record<string, unknown> = { to: 'a@b.com', nested: { k: 'original' } }
    const out = snapshotValue(input)
    expect(out).not.toBe(input)
    expect(out).toEqual(input)
    ;(input['nested'] as Record<string, unknown>)['k'] = 'forged'
    expect((out['nested'] as Record<string, unknown>)['k']).toBe('original')
  })

  // T9 (b)
  it('falls back to the JSON form for a value structuredClone refuses', () => {
    const input: Record<string, unknown> = { to: 'x', cb: () => 1 }
    let out: Record<string, unknown> | undefined
    expect(() => {
      out = snapshotValue(input)
    }).not.toThrow()
    expect(Object.keys(out as object)).toEqual(['to'])
    expect(out).toEqual({ to: 'x' })
  })

  // T9 (c)
  it('returns the same reference when neither clone nor JSON can serialize the value', () => {
    const input = {
      get x(): never {
        throw new Error('boom')
      },
    }
    let out: unknown
    expect(() => {
      out = snapshotValue(input)
    }).not.toThrow()
    expect(out).toBe(input)
  })

  // T9 (d)
  it('keeps a cycle as a cycle on a new object', () => {
    const cyc: Record<string, unknown> = { a: 1 }
    cyc['self'] = cyc
    const out = snapshotValue(cyc)
    expect(out).not.toBe(cyc)
    expect(out['self']).toBe(out)
    expect(out['a']).toBe(1)
  })

  // T9 (e)
  it('keeps Date instances and BigInt values', () => {
    const out = snapshotValue({ d: new Date(0), b: 10n })
    expect(out.d).toBeInstanceOf(Date)
    expect(out.d.getTime()).toBe(0)
    expect(out.b).toBe(10n)
  })

  // T9 (f)
  it('yields an equal unfrozen copy of a frozen input and leaves the input frozen', () => {
    const input = Object.freeze({ to: 'a', nested: Object.freeze({ k: 'original' }) })
    const out = snapshotValue(input)
    expect(out).toEqual(input)
    expect(out).not.toBe(input)
    expect(Object.isFrozen(out)).toBe(false)
    expect(Object.isFrozen(out.nested)).toBe(false)
    expect(Object.isFrozen(input)).toBe(true)
    expect(input).toEqual({ to: 'a', nested: { k: 'original' } })
  })
})
