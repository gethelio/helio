import { csvEscape } from '../audit/csv.js'
import type { BudgetEventRecord } from './ledger.js'

// ---------------------------------------------------------------------------
// CSV export utilities for the budget spend ledger — shared between the CLI
// export and the dashboard API export. Reuses the audit exporter's csvEscape
// so RFC 4180 quoting and the formula-injection guard (CWE-1236) stay
// single-sourced.
// ---------------------------------------------------------------------------

/** Column headers for CSV ledger export — the wire row, in wire order. */
export const BUDGET_EVENT_CSV_HEADERS = [
  'id',
  'budget_name',
  'bucket_key',
  'kind',
  'amount',
  'currency',
  'tool_name',
  'origin',
  'audit_record_id',
  'timestamp',
  'timestamp_ms',
  'created_at',
  // Appended LAST (issue #292): positional consumers of the existing
  // columns keep working — new columns always go at the end.
  'upstream',
] as const

/** Convert a single ledger event to a CSV row string. */
function eventToRow(event: BudgetEventRecord): string {
  return BUDGET_EVENT_CSV_HEADERS.map((h) => {
    const val: unknown = event[h]
    if (val === null || val === undefined) return ''
    if (typeof val === 'number') return String(val)
    if (typeof val === 'string') return csvEscape(val)
    return ''
  }).join(',')
}

/** Convert ledger events to a complete CSV string (header + rows). */
export function budgetEventsToCsv(events: readonly BudgetEventRecord[]): string {
  const lines: string[] = [BUDGET_EVENT_CSV_HEADERS.join(',')]
  for (const e of events) {
    lines.push(eventToRow(e))
  }
  return lines.join('\n')
}
