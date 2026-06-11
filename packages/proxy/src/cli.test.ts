import { describe, it, expect, beforeAll } from 'vitest'
import { execFile, spawn } from 'node:child_process'
import { existsSync, writeFileSync, rmSync, mkdtempSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AuditStore } from './audit/store.js'
import type { AuditRecord } from './audit/types.js'

const CLI_PATH = join(import.meta.dirname, '../dist/cli.js')

/** Run the CLI and capture output. */
function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('node', [CLI_PATH, ...args], (error, stdout, stderr) => {
      resolve({
        code: typeof error?.code === 'number' ? error.code : error ? 1 : 0,
        stdout,
        stderr,
      })
    })
  })
}

/**
 * Spawn `helio start` and collect stderr until a target log line appears,
 * then kill the process. Used by start-command tests to assert on startup
 * log lines without depending on real upstream connectivity.
 */
async function startAndCaptureStderr(
  args: string[],
  options: {
    readyMarker?: RegExp
    timeoutMs?: number
    env?: NodeJS.ProcessEnv
  } = {},
): Promise<string> {
  const readyMarker = options.readyMarker ?? /Helio proxy listening/
  const timeoutMs = options.timeoutMs ?? 8_000
  return new Promise<string>((resolve, reject) => {
    // stdout is ignored entirely — the CLI does not write anything to stdout
    // at startup, and attaching a pipe we never drain would block the child
    // if that ever changed.
    const child = spawn('node', [CLI_PATH, 'start', ...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
      ...(options.env ? { env: options.env } : {}),
    })

    let stderr = ''
    let settled = false
    let flushTimer: ReturnType<typeof setTimeout> | null = null

    const finish = (result: string | Error) => {
      if (settled) return
      settled = true
      if (flushTimer !== null) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      try {
        child.kill('SIGTERM')
      } catch {
        // Process already gone — ignore.
      }
      if (result instanceof Error) reject(result)
      else resolve(result)
    }

    const timer = setTimeout(() => {
      finish(
        new Error(
          `Timed out waiting for helio start to reach ready marker. stderr so far:\n${stderr}`,
        ),
      )
    }, timeoutMs)
    timer.unref()

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8')
      if (flushTimer === null && readyMarker.test(stderr)) {
        clearTimeout(timer)
        // Give the process one more tick to flush any trailing startup lines
        // that come out in the same microtask (e.g. "Watching ...").
        flushTimer = setTimeout(() => {
          flushTimer = null
          finish(stderr)
        }, 50)
        flushTimer.unref()
      }
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      finish(err instanceof Error ? err : new Error(String(err)))
    })

    child.on('exit', (code) => {
      if (!settled) {
        clearTimeout(timer)
        finish(
          new Error(
            `helio start exited with code ${String(code)} before reaching ready marker. stderr:\n${stderr}`,
          ),
        )
      }
    })
  })
}

/**
 * Write a minimal start-ready config at a randomized high port and return
 * the tempdir + config path. The caller is responsible for rmSync cleanup.
 */
function writeStartConfig(): { dir: string; configPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'helio-cli-start-'))
  const configPath = join(dir, 'helio.yaml')
  // High-numbered random ports avoid collisions across parallel test workers.
  const listenPort = 40_000 + Math.floor(Math.random() * 20_000)
  const dashboardPort = listenPort + 1
  const auditPath = join(dir, 'audit.db')
  writeFileSync(
    configPath,
    `
version: "1"
upstream:
  url: "http://127.0.0.1:1/mcp"
  transport: streamable-http
listen:
  port: ${String(listenPort)}
  host: 127.0.0.1
dashboard:
  enabled: true
  port: ${String(dashboardPort)}
  host: 127.0.0.1
  api_secret: "test-secret-${String(listenPort)}"
audit:
  path: "${auditPath}"
`,
  )
  return { dir, configPath }
}

/** Write a stdio transport config for startup/request-timeout assertions. */
function writeStdioStartConfig(requestTimeout: string): {
  dir: string
  configPath: string
  listenPort: number
} {
  const dir = mkdtempSync(join(tmpdir(), 'helio-cli-stdio-start-'))
  const configPath = join(dir, 'helio.yaml')
  const listenPort = 40_000 + Math.floor(Math.random() * 20_000)
  const auditPath = join(dir, 'audit.db')
  writeFileSync(
    configPath,
    `
version: "1"
upstream:
  url: "http://127.0.0.1:1/mcp"
  transport: stdio
  command: "node"
  args:
    - "-e"
    - "process.stdin.resume()"
  request_timeout: "${requestTimeout}"
listen:
  port: ${String(listenPort)}
  host: 127.0.0.1
dashboard:
  enabled: false
audit:
  path: "${auditPath}"
`,
  )
  return { dir, configPath, listenPort }
}

