import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { Hono } from 'hono'
import { createApp } from '../server.js'
import { UpstreamForwarder } from '../upstream/forwarder.js'
import { GovernedForwarder } from '../policy/governed-forwarder.js'
import { compilePolicies } from '../policy/parser.js'
import { AuditStore } from '../audit/store.js'
import { AuditWriter } from '../audit/writer.js'
import { startHttpMcpServer } from './helpers/mcp-test-server.js'
import { startOnDynamicPort, makeConfig, sendMcpRequest } from './helpers/test-utils.js'
import type { ManagedServer } from './helpers/test-utils.js'

describe('Streamable HTTP integration', () => {
  let upstream: { port: number; close: () => Promise<void> }
  let proxy: ManagedServer
  let proxyUrl: string

  beforeAll(async () => {
    upstream = await startHttpMcpServer()

    const config = makeConfig({
      upstream: {
        url: `http://127.0.0.1:${String(upstream.port)}/mcp`,
        transport: 'streamable-http',
      },
    })

    const forwarder = new UpstreamForwarder({
      url: config.upstream.url,
      headers: {},
    })

    const app = createApp(config, forwarder)
    proxy = startOnDynamicPort(app)
    proxyUrl = `http://127.0.0.1:${String(proxy.port)}/mcp`
  })

  afterAll(async () => {
    await proxy.close()
    await upstream.close()
  })

  // --- tools ---

  it('tools/list returns all 6 tools', async () => {
    const { status, body } = await sendMcpRequest(proxyUrl, 'tools/list')
    expect(status).toBe(200)

    const result = body['result'] as {
      tools: {
        name: string
        description: string
        inputSchema?: Record<string, unknown>
      }[]
    }
    const names = result.tools.map((t) => t.name).sort()
    expect(names).toEqual([
      'create_payment',
      'delete_record',
      'get_weather',
      'lookup_order',
      'send_email',
      'transfer_funds',
    ])

    // Verify descriptions and inputSchema pass through
    const weather = result.tools.find((t) => t.name === 'get_weather')
    expect(weather?.description).toBe('Get the current weather for a city')
    expect(weather?.inputSchema).toBeDefined()
    expect(weather?.inputSchema?.['properties']).toHaveProperty('city')
  })

  it('tools/call get_weather returns correct response', async () => {
    const { status, body } = await sendMcpRequest(proxyUrl, 'tools/call', {
      name: 'get_weather',
      arguments: { city: 'London' },
    })
    expect(status).toBe(200)

    const result = body['result'] as { content: { type: string; text: string }[] }
    expect(result.content[0]?.text).toBe('Sunny, 22°C in London')
  })

  it('tools/call send_email returns correct response', async () => {
    const { status, body } = await sendMcpRequest(proxyUrl, 'tools/call', {
      name: 'send_email',
      arguments: { to: 'test@example.com', body: 'Hello' },
    })
    expect(status).toBe(200)

    const result = body['result'] as { content: { type: string; text: string }[] }
    expect(result.content[0]?.text).toBe('Email sent to test@example.com')
  })

  it('tools/call create_payment returns correct response', async () => {
    const { status, body } = await sendMcpRequest(proxyUrl, 'tools/call', {
      name: 'create_payment',
      arguments: { amount: 99.99, currency: 'USD' },
    })
    expect(status).toBe(200)

    const result = body['result'] as { content: { type: string; text: string }[] }
    expect(result.content[0]?.text).toBe('Payment of 99.99 USD created')
  })

  it('tools/call delete_record returns correct response', async () => {
    const { status, body } = await sendMcpRequest(proxyUrl, 'tools/call', {
      name: 'delete_record',
      arguments: { id: 'rec-42' },
    })
    expect(status).toBe(200)

    const result = body['result'] as { content: { type: string; text: string }[] }
    expect(result.content[0]?.text).toBe('Record rec-42 deleted')
  })

  // --- resources ---

  it('resources/list passes through', async () => {
    const { status, body } = await sendMcpRequest(proxyUrl, 'resources/list')
    expect(status).toBe(200)

    const result = body['result'] as { resources: { uri: string }[] }
    expect(result.resources).toHaveLength(1)
    expect(result.resources[0]?.uri).toBe('status://server')
  })

  it('resources/read passes through', async () => {
    const { status, body } = await sendMcpRequest(proxyUrl, 'resources/read', {
      uri: 'status://server',
    })
    expect(status).toBe(200)

    const result = body['result'] as { contents: { text: string }[] }
    expect(result.contents[0]?.text).toBe('Helio test server is running')
  })

  // --- prompts ---

  it('prompts/list passes through', async () => {
    const { status, body } = await sendMcpRequest(proxyUrl, 'prompts/list')
    expect(status).toBe(200)

    const result = body['result'] as { prompts: { name: string }[] }
    expect(result.prompts).toHaveLength(1)
    expect(result.prompts[0]?.name).toBe('summarize')
  })

  it('prompts/get passes through', async () => {
    const { status, body } = await sendMcpRequest(proxyUrl, 'prompts/get', {
      name: 'summarize',
      arguments: { text: 'test input' },
    })
    expect(status).toBe(200)

    const result = body['result'] as {
      messages: { role: string; content: { type: string; text: string } }[]
    }
    expect(result.messages[0]?.role).toBe('user')
    expect(result.messages[0]?.content.text).toBe('Please summarize: test input')
  })

  // --- initialize ---

  it('initialize passes through with protocol info', async () => {
    const { status, body } = await sendMcpRequest(proxyUrl, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    })
    expect(status).toBe(200)

    const result = body['result'] as {
      protocolVersion: string
      capabilities: Record<string, unknown>
      serverInfo: { name: string }
    }
    expect(result.protocolVersion).toBeDefined()
    expect(result.capabilities).toBeDefined()
    expect(result.serverInfo.name).toBe('helio-test-server')
  })

  // --- error handling ---

  it('upstream unreachable returns normalized JSON-RPC error envelope', async () => {
    const config = makeConfig({
      upstream: {
        url: 'http://127.0.0.1:19999/mcp',
        transport: 'streamable-http',
      },
    })

    const forwarder = new UpstreamForwarder({ url: config.upstream.url })
    const app = createApp(config, forwarder)
    const badProxy = startOnDynamicPort(app)

    try {
      const { status, body } = await sendMcpRequest(
        `http://127.0.0.1:${String(badProxy.port)}/mcp`,
        'tools/list',
      )
      expect(status).toBe(200)
      expect(body['jsonrpc']).toBe('2.0')
      const error = body['error'] as Record<string, unknown>
      expect(error['code']).toBe(-32603)
      const data = error['data'] as Record<string, unknown>
      expect(data['failure_class']).toBe('upstream_forward_error')
    } finally {
      await badProxy.close()
    }
  })

  it('malformed non-JSON upstream response is wrapped as JSON-RPC internal error', async () => {
    const upstreamApp = new Hono()
    upstreamApp.post('/mcp', () => {
      return new Response('upstream failed', {
        status: 500,
        headers: { 'content-type': 'text/plain' },
      })
    })

    const malformedUpstream = startOnDynamicPort(upstreamApp)
    const config = makeConfig({
      upstream: {
        url: `http://127.0.0.1:${String(malformedUpstream.port)}/mcp`,
        transport: 'streamable-http',
      },
    })
    const forwarder = new UpstreamForwarder({ url: config.upstream.url })
    const app = createApp(config, forwarder)
    const proxy = startOnDynamicPort(app)

    try {
      const { status, body } = await sendMcpRequest(
        `http://127.0.0.1:${String(proxy.port)}/mcp`,
        'tools/call',
        { name: 'get_weather', arguments: { city: 'NYC' } },
        1009,
      )
      expect(status).toBe(200)
      expect(body['jsonrpc']).toBe('2.0')
      const error = body['error'] as Record<string, unknown>
      expect(error['code']).toBe(-32603)
      const data = error['data'] as Record<string, unknown>
      expect(data['failure_class']).toBe('upstream_invalid_jsonrpc')
      expect(data['upstream_http_status']).toBe(500)
      expect(data['upstream_content_type']).toBe('text/plain')
      expect(data['upstream_body_excerpt']).toBeUndefined()
    } finally {
      await proxy.close()
      await malformedUpstream.close()
    }
  })
})

