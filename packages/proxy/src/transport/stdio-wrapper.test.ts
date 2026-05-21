import { describe, it, expect, afterEach } from 'vitest'
import { StdioForwarder } from './stdio-wrapper.js'
import type { McpRequest } from '../mcp/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Inline Node script that echoes JSON-RPC requests back as responses.
 * Reads stdin line-by-line, parses JSON, and writes a JSON-RPC response
 * with the method name as the result.
 */
const ECHO_SCRIPT = `
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    try {
      const req = JSON.parse(line);
      if (req.id !== undefined && req.id !== null) {
        const res = { jsonrpc: '2.0', id: req.id, result: { method: req.method } };
        process.stdout.write(JSON.stringify(res) + '\\n');
      }
    } catch {}
  });
`

/** Script that exits immediately with code 1. */
const CRASH_SCRIPT = 'process.exit(1);'

function makeRequest(id: number, method: string): McpRequest {
  return { jsonrpc: '2.0', id, method }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StdioForwarder', () => {
  let forwarder: StdioForwarder | null = null

  afterEach(async () => {
    if (forwarder) {
      await forwarder.close()
      forwarder = null
    }
  })

  it('forwards a request and receives a response', async () => {
    forwarder = new StdioForwarder({ command: 'node', args: ['-e', ECHO_SCRIPT] })
    await forwarder.start()

    const result = await forwarder.forward(makeRequest(1, 'tools/list'))

    expect(result.response.status).toBe(200)
    expect(result.response.body).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { method: 'tools/list' },
    })
  })

  it('measures durationMs', async () => {
    forwarder = new StdioForwarder({ command: 'node', args: ['-e', ECHO_SCRIPT] })
    await forwarder.start()

    const result = await forwarder.forward(makeRequest(1, 'ping'))

    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(result.durationMs).toBeLessThan(5000)
  })

  it('handles multiple concurrent requests', async () => {
    forwarder = new StdioForwarder({ command: 'node', args: ['-e', ECHO_SCRIPT] })
    await forwarder.start()

    const results = await Promise.all([
      forwarder.forward(makeRequest(1, 'tools/list')),
      forwarder.forward(makeRequest(2, 'tools/call')),
      forwarder.forward(makeRequest(3, 'initialize')),
    ])

    expect(results).toHaveLength(3)
    for (const [i, result] of results.entries()) {
      expect(result.response.body).toHaveProperty('id', i + 1)
    }
  })

  it('strips sessionId and headers from the body sent to stdin', async () => {
    // Use a script that echoes the raw received JSON back as the result
    const inspectScript = `
      const readline = require('readline');
      const rl = readline.createInterface({ input: process.stdin });
      rl.on('line', (line) => {
        try {
          const req = JSON.parse(line);
          if (req.id !== undefined) {
            process.stdout.write(JSON.stringify({
              jsonrpc: '2.0', id: req.id, result: { received: req }
            }) + '\\n');
          }
        } catch {}
      });
    `
    forwarder = new StdioForwarder({ command: 'node', args: ['-e', inspectScript] })
    await forwarder.start()

    const request: McpRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      sessionId: 'session-123',
      headers: { authorization: 'Bearer token' },
    }
    const result = await forwarder.forward(request)
    const body = result.response.body as { result: { received: Record<string, unknown> } }
    const received = body.result.received

    expect(received).not.toHaveProperty('sessionId')
    expect(received).not.toHaveProperty('headers')
    expect(received).toHaveProperty('method', 'tools/list')
  })

  it('handles notifications (no id) without hanging', async () => {
    forwarder = new StdioForwarder({ command: 'node', args: ['-e', ECHO_SCRIPT] })
    await forwarder.start()

    const request: McpRequest = { jsonrpc: '2.0', method: 'notifications/initialized' }
    const result = await forwarder.forward(request)

    expect(result.response.status).toBe(200)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('treats id: null as a request id (not a notification)', async () => {
    const nullIdScript = `
      const readline = require('readline');
      const rl = readline.createInterface({ input: process.stdin });
      rl.on('line', (line) => {
        try {
          const req = JSON.parse(line);
          if (Object.prototype.hasOwnProperty.call(req, 'id')) {
            const res = { jsonrpc: '2.0', id: req.id, result: { method: req.method } };
            process.stdout.write(JSON.stringify(res) + '\\n');
          }
        } catch {}
      });
    `
    forwarder = new StdioForwarder({ command: 'node', args: ['-e', nullIdScript] })
    await forwarder.start()

    const request: McpRequest = { jsonrpc: '2.0', id: null, method: 'tools/list' }
    const result = await forwarder.forward(request)

    expect(result.response.status).toBe(200)
    expect(result.response.body).toEqual({
      jsonrpc: '2.0',
      id: null,
      result: { method: 'tools/list' },
    })
  })

  it('rejects forward when not started', async () => {
    forwarder = new StdioForwarder({ command: 'node', args: ['-e', ECHO_SCRIPT] })

    await expect(forwarder.forward(makeRequest(1, 'ping'))).rejects.toThrow('not started')
  })

  it('rejects forward when dead after max retries', async () => {
    forwarder = new StdioForwarder({
      command: 'node',
      args: ['-e', CRASH_SCRIPT],
      maxRetries: 0,
      retryDelayMs: 10,
    })

    // start() will succeed (process spawns), but it will exit immediately.
    // After exit with maxRetries=0, the forwarder should be dead.
    await forwarder.start()

    // Wait for the process to crash and be marked dead
    await new Promise((resolve) => setTimeout(resolve, 100))

    await expect(forwarder.forward(makeRequest(1, 'ping'))).rejects.toThrow('dead')
  }, 5000)

  it('auto-restarts on crash up to maxRetries', async () => {
    // Script that crashes on first run, then works on second
    const crashOnceScript = `
        const fs = require('fs');
        const path = require('path');
        const marker = path.join(require('os').tmpdir(), 'helio-stdio-test-' + process.ppid);
        if (!fs.existsSync(marker)) {
          fs.writeFileSync(marker, '');
          process.exit(1);
        }
        fs.unlinkSync(marker);
        const readline = require('readline');
        const rl = readline.createInterface({ input: process.stdin });
        rl.on('line', (line) => {
          try {
            const req = JSON.parse(line);
            if (req.id !== undefined) {
              process.stdout.write(JSON.stringify({
                jsonrpc: '2.0', id: req.id, result: { ok: true }
              }) + '\\n');
            }
          } catch {}
        });
      `

    forwarder = new StdioForwarder({
      command: 'node',
      args: ['-e', crashOnceScript],
      maxRetries: 3,
      retryDelayMs: 50,
    })
    await forwarder.start()

    // Wait for crash + restart
    await new Promise((resolve) => setTimeout(resolve, 500))

    const result = await forwarder.forward(makeRequest(1, 'ping'))
    expect(result.response.body).toHaveProperty('result', { ok: true })
  }, 10000)

  it('close rejects pending requests', async () => {
    // Script that never responds
    const silentScript = `
      const readline = require('readline');
      const rl = readline.createInterface({ input: process.stdin });
      rl.on('line', () => {});
    `
    forwarder = new StdioForwarder({
      command: 'node',
      args: ['-e', silentScript],
      requestTimeoutMs: 60000,
    })
    await forwarder.start()

    // Capture the rejection before closing to avoid unhandled rejection
    const promise = forwarder.forward(makeRequest(1, 'tools/list'))
    const rejection = expect(promise).rejects.toThrow('closing')

    await forwarder.close()
    forwarder = null // already closed

    await rejection
  })

  it('handles partial stdout lines (buffered)', async () => {
    // Script that sends a response in two chunks with a delay between them
    const chunkedScript = `
      const readline = require('readline');
      const rl = readline.createInterface({ input: process.stdin });
      rl.on('line', (line) => {
        try {
          const req = JSON.parse(line);
          if (req.id !== undefined) {
            const res = JSON.stringify({ jsonrpc: '2.0', id: req.id, result: {} });
            // Send first half
            process.stdout.write(res.slice(0, 10));
            // Send rest after a small delay
            setTimeout(() => {
              process.stdout.write(res.slice(10) + '\\n');
            }, 20);
          }
        } catch {}
      });
    `
    forwarder = new StdioForwarder({ command: 'node', args: ['-e', chunkedScript] })
    await forwarder.start()

    const result = await forwarder.forward(makeRequest(1, 'ping'))
    expect(result.response.body).toEqual({ jsonrpc: '2.0', id: 1, result: {} })
  })
})