/** Wait until the proxy health endpoint responds, to avoid startup races. */
async function waitForProxyHealth(baseUrl: string, timeoutMs: number): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/healthz`, {
        signal: AbortSignal.timeout(500),
      })
      if (res.ok) return
    } catch {
      // Proxy may still be binding sockets; keep polling until timeout.
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out waiting for proxy health endpoint at ${baseUrl}/healthz`)
}

/** Wait for child process exit with timeout. */
async function waitForChildExit(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode }
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for child process exit after ${String(timeoutMs)}ms`))
    }, timeoutMs)
    timer.unref()

    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal })
    })
  })
}

interface MockMcpServer {
  readonly url: string
  readonly calls: readonly { readonly method: string; readonly name?: string }[]
  close(): Promise<void>
}

async function startMockMcpServer(
  responder: (payload: Record<string, unknown>) => Record<string, unknown>,
): Promise<MockMcpServer> {
  const calls: Array<{ method: string; name?: string }> = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8')
      let payload: Record<string, unknown> = {}
      try {
        payload = JSON.parse(raw) as Record<string, unknown>
      } catch {
        payload = {}
      }

      const method = typeof payload['method'] === 'string' ? payload['method'] : 'unknown'
      const params =
        payload['params'] && typeof payload['params'] === 'object'
          ? (payload['params'] as Record<string, unknown>)
          : undefined
      const name = typeof params?.['name'] === 'string' ? params['name'] : undefined
      calls.push({ method, name })

      const responseBody = responder(payload)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(responseBody))
    })
  })

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = (server.address() as AddressInfo).port

  return {
    url: `http://127.0.0.1:${String(port)}/mcp`,
    calls,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err)
            return
          }
          resolve()
        })
      }),
  }
}

