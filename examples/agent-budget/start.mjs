/**
 * Start script for the agent-budget example.
 *
 * Spawns three shared MCP echo servers, one per named upstream, each
 * with its own tool set, waits for all three to be ready, then starts
 * the Helio proxy with the local helio.yaml config.
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { registerCleanup, waitForHealthcheck } from '../_shared/start-helpers.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const echoServer = resolve(__dirname, '..', '_shared', 'mcp-echo-server.mjs')
const proxyCli = resolve(__dirname, '..', '..', 'packages', 'proxy', 'dist', 'cli.js')
const config = resolve(__dirname, 'helio.yaml')

if (!process.env.HELIO_DASHBOARD_SECRET) {
  console.error('HELIO_DASHBOARD_SECRET is not set.')
  console.error('Copy .env.example to .env, fill it in, then load it:')
  console.error('  set -a; . ./.env; set +a; pnpm start')
  process.exit(1)
}

const children = []
const state = { exitCode: 0 }
const cleanup = registerCleanup(children, state)

// One echo server per door, each listing its own tool set
const doors = [
  { name: 'compute', port: '8080' },
  { name: 'market-data', port: '8081' },
  { name: 'tools', port: '8082' },
]
for (const door of doors) {
  const echo = spawn('node', [echoServer], {
    stdio: 'inherit',
    env: { ...process.env, HOST: '127.0.0.1', PORT: door.port, TOOLSET: door.name },
  })
  children.push(echo)

  echo.on('error', (err) => {
    console.error(`Failed to start echo server on port ${door.port}:`, err.message)
    process.exit(1)
  })
}

// Wait for all three echo servers to be ready
try {
  for (const door of doors) {
    await waitForHealthcheck(`http://127.0.0.1:${door.port}/healthz`)
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

// Wait for the proxy to be ready, then prime every door
try {
  await waitForHealthcheck('http://127.0.0.1:3100/api/health')
  for (const door of doors) {
    await fetch(`http://127.0.0.1:3000/mcp/${door.name}`, {
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
  Helio Agent Budget Example
─────────────────────────────────────────

  Dashboard:         http://localhost:3100  (log in with HELIO_DASHBOARD_SECRET)
  Compute door:      http://localhost:3000/mcp/compute
  Market-data door:  http://localhost:3000/mcp/market-data
  Tools door:        http://localhost:3000/mcp/tools

  One $50 pot, coding-agent-run, drawn down by all three doors.
  Every call needs both headers: the door answers 415 without the
  Content-Type, and a call without the session id charges nothing.

  curl -s -X POST http://localhost:3000/mcp/compute \\
    -H 'Content-Type: application/json' \\
    -H 'x-helio-session-id: coding-agent-run' \\
    -d @demo/calls/top-up-compute.json | jq

  # See README.md for the full walkthrough: four allowed calls, the
  # held overage, the approved overage in the ledger, the restart.

─────────────────────────────────────────
`)
