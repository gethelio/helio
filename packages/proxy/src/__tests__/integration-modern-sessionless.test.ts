import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createApp } from '../server.js'
import { createForwarderFromConfig } from '../cli-forwarder.js'
import { GovernedForwarder } from '../policy/governed-forwarder.js'
import { compilePolicies } from '../policy/parser.js'
import { AuditStore, AuditWriter } from '../audit/index.js'
import { startModernOnlyHttpMcpServer } from './helpers/mcp-test-server.js'
import { startOnDynamicPort, makeConfig } from './helpers/test-utils.js'
import type { ModernOnlyMcpServer } from './helpers/mcp-test-server.js'
import type { ManagedServer } from './helpers/test-utils.js'

// The modern mirror of integration-streamable-http-session.test.ts (issue
// #219): a MODERN downstream client — sessionless, no initialize handshake,
// claiming 2026-07-28 on the wire — drives the proxy against the modern-only
// fixture through production wiring. No internal priming runs first, so the
// first relay is also what triggers the era probe.

/** The name-bearing params field a 2026-07-28 client mirrors onto Mcp-Name. */
const NAME_BEARING_FIELD: Record<string, 'name' | 'uri'> = {
  'tools/call': 'name',
  'prompts/get': 'name',
  'resources/read': 'uri',
}

/**
 * A modern client's POST: sessionless, version-claiming, identity-carrying,
 * and fully conformant to the 2026-07-28 header/body agreement — Mcp-Method,
 * Mcp-Name on name-bearing methods, and the params._meta protocol-version
 * mirror. A bare version claim is rejected at the inbound door since #226;
 * the bare-claim rejection itself is covered by the header-agreement
 * integration suite.
 */
async function sendModernClientRequest(
  baseUrl: string,
  method: string,
  params?: Record<string, unknown>,
  id: number | string = 1,
): Promise<{ status: number; headers: Headers; body: Record<string, unknown> }> {
  const mergedParams: Record<string, unknown> = {
    ...params,
    _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' },
  }
  const payload: Record<string, unknown> = { jsonrpc: '2.0', id, method, params: mergedParams }
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'mcp-protocol-version': '2026-07-28',
    'mcp-method': method,
    'x-helio-session-id': 'modern-run-1',
  }
  const nameField = NAME_BEARING_FIELD[method]
  const nameValue = nameField === undefined ? undefined : mergedParams[nameField]
  if (typeof nameValue === 'string') headers['mcp-name'] = nameValue
  const res = await fetch(baseUrl, {
    method: 'POST',
    body: JSON.stringify(payload),
    headers,
  })
  const body = (await res.json()) as Record<string, unknown>
  return { status: res.status, headers: res.headers, body }
}

describe('modern sessionless client against a modern-only upstream', () => {
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
    proxy = startOnDynamicPort(createApp(config, governedForwarder))
    proxyUrl = `http://127.0.0.1:${String(proxy.port)}/mcp`
  })

  afterAll(async () => {
    if (proxy) await proxy.close()
    await closeForwarder?.()
    if (upstream) await upstream.close()
    auditWriter.close()
  })

  it('serves tools/list and tools/call with no handshake and no session id anywhere', async () => {
    const list = await sendModernClientRequest(proxyUrl, 'tools/list', undefined, 'list-1')
    expect(list.status).toBe(200)
    expect(list.headers.get('mcp-session-id')).toBeNull()
    const tools = (list.body['result'] as { tools: { name: string }[] }).tools
    expect(tools.map((tool) => tool.name)).toContain('get_status')

    const call = await sendModernClientRequest(
      proxyUrl,
      'tools/call',
      { name: 'get_status', arguments: {} },
      'call-1',
    )
    expect(call.status).toBe(200)
    expect(call.headers.get('mcp-session-id')).toBeNull()
    expect(call.body['error']).toBeUndefined()
    const content = (call.body['result'] as { content: { text: string }[] }).content
    expect(content[0]?.text).toContain('get_status')

    // No handshake ever happened, upstream or downstream, and no POST the
    // upstream received carried a session id.
    const seen = upstream?.receivedRequests ?? []
    expect(seen.filter((req) => req.method === 'initialize')).toHaveLength(0)
    expect(seen.filter((req) => req.method === 'notifications/initialized')).toHaveLength(0)
    for (const received of seen) {
      expect(received.headers['mcp-session-id']).toBeUndefined()
      expect(received.headers['mcp-protocol-version']).toBe('2026-07-28')
    }
  })

  it('records the client protocol claim on the audit trail through production wiring', () => {
    auditWriter.flush()
    const records = auditStore.list({ tool_name: 'get_status' }).records
    expect(records).toHaveLength(1)
    expect(records[0]?.protocol_version).toBe('2026-07-28')
    // The governance identity resolved independently of the (absent) wire
    // session — proxy-owned identity is orthogonal to transport sessions.
    expect(records[0]?.session_id).toBe('modern-run-1')
    expect(records[0]?.session_source).toBe('header')
  })
})
