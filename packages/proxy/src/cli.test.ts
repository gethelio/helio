import { describe, it, expect, beforeAll } from 'vitest'
import { execFile, spawn } from 'node:child_process'
import { existsSync, writeFileSync, rmSync, mkdtempSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { AuditStore } from './audit/store.js'
import type { AuditRecord } from './audit/types.js'
import { BudgetLedger } from './budget/ledger.js'
import type { BudgetLedgerRow } from './budget/engine.js'

const CLI_PATH = join(import.meta.dirname, '../dist/cli.js')

/** Run the CLI and capture output. */
function runCli(
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('node', [CLI_PATH, ...args], env ? { env } : {}, (error, stdout, stderr) => {
      resolve({
        code: typeof error?.code === 'number' ? error.code : error ? 1 : 0,
        stdout,
        stderr,
      })
    })
  })
}

/**
 * Spawn `helio start` and collect stderr until every ready marker has
 * appeared (in any order), then kill the process. Used by start-command
 * tests to assert on startup log lines without depending on real upstream
 * connectivity.
 *
 * The snapshot resolves as soon as the markers match — there is no grace
 * window. A test asserting a line is ABSENT must anchor on a marker the CLI
 * prints AFTER the absent line's print site, so the snapshot provably
 * covers the window where that line would have appeared.
 */
async function startAndCaptureStderr(
  args: string[],
  options: {
    readyMarker?: RegExp | RegExp[]
    timeoutMs?: number
    env?: NodeJS.ProcessEnv
  } = {},
): Promise<string> {
  const readyMarkers = [options.readyMarker ?? /Helio proxy listening/].flat()
  // Stateful regexes would advance lastIndex across the per-chunk re-tests
  // and could wedge the wait; an empty list would resolve on the first chunk.
  if (readyMarkers.length === 0 || readyMarkers.some((m) => m.global || m.sticky)) {
    throw new Error('readyMarker must be one or more regexes without the g/y flags')
  }
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

    const finish = (result: string | Error) => {
      if (settled) return
      settled = true
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
      if (readyMarkers.every((marker) => marker.test(stderr))) {
        clearTimeout(timer)
        finish(stderr)
      }
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      finish(err instanceof Error ? err : new Error(String(err)))
    })

    // 'close' rather than 'exit': the rejection embeds stderr, and 'exit'
    // can fire before the final pipe chunks (e.g. the config error itself)
    // have been delivered.
    child.on('close', (code) => {
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

/** Grab a port that was just free, for fast-ECONNREFUSED connect failures. */
function getClosedPort(): Promise<number> {
  return new Promise<number>((resolve) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port
      srv.close(() => {
        resolve(port)
      })
    })
  })
}

/** Path of the MCP-speaking stdio child fixture (see the file's header). */
const STDIO_MCP_FIXTURE = join(import.meta.dirname, '__tests__', 'helpers', 'stdio-mcp-fixture.cjs')

/**
 * Write a two-entry named-mode config whose stdio children each advertise a
 * tool named after their entry (`files_ping` / `github_ping`).
 */
