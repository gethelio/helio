import type { AuditRecord } from './types.js'

// ---------------------------------------------------------------------------
// CSV export utilities — shared between CLI export and dashboard API export.
// ---------------------------------------------------------------------------

/** Column headers for CSV audit export. */
export const CSV_HEADERS = [
  'id',
  'timestamp',
  'session_id',
  'agent_id',
  'tool_name',
  'tool_input',
  'policy_decision',
  'block_reason',
  'matched_rule',
  'evidence_chain',
  'approval_status',
  'approved_by',
  'upstream_response',
  'upstream_error',
  'upstream_http_status',
  'upstream_latency_ms',
  'total_duration_ms',
  'approval_wait_ms',
  'proxy_compute_ms',
  'flagged_destructive',
  'dry_run',
  'created_at',
  'environment',
  'matched_rule_index',
] as const

/**
 * Characters that spreadsheet applications (Excel, LibreOffice, Google
 * Sheets, Numbers) interpret as the start of a formula when they appear at
 * the first position of a cell. Any audit field whose value begins with one
 * of these must be neutralized before export so opening the CSV cannot
 * execute a live formula (CSV/formula injection, CWE-1236).
 */
const FORMULA_PREFIXES = /^[=+\-@\t\r]/

/**
 * Escape a string value for CSV.
 *
 * Quotes fields containing commas, newlines, or embedded double-quotes, and
 * additionally neutralizes formula-injection prefixes by prepending a single
 * quote and forcing a quote-wrap. The single quote sits inside the quoted
 * field so spreadsheet apps treat the cell as literal text, and a downstream
 * parser that strips the outer quotes still sees the harmless leading `'`.
 */
export function csvEscape(value: string): string {
  const needsQuote = value.includes(',') || value.includes('\n') || value.includes('"')
  const needsFormulaGuard = FORMULA_PREFIXES.test(value)

  let out = value
  if (needsFormulaGuard) out = `'${out}`
  if (needsQuote || needsFormulaGuard) out = `"${out.replace(/"/g, '""')}"`
  return out
}

/** Convert a single audit record to a CSV row string. */
function recordToRow(record: AuditRecord): string {
  return CSV_HEADERS.map((h) => {
    const val: unknown = record[h]
    if (val === null || val === undefined) return ''
    if (typeof val === 'boolean') return val ? 'true' : 'false'
    if (typeof val === 'number') return String(val)
    if (typeof val === 'string') return csvEscape(val)
    if (typeof val === 'object') return csvEscape(JSON.stringify(val))
    return ''
  }).join(',')
}

/** Convert an array of audit records to a complete CSV string (header + rows). */
export function recordsToCsv(records: readonly AuditRecord[]): string {
  const lines = [CSV_HEADERS.join(',')]
  for (const r of records) {
    lines.push(recordToRow(r))
  }
  return lines.join('\n')
}
