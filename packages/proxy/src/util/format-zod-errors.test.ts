import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { formatZodErrors } from './format-zod-errors.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a real `ZodError` via `.safeParse()`. We deliberately avoid
 * hand-fabricating `ZodIssue` objects — using the real parser means a
 * future Zod major that changes the issue shape fails loudly here
 * instead of silently mangling error output at consumer sites
 * (approval/api.ts, evidence/api.ts, config/loader.ts).
 */
function zodErrorFor(schema: z.ZodType, bad: unknown): z.ZodError {
  const result = schema.safeParse(bad)
  if (result.success) throw new Error('test setup: schema unexpectedly accepted input')
  return result.error
}

// ---------------------------------------------------------------------------
// formatZodErrors
// ---------------------------------------------------------------------------

describe('formatZodErrors', () => {
  it('formats a flat-path issue as "field"', () => {
    const err = zodErrorFor(z.object({ email: z.string() }), { email: 123 })
    const result = formatZodErrors(err)
    expect(result).toHaveLength(1)
    expect(result[0]?.path).toBe('email')
    // Don't couple to Zod's exact wording — those strings drift across
    // minors. Just assert we got a non-empty message through.
    expect(typeof result[0]?.message).toBe('string')
    expect(result[0]?.message.length).toBeGreaterThan(0)
  })

  it('formats a nested-path issue joined with dots', () => {
    const err = zodErrorFor(z.object({ user: z.object({ age: z.number() }) }), {
      user: { age: 'x' },
    })
    const result = formatZodErrors(err)
    expect(result).toHaveLength(1)
    expect(result[0]?.path).toBe('user.age')
  })

  it('formats an array-index issue with the numeric index stringified', () => {
    // Confirms Array.prototype.join coerces numeric indices to strings, so
    // the returned path is usable in dotted error strings like "items.1".
    const err = zodErrorFor(z.object({ items: z.array(z.string()) }), { items: ['a', 123] })
    const result = formatZodErrors(err)
    expect(result).toHaveLength(1)
    expect(result[0]?.path).toBe('items.1')
  })

  it('returns an empty-string path for a root-level issue', () => {
    // `z.string().safeParse(42)` puts the issue at the root; its `path` is
    // `[]`, which joins to `''`. Consumers that render the path often do
    // `path || '<root>'` — pin the empty string.
    const err = zodErrorFor(z.string(), 42)
    const result = formatZodErrors(err)
    expect(result).toHaveLength(1)
    expect(result[0]?.path).toBe('')
  })

  it('preserves multiple issues with their individual paths and messages', () => {
    const err = zodErrorFor(z.object({ a: z.string(), b: z.number() }), { a: 1, b: 'x' })
    const result = formatZodErrors(err)
    expect(result).toHaveLength(2)
    const paths = result.map((r) => r.path).sort()
    expect(paths).toEqual(['a', 'b'])
    for (const entry of result) {
      expect(typeof entry.message).toBe('string')
      expect(entry.message.length).toBeGreaterThan(0)
    }
  })
})
