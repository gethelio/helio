import { describe, it, expect } from 'vitest'
import {
  collectAuditLatencies,
  evaluateGate,
  formatGateSummary,
  generateMarkdownReport,
  type BenchmarkResults,
  type LatencyStats,
} from './benchmark-report.js'
import { AuditStore } from '../src/audit/index.js'
import type { AuditRecord } from '../src/audit/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStats(overrides: Partial<LatencyStats> = {}): LatencyStats {
  return {
    count: 10_000,
    p50: 1,
    p95: 2,
    p99: 3,
    max: 4,
    avg: 1.5,
    ...overrides,
  }
}

/**
 * A results fixture whose end-to-end p99s sit far over the 5ms budget while
 * the governed overhead sits far under it — the shape every real run on a
 * loaded box produces.
 */
function makeResults(
  overrides: { endToEndP99?: number; overheadP99?: number } = {},
): BenchmarkResults {
  const endToEndP99 = overrides.endToEndP99 ?? 40
  const overheadP99 = overrides.overheadP99 ?? 0.2
  return {
    transparent: { stats: makeStats({ p99: endToEndP99 }), throughput: 100 },
    governed: {
      external: { stats: makeStats({ p99: endToEndP99 }), throughput: 200 },
      proxyInternal: makeStats({ p50: 10.5, p95: 12, p99: 15, max: 20, avg: 11 }),
      upstreamInternal: makeStats({ p50: 10.3, p95: 11.8, p99: 14.8, max: 19, avg: 10.8 }),
      overhead: makeStats({ p50: 0.05, p95: 0.1, p99: overheadP99, max: 0.5, avg: 0.06 }),
    },
    memory: [
      { label: 'Before warmup', heapUsedMB: 10, rssMB: 100 },
      { label: 'After warmup', heapUsedMB: 11, rssMB: 110 },
      { label: 'After 10K requests', heapUsedMB: 12, rssMB: 120 },
      { label: 'After flush', heapUsedMB: 12.5, rssMB: 125 },
    ],
    sqlite: { records: 10_000, durationMs: 43_000, throughput: 232 },
    gcExposed: false,
  }
}

// Copied verbatim from src/audit/store.test.ts — the helper is not exported,
// and every NOT NULL column has to be present for the insert to succeed.
type InsertRecord = Omit<AuditRecord, 'id' | 'created_at'>

function makeRecord(overrides: Partial<InsertRecord> = {}): InsertRecord {
  const defaults: InsertRecord = {
    timestamp: new Date().toISOString(),
    session_id: null,
    session_source: null,
    agent_id: null,
    environment: null,
    tool_name: 'test_tool',
    tool_input: { key: 'value' },
    policy_decision: 'allow',
    block_reason: null,
    matched_rule: null,
    matched_rule_index: null,
    evidence_chain: null,
    approval_status: null,
    approved_by: null,
    upstream_response: { result: 'ok' },
    upstream_error: null,
    upstream_http_status: 200,
    upstream_latency_ms: 10,
    total_duration_ms: 15,
    approval_wait_ms: 0,
    proxy_compute_ms: 5,
    flagged_destructive: false,
    dry_run: false,
    record_kind: 'tool_call',
    origin: 'mcp',
    metadata: null,
    protocol_version: null,
    upstream: null,
  }
  return {
    ...defaults,
    ...overrides,
    environment: overrides.environment ?? defaults.environment,
    matched_rule_index: overrides.matched_rule_index ?? defaults.matched_rule_index,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('evaluateGate', () => {
  it('gates on the governed overhead p99 alone and keeps the end-to-end p99s as context', () => {
    const gate = evaluateGate(makeResults(), 5)

    expect(gate.pass).toBe(true)
    expect(gate.checks).toHaveLength(1)
    expect(gate.checks[0]).toEqual({
      label: 'Governed (overhead)',
      targetMs: 5,
      actualMs: 0.2,
      pass: true,
    })
    expect(gate.context).toEqual([
      { label: 'Transparent', p99Ms: 40 },
      { label: 'Governed (external)', p99Ms: 40 },
    ])
  })

  it('fails at the budget and passes just under it', () => {
    expect(evaluateGate(makeResults({ endToEndP99: 3, overheadP99: 5 }), 5).pass).toBe(false)
    expect(evaluateGate(makeResults({ endToEndP99: 3, overheadP99: 4.999 }), 5).pass).toBe(true)
  })
})

describe('generateMarkdownReport', () => {
  it('renders one gate row and says the end-to-end numbers are context', () => {
    const md = generateMarkdownReport(makeResults())

    expect(md).toContain('## Gate')
    expect(md).not.toContain('## Pass/Fail')
    expect(md.match(/\*\*(?:PASS|FAIL)\*\*/g)).toHaveLength(1)
    expect(md).toContain('| Governed p99 (overhead) | < 5ms | 0.20ms | **PASS** |')
    expect(md).not.toContain('**FAIL**')
    expect(md).toContain('so they are context, not gates')
    expect(md).toContain('`proxy_compute_ms` from the audit records')
    expect(md).toContain('excludes the HTTP transport handler around the forwarder')
  })
})

describe('formatGateSummary', () => {
  it('prints the one gate line above the two context lines', () => {
    expect(formatGateSummary(evaluateGate(makeResults(), 5))).toBe(
      [
        'Gate: Governed (overhead) p99 0.20ms < 5ms PASS',
        'Context (not gated; end-to-end from the client, includes the mock upstream):',
        '  Transparent p99:         40.00ms',
        '  Governed (external) p99: 40.00ms',
      ].join('\n'),
    )
  })

  it('flips only the gate line when the overhead is over budget', () => {
    expect(formatGateSummary(evaluateGate(makeResults({ overheadP99: 6.2 }), 5))).toBe(
      [
        'Gate: Governed (overhead) p99 6.20ms >= 5ms FAIL',
        'Context (not gated; end-to-end from the client, includes the mock upstream):',
        '  Transparent p99:         40.00ms',
        '  Governed (external) p99: 40.00ms',
      ].join('\n'),
    )
  })
})

describe('collectAuditLatencies', () => {
  it('reads the proxy total, the upstream latency, and the overhead as three distinct series', () => {
    const store = new AuditStore({
      path: ':memory:',
      retention: '90d',
      includeResponses: true,
      cleanupIntervalMs: 0,
    })

    try {
      store.insert(
        makeRecord({ total_duration_ms: 15, upstream_latency_ms: 10, proxy_compute_ms: 5 }),
        '2026-09-02T00:00:01.000Z',
      )
      store.insert(
        makeRecord({ total_duration_ms: 25, upstream_latency_ms: 20, proxy_compute_ms: 5 }),
        '2026-09-02T00:00:02.000Z',
      )
      store.insert(
        makeRecord({ total_duration_ms: 35, upstream_latency_ms: 30, proxy_compute_ms: 5 }),
        '2026-09-02T00:00:03.000Z',
      )

      const latencies = collectAuditLatencies(store, 3, 0)

      expect(latencies.proxyLatencies).toEqual([15, 25, 35])
      expect(latencies.upstreamLatencies).toEqual([10, 20, 30])
      expect(latencies.overheadLatencies).toEqual([5, 5, 5])
    } finally {
      store.close()
    }
  })
})
