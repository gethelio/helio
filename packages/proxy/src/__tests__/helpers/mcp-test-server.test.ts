import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { startHttpMcpServer } from './mcp-test-server.js'

describe('MCP test server', () => {
  let port: number
  let close: () => Promise<void>

  beforeAll(async () => {
    const server = await startHttpMcpServer()
    port = server.port
    close = server.close
  })

  afterAll(async () => {
    await close()
  })

  function send(method: string, params?: unknown, id: number = 1) {
    return fetch(`http://127.0.0.1:${String(port)}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    })
  }

  it('returns 6 tools from tools/list', async () => {
    const res = await send('tools/list')
    expect(res.status).toBe(200)
    const json = (await res.json()) as { result: { tools: { name: string }[] } }
    const names = json.result.tools.map((t) => t.name).sort()
    expect(names).toEqual([
      'create_payment',
      'delete_record',
      'get_weather',
      'lookup_order',
      'send_email',
      'transfer_funds',
    ])
  })

  it('calls get_weather and returns response', async () => {
    const res = await send('tools/call', { name: 'get_weather', arguments: { city: 'London' } })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { result: { content: { text: string }[] } }
    expect(json.result.content[0]?.text).toBe('Sunny, 22°C in London')
  })

  it('returns resources from resources/list', async () => {
    const res = await send('resources/list')
    expect(res.status).toBe(200)
    const json = (await res.json()) as { result: { resources: { uri: string }[] } }
    expect(json.result.resources).toHaveLength(1)
    expect(json.result.resources[0]?.uri).toBe('status://server')
  })

  it('returns prompts from prompts/list', async () => {
    const res = await send('prompts/list')
    expect(res.status).toBe(200)
    const json = (await res.json()) as { result: { prompts: { name: string }[] } }
    expect(json.result.prompts).toHaveLength(1)
    expect(json.result.prompts[0]?.name).toBe('summarize')
  })
})
