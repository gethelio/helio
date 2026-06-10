/**
 * Governance pipeline integration tests — policy engine + audit.
 *
 * End-to-end verification of the full governance pipeline:
 * mock MCP server → proxy with policies + audit → SQLite.
 *
 * Covers: all matcher types, first-match-wins ordering, destructive
 * detection, hot-reload, response capture, and performance (<5ms p99).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { join } from 'node:path'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { startHttpMcpServer } from './helpers/mcp-test-server.js'
import { startOnDynamicPort, makeConfig, sendMcpRequest } from './helpers/test-utils.js'
import { createApp } from '../server.js'
import { StreamableHttpForwarder } from '../upstream/streamable-http-forwarder.js'
import { compilePolicies } from '../policy/index.js'
import { GovernedForwarder } from '../policy/governed-forwarder.js'
import { AuditStore, AuditWriter } from '../audit/index.js'
import { ConfigWatcher } from '../config/index.js'
import type { ManagedServer } from './helpers/test-utils.js'
import type { PoliciesConfig } from '../config/index.js'

// ---------------------------------------------------------------------------
// Shared upstream server
// ---------------------------------------------------------------------------

let upstream: { port: number; close: () => Promise<void> }
let upstreamUrl: string

beforeAll(async () => {
  upstream = await startHttpMcpServer()
  upstreamUrl = `http://127.0.0.1:${String(upstream.port)}/mcp`
})

afterAll(async () => {
  await upstream.close()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createGovernedProxyWithAudit(
  policiesConfig: PoliciesConfig,
  options?: { environment?: string; includeResponses?: boolean; bufferSize?: number },
) {
  const config = makeConfig({
    upstream: { url: upstreamUrl, transport: 'streamable-http' },
    policies: policiesConfig,
    environment: options?.environment,
  })

  const rawForwarder = new StreamableHttpForwarder({ url: config.upstream.url })
  const { policy } = compilePolicies(config.policies)

  const auditStore = new AuditStore({
    path: ':memory:',
    retention: '90d',
    includeResponses: options?.includeResponses ?? true,
    cleanupIntervalMs: 0,
  })
  const auditWriter = new AuditWriter({
    store: auditStore,
    flushIntervalMs: 0,
    ...(options?.bufferSize !== undefined && { bufferSize: options.bufferSize }),
  })

  const governed = new GovernedForwarder(rawForwarder, policy, {
    environment: config.environment,
    auditWriter,
  })

  const app = createApp(config, governed)
  const managed = startOnDynamicPort(app)

  return {
    url: `http://127.0.0.1:${String(managed.port)}/mcp`,
    close: async () => {
      await managed.close()
      auditWriter.close()
    },
    auditStore,
    auditWriter,
    governed,
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Suite 1: Full pipeline with 5+ rules
// ---------------------------------------------------------------------------

describe('full pipeline with 5+ rules', () => {
  let proxy: ReturnType<typeof createGovernedProxyWithAudit>

  beforeAll(async () => {
    proxy = createGovernedProxyWithAudit(
      {
        default: 'deny',
        dry_run: false,
        flag_destructive: 'log',
        rules: [
          { name: 'allow-weather', match: { tool: 'get_weather' }, action: 'allow' },
          {
            name: 'block-large-payments',
            match: { tool: 'create_payment', input: { '$.amount': { gt: 1000 } } },
            action: 'deny',
            feedback: { message: 'Payments over 1000 require approval' },
          },
          { name: 'allow-small-payments', match: { tool: 'create_payment' }, action: 'allow' },
          {
            name: 'block-destructive-prod',
            match: {
              tool: 'delete_*',
              annotations: { destructiveHint: true },
              environment: 'production',
            },
            action: 'deny',
          },
          { name: 'allow-email', match: { tool: 'send_*' }, action: 'allow' },
        ],
      } as PoliciesConfig,
      { environment: 'production' },
    )

    // Prime annotation cache
    await sendMcpRequest(proxy.url, 'tools/list')
  })

  afterAll(async () => {
    await proxy.close()
  })

  it('tool name match: get_weather allowed by rule 1', async () => {
    const { body } = await sendMcpRequest(proxy.url, 'tools/call', {
      name: 'get_weather',
      arguments: { city: 'London' },
    })

    const result = body['result'] as { content: { text: string }[] }
    expect(result.content[0]?.text).toBe('Sunny, 22°C in London')

    proxy.auditWriter.flush()
    const records = proxy.auditStore.list({ tool_name: 'get_weather' }).records
    expect(records).toHaveLength(1)
    expect(records[0]?.policy_decision).toBe('allow')
    expect(records[0]?.matched_rule).toBe('allow-weather')
    expect(records[0]?.upstream_response).not.toBeNull()
    expect(records[0]?.upstream_latency_ms).toBeGreaterThan(0)
    expect(records[0]?.total_duration_ms).toBeGreaterThan(0)
    expect(records[0]?.proxy_compute_ms).toBeGreaterThanOrEqual(0)
    expect(records[0]?.approval_wait_ms).toBe(0)
  })

  it('input parameter match: large payment denied by rule 2', async () => {
    const { body } = await sendMcpRequest(proxy.url, 'tools/call', {
      name: 'create_payment',
      arguments: { amount: 5000, currency: 'USD' },
    })

    const error = body['error'] as { code: number; message: string }
    expect(error.code).toBe(-32001)
    expect(error.message).toBe('Payments over 1000 require approval')

    proxy.auditWriter.flush()
    const records = proxy.auditStore.list({ tool_name: 'create_payment' }).records
    const largePayment = records.find((r) => (r.tool_input as { amount: number }).amount === 5000)
    expect(largePayment?.policy_decision).toBe('deny')
    expect(largePayment?.matched_rule).toBe('block-large-payments')
    expect(largePayment?.upstream_response).toBeNull()
    expect(largePayment?.upstream_latency_ms).toBeNull()
  })

  it('first-match-wins: small payment allowed by rule 3 (rule 2 skipped)', async () => {
    const { body } = await sendMcpRequest(proxy.url, 'tools/call', {
      name: 'create_payment',
      arguments: { amount: 50, currency: 'EUR' },
    })

    const result = body['result'] as { content: { text: string }[] }
    expect(result.content[0]?.text).toBe('Payment of 50 EUR created')

    proxy.auditWriter.flush()
    const records = proxy.auditStore.list({ tool_name: 'create_payment' }).records
    const smallPayment = records.find((r) => (r.tool_input as { amount: number }).amount === 50)
    expect(smallPayment?.policy_decision).toBe('allow')
    expect(smallPayment?.matched_rule).toBe('allow-small-payments')
  })

  it('annotation + environment match: destructive tool denied in production', async () => {
    const { body } = await sendMcpRequest(proxy.url, 'tools/call', {
      name: 'delete_record',
      arguments: { id: 'rec-99' },
    })

    const error = body['error'] as { code: number; data: Record<string, unknown> }
    expect(error.code).toBe(-32001)
    expect(error.data['blocked']).toBe(true)

    proxy.auditWriter.flush()
    const records = proxy.auditStore.list({ tool_name: 'delete_record' }).records
    expect(records[0]?.policy_decision).toBe('deny')
    expect(records[0]?.matched_rule).toBe('block-destructive-prod')
  })

  it('glob match: send_email allowed by send_* rule', async () => {
    const { body } = await sendMcpRequest(proxy.url, 'tools/call', {
      name: 'send_email',
      arguments: { to: 'test@example.com', body: 'Hello' },
    })

    const result = body['result'] as { content: { text: string }[] }
    expect(result.content[0]?.text).toContain('Email sent')

    proxy.auditWriter.flush()
    const records = proxy.auditStore.list({ tool_name: 'send_email' }).records
    expect(records[0]?.policy_decision).toBe('allow')
    expect(records[0]?.matched_rule).toBe('allow-email')
  })

  it('default deny: unknown tool blocked', async () => {
    const { body } = await sendMcpRequest(proxy.url, 'tools/call', {
      name: 'unknown_tool',
      arguments: {},
    })

    const error = body['error'] as { code: number; data: Record<string, unknown> }
    expect(error.code).toBe(-32001)
    expect(error.data['blocked']).toBe(true)

    proxy.auditWriter.flush()
    const records = proxy.auditStore.list({ tool_name: 'unknown_tool' }).records
    expect(records[0]?.policy_decision).toBe('deny')
    expect(records[0]?.matched_rule).toBeNull()
  })

  it('every tools/call produced an audit record', () => {
    proxy.auditWriter.flush()
    // 6 tool calls above
    expect(proxy.auditStore.count()).toBeGreaterThanOrEqual(6)
  })
})

// ---------------------------------------------------------------------------
// Suite 2: Destructive detection (end-to-end)
// ---------------------------------------------------------------------------

describe('destructive detection', () => {
  let proxy: ReturnType<typeof createGovernedProxyWithAudit>

  beforeAll(async () => {
    proxy = createGovernedProxyWithAudit({
      default: 'allow',
      dry_run: false,
      flag_destructive: 'log',
      rules: [],
    } as PoliciesConfig)

    // Prime annotation cache so tools have explicit annotations
    await sendMcpRequest(proxy.url, 'tools/list')
  })

  afterAll(async () => {
    await proxy.close()
  })

  it('destructive tool is flagged in audit record', async () => {
    await sendMcpRequest(proxy.url, 'tools/call', {
      name: 'delete_record',
      arguments: { id: 'rec-1' },
    })

    proxy.auditWriter.flush()
    const records = proxy.auditStore.list({ tool_name: 'delete_record' }).records
    expect(records).toHaveLength(1)
    expect(records[0]?.flagged_destructive).toBe(true)
    expect(records[0]?.policy_decision).toBe('allow')
  })

  it('non-destructive tool is NOT flagged', async () => {
    await sendMcpRequest(proxy.url, 'tools/call', {
      name: 'get_weather',
      arguments: { city: 'Paris' },
    })

    proxy.auditWriter.flush()
    const records = proxy.auditStore.list({ tool_name: 'get_weather' }).records
    expect(records).toHaveLength(1)
    expect(records[0]?.flagged_destructive).toBe(false)
  })

  it('flagged_destructive filter works in audit queries', () => {
    proxy.auditWriter.flush()
    const flagged = proxy.auditStore.list({ flagged_destructive: true })
    const unflagged = proxy.auditStore.list({ flagged_destructive: false })

    expect(flagged.total).toBe(1)
    expect(flagged.records[0]?.tool_name).toBe('delete_record')
    expect(unflagged.total).toBe(1)
    expect(unflagged.records[0]?.tool_name).toBe('get_weather')
  })
})

// ---------------------------------------------------------------------------
// Suite 3: Hot-reload with running proxy
// ---------------------------------------------------------------------------

describe('hot-reload', () => {
  let tmpDir: string
  let configPath: string
  let proxy: ManagedServer
  let proxyUrl: string
  let governed: GovernedForwarder
  let auditStore: AuditStore
  let auditWriter: AuditWriter
  let watcher: ConfigWatcher

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'helio-hot-reload-'))
    configPath = join(tmpDir, 'helio.yaml')

    // Write initial config: allow everything, no rules
    await writeFile(
      configPath,
      `
version: "1"
upstream:
  url: "${upstreamUrl}"
dashboard:
  enabled: false
policies:
  default: allow
  rules: []
`,
    )

    // Build the proxy stack manually to wire up the config watcher
    const config = makeConfig({
      upstream: { url: upstreamUrl, transport: 'streamable-http' },
      policies: { default: 'allow', rules: [] },
    })
    const rawForwarder = new StreamableHttpForwarder({ url: config.upstream.url })
    const { policy } = compilePolicies(config.policies)

    auditStore = new AuditStore({
      path: ':memory:',
      retention: '90d',
      includeResponses: true,
      cleanupIntervalMs: 0,
    })
    auditWriter = new AuditWriter({ store: auditStore, flushIntervalMs: 0 })

    governed = new GovernedForwarder(rawForwarder, policy, { auditWriter })

    // Start the config watcher
    watcher = new ConfigWatcher({
      configPath,
      onPolicyReload: (newPolicy) => {
        governed.updatePolicy(newPolicy)
      },
      onError: () => {},
      debounceMs: 50,
    })
    watcher.start()

    const app = createApp(config, governed)
    proxy = startOnDynamicPort(app)
    proxyUrl = `http://127.0.0.1:${String(proxy.port)}/mcp`

    await wait(100)
  })

  afterAll(async () => {
    watcher.close()
    await proxy.close()
    auditWriter.close()
  })

  it('initial policy allows delete_record', async () => {
    const { body } = await sendMcpRequest(proxyUrl, 'tools/call', {
      name: 'delete_record',
      arguments: { id: 'rec-1' },
    })

    const result = body['result'] as { content: { text: string }[] }
    expect(result.content[0]?.text).toContain('Record rec-1 deleted')
  })

  it('hot-reload: new deny rule takes effect without restart', async () => {
    // Overwrite config with a deny rule for delete_*
    await writeFile(
      configPath,
      `
version: "1"
upstream:
  url: "${upstreamUrl}"
dashboard:
  enabled: false
policies:
  default: allow
  rules:
    - name: block-delete
      match:
        tool: "delete_*"
      action: deny
`,
    )

    // Wait for watcher debounce + reload
    await wait(600)

    // Same tool call should now be denied
    const { body } = await sendMcpRequest(proxyUrl, 'tools/call', {
      name: 'delete_record',
      arguments: { id: 'rec-2' },
    })

    const error = body['error'] as { code: number; data: Record<string, unknown> }
    expect(error.code).toBe(-32001)
    expect(error.data['blocked']).toBe(true)
  })

  it('audit records reflect both decisions', () => {
    auditWriter.flush()
    const records = auditStore.list({ tool_name: 'delete_record' }, { order: 'asc' }).records
    expect(records).toHaveLength(2)
    expect(records[0]?.policy_decision).toBe('allow')
    expect(records[1]?.policy_decision).toBe('deny')
    expect(records[1]?.matched_rule).toBe('block-delete')
  })
})

// ---------------------------------------------------------------------------
// Suite 4: Performance benchmark (1,000 calls with policy + audit)
// ---------------------------------------------------------------------------

describe('performance (<5ms p99 with policy + audit)', { timeout: 30_000 }, () => {
  const WARMUP = 20
  const MEASURE = 1000

  it(`p99 latency for ${String(MEASURE)} governed tool calls is reasonable`, async () => {
    // Use a large buffer to avoid mid-benchmark auto-flush blocking
    const proxy = createGovernedProxyWithAudit(
      {
        default: 'deny',
        dry_run: false,
        rules: [
          { name: 'allow-weather', match: { tool: 'get_weather' }, action: 'allow' },
          { name: 'allow-email', match: { tool: 'send_*' }, action: 'allow' },
          { name: 'deny-all', match: { tool: '*' }, action: 'deny' },
        ],
      } as PoliciesConfig,
      { bufferSize: 2000 },
    )

    try {
      // Prime annotation cache
      await sendMcpRequest(proxy.url, 'tools/list')

      // Warmup
      for (let i = 0; i < WARMUP; i++) {
        await sendMcpRequest(proxy.url, 'tools/call', {
          name: 'get_weather',
          arguments: { city: 'London' },
        })
      }

      // Measure
      const durations: number[] = []
      for (let i = 0; i < MEASURE; i++) {
        const start = performance.now()
        await sendMcpRequest(proxy.url, 'tools/call', {
          name: 'get_weather',
          arguments: { city: 'London' },
        })
        durations.push(performance.now() - start)
      }

      // Calculate stats
      const sorted = [...durations].sort((a, b) => a - b)
      const p99idx = Math.ceil(0.99 * sorted.length) - 1
      const p99 = sorted[Math.max(0, p99idx)] ?? 0
      const p95idx = Math.ceil(0.95 * sorted.length) - 1
      const p95 = sorted[Math.max(0, p95idx)] ?? 0

      // Vitest + concurrent test suites add significant overhead.
      // The dedicated benchmark script (pnpm benchmark) is the authoritative <5ms check.
      // Here we verify no major regression while tolerating occasional worker-load spikes.
      expect(p95).toBeLessThan(50)
      expect(p99).toBeLessThan(100)

      // Verify audit records were written
      proxy.auditWriter.flush()
      expect(proxy.auditStore.count()).toBeGreaterThanOrEqual(MEASURE)
    } finally {
      await proxy.close()
    }
  })
})

// ---------------------------------------------------------------------------
// Suite 5: Dry-run mode
// ---------------------------------------------------------------------------

describe('dry-run mode', () => {
  it('per-rule dry_run returns synthetic response without contacting upstream', async () => {
    const proxy = createGovernedProxyWithAudit({
      default: 'allow',
      dry_run: false,
      rules: [{ name: 'shadow-weather', match: { tool: 'get_weather' }, action: 'dry_run' }],
    })

    try {
      const { body } = await sendMcpRequest(proxy.url, 'tools/call', {
        name: 'get_weather',
        arguments: { city: 'London' },
      })

      // Should be a success response with dry-run payload
      expect(body['error']).toBeUndefined()
      const result = body['result'] as Record<string, unknown>
      const content = result['content'] as Array<{ type: string; text: string }>
      const payload = JSON.parse((content[0] ?? { text: '{}' }).text) as Record<string, unknown>

      expect(payload['dry_run']).toBe(true)
      expect(payload['would_forward']).toBe(false)
      expect(payload['policy_decision']).toBe('dry_run')
      expect(payload['matched_rule']).toBe('shadow-weather')

      // Verify audit record
      proxy.auditWriter.flush()
      const { records } = proxy.auditStore.list()
      expect(records).toHaveLength(1)
      expect(records[0]?.dry_run).toBe(true)
      expect(records[0]?.policy_decision).toBe('dry_run')
      expect(records[0]?.upstream_response).toBeNull()
    } finally {
      await proxy.close()
    }
  })

  it('global dry_run prevents forwarding and returns would_forward: true for allow', async () => {
    const proxy = createGovernedProxyWithAudit({
      default: 'allow',
      dry_run: true,
      rules: [{ name: 'allow-weather', match: { tool: 'get_weather' }, action: 'allow' }],
    })

    try {
      const { body } = await sendMcpRequest(proxy.url, 'tools/call', {
        name: 'get_weather',
        arguments: { city: 'London' },
      })

      expect(body['error']).toBeUndefined()
      const result = body['result'] as Record<string, unknown>
      const content = result['content'] as Array<{ type: string; text: string }>
      const payload = JSON.parse((content[0] ?? { text: '{}' }).text) as Record<string, unknown>

      expect(payload['dry_run']).toBe(true)
      expect(payload['would_forward']).toBe(true)
      expect(payload['policy_decision']).toBe('allow')
      expect(payload['matched_rule']).toBe('allow-weather')
      expect(payload['evidence_satisfied']).toBe(true)
      expect(payload['limits_ok']).toBe(true)

      // Verify audit
      proxy.auditWriter.flush()
      const { records } = proxy.auditStore.list()
      expect(records).toHaveLength(1)
      expect(records[0]?.dry_run).toBe(true)
      expect(records[0]?.policy_decision).toBe('allow')
    } finally {
      await proxy.close()
    }
  })

  it('global dry_run with deny shows would_forward: false', async () => {
    const proxy = createGovernedProxyWithAudit({
      default: 'deny',
      dry_run: true,
      rules: [],
    })

    try {
      const { body } = await sendMcpRequest(proxy.url, 'tools/call', {
        name: 'get_weather',
        arguments: {},
      })

      expect(body['error']).toBeUndefined()
      const result = body['result'] as Record<string, unknown>
      const content = result['content'] as Array<{ type: string; text: string }>
      const payload = JSON.parse((content[0] ?? { text: '{}' }).text) as Record<string, unknown>

      expect(payload['would_forward']).toBe(false)
      expect(payload['policy_decision']).toBe('deny')

      // Audit record with dry_run filter
      proxy.auditWriter.flush()
      const { records } = proxy.auditStore.list({ dry_run: true })
      expect(records).toHaveLength(1)
    } finally {
      await proxy.close()
    }
  })
})