// ---------------------------------------------------------------------------
// Policy evaluation integration tests
// ---------------------------------------------------------------------------

describe('Policy evaluation (Streamable HTTP)', () => {
  let upstream: { port: number; close: () => Promise<void> }

  beforeAll(async () => {
    upstream = await startHttpMcpServer()
  })

  afterAll(async () => {
    await upstream.close()
  })

  /** Create a proxy with the given policy config and return its URL + close handle. */
  function createGovernedProxy(policiesConfig: {
    default?: 'allow' | 'deny'
    rules: Array<Record<string, unknown>>
  }) {
    const config = makeConfig({
      upstream: {
        url: `http://127.0.0.1:${String(upstream.port)}/mcp`,
        transport: 'streamable-http',
      },
      policies: policiesConfig as ReturnType<typeof makeConfig>['policies'],
    })
    const rawForwarder = new UpstreamForwarder({ url: config.upstream.url })
    const { policy } = compilePolicies(config.policies)
    const governed = new GovernedForwarder(rawForwarder, policy, {
      environment: config.environment,
    })
    const app = createApp(config, governed)
    const managed = startOnDynamicPort(app)
    return {
      url: `http://127.0.0.1:${String(managed.port)}/mcp`,
      close: managed.close,
    }
  }

  it('allowed tool call passes through and returns upstream response', async () => {
    const proxy = createGovernedProxy({
      default: 'deny',
      rules: [{ match: { tool: 'get_weather' }, action: 'allow' }],
    })

    try {
      const { status, body } = await sendMcpRequest(proxy.url, 'tools/call', {
        name: 'get_weather',
        arguments: { city: 'London' },
      })
      expect(status).toBe(200)
      const result = body['result'] as { content: { type: string; text: string }[] }
      expect(result.content[0]?.text).toBe('Sunny, 22°C in London')
    } finally {
      await proxy.close()
    }
  })

  it('denied tool call returns JSON-RPC error without contacting upstream', async () => {
    const proxy = createGovernedProxy({
      default: 'allow',
      rules: [
        {
          name: 'block-delete',
          match: { tool: 'delete_*' },
          action: 'deny',
          feedback: { message: 'Destructive operations are disabled' },
        },
      ],
    })

    try {
      const { status, body } = await sendMcpRequest(proxy.url, 'tools/call', {
        name: 'delete_record',
        arguments: { id: 'rec-42' },
      })
      expect(status).toBe(200)

      const error = body['error'] as {
        code: number
        message: string
        data: Record<string, unknown>
      }
      expect(error.code).toBe(-32001)
      expect(error.message).toBe('Destructive operations are disabled')
      expect(error.data['blocked']).toBe(true)
      expect(error.data['rule']).toBe('block-delete')
    } finally {
      await proxy.close()
    }
  })

  it('default deny blocks unmatched tools', async () => {
    const proxy = createGovernedProxy({
      default: 'deny',
      rules: [{ match: { tool: 'get_weather' }, action: 'allow' }],
    })

    try {
      const { status, body } = await sendMcpRequest(proxy.url, 'tools/call', {
        name: 'send_email',
        arguments: { to: 'test@example.com', body: 'Hello' },
      })
      expect(status).toBe(200)

      const error = body['error'] as { code: number; data: Record<string, unknown> }
      expect(error.code).toBe(-32001)
      expect(error.data['blocked']).toBe(true)
    } finally {
      await proxy.close()
    }
  })

  it('non-tool methods pass through regardless of policy', async () => {
    const proxy = createGovernedProxy({
      default: 'deny',
      rules: [{ match: { tool: '*' }, action: 'deny' }],
    })

    try {
      // tools/list should pass through even with deny-all policy
      const { status, body } = await sendMcpRequest(proxy.url, 'tools/list')
      expect(status).toBe(200)
      const result = body['result'] as { tools: { name: string }[] }
      expect(result.tools.length).toBeGreaterThan(0)
    } finally {
      await proxy.close()
    }
  })

  it('annotation-based matching works after tools/list populates cache', async () => {
    const proxy = createGovernedProxy({
      default: 'allow',
      rules: [{ match: { annotations: { destructiveHint: true } }, action: 'deny' }],
    })

    try {
      // First call tools/list to populate the annotation cache
      await sendMcpRequest(proxy.url, 'tools/list')

      // delete_record has destructiveHint: true in the test server → should be denied
      const { body } = await sendMcpRequest(proxy.url, 'tools/call', {
        name: 'delete_record',
        arguments: { id: 'rec-42' },
      })
      const error = body['error'] as { code: number; data: Record<string, unknown> }
      expect(error.code).toBe(-32001)
      expect(error.data['blocked']).toBe(true)

      // get_weather has readOnlyHint: true (no destructiveHint) in the test server
      // MCP default for destructiveHint is true, so it will also match unless
      // the server explicitly sets destructiveHint: false
      // The test server only sets readOnlyHint: true, so destructiveHint defaults to true
      // This means get_weather is ALSO blocked — which is correct per MCP spec behavior
    } finally {
      await proxy.close()
    }
  })
})

