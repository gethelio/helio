/**
 * Start script for the named budgets example.
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

if (!process.env.HELIO_DASHBOARD_SECRET) {
  console.error('HELIO_DASHBOARD_SECRET is not set.')
  console.error('Copy .env.example to .env, fill it in, then load it:')
  console.error('  set -a; . ./.env; set +a; pnpm start')
  process.exit(1)
}

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

// Wait for proxy to be ready, then prime the annotation cache
try {
  await waitForHealthcheck('http://127.0.0.1:3100/api/health')
  await fetch('http://127.0.0.1:3000/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/list' }),
  })
} catch (err) {
  console.error('Failed to connect to proxy:', err.message)
  console.error('Hint: ensure the proxy is built (pnpm build from repo root)')
  state.exitCode = 1
  cleanup()
}

console.log(`
─────────────────────────────────────────
  Helio Named Budgets Example
─────────────────────────────────────────

  Dashboard:  http://localhost:3100  (log in with HELIO_DASHBOARD_SECRET)
  Proxy:      http://localhost:3000/mcp

  Open the dashboard Budgets tab, then deplete the pot:

  # Stripe charge: $20 (20/50 used)
  curl -s -X POST http://localhost:3000/mcp \\
    -H 'Content-Type: application/json' \\
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"stripe_charge","arguments":{"amount":20,"currency":"USD","customer":"cus_123"}}}' | jq

  # PayPal payout: $20 into the SAME pot (40/50 used)
  curl -s -X POST http://localhost:3000/mcp \\
    -H 'Content-Type: application/json' \\
    -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"paypal_payout","arguments":{"total":20,"recipient":"ops@example.com"}}}' | jq

  # Stripe charge: $20 (would exceed $50 — waits for break-glass approval)
  curl -s -X POST http://localhost:3000/mcp \\
    -H 'Content-Type: application/json' \\
    -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"stripe_charge","arguments":{"amount":20,"currency":"USD","customer":"cus_123"}}}' | jq

  # Approve the ticket in the dashboard Approvals tab, then check the
  # Budgets tab: the pot shows the approved overage in its ledger.

─────────────────────────────────────────
`)
