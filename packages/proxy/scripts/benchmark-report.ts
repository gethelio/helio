/**
 * Helio Proxy Performance Benchmark — pure reporting and gate logic.
 *
 * Split out of benchmark.ts so the gate, the Markdown report, and the audit
 * decomposition can be unit tested without running a 10,000-request
 * benchmark. This module holds no I/O: benchmark.ts owns the phases, the
 * console, the file write, and the exit status.
 */

import { cpus, totalmem, platform, arch } from 'node:os'
import type { AuditStore } from '../src/audit/index.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const P99_TARGET_MS = 5
const AUDIT_PAGE_SIZE = 1_000

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LatencyStats {
  count: number
  p50: number
  p95: number
  p99: number
  max: number
  avg: number
}

export interface MemorySnapshot {
  label: string
  heapUsedMB: number
  rssMB: number
}

export interface BenchmarkResults {
  transparent: { stats: LatencyStats; throughput: number }
  governed: {
    external: { stats: LatencyStats; throughput: number }
    proxyInternal: LatencyStats
    upstreamInternal: LatencyStats
    overhead: LatencyStats
  }
  memory: MemorySnapshot[]
  sqlite: { records: number; durationMs: number; throughput: number }
  gcExposed: boolean
}

/** One check whose result decides the process exit status. */
export interface GateCheck {
  label: string
  targetMs: number
  actualMs: number
  pass: boolean
}

/** A measured number that is reported but never gated on. */
export interface ContextMeasurement {
  label: string
  p99Ms: number
}

export interface GateResult {
  pass: boolean
  checks: GateCheck[]
  context: ContextMeasurement[]
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

export function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.max(0, idx)]!
}

export function computeStats(durations: number[]): LatencyStats {
  const sorted = [...durations].sort((a, b) => a - b)
  const avg = durations.reduce((sum, d) => sum + d, 0) / durations.length
  return {
    count: durations.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1] ?? 0,
    avg,
  }
}

/**
 * Paginate through audit records and extract latency arrays.
 * Skips the first `offset` records (warmup) and reads `count` records.
 *
 * The three series are distinct quantities: the proxy total is the whole
 * governed request, the upstream latency is the forwarded call, and the
 * overhead is what the proxy itself spent (total minus upstream minus any
 * approval wait).
 */
