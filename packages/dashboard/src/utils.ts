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

/** Format an ISO string as YYYY-MM-DD HH:MM:SS. */
export function formatTimestamp(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
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
