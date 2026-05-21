/**
 * Start script for the basic example.
 *
 * Spawns the shared MCP echo server, waits for it to be ready,
 * then starts the Helio proxy with the local helio.yaml config.
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { registerCleanup, waitForHealthcheck } from '../_shared/start-helpers.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const echoServer = resolve(__dirname, '..', '_shared', 'mcp-echo-server.mjs')
const proxyCli = resolve(__dirname, '..', '..', 'packages', 'proxy', 'dist', 'cli.js')
const config = resolve(__dirname, 'helio.yaml')

const children = []
const state = { exitCode: 0 }
const cleanup = registerCleanup(children, state)

// Start the echo server
const echo = spawn('node', [echoServer], {
  stdio: 'inherit',
  env: { ...process.env, HOST: '127.0.0.1', PORT: '8080' },
})
children.push(echo)

echo.on('error', (err) => {
  console.error('Failed to start echo server:', err.message)
  process.exit(1)
})

// Wait for echo server to be ready
try {
  await waitForHealthcheck('http://127.0.0.1:8080/healthz')
} catch (err) {
  console.error(err.message)
  state.exitCode = 1
  cleanup()
}

// Start the Helio proxy
const proxy = spawn('node', [proxyCli, 'start', '-c', config], {
  stdio: 'inherit',
})
children.push(proxy)

proxy.on('error', (err) => {
  console.error('Failed to start proxy:', err.message)
  state.exitCode = 1
  cleanup()
})

proxy.on('exit', (code) => {
  if (code !== 0) {
    console.error(`Proxy exited with code ${code}`)
    state.exitCode = code
  }
  cleanup()
})

// Wait for proxy to be ready
try {
  await waitForHealthcheck('http://127.0.0.1:3100/api/health')
} catch (err) {
  console.error('Failed to connect to proxy:', err.message)
  console.error('Hint: ensure the proxy is built (pnpm build from repo root)')
  state.exitCode = 1
  cleanup()
}

console.log(`
─────────────────────────────────────────
  Helio Basic Example
─────────────────────────────────────────

  Dashboard:  http://localhost:3100
  Proxy:      http://localhost:3000/mcp

  Try these commands:

  # List available tools
  curl -s -X POST http://localhost:3000/mcp \\
    -H 'Content-Type: application/json' \\
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq

  # Call a read-only tool (allowed)
  curl -s -X POST http://localhost:3000/mcp \\
    -H 'Content-Type: application/json' \\
    -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_weather","arguments":{"city":"London"}}}' | jq

  # Call a destructive tool (denied)
  curl -s -X POST http://localhost:3000/mcp \\
    -H 'Content-Type: application/json' \\
    -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"delete_record","arguments":{"id":"123"}}}' | jq

─────────────────────────────────────────
`)