export function collectAuditLatencies(
  store: AuditStore,
  count: number,
  warmupOffset: number,
): { proxyLatencies: number[]; upstreamLatencies: number[]; overheadLatencies: number[] } {
  const proxyLatencies: number[] = []
  const upstreamLatencies: number[] = []
  const overheadLatencies: number[] = []

  for (let offset = warmupOffset; offset < warmupOffset + count; offset += AUDIT_PAGE_SIZE) {
    const page = store.list({}, { limit: AUDIT_PAGE_SIZE, offset, order: 'asc' })
    for (const record of page.records) {
      proxyLatencies.push(record.total_duration_ms)
      const upstream = record.upstream_latency_ms ?? 0
      upstreamLatencies.push(upstream)
      overheadLatencies.push(record.proxy_compute_ms)
    }
  }

  return { proxyLatencies, upstreamLatencies, overheadLatencies }
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

/**
 * Evaluate the one check that decides the exit status: the governed overhead
 * p99 against the budget.
 *
 * The transparent and governed end-to-end p99s are measured from the
 * benchmark client and therefore include the mock upstream, which on a loaded
 * box exceeds the budget on its own. They are returned as context so the
 * numbers stay visible, and they never decide the exit status.
 */
export function evaluateGate(results: BenchmarkResults, budgetMs: number): GateResult {
  const overheadP99 = results.governed.overhead.p99
  const check: GateCheck = {
    label: 'Governed (overhead)',
    targetMs: budgetMs,
    actualMs: overheadP99,
    pass: overheadP99 < budgetMs,
  }

  return {
    pass: check.pass,
    checks: [check],
    context: [
      { label: 'Transparent', p99Ms: results.transparent.stats.p99 },
      { label: 'Governed (external)', p99Ms: results.governed.external.stats.p99 },
    ],
  }
}

export function formatGateSummary(gate: GateResult): string {
  const lines = gate.checks.map((c) =>
    c.pass
      ? `Gate: ${c.label} p99 ${c.actualMs.toFixed(2)}ms < ${String(c.targetMs)}ms PASS`
      : `Gate: ${c.label} p99 ${c.actualMs.toFixed(2)}ms >= ${String(c.targetMs)}ms FAIL`,
  )

  lines.push('Context (not gated; end-to-end from the client, includes the mock upstream):')
  for (const c of gate.context) {
    const label = `${c.label} p99:`.padEnd(25)
    lines.push(`  ${label}${c.p99Ms.toFixed(2)}ms`)
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Markdown report generation
// ---------------------------------------------------------------------------

export function fmt(n: number, decimals = 2): string {
  return n.toFixed(decimals)
}

export function fmtInt(n: number): string {
  return n.toLocaleString('en-US')
}

export function generateMarkdownReport(results: BenchmarkResults): string {
  const now = new Date().toISOString()
  const cpu = cpus()
  const cpuModel = cpu[0]?.model ?? 'unknown'
  const cpuCount = cpu.length
  const totalMemGB = (totalmem() / 1024 / 1024 / 1024).toFixed(0)

  const t = results.transparent
  const g = results.governed
  const mem = results.memory
  const sq = results.sqlite

  const lines: string[] = [
    '# Helio Proxy Performance Benchmark',
    '',
    `> Generated: ${now} | Node ${process.version} | ${platform()} ${arch()}`,
    '',
    '## Environment',
    '',
    '| Property | Value |',
    '| --- | --- |',
    `| Node.js | ${process.version} |`,
    `| Platform | ${platform()} ${arch()} |`,
    `| CPU | ${cpuModel} (${String(cpuCount)} cores) |`,
    `| Memory | ${totalMemGB} GB |`,
    `| GC exposed | ${results.gcExposed ? 'yes' : 'no'} |`,
    '',
    `## 1. Transparent Proxy (${fmtInt(t.stats.count)} requests)`,
    '',
    'Baseline: no policy evaluation, no audit writing.',
    '',
    '| Metric | Value |',
    '| --- | --- |',
    `| p50 | ${fmt(t.stats.p50)}ms |`,
    `| p95 | ${fmt(t.stats.p95)}ms |`,
    `| p99 | ${fmt(t.stats.p99)}ms |`,
    `| max | ${fmt(t.stats.max)}ms |`,
    `| avg | ${fmt(t.stats.avg)}ms |`,
    `| Throughput | ${fmtInt(Math.round(t.throughput))} req/s |`,
    '',
    `## 2. Governed Proxy \u2014 External Round-Trip (${fmtInt(g.external.stats.count)} requests)`,
    '',
    'Full governance pipeline: policy evaluation + upstream forward + audit write.',
    'Measured from the benchmark client (includes client\u2194proxy network overhead).',
    '',
    '| Metric | Value |',
    '| --- | --- |',
    `| p50 | ${fmt(g.external.stats.p50)}ms |`,
    `| p95 | ${fmt(g.external.stats.p95)}ms |`,
    `| p99 | ${fmt(g.external.stats.p99)}ms |`,
    `| max | ${fmt(g.external.stats.max)}ms |`,
    `| avg | ${fmt(g.external.stats.avg)}ms |`,
    `| Throughput | ${fmtInt(Math.round(g.external.throughput))} req/s |`,
    '',
    '## 3. Latency Overhead Decomposition (from audit records)',
    '',
    'Internal proxy timing extracted from audit records. Overhead = proxy total \u2212 upstream',
    '\u2212 approval wait; the approval wait is zero in this harness, because the allow rule the',
    'benchmark configures never queues an approval.',
    '',
    '| Percentile | Proxy Total | Upstream | Overhead |',
    '| --- | --- | --- | --- |',
    `| p50 | ${fmt(g.proxyInternal.p50)}ms | ${fmt(g.upstreamInternal.p50)}ms | ${fmt(g.overhead.p50)}ms |`,
    `| p95 | ${fmt(g.proxyInternal.p95)}ms | ${fmt(g.upstreamInternal.p95)}ms | ${fmt(g.overhead.p95)}ms |`,
    `| p99 | ${fmt(g.proxyInternal.p99)}ms | ${fmt(g.upstreamInternal.p99)}ms | ${fmt(g.overhead.p99)}ms |`,
    `| max | ${fmt(g.proxyInternal.max)}ms | ${fmt(g.upstreamInternal.max)}ms | ${fmt(g.overhead.max)}ms |`,
    `| avg | ${fmt(g.proxyInternal.avg)}ms | ${fmt(g.upstreamInternal.avg)}ms | ${fmt(g.overhead.avg)}ms |`,
    '',
    '## 4. Memory Usage',
    '',
  ]

  if (mem.length >= 4) {
    lines.push('| Checkpoint | Heap Used | RSS |', '| --- | --- | --- |')
    for (const s of mem) {
      lines.push(`| ${s.label} | ${fmt(s.heapUsedMB, 1)} MB | ${fmt(s.rssMB, 1)} MB |`)
    }
    const memAfterWarmup = mem[1]!
    const memAfter10K = mem[2]!
    const heapDelta = memAfter10K.heapUsedMB - memAfterWarmup.heapUsedMB
    const rssDelta = memAfter10K.rssMB - memAfterWarmup.rssMB
    lines.push(
      `| **Delta (warmup \u2192 10K)** | **${heapDelta >= 0 ? '+' : ''}${fmt(heapDelta, 1)} MB** | **${rssDelta >= 0 ? '+' : ''}${fmt(rssDelta, 1)} MB** |`,
    )
  }

  lines.push(
    '',
    '## 5. SQLite Audit Write Throughput',
    '',
    'Effective throughput: audit writes interleaved with request processing (real-world scenario).',
    'Audit records are batched by AuditWriter and flushed to SQLite in transactions.',
    '',
    '| Metric | Value |',
    '| --- | --- |',
    `| Records written | ${fmtInt(sq.records)} |`,
    `| Wall clock time | ${fmt(sq.durationMs / 1000, 2)}s |`,
    `| Throughput | ${fmtInt(Math.round(sq.throughput))} records/s |`,
    '',
    '## Gate',
    '',
    '| Check | Target | Actual | Status |',
    '| --- | --- | --- | --- |',
  )

  const check = evaluateGate(results, P99_TARGET_MS).checks[0]!
  lines.push(
    `| Governed p99 (overhead) | < ${String(check.targetMs)}ms | ${fmt(check.actualMs)}ms | **${check.pass ? 'PASS' : 'FAIL'}** |`,
    '',
    'The end-to-end p99s in sections 1 and 2 are measured from the benchmark client and include the',
    'mock upstream, so they are context, not gates. The gated number is the governance overhead:',
    '`proxy_compute_ms` from the audit records, which is the governed pipeline from request receipt',
    'in the forwarder to the audit write, minus the upstream call and any approval wait (zero in',
    'this harness). It excludes the HTTP transport handler around the forwarder: request parsing',
    'and validation before the call, and response serialization after it.',
  )

  lines.push('')
  return lines.join('\n')
}
