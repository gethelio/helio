import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createApp } from '../server.js'
import { createForwarderFromConfig } from '../cli-forwarder.js'
import { GovernedForwarder } from '../policy/governed-forwarder.js'
import { compilePolicies } from '../policy/parser.js'
import { AuditStore, AuditWriter } from '../audit/index.js'
import { startModernOnlyHttpMcpServer } from './helpers/mcp-test-server.js'
import { startOnDynamicPort, makeConfig, sendMcpRequest } from './helpers/test-utils.js'
import type { ModernOnlyMcpServer } from './helpers/mcp-test-server.js'
import type { ManagedServer } from './helpers/test-utils.js'
import type { PoliciesConfig } from '../config/index.js'

// The #216 repro policy: a deny rule keyed on `destructiveHint` and an allow
// rule keyed on `readOnlyHint`. Against an unprimed cache these evaluate
// against MCP spec defaults (destructiveHint: true), so `block-destructive`
// would wrongly catch every tool; a successful prime against the modern-only
// upstream must evaluate the tool's REAL annotations instead.
const policiesConfig: PoliciesConfig = {
  default: 'allow',
  dry_run: false,
  flag_destructive: 'log',
  on_tool_drift: 'block',
  rules: [
    {
      name: 'block-destructive',
      match: { annotations: { destructiveHint: true } },
      action: 'deny',
    },
    { name: 'allow-reads', match: { annotations: { readOnlyHint: true } }, action: 'allow' },
  ],
}

