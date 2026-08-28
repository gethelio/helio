import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { createMultiApp } from '../server.js'
import { makeConfig, makeNamedConfig } from './helpers/test-utils.js'
import type { McpForwarder, McpRequest } from '../mcp/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A forwarder stand-in whose canned tools/list payload advertises a single
 * tool named after its door, so a response can never be mistaken for a
 * different door's (the routing assertions read the tool NAME).
 */
function stubForwarder(toolName: string): McpForwarder & { calls: McpRequest[] } {
  const calls: McpRequest[] = []
  return {
    calls,
    forward(req: McpRequest) {
      calls.push(req)
      return Promise.resolve({
        response: {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: {
            jsonrpc: '2.0' as const,
            id: req.id ?? 1,
            result: { tools: [{ name: toolName }] },
          },
        },
        durationMs: 0,
      })
    },
  }
}

const MCP_CATCH_ALL_MESSAGE =
  'No MCP endpoint answers this request: this Helio serves named upstreams at /mcp/<name>.'
const SSE_CATCH_ALL_MESSAGE =
  'No MCP endpoint answers this request: this Helio serves named upstreams at /sse/<name>.'

function postJson(app: Hono, path: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  })
}

const toolsList = (id: number) => ({ jsonrpc: '2.0', id, method: 'tools/list' })

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createMultiApp', () => {
  describe('guards', () => {
    it('throws on a singular config', () => {
      expect(() => createMultiApp(makeConfig(), { files: stubForwarder('files_ping') })).toThrow(
        'createMultiApp composes a named multi-upstream (upstreams:) config only. ' +
          'Singular configs are served by createApp.',
      )
    })

    it('throws when the forwarder record is missing a configured name', () => {
      expect(() =>
        createMultiApp(makeNamedConfig(['files', 'github']), {
          files: stubForwarder('files_ping'),
        }),
      ).toThrow(
        'createMultiApp forwarders must match the configured upstream names exactly — ' +
          'missing: [github], unexpected: [].',
      )
    })

    it('throws when the forwarder record carries an unconfigured name', () => {
      expect(() =>
        createMultiApp(makeNamedConfig(['files']), {
          files: stubForwarder('files_ping'),
          ghost: stubForwarder('ghost_ping'),
        }),
      ).toThrow(
        'createMultiApp forwarders must match the configured upstream names exactly — ' +
          'missing: [], unexpected: [ghost].',
      )
    })
  })

  describe('routing', () => {
    it('serves each door from its own forwarder, in mount order over catch-alls', async () => {
      const files = stubForwarder('files_ping')
      const github = stubForwarder('github_ping')
      const app = createMultiApp(makeNamedConfig(['files', 'github']), { files, github })

      const filesRes = await postJson(app, '/mcp/files', toolsList(1))
      expect(filesRes.status).toBe(200)
      const filesBody = (await filesRes.json()) as {
        result: { tools: Array<{ name: string }> }
      }
      expect(filesBody.result.tools[0]?.name).toBe('files_ping')

      const githubRes = await postJson(app, '/mcp/github', toolsList(2))
      expect(githubRes.status).toBe(200)
      const githubBody = (await githubRes.json()) as {
        result: { tools: Array<{ name: string }> }
      }
      expect(githubBody.result.tools[0]?.name).toBe('github_ping')

      // Door isolation: each stub saw exactly its own door's request.
      expect(files.calls).toHaveLength(1)
      expect(files.calls[0]?.id).toBe(1)
      expect(github.calls).toHaveLength(1)
      expect(github.calls[0]?.id).toBe(2)
    })

    it('keeps /healthz global', async () => {
      const app = createMultiApp(makeNamedConfig(['files']), {
        files: stubForwarder('files_ping'),
      })
      const res = await app.request('/healthz')
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ status: 'ok' })
    })

    it('mounts the Slack action app globally', async () => {
      const slackActionApp = new Hono()
      slackActionApp.post('/', (c) => c.json({ slack: true }))
      const app = createMultiApp(
        makeNamedConfig(['files']),
        { files: stubForwarder('files_ping') },
        { slackActionApp },
      )
      const res = await app.request('/slack/actions', { method: 'POST' })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ slack: true })
    })

    it('serves the SSE door with a mount-relative endpoint event (issue #294)', async () => {
      const files = stubForwarder('files_ping')
      const github = stubForwarder('github_ping')
      const app = createMultiApp(makeNamedConfig(['files', 'github']), { files, github })

      const sseRes = await app.request('/sse/files')
      expect(sseRes.status).toBe(200)
      expect(sseRes.headers.get('content-type')).toBe('text/event-stream')

      const reader = sseRes.body?.getReader() as ReadableStreamDefaultReader<Uint8Array>
      const chunk = await reader.read()
      reader.releaseLock()
      const text = new TextDecoder().decode(chunk.value)
      expect(text).toContain('event: endpoint')
      // The endpoint reference is RELATIVE (`?sessionId=…`), so a client at
      // /sse/files resolves it to /sse/files?sessionId=… by construction.
      const match = /data: (\S+)/.exec(text)
      const endpointRef = match?.[1] ?? ''
      expect(endpointRef.startsWith('?sessionId=')).toBe(true)

      const sessionId = endpointRef.slice('?sessionId='.length)
      const postRes = await postJson(app, `/sse/files?sessionId=${sessionId}`, toolsList(3))
      expect(postRes.status).toBe(202)
      expect(files.calls).toHaveLength(1)
      expect(files.calls[0]?.id).toBe(3)
      expect(github.calls).toHaveLength(0)
    })
  })

  describe('catch-alls', () => {
    const envelope = (message: string) => ({
      jsonrpc: '2.0',
      error: { code: -32600, message },
    })

    it.each([
      ['POST', '/mcp', 'bare prefix'],
      ['POST', '/mcp/ghost', 'unknown name'],
      ['POST', '/mcp/files/extra', 'extra segments'],
      ['DELETE', '/mcp/files', 'method miss on a valid door'],
    ])('%s %s (%s) gets the /mcp envelope', async (method, path) => {
      const app = createMultiApp(makeNamedConfig(['files']), {
        files: stubForwarder('files_ping'),
      })
      const res = await app.request(path, { method })
      expect(res.status).toBe(404)
      expect(res.headers.get('content-type')).toContain('application/json')
      const body = (await res.json()) as Record<string, unknown>
      expect(body).toEqual(envelope(MCP_CATCH_ALL_MESSAGE))
      expect('id' in body).toBe(false)
    })

    it.each([
      ['GET', '/sse', 'bare prefix'],
      ['GET', '/sse/ghost', 'unknown name'],
      ['POST', '/sse/files/extra', 'extra segments'],
    ])('%s %s (%s) gets the /sse envelope', async (method, path) => {
      const app = createMultiApp(makeNamedConfig(['files']), {
        files: stubForwarder('files_ping'),
      })
      const res = await app.request(path, { method })
      expect(res.status).toBe(404)
      expect(res.headers.get('content-type')).toContain('application/json')
      const body = (await res.json()) as Record<string, unknown>
      expect(body).toEqual(envelope(SSE_CATCH_ALL_MESSAGE))
      expect('id' in body).toBe(false)
    })

    it('omits the id even when the request body carries one (issue #294)', async () => {
      const app = createMultiApp(makeNamedConfig(['files']), {
        files: stubForwarder('files_ping'),
      })
      const res = await postJson(app, '/mcp/ghost', { jsonrpc: '2.0', id: 7, method: 'x' })
      expect(res.status).toBe(404)
      const body = (await res.json()) as Record<string, unknown>
      expect('id' in body).toBe(false)
      expect(body).toEqual(envelope(MCP_CATCH_ALL_MESSAGE))
    })

    it('never names a configured upstream in the envelope', async () => {
      const app = createMultiApp(makeNamedConfig(['zephyr-door']), {
        'zephyr-door': stubForwarder('zephyr_ping'),
      })
      for (const path of ['/mcp/nope', '/sse/nope']) {
        const res = await app.request(path, { method: 'POST' })
        expect(res.status).toBe(404)
        const text = await res.text()
        expect(text).not.toContain('zephyr-door')
      }
    })
  })
})