describe('CLI', () => {
  beforeAll(() => {
    if (!existsSync(CLI_PATH)) {
      throw new Error(
        `dist/cli.js not found — run "pnpm --filter @gethelio/proxy build" before running CLI tests`,
      )
    }
  })

  // --- helio init ---

  describe('init', () => {
    it('generates a valid YAML file with a dashboard.api_secret', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'helio-cli-test-'))
      const outPath = join(dir, 'helio.yaml')

      try {
        const { code, stderr } = await runCli(['init', '-o', outPath])
        expect(code).toBe(0)
        expect(stderr).toContain(`Created ${outPath}`)
        expect(existsSync(outPath)).toBe(true)

        const contents = readFileSync(outPath, 'utf-8')
        const match = contents.match(/dashboard:[\s\S]*?api_secret:\s*"([a-f0-9]{64})"/)
        expect(match).not.toBeNull()
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('generates a different secret each time', async () => {
      const dir1 = mkdtempSync(join(tmpdir(), 'helio-cli-test-'))
      const dir2 = mkdtempSync(join(tmpdir(), 'helio-cli-test-'))
      const out1 = join(dir1, 'helio.yaml')
      const out2 = join(dir2, 'helio.yaml')

      try {
        await runCli(['init', '-o', out1])
        await runCli(['init', '-o', out2])

        const secret1 = readFileSync(out1, 'utf-8').match(/api_secret:\s*"([a-f0-9]{64})"/)?.[1]
        const secret2 = readFileSync(out2, 'utf-8').match(/api_secret:\s*"([a-f0-9]{64})"/)?.[1]
        expect(secret1).toBeDefined()
        expect(secret2).toBeDefined()
        expect(secret1).not.toBe(secret2)
      } finally {
        rmSync(dir1, { recursive: true, force: true })
        rmSync(dir2, { recursive: true, force: true })
      }
    })

    it('prints the generated secret to stderr', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'helio-cli-test-'))
      const outPath = join(dir, 'helio.yaml')

      try {
        const { code, stderr } = await runCli(['init', '-o', outPath])
        expect(code).toBe(0)
        expect(stderr).toContain('Generated dashboard.api_secret')
        expect(stderr).toMatch(/[a-f0-9]{64}/)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('refuses to overwrite existing file', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'helio-cli-test-'))
      const outPath = join(dir, 'helio.yaml')
      writeFileSync(outPath, 'existing content')

      try {
        const { code, stderr } = await runCli(['init', '-o', outPath])
        expect(code).toBe(1)
        expect(stderr).toContain('already exists')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('overwrites with --force', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'helio-cli-test-'))
      const outPath = join(dir, 'helio.yaml')
      writeFileSync(outPath, 'old content')

      try {
        const { code, stderr } = await runCli(['init', '-o', outPath, '--force'])
        expect(code).toBe(0)
        expect(stderr).toContain(`Created ${outPath}`)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })

  // --- helio validate ---

  describe('validate', () => {
    it('accepts valid config', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'helio-cli-test-'))
      const configPath = join(dir, 'helio.yaml')

      const validConfig = `
version: "1"
upstream:
  url: "http://localhost:8080/mcp"
  transport: streamable-http
listen:
  port: 3000
  host: 127.0.0.1
dashboard:
  enabled: false
`
      writeFileSync(configPath, validConfig)

      try {
        const { code, stderr } = await runCli(['validate', '-c', configPath])
        expect(code).toBe(0)
        expect(stderr).toContain('Config is valid')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('rejects invalid config (missing upstream.url)', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'helio-cli-test-'))
      const configPath = join(dir, 'helio.yaml')

      writeFileSync(configPath, 'version: "1"\n')

      try {
        const { code, stderr } = await runCli(['validate', '-c', configPath])
        expect(code).toBe(1)
        expect(stderr).toContain('Invalid config')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('rejects non-existent file', async () => {
      const { code, stderr } = await runCli([
        'validate',
        '-c',
        '/tmp/nonexistent-helio-config.yaml',
      ])
      expect(code).toBe(1)
      expect(stderr.length).toBeGreaterThan(0)
    })
  })

  // --- helio init + validate round-trip ---

  it('init generates config that passes validate', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'helio-cli-test-'))
    const configPath = join(dir, 'helio.yaml')

    try {
      const init = await runCli(['init', '-o', configPath])
      expect(init.code).toBe(0)

      const validate = await runCli(['validate', '-c', configPath])
      expect(validate.code).toBe(0)
      expect(validate.stderr).toContain('Config is valid')

      const contents = readFileSync(configPath, 'utf-8')
      expect(contents).toMatch(/dashboard:[\s\S]*?api_secret:\s*"[a-f0-9]{64}"/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // --- helio start ---

  describe('start', () => {
    it('watches the config file for policy changes by default', async () => {
      const { dir, configPath } = writeStartConfig()
      try {
        const stderr = await startAndCaptureStderr(['-c', configPath])
        expect(stderr).toContain(`Watching ${configPath} for policy changes`)
        expect(stderr).not.toContain('Hot-reload disabled')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('disables the config watcher when --no-hot-reload is set', async () => {
      const { dir, configPath } = writeStartConfig()
      try {
        const stderr = await startAndCaptureStderr(['-c', configPath, '--no-hot-reload'])
        expect(stderr).toContain('Hot-reload disabled')
        expect(stderr).not.toContain(`Watching ${configPath} for policy changes`)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('fails startup when dashboard is enabled but bundled assets are missing', async () => {
      const { dir, configPath } = writeStartConfig()
      const missingAssetsDir = join(dir, 'missing-dashboard-assets')
      try {
        await expect(
          startAndCaptureStderr(['-c', configPath], {
            timeoutMs: 5_000,
            env: {
              ...process.env,
              VITEST: 'true',
              HELIO_DASHBOARD_ASSETS_DIR_TEST_OVERRIDE: missingAssetsDir,
            },
          }),
        ).rejects.toThrow(/bundled dashboard assets are missing/)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('starts in headless mode when dashboard assets are missing and dashboard.enabled is false', async () => {
      const { dir, configPath } = writeStartConfig()
      const missingAssetsDir = join(dir, 'missing-dashboard-assets')
      try {
        const original = readFileSync(configPath, 'utf-8')
        const headless = original.replace('enabled: true', 'enabled: false')
        writeFileSync(configPath, headless)
        const stderr = await startAndCaptureStderr(['-c', configPath], {
          timeoutMs: 8_000,
          env: {
            ...process.env,
            VITEST: 'true',
            HELIO_DASHBOARD_ASSETS_DIR_TEST_OVERRIDE: missingAssetsDir,
          },
        })
        expect(stderr).toContain('Helio proxy listening')
        expect(stderr).not.toContain('Dashboard API listening')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('logs restart-required warning when non-reloadable fields change on hot-reload', async () => {
      const { dir, configPath } = writeStartConfig()
      const child = spawn('node', [CLI_PATH, 'start', '-c', configPath], {
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      let stderr = ''
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf-8')
      })

      const waitForLog = async (predicate: () => boolean, timeoutMs: number): Promise<void> => {
        const started = Date.now()
        while (Date.now() - started < timeoutMs) {
          if (predicate()) return
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
        throw new Error(`Timed out waiting for expected log. stderr:\n${stderr}`)
      }

      try {
        await waitForLog(() => stderr.includes(`Watching ${configPath} for policy changes`), 8_000)
        // Chokidar start() is async; give it a short settle window after the
        // "Watching ..." log so the first write is not missed on fast machines.
        await new Promise((resolve) => setTimeout(resolve, 150))

        const original = readFileSync(configPath, 'utf-8')
        const updated = original.replace(
          /listen:\n\s*port: (\d+)/,
          (_full, port: string) => `listen:\n  port: ${String(Number(port) + 1)}`,
        )
        expect(updated).not.toBe(original)
        writeFileSync(configPath, updated)

        await waitForLog(
          () => stderr.includes('Restart required: non-reloadable fields changed'),
          8_000,
        )
        expect(stderr).toContain('Restart required: non-reloadable fields changed')
        expect(stderr).toContain('listen')
      } finally {
        child.kill('SIGTERM')
        await waitForChildExit(child, 5_000).catch(() => undefined)
        rmSync(dir, { recursive: true, force: true })
      }
    }, 20_000)

    it('shuts down cleanly on SIGINT with an active dashboard SSE stream', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'helio-cli-shutdown-'))
      const configPath = join(dir, 'helio.yaml')
      const listenPort = 40_000 + Math.floor(Math.random() * 20_000)
      const dashboardPort = listenPort + 1
      const apiSecret = `test-secret-${String(listenPort)}`
      const auditPath = join(dir, 'audit.db')
      writeFileSync(
        configPath,
        `
version: "1"
upstream:
  url: "http://127.0.0.1:1/mcp"
  transport: streamable-http
listen:
  port: ${String(listenPort)}
  host: 127.0.0.1
dashboard:
  enabled: true
  port: ${String(dashboardPort)}
  host: 127.0.0.1
  api_secret: "${apiSecret}"
audit:
  path: "${auditPath}"
`,
      )

      const child = spawn('node', [CLI_PATH, 'start', '-c', configPath], {
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      let stderr = ''
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf-8')
      })

      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new Error(`Timed out waiting for startup logs. stderr:\n${stderr}`))
          }, 8_000)
          timer.unref()

          const checkReady = () => {
            if (
              stderr.includes('Helio proxy listening') &&
              stderr.includes('Dashboard API listening')
            ) {
              clearTimeout(timer)
              resolve()
            }
          }

          child.stderr.on('data', checkReady)
          child.once('exit', (code) => {
            clearTimeout(timer)
            reject(
              new Error(
                `helio start exited with code ${String(code)} before startup. stderr:\n${stderr}`,
              ),
            )
          })
        })

        const baseUrl = `http://127.0.0.1:${String(listenPort)}`
        await waitForProxyHealth(baseUrl, 2_000)

        const eventsRes = await fetch(`http://127.0.0.1:${String(dashboardPort)}/api/events`, {
          headers: { authorization: `Bearer ${apiSecret}` },
          signal: AbortSignal.timeout(5_000),
        })
        expect(eventsRes.status).toBe(200)
        expect(eventsRes.body).not.toBeNull()

        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- asserted above
        reader = eventsRes.body!.getReader()
        const decoder = new TextDecoder()
        const firstChunk = await Promise.race([
          reader.read(),
          new Promise<never>((_resolve, reject) => {
            setTimeout(() => {
              reject(new Error('Timed out waiting for SSE heartbeat chunk'))
            }, 1_000)
          }),
        ])
        expect(decoder.decode(firstChunk.value)).toContain('event: heartbeat')

        child.kill('SIGINT')
        const exit = await waitForChildExit(child, 8_000)
        expect(exit.code).toBe(0)
        expect(exit.signal).toBeNull()
        expect(stderr).toContain('[helio] Shutting down...')
        expect(stderr).not.toContain('[helio] Forced shutdown after timeout')
      } finally {
        if (reader) {
          await reader.cancel().catch(() => {
            // Ignore cancellation errors when stream already closed.
          })
        }
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGTERM')
          await waitForChildExit(child, 5_000)
        }
        rmSync(dir, { recursive: true, force: true })
      }
    }, 20_000)

    it('primes annotation cache at startup when upstream tools/list is reachable', async () => {
      const upstream = await startMockMcpServer((payload) => {
        const id = payload['id'] ?? null
        if (payload['method'] === 'tools/list') {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              tools: [
                {
                  name: 'send_email',
                  annotations: { readOnlyHint: false, destructiveHint: false },
                },
                {
                  name: 'delete_record',
                  annotations: { readOnlyHint: false, destructiveHint: true },
                },
              ],
            },
          }
        }
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'ok' }] } }
      })

      const dir = mkdtempSync(join(tmpdir(), 'helio-cli-prime-'))
      const configPath = join(dir, 'helio.yaml')
      const listenPort = 40_000 + Math.floor(Math.random() * 20_000)
      const auditPath = join(dir, 'audit.db')
      writeFileSync(
        configPath,
        `
version: "1"
upstream:
  url: "${upstream.url}"
  transport: streamable-http
listen:
  port: ${String(listenPort)}
  host: 127.0.0.1
dashboard:
  enabled: false
audit:
  path: "${auditPath}"
`,
      )

      try {
        const stderr = await startAndCaptureStderr(['-c', configPath], {
          readyMarker: /Annotation cache primed:/,
          timeoutMs: 8_000,
        })
        expect(stderr).toContain(
          'Annotation cache primed: 2 tool definitions baselined for drift detection',
        )
        expect(upstream.calls.some((call) => call.method === 'tools/list')).toBe(true)
      } finally {
        await upstream.close()
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('continues startup when initial annotation prime fails, remaining fail-closed', async () => {
      const { dir, configPath } = writeStartConfig()
      try {
        const stderr = await startAndCaptureStderr(['-c', configPath], {
          readyMarker: /Helio proxy listening/,
          timeoutMs: 8_000,
        })
        expect(stderr).toContain('Helio proxy listening')
        expect(stderr).toContain('Annotation cache priming failed:')
        expect(stderr).toContain('fail-closed')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('allows first non-destructive tools/call without client tools/list after startup prime', async () => {
      const upstream = await startMockMcpServer((payload) => {
        const id = payload['id'] ?? null
        if (payload['method'] === 'tools/list') {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              tools: [
                { name: 'send_email', annotations: { destructiveHint: false } },
                { name: 'delete_record', annotations: { destructiveHint: true } },
              ],
            },
          }
        }

        const params =
          payload['params'] && typeof payload['params'] === 'object'
            ? (payload['params'] as Record<string, unknown>)
            : undefined
        const name = typeof params?.['name'] === 'string' ? params['name'] : 'unknown'
        return {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: `upstream:${name}` }] },
        }
      })

      const dir = mkdtempSync(join(tmpdir(), 'helio-cli-prime-call-'))
      const configPath = join(dir, 'helio.yaml')
      const listenPort = 40_000 + Math.floor(Math.random() * 20_000)
      const auditPath = join(dir, 'audit.db')
      writeFileSync(
        configPath,
        `
version: "1"
upstream:
  url: "${upstream.url}"
  transport: streamable-http
listen:
  port: ${String(listenPort)}
  host: 127.0.0.1
dashboard:
  enabled: false
policies:
  default: allow
  rules:
    - name: block-destructive
      match:
        annotations:
          destructiveHint: true
      action: deny
audit:
  path: "${auditPath}"
`,
      )

      const child = spawn('node', [CLI_PATH, 'start', '-c', configPath], {
        stdio: ['ignore', 'ignore', 'pipe'],
      })

      let stderr = ''
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new Error(`Timed out waiting for startup. stderr:\n${stderr}`))
          }, 8_000)
          timer.unref()

          child.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString('utf-8')
            if (stderr.includes('Helio proxy listening')) {
              clearTimeout(timer)
              resolve()
            }
          })

          child.once('exit', (code) => {
            clearTimeout(timer)
            reject(
              new Error(
                `helio start exited before ready marker with code ${String(code)}. stderr:\n${stderr}`,
              ),
            )
          })
        })

        const baseUrl = `http://127.0.0.1:${String(listenPort)}`
        await waitForProxyHealth(baseUrl, 2_000)

        const res = await fetch(`${baseUrl}/mcp`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'send_email', arguments: { to: 'x@y', body: 'hi' } },
          }),
          signal: AbortSignal.timeout(5_000),
        })
        const body = (await res.json()) as Record<string, unknown>

        expect(res.status).toBe(200)
        expect(body['error']).toBeUndefined()
        expect(upstream.calls.some((call) => call.method === 'tools/list')).toBe(true)
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGTERM')
          await new Promise<void>((resolve) => {
            child.once('exit', () => {
              resolve()
            })
          })
        }
        await upstream.close()
        rmSync(dir, { recursive: true, force: true })
      }
    }, 15_000)

    it('generates a fresh SDK sideband bearer token when sdk.enabled is true', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'helio-cli-start-'))
      const configPath = join(dir, 'helio.yaml')
      const listenPort = 40_000 + Math.floor(Math.random() * 20_000)
      const dashboardPort = listenPort + 1
      const sdkPort = listenPort + 2
      const auditPath = join(dir, 'audit.db')
      writeFileSync(
        configPath,
        `
version: "1"
upstream:
  url: "http://127.0.0.1:1/mcp"
  transport: streamable-http
listen:
  port: ${String(listenPort)}
  host: 127.0.0.1
dashboard:
  enabled: true
  port: ${String(dashboardPort)}
  host: 127.0.0.1
  api_secret: "test-secret-${String(listenPort)}"
sdk:
  enabled: true
  port: ${String(sdkPort)}
  host: 127.0.0.1
audit:
  path: "${auditPath}"
`,
      )
      try {
        const stderr = await startAndCaptureStderr(['-c', configPath], {
          readyMarker: /SDK token \(.*pass as HELIO_SDK_TOKEN/,
          timeoutMs: 8_000,
        })
        expect(stderr).toContain(`SDK sideband listening on http://127.0.0.1:${String(sdkPort)}`)
        expect(stderr).toContain('generated per-boot HELIO_SDK_TOKEN')
        // 32 bytes hex = 64 chars
        expect(stderr).toMatch(/[a-f0-9]{64}/)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('respects a pre-set HELIO_SDK_TOKEN environment variable', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'helio-cli-start-'))
      const configPath = join(dir, 'helio.yaml')
      const listenPort = 40_000 + Math.floor(Math.random() * 20_000)
      const dashboardPort = listenPort + 1
      const sdkPort = listenPort + 2
      const auditPath = join(dir, 'audit.db')
      writeFileSync(
        configPath,
        `
version: "1"
upstream:
  url: "http://127.0.0.1:1/mcp"
  transport: streamable-http
listen:
  port: ${String(listenPort)}
  host: 127.0.0.1
dashboard:
  enabled: true
  port: ${String(dashboardPort)}
  host: 127.0.0.1
  api_secret: "test-secret-${String(listenPort)}"
sdk:
  enabled: true
  port: ${String(sdkPort)}
  host: 127.0.0.1
audit:
  path: "${auditPath}"
`,
      )
      const presetToken = 'preset-token-value-that-should-appear-verbatim-in-stderr'
      try {
        const stderr = await startAndCaptureStderr(['-c', configPath], {
          readyMarker: /SDK token \(.*pass as HELIO_SDK_TOKEN/,
          timeoutMs: 8_000,
          env: { ...process.env, HELIO_SDK_TOKEN: presetToken },
        })
        expect(stderr).toContain(presetToken)
        expect(stderr).toContain('reusing HELIO_SDK_TOKEN from environment')
        expect(stderr).not.toContain('generated per-boot HELIO_SDK_TOKEN')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('disables the config watcher when policies.hot_reload is false', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'helio-cli-start-'))
      const configPath = join(dir, 'helio.yaml')
      const listenPort = 40_000 + Math.floor(Math.random() * 20_000)
      const dashboardPort = listenPort + 1
      const auditPath = join(dir, 'audit.db')
      writeFileSync(
        configPath,
        `
version: "1"
upstream:
  url: "http://127.0.0.1:1/mcp"
  transport: streamable-http
listen:
  port: ${String(listenPort)}
  host: 127.0.0.1
dashboard:
  enabled: true
  port: ${String(dashboardPort)}
  host: 127.0.0.1
  api_secret: "test-secret-${String(listenPort)}"
policies:
  hot_reload: false
audit:
  path: "${auditPath}"
`,
      )
      try {
        const stderr = await startAndCaptureStderr(['-c', configPath])
        expect(stderr).toContain('Hot-reload disabled')
        expect(stderr).not.toContain(`Watching ${configPath} for policy changes`)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('uses upstream.request_timeout for stdio transport', async () => {
      const { dir, configPath, listenPort } = writeStdioStartConfig('1s')
      const child = spawn('node', [CLI_PATH, 'start', '-c', configPath], {
        stdio: ['ignore', 'ignore', 'pipe'],
      })

      let stderr = ''
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new Error(`Timed out waiting for start marker. stderr:\n${stderr}`))
          }, 8_000)
          timer.unref()

          child.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString('utf-8')
            if (stderr.includes('Helio proxy listening')) {
              clearTimeout(timer)
              resolve()
            }
          })

          child.on('exit', (code) => {
            clearTimeout(timer)
            reject(
              new Error(
                `helio start exited before ready marker with code ${String(code)}. stderr:\n${stderr}`,
              ),
            )
          })
        })

        const baseUrl = `http://127.0.0.1:${String(listenPort)}`
        await waitForProxyHealth(baseUrl, 2_000)

        const beginMs = Date.now()
        const res = await fetch(`${baseUrl}/mcp`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
          signal: AbortSignal.timeout(5_000),
        })
        const elapsedMs = Date.now() - beginMs

        expect(res.status).toBe(200)
        const body = (await res.json()) as {
          error: { code: number; data?: Record<string, unknown> }
        }
        expect(body.error.code).toBe(-32603)
        expect(body.error.data?.['failure_class']).toBe('upstream_forward_error')
        // If stdio ignored request_timeout, this would hang near the default
        // 30s and trip the 5s client timeout above.
        expect(elapsedMs).toBeLessThan(4_000)
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGTERM')
          await new Promise<void>((resolve) => {
            child.once('exit', () => {
              resolve()
            })
          })
        }
        rmSync(dir, { recursive: true, force: true })
      }
    }, 15_000)
  })

  // --- helio export ---

  describe('export', () => {
    type InsertRecord = Omit<AuditRecord, 'id' | 'created_at'>

    function makeRecord(overrides: Partial<InsertRecord> = {}): InsertRecord {
      const defaults: InsertRecord = {
        timestamp: new Date().toISOString(),
        session_id: null,
        agent_id: null,
        environment: null,
        tool_name: 'test_tool',
        tool_input: { key: 'value' },
        policy_decision: 'allow',
        block_reason: null,
        matched_rule: null,
        matched_rule_index: null,
        evidence_chain: null,
        approval_status: null,
        approved_by: null,
        upstream_response: { result: 'ok' },
        upstream_error: null,
        upstream_http_status: 200,
        upstream_latency_ms: 10,
        total_duration_ms: 5,
        approval_wait_ms: 0,
        proxy_compute_ms: 2,
        flagged_destructive: false,
        dry_run: false,
      }
      return {
        ...defaults,
        ...overrides,
        environment: overrides.environment ?? defaults.environment,
        matched_rule_index: overrides.matched_rule_index ?? defaults.matched_rule_index,
      }
    }

    /** Create a temp dir with an audit DB and helio.yaml pointing to it. */
    function setupExport(records: InsertRecord[]) {
      const dir = mkdtempSync(join(tmpdir(), 'helio-export-'))
      const dbPath = join(dir, 'audit.db')
      const configPath = join(dir, 'helio.yaml')

      const store = new AuditStore({
        path: dbPath,
        retention: '90d',
        includeResponses: true,
        cleanupIntervalMs: 0,
      })

      for (const r of records) {
        store.insert(r)
      }
      store.close()

      writeFileSync(
        configPath,
        `
version: "1"
upstream:
  url: "http://localhost:8080/mcp"
dashboard:
  enabled: false
audit:
  path: "${dbPath}"
  retention: "90d"
  include_responses: true
`,
      )

      return { dir, configPath }
    }

    it('exports records as JSON', async () => {
      const { dir, configPath } = setupExport([
        makeRecord({ tool_name: 'tool_a', policy_decision: 'allow' }),
        makeRecord({ tool_name: 'tool_b', policy_decision: 'deny' }),
        makeRecord({ tool_name: 'tool_c', policy_decision: 'allow' }),
      ])

      try {
        const { code, stdout, stderr } = await runCli(['export', '-c', configPath, '-f', 'json'])
        expect(code).toBe(0)
        expect(stderr).toContain('Exported 3 of 3 records')

        const records = JSON.parse(stdout) as AuditRecord[]
        expect(records).toHaveLength(3)
        expect(records.map((r) => r.tool_name).sort()).toEqual(['tool_a', 'tool_b', 'tool_c'])
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('exports records as CSV', async () => {
      const { dir, configPath } = setupExport([
        makeRecord({ tool_name: 'tool_x' }),
        makeRecord({ tool_name: 'tool_y' }),
      ])

      try {
        const { code, stdout, stderr } = await runCli(['export', '-c', configPath, '-f', 'csv'])
        expect(code).toBe(0)
        expect(stderr).toContain('Exported 2 of 2 records')

        const lines = stdout.trim().split('\n')
        expect(lines).toHaveLength(3) // header + 2 data rows
        expect(lines[0]).toContain('tool_name')
        expect(lines[0]).toContain('flagged_destructive')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('filters by tool name', async () => {
      const { dir, configPath } = setupExport([
        makeRecord({ tool_name: 'alpha' }),
        makeRecord({ tool_name: 'alpha' }),
        makeRecord({ tool_name: 'beta' }),
      ])

      try {
        const { code, stdout } = await runCli([
          'export',
          '-c',
          configPath,
          '-f',
          'json',
          '--tool',
          'alpha',
        ])
        expect(code).toBe(0)

        const records = JSON.parse(stdout) as AuditRecord[]
        expect(records).toHaveLength(2)
        expect(records.every((r) => r.tool_name === 'alpha')).toBe(true)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('filters by decision', async () => {
      const { dir, configPath } = setupExport([
        makeRecord({ policy_decision: 'allow' }),
        makeRecord({ policy_decision: 'deny' }),
        makeRecord({ policy_decision: 'deny' }),
      ])

      try {
        const { code, stdout } = await runCli([
          'export',
          '-c',
          configPath,
          '-f',
          'json',
          '--decision',
          'deny',
        ])
        expect(code).toBe(0)

        const records = JSON.parse(stdout) as AuditRecord[]
        expect(records).toHaveLength(2)
        expect(records.every((r) => r.policy_decision === 'deny')).toBe(true)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('filters by block reason', async () => {
      const { dir, configPath } = setupExport([
        makeRecord({ policy_decision: 'deny', block_reason: 'evidence_missing' }),
        makeRecord({ policy_decision: 'deny', block_reason: 'evidence_expired' }),
        makeRecord({ policy_decision: 'allow', block_reason: null }),
      ])

      try {
        const { code, stdout } = await runCli([
          'export',
          '-c',
          configPath,
          '-f',
          'json',
          '--reason',
          'evidence_missing',
        ])
        expect(code).toBe(0)

        const records = JSON.parse(stdout) as AuditRecord[]
        expect(records).toHaveLength(1)
        expect(records[0]?.block_reason).toBe('evidence_missing')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('respects --limit', async () => {
      const records = Array.from({ length: 10 }, (_, i) =>
        makeRecord({ tool_name: `tool_${String(i)}` }),
      )
      const { dir, configPath } = setupExport(records)

      try {
        const { code, stdout, stderr } = await runCli([
          'export',
          '-c',
          configPath,
          '-f',
          'json',
          '--limit',
          '3',
        ])
        expect(code).toBe(0)
        expect(stderr).toContain('Exported 3 of 10 records')

        const exported = JSON.parse(stdout) as AuditRecord[]
        expect(exported).toHaveLength(3)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('CSV includes flagged_destructive values', async () => {
      const { dir, configPath } = setupExport([
        makeRecord({ tool_name: 'safe', flagged_destructive: false }),
        makeRecord({ tool_name: 'dangerous', flagged_destructive: true }),
      ])

      try {
        const { code, stdout } = await runCli(['export', '-c', configPath, '-f', 'csv'])
        expect(code).toBe(0)

        const lines = stdout.trim().split('\n')
        // Find the flagged_destructive column index from the header
        const headers = (lines[0] ?? '').split(',')
        const fdIdx = headers.indexOf('flagged_destructive')
        expect(fdIdx).toBeGreaterThan(-1)

        // Check values in data rows
        const values = lines.slice(1).map((line) => line.split(',')[fdIdx])
        expect(values.sort()).toEqual(['false', 'true'])
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })
})