// ---------------------------------------------------------------------------
// Audit response capture integration tests
// ---------------------------------------------------------------------------

describe('Audit response capture (Streamable HTTP)', () => {
  let upstream: { port: number; close: () => Promise<void> }

  beforeAll(async () => {
    upstream = await startHttpMcpServer()
  })

  afterAll(async () => {
    await upstream.close()
  })

  function createGovernedProxyWithAudit(
    policiesConfig: {
      default?: 'allow' | 'deny'
      rules: Array<Record<string, unknown>>
    },
    includeResponses = true,
    upstreamUrl = `http://127.0.0.1:${String(upstream.port)}/mcp`,
  ) {
    const config = makeConfig({
      upstream: {
        url: upstreamUrl,
        transport: 'streamable-http',
      },
      policies: policiesConfig as ReturnType<typeof makeConfig>['policies'],
    })
    const rawForwarder = new UpstreamForwarder({ url: config.upstream.url })
    const { policy } = compilePolicies(config.policies)

    const auditStore = new AuditStore({
      path: ':memory:',
      retention: '90d',
      includeResponses,
      cleanupIntervalMs: 0,
    })
    const auditWriter = new AuditWriter({ store: auditStore, flushIntervalMs: 0 })

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
    }
  }

  it('allowed call stores full upstream response when include_responses is true', async () => {
    const proxy = createGovernedProxyWithAudit({ default: 'allow', rules: [] }, true)

    try {
      await sendMcpRequest(proxy.url, 'tools/call', {
        name: 'get_weather',
        arguments: { city: 'London' },
      })

      proxy.auditWriter.flush()
      const { records } = proxy.auditStore.list()
      expect(records).toHaveLength(1)

      expect(records[0]).toBeDefined()
      expect(records[0]?.policy_decision).toBe('allow')
      expect(records[0]?.upstream_http_status).toBe(200)
      expect(records[0]?.upstream_latency_ms).toBeGreaterThan(0)

      // Full response body is stored
      const response = records[0]?.upstream_response as Record<string, unknown>
      expect(response['jsonrpc']).toBe('2.0')
      expect(response['result']).toBeDefined()
    } finally {
      await proxy.close()
    }
  })

  it('allowed call stores response summary when include_responses is false', async () => {
    const proxy = createGovernedProxyWithAudit({ default: 'allow', rules: [] }, false)

    try {
      await sendMcpRequest(proxy.url, 'tools/call', {
        name: 'get_weather',
        arguments: { city: 'London' },
      })

      proxy.auditWriter.flush()
      const { records } = proxy.auditStore.list()
      expect(records).toHaveLength(1)

      expect(records[0]).toBeDefined()
      expect(records[0]?.upstream_http_status).toBe(200)
      expect(records[0]?.upstream_latency_ms).toBeGreaterThan(0)

      // Summary is stored, not the full body
      const summary = records[0]?.upstream_response as Record<string, unknown>
      expect(summary['success']).toBe(true)
      expect(summary['has_error']).toBe(false)
      expect(summary['content_types']).toEqual(['text'])
      expect(summary['content_count']).toBe(1)
      // Full body fields should NOT be present
      expect(summary['jsonrpc']).toBeUndefined()
      expect(summary['result']).toBeUndefined()
    } finally {
      await proxy.close()
    }
  })

  it('denied call stores null upstream_response regardless of flag', async () => {
    const proxy = createGovernedProxyWithAudit({
      default: 'allow',
      rules: [{ match: { tool: 'delete_*' }, action: 'deny' }],
    })

    try {
      await sendMcpRequest(proxy.url, 'tools/call', {
        name: 'delete_record',
        arguments: { id: 'rec-42' },
      })

      proxy.auditWriter.flush()
      const { records } = proxy.auditStore.list()
      expect(records).toHaveLength(1)

      expect(records[0]).toBeDefined()
      expect(records[0]?.policy_decision).toBe('deny')
      expect(records[0]?.upstream_response).toBeNull()
      expect(records[0]?.upstream_http_status).toBeNull()
      expect(records[0]?.upstream_latency_ms).toBeNull()
    } finally {
      await proxy.close()
    }
  })

  it('audit record captures full metadata end-to-end', async () => {
    const proxy = createGovernedProxyWithAudit({ default: 'allow', rules: [] })

    try {
      await sendMcpRequest(
        proxy.url,
        'tools/call',
        { name: 'get_weather', arguments: { city: 'Paris' } },
        1,
        { sessionId: 'session-e2e-123' },
      )

      proxy.auditWriter.flush()
      const { records } = proxy.auditStore.list()
      expect(records).toHaveLength(1)

      expect(records[0]).toBeDefined()
      expect(records[0]?.tool_name).toBe('get_weather')
      expect(records[0]?.tool_input).toEqual({ city: 'Paris' })
      expect(records[0]?.session_id).toBe('session-e2e-123')
      expect(records[0]?.policy_decision).toBe('allow')
      expect(records[0]?.total_duration_ms).toBeGreaterThan(0)
      expect(records[0]?.proxy_compute_ms).toBeGreaterThanOrEqual(0)
      expect(records[0]?.approval_wait_ms).toBe(0)
      expect(records[0]?.upstream_http_status).toBe(200)
      expect(records[0]?.upstream_latency_ms).toBeGreaterThan(0)
      expect(records[0]?.dry_run).toBe(false)
      expect(records[0]?.upstream_response).not.toBeNull()
    } finally {
      await proxy.close()
    }
  })

  it('wrapped upstream failure stores upstream_http_status and raw body in audit', async () => {
    const upstreamApp = new Hono()
    upstreamApp.post('/mcp', () => {
      return new Response('upstream failed', {
        status: 500,
        headers: { 'content-type': 'text/plain' },
      })
    })
    const malformedUpstream = startOnDynamicPort(upstreamApp)
    const proxy = createGovernedProxyWithAudit(
      { default: 'allow', rules: [] },
      true,
      `http://127.0.0.1:${String(malformedUpstream.port)}/mcp`,
    )

    try {
      await sendMcpRequest(proxy.url, 'tools/call', {
        name: 'get_weather',
        arguments: { city: 'London' },
      })

      proxy.auditWriter.flush()
      const { records } = proxy.auditStore.list()
      expect(records).toHaveLength(1)
      expect(records[0]?.upstream_http_status).toBe(500)
      expect(records[0]?.upstream_response).toBe('upstream failed')
      expect(records[0]?.upstream_latency_ms).toBeGreaterThan(0)
    } finally {
      await proxy.close()
      await malformedUpstream.close()
    }
  })

  it('connection-level forwarding failure writes audit row with null upstream_http_status', async () => {
    const proxy = createGovernedProxyWithAudit(
      { default: 'allow', rules: [] },
      true,
      'http://127.0.0.1:19999/mcp',
    )

    try {
      const { status, body } = await sendMcpRequest(proxy.url, 'tools/call', {
        name: 'get_weather',
        arguments: { city: 'London' },
      })
      expect(status).toBe(200)
      const error = body['error'] as Record<string, unknown>
      const data = error['data'] as Record<string, unknown>
      expect(data['failure_class']).toBe('upstream_forward_error')

      proxy.auditWriter.flush()
      const { records } = proxy.auditStore.list()
      expect(records).toHaveLength(1)
      expect(records[0]?.upstream_http_status).toBeNull()
      expect(records[0]?.upstream_response).toBeNull()
      expect(records[0]?.upstream_latency_ms).toBeNull()
      expect(records[0]?.upstream_error).toBeTypeOf('string')
      expect(records[0]?.upstream_error).toMatch(/fetch failed|timed out|ECONNREFUSED/i)
    } finally {
      await proxy.close()
    }
  })
})
