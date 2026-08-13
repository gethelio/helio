import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { createApp } from '../server.js'
import { createForwarderFromConfig } from '../cli-forwarder.js'
import { GovernedForwarder } from '../policy/governed-forwarder.js'
import { compilePolicies } from '../policy/parser.js'
import { AuditStore, AuditWriter, buildHeaderMismatchAuditRecord } from '../audit/index.js'
import { startModernOnlyHttpMcpServer } from './helpers/mcp-test-server.js'
import { startOnDynamicPort, makeConfig } from './helpers/test-utils.js'
import type { ModernOnlyMcpServer } from './helpers/mcp-test-server.js'
import type { ManagedServer } from './helpers/test-utils.js'

// Issue #226: the inbound header/body agreement door through production
// wiring — createApp + GovernedForwarder + audit store, with the rejection
// recorder composed exactly as cli.ts composes it (createApp without options
// writes no rejection records, so every audit assertion here depends on it).

const MODERN = '2026-07-28'
const MIRROR_KEY = 'io.modelcontextprotocol/protocolVersion'
/** Sentinel-wrapped 'Hello, 世界' — hand-rolled, not built with the encoder. */
const ENCODED_HELLO_WORLD = '=?base64?SGVsbG8sIOS4lueVjA==?='

interface McpPostResult {
  status: number
  body: Record<string, unknown>
}

