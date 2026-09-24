// ---------------------------------------------------------------------------
// Human-facing time formatting for CLI text. Every absolute date Helio prints
// for a person is ISO 8601 in UTC: the calendar day as `2026-09-23`, and a
// minute-precision instant as `2026-09-23 12:27 UTC`. The form is the one
// developers read at a glance in any country, it sorts, and it matches the
// ISO strings in every JSON field beside it. Machine-facing fields stay full
// ISO 8601 (`toISOString()`); relative durations are the config grammar.
// ---------------------------------------------------------------------------

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** `2026-09-23`: the ISO 8601 calendar day of `iso`, in UTC. */
export function formatUtcDay(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getUTCFullYear())}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

/** `2026-09-23 12:27 UTC`: the day and the zero-padded hour and minute of `iso`, in UTC. */
export function formatUtcMinute(iso: string): string {
  const d = new Date(iso)
  return `${formatUtcDay(iso)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
}
