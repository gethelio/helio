import { describe, it, expect } from 'vitest'
import { csvEscape, recordsToCsv, CSV_HEADERS } from './csv.js'
import type { AuditRecord } from './types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRecord(overrides: Partial<AuditRecord> = {}): AuditRecord {
  const defaults: AuditRecord = {
    id: 'rec-001',
    timestamp: '2025-01-15T10:00:00.000Z',
    session_id: 'sess-abc',
    agent_id: null,
    environment: null,
    tool_name: 'send_email',
    tool_input: { to: 'user@example.com' },
    policy_decision: 'allow',
    block_reason: null,
    matched_rule: 'rule-1',
    matched_rule_index: 0,
    evidence_chain: null,
    approval_status: null,
    approved_by: null,
    upstream_response: null,
    upstream_error: null,
    upstream_http_status: 200,
    upstream_latency_ms: 12,
    total_duration_ms: 3.5,
    approval_wait_ms: 0,
    proxy_compute_ms: 1.2,
    flagged_destructive: false,
    dry_run: false,
    created_at: '2025-01-15T10:00:00.100Z',
  }
  return {
    ...defaults,
    ...overrides,
    environment: overrides.environment ?? defaults.environment,
    matched_rule_index: overrides.matched_rule_index ?? defaults.matched_rule_index,
  }
}

// ---------------------------------------------------------------------------
// csvEscape
// ---------------------------------------------------------------------------

describe('csvEscape', () => {
  it('returns simple string unchanged', () => {
    expect(csvEscape('hello')).toBe('hello')
  })

  it('wraps string with comma in quotes', () => {
    expect(csvEscape('a,b')).toBe('"a,b"')
  })

  it('wraps string with newline in quotes', () => {
    expect(csvEscape('line1\nline2')).toBe('"line1\nline2"')
  })

  it('escapes double quotes as ""', () => {
    expect(csvEscape('say "hello"')).toBe('"say ""hello"""')
  })

  it('handles multiple special characters', () => {
    expect(csvEscape('a,b\n"c"')).toBe('"a,b\n""c"""')
  })

  it('returns empty string unchanged', () => {
    expect(csvEscape('')).toBe('')
  })

  // -------------------------------------------------------------------------
  // Formula injection (CSV injection) — prefixes =, +, -, @, \t, \r must be
  // neutralized so spreadsheet apps like Excel / LibreOffice / Google Sheets
  // do not interpret the value as a live formula.
  // -------------------------------------------------------------------------

  describe('formula injection', () => {
    it('neutralizes leading = by prepending a single quote and quote-wrapping', () => {
      expect(csvEscape('=1+2')).toBe(`"'=1+2"`)
    })

    it('neutralizes leading +', () => {
      expect(csvEscape('+cmd|calc!A0')).toBe(`"'+cmd|calc!A0"`)
    })

    it('neutralizes leading -', () => {
      expect(csvEscape('-2+3')).toBe(`"'-2+3"`)
    })

    it('neutralizes leading @', () => {
      expect(csvEscape('@SUM(A1:A10)')).toBe(`"'@SUM(A1:A10)"`)
    })

    it('neutralizes leading tab', () => {
      expect(csvEscape('\t=1')).toBe(`"'\t=1"`)
    })

    it('neutralizes leading carriage return', () => {
      expect(csvEscape('\r=1')).toBe(`"'\r=1"`)
    })

    it('escapes a value that both starts with = and contains a comma', () => {
      // The CSV-wrap must still happen, the embedded quote must still get
      // doubled if present, and the single-quote guard must be inside the
      // quoted field (not outside it).
      const result = csvEscape('=DDE("cmd";"/c calc")')
      expect(result).toBe(`"'=DDE(""cmd"";""/c calc"")"`)
    })

    it('leaves a value that only contains = in the middle untouched', () => {
      // Only the leading character triggers formula-guard treatment.
      expect(csvEscape('a=b')).toBe('a=b')
    })

    it('leaves an ordinary leading minus-free string untouched', () => {
      expect(csvEscape('hello world')).toBe('hello world')
    })
  })
})

