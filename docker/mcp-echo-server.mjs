/**
 * Minimal MCP echo server for Docker Compose demo.
 *
 * Returns valid JSON-RPC responses for tools/list and tools/call
 * with a realistic mix of tool annotations (read-only, destructive,
 * payment) so the Helio policy engine has something meaningful to
 * evaluate.
 *
 * No dependencies — just node:http.
 */

import { createServer } from 'node:http'

const PORT = Number(process.env.PORT ?? 8080)
const HOST = process.env.HOST ?? '0.0.0.0'

const TOOLS = [
  {
    name: 'get_weather',
    description: 'Get the current weather for a city',
    inputSchema: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: 'send_email',
    description: 'Send an email to a recipient',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['to', 'body'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: 'delete_record',
    description: 'Permanently delete a record by ID',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: 'stripe_charge',
    description: 'Charge a customer card via Stripe',
    inputSchema: {
      type: 'object',
      properties: {
        amount: { type: 'number', description: 'Charge amount in dollars' },
        currency: { type: 'string', description: 'Currency code (e.g. USD)' },
        customer: { type: 'string', description: 'Customer identifier' },
      },
      required: ['amount'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: 'paypal_payout',
    description: 'Send a PayPal payout to a recipient',
    inputSchema: {
      type: 'object',
      properties: {
        total: { type: 'number', description: 'Payout total in dollars' },
        recipient: { type: 'string', description: 'Payout recipient' },
      },
      required: ['total'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
]

const TOOL_RESPONSES = {
  get_weather: (args) => `Sunny, 22°C in ${args?.city ?? 'unknown'}`,
  send_email: (args) => `Email sent to ${args?.to ?? 'unknown'}`,
  delete_record: (args) => `Record ${args?.id ?? 'unknown'} deleted`,
  stripe_charge: (args) =>
    `Charged ${args?.amount ?? 0} ${args?.currency ?? 'USD'} to customer ${args?.customer ?? 'unknown'} via Stripe`,
  paypal_payout: (args) =>
    `PayPal payout of ${args?.total ?? 0} sent to ${args?.recipient ?? 'unknown'}`,
}

function handleJsonRpc(request) {
  const { method, params, id } = request

  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: TOOLS } }
  }

  if (method === 'tools/call') {
    const toolName = params?.name
    const handler = TOOL_RESPONSES[toolName]
    if (!handler) {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32602, message: `Unknown tool: ${toolName}` },
      }
    }
    return {
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: handler(params?.arguments) }],
      },
    }
  }

  // All other methods — return empty success
  return { jsonrpc: '2.0', id, result: {} }
}

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok' }))
    return
  }

  if (req.method === 'POST' && req.url === '/mcp') {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'))
        const response = handleJsonRpc(body)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(response))
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32700, message: 'Parse error' },
          }),
        )
      }
    })
    return
  }

  res.writeHead(404)
  res.end()
})

server.listen(PORT, HOST, () => {
  console.log(`MCP echo server listening on http://${HOST}:${PORT}`)
})
