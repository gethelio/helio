import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  formatCountdown,
  formatLabel,
  formatLatency,
  formatTimestamp,
  timeAgo,
  truncateForDisplay,
  truncateId,
  usageColor,
  usagePercent,
} from './utils'

// ---------------------------------------------------------------------------
// formatLabel
// ---------------------------------------------------------------------------

describe('formatLabel', () => {
  it('title-cases a single word', () => {
    expect(formatLabel('allow')).toBe('Allow')
    expect(formatLabel('deny')).toBe('Deny')
  })

  it('converts snake_case to Title Case with spaces', () => {
    expect(formatLabel('require_approval')).toBe('Require Approval')
    expect(formatLabel('break_glass')).toBe('Break Glass')
  })

  it('handles multiple underscores', () => {
    expect(formatLabel('rate_limit_exceeded')).toBe('Rate Limit Exceeded')
  })

  it('returns an empty string unchanged', () => {
    expect(formatLabel('')).toBe('')
  })

  it('preserves case after the first character of each word', () => {
    expect(formatLabel('camelCase_value')).toBe('CamelCase Value')
  })
})

// ---------------------------------------------------------------------------
// truncateId
// ---------------------------------------------------------------------------

describe('truncateId', () => {
  it('returns an em-dash for null', () => {
    expect(truncateId(null)).toBe('\u2014')
  })

  it('returns an em-dash for an empty string (falsy guard)', () => {
    expect(truncateId('')).toBe('\u2014')
  })

  it('leaves IDs of 8 characters or fewer unchanged', () => {
    expect(truncateId('abc')).toBe('abc')
    expect(truncateId('12345678')).toBe('12345678')
  })

  it('truncates IDs longer than 8 characters with a horizontal ellipsis', () => {
    expect(truncateId('123456789')).toBe('12345678\u2026')
    expect(truncateId('very-long-session-id-abc-123')).toBe('very-lon\u2026')
  })
})

// ---------------------------------------------------------------------------
// truncateForDisplay
// ---------------------------------------------------------------------------

describe('truncateForDisplay', () => {
  it('leaves short strings unchanged at the default cap (4096)', () => {
    expect(truncateForDisplay('hello world')).toBe('hello world')
  })

  it('leaves an empty string unchanged', () => {
    expect(truncateForDisplay('')).toBe('')
  })

  it('truncates strings beyond the default cap', () => {
    const long = 'x'.repeat(4097)
    const result = truncateForDisplay(long)
    expect(result).toHaveLength(4097) // 4096 x's + ellipsis
    expect(result.endsWith('\u2026')).toBe(true)
    expect(result.slice(0, 4096)).toBe('x'.repeat(4096))
  })

  it('respects a custom max', () => {
    expect(truncateForDisplay('abcdefghij', 5)).toBe('abcde\u2026')
  })

  it('leaves a string exactly at the custom max unchanged', () => {
    expect(truncateForDisplay('abcde', 5)).toBe('abcde')
  })

  it('truncates a string one character over the custom max', () => {
    expect(truncateForDisplay('abcdef', 5)).toBe('abcde\u2026')
  })
})

// ---------------------------------------------------------------------------
// timeAgo
// ---------------------------------------------------------------------------

describe('timeAgo', () => {
  // Fix "now" to a known instant so the relative math is deterministic.
  const NOW = new Date('2026-04-15T12:00:00.000Z')

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /** Build an ISO timestamp `offsetMs` ahead of NOW. Negative = in the past. */
  function atOffset(offsetMs: number): string {
    return new Date(NOW.getTime() + offsetMs).toISOString()
  }

  it('returns "just now" for a future timestamp', () => {
    expect(timeAgo(atOffset(5_000))).toBe('just now')
  })

  it('returns seconds for sub-minute deltas', () => {
    expect(timeAgo(atOffset(-1_000))).toBe('1s ago')
    expect(timeAgo(atOffset(-30_000))).toBe('30s ago')
    expect(timeAgo(atOffset(-59_000))).toBe('59s ago')
  })

  it('returns minutes starting at 60 seconds', () => {
    expect(timeAgo(atOffset(-60_000))).toBe('1m ago')
    expect(timeAgo(atOffset(-90_000))).toBe('1m ago')
    expect(timeAgo(atOffset(-59 * 60_000))).toBe('59m ago')
  })

  it('returns hours starting at 60 minutes', () => {
    expect(timeAgo(atOffset(-60 * 60_000))).toBe('1h ago')
    expect(timeAgo(atOffset(-23 * 60 * 60_000))).toBe('23h ago')
  })

  it('returns days starting at 24 hours', () => {
    expect(timeAgo(atOffset(-24 * 60 * 60_000))).toBe('1d ago')
    expect(timeAgo(atOffset(-7 * 24 * 60 * 60_000))).toBe('7d ago')
  })

  it('returns "0s ago" for a timestamp exactly equal to now', () => {
    expect(timeAgo(NOW.toISOString())).toBe('0s ago')
  })
})

// ---------------------------------------------------------------------------
// formatTimestamp
// ---------------------------------------------------------------------------

describe('formatTimestamp', () => {
  // Using an ISO string WITHOUT a timezone suffix is deterministic across
  // test environments: JS parses it as local time, then pulls local
  // components back out — the round-trip gives the same components we
  // passed in regardless of the machine's TZ setting.

  it('formats a timestamp as YYYY-MM-DD HH:MM:SS', () => {
    expect(formatTimestamp('2024-03-15T14:23:45')).toBe('2024-03-15 14:23:45')
  })

  it('pads single-digit month, day, hour, minute, and second', () => {
    expect(formatTimestamp('2024-01-05T09:03:07')).toBe('2024-01-05 09:03:07')
  })

  it('handles the end of a year', () => {
    expect(formatTimestamp('2024-12-31T23:59:59')).toBe('2024-12-31 23:59:59')
  })

  it('handles midnight', () => {
    expect(formatTimestamp('2024-03-15T00:00:00')).toBe('2024-03-15 00:00:00')
  })
})

