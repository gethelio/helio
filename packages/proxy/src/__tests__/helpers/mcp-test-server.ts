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

/** A single POST the fixture received, captured for wire-level assertions. */
interface ReceivedRequest {
  readonly method: string
  readonly headers: Record<string, string | string[] | undefined>
}

/** A running modern-only MCP fixture, with a setter for its `tools/list` set. */
export interface ModernOnlyMcpServer {
  port: number
  close: () => Promise<void>
  /** Replace the tools/list definition set — drift tests mutate a tool this way. */
  setTools: (tools: readonly Record<string, unknown>[]) => void
  /** Every POST received so far, in arrival order — lets tests assert the raw wire header values a relay actually sent. */
  receivedRequests: readonly ReceivedRequest[]
}

/**
 * Start a hand-rolled, JSON-only MCP fixture that speaks ONLY the 2026-07-28
 * revision (issues #216/#221 repro): no `initialize`/`notifications/initialized`
 * handshake, and it never mints or echoes `mcp-session-id`.
 *
 * EVERY POST — probe, internal, relayed — is held to the full modern
 * conformance check unconditionally: the `mcp-method`/`mcp-name` header↔body
 * agreement (see {@link validateMirroredStandardHeaders}, sentinel decode
 * included), the `mcp-protocol-version` header, and a matching
 * `params._meta['io.modelcontextprotocol/protocolVersion']` mirror. The old
 * claims-2026-07-28 leniency for legacy-versioned relays is retired: relay
 * version negotiation (#219) made the relay leg era-aware, so everything
 * Helio sends a modern upstream now carries both halves, and a stamping
 * drop on any path must fail loudly instead of falling through unnoticed.
 * Any validation failure answers `400` + JSON-RPC `-32020`.
 *
 * Deliberately a JSON-only responder (no `text/event-stream` framing) — SSE
 * probe/response coverage for the era detector lives in
 * `upstream-session-manager.test.ts`.
 *
 * Once the conformance check passes, `initialize` and any other
 * unrecognized method answer `404` + JSON-RPC `-32601`, per the
 * 2026-07-28 removal of the handshake. A header-less `initialize` never
 * gets that far — it fails the conformance check first, with `400`
 * + JSON-RPC `-32020`.
 */
export async function startModernOnlyHttpMcpServer(): Promise<ModernOnlyMcpServer> {
  let tools: Record<string, unknown>[] = [
    {
      name: 'get_status',
      description: 'Report the current server status',
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    {
      name: 'Hello, 世界',
      description: 'Report status with a non-ASCII display name',
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
  ]
  const receivedRequests: ReceivedRequest[] = []

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
      receivedRequests.push({
        method: method ?? '<non-string-method>',
        headers: { ...req.headers },
      })

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
        const mismatch = validateModernRequest(req.headers, body)
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
            // Optional DiscoverResult field (2026-07-28 schema): exercises
            // the probe capture that the relay initialize synthesis reuses.
            instructions: 'Call get_status before anything else.',
            ttlMs: 3_600_000,
            cacheScope: 'public',
          },
        })
        return
      }

      // Every POST — internal or relayed — is held to the FULL modern
      // conformance check unconditionally (see docstring): #217 retired the
      // header-less lenient leg, and #219's era-aware relay leg retired the
      // remaining version/`_meta` leniency for legacy-versioned relays.
      const mismatch = validateModernRequest(req.headers, body)
      if (mismatch) {
        respondModernMismatch(mismatch)
        return
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
        receivedRequests,
      })
    })
  })
}

/** Matches the spec's `Mcp-Name` sentinel wrapper: `=?base64?<payload>?=`. */
const MCP_NAME_SENTINEL_PATTERN = /^=\?base64\?([A-Za-z0-9+/]*={0,2})\?=$/

/**
 * Decode a `Mcp-Name` header value if it is sentinel-wrapped (base64 over
 * UTF-8), otherwise return it unchanged. Implemented independently of
 * `packages/proxy/src/upstream/standard-headers.ts` on purpose — this
 * fixture is the other side of the wire agreement, so it must not validate
 * the encoder against itself.
 */
function decodeMcpNameSentinel(value: string): string {
  const match = MCP_NAME_SENTINEL_PATTERN.exec(value)
  return match ? Buffer.from(match[1] ?? '', 'base64').toString('utf8') : value
}

/** The name-bearing param field the spec's `Mcp-Name` header mirrors, per method. */
const NAME_BEARING_FIELD = new Map<string, 'name' | 'uri'>([
  ['tools/call', 'name'],
  ['prompts/get', 'name'],
  ['resources/read', 'uri'],
])

/**
 * Verify the standard-headers wire agreement (issue #217) for ANY POST,
 * internal or relayed alike: `mcp-method` must be PRESENT and equal the
 * body's `method` — absence is itself a failure, not a lenient pass-through,
 * so a total drop of relay stamping fails loudly rather than falling through
 * unnoticed. `mcp-name` must be PRESENT and (after sentinel-decoding, when
 * wrapped) byte-for-byte equal the body's name-bearing field on
 * `tools/call`/`prompts/get`/`resources/read`; on any other method a
 * PRESENT `mcp-name` is itself a failure ("unexpected mcp-name"), and its
 * absence is correct. Returns a failure reason, or undefined when everything
 * agrees.
 *
 * This is an OUTBOUND test double policing Helio's own stamping discipline,
 * deliberately STRICTER than the spec (the unexpected-mcp-name rule has no
 * spec MUST behind it). Helio's production inbound door is
 * `transport/header-body-agreement.ts` (issue #226), which does not copy
 * that rule and stays independent of this fixture on purpose.
 */
function validateMirroredStandardHeaders(
  headers: IncomingHttpHeaders,
  body: Record<string, unknown>,
): string | undefined {
  const bodyMethod = typeof body['method'] === 'string' ? body['method'] : undefined
  const headerMethod = headers['mcp-method']
  if (typeof headerMethod !== 'string' || headerMethod !== bodyMethod) {
    return `missing or mismatched mcp-method header (expected ${String(bodyMethod)}, got ${String(headerMethod)})`
  }

  const nameField = bodyMethod ? NAME_BEARING_FIELD.get(bodyMethod) : undefined
  const params = body['params']
  const rawField =
    nameField && typeof params === 'object' && params !== null
      ? (params as Record<string, unknown>)[nameField]
      : undefined
  const expectedName = typeof rawField === 'string' ? rawField : undefined

  const headerName = headers['mcp-name']
  if (expectedName === undefined) {
    return headerName === undefined
      ? undefined
      : `unexpected mcp-name header (${String(headerName)}) for a non-name-bearing request`
  }
  if (typeof headerName !== 'string') {
    return `missing mcp-name header (expected ${expectedName})`
  }
  const decoded = decodeMcpNameSentinel(headerName)
  if (decoded !== expectedName) {
    return `mismatched mcp-name header (expected ${expectedName}, got ${decoded})`
  }
  return undefined
}

/**
 * Full modern-conformance check for one request: the standard-headers
 * agreement (delegated to {@link validateMirroredStandardHeaders}), the
 * `mcp-protocol-version` header, and the `params._meta` protocol version
 * mirror. Returns a failure reason, or undefined when everything matches.
 */
function validateModernRequest(
  headers: IncomingHttpHeaders,
  body: Record<string, unknown>,
): string | undefined {
  const standardHeadersMismatch = validateMirroredStandardHeaders(headers, body)
  if (standardHeadersMismatch) return standardHeadersMismatch

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
