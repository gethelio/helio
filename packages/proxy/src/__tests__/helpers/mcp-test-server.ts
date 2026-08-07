import { createServer } from 'node:http'
import type { IncomingHttpHeaders, Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'

/**
 * Register the standard set of test tools, resources, and prompts on an McpServer.
 *
 * Tools:
 *  - get_weather (readOnlyHint: true, destructiveHint: false)
 *  - send_email (readOnlyHint: false, destructiveHint: false)
 *  - create_payment (readOnlyHint: false, destructiveHint: false)
 *  - delete_record (destructiveHint: true)
 *  - lookup_order (readOnlyHint: true, destructiveHint: false)
 *  - transfer_funds (readOnlyHint: false, destructiveHint: false)
 *
 * Resources:
 *  - status://server
 *
 * Prompts:
 *  - summarize
 */
export function registerTestCapabilities(server: McpServer): void {
  server.registerTool(
    'get_weather',
    {
      description: 'Get the current weather for a city',
      inputSchema: { city: z.string() },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    ({ city }) => ({
      content: [{ type: 'text', text: `Sunny, 22°C in ${city}` }],
    }),
  )

  server.registerTool(
    'send_email',
    {
      description: 'Send an email to a recipient',
      inputSchema: { to: z.string(), body: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    ({ to }) => ({
      content: [{ type: 'text', text: `Email sent to ${to}` }],
    }),
  )

  server.registerTool(
    'create_payment',
    {
      description: 'Create a payment',
      inputSchema: { amount: z.number(), currency: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    ({ amount, currency }) => ({
      content: [{ type: 'text', text: `Payment of ${String(amount)} ${currency} created` }],
    }),
  )

  server.registerTool(
    'delete_record',
    {
      description: 'Delete a record by ID',
      inputSchema: { id: z.string() },
      annotations: { destructiveHint: true },
    },
    ({ id }) => ({
      content: [{ type: 'text', text: `Record ${id} deleted` }],
    }),
  )

  server.registerTool(
    'lookup_order',
    {
      description: 'Look up an order by ID',
      inputSchema: { order_id: z.string() },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    ({ order_id }) => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ orderId: order_id, total: 99.99, status: 'shipped' }),
        },
      ],
    }),
  )

  server.registerTool(
    'transfer_funds',
    {
      description: 'Transfer funds to an account',
      inputSchema: {
        amount: z.number(),
        currency: z.string(),
        to_account: z.string(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    ({ amount, currency, to_account }) => ({
      content: [
        {
          type: 'text',
          text: `Transfer of ${String(amount)} ${currency} to ${to_account} completed`,
        },
      ],
    }),
  )

  server.registerResource(
    'server-status',
    'status://server',
    {
      description: 'Current server status',
      mimeType: 'text/plain',
    },
    (uri) => ({
      contents: [{ uri: uri.href, text: 'Helio test server is running' }],
    }),
  )

  server.registerPrompt(
    'summarize',
    {
      description: 'Summarize the given text',
      argsSchema: { text: z.string() },
    },
    ({ text }) => ({
      messages: [{ role: 'user', content: { type: 'text', text: `Please summarize: ${text}` } }],
    }),
  )
}

/** Create a configured McpServer (not yet connected to any transport). */
export function createMcpTestServer(): McpServer {
  const server = new McpServer({
    name: 'helio-test-server',
    version: '1.0.0',
  })
  registerTestCapabilities(server)
  return server
}

/**
 * Start a real MCP server over Streamable HTTP on a dynamic port.
 * Each incoming request gets its own McpServer + transport (stateless mode).
 */
export async function startHttpMcpServer(): Promise<{
  port: number
  close: () => Promise<void>
}> {
  const httpServer = createServer((req, res) => {
    // Only handle POST /mcp
    if (req.method === 'POST' && req.url === '/mcp') {
      void (async () => {
        // Read the body
        const chunks: Buffer[] = []
        for await (const chunk of req) {
          chunks.push(chunk as Buffer)
        }
        const bodyText = Buffer.concat(chunks).toString('utf-8')
        let parsedBody: unknown
        try {
          parsedBody = JSON.parse(bodyText)
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(
            JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } }),
          )
          return
        }

        // Create a fresh server + transport for each request (stateless)
        const server = createMcpTestServer()
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined, // stateless
          enableJsonResponse: true,
        })

        await server.connect(transport)
        await transport.handleRequest(req, res, parsedBody)
      })()
      return
    }

    res.writeHead(404)
    res.end()
  })

  return new Promise((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => {
      const port = (httpServer.address() as AddressInfo).port
      resolve({
        port,
        close: () => closeHttpServer(httpServer),
      })
    })
  })
}

