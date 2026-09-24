import { describe, it, expect } from 'vitest'
import { formatUtcDay, formatUtcMinute } from './format-time.js'

describe('formatUtcDay', () => {
  it('prints the ISO 8601 calendar day in UTC', () => {
    expect(formatUtcDay('2026-09-23T12:27:38.535Z')).toBe('2026-09-23')
    expect(formatUtcDay('2026-01-05T00:00:00.000Z')).toBe('2026-01-05')
  })

  it('reads the day from UTC, not from the process zone', () => {
    // 23:30 in a zone west of UTC is already the next UTC day.
    expect(formatUtcDay('2026-09-23T23:30:00.000-05:00')).toBe('2026-09-24')
  })
})

describe('formatUtcMinute', () => {
  it('prints the day, the zero-padded hour and minute, and the zone label', () => {
    expect(formatUtcMinute('2026-09-23T12:27:38.535Z')).toBe('2026-09-23 12:27 UTC')
    expect(formatUtcMinute('2026-09-23T03:04:59.999Z')).toBe('2026-09-23 03:04 UTC')
  })
})
