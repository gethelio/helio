// ---------------------------------------------------------------------------
// The sample MCP upstream `helio init --demo` writes as `mcp-demo-server.mjs`
// (issue #397): one `node:http` process, no dependency, serving the corpus's
// ten tools with their annotations, five on `/crm` and five on `/billing`.
// It answers `initialize` with the legacy protocol revision, so every boot
// prints one `Upstream MCP era detected: legacy` line per door.
// ---------------------------------------------------------------------------

import { HELIO_MCP_LEGACY_PROTOCOL_VERSION } from '../mcp/protocol-version.js'
import { DEMO_TOOLS, DEMO_UPSTREAMS } from './corpus.js'
import type { DemoTool } from './corpus.js'

/** The tool as the wire lists it: no door name, no annotations key when the corpus has none. */
function wireTool(tool: DemoTool): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
  }
}

/** Render the upstream's source. The listening port is `PORT` (default 8080); `0` picks a free one. */
export function renderDemoUpstream(): string {
  const doors = {
    '/crm': DEMO_TOOLS.filter((tool) => tool.upstream === DEMO_UPSTREAMS.crm).map(wireTool),
    '/billing': DEMO_TOOLS.filter((tool) => tool.upstream === DEMO_UPSTREAMS.billing).map(wireTool),
  }
  return `// Helio demo upstream: sample tools, not your own. Written by helio init --demo.
// One process serves two doors: /crm and /billing, each with its own five
// tools. No dependencies, just node:http. PORT=0 picks a free port.
import { createServer } from 'node:http'

const PORT = Number(process.env.PORT ?? 8080)
const HOST = process.env.HOST ?? '127.0.0.1'

const DOORS = ${JSON.stringify(doors, null, 2)}

function toolsFor(url) {
  for (const [path, tools] of Object.entries(DOORS)) {
    if (url === path || url.startsWith(path + '/') || url.startsWith(path + '?')) return tools
  }
  return null
}

function answer(url, body) {
  const tools = toolsFor(url)
  if (tools === null) return null
  switch (body.method) {
    case 'initialize':
      return {
        protocolVersion: '${HELIO_MCP_LEGACY_PROTOCOL_VERSION}',
        capabilities: { tools: {} },
        serverInfo: { name: 'helio-demo-upstream', version: '1' },
      }
    case 'tools/list':
      return { tools }
    case 'tools/call': {
      const name = body.params && typeof body.params.name === 'string' ? body.params.name : '?'
      return { content: [{ type: 'text', text: name + ': ok (sample)' }] }
    }
    default:
      return {}
  }
}

const server = createServer((req, res) => {
  let raw = ''
  req.on('data', (chunk) => {
    raw += chunk
  })
  req.on('end', () => {
    let body = {}
    try {
      body = JSON.parse(raw)
    } catch {
      body = {}
    }
    const result = answer(req.url ?? '', body)
    if (result === null) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('no such door; the paths are /crm and /billing')
      return
    }
    if (body.id === undefined || body.id === null) {
      res.writeHead(202)
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }))
  })
})

server.listen(PORT, HOST, () => {
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : PORT
  console.error(
    'Helio demo upstream listening on http://' + HOST + ':' + String(port) + ' (doors: /crm and /billing)',
  )
})
`
}
