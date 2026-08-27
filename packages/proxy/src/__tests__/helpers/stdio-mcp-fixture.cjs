// Minimal MCP-speaking stdio child for multi-upstream CLI e2e tests.
//
// Speaks newline-delimited JSON-RPC on stdin/stdout (the StdioForwarder
// framing — NOT LSP Content-Length). Answers `initialize` and `tools/list`
// immediately so annotation priming completes in milliseconds instead of
// eating the 1.5s startup window. The advertised tool is NAMED by argv so
// each entry's child is distinguishable end to end — a door's response can
// never be mistaken for another door's.
const toolName = process.argv[2] ?? 'fixture_ping'
const readline = require('readline')
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  let req
  try {
    req = JSON.parse(line)
  } catch {
    return
  }
  if (req.id === undefined || req.id === null) return
  let result
  if (req.method === 'initialize') {
    result = {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: `fixture-${toolName}`, version: '0.0.0' },
    }
  } else if (req.method === 'tools/list') {
    result = {
      tools: [{ name: toolName, description: 'e2e fixture tool', inputSchema: { type: 'object' } }],
    }
  } else {
    result = {}
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\n')
})
