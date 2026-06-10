import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createApp } from '../server.js'
import { createForwarderFromConfig } from '../cli-forwarder.js'
import { GovernedForwarder } from '../policy/governed-forwarder.js'
import { compilePolicies } from '../policy/parser.js'
import { startSessionEnforcingHttpMcpServer } from './helpers/mcp-test-server.js'
import { startOnDynamicPort, makeConfig, sendMcpRequest } from './helpers/test-utils.js'
import type { ManagedServer } from './helpers/test-utils.js'

describe('Streamable HTTP session-enforcing upstream', () => {
  let upstream: { port: number; close: () => Promise<void> } | undefined
  let upstreamPort = 0
  let proxy: ManagedServer | undefined
  let proxyUrl: string
  let governedForwarder: GovernedForwarder
  let closeForwarder: (() => Promise<void>) | undefined

  beforeAll(async () => {
    upstream = await startSessionEnforcingHttpMcpServer()
    upstreamPort = upstream.port
    const config = makeConfig({
      upstream: {
        url: `http://127.0.0.1:${String(upstreamPort)}/mcp`,
        transport: 'streamable-http',
        request_timeout: '30s',
      },
    })
    const built = await createForwarderFromConfig(config)
    closeForwarder = built.close
    governedForwarder = new GovernedForwarder(
      built.forwarder,
      compilePolicies({ default: 'allow', dry_run: false, rules: [] }).policy,
    )
    proxy = startOnDynamicPort(createApp(config, governedForwarder))
    proxyUrl = `http://127.0.0.1:${String(proxy.port)}/mcp`
  })

  afterAll(async () => {
    if (proxy) await proxy.close()
    await closeForwarder?.()
    if (upstream) await upstream.close()
  })

  it('primes annotations against a session-enforcing SSE upstream through production wiring', async () => {
    const result = await governedForwarder.primeAnnotationCache()
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
    const res = await fetch(`http://127.0.0.1:${String(upstreamPort)}/mcp`, {
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
