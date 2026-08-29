/**
 * Start script for the multi-upstream example.
 *
 * Spawns two shared MCP echo servers (one per named upstream), waits
 * for both to be ready, then starts the Helio proxy with the local
 * helio.yaml config.
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

// Start one echo server per named upstream
const echoPorts = ['8080', '8081']
for (const port of echoPorts) {
  const echo = spawn('node', [echoServer], {
    stdio: 'inherit',
    env: { ...process.env, HOST: '127.0.0.1', PORT: port },
  })
  children.push(echo)

  echo.on('error', (err) => {
    console.error(`Failed to start echo server on port ${port}:`, err.message)
    process.exit(1)
  })
}

// Wait for both echo servers to be ready
try {
  for (const port of echoPorts) {
    await waitForHealthcheck(`http://127.0.0.1:${port}/healthz`)
  }
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

// Wait for proxy to be ready, then prime both doors
try {
  await waitForHealthcheck('http://127.0.0.1:3100/api/health')
  for (const door of ['files', 'payments']) {
    await fetch(`http://127.0.0.1:3000/mcp/${door}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/list' }),
    })
  }
} catch (err) {
  console.error('Failed to connect to proxy:', err.message)
  console.error('Hint: ensure the proxy is built (pnpm build from repo root)')
  state.exitCode = 1
  cleanup()
}

console.log(`
─────────────────────────────────────────
  Helio Multi-Upstream Example
─────────────────────────────────────────

  Dashboard:      http://localhost:3100
  Files door:     http://localhost:3000/mcp/files
  Payments door:  http://localhost:3000/mcp/payments

  Each named upstream has its own door — bare /mcp answers 404:

  curl -s -X POST http://localhost:3000/mcp \\
    -H 'Content-Type: application/json' \\
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

  # List tools through each door:
  curl -s -X POST http://localhost:3000/mcp/files \\
    -H 'Content-Type: application/json' \\
    -H 'x-helio-session-id: demo' \\
    -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | jq

  # See README.md for the scoped rate-limit and budget walkthrough.

─────────────────────────────────────────
`)
