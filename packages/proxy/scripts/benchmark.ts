/**
 * Helio Proxy Performance Benchmark
 *
 * Sends 10,000 sequential tools/call requests through the governed proxy
 * and measures latency overhead, throughput, memory usage, and SQLite
 * write throughput. Outputs results to the console and generates a
 * Markdown report at docs/benchmark-results.md.
 *
 * Usage: pnpm --filter @gethelio/proxy benchmark
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp } from '../src/server.js'
import { UpstreamForwarder } from '../src/upstream/forwarder.js'
import { startHttpMcpServer } from '../src/__tests__/helpers/mcp-test-server.js'
import { startOnDynamicPort, makeConfig } from '../src/__tests__/helpers/test-utils.js'
import { compilePolicies } from '../src/policy/index.js'
import { GovernedForwarder } from '../src/policy/governed-forwarder.js'
import { AuditStore, AuditWriter } from '../src/audit/index.js'
import {
  P99_TARGET_MS,
  collectAuditLatencies,
  computeStats,
  evaluateGate,
  fmt,
  fmtInt,
  formatGateSummary,
  generateMarkdownReport,
  type BenchmarkResults,
  type LatencyStats,
  type MemorySnapshot,
} from './benchmark-report.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WARMUP_COUNT = 50
const MEASURE_COUNT_TRANSPARENT = 1_000
const MEASURE_COUNT_GOVERNED = 10_000

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function measureMemory(label: string): MemorySnapshot {
  if (typeof globalThis.gc === 'function') {
    globalThis.gc()
  }
  const mem = process.memoryUsage()
  return {
    label,
    heapUsedMB: mem.heapUsed / 1024 / 1024,
    rssMB: mem.rss / 1024 / 1024,
  }
}

async function sendRequest(url: string, method = 'tools/call'): Promise<number> {
  const payload: Record<string, unknown> = {
    jsonrpc: '2.0',
    id: 1,
    method,
  }
  if (method === 'tools/call') {
    payload['params'] = { name: 'get_weather', arguments: { city: 'London' } }
  }

  const start = performance.now()
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  await res.json()
  return performance.now() - start
}

// ---------------------------------------------------------------------------
// Console reporting
// ---------------------------------------------------------------------------

function printStats(label: string, stats: LatencyStats, throughput?: number): void {
  console.log(`\n${label} — ${String(stats.count)} sequential requests`)
  console.log('─'.repeat(58))
  console.log(`  p50:  ${stats.p50.toFixed(2)}ms`)
  console.log(`  p95:  ${stats.p95.toFixed(2)}ms`)
  console.log(`  p99:  ${stats.p99.toFixed(2)}ms`)
  console.log(`  max:  ${stats.max.toFixed(2)}ms`)
  console.log(`  avg:  ${stats.avg.toFixed(2)}ms`)
  if (throughput !== undefined) {
    console.log(`  throughput: ${throughput.toFixed(0)} req/s`)
  }
  console.log('─'.repeat(58))
}

function printMemory(snapshots: MemorySnapshot[]): void {
  console.log('\nMemory Usage')
  console.log('─'.repeat(58))
  for (const s of snapshots) {
    console.log(`  ${s.label}: heap=${s.heapUsedMB.toFixed(1)}MB rss=${s.rssMB.toFixed(1)}MB`)
  }
  if (snapshots.length >= 4) {
    const afterWarmup = snapshots[1]!
    const after10K = snapshots[2]!
    const delta = after10K.heapUsedMB - afterWarmup.heapUsedMB
    console.log(`  Delta (warmup → 10K): ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}MB heap`)
  }
  console.log('─'.repeat(58))
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('Helio Proxy Performance Benchmark')
  console.log(`  Transparent: ${fmtInt(MEASURE_COUNT_TRANSPARENT)} requests`)
  console.log(`  Governed:    ${fmtInt(MEASURE_COUNT_GOVERNED)} requests`)
  console.log(`  Warmup:      ${String(WARMUP_COUNT)} requests each`)
  console.log(`  Gate:        Governed (overhead) p99 < ${String(P99_TARGET_MS)}ms`)

  // Start upstream MCP server
  const upstream = await startHttpMcpServer()
  const upstreamUrl = `http://127.0.0.1:${String(upstream.port)}/mcp`

  // -----------------------------------------------------------------------
  // Benchmark 1: Transparent proxy (no policy, no audit)
  // -----------------------------------------------------------------------

  const config1 = makeConfig({
    upstream: { url: upstreamUrl, transport: 'streamable-http' },
  })
  const forwarder1 = new UpstreamForwarder({ url: config1.upstream.url as string })
  const app1 = createApp(config1, forwarder1)
  const proxy1 = startOnDynamicPort(app1)
  const proxyUrl1 = `http://127.0.0.1:${String(proxy1.port)}/mcp`

  for (let i = 0; i < WARMUP_COUNT; i++) {
    await sendRequest(proxyUrl1)
  }

  const transparentStart = performance.now()
  const transparentDurations: number[] = []
  for (let i = 0; i < MEASURE_COUNT_TRANSPARENT; i++) {
    transparentDurations.push(await sendRequest(proxyUrl1))
  }
  const transparentEnd = performance.now()
  await proxy1.close()

  const transparentThroughput =
    MEASURE_COUNT_TRANSPARENT / ((transparentEnd - transparentStart) / 1000)

  // -----------------------------------------------------------------------
  // Benchmark 2: Governed proxy (policy + audit) — 10K requests
  // -----------------------------------------------------------------------

  const config2 = makeConfig({
    upstream: { url: upstreamUrl, transport: 'streamable-http' },
    policies: {
      default: 'deny',
      rules: [
        { match: { tool: 'get_weather' }, action: 'allow' },
        { match: { tool: 'send_*' }, action: 'allow' },
        { match: { tool: '*' }, action: 'deny' },
      ],
    },
  })
  const forwarder2 = new UpstreamForwarder({ url: config2.upstream.url as string })
  const { policy } = compilePolicies(config2.policies)
  const auditStore = new AuditStore({
    path: ':memory:',
    retention: '90d',
    includeResponses: true,
    cleanupIntervalMs: 0,
  })
  const auditWriter = new AuditWriter({ store: auditStore, bufferSize: 2000 })
  const governed = new GovernedForwarder(forwarder2, policy, { auditWriter })
  const app2 = createApp(config2, governed)
  const proxy2 = startOnDynamicPort(app2)
  const proxyUrl2 = `http://127.0.0.1:${String(proxy2.port)}/mcp`

  // Prime annotation cache (intentionally before memory snapshots so the
  // cache allocation is included in all snapshots rather than skewing warmup)
  await sendRequest(proxyUrl2, 'tools/list')

  // Memory: before warmup (includes annotation cache from tools/list above)
  const memSnapshots: MemorySnapshot[] = []
  memSnapshots.push(measureMemory('Before warmup'))

  // Warmup
  for (let i = 0; i < WARMUP_COUNT; i++) {
    await sendRequest(proxyUrl2)
  }

  // Flush warmup audit records and record the offset
  auditWriter.flush()
  const warmupOffset = auditStore.count()

  // Memory: after warmup
  memSnapshots.push(measureMemory('After warmup'))

  // Measurement loop — 10K requests
  const governedStart = performance.now()
  const governedDurations: number[] = []
  for (let i = 0; i < MEASURE_COUNT_GOVERNED; i++) {
    governedDurations.push(await sendRequest(proxyUrl2))
  }
  const governedEnd = performance.now()

  // Memory: after 10K requests
  memSnapshots.push(measureMemory('After 10K requests'))

  // Flush remaining audit buffer
  auditWriter.flush()

  // Memory: after flush
  memSnapshots.push(measureMemory('After flush'))

  // SQLite metrics
  const totalAuditRecords = auditStore.count()
  const sqliteCount = totalAuditRecords - warmupOffset
  const sqliteDurationMs = governedEnd - governedStart
  const sqliteThroughput = sqliteCount / (sqliteDurationMs / 1000)

  // Extract latency decomposition from audit records
  const { proxyLatencies, upstreamLatencies, overheadLatencies } = collectAuditLatencies(
    auditStore,
    sqliteCount,
    warmupOffset,
  )

  // Clean up
  auditWriter.close()
  await proxy2.close()
  await upstream.close()

  // -----------------------------------------------------------------------
  // Compute results
  // -----------------------------------------------------------------------

  const governedThroughput = MEASURE_COUNT_GOVERNED / ((governedEnd - governedStart) / 1000)

  const results: BenchmarkResults = {
    transparent: {
      stats: computeStats(transparentDurations),
      throughput: transparentThroughput,
    },
    governed: {
      external: {
        stats: computeStats(governedDurations),
        throughput: governedThroughput,
      },
      proxyInternal: computeStats(proxyLatencies),
      upstreamInternal: computeStats(upstreamLatencies),
      overhead: computeStats(overheadLatencies),
    },
    memory: memSnapshots,
    sqlite: {
      records: sqliteCount,
      durationMs: sqliteDurationMs,
      throughput: sqliteThroughput,
    },
    gcExposed: typeof globalThis.gc === 'function',
  }

  // -----------------------------------------------------------------------
  // Console report
  // -----------------------------------------------------------------------

  printStats('Transparent Proxy', results.transparent.stats, results.transparent.throughput)
  printStats(
    'Governed Proxy (external)',
    results.governed.external.stats,
    results.governed.external.throughput,
  )

  console.log('\nLatency Overhead Decomposition (from audit records)')
  console.log('─'.repeat(58))
  const oh = results.governed.overhead
  const pi = results.governed.proxyInternal
  const ui = results.governed.upstreamInternal
  console.log(
    `  p50:  proxy=${pi.p50.toFixed(2)}ms  upstream=${ui.p50.toFixed(2)}ms  overhead=${oh.p50.toFixed(2)}ms`,
  )
  console.log(
    `  p95:  proxy=${pi.p95.toFixed(2)}ms  upstream=${ui.p95.toFixed(2)}ms  overhead=${oh.p95.toFixed(2)}ms`,
  )
  console.log(
    `  p99:  proxy=${pi.p99.toFixed(2)}ms  upstream=${ui.p99.toFixed(2)}ms  overhead=${oh.p99.toFixed(2)}ms`,
  )
  console.log('─'.repeat(58))

  printMemory(results.memory)

  console.log('\nSQLite Audit Write Throughput')
  console.log('─'.repeat(58))
  console.log(`  Records: ${fmtInt(results.sqlite.records)}`)
  console.log(`  Duration: ${fmt(results.sqlite.durationMs / 1000)}s`)
  console.log(`  Throughput: ${fmtInt(Math.round(results.sqlite.throughput))} records/s`)
  console.log('─'.repeat(58))

  // -----------------------------------------------------------------------
  // Markdown report
  // -----------------------------------------------------------------------

  const __dirname = dirname(fileURLToPath(import.meta.url))
  const docsDir = join(__dirname, '..', '..', '..', 'docs')
  mkdirSync(docsDir, { recursive: true })
  const reportPath = join(docsDir, 'benchmark-results.md')
  const markdown = generateMarkdownReport(results)
  writeFileSync(reportPath, markdown, 'utf-8')
  console.log(`\nMarkdown report written to: ${reportPath}`)

  // -----------------------------------------------------------------------
  // Pass/fail
  // -----------------------------------------------------------------------

  console.log('\n' + '='.repeat(58))
  const gate = evaluateGate(results, P99_TARGET_MS)
  console.log(formatGateSummary(gate))
  console.log('='.repeat(58))
  process.exit(gate.pass ? 0 : 1)
}

void main()
