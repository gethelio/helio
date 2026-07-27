import { describe, it, expect } from 'vitest'
import { BUDGET_EVENT_CSV_HEADERS, budgetEventsToCsv } from './csv.js'
import type { BudgetEventRecord } from './ledger.js'

function eventRecord(overrides: Partial<BudgetEventRecord> = {}): BudgetEventRecord {
  return {
    id: 'event-1',
    budget_name: 'daily-cap',
    bucket_key: 'budget:daily-cap:global',
    kind: 'spend',
    amount: 25,
    currency: 'USD',
    tool_name: 'stripe_charge',
    origin: 'mcp',
    audit_record_id: 'audit-1',
    timestamp: '2026-07-10T12:00:00.000Z',
    timestamp_ms: 1_000_000,
    created_at: '2026-07-10T12:00:00.012Z',
    ...overrides,
  }
}

describe('budgetEventsToCsv', () => {
  it('emits the wire row columns as the header line, in wire order', () => {
    expect(BUDGET_EVENT_CSV_HEADERS).toEqual([
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
    ])
    const csv = budgetEventsToCsv([eventRecord()])
    expect(csv.split('\n')[0]).toBe(
      'id,budget_name,bucket_key,kind,amount,currency,tool_name,origin,' +
        'audit_record_id,timestamp,timestamp_ms,created_at',
    )
  })

  it('serializes a full row: numbers unquoted, null audit_record_id as an empty cell', () => {
    const csv = budgetEventsToCsv([eventRecord({ amount: 12.5, audit_record_id: null })])
    expect(csv.split('\n')[1]).toBe(
      'event-1,daily-cap,budget:daily-cap:global,spend,12.5,USD,stripe_charge,mcp,,' +
        '2026-07-10T12:00:00.000Z,1000000,2026-07-10T12:00:00.012Z',
    )
  })

  it('quotes fields containing commas, quotes, or newlines', () => {
    const csv = budgetEventsToCsv([
      eventRecord({ bucket_key: 'budget:daily-cap:session:a,b', tool_name: 'say "hi"\nnow' }),
    ])
    const row = csv.split('\n')[1] ?? ''
    expect(row).toContain('"budget:daily-cap:session:a,b"')
    expect(csv).toContain('"say ""hi""')
  })

  it('neutralizes formula-prefix values via the shared escape', () => {
    const csv = budgetEventsToCsv([eventRecord({ tool_name: '=SUM(A1:A9)' })])
    expect(csv.split('\n')[1]).toContain('"\'=SUM(A1:A9)"')
  })

  it('emits the header line only for zero events, without a trailing newline', () => {
    const csv = budgetEventsToCsv([])
    expect(csv).toBe(
      'id,budget_name,bucket_key,kind,amount,currency,tool_name,origin,' +
        'audit_record_id,timestamp,timestamp_ms,created_at',
    )
  })
})