// ---------------------------------------------------------------------------
// formatLatency
// ---------------------------------------------------------------------------

describe('formatLatency', () => {
  it('collapses sub-millisecond values to "<1ms"', () => {
    expect(formatLatency(0)).toBe('<1ms')
    expect(formatLatency(0.5)).toBe('<1ms')
    expect(formatLatency(0.999)).toBe('<1ms')
  })

  it('formats millisecond values under one second', () => {
    expect(formatLatency(1)).toBe('1ms')
    expect(formatLatency(42)).toBe('42ms')
    expect(formatLatency(999)).toBe('999ms')
  })

  it('rounds fractional millisecond values to nearest integer', () => {
    // V8's Math.round rounds .5 up for positive numbers
    expect(formatLatency(1.5)).toBe('2ms')
    expect(formatLatency(2.5)).toBe('3ms')
    expect(formatLatency(12.3)).toBe('12ms')
    expect(formatLatency(12.7)).toBe('13ms')
  })

  it('formats second-scale values with one decimal place', () => {
    expect(formatLatency(1000)).toBe('1.0s')
    expect(formatLatency(1500)).toBe('1.5s')
    expect(formatLatency(59_999)).toBe('60.0s')
  })

  it('formats minute-scale values as Xm Ys', () => {
    expect(formatLatency(60_000)).toBe('1m 0s')
    expect(formatLatency(147_344)).toBe('2m 27s')
    expect(formatLatency(119_500)).toBe('2m 0s')
  })
})

// ---------------------------------------------------------------------------
// usageColor
// ---------------------------------------------------------------------------

describe('usageColor', () => {
  it('returns gray when the limit is zero', () => {
    expect(usageColor(0, 0)).toBe('bg-gray-300')
    expect(usageColor(5, 0)).toBe('bg-gray-300')
  })

  it('returns emerald below 80% utilization', () => {
    expect(usageColor(0, 100)).toBe('bg-emerald-500')
    expect(usageColor(50, 100)).toBe('bg-emerald-500')
    expect(usageColor(79, 100)).toBe('bg-emerald-500')
  })

  it('returns amber at exactly 80% utilization (>= boundary)', () => {
    expect(usageColor(80, 100)).toBe('bg-amber-500')
  })

  it('returns amber between 80% and 100%', () => {
    expect(usageColor(99, 100)).toBe('bg-amber-500')
  })

  it('returns red at exactly 100% utilization (>= boundary)', () => {
    expect(usageColor(100, 100)).toBe('bg-red-500')
  })

  it('returns red above 100% utilization', () => {
    expect(usageColor(150, 100)).toBe('bg-red-500')
  })
})

// ---------------------------------------------------------------------------
// usagePercent
// ---------------------------------------------------------------------------

describe('usagePercent', () => {
  it('returns 0 when the limit is zero (zero-limit guard)', () => {
    expect(usagePercent(0, 0)).toBe(0)
    expect(usagePercent(5, 0)).toBe(0)
  })

  it('returns 0 for zero current', () => {
    expect(usagePercent(0, 100)).toBe(0)
  })

  it('returns the raw percentage for sub-limit values', () => {
    expect(usagePercent(25, 100)).toBe(25)
    expect(usagePercent(50, 100)).toBe(50)
    expect(usagePercent(80, 100)).toBe(80)
  })

  it('returns exactly 100 at the limit', () => {
    expect(usagePercent(100, 100)).toBe(100)
  })

  it('clamps values above 100%', () => {
    expect(usagePercent(150, 100)).toBe(100)
    expect(usagePercent(9999, 100)).toBe(100)
  })
})

// ---------------------------------------------------------------------------
// formatCountdown
// ---------------------------------------------------------------------------

describe('formatCountdown', () => {
  it('returns "Expired" for zero or negative remaining', () => {
    expect(formatCountdown(0)).toBe('Expired')
    expect(formatCountdown(-1)).toBe('Expired')
    expect(formatCountdown(-5_000)).toBe('Expired')
  })

  it('rounds sub-second values UP to 1s (ceiling, not floor)', () => {
    // ceil ensures we never show "0s" before the timer has actually expired
    expect(formatCountdown(1)).toBe('1s')
    expect(formatCountdown(500)).toBe('1s')
    expect(formatCountdown(999)).toBe('1s')
  })

  it('formats sub-minute remaining as "Ns"', () => {
    expect(formatCountdown(1_000)).toBe('1s')
    expect(formatCountdown(30_000)).toBe('30s')
    expect(formatCountdown(59_000)).toBe('59s')
  })

  it('formats minute-plus remaining as "Nm Ss"', () => {
    expect(formatCountdown(60_000)).toBe('1m 0s')
    expect(formatCountdown(90_000)).toBe('1m 30s')
    expect(formatCountdown(150_000)).toBe('2m 30s')
  })

  it('does not roll minutes into hours — 60 minutes stays as "60m 0s"', () => {
    // Used for approval countdowns which max out in the low single-digit
    // minutes in practice; the function deliberately has no hour bucket.
    expect(formatCountdown(3_600_000)).toBe('60m 0s')
  })
})
