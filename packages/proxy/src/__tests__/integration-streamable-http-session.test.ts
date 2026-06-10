import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createApp } from '../server.js'
import { StreamableHttpForwarder } from '../upstream/streamable-http-forwarder.js'
import { GovernedForwarder } from '../policy/governed-forwarder.js'
import { compilePolicies } from '../policy/parser.js'
import { startSessionEnforcingHttpMcpServer } from './helpers/mcp-test-server.js'
import { startOnDynamicPort, makeConfig, sendMcpRequest } from './helpers/test-utils.js'
import type { ManagedServer } from './helpers/test-utils.js'

describe('Streamable HTTP session-enforcing upstream', () => {
  let upstream: { port: number; close: () => Promise<void> }
  let proxy: ManagedServer
  let proxyUrl: string
  let forwarder: StreamableHttpForwarder

  beforeAll(async () => {
    upstream = await startSessionEnforcingHttpMcpServer()
    const config = makeConfig({
      upstream: {
        url: `http://127.0.0.1:${String(upstream.port)}/mcp`,
        transport: 'streamable-http',
      },
    })
    forwarder = new StreamableHttpForwarder({ url: config.upstream.url })
    await forwarder.connect()
    proxy = startOnDynamicPort(createApp(config, forwarder))
    proxyUrl = `http://127.0.0.1:${String(proxy.port)}/mcp`
  })

  afterAll(async () => {
    await proxy.close()
    await forwarder.close()
    await upstream.close()
  })

  it('primes annotations against a session-enforcing SSE upstream', async () => {
    const gf = new GovernedForwarder(
      forwarder,
      compilePolicies({ default: 'allow', dry_run: false, rules: [] }).policy,
    )
    const result = await gf.primeAnnotationCache()
    expect(result.success).toBe(true)
    expect(result.toolsCached).toBeGreaterThan(0)
  })

  it('tools/list succeeds through the proxy (downstream-initialized session)', async () => {
    const init = await sendMcpRequest(proxyUrl, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    })
    const sessionId = init.headers.get('mcp-session-id') ?? undefined
    expect(sessionId).toBeDefined()

    // Send notifications/initialized so the server considers the session ready
    await fetch(proxyUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    })

    const { status, body } = await sendMcpRequest(proxyUrl, 'tools/list', undefined, 2, {
      sessionId,
    })
    expect(status).toBe(200)
    const tools = (body['result'] as { tools: { name: string }[] }).tools
    expect(tools.map((t) => t.name)).toContain('get_weather')
  })

  it('a sessionless pre-initialize tools/list is rejected by the upstream with HTTP 400', async () => {
    // Call the upstream directly (bypassing the proxy) with a bare tools/list —
    // this documents that the fixture genuinely enforces sessions and that the
    // old sessionless client would still fail against it.
    const res = await fetch(`http://127.0.0.1:${String(upstream.port)}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    expect(res.status).toBe(400)
  })
})