async function postJson(
  url: string,
  payload: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<McpPostResult> {
  const res = await fetch(url, {
    method: 'POST',
    body: JSON.stringify(payload),
    headers: { 'content-type': 'application/json', ...headers },
  })
  const body = (await res.json()) as Record<string, unknown>
  return { status: res.status, body }
}

function errorCode(body: Record<string, unknown>): number | undefined {
  const error = body['error']
  if (typeof error !== 'object' || error === null) return undefined
  return (error as { code?: number }).code
}

describe('inbound header/body agreement through production wiring (issue #226)', () => {
  let upstream: ModernOnlyMcpServer | undefined
  let proxy: ManagedServer | undefined
  let proxyUrl: string
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
      environment: 'integration',
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

    const governedForwarder = new GovernedForwarder(
      built.forwarder,
      compilePolicies({ default: 'allow', dry_run: false, rules: [] }).policy,
      { auditWriter },
    )
    // The cli.ts recorder composition, verbatim: callback → builder →
    // pushImmediate.
    proxy = startOnDynamicPort(
      createApp(config, governedForwarder, {
        onHeaderMismatch: (rejection) => {
          auditWriter.pushImmediate(buildHeaderMismatchAuditRecord(rejection, config.environment))
        },
      }),
    )
    proxyUrl = `http://127.0.0.1:${String(proxy.port)}/mcp`
  })

  afterAll(async () => {
    if (proxy) await proxy.close()
    await closeForwarder?.()
    if (upstream) await upstream.close()
    auditWriter.close()
  })

  it('(a) rejects a lying mcp-name before any forwarding and writes exactly one rejection record', async () => {
    const upstreamRequestsBefore = upstream?.receivedRequests.length ?? 0

    const { status, body } = await postJson(
      proxyUrl,
      {
        jsonrpc: '2.0',
        id: 'a-1',
        method: 'tools/call',
        params: {
          name: 'transfer_funds',
          arguments: { amount: 5 },
          _meta: { [MIRROR_KEY]: MODERN },
        },
      },
      {
        'mcp-protocol-version': MODERN,
        'mcp-method': 'tools/call',
        'mcp-name': 'list_orders',
        'x-helio-session-id': 'reject-run-a',
      },
    )

    expect(status).toBe(400)
    expect(errorCode(body)).toBe(-32020)
    expect(body['id']).toBe('a-1')
    // The upstream fixture received NOTHING for this request — rejection
    // precedes policy evaluation and forwarding entirely.
    expect(upstream?.receivedRequests.length ?? 0).toBe(upstreamRequestsBefore)

    auditWriter.flush()
    const records = auditStore.list({
      block_reason: 'header_mismatch',
      tool_name: 'transfer_funds',
    }).records
    expect(records).toHaveLength(1)
    const record = records[0]
    expect(record?.policy_decision).toBe('rejected')
    expect(record?.record_kind).toBe('tool_call')
    expect(record?.origin).toBe('mcp')
    expect(record?.protocol_version).toBe(MODERN)
    expect(record?.session_id).toBe('reject-run-a')
    expect(record?.session_source).toBe('header')
    expect(record?.environment).toBe('integration')
    expect(record?.tool_input['body_method']).toBe('tools/call')
    expect(record?.tool_input['mismatch_reason']).toContain('mismatched mcp-name')
    expect(record?.tool_input['headers']).toEqual({
      'mcp-method': 'tools/call',
      'mcp-name': 'list_orders',
      'mcp-protocol-version': MODERN,
    })
    expect(record?.tool_input['raw_params']).toEqual({
      name: 'transfer_funds',
      arguments: { amount: 5 },
      _meta: { [MIRROR_KEY]: MODERN },
    })
    expect(record?.matched_rule).toBeNull()
    expect(record?.upstream_response).toBeNull()
  })

  it('(b) forwards and governs the same body when the headers agree', async () => {
    const { status, body } = await postJson(
      proxyUrl,
      {
        jsonrpc: '2.0',
        id: 'b-1',
        method: 'tools/call',
        params: {
          name: 'transfer_funds',
          arguments: { amount: 5 },
          _meta: { [MIRROR_KEY]: MODERN },
        },
      },
      {
        'mcp-protocol-version': MODERN,
        'mcp-method': 'tools/call',
        'mcp-name': 'transfer_funds',
        'x-helio-session-id': 'allow-run-b',
      },
    )

    expect(status).toBe(200)
    expect(body['error']).toBeUndefined()
    const content = (body['result'] as { content: { text: string }[] }).content
    expect(content[0]?.text).toContain('transfer_funds executed')

    auditWriter.flush()
    const records = auditStore
      .list({ tool_name: 'transfer_funds' })
      .records.filter((record) => record.block_reason === null)
    expect(records).toHaveLength(1)
    expect(records[0]?.policy_decision).toBe('allow')
    expect(records[0]?.session_id).toBe('allow-run-b')
  })

  it('(c) rejects a bare modern claim missing mcp-method — the shape that forwarded before this change', async () => {
    const upstreamRequestsBefore = upstream?.receivedRequests.length ?? 0

    const { status, body } = await postJson(
      proxyUrl,
      {
        jsonrpc: '2.0',
        id: 'c-1',
        method: 'tools/list',
        params: { _meta: { [MIRROR_KEY]: MODERN } },
      },
      { 'mcp-protocol-version': MODERN },
    )

    expect(status).toBe(400)
    expect(errorCode(body)).toBe(-32020)
    expect(upstream?.receivedRequests.length ?? 0).toBe(upstreamRequestsBefore)

    auditWriter.flush()
    const records = auditStore.list({
      block_reason: 'header_mismatch',
      tool_name: '<header_mismatch>',
    }).records
    expect(records).toHaveLength(1)
    expect(records[0]?.tool_input['body_method']).toBe('tools/list')
    expect(records[0]?.tool_input['mismatch_reason']).toContain('missing mcp-method')
  })

  it('(d) rejects a lying mcp-name with no version claim at all (tier 2)', async () => {
    const upstreamRequestsBefore = upstream?.receivedRequests.length ?? 0

    const { status, body } = await postJson(
      proxyUrl,
      {
        jsonrpc: '2.0',
        id: 'd-1',
        method: 'tools/call',
        params: { name: 'get_status', arguments: {} },
      },
      { 'mcp-name': 'other_tool' },
    )

    expect(status).toBe(400)
    expect(errorCode(body)).toBe(-32020)
    expect(upstream?.receivedRequests.length ?? 0).toBe(upstreamRequestsBefore)

    auditWriter.flush()
    const records = auditStore.list({
      block_reason: 'header_mismatch',
      tool_name: 'get_status',
    }).records
    expect(records).toHaveLength(1)
    // No version claim on the wire: the record's protocol_version is null.
    expect(records[0]?.protocol_version).toBeNull()
    expect(records[0]?.tool_input['headers']).toEqual({ 'mcp-name': 'other_tool' })
  })

  it('(e) passes a legacy client with no markers end-to-end unchanged', async () => {
    const { status, body } = await postJson(proxyUrl, {
      jsonrpc: '2.0',
      id: 'e-1',
      method: 'tools/call',
      params: { name: 'get_status', arguments: {} },
    })

    expect(status).toBe(200)
    expect(body['error']).toBeUndefined()
    const content = (body['result'] as { content: { text: string }[] }).content
    expect(content[0]?.text).toContain('get_status executed')
  })

  it('(g) agrees on a sentinel-encoded mcp-name end-to-end', async () => {
    const { status, body } = await postJson(
      proxyUrl,
      {
        jsonrpc: '2.0',
        id: 'g-1',
        method: 'tools/call',
        params: { name: 'Hello, 世界', arguments: {}, _meta: { [MIRROR_KEY]: MODERN } },
      },
      {
        'mcp-protocol-version': MODERN,
        'mcp-method': 'tools/call',
        'mcp-name': ENCODED_HELLO_WORLD,
      },
    )

    expect(status).toBe(200)
    expect(body['error']).toBeUndefined()
    const content = (body['result'] as { content: { text: string }[] }).content
    expect(content[0]?.text).toContain('Hello, 世界 executed')
  })

  it("(f) ignores agreement headers on the /sse route — today's behavior, pinned", async () => {
    // Establish an SSE session (GET /sse, read the endpoint event).
    const ac = new AbortController()
    const sseRes = await fetch(`http://127.0.0.1:${String(proxy?.port ?? 0)}/sse`, {
      signal: ac.signal,
    })
    expect(sseRes.status).toBe(200)
    if (!sseRes.body) throw new Error('SSE response has no body')
    const reader = sseRes.body.getReader()
    const decoder = new TextDecoder()

    let buffer = ''
    let sessionId = ''
    while (!sessionId) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- ReadableStreamDefaultReader.read() types
      const { done, value } = await reader.read()
      if (done) throw new Error('SSE stream ended before endpoint event')
      buffer += decoder.decode(value as Uint8Array, { stream: true })
      const parts = buffer.split('\n\n')
      buffer = parts.pop() ?? ''
      for (const part of parts) {
        if (part.includes('event: endpoint')) {
          const dataMatch = part.match(/data: \?sessionId=([a-f0-9-]+)/)
          if (dataMatch?.[1]) sessionId = dataMatch[1]
        }
      }
    }

    // POST a tools/call carrying a LYING Mcp-Method: the SSE transport
    // predates the standard request headers, so the route ignores them —
    // 202-accepted and forwarded, never a 400.
    const postRes = await fetch(
      `http://127.0.0.1:${String(proxy?.port ?? 0)}/sse?sessionId=${sessionId}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'mcp-method': 'tools/list' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'f-1',
          method: 'tools/call',
          params: { name: 'get_status', arguments: {} },
        }),
      },
    )
    expect(postRes.status).toBe(202)

    // The response arrives on the stream — a result, not a -32020.
    let message: Record<string, unknown> | undefined
    while (!message) {
      const chunk = await reader.read()
      if (chunk.done) throw new Error('SSE stream ended before message event')
      buffer += decoder.decode(chunk.value as Uint8Array, { stream: true })
      const parts = buffer.split('\n\n')
      buffer = parts.pop() ?? ''
      for (const part of parts) {
        if (part.includes('event: message')) {
          const dataMatch = part.match(/data: (.+)/)
          if (dataMatch?.[1]) message = JSON.parse(dataMatch[1]) as Record<string, unknown>
        }
      }
    }
    expect(message['error']).toBeUndefined()
    expect(message['result']).toBeDefined()
    ac.abort()
  })
})

// ---------------------------------------------------------------------------
// (h) The R1 F1 chained-proxy regression: Helio A → Helio B → legacy fixture.
// ---------------------------------------------------------------------------

/** A running hand-rolled legacy fixture that records every method received. */
interface LegacyRecordingMcpServer {
  port: number
  close: () => Promise<void>
  receivedMethods: readonly string[]
}

/**
 * A minimal JSON-only LEGACY (2025-06-18) MCP fixture: answers
 * `server/discover` with -32601 (method not found — the legacy
 * classification signal), speaks the initialize handshake statelessly, and
 * records every method received so the chained-proxy test can count
 * `server/discover` arrivals.
 */
function startLegacyRecordingMcpServer(): Promise<LegacyRecordingMcpServer> {
  const receivedMethods: string[] = []

  const httpServer: Server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/mcp') {
      res.writeHead(404)
      res.end()
      return
    }
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Record<string, unknown>
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } }))
        return
      }
      const method = typeof parsed['method'] === 'string' ? parsed['method'] : '<non-string>'
      const id = (parsed['id'] ?? null) as string | number | null
      receivedMethods.push(method)

      const respond = (status: number, payload: Record<string, unknown>): void => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
      }

      if (method === 'initialize') {
        respond(200, {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'legacy-recording-fixture', version: '1.0.0' },
          },
        })
        return
      }
      if (method.startsWith('notifications/')) {
        res.writeHead(202)
        res.end()
        return
      }
      if (method === 'tools/list') {
        respond(200, {
          jsonrpc: '2.0',
          id,
          result: {
            tools: [{ name: 'get_status', description: 'Report status' }],
          },
        })
        return
      }
      if (method === 'tools/call') {
        const params = parsed['params']
        const name =
          typeof params === 'object' && params !== null
            ? (params as Record<string, unknown>)['name']
            : undefined
        respond(200, {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: `${String(name)} executed` }] },
        })
        return
      }
      // server/discover and anything else a 2025-06-18 server does not
      // know: a parsed-and-answered JSON-RPC error — the legacy signal.
      respond(200, {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      })
    })()
  })

  return new Promise((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => {
      const port = (httpServer.address() as AddressInfo).port
      resolve({
        port,
        close: () =>
          new Promise<void>((res2, rej2) => {
            httpServer.close((err) => {
              if (err) rej2(err)
              else res2()
            })
            httpServer.closeIdleConnections()
          }),
        receivedMethods,
      })
    })
  })
}

describe('chained proxies keep the era cache stable (issue #226, R1 F1 regression)', () => {
  let fixture: LegacyRecordingMcpServer | undefined
  let proxyB: ManagedServer | undefined
  let proxyA: ManagedServer | undefined
  let closeForwarderB: (() => Promise<void>) | undefined
  let closeForwarderA: (() => Promise<void>) | undefined
  let proxyAUrl: string

  beforeAll(async () => {
    fixture = await startLegacyRecordingMcpServer()

    const configB = makeConfig({
      upstream: {
        url: `http://127.0.0.1:${String(fixture.port)}/mcp`,
        transport: 'streamable-http',
        request_timeout: '30s',
      },
    })
    const builtB = await createForwarderFromConfig(configB)
    closeForwarderB = builtB.close
    const governedB = new GovernedForwarder(
      builtB.forwarder,
      compilePolicies({ default: 'allow', dry_run: false, rules: [] }).policy,
      {},
    )
    proxyB = startOnDynamicPort(createApp(configB, governedB))

    const configA = makeConfig({
      upstream: {
        url: `http://127.0.0.1:${String(proxyB.port)}/mcp`,
        transport: 'streamable-http',
        request_timeout: '30s',
      },
    })
    const builtA = await createForwarderFromConfig(configA)
    closeForwarderA = builtA.close
    const governedA = new GovernedForwarder(
      builtA.forwarder,
      compilePolicies({ default: 'allow', dry_run: false, rules: [] }).policy,
      {},
    )
    proxyA = startOnDynamicPort(createApp(configA, governedA))
    proxyAUrl = `http://127.0.0.1:${String(proxyA.port)}/mcp`
  })

  afterAll(async () => {
    if (proxyA) await proxyA.close()
    if (proxyB) await proxyB.close()
    await closeForwarderA?.()
    await closeForwarderB?.()
    if (fixture) await fixture.close()
  })

  it('relays a conformant modern client through A and B with no 400, no -32020, and no era clear', async () => {
    // A conformant modern client through A. A's era probe of B relays
    // through B to the legacy fixture and classifies the chain legacy; A's
    // legacy relay leg then forwards the client's body VERBATIM — modern
    // mirror intact — under a 2025-06-18 stamp with agreeing mcp-method/
    // mcp-name. B's tier-2 door must pass that shape (the R1 F1 named
    // regression: a tier-2 mirror rule would 400 here, and the relayed
    // -32020 would clear A's correctly cached legacy era).
    const first = await postJson(
      proxyAUrl,
      {
        jsonrpc: '2.0',
        id: 'chain-1',
        method: 'tools/call',
        params: { name: 'get_status', arguments: {}, _meta: { [MIRROR_KEY]: MODERN } },
      },
      {
        'mcp-protocol-version': MODERN,
        'mcp-method': 'tools/call',
        'mcp-name': 'get_status',
      },
    )

    expect(first.status).toBe(200)
    expect(first.body['error']).toBeUndefined()
    const content = (first.body['result'] as { content: { text: string }[] }).content
    expect(content[0]?.text).toContain('get_status executed')

    // server/discover arrivals at the terminal fixture: exactly two —
    // B's own era probe, then A's probe relayed through B's legacy leg.
    // A falsification-triggered era clear would add more on later calls.
    const probesAfterFirstCall = (fixture?.receivedMethods ?? []).filter(
      (method) => method === 'server/discover',
    ).length
    expect(probesAfterFirstCall).toBe(2)

    // A second call: both era caches hold, so no new probe reaches the
    // fixture — the count is stable, proving A's era was NOT cleared.
    const second = await postJson(
      proxyAUrl,
      {
        jsonrpc: '2.0',
        id: 'chain-2',
        method: 'tools/call',
        params: { name: 'get_status', arguments: {}, _meta: { [MIRROR_KEY]: MODERN } },
      },
      {
        'mcp-protocol-version': MODERN,
        'mcp-method': 'tools/call',
        'mcp-name': 'get_status',
      },
    )
    expect(second.status).toBe(200)
    expect(second.body['error']).toBeUndefined()

    const probesAfterSecondCall = (fixture?.receivedMethods ?? []).filter(
      (method) => method === 'server/discover',
    ).length
    expect(probesAfterSecondCall).toBe(2)
  })
})
