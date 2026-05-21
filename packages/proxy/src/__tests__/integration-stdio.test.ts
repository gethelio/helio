import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { createApp } from '../server.js'
import { StdioForwarder } from '../transport/stdio-wrapper.js'
import { startOnDynamicPort, makeConfig, sendMcpRequest } from './helpers/test-utils.js'
import type { ManagedServer } from './helpers/test-utils.js'

// ---------------------------------------------------------------------------
// Inline Node script that acts as a minimal MCP server over stdio.
// Handles: initialize, tools/list, tools/call, resources/list, prompts/list
// ---------------------------------------------------------------------------

const MCP_STDIO_SCRIPT = `
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });

const tools = [
  { name: 'get_weather', description: 'Get the current weather for a city' },
  { name: 'send_email', description: 'Send an email to a recipient' },
  { name: 'create_payment', description: 'Create a payment' },
  { name: 'delete_record', description: 'Delete a record by ID' },
];

function handleRequest(req) {
  switch (req.method) {
    case 'initialize':
      return {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'stdio-test-server', version: '1.0.0' },
      };
    case 'tools/list':
      return { tools };
    case 'tools/call': {
      const name = req.params && req.params.name;
      const args = req.params && req.params.arguments;
      if (name === 'get_weather') {
        return { content: [{ type: 'text', text: 'Sunny, 22°C in ' + args.city }] };
      }
      return { content: [{ type: 'text', text: 'Called ' + name }] };
    }
    case 'resources/list':
      return { resources: [{ uri: 'status://server', name: 'server-status' }] };
    case 'resources/read':
      return { contents: [{ uri: 'status://server', text: 'Stdio test server is running' }] };
    case 'prompts/list':
      return { prompts: [{ name: 'summarize' }] };
    case 'prompts/get':
      return { messages: [{ role: 'user', content: { type: 'text', text: 'Please summarize: ' + (req.params && req.params.arguments && req.params.arguments.text || 'unknown') } }] };
    default:
      return {};
  }
}

rl.on('line', (line) => {
  try {
    const req = JSON.parse(line);
    if (req.id !== undefined && req.id !== null) {
      const result = handleRequest(req);
      const res = { jsonrpc: '2.0', id: req.id, result };
      process.stdout.write(JSON.stringify(res) + '\\n');
    }
    // Notifications (no id) — silently ignore
  } catch {}
});
`

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Stdio integration', () => {
  let forwarder: StdioForwarder
  let proxy: ManagedServer
  let proxyUrl: string

  beforeAll(async () => {
    forwarder = new StdioForwarder({
      command: 'node',
      args: ['-e', MCP_STDIO_SCRIPT],
    })
    await forwarder.start()

    const config = makeConfig({
      upstream: {
        url: 'http://unused',
        transport: 'stdio',
      },
    })

    const app = createApp(config, forwarder)
    proxy = startOnDynamicPort(app)
    proxyUrl = `http://127.0.0.1:${String(proxy.port)}/mcp`
  })

  afterAll(async () => {
    await proxy.close()
    await forwarder.close()
  })

  it('tools/list through stdio proxy', async () => {
    const { status, body } = await sendMcpRequest(proxyUrl, 'tools/list')
    expect(status).toBe(200)

    const result = body['result'] as { tools: { name: string }[] }
    const names = result.tools.map((t) => t.name).sort()
    expect(names).toEqual(['create_payment', 'delete_record', 'get_weather', 'send_email'])
  })

  it('tools/call get_weather returns correct response', async () => {
    const { status, body } = await sendMcpRequest(proxyUrl, 'tools/call', {
      name: 'get_weather',
      arguments: { city: 'Tokyo' },
    })
    expect(status).toBe(200)

    const result = body['result'] as { content: { text: string }[] }
    expect(result.content[0]?.text).toBe('Sunny, 22°C in Tokyo')
  })

  it('multiple sequential requests succeed', async () => {
    for (let i = 1; i <= 3; i++) {
      const { status, body } = await sendMcpRequest(proxyUrl, 'tools/list', undefined, i)
      expect(status).toBe(200)
      expect(body['result']).toBeDefined()
    }
  })

  it('resources/list passes through', async () => {
    const { status, body } = await sendMcpRequest(proxyUrl, 'resources/list')
    expect(status).toBe(200)

    const result = body['result'] as { resources: { uri: string }[] }
    expect(result.resources).toHaveLength(1)
    expect(result.resources[0]?.uri).toBe('status://server')
  })

  it('prompts/list passes through', async () => {
    const { status, body } = await sendMcpRequest(proxyUrl, 'prompts/list')
    expect(status).toBe(200)

    const result = body['result'] as { prompts: { name: string }[] }
    expect(result.prompts).toHaveLength(1)
    expect(result.prompts[0]?.name).toBe('summarize')
  })

  it('notification does not hang', async () => {
    // Send a JSON-RPC notification (no id) — should return quickly
    const res = await fetch(proxyUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled' }),
    })
    // Notifications are fire-and-forget; proxy returns 202 or 200
    expect(res.status).toBeLessThan(300)
  })
})