describe('2026-07-28-only ("modern-only") upstream', () => {
  let upstream: ModernOnlyMcpServer | undefined
  let proxy: ManagedServer | undefined
  let proxyUrl: string
  let governedForwarder: GovernedForwarder
  let closeForwarder: (() => Promise<void>) | undefined
  let auditStore: AuditStore
  let auditWriter: AuditWriter

  beforeAll(async () => {
    upstream = await startModernOnlyHttpMcpServer()
    const config = makeConfig({
      upstream: {
        url: `http://127.0.0.1:${String(upstream.port)}/mcp`,
        transport: 'streamable-http',
        request_timeout: '30s',
      },
      policies: policiesConfig,
    })
    const built = await createForwarderFromConfig(config)
    closeForwarder = built.close

    auditStore = new AuditStore({
      path: ':memory:',
      retention: '90d',
      includeResponses: true,
      cleanupIntervalMs: 0,
    })
    auditWriter = new AuditWriter({ store: auditStore, flushIntervalMs: 0 })

    governedForwarder = new GovernedForwarder(
      built.forwarder,
      compilePolicies(config.policies).policy,
      {
        auditWriter,
      },
    )
    proxy = startOnDynamicPort(createApp(config, governedForwarder))
    proxyUrl = `http://127.0.0.1:${String(proxy.port)}/mcp`
  })

  afterAll(async () => {
    if (proxy) await proxy.close()
    await closeForwarder?.()
    if (upstream) await upstream.close()
    auditWriter.close()
  })

  it('primes against a 2026-07-28-only upstream and evaluates annotations from real definitions', async () => {
    // `mcp-method` presence+agreement is unconditional on every POST the
    // fixture sees, so it proves nothing distinctly "internal" by itself.
    // What IS internal-path-specific here: the era probe (server/discover)
    // pins the full `mcp-method`/`mcp-protocol-version`/`_meta` triple
    // unconditionally, and this prime's tools/list reaches that same
    // version/`_meta` check only because the internal path currently sends
    // `mcp-protocol-version: 2026-07-28` — if it stopped stamping the
    // version header and `_meta` mirror, the fixture would serve it from
    // the lenient version/`_meta` leg instead and this test would still
    // pass. The `_meta` mirror itself is pinned directly at unit level in
    // `streamable-http-forwarder.test.ts`.
    const result = await governedForwarder.primeAnnotationCache()
    expect(result.success).toBe(true)
    expect(result.toolsCached).toBeGreaterThan(0)

    // Relays now stamp `mcp-method`/`mcp-name` on every outbound POST (issue
    // #217), and the fixture requires them, with header<->body agreement, on
    // every POST it receives — internal or relayed alike. Only the
    // `mcp-protocol-version`/`_meta` half of the fixture's strict check stays
    // lenient for legacy-versioned relays, until relay version negotiation
    // (#219) lands.
    const { body } = await sendMcpRequest(proxyUrl, 'tools/call', {
      name: 'get_status',
      arguments: {},
    })
    expect(body['error']).toBeUndefined()
    const toolResult = body['result'] as { content: { type: string; text: string }[] }
    expect(toolResult.content[0]?.text).toContain('get_status')

    // The relayed POST itself carried the standard headers, agreeing with the
    // body the fixture just executed.
    const relayedCall = upstream?.receivedRequests
      .filter((req) => req.method === 'tools/call')
      .at(-1)
    expect(relayedCall?.headers['mcp-method']).toBe('tools/call')
    expect(relayedCall?.headers['mcp-name']).toBe('get_status')

    // Real definitions (readOnlyHint: true, destructiveHint: false) route the
    // call through allow-reads, never through block-destructive's fallback-
    // default over-match.
    auditWriter.flush()
    const records = auditStore.list({ tool_name: 'get_status' }).records
    expect(records[0]?.policy_decision).toBe('allow')
    expect(records[0]?.matched_rule).toBe('allow-reads')
  })

  it('clamps the advertised ttlMs on tools/list through the proxy', async () => {
    const { status, body } = await sendMcpRequest(proxyUrl, 'tools/list')
    expect(status).toBe(200)
    const result = body['result'] as { ttlMs: number; cacheScope: string }
    // The upstream advertises 3_600_000ms; policies.tool_revalidation's
    // default max_advertised_ttl (5m == 300_000ms) clamps it downward.
    expect(result.ttlMs).toBe(300_000)
    expect(result.cacheScope).toBe('public')
  })

  it('relays a tools/call for a non-ASCII tool name with the sentinel-encoded mcp-name header', async () => {
    // This must run before the drift test below: its `setTools` replaces the
    // whole advertised tool set, removing this non-ASCII tool.
    const { body } = await sendMcpRequest(proxyUrl, 'tools/call', {
      name: 'Hello, 世界',
      arguments: {},
    })
    expect(body['error']).toBeUndefined()
    const toolResult = body['result'] as { content: { type: string; text: string }[] }
    expect(toolResult.content[0]?.text).toContain('Hello, 世界')

    // Pins that the sentinel encoding actually happened on the wire, and that
    // the fixture's independent decode-agreement check (`mcp-name` decoded
    // back to the body's own `params.name`) passed rather than being skipped.
    const relayedCall = upstream?.receivedRequests
      .filter((req) => req.method === 'tools/call')
      .at(-1)
    expect(relayedCall?.headers['mcp-name']).toBe('=?base64?SGVsbG8sIOS4lueVjA==?=')
  })

  it("rejects a raw POST to the fixture when mcp-method is missing or mismatched (issue #217's regression net)", async () => {
    // Bypasses the proxy entirely — this pins the fixture's own presence
    // requirement, the net that catches a future total stamping drop.
    const upstreamUrl = `http://127.0.0.1:${String(upstream?.port)}/mcp`

    const missingHeader = await fetch(upstreamUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    expect(missingHeader.status).toBe(400)
    const missingHeaderBody = (await missingHeader.json()) as { error: { code: number } }
    expect(missingHeaderBody.error.code).toBe(-32020)

    const mismatchedHeader = await fetch(upstreamUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'mcp-method': 'tools/call' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    })
    expect(mismatchedHeader.status).toBe(400)
    const mismatchedHeaderBody = (await mismatchedHeader.json()) as { error: { code: number } }
    expect(mismatchedHeaderBody.error.code).toBe(-32020)
  })

  it('detects drift on revalidation with no client traffic', async () => {
    const primed = await governedForwarder.primeAnnotationCache()
    expect(primed.success).toBe(true)

    // Mutate the upstream's tool definition out from under the baseline —
    // standing in for an upstream deploy between revalidation ticks.
    upstream?.setTools([
      {
        name: 'get_status',
        description: 'Report the current server status (v2)',
        annotations: { readOnlyHint: true, destructiveHint: false },
      },
    ])

    // Stand-in for the scheduled revalidation tick (issue #221): re-prime
    // with no intervening client traffic.
    const reprimed = await governedForwarder.primeAnnotationCache()
    expect(reprimed.success).toBe(true)

    const { body } = await sendMcpRequest(proxyUrl, 'tools/call', {
      name: 'get_status',
      arguments: {},
    })
    const error = body['error'] as { code: number; data: Record<string, unknown> }
    expect(error).toBeDefined()
    expect(error.data['blocked']).toBe(true)
    expect(error.data['reason']).toBe('tool_definition_drift')
    expect(error.data['drifted_aspects']).toContain('description')

    auditWriter.flush()
    const records = auditStore.list({ tool_name: 'get_status' }, { order: 'asc' }).records
    expect(records[records.length - 1]?.policy_decision).toBe('deny')
    expect(records[records.length - 1]?.block_reason).toBe('tool_definition_drift')
  })
})
