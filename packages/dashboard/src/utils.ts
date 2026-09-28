// ---------------------------------------------------------------------------
// Shared formatting/display helpers used across multiple dashboard pages
// and components. Extracted to eliminate duplication.
// ---------------------------------------------------------------------------

/** Convert a snake_case decision or status string to Title Case. */
export function formatLabel(value: string): string {
  return value
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

/** Truncate an ID string to 8 characters with an ellipsis, or return an em-dash for null. */
export function truncateId(id: string | null): string {
  if (!id) return '\u2014'
  return id.length > 8 ? id.slice(0, 8) + '\u2026' : id
}

/**
 * Cap a display string at `max` characters and append a horizontal
 * ellipsis. Used for upstream-controlled fields like `upstream_error`
 * where a 1 MB string or a pathological control-character payload
 * would otherwise break the detail panel layout.
 */
export function truncateForDisplay(value: string, max = 4096): string {
  return value.length > max ? value.slice(0, max) + '\u2026' : value
}

/**
 * Safely stringify JSON-ish values for UI display and cap output size.
 * Returns both the display text and whether truncation occurred.
 */
export function stringifyForDisplay(
  value: unknown,
  max = 4096,
): { readonly text: string; readonly truncated: boolean } {
  let text: string
  try {
    text = JSON.stringify(value, null, 2)
  } catch {
    return { text: '"[unserializable value]"', truncated: false }
  }
  if (text.length <= max) return { text, truncated: false }
  return { text: `${text.slice(0, max)}\u2026`, truncated: true }
}

/** One side of a drift change as the approval card shows it (issue #60). */
export interface DriftValueView {
  /** The side is missing: the tool gained or dropped this aspect. */
  readonly absent: boolean
  readonly text: string
  readonly truncated: boolean
  /** UTF-8 bytes of the side's compact JSON; 0 when absent. */
  readonly bytes: number
}

/** Both sides of a drift change, plus the note when the window branch applies. */
export interface DriftValueViews {
  readonly baseline: DriftValueView
  readonly current: DriftValueView
  readonly note?: string
}

const ABSENT_VIEW: DriftValueView = { absent: true, text: 'absent', truncated: false, bytes: 0 }

/** Pretty-print a present drift side; the fallback matches {@link stringifyForDisplay}. */
function prettyDriftSide(value: unknown): { readonly pretty: string; readonly bytes: number } {
  try {
    return {
      pretty: JSON.stringify(value, null, 2),
      bytes: new TextEncoder().encode(JSON.stringify(value)).length,
    }
  } catch {
    return { pretty: '"[unserializable value]"', bytes: 0 }
  }
}

/** A `max`-character window of `text` from `start`, ellipses marking the cut ends. */
function windowOf(text: string, start: number, max: number): DriftValueView & { absent: false } {
  const end = Math.min(text.length, start + max)
  const truncated = start > 0 || end < text.length
  const slice = `${start > 0 ? '\u2026' : ''}${text.slice(start, end)}${end < text.length ? '\u2026' : ''}`
  return { absent: false, text: slice, truncated, bytes: 0 }
}

/**
 * Render both sides of a drift change for the approval card (issue #60).
 *
 * A missing side (`undefined`: the tool gained or dropped the aspect) is
 * the word `absent` with no length, decided before any stringify, since
 * `JSON.stringify(undefined)` is `undefined` and would throw downstream. A
 * JSON `null` is a present side. Two present sides that differ inside the
 * first `max` characters each render as {@link stringifyForDisplay} does,
 * whole when they fit. When they share that prefix (a large schema that
 * gained one property at its end), the two capped previews would be
 * identical and hide the change, so both sides open the SAME window: from
 * `context` characters before the first differing character, for `max`
 * characters, each clamped to its own end, with the note saying where the
 * first difference is.
 */
export function driftValueViews(
  baseline: unknown,
  current: unknown,
  max = 4096,
  context = 256,
): DriftValueViews {
  if (baseline === undefined && current === undefined) {
    return { baseline: ABSENT_VIEW, current: ABSENT_VIEW }
  }
  if (baseline === undefined) {
    const side = prettyDriftSide(current)
    return {
      baseline: ABSENT_VIEW,
      current: { absent: false, ...stringifyForDisplay(current, max), bytes: side.bytes },
    }
  }
  if (current === undefined) {
    const side = prettyDriftSide(baseline)
    return {
      baseline: { absent: false, ...stringifyForDisplay(baseline, max), bytes: side.bytes },
      current: ABSENT_VIEW,
    }
  }

  const left = prettyDriftSide(baseline)
  const right = prettyDriftSide(current)
  const sharedPrefix = left.pretty.slice(0, max) === right.pretty.slice(0, max)
  let firstDifference = -1
  if (sharedPrefix) {
    const shorter = Math.min(left.pretty.length, right.pretty.length)
    let i = max
    while (i < shorter && left.pretty.charAt(i) === right.pretty.charAt(i)) i += 1
    if (i < Math.max(left.pretty.length, right.pretty.length)) firstDifference = i
  }
  if (firstDifference < 0) {
    return {
      baseline: { absent: false, ...stringifyForDisplay(baseline, max), bytes: left.bytes },
      current: { absent: false, ...stringifyForDisplay(current, max), bytes: right.bytes },
    }
  }
  const start = Math.max(0, firstDifference - context)
  return {
    baseline: { ...windowOf(left.pretty, start, max), bytes: left.bytes },
    current: { ...windowOf(right.pretty, start, max), bytes: right.bytes },
    note: `the first difference is at character ${String(firstDifference)}`,
  }
}

/** Convert an ISO timestamp to a relative "time ago" string. */
export function timeAgo(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (seconds < 0) return 'just now'
  if (seconds < 60) return `${String(seconds)}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${String(minutes)}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${String(hours)}h ago`
  const days = Math.floor(hours / 24)
  return `${String(days)}d ago`
}

/** `2026-09-23`: the ISO 8601 calendar day of `iso` in UTC, the form every CLI line prints for a person. */
export function formatUtcDay(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${String(d.getUTCFullYear())}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

/** `2026-09-23 14:23:45 UTC`: the day and the second-precision time of `iso` in UTC, the zone on the face. */
export function formatTimestamp(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${formatUtcDay(iso)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`
}

/**
 * `14:00`: the zero-padded UTC hour of `iso` for a chart tick; with `label`,
 * `14:00 UTC` for a tooltip that is read without the chart's heading.
 */
export function formatUtcHour(iso: string, options: { readonly label?: boolean } = {}): string {
  const hour = `${String(new Date(iso).getUTCHours()).padStart(2, '0')}:00`
  return options.label ? `${hour} UTC` : hour
}

/** Format a latency value in milliseconds to a human-readable string. */
export function formatLatency(ms: number): string {
  if (ms < 1) return '<1ms'
  if (ms < 1000) return `${String(Math.round(ms))}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const totalSeconds = Math.round(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes)}m ${String(seconds)}s`
}

/** Return a Tailwind `bg-*` class based on usage percentage. */
export function usageColor(current: number, limit: number): string {
  if (limit === 0) return 'bg-gray-300'
  const pct = current / limit
  if (pct >= 1) return 'bg-red-500'
  if (pct >= 0.8) return 'bg-amber-500'
  return 'bg-emerald-500'
}

/** Compute usage as a percentage clamped to 0-100. */
export function usagePercent(current: number, limit: number): number {
  if (limit === 0) return 0
  return Math.min(100, (current / limit) * 100)
}

/** Format remaining milliseconds as a countdown string (e.g. "2m 30s"). */
export function formatCountdown(remainingMs: number): string {
  if (remainingMs <= 0) return 'Expired'
  const totalSec = Math.ceil(remainingMs / 1000)
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  if (min > 0) return `${String(min)}m ${String(sec)}s`
  return `${String(sec)}s`
}

/** Format an amount in a currency, falling back to a plain prefix form. */
export function formatCurrency(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount)
  } catch {
    return `${currency} ${amount.toFixed(2)}`
  }
}