function writeTwoUpstreamConfig(): { dir: string; configPath: string; listenPort: number } {
  const dir = mkdtempSync(join(tmpdir(), 'helio-cli-multi-'))
  const configPath = join(dir, 'helio.yaml')
  const listenPort = 40_000 + Math.floor(Math.random() * 20_000)
  writeFileSync(
    configPath,
    `
version: "1"
upstreams:
  - name: files
    url: "http://127.0.0.1:1/mcp"
    transport: stdio
    command: "node"
    args: ["${STDIO_MCP_FIXTURE}", "files_ping"]
  - name: github
    url: "http://127.0.0.1:1/mcp"
    transport: stdio
    command: "node"
    args: ["${STDIO_MCP_FIXTURE}", "github_ping"]
listen:
  port: ${String(listenPort)}
  host: 127.0.0.1
dashboard:
  enabled: false
policies:
  default: allow
  rules:
    - name: deny-probe
      match:
        tool: "denied_probe"
      action: deny
audit:
  path: "${join(dir, 'audit.db')}"
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

/**
 * Wait for child process exit with timeout. Resolves on 'close' (exit AND
 * stdio streams flushed) rather than 'exit', so callers may assert on
 * captured stderr immediately afterwards without racing the final chunks.
 */
async function waitForChildExit(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const exited = child.exitCode !== null || child.signalCode !== null
  if (exited && (child.stderr === null || child.stderr.destroyed)) {
    return { code: child.exitCode, signal: child.signalCode }
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for child process exit after ${String(timeoutMs)}ms`))
    }, timeoutMs)
    timer.unref()

    child.once('close', (code, signal) => {
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

    it('scaffolds a commented upstreams: pointer stub (issue #293)', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'helio-cli-test-'))
      const outPath = join(dir, 'helio.yaml')

      try {
        const { code } = await runCli(['init', '-o', outPath])
        expect(code).toBe(0)

        const contents = readFileSync(outPath, 'utf-8')
        expect(contents).toContain('\n# upstreams:\n')
        expect(contents).toContain('# Multiple named upstreams (multi-upstream mode)')
        expect(contents).toContain('#   - name: files')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('scaffolds every top-level section in canonical order', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'helio-cli-test-'))
      const outPath = join(dir, 'helio.yaml')

      try {
        const { code } = await runCli(['init', '-o', outPath])
        expect(code).toBe(0)

        const contents = readFileSync(outPath, 'utf-8')
        expect(contents).toContain('\n# environment: production\n')
        expect(contents).toContain('\n# budgets:\n')

        const canonicalOrder = [
          'version',
          'upstream',
          'upstreams',
          'listen',
          'environment',
          'session',
          'policies',
          'budgets',
          'approval',
          'audit',
          'dashboard',
          'sdk',
        ]
        let cursor = -1
        for (const key of canonicalOrder) {
          const match = new RegExp(`^(?:#\\s*)?${key}:`, 'm').exec(contents)
          expect(match, `top-level \`${key}:\` stub missing from the scaffold`).not.toBeNull()
          const index = match?.index ?? -1
          expect(index, `\`${key}:\` is out of canonical order`).toBeGreaterThan(cursor)
          cursor = index
        }
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

    it('accepts a named multi-upstream config fully (issue #293)', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'helio-cli-test-'))
      const configPath = join(dir, 'helio.yaml')

      const namedConfig = `
version: "1"
upstreams:
  - name: files
    url: "http://localhost:8081/mcp"
  - name: search
    url: "http://localhost:8082/mcp"
    transport: streamable-http
dashboard:
  enabled: false
`
      writeFileSync(configPath, namedConfig)

      try {
        const { code, stderr } = await runCli(['validate', '-c', configPath])
        expect(code).toBe(0)
        expect(stderr).toContain(`Config is valid: ${configPath} (0 policy rules, 0 budgets)`)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    describe('named-mode acceptance matrix (issue #293)', () => {
      const NAMED_HEADER = [
        'version: "1"',
        'upstreams:',
        '  - name: files',
        '    url: "http://localhost:8081/mcp"',
        '  - name: search',
        '    url: "http://localhost:8082/mcp"',
      ].join('\n')
      const FOOTER = 'dashboard:\n  enabled: false\n'

      const rejectionCases: Array<[string, string, string[]]> = [
        [
          'both upstream: and upstreams:',
          `version: "1"\nupstream:\n  url: "http://localhost:8080/mcp"\nupstreams:\n  - name: files\n    url: "http://localhost:8081/mcp"\n${FOOTER}`,
          ['upstreams: Set exactly one of'],
        ],
        [
          'neither upstream: nor upstreams:',
          `version: "1"\n${FOOTER}`,
          ['(top level): Missing upstream configuration'],
        ],
        [
          'empty upstreams: list',
          `version: "1"\nupstreams: []\n${FOOTER}`,
          ['would serve nothing'],
        ],
        [
          'duplicate entry names',
          `version: "1"\nupstreams:\n  - name: files\n    url: "http://localhost:8081/mcp"\n  - name: files\n    url: "http://localhost:8082/mcp"\n${FOOTER}`,
          ['upstreams.1.name: Duplicate upstream name "files"'],
        ],
        [
          'entry name outside the charset',
          `version: "1"\nupstreams:\n  - name: "bad name"\n    url: "http://localhost:8081/mcp"\n${FOOTER}`,
          ['upstreams.0.name: Upstream names may only contain letters, digits, "_" and "-"'],
        ],
        [
          'stdio entry missing command',
          `version: "1"\nupstreams:\n  - name: files\n    url: "unused"\n    transport: stdio\n${FOOTER}`,
          ['upstreams.0.command: "command" is required when transport is "stdio"'],
        ],
        [
          'rule naming an unknown upstream',
          `${NAMED_HEADER}\npolicies:\n  rules:\n    - match:\n        tool: "*"\n        upstreams: [ghost]\n      action: deny\n${FOOTER}`,
          ['policies.rules.0.match.upstreams.0: Rule names upstream "ghost"'],
        ],
        [
          'rule combining upstreams with metadata',
          `${NAMED_HEADER}\npolicies:\n  rules:\n    - match:\n        upstreams: [files]\n        metadata:\n          channel_id: "C1"\n      action: deny\n${FOOTER}`,
          ['match.upstreams cannot be combined with match.metadata'],
        ],
        [
          'sender_id budget with only scoped contributors',
          `${NAMED_HEADER}\nbudgets:\n  - name: cap\n    limit: 100\n    currency: USD\n    window: 24h\n    key: sender_id\n    on_exceed: deny\n    contributors:\n      - match:\n          tool: "stripe_*"\n          upstreams: [files]\n        field: "$.amount"\nsdk:\n  enabled: true\n${FOOTER}`,
          ['budgets.0.key: budget key "sender_id" requires at least one contributor'],
        ],
        [
          'evidence-gated rule under the default legacy_header chain',
          `${NAMED_HEADER}\npolicies:\n  rules:\n    - match:\n        tool: "*"\n      action: allow\n      requires: [deploy_ticket]\n${FOOTER}`,
          ['session.identity.1: session.identity includes "legacy_header"'],
        ],
      ]

      it.each(rejectionCases)('rejects %s', async (_name, yamlBody, fragments) => {
        const dir = mkdtempSync(join(tmpdir(), 'helio-cli-test-'))
        const configPath = join(dir, 'helio.yaml')
        writeFileSync(configPath, yamlBody)
        try {
          const { code, stderr } = await runCli(['validate', '-c', configPath])
          expect(code).toBe(1)
          expect(stderr).toContain('Invalid config')
          for (const fragment of fragments) {
            expect(stderr).toContain(fragment)
          }
        } finally {
          rmSync(dir, { recursive: true, force: true })
        }
      })

      it('accepts a governance-rich named config end to end', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'helio-cli-test-'))
        const configPath = join(dir, 'helio.yaml')
        writeFileSync(
          configPath,
          `${NAMED_HEADER}\n` +
            'session:\n' +
            '  identity:\n' +
            '    - source: header\n' +
            '      name: x-helio-session-id\n' +
            'policies:\n' +
            '  rules:\n' +
            '    - match:\n' +
            '        tool: "send_*"\n' +
            '        upstreams: [files]\n' +
            '      action: deny\n' +
            'budgets:\n' +
            '  - name: cap\n' +
            '    limit: 100\n' +
            '    currency: USD\n' +
            '    window: 24h\n' +
            '    key: global\n' +
            '    on_exceed: deny\n' +
            '    contributors:\n' +
            '      - match:\n' +
            '          tool: "stripe_*"\n' +
            '          upstreams: [files, search]\n' +
            '        field: "$.amount"\n' +
            FOOTER,
        )
        try {
          const { code, stderr } = await runCli(['validate', '-c', configPath])
          expect(code).toBe(0)
          expect(stderr).toContain(`Config is valid: ${configPath} (1 policy rule, 1 budget)`)
        } finally {
          rmSync(dir, { recursive: true, force: true })
        }
      })
    })

    it('warns above 16 upstreams while still validating (issue #293)', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'helio-cli-test-'))
      const configPath = join(dir, 'helio.yaml')

      const entries = Array.from(
        { length: 17 },
        (_, i) => `  - name: up-${String(i)}\n    url: "http://localhost:${String(9000 + i)}/mcp"`,
      ).join('\n')
      writeFileSync(
        configPath,
        `version: "1"\nupstreams:\n${entries}\ndashboard:\n  enabled: false\n`,
      )

      try {
        const { code, stderr } = await runCli(['validate', '-c', configPath])
        expect(code).toBe(0)
        expect(stderr).toContain('17 upstreams configured')
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

    it('renders the exact path and message for a missing scalar field', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'helio-cli-test-'))
      const configPath = join(dir, 'helio.yaml')

      // upstream present but upstream.url omitted → exactly one error, on the
      // scalar. Pins the rendered CLI output so a future Zod message change (as
      // happened on the v3→v4 upgrade) fails here instead of silently drifting
      // from docs/configuration.md.
      writeFileSync(
        configPath,
        'version: "1"\nupstream:\n  transport: streamable-http\ndashboard:\n  enabled: false\n',
      )

      try {
        const { code, stderr } = await runCli(['validate', '-c', configPath])
        expect(code).toBe(1)
        expect(stderr).toContain('Invalid config: Invalid configuration (1 error)')
        expect(stderr).toContain('upstream.url: Invalid input: expected string, received undefined')
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

    it('rejects an unknown top-level key, naming it (issue #167)', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'helio-cli-test-'))
      const configPath = join(dir, 'helio.yaml')

      // The shape a user naturally writes: rules: at the top level instead
      // of nested under policies:.
      writeFileSync(
        configPath,
        `
version: "1"
upstream:
  url: "http://localhost:8080/mcp"
dashboard:
  enabled: false
rules:
  - match:
      tool: "delete_*"
    action: deny
`,
      )

      try {
        const { code, stderr } = await runCli(['validate', '-c', configPath])
        expect(code).toBe(1)
        expect(stderr).toContain('Invalid config: Invalid configuration (1 error)')
        expect(stderr).toContain('(top level): Unrecognized key: "rules"')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('rejects a config with an unknown key inside a section (issue #182)', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'helio-cli-test-'))
      const configPath = join(dir, 'helio.yaml')

      writeFileSync(
        configPath,
        `
version: "1"
upstream:
  url: "http://localhost:8080/mcp"
  request_timout: "5s"
dashboard:
  enabled: false
`,
      )

      try {
        const { code, stderr } = await runCli(['validate', '-c', configPath])
        expect(code).toBe(1)
        expect(stderr).toContain('Invalid config: Invalid configuration (1 error)')
        expect(stderr).toContain('upstream: Unrecognized key: "request_timout"')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('reports the budgets count alongside the policy rule count', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'helio-cli-test-'))
      const configPath = join(dir, 'helio.yaml')

      writeFileSync(
        configPath,
        `
version: "1"
upstream:
  url: "http://localhost:8080/mcp"
dashboard:
  enabled: false
policies:
  rules:
    - name: block-delete
      match:
        tool: "delete_*"
      action: deny
    - name: block-drop
      match:
        tool: "drop_*"
      action: deny
budgets:
  - name: openai-daily
    limit: 25
    currency: USD
    window: 1d
    contributors:
      - match:
          tool: "openai_*"
        field: "$.usage.total_cost"
`,
      )

      try {
        const { code, stderr } = await runCli(['validate', '-c', configPath])
        expect(code).toBe(0)
        expect(stderr).toContain('(2 policy rules, 1 budget)')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('fails fast when a ${VAR} secret reference is unset', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'helio-cli-test-'))
      const configPath = join(dir, 'helio.yaml')

      // A hand-authored config using the documented ${HELIO_DASHBOARD_SECRET}
      // placeholder without exporting it must fail loudly, not run unauthenticated.
      writeFileSync(
        configPath,
        `
version: "1"
upstream:
  url: "http://localhost:8080/mcp"
dashboard:
  enabled: true
  api_secret: "\${HELIO_DASHBOARD_SECRET}"
`,
      )

      const env = { ...process.env }
      delete env['HELIO_DASHBOARD_SECRET']

      try {
        const { code, stderr } = await runCli(['validate', '-c', configPath], env)
        expect(code).toBe(1)
        expect(stderr).toContain('Environment variable "HELIO_DASHBOARD_SECRET" is not set')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
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
      expect(validate.stderr).toContain('(0 policy rules, 0 budgets)')

      const contents = readFileSync(configPath, 'utf-8')
      expect(contents).toMatch(/dashboard:[\s\S]*?api_secret:\s*"[a-f0-9]{64}"/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('uncommenting only the budgets stub yields a config with one budget', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'helio-cli-test-'))
    const configPath = join(dir, 'helio.yaml')

    try {
      const init = await runCli(['init', '-o', configPath])
      expect(init.code).toBe(0)

      const contents = readFileSync(configPath, 'utf-8')
      const stub = /^# budgets:\n(?:#.*\n)*/m.exec(contents)?.[0] ?? ''
      expect(stub, 'commented `# budgets:` stub missing from the scaffold').not.toBe('')
      expect(stub, 'stub capture must stop at the end of the budgets block').toMatch(
        /field: '\$\.total'\n$/,
      )
      writeFileSync(
        configPath,
        contents.replace(stub, () => stub.replace(/^# ?/gm, '')),
      )

      const validate = await runCli(['validate', '-c', configPath])
      expect(validate.code).toBe(0)
      expect(validate.stderr).toContain('Config is valid')
      expect(validate.stderr).toContain('(0 policy rules, 1 budget)')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // --- helio start ---

  describe('start', () => {
    it('watches the config file for policy changes by default', async () => {
      const { dir, configPath } = writeStartConfig()
      try {
        const stderr = await startAndCaptureStderr(['-c', configPath], {
          readyMarker: /for policy changes/,
        })
        expect(stderr).toContain(`Watching ${configPath} for policy changes`)
        expect(stderr).not.toContain('Hot-reload disabled')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 15_000)

    it('disables the config watcher when --no-hot-reload is set', async () => {
      const { dir, configPath } = writeStartConfig()
      try {
        const stderr = await startAndCaptureStderr(['-c', configPath, '--no-hot-reload'], {
          readyMarker: /Hot-reload disabled/,
        })
        expect(stderr).toContain('Hot-reload disabled')
        expect(stderr).not.toContain(`Watching ${configPath} for policy changes`)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 15_000)

    it('refuses to boot when the config has an unknown top-level key (issue #167)', async () => {
      const { dir, configPath } = writeStartConfig()
      try {
        // The money-gate scenario: a typo'd budget: key. The proxy must exit
        // before listening, not boot with the budget silently dropped.
        const original = readFileSync(configPath, 'utf-8')
        writeFileSync(configPath, original + 'budget:\n  - name: openai-daily\n')
        await expect(startAndCaptureStderr(['-c', configPath])).rejects.toThrow(
          /Unrecognized key: "budget"/,
        )
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 15_000)

    it('refuses to boot when a section carries an unknown key (issue #182)', async () => {
      const { dir, configPath } = writeStartConfig()
      try {
        // The sideband-gate scenario: a typo'd sdk enable key. The proxy
        // must exit before listening, not boot with the sideband silently
        // disabled.
        const original = readFileSync(configPath, 'utf-8')
        writeFileSync(configPath, original + 'sdk:\n  enable: true\n')
        await expect(startAndCaptureStderr(['-c', configPath])).rejects.toThrow(
          /sdk: Unrecognized key: "enable"/,
        )
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 15_000)

    it('serves a two-entry named config end to end (issue #294)', async () => {
      const { dir, configPath, listenPort } = writeTwoUpstreamConfig()
      const baseUrl = `http://127.0.0.1:${String(listenPort)}`
      const child = spawn('node', [CLI_PATH, 'start', '-c', configPath], {
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      let stderr = ''
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf-8')
      })
      try {
        // A pre-healthy exit (e.g. a boot refusal) must surface its stderr
        // instead of a bare health-poll timeout.
        await Promise.race([
          waitForProxyHealth(baseUrl, 8_000),
          new Promise<never>((_, reject) => {
            child.on('close', (code) => {
              reject(
                new Error(`helio start exited ${String(code)} before healthy. stderr:\n${stderr}`),
              )
            })
          }),
        ])

        // The acceptance leg: each door serves ITS OWN child's entry-named
        // tool over real HTTP. Status alone cannot prove the mount wiring;
        // the tool NAME can. Content-Type is required or the door 415s.
        for (const [name, toolName, id] of [
          ['files', 'files_ping', 1],
          ['github', 'github_ping', 2],
        ] as const) {
          const res = await fetch(`${baseUrl}/mcp/${name}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list' }),
          })
          expect(res.status).toBe(200)
          const body = (await res.json()) as { result: { tools: Array<{ name: string }> } }
          expect(body.result.tools[0]?.name).toBe(toolName)
        }

        // Catch-alls over real HTTP: bare prefix and unknown name get the
        // exact id-less envelope.
        for (const path of ['/mcp', '/mcp/ghost']) {
          const res = await fetch(`${baseUrl}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' }),
          })
          expect(res.status).toBe(404)
          expect(res.headers.get('content-type')).toContain('application/json')
          const body = (await res.json()) as Record<string, unknown>
          expect(body).toEqual({
            jsonrpc: '2.0',
            error: {
              code: -32600,
              message:
                'No MCP endpoint answers this request: this Helio serves named upstreams at /mcp/<name>.',
            },
          })
          expect('id' in body).toBe(false)
        }

        // The door serves the GOVERNED forwarder, not the raw transport: a
        // deny rule answers with the policy envelope instead of relaying.
        const deniedRes = await fetch(`${baseUrl}/mcp/files`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 9,
            method: 'tools/call',
            params: { name: 'denied_probe', arguments: {} },
          }),
        })
        const deniedBody = (await deniedRes.json()) as {
          error?: { code: number; data?: { blocked?: boolean } }
        }
        expect(deniedBody.error?.code).toBe(-32001)
        expect(deniedBody.error?.data?.blocked).toBe(true)

        // Per-entry startup lines and name-tagged prime lines.
        expect(stderr).toContain('Upstream[files]: node (stdio)')
        expect(stderr).toContain('Upstream[github]: node (stdio)')
        expect(stderr).toMatch(/\[helio\]\[files\] Annotation cache primed/)
        expect(stderr).toMatch(/\[helio\]\[github\] Annotation cache primed/)

        // Clean shutdown.
        const exitCode = await new Promise<number | null>((resolve) => {
          if (child.exitCode !== null) {
            resolve(child.exitCode)
            return
          }
          child.on('close', (code) => {
            resolve(code)
          })
          child.kill('SIGTERM')
        })
        expect(exitCode).toBe(0)
      } finally {
        if (child.exitCode === null) child.kill('SIGKILL')
        rmSync(dir, { recursive: true, force: true })
      }
    }, 15_000)

    it('all-or-nothing boot: an unreachable entry fails startup naming it (issue #294)', async () => {
      const closedPort = await getClosedPort()
      const dir = mkdtempSync(join(tmpdir(), 'helio-cli-multi-fail-'))
      const configPath = join(dir, 'helio.yaml')
      const listenPort = 40_000 + Math.floor(Math.random() * 20_000)
      writeFileSync(
        configPath,
        `
version: "1"
upstreams:
  - name: files
    url: "http://127.0.0.1:1/mcp"
    transport: stdio
    command: "node"
    args: ["${STDIO_MCP_FIXTURE}", "files_ping"]
  - name: backend
    url: "http://127.0.0.1:${String(closedPort)}/sse"
    transport: sse
    connect_timeout: "2s"
listen:
  port: ${String(listenPort)}
  host: 127.0.0.1
dashboard:
  enabled: false
audit:
  path: "${join(dir, 'audit.db')}"
`,
      )
      try {
        const result = await runCli(['start', '-c', configPath])
        expect(result.code).toBe(1)
        expect(result.stderr).toContain('upstream "backend": ')
        expect(result.stderr).toContain('is unreachable (ECONNREFUSED)')
        expect(result.stderr).not.toContain('Unhandled promise rejection')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 15_000)

    it('warns before connecting when more than 16 upstreams are configured (issue #294)', async () => {
      const closedPort = await getClosedPort()
      const dir = mkdtempSync(join(tmpdir(), 'helio-cli-multi-many-'))
      const configPath = join(dir, 'helio.yaml')
      const listenPort = 40_000 + Math.floor(Math.random() * 20_000)
      const entries = Array.from(
        { length: 17 },
        (_, i) =>
          `  - name: u${String(i)}\n` +
          `    url: "http://127.0.0.1:${String(closedPort)}/sse"\n` +
          '    transport: sse\n' +
          '    connect_timeout: "2s"\n',
      ).join('')
      writeFileSync(
        configPath,
        `version: "1"\nupstreams:\n${entries}listen:\n  port: ${String(listenPort)}\n  host: 127.0.0.1\ndashboard:\n  enabled: false\naudit:\n  path: "${join(dir, 'audit.db')}"\n`,
      )
      try {
        const result = await runCli(['start', '-c', configPath])
        expect(result.code).toBe(1)
        const warningIndex = result.stderr.indexOf('[helio] Warning: 17 upstreams configured.')
        const failureIndex = result.stderr.indexOf('upstream "u0": ')
        expect(warningIndex).toBeGreaterThanOrEqual(0)
        expect(failureIndex).toBeGreaterThanOrEqual(0)
        // The operator hears the warning even though entry 1 fails: it
        // prints BEFORE the connect loop.
        expect(warningIndex).toBeLessThan(failureIndex)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 15_000)

    it('start with a stale legacy audit DB exits 1 with the recovery message alone (issue #233)', async () => {
      const { dir, configPath } = writeStdioStartConfig('30s')
      const auditPath = join(dir, 'audit.db')
      const staleDb = new Database(auditPath)
      // The issue's repro table: MANY required columns missing. A DB missing
      // only `upstream` is silently repaired on open (the #292 additive
      // exception) and would boot clean instead of reproducing.
      staleDb.exec(
        'CREATE TABLE audit_records (' +
          'id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, tool_name TEXT NOT NULL, ' +
          'policy_decision TEXT NOT NULL, matched_rule TEXT, tool_input TEXT, ' +
          'flagged_destructive INTEGER, dry_run INTEGER)',
      )
      staleDb.close()

      try {
        const result = await runCli(['start', '-c', configPath])
        expect(result.code).toBe(1)
        expect(result.stderr).toContain(
          '[helio] Audit DB schema mismatch: missing required columns',
        )
        expect(result.stderr).toContain('then restart Helio.')
        expect(result.stderr).not.toContain('Unhandled promise rejection')
        expect(result.stderr).not.toMatch(/\n\s+at /)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 15_000)

    it('start with an unreachable singular sse upstream exits 1 with the connect error alone (issue #233)', async () => {
      // Grab a port that was just free, so the connect fails fast with
      // ECONNREFUSED instead of eating the connect timeout.
      const closedPort = await new Promise<number>((resolve) => {
        const srv = createServer()
        srv.listen(0, '127.0.0.1', () => {
          const port = (srv.address() as AddressInfo).port
          srv.close(() => {
            resolve(port)
          })
        })
      })
      const dir = mkdtempSync(join(tmpdir(), 'helio-cli-sse-conn-'))
      const configPath = join(dir, 'helio.yaml')
      const listenPort = 40_000 + Math.floor(Math.random() * 20_000)
      writeFileSync(
        configPath,
        `
version: "1"
upstream:
  url: "http://127.0.0.1:${String(closedPort)}/sse"
  transport: sse
  connect_timeout: "2s"
listen:
  port: ${String(listenPort)}
  host: 127.0.0.1
dashboard:
  enabled: false
audit:
  path: "${join(dir, 'audit.db')}"
`,
      )

      try {
        const result = await runCli(['start', '-c', configPath])
        expect(result.code).toBe(1)
        expect(result.stderr).toContain('is unreachable (ECONNREFUSED)')
        // Singular mode: the underlying message alone — no minted upstream
        // name, no crash dump.
        expect(result.stderr).not.toContain('upstream "')
        expect(result.stderr).not.toContain('Unhandled promise rejection')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 15_000)

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
    }, 15_000)

    it('starts in headless mode when dashboard assets are missing and dashboard.enabled is false', async () => {
      const { dir, configPath } = writeStartConfig()
      const missingAssetsDir = join(dir, 'missing-dashboard-assets')
      try {
        const original = readFileSync(configPath, 'utf-8')
        const headless = original.replace('enabled: true', 'enabled: false')
        writeFileSync(configPath, headless)
        const stderr = await startAndCaptureStderr(['-c', configPath], {
          // "Watching ... for policy changes" is the last startup line,
          // printed after the point where "Dashboard API listening" would
          // have appeared — the snapshot covers the absence assertion.
          readyMarker: /for policy changes/,
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
    }, 15_000)

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

        const original = readFileSync(configPath, 'utf-8')
        const updated = original.replace(
          /listen:\n\s*port: (\d+)/,
          (_full, port: string) => `listen:\n  port: ${String(Number(port) + 1)}`,
        )
        expect(updated).not.toBe(original)

        // The Watching line prints from chokidar's ready hook, so the
        // marker above means the initial scan is done and the watcher is
        // armed. One gap remains below that API: on macOS the kernel
        // FSEvents stream goes live a few milliseconds AFTER ready, and a
        // write inside that window is dropped by the OS (measured
        // sub-5ms and load-independent; Linux inotify has no such gap).
        // The grace covers it with ~20x margin, so exactly ONE write
        // suffices — a watcher that drops the first change event now
        // fails this test.
        const WATCH_ARM_GRACE_MS = 100
        await new Promise((resolve) => setTimeout(resolve, WATCH_ARM_GRACE_MS))
        writeFileSync(configPath, updated)
        await waitForLog(
          () => stderr.includes('Restart required: non-reloadable fields changed'),
          8_000,
        )
        expect(stderr).toContain('Restart required: non-reloadable fields changed')
        // The banner's "Helio proxy listening" also contains "listen" — match
        // the changed path inside the warning's parenthesized list instead.
        expect(stderr).toMatch(/non-reloadable fields changed \([^)]*\blisten\b/)
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
        await waitForProxyHealth(baseUrl, 8_000)

        // The signal also times the body read below, so it must outlast the
        // 8s heartbeat bound or the race rejects with a bare AbortError.
        const eventsRes = await fetch(`http://127.0.0.1:${String(dashboardPort)}/api/events`, {
          headers: { authorization: `Bearer ${apiSecret}` },
          signal: AbortSignal.timeout(10_000),
        })
        expect(eventsRes.status).toBe(200)
        expect(eventsRes.body).not.toBeNull()

        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- asserted above
        reader = eventsRes.body!.getReader()
        const decoder = new TextDecoder()
        let heartbeatTimer: ReturnType<typeof setTimeout> | undefined
        const firstChunk = await Promise.race([
          reader.read(),
          new Promise<never>((_resolve, reject) => {
            // The endpoint writes a heartbeat immediately on connect; the
            // bound only caps how long a genuinely broken stream can hang.
            heartbeatTimer = setTimeout(() => {
              reject(new Error('Timed out waiting for SSE heartbeat chunk'))
            }, 8_000)
          }),
        ])
        clearTimeout(heartbeatTimer)
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
          '[helio] Annotation cache primed: 2 tool definitions baselined for drift detection',
        )
        expect(upstream.calls.some((call) => call.method === 'tools/list')).toBe(true)
      } finally {
        await upstream.close()
        rmSync(dir, { recursive: true, force: true })
      }
    }, 15_000)

    it('continues startup when initial annotation prime fails, remaining fail-closed', async () => {
      const { dir, configPath } = writeStartConfig()
      try {
        const stderr = await startAndCaptureStderr(['-c', configPath], {
          // The initial prime is awaited before the banner but only for
          // 1.5s, so under load the failure line can print on either side
          // of "Helio proxy listening" — require both before snapshotting.
          readyMarker: [/Helio proxy listening/, /Annotation cache priming failed:/],
          timeoutMs: 8_000,
        })
        expect(stderr).toContain('Helio proxy listening')
        expect(stderr).toContain('Annotation cache priming failed:')
        expect(stderr).toContain('fail-closed')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 15_000)

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
        await waitForProxyHealth(baseUrl, 8_000)

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

    it('resolves a require_approval call through the dashboard approve endpoint', async () => {
      const upstream = await startMockMcpServer((payload) => {
        const id = payload['id'] ?? null
        if (payload['method'] === 'tools/list') {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              tools: [{ name: 'create_payment', annotations: { destructiveHint: false } }],
            },
          }
        }
        return {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: 'payment-sent' }] },
        }
      })

      const dir = mkdtempSync(join(tmpdir(), 'helio-cli-approval-'))
      const configPath = join(dir, 'helio.yaml')
      const listenPort = 40_000 + Math.floor(Math.random() * 20_000)
      const dashboardPort = listenPort + 1
      const auditPath = join(dir, 'audit.db')
      const secret = `test-secret-${String(listenPort)}`
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
  enabled: true
  port: ${String(dashboardPort)}
  host: 127.0.0.1
  api_secret: "${secret}"
approval:
  channels:
    - type: dashboard
policies:
  default: allow
  rules:
    - name: approve-payments
      match:
        tool: "create_payment"
      action: require_approval
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
        const dashUrl = `http://127.0.0.1:${String(dashboardPort)}`
        await waitForProxyHealth(baseUrl, 8_000)

        // The require_approval rule holds the call open, so do NOT await yet.
        const callPromise = fetch(`${baseUrl}/mcp`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'create_payment', arguments: { amount: 10 } },
          }),
          signal: AbortSignal.timeout(12_000),
        })

        // Poll the dashboard approvals queue until the pending ticket appears.
        const authHeader = { authorization: `Bearer ${secret}` }
        let ticketId: string | undefined
        for (let i = 0; i < 40 && ticketId === undefined; i++) {
          const listRes = await fetch(`${dashUrl}/api/approvals`, { headers: authHeader })
          if (listRes.ok) {
            const list = (await listRes.json()) as {
              data?: Array<{ id: string; tool_name: string }>
            }
            ticketId = (list.data ?? []).find((t) => t.tool_name === 'create_payment')?.id
          }
          if (ticketId === undefined) await new Promise((r) => setTimeout(r, 100))
        }
        expect(ticketId).toBeDefined()

        // Resolve it via the dashboard REST API (the same router the proxy is
        // waiting on), which should unblock the pending /mcp call.
        const approveRes = await fetch(`${dashUrl}/api/approvals/${String(ticketId)}/approve`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeader },
          body: JSON.stringify({ approved_by: 'e2e-test' }),
        })
        expect(approveRes.status).toBe(200)

        const callRes = await callPromise
        const body = (await callRes.json()) as Record<string, unknown>
        expect(callRes.status).toBe(200)
        expect(body['error']).toBeUndefined()
        expect(JSON.stringify(body)).toContain('payment-sent')
        expect(
          upstream.calls.some((c) => c.method === 'tools/call' && c.name === 'create_payment'),
        ).toBe(true)
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
    }, 20_000)

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
          // The adapter line prints after the SDK line, so anchoring readiness
          // on it guarantees both banners are captured.
          readyMarker: /Adapter token \(generated per-boot HELIO_ADAPTER_TOKEN/,
          timeoutMs: 8_000,
        })
        expect(stderr).toContain(`SDK sideband listening on http://127.0.0.1:${String(sdkPort)}`)
        expect(stderr).toContain('generated per-boot HELIO_SDK_TOKEN')
        expect(stderr).toContain('Adapter token (generated per-boot HELIO_ADAPTER_TOKEN')
        // 32 bytes hex = 64 chars; one value per token, so both handoffs print.
        expect(stderr.match(/[a-f0-9]{64}/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 15_000)

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
      const presetToken = 'preset-token-value-that-must-not-appear-in-stderr'
      const presetAdapterToken = 'preset-adapter-token-that-must-not-appear-in-stderr'
      try {
        const stderr = await startAndCaptureStderr(['-c', configPath], {
          // "Watching ..." is the last startup line, so the snapshot spans
          // the whole startup block — a preset secret echoed anywhere in
          // it lands in the capture, not just at the token print sites.
          readyMarker: /for policy changes/,
          timeoutMs: 8_000,
          env: {
            ...process.env,
            HELIO_SDK_TOKEN: presetToken,
            HELIO_ADAPTER_TOKEN: presetAdapterToken,
          },
        })
        // Operator-provided secrets must not be echoed into process logs.
        expect(stderr).not.toContain(presetToken)
        expect(stderr).not.toContain(presetAdapterToken)
        expect(stderr).toContain(
          'SDK token: reusing HELIO_SDK_TOKEN from environment (value not shown)',
        )
        expect(stderr).toContain(
          'Adapter token: reusing HELIO_ADAPTER_TOKEN from environment (value not shown)',
        )
        expect(stderr).not.toContain('generated per-boot HELIO_SDK_TOKEN')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 15_000)

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
        const stderr = await startAndCaptureStderr(['-c', configPath], {
          // The disabled notice and "Watching ..." are exclusive branches of
          // the same if/else — once this marker prints, the watcher line
          // can never appear, so the absence assertion is race-free.
          readyMarker: /Hot-reload disabled/,
        })
        expect(stderr).toContain('Hot-reload disabled')
        expect(stderr).not.toContain(`Watching ${configPath} for policy changes`)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 15_000)

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
        await waitForProxyHealth(baseUrl, 8_000)

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
        session_source: null,
        protocol_version: null,
        upstream: null,
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
        record_kind: 'tool_call',
        origin: 'mcp',
        metadata: null,
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

      const inserted = store.insertBatch(records)
      if (inserted !== records.length) {
        throw new Error(`setupExport seeded ${String(inserted)}/${String(records.length)} records`)
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

    it('names the offending key when the config is invalid (issue #167)', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'helio-cli-test-'))
      const configPath = join(dir, 'helio.yaml')

      writeFileSync(
        configPath,
        `
version: "1"
upstream:
  url: "http://localhost:8080/mcp"
dashboard:
  enabled: false
budget:
  - name: openai-daily
`,
      )

      try {
        const { code, stderr } = await runCli(['export', '-c', configPath, '-f', 'json'])
        expect(code).toBe(1)
        expect(stderr).toContain('(top level): Unrecognized key: "budget"')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

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

    it('exports more than 1000 records when --limit allows it (#131)', async () => {
      const { dir, configPath } = setupExport(Array.from({ length: 1100 }, () => makeRecord()))

      try {
        const { code, stdout, stderr } = await runCli([
          'export',
          '-c',
          configPath,
          '-f',
          'json',
          '--limit',
          '2000',
        ])
        expect(code).toBe(0)
        expect(stderr).toContain('Exported 1100 of 1100 records')

        const records = JSON.parse(stdout) as AuditRecord[]
        expect(records).toHaveLength(1100)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 15_000)

    it('rejects a malformed --limit instead of silently truncating', async () => {
      const { dir, configPath } = setupExport([makeRecord()])

      try {
        for (const bad of ['5,000', 'abc', '50.7', '0']) {
          const { code, stderr } = await runCli(['export', '-c', configPath, '--limit', bad])
          expect(code).toBe(1)
          expect(stderr).toContain('--limit must be an integer between 1 and 10000')
        }

        // '1e3' is a valid integer (1000) and must not be rejected or truncated.
        const ok = await runCli(['export', '-c', configPath, '--limit', '1e3'])
        expect(ok.code).toBe(0)
        expect(ok.stderr).toContain('Exported 1 of 1 records')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 15_000)

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

    it('filters by upstream (issue #292)', async () => {
      const { dir, configPath } = setupExport([
        makeRecord({ upstream: 'github' }),
        makeRecord({ upstream: null }),
      ])

      try {
        const { code, stdout } = await runCli([
          'export',
          '-c',
          configPath,
          '-f',
          'json',
          '--upstream',
          'github',
        ])
        expect(code).toBe(0)

        const records = JSON.parse(stdout) as AuditRecord[]
        expect(records).toHaveLength(1)
        expect(records[0]?.upstream).toBe('github')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('rejects --budgets combined with --upstream, naming the flag (issue #292)', async () => {
      const { dir, configPath } = setupExport([makeRecord()])

      try {
        const { code, stderr } = await runCli([
          'export',
          '-c',
          configPath,
          '--budgets',
          'daily-cap',
          '--upstream',
          'github',
        ])
        expect(code).toBe(1)
        expect(stderr).toContain('--budgets cannot be combined with audit filters (--upstream)')
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

    it('CSV includes record_kind and origin but leaves metadata empty', async () => {
      const { dir, configPath } = setupExport([
        makeRecord({ origin: 'openclaw', metadata: { channel_id: 'C042' } }),
      ])

      try {
        const { code, stdout } = await runCli(['export', '-c', configPath, '-f', 'csv'])
        expect(code).toBe(0)

        const lines = stdout.trim().split('\n')
        const headers = (lines[0] ?? '').split(',')
        const cells = (lines[1] ?? '').split(',')
        expect(cells[headers.indexOf('record_kind')]).toBe('tool_call')
        expect(cells[headers.indexOf('origin')]).toBe('openclaw')

        // The CLI serializer leaves object-valued fields empty; metadata is
        // only populated in dashboard API CSV exports.
        const metadataIdx = headers.indexOf('metadata')
        expect(metadataIdx).toBeGreaterThan(-1)
        expect(cells[metadataIdx]).toBe('')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    // --- helio export --budgets ---

    describe('--budgets', () => {
      function budgetRow(overrides: Partial<BudgetLedgerRow> = {}): BudgetLedgerRow {
        return {
          budget_name: 'daily-cap',
          bucket_key: 'budget:daily-cap:global',
          kind: 'spend',
          amount: 25,
          currency: 'USD',
          tool_name: 'stripe_charge',
          origin: 'mcp',
          audit_record_id: 'audit-1',
          timestamp: '2026-07-10T12:00:00.000Z',
          timestamp_ms: 1_000_000,
          generation: 1,
          ...overrides,
        }
      }

      /** Create a temp dir with a seeded budget ledger and helio.yaml. */
      function setupBudgetExport(rows: BudgetLedgerRow[]) {
        const dir = mkdtempSync(join(tmpdir(), 'helio-export-'))
        const dbPath = join(dir, 'audit.db')
        const configPath = join(dir, 'helio.yaml')

        const store = new AuditStore({
          path: dbPath,
          retention: '90d',
          includeResponses: true,
          cleanupIntervalMs: 0,
        })
        const ledger = new BudgetLedger({ database: store.database })
        ledger.commitAll(rows)
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

      const BUDGET_CSV_HEADER =
        'id,budget_name,bucket_key,kind,amount,currency,tool_name,origin,' +
        'audit_record_id,timestamp,timestamp_ms,created_at,upstream'

      it('exports a budget ledger as CSV, newest first', async () => {
        const { dir, configPath } = setupBudgetExport([
          budgetRow({ timestamp_ms: 1_000, tool_name: 'older' }),
          budgetRow({ timestamp_ms: 2_000, tool_name: 'newer' }),
        ])

        try {
          const { code, stdout, stderr } = await runCli([
            'export',
            '-c',
            configPath,
            '--budgets',
            'daily-cap',
            '-f',
            'csv',
          ])
          expect(code).toBe(0)
          expect(stderr).toContain('Exported 2 of 2 records')

          const lines = stdout.trim().split('\n')
          expect(lines[0]).toBe(BUDGET_CSV_HEADER)
          expect(lines[1]).toContain('newer')
          expect(lines[2]).toContain('older')
        } finally {
          rmSync(dir, { recursive: true, force: true })
        }
      })

      it('exports a budget ledger as a bare JSON array', async () => {
        const { dir, configPath } = setupBudgetExport([
          budgetRow({ timestamp_ms: 1_000, tool_name: 'older' }),
          budgetRow({ timestamp_ms: 2_000, tool_name: 'newer' }),
        ])

        try {
          const { code, stdout, stderr } = await runCli([
            'export',
            '-c',
            configPath,
            '--budgets',
            'daily-cap',
            '-f',
            'json',
          ])
          expect(code).toBe(0)
          expect(stderr).toContain('Exported 2 of 2 records')

          const events = JSON.parse(stdout) as Array<Record<string, unknown>>
          expect(events.map((e) => e['tool_name'])).toEqual(['newer', 'older'])
          expect(events[0]).not.toHaveProperty('epoch')
        } finally {
          rmSync(dir, { recursive: true, force: true })
        }
      })

      it('rejects --budgets combined with audit filter flags', async () => {
        const { dir, configPath } = setupBudgetExport([budgetRow()])

        try {
          const { code, stderr } = await runCli([
            'export',
            '-c',
            configPath,
            '--budgets',
            'daily-cap',
            '--decision',
            'deny',
          ])
          expect(code).toBe(1)
          expect(stderr).toContain('--budgets cannot be combined')
        } finally {
          rmSync(dir, { recursive: true, force: true })
        }
      })

      it('keeps the newest rows when --limit truncates', async () => {
        const { dir, configPath } = setupBudgetExport([
          budgetRow({ timestamp_ms: 1_000, tool_name: 'oldest' }),
          budgetRow({ timestamp_ms: 2_000, tool_name: 'middle' }),
          budgetRow({ timestamp_ms: 3_000, tool_name: 'newest' }),
        ])

        try {
          const { code, stdout, stderr } = await runCli([
            'export',
            '-c',
            configPath,
            '--budgets',
            'daily-cap',
            '-f',
            'json',
            '--limit',
            '2',
          ])
          expect(code).toBe(0)
          expect(stderr).toContain('Exported 2 of 3 records')

          const events = JSON.parse(stdout) as Array<Record<string, unknown>>
          expect(events.map((e) => e['tool_name'])).toEqual(['newest', 'middle'])
        } finally {
          rmSync(dir, { recursive: true, force: true })
        }
      })

      it('exports an empty artifact for an unknown budget name', async () => {
        const { dir, configPath } = setupBudgetExport([budgetRow()])

        try {
          const { code, stdout, stderr } = await runCli([
            'export',
            '-c',
            configPath,
            '--budgets',
            'no-such-budget',
            '-f',
            'csv',
          ])
          expect(code).toBe(0)
          expect(stderr).toContain('Exported 0 of 0 records')
          expect(stdout.trim()).toBe(BUDGET_CSV_HEADER)
        } finally {
          rmSync(dir, { recursive: true, force: true })
        }
      })
    })
  })
})