/**
 * Start a session-enforcing MCP server over Streamable HTTP that replies with
 * `text/event-stream` — i.e. the FastMCP-class shape that the stateless stub
 * could not reproduce. Sessionless, pre-initialize requests get HTTP 400.
 */
export async function startSessionEnforcingHttpMcpServer(): Promise<{
  port: number
  close: () => Promise<void>
}> {
  const transports = new Map<string, StreamableHTTPServerTransport>()

  const httpServer = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/mcp') {
      res.writeHead(404)
      res.end()
      return
    }
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      let parsedBody: unknown
      try {
        parsedBody = JSON.parse(Buffer.concat(chunks).toString('utf-8'))
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } }))
        return
      }

      const sessionId = req.headers['mcp-session-id'] as string | undefined
      let transport = sessionId ? transports.get(sessionId) : undefined

      if (!transport) {
        const isInit =
          typeof parsedBody === 'object' &&
          parsedBody !== null &&
          (parsedBody as { method?: string }).method === 'initialize'
        if (!isInit) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              error: { code: -32000, message: 'Bad Request: no valid session' },
            }),
          )
          return
        }
        const newTransport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: false, // reply with text/event-stream
          onsessioninitialized: (sid: string) => {
            transports.set(sid, newTransport)
          },
        })
        transport = newTransport
        const server = createMcpTestServer()
        await server.connect(transport)
      }

      await transport.handleRequest(req, res, parsedBody)
    })()
  })

  return new Promise((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => {
      const port = (httpServer.address() as AddressInfo).port
      resolve({ port, close: () => closeHttpServer(httpServer) })
    })
  })
}

/** The only MCP revision {@link startModernOnlyHttpMcpServer} speaks. */
const MODERN_ONLY_PROTOCOL_VERSION = '2026-07-28'
/** JSON-RPC error code a 2026-07-28 server uses for a header/`_meta` mismatch. */
const MCP_HEADER_MISMATCH_CODE = -32020
/** `_meta` key a modern client mirrors its negotiated protocol version under. */
const MODERN_META_PROTOCOL_VERSION_KEY = 'io.modelcontextprotocol/protocolVersion'

/** A running modern-only MCP fixture, with a setter for its `tools/list` set. */
export interface ModernOnlyMcpServer {
  port: number
  close: () => Promise<void>
  /** Replace the tools/list definition set — drift tests mutate a tool this way. */
  setTools: (tools: readonly Record<string, unknown>[]) => void
}

/**
 * Start a hand-rolled, JSON-only MCP fixture that speaks ONLY the 2026-07-28
 * revision (issues #216/#221 repro): no `initialize`/`notifications/initialized`
 * handshake, and it never mints or echoes `mcp-session-id`.
 *
 * Strictness is SCOPED, not blanket, so the proxy's still-legacy-shaped
 * downstream relays keep working against this fixture:
 *  - `server/discover` unconditionally REQUIRES the modern
 *    `mcp-protocol-version`/`mcp-method` headers and a matching
 *    `params._meta['io.modelcontextprotocol/protocolVersion']` mirror.
 *  - Any OTHER request that carries an `mcp-method` header (today, only
 *    Helio's own internal sends do) gets that same full validation, keyed off
 *    the header's own method name — this is what proves Helio's internal path
 *    conforms.
 *  - Requests with no `mcp-method` header — the proxy's downstream-driven
 *    relays, which do not yet stamp modern headers/version (#217/#219) — are
 *    served leniently. This leg is interim: once #217/#219 land, their own
 *    tests tighten relay conformance and this fixture's lenient leg can be
 *    retired.
 * Any validation failure answers `400` + JSON-RPC `-32020`.
 *
 * Deliberately a JSON-only responder (no `text/event-stream` framing) — SSE
 * probe/response coverage for the era detector lives in
 * `upstream-session-manager.test.ts`.
 *
 * `initialize` and any other unrecognized method answer `404` + JSON-RPC
 * `-32601`, per the 2026-07-28 removal of the handshake.
 */
