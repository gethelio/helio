import { createServer } from 'node:http'
import type { Server } from 'node:http'
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