// ---------------------------------------------------------------------------
// recordsToCsv
// ---------------------------------------------------------------------------

describe('recordsToCsv', () => {
  it('returns only header row for empty array', () => {
    const csv = recordsToCsv([])
    expect(csv).toBe(CSV_HEADERS.join(','))
  })

  it('serializes a single record with all fields', () => {
    const csv = recordsToCsv([makeRecord()])
    const lines = csv.split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe(CSV_HEADERS.join(','))

    const row = lines[1]
    expect(row).toBeDefined()
    expect(row).toContain('rec-001')
    expect(row).toContain('send_email')
    expect(row).toContain('allow')
    expect(row).toContain('rule-1')
    expect(row).toContain('3.5')
    expect(row).toContain('false')
  })

  it('handles null fields as empty cells', () => {
    const csv = recordsToCsv([makeRecord({ agent_id: null, evidence_chain: null })])
    const lines = csv.split('\n')
    const headers = (lines[0] ?? '').split(',')
    const row = lines[1]
    expect(row).toBeDefined()
    const cells = (row ?? '').split(',')
    const agentIdx = headers.indexOf('agent_id')
    const evidenceIdx = headers.indexOf('evidence_chain')
    expect(cells[agentIdx]).toBe('')
    expect(cells[evidenceIdx]).toBe('')
  })

  it('renders boolean fields as true/false strings', () => {
    const csv = recordsToCsv([makeRecord({ flagged_destructive: true, dry_run: true })])
    const row = csv.split('\n')[1]
    expect(row).toBeDefined()
    expect(row).toContain('true')
  })

  it('escapes special characters in field values', () => {
    const csv = recordsToCsv([makeRecord({ tool_name: 'tool,with,commas' })])
    const row = csv.split('\n')[1]
    expect(row).toBeDefined()
    expect(row).toContain('"tool,with,commas"')
  })

  it('includes all 24 AuditRecord fields in headers', () => {
    expect(CSV_HEADERS).toHaveLength(24)
    expect(CSV_HEADERS).toContain('tool_input')
    expect(CSV_HEADERS).toContain('block_reason')
    expect(CSV_HEADERS).toContain('evidence_chain')
    expect(CSV_HEADERS).toContain('upstream_response')
    expect(CSV_HEADERS).toContain('upstream_http_status')
    expect(CSV_HEADERS).toContain('total_duration_ms')
    expect(CSV_HEADERS).toContain('approval_wait_ms')
    expect(CSV_HEADERS).toContain('proxy_compute_ms')
    expect(CSV_HEADERS).toContain('environment')
    expect(CSV_HEADERS).toContain('matched_rule_index')
  })

  it('serializes object fields as JSON strings', () => {
    const csv = recordsToCsv([makeRecord({ tool_input: { amount: 100, currency: 'GBP' } })])
    const row = csv.split('\n')[1]
    expect(row).toBeDefined()
    expect(row).toContain('amount')
    expect(row).toContain('GBP')
  })

  it('serializes nested objects with special characters', () => {
    const csv = recordsToCsv([makeRecord({ tool_input: { query: 'a,b', note: 'say "hello"' } })])
    const row = csv.split('\n')[1]
    expect(row).toBeDefined()
    // The JSON string contains commas and quotes, so it gets CSV-escaped
    expect(row).toContain('say')
    expect(row).toContain('hello')
  })

  it('serializes multiple records', () => {
    const records = [
      makeRecord({ id: 'rec-001' }),
      makeRecord({ id: 'rec-002', tool_name: 'delete_user' }),
      makeRecord({ id: 'rec-003', policy_decision: 'deny' }),
    ]
    const lines = recordsToCsv(records).split('\n')
    expect(lines).toHaveLength(4) // header + 3 rows
    expect(lines[2]).toContain('delete_user')
    expect(lines[3]).toContain('deny')
  })
})