export async function startModernOnlyHttpMcpServer(): Promise<ModernOnlyMcpServer> {
  let tools: Record<string, unknown>[] = [
    {
      name: 'get_status',
      description: 'Report the current server status',
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
  ]

  const httpServer = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/mcp') {
      res.writeHead(404)
      res.end()
      return
    }
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      let parsed: unknown
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8'))
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } }))
        return
      }
      if (typeof parsed !== 'object' || parsed === null) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } }))
        return
      }
      const body = parsed as Record<string, unknown>
      const id = (body['id'] ?? null) as string | number | null
      const method = typeof body['method'] === 'string' ? body['method'] : undefined

      const respond = (status: number, payload: Record<string, unknown>): void => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
      }
      const respondModernMismatch = (reason: string): void => {
        respond(400, {
          jsonrpc: '2.0',
          id,
          error: { code: MCP_HEADER_MISMATCH_CODE, message: reason },
        })
      }

      if (method === 'server/discover') {
        const mismatch = validateModernRequest(req.headers, body, 'server/discover')
        if (mismatch) {
          respondModernMismatch(mismatch)
          return
        }
        respond(200, {
          jsonrpc: '2.0',
          id,
          result: {
            resultType: 'complete',
            supportedVersions: [MODERN_ONLY_PROTOCOL_VERSION],
            capabilities: { tools: {} },
            ttlMs: 3_600_000,
            cacheScope: 'public',
          },
        })
        return
      }

      // Scoped strictness (see docstring): only a request that itself carries
      // an `mcp-method` header — today, only Helio's internal sends — is held
      // to the full modern conformance check. Header-less relays fall through
      // untouched.
      if (typeof req.headers['mcp-method'] === 'string') {
        const mismatch = validateModernRequest(req.headers, body, method ?? '')
        if (mismatch) {
          respondModernMismatch(mismatch)
          return
        }
      }

      if (method === 'tools/list') {
        respond(200, {
          jsonrpc: '2.0',
          id,
          result: { tools, resultType: 'complete', ttlMs: 3_600_000, cacheScope: 'public' },
        })
        return
      }

      if (method === 'tools/call') {
        const params = body['params']
        const toolName =
          typeof params === 'object' && params !== null
            ? (params as Record<string, unknown>)['name']
            : undefined
        respond(200, {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: `${String(toolName)} executed` }] },
        })
        return
      }

      // `initialize` and any other unrecognized method: the 2026-07-28
      // revision removed the handshake outright.
      respond(404, {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${String(method)}` },
      })
    })()
  })

  return new Promise((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => {
      const port = (httpServer.address() as AddressInfo).port
      resolve({
        port,
        close: () => closeHttpServer(httpServer),
        setTools: (next) => {
          tools = next.map((tool) => ({ ...tool }))
        },
      })
    })
  })
}

/**
 * Full modern-conformance check for one request: the `mcp-protocol-version`
 * header, the `params._meta` protocol version mirror, and (for the
 * `mcp-method`-bearing branch) the header matching the JSON-RPC body method.
 * Returns a failure reason, or undefined when everything matches.
 */
function validateModernRequest(
  headers: IncomingHttpHeaders,
  body: Record<string, unknown>,
  expectedMethod: string,
): string | undefined {
  if (headers['mcp-protocol-version'] !== MODERN_ONLY_PROTOCOL_VERSION) {
    return `missing or mismatched mcp-protocol-version header (expected ${MODERN_ONLY_PROTOCOL_VERSION})`
  }
  const params = body['params']
  const meta =
    typeof params === 'object' && params !== null
      ? (params as Record<string, unknown>)['_meta']
      : undefined
  const metaProtocolVersion =
    typeof meta === 'object' && meta !== null
      ? (meta as Record<string, unknown>)[MODERN_META_PROTOCOL_VERSION_KEY]
      : undefined
  if (metaProtocolVersion !== MODERN_ONLY_PROTOCOL_VERSION) {
    return `missing or mismatched params._meta["${MODERN_META_PROTOCOL_VERSION_KEY}"] mirror`
  }
  if (headers['mcp-method'] !== expectedMethod) {
    return `mcp-method header (${String(headers['mcp-method'])}) does not match request method (${expectedMethod})`
  }
  return undefined
}

function closeHttpServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err)
      else resolve()
    })
    // Release any keep-alive sockets held by fetch connection pools so
    // close() does not block on idle connections.
    server.closeIdleConnections()
  })
}
