import { describe, it, expect, beforeAll, vi } from 'vitest'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { AuditStore } from './audit/store.js'
import type { AuditRecord, AuditRecordInput } from './audit/types.js'
import { BudgetLedger } from './budget/ledger.js'
import type { BudgetLedgerRow } from './budget/engine.js'
import {
  startSessionEnforcingHttpMcpServer,
  startModernOnlyHttpMcpServer,
} from './__tests__/helpers/mcp-test-server.js'
import { secretDigest } from './auth/bearer.js'

const CLI_PATH = join(import.meta.dirname, '../dist/cli.js')
const CLI_MAX_BUFFER_BYTES = 16 * 1024 * 1024

/** Run the CLI and capture output. */
function runCli(
  args: string[],
  env?: NodeJS.ProcessEnv,
  cwd?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      'node',
      [CLI_PATH, ...args],
      {
        ...(env ? { env } : {}),
        ...(cwd ? { cwd } : {}),
        // A JSON export of 1100 records is just over execFile's 1 MiB default
        // once every record carries config_sha256; the CLI itself has no cap.
        maxBuffer: CLI_MAX_BUFFER_BYTES,
      },
      (error, stdout, stderr) => {
        resolve({
          code: typeof error?.code === 'number' ? error.code : error ? 1 : 0,
          stdout,
          stderr,
        })
      },
    )
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
 * A random port for a spawned `helio start`, below every OS's ephemeral
 * range so it cannot land on a port a port-0 listener already holds
 * (issue #271). A foreign fixed-port service there is still possible
 * and fails loudly with EADDRINUSE in the child's stderr.
 */
function randomChildPort(): number {
  return 20_000 + Math.floor(Math.random() * 10_000)
}

/**
 * Write a minimal start-ready config at a random port and return the
 * tempdir + config path. The caller is responsible for rmSync cleanup.
 */
function writeStartConfig(): { dir: string; configPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'helio-cli-start-'))
  const configPath = join(dir, 'helio.yaml')
  const listenPort = randomChildPort()
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
  const listenPort = randomChildPort()
  const auditPath = join(dir, 'audit.db')
  writeFileSync(
    configPath,
    `
version: "1"
upstream:
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

// The compile-failure faces (issue #195): a name, the YAML tail appended to a
// start-ready header, and the exact line BOTH surfaces must print for it. One
// table drives validate and start so a drift on either fails its own row.
const RULE_CATASTROPHIC_TAIL = `policies:
  default: allow
  rules:
    - name: bad
      match:
        input:
          '$.memo':
            regex: '(a+)+$'
      action: deny
`
const RULE_INVALID_TAIL = `policies:
  default: allow
  rules:
    - name: bad
      match:
        input:
          '$.memo':
            regex: '[z-a]'
      action: deny
`
const METADATA_CATASTROPHIC_TAIL = `policies:
  default: allow
  rules:
    - name: bad
      match:
        metadata:
          agent:
            regex: '(a+)+$'
      action: deny
`
const BUDGET_CATASTROPHIC_TAIL = `budgets:
  - name: daily-cap
    limit: 50
    currency: USD
    window: 24h
    contributors:
      - match:
          tool: 'stripe_*'
          input:
            '$.memo':
              regex: '(a+)+$'
        field: '$.amount'
`
const RULE_CATASTROPHIC_LINE =
  'Invalid policy: Policy rule 0 ("bad"): catastrophic regex "(a+)+$" for input path "$.memo": pattern is vulnerable to ReDoS and has been rejected. Rewrite with bounded quantifiers (e.g. {1,100}) or split into simpler rules.'
const COMPILE_FAILURE_FACES: Array<[string, string, string]> = [
  ['a catastrophic rule input regex', RULE_CATASTROPHIC_TAIL, RULE_CATASTROPHIC_LINE],
  [
    'a malformed rule input regex',
    RULE_INVALID_TAIL,
    'Invalid policy: Policy rule 0 ("bad"): invalid regex "[z-a]" for input path "$.memo": Invalid regular expression: /[z-a]/: Range out of order in character class',
  ],
  [
    'a catastrophic rule metadata regex',
    METADATA_CATASTROPHIC_TAIL,
    'Invalid policy: Policy rule 0 ("bad"): catastrophic regex "(a+)+$" for metadata key "agent": pattern is vulnerable to ReDoS and has been rejected. Rewrite with bounded quantifiers (e.g. {1,100}) or split into simpler rules.',
  ],
  [
    'a catastrophic budget contributor regex',
    BUDGET_CATASTROPHIC_TAIL,
    'Invalid budget: Budget "daily-cap": contributor 0: catastrophic regex "(a+)+$" for input path "$.memo": pattern is vulnerable to ReDoS and has been rejected. Rewrite with bounded quantifiers (e.g. {1,100}) or split into simpler rules.',
  ],
]

/**
 * Write a start-ready config (the writeStartConfig header with the dashboard
 * disabled, so no dashboard port or bundled assets are involved) followed by
 * a `policies:` or `budgets:` tail that validates but does not compile.
 * The caller is responsible for rmSync cleanup.
 */
function writeCompileFailureConfig(tail: string): {
  dir: string
  configPath: string
  auditPath: string
} {
  const dir = mkdtempSync(join(tmpdir(), 'helio-cli-compile-'))
  const configPath = join(dir, 'helio.yaml')
  const listenPort = randomChildPort()
  const auditPath = join(dir, 'audit.db')
  writeFileSync(
    configPath,
    `version: "1"
upstream:
  url: "http://127.0.0.1:1/mcp"
  transport: streamable-http
listen:
  port: ${String(listenPort)}
  host: 127.0.0.1
dashboard:
  enabled: false
audit:
  path: "${auditPath}"
${tail}`,
  )
  return { dir, configPath, auditPath }
}

/**
 * Write the start-ready header writeCompileFailureConfig uses, with the
 * given audit.path and no tail, into an existing tempdir (issue #388).
 */
function writeAuditPathConfig(dir: string, auditPath: string): string {
  const configPath = join(dir, 'helio.yaml')
  writeFileSync(
    configPath,
    `version: "1"
upstream:
  url: "http://127.0.0.1:1/mcp"
  transport: streamable-http
listen:
  port: ${String(randomChildPort())}
  host: 127.0.0.1
dashboard:
  enabled: false
audit:
  path: "${auditPath}"
`,
  )
  return configPath
}

/** A directory chmod cannot make unwritable for root, and W_OK is not honored on Windows. */
const CAN_TEST_UNWRITABLE = process.platform !== 'win32' && process.getuid?.() !== 0

// The audit.path faces (issue #388): a name, and a builder that lays the
// fixture out under the tempdir and returns the configured path, the
// exact body all three surfaces print (validate behind `Warning: `, start
// and export behind `Invalid config: `), and the directory that must not
// exist afterwards (undefined when the face has nothing to create).
type AuditPathFace = { auditPath: string; expectedBody: string; absentAfter?: string }
const AUDIT_PATH_FACES: Array<[string, (dir: string) => AuditPathFace]> = [
  [
    'a directory that does not exist',
    (dir) => ({
      auditPath: join(dir, 'no-such-dir', 'audit.db'),
      expectedBody: `audit.path: directory ${join(dir, 'no-such-dir')} does not exist`,
      absentAfter: join(dir, 'no-such-dir'),
    }),
  ],
  [
    'a nested directory that does not exist',
    (dir) => ({
      auditPath: join(dir, 'no', 'such', 'audit.db'),
      expectedBody: `audit.path: directory ${join(dir, 'no', 'such')} does not exist`,
      absentAfter: join(dir, 'no'),
    }),
  ],
  [
    'a parent that is a file',
    (dir) => {
      writeFileSync(join(dir, 'plainfile'), '')
      return {
        auditPath: join(dir, 'plainfile', 'audit.db'),
        expectedBody: `audit.path: ${join(dir, 'plainfile')} is not a directory`,
      }
    },
  ],
  [
    'a path that is a directory',
    (dir) => ({
      auditPath: dir,
      expectedBody: `audit.path: ${dir} is a directory, not a file`,
    }),
  ],
  [
    'a relative path into a directory that does not exist',
    (dir) => ({
      auditPath: './rel-missing/audit.db',
      // The child resolves against its cwd, which process.cwd() reports
      // with symlinks resolved (macOS tmpdir is under /var -> /private/var).
      expectedBody: `audit.path: directory ${join(realpathSync(dir), 'rel-missing')} does not exist`,
      absentAfter: join(dir, 'rel-missing'),
    }),
  ],
  [
    'a path through a file',
    (dir) => {
      // A deeper component below a regular file: stat says ENOTDIR, a
      // different branch from the parent-is-a-file row above.
      writeFileSync(join(dir, 'plainfile'), '')
      return {
        auditPath: join(dir, 'plainfile', 'foo', 'audit.db'),
        expectedBody: `audit.path: ${join(dir, 'plainfile', 'foo')} is not a directory`,
      }
    },
  ],
]

/**
 * Seed a WAL database and leave empty -wal and -shm sidecars beside it
 * after the close (a clean close deletes both), then make the directory
 * read-only. The face r1 found: SQLite needs no directory write once the
 * sidecars exist, so all three commands must keep accepting it.
 */
function seedReadOnlyDirWithSidecars(dir: string): string {
  const dbPath = join(dir, 'audit.db')
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.exec('CREATE TABLE seeded (x)')
  db.close()
  writeFileSync(`${dbPath}-wal`, '')
  writeFileSync(`${dbPath}-shm`, '')
  chmodSync(dir, 0o500)
  return dbPath
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
  const listenPort = randomChildPort()
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

/** Wait for the proxy's health endpoint, or fail at once if the child exits first. */
async function waitForProxyHealthOrExit(
  child: ReturnType<typeof spawn>,
  baseUrl: string,
  timeoutMs: number,
  stderr: () => string,
): Promise<void> {
  await Promise.race([
    waitForProxyHealth(baseUrl, timeoutMs),
    new Promise<never>((_, reject) => {
      child.once('close', (code) => {
        reject(new Error(`helio start exited ${String(code)} before healthy. stderr:\n${stderr()}`))
      })
    }),
  ])
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
        const match = contents.match(/dashboard:[\s\S]*?api_secret:\s*"sha256:([a-f0-9]{64})"/)
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

        const secret1 = readFileSync(out1, 'utf-8').match(
          /api_secret:\s*"sha256:([a-f0-9]{64})"/,
        )?.[1]
        const secret2 = readFileSync(out2, 'utf-8').match(
          /api_secret:\s*"sha256:([a-f0-9]{64})"/,
        )?.[1]
        expect(secret1).toBeDefined()
        expect(secret2).toBeDefined()
        expect(secret1).not.toBe(secret2)
      } finally {
        rmSync(dir1, { recursive: true, force: true })
        rmSync(dir2, { recursive: true, force: true })
      }
    }, 15_000)

    it('prints the generated secret to stderr', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'helio-cli-test-'))
      const outPath = join(dir, 'helio.yaml')

      try {
        const { code, stderr } = await runCli(['init', '-o', outPath])
        expect(code).toBe(0)
        expect(stderr).toContain('Dashboard secret (shown once')
        expect(stderr).toMatch(/[a-f0-9]{64}/)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('writes only the digest of the secret it prints', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'helio-cli-test-'))
      const outPath = join(dir, 'helio.yaml')

      try {
        const { code, stderr } = await runCli(['init', '-o', outPath])
        expect(code).toBe(0)
        expect(stderr).toContain('Dashboard secret (shown once')

        const printed = /^ {2}([a-f0-9]{64})$/m.exec(stderr)?.[1]
        expect(printed).toBeDefined()

        const contents = readFileSync(outPath, 'utf-8')
        const stored = /dashboard:[\s\S]*?api_secret:\s*"(sha256:[a-f0-9]{64})"/.exec(contents)?.[1]
        expect(stored).toBe(secretDigest(printed ?? ''))
        expect(contents).not.toContain(printed ?? 'never')
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

    it('--sandbox writes the three-file layout and prints the next steps', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'helio-cli-sandbox-'))
      const target = join(dir, 'sandbox')
      try {
        const { code, stderr } = await runCli(['init', '--sandbox', target])
        expect(code).toBe(0)
        for (const rel of ['compose.yaml', 'helio/helio.yaml', 'helio/README.md']) {
          expect(existsSync(join(target, rel)), rel).toBe(true)
          expect(stderr).toContain(`Created ${join(target, rel)}`)
        }
        expect(stderr).toContain('Next steps')
        expect(stderr).toContain('helio secret')
        expect(stderr).not.toMatch(/[a-f0-9]{64}/)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('--sandbox defaults to ./helio-sandbox under the current directory', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'helio-cli-sandbox-'))
      try {
        const { code } = await runCli(['init', '--sandbox'], undefined, dir)
        expect(code).toBe(0)
        expect(existsSync(join(dir, 'helio-sandbox', 'compose.yaml'))).toBe(true)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('--sandbox refuses to overwrite an existing layout without --force', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'helio-cli-sandbox-'))
      const target = join(dir, 'sandbox')
      try {
        expect((await runCli(['init', '--sandbox', target])).code).toBe(0)
        const second = await runCli(['init', '--sandbox', target])
        expect(second.code).toBe(1)
        expect(second.stderr).toContain('already exists')
        const forced = await runCli(['init', '--sandbox', target, '--force'])
        expect(forced.code).toBe(0)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 15_000)

    it('--sandbox rejects an explicit --output', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'helio-cli-sandbox-'))
      try {
        const { code, stderr } = await runCli([
          'init',
          '--sandbox',
          join(dir, 's'),
          '-o',
          join(dir, 'x.yaml'),
        ])
        expect(code).toBe(1)
        expect(stderr).toContain('--output does not apply to --sandbox')
        // An explicit -o equal to the default must be caught too (option source, not value).
        const sameAsDefault = await runCli(
          ['init', '--sandbox', join(dir, 's2'), '-o', 'helio.yaml'],
          undefined,
          dir,
        )
        expect(sameAsDefault.code).toBe(1)
        expect(existsSync(join(dir, 's2'))).toBe(false)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 15_000)

    it('--sandbox writes a config that passes validate', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'helio-cli-sandbox-'))
      const target = join(dir, 'sandbox')
      try {
        expect((await runCli(['init', '--sandbox', target])).code).toBe(0)
        const validate = await runCli(['validate', '-c', join(target, 'helio', 'helio.yaml')], {
          ...process.env,
          HELIO_DASHBOARD_SECRET: 'sandbox-test',
        })
        expect(validate.code).toBe(0)
        expect(validate.stderr).toContain('Config is valid')
        expect(validate.stderr).toContain('(2 policy rules, 0 budgets)')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 15_000)
  })

  // --- helio init --client (issue #398) ---

  describe('init --client', () => {
    /** A three-format, four-server tree: one stdio and one HTTP entry for Claude Code, one stdio each for Cursor and VS Code. */
    function writeAdoptTree(dir: string): void {
      mkdirSync(join(dir, '.cursor'), { recursive: true })
      mkdirSync(join(dir, '.vscode'), { recursive: true })
      writeFileSync(
        join(dir, '.mcp.json'),
        JSON.stringify(
          {
            mcpServers: {
              files: {
                command: 'node',
                args: [STDIO_MCP_FIXTURE, 'files_ping'],
                env: { FILES_ROOT: '/tmp' },
              },
              github: {
                type: 'http',
                url: 'http://127.0.0.1:8087/mcp',
                headers: { Authorization: 'Bearer ${GITHUB_TOKEN}' },
              },
            },
          },
          null,
          2,
        ) + '\n',
      )
      writeFileSync(
        join(dir, '.cursor', 'mcp.json'),
        JSON.stringify(
          {
            mcpServers: {
              payments: { command: 'node', args: [STDIO_MCP_FIXTURE, 'payments_ping'] },
            },
          },
          null,
          2,
        ) + '\n',
      )
      writeFileSync(
        join(dir, '.vscode', 'mcp.json'),
        JSON.stringify(
          {
            servers: {
              search: { type: 'stdio', command: 'node', args: [STDIO_MCP_FIXTURE, 'search_ping'] },
            },
            inputs: [],
          },
          null,
          2,
        ) + '\n',
      )
    }

    /** Every file under the tree with its bytes, for the "tree unchanged" assertions. */
    function snapshotTree(dir: string): Record<string, string> {
      const out: Record<string, string> = {}
      const walk = (d: string, rel: string): void => {
        for (const name of readdirSync(d).sort()) {
          const full = join(d, name)
          const relName = rel ? `${rel}/${name}` : name
          if (name === 'helio-audit.db') continue
          const st = statSync(full)
          if (st.isDirectory()) walk(full, relName)
          else out[relName] = createHash('sha256').update(readFileSync(full)).digest('hex')
        }
      }
      walk(dir, '')
      return out
    }

    const NEXT_LINE =
      'Next: run `helio start`. Restart your MCP client. In Claude Code, run `claude` and approve the project servers (`claude mcp list` stays at pending approval until you do).'

    it('adopts the three project files: backups first, the manifest, the config, the rewrites, the lines in order', async () => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'helio-cli-adopt-')))
      try {
        writeAdoptTree(dir)
        const originals = {
          mcp: readFileSync(join(dir, '.mcp.json')),
          cursor: readFileSync(join(dir, '.cursor', 'mcp.json')),
          vscode: readFileSync(join(dir, '.vscode', 'mcp.json')),
        }
        const { code, stderr, stdout } = await runCli(['init', '--client'], undefined, dir)
        expect(stdout).toBe('')
        expect(code, stderr).toBe(0)
        const lines = stderr.split('\n')
        const expectedOrder = [
          'Found 4 servers in 3 client configs:',
          '  .mcp.json: files (stdio), github (http)',
          '  .cursor/mcp.json: payments (stdio)',
          '  .vscode/mcp.json: search (stdio)',
          'Backed up .mcp.json to .mcp.json.helio-backup',
          'Backed up .cursor/mcp.json to .cursor/mcp.json.helio-backup',
          'Backed up .vscode/mcp.json to .vscode/mcp.json.helio-backup',
          'Wrote .helio-init-client.json (undo reads it; tied to this directory)',
          '.helio-init-client.json and the .helio-backup files are local to this machine; do not commit them.',
          'Created helio.yaml (4 upstreams; doors at http://127.0.0.1:3000/mcp/<name>)',
          'Copied env for files into helio.yaml (FILES_ROOT); the file now holds those values',
          `Set CLAUDE_PROJECT_DIR=${dir} for files in helio.yaml (Claude Code sets it for stdio servers; update it if the project moves)`,
          'Rewrote .mcp.json: files, github now point at Helio',
          'Rewrote .cursor/mcp.json: payments now points at Helio',
          'Rewrote .vscode/mcp.json: search now points at Helio',
          'Environment variables helio.yaml needs (helio start and helio policy status): GITHUB_TOKEN',
          'Dashboard secret (shown once; the file stores only its SHA-256 digest):',
          'helio policy status needs this secret in HELIO_DASHBOARD_SECRET.',
          NEXT_LINE,
          'Undo: from this directory, helio init --client --undo',
        ]
        let cursor = -1
        for (const line of expectedOrder) {
          const index = lines.indexOf(line)
          expect(index, `line missing: ${line}\n${stderr}`).toBeGreaterThan(cursor)
          cursor = index
        }
        expect(stderr).toContain('Store it in your password manager.')

        // The backups hold the original bytes.
        expect(readFileSync(join(dir, '.mcp.json.helio-backup'))).toEqual(originals.mcp)
        expect(readFileSync(join(dir, '.cursor', 'mcp.json.helio-backup'))).toEqual(
          originals.cursor,
        )
        expect(readFileSync(join(dir, '.vscode', 'mcp.json.helio-backup'))).toEqual(
          originals.vscode,
        )

        // The manifest names every backup and the output, as absolute paths.
        const manifest = JSON.parse(
          readFileSync(join(dir, '.helio-init-client.json'), 'utf-8'),
        ) as Record<string, unknown>
        expect(manifest).toEqual({
          version: 1,
          output: join(dir, 'helio.yaml'),
          output_backup: null,
          clients: [
            { path: join(dir, '.mcp.json'), backup: join(dir, '.mcp.json.helio-backup') },
            {
              path: join(dir, '.cursor', 'mcp.json'),
              backup: join(dir, '.cursor', 'mcp.json.helio-backup'),
            },
            {
              path: join(dir, '.vscode', 'mcp.json'),
              backup: join(dir, '.vscode', 'mcp.json.helio-backup'),
            },
          ],
          created_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) as unknown,
        })

        // The rewritten entries, in the shape each client documents.
        expect(JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf-8'))).toEqual({
          mcpServers: {
            files: { type: 'http', url: 'http://127.0.0.1:3000/mcp/files' },
            github: { type: 'http', url: 'http://127.0.0.1:3000/mcp/github' },
          },
        })
        expect(JSON.parse(readFileSync(join(dir, '.cursor', 'mcp.json'), 'utf-8'))).toEqual({
          mcpServers: { payments: { url: 'http://127.0.0.1:3000/mcp/payments' } },
        })
        expect(JSON.parse(readFileSync(join(dir, '.vscode', 'mcp.json'), 'utf-8'))).toEqual({
          servers: { search: { type: 'http', url: 'http://127.0.0.1:3000/mcp/search' } },
          inputs: [],
        })

        // The config: the scaffold with a live upstreams: list and a live listen:, the digest only.
        const contents = readFileSync(join(dir, 'helio.yaml'), 'utf-8')
        expect(contents).toContain(
          '# Written by helio init --client from .mcp.json, .cursor/mcp.json and .vscode/mcp.json\n',
        )
        expect(contents).toContain('# Undo: from this directory, helio init --client --undo\n')
        expect(contents).toContain(
          '\nupstreams:\n  - name: "files"\n    transport: "stdio"\n    command: "node"\n',
        )
        expect(contents).toContain(
          '    env:\n      FILES_ROOT: "/tmp"\n      CLAUDE_PROJECT_DIR: "',
        )
        expect(contents).toContain(
          '  - name: "github"\n    transport: "streamable-http"\n    url: "http://127.0.0.1:8087/mcp"\n    headers:\n      Authorization: "Bearer ${GITHUB_TOKEN}"\n',
        )
        expect(contents).toContain('\n# upstream:\n')
        expect(contents).not.toContain('\n# upstreams:\n')
        expect(contents).toContain('\nlisten:\n  port: 3000\n  host: 127.0.0.1\n')
        const printed = /^ {2}([a-f0-9]{64})$/m.exec(stderr)?.[1]
        expect(printed).toBeDefined()
        expect(contents).toContain(`api_secret: "${secretDigest(printed ?? '')}"`)
        expect(contents).not.toContain(printed ?? 'never')
        expect(stderr.match(/[a-f0-9]{64}/g)).toHaveLength(1)

        // The written file passes validate once the variable is exported, and keeps the canonical order.
        const validate = await runCli(['validate', '-c', join(dir, 'helio.yaml')], {
          ...process.env,
          GITHUB_TOKEN: 'x',
        })
        expect(validate.code, validate.stderr).toBe(0)
        expect(validate.stderr).toContain('(0 policy rules, 0 budgets)')
        const canonicalOrder = [
          'version',
          'upstreams',
          'upstream',
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
        let at = -1
        for (const key of canonicalOrder) {
          const match = new RegExp(`^(?:#\\s*)?${key}:`, 'm').exec(contents)
          expect(match, `top-level \`${key}:\` stub missing`).not.toBeNull()
          expect(match?.index ?? -1, `\`${key}:\` is out of canonical order`).toBeGreaterThan(at)
          at = match?.index ?? -1
        }
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 20_000)

    it('--client <path> adopts one file and the Undo line names the path', async () => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'helio-cli-adopt-')))
      try {
        writeAdoptTree(dir)
        const target = join(dir, 'copy', '.mcp.json')
        mkdirSync(join(dir, 'copy'))
        writeFileSync(target, readFileSync(join(dir, '.mcp.json')))
        const { code, stderr } = await runCli(
          ['init', '--client', 'copy/.mcp.json'],
          undefined,
          dir,
        )
        expect(code, stderr).toBe(0)
        expect(stderr).toContain(
          'Found 2 servers in 1 client config:\n  copy/.mcp.json: files (stdio), github (http)\n',
        )
        expect(stderr).toContain('Backed up copy/.mcp.json to copy/.mcp.json.helio-backup\n')
        expect(stderr).toContain(
          'Undo: from this directory, helio init --client copy/.mcp.json --undo\n',
        )
        expect(existsSync(join(dir, '.mcp.json.helio-backup'))).toBe(false)
        expect(existsSync(target + '.helio-backup')).toBe(true)
        const contents = readFileSync(join(dir, 'helio.yaml'), 'utf-8')
        expect(contents).toContain('# Written by helio init --client from copy/.mcp.json\n')
        expect(contents).toContain(
          '# Undo: from this directory, helio init --client copy/.mcp.json --undo\n',
        )
        expect(contents).toContain(`CLAUDE_PROJECT_DIR: "${join(dir, 'copy')}"`)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 15_000)

    it('-o other.yaml then --undo restores every file byte for byte and names other.yaml', async () => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'helio-cli-adopt-')))
      try {
        writeAdoptTree(dir)
        const before = snapshotTree(dir)
        const adopt = await runCli(['init', '--client', '-o', 'other.yaml'], undefined, dir)
        expect(adopt.code, adopt.stderr).toBe(0)
        expect(adopt.stderr).toContain(
          'Created other.yaml (4 upstreams; doors at http://127.0.0.1:3000/mcp/<name>)',
        )
        expect(adopt.stderr).toContain(
          'Copied env for files into other.yaml (FILES_ROOT); the file now holds those values\n',
        )
        expect(adopt.stderr).toContain(
          `Set CLAUDE_PROJECT_DIR=${dir} for files in other.yaml (Claude Code sets it for stdio servers; update it if the project moves)\n`,
        )
        expect(adopt.stderr).not.toContain('in helio.yaml')
        expect(adopt.stderr).not.toContain('into helio.yaml')
        expect(existsSync(join(dir, 'other.yaml'))).toBe(true)
        expect(existsSync(join(dir, 'helio.yaml'))).toBe(false)
        // An edit after the adoption is discarded by the restore, and the line says so.
        writeFileSync(join(dir, '.mcp.json'), '{"mcpServers": {}}')

        const undo = await runCli(['init', '--client', '--undo'], undefined, dir)
        expect(undo.code, undo.stderr).toBe(0)
        const mcpBytes = readFileSync(join(dir, '.mcp.json')).length
        expect(undo.stderr).toContain(
          `Replaced .mcp.json with the backup (${String(mcpBytes)} bytes). Edits since the adoption, if there were any, are discarded.\n`,
        )
        expect(undo.stderr).toMatch(/Replaced \.cursor\/mcp\.json with the backup \(\d+ bytes\)\./)
        expect(undo.stderr).toMatch(/Replaced \.vscode\/mcp\.json with the backup \(\d+ bytes\)\./)
        expect(undo.stderr).toContain(
          'other.yaml was left in place (from .helio-init-client.json); delete it if you no longer want it.\n',
        )
        expect(undo.stderr).toContain('Restart your MCP client to pick the restored files up.\n')
        expect(existsSync(join(dir, '.helio-init-client.json'))).toBe(false)
        expect(existsSync(join(dir, '.mcp.json.helio-backup'))).toBe(false)
        expect(existsSync(join(dir, '.cursor', 'mcp.json.helio-backup'))).toBe(false)
        expect(existsSync(join(dir, '.vscode', 'mcp.json.helio-backup'))).toBe(false)
        rmSync(join(dir, 'other.yaml'))
        expect(snapshotTree(dir)).toEqual(before)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 20_000)

    it('--force backs up an existing output and --undo restores it', async () => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'helio-cli-adopt-')))
      try {
        writeAdoptTree(dir)
        writeFileSync(join(dir, 'helio.yaml'), 'old content\n')
        const refused = await runCli(['init', '--client'], undefined, dir)
        expect(refused.code).toBe(1)
        expect(refused.stderr).toContain(
          'Error: helio.yaml already exists. Use --force to overwrite.',
        )
        expect(existsSync(join(dir, '.mcp.json.helio-backup'))).toBe(false)

        const forced = await runCli(['init', '--client', '--force'], undefined, dir)
        expect(forced.code, forced.stderr).toBe(0)
        expect(forced.stderr).toContain('Backed up helio.yaml to helio.yaml.helio-backup\n')
        expect(readFileSync(join(dir, 'helio.yaml.helio-backup'), 'utf-8')).toBe('old content\n')
        const manifest = JSON.parse(
          readFileSync(join(dir, '.helio-init-client.json'), 'utf-8'),
        ) as { output_backup: string }
        expect(manifest.output_backup).toBe(join(dir, 'helio.yaml.helio-backup'))

        const undo = await runCli(['init', '--client', '--undo'], undefined, dir)
        expect(undo.code, undo.stderr).toBe(0)
        expect(undo.stderr).toContain(
          'Replaced helio.yaml with the backup (12 bytes). Edits since the adoption, if there were any, are discarded.\n',
        )
        expect(readFileSync(join(dir, 'helio.yaml'), 'utf-8')).toBe('old content\n')
        expect(existsSync(join(dir, 'helio.yaml.helio-backup'))).toBe(false)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 20_000)

    it('refuses every flag combination and unaccepted path in one line, exit 1, before anything is written', async () => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'helio-cli-adopt-')))
      try {
        writeAdoptTree(dir)
        const before = snapshotTree(dir)
        const cases: Array<[string[], string]> = [
          [['init', '--client', '--sandbox'], 'Error: --client does not combine with --sandbox.'],
          [['init', '--undo'], 'Error: --undo requires --client.'],
          [
            ['init', '--client', '--undo', '-o', 'x.yaml'],
            'Error: --output does not apply to --undo.',
          ],
          [['init', '--client', '--undo', '--force'], 'Error: --force does not apply to --undo.'],
          [
            ['init', '--client', 'helio.yaml'],
            'Error: helio.yaml is not a client config Helio adopts (accepted: .mcp.json, .cursor/mcp.json, .vscode/mcp.json, .claude.json). Nothing changed.',
          ],
          [
            ['init', '--client='],
            'Error: "" is not a client config Helio adopts (accepted: .mcp.json, .cursor/mcp.json, .vscode/mcp.json, .claude.json). Nothing changed.',
          ],
          [
            ['init', '--client', '-'],
            'Error: - is not a client config Helio adopts (accepted: .mcp.json, .cursor/mcp.json, .vscode/mcp.json, .claude.json). Nothing changed.',
          ],
          [
            ['init', '--client', 'missing/.mcp.json'],
            'Error: missing/.mcp.json does not exist. Nothing changed.',
          ],
          [
            ['init', '--client', 'claude_desktop_config.json'],
            'Error: claude_desktop_config.json: Claude Desktop reaches HTTP servers through Settings > Connectors, not this file, so Helio cannot repoint it. Nothing changed.',
          ],
        ]
        for (const [args, line] of cases) {
          const { code, stderr } = await runCli(args, undefined, dir)
          expect(code, args.join(' ')).toBe(1)
          expect(stderr.trim(), args.join(' ')).toBe(line)
        }
        expect(snapshotTree(dir)).toEqual(before)
        expect(existsSync(join(dir, 'helio.yaml'))).toBe(false)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 30_000)

    it('refuses when no client config is found, naming the three paths', async () => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'helio-cli-adopt-')))
      try {
        const { code, stderr } = await runCli(['init', '--client'], undefined, dir)
        expect(code).toBe(1)
        expect(stderr.trim()).toBe(
          `Error: no MCP client config found in ${dir} (looked for .mcp.json, .cursor/mcp.json, .vscode/mcp.json). Pass a path: helio init --client <path>`,
        )
        expect(readdirSync(dir)).toEqual([])
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('refuses an unreadable file, a collision, an empty name and a door with the plan lines and the tree unchanged', async () => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'helio-cli-adopt-')))
      try {
        const run = async (mcp: string, cursor?: string): Promise<string> => {
          rmSync(join(dir, '.cursor'), { recursive: true, force: true })
          writeFileSync(join(dir, '.mcp.json'), mcp)
          if (cursor !== undefined) {
            mkdirSync(join(dir, '.cursor'))
            writeFileSync(join(dir, '.cursor', 'mcp.json'), cursor)
          }
          const before = snapshotTree(dir)
          const { code, stderr } = await runCli(['init', '--client'], undefined, dir)
          expect(code, stderr).toBe(1)
          expect(snapshotTree(dir)).toEqual(before)
          expect(existsSync(join(dir, 'helio.yaml'))).toBe(false)
          return stderr
        }
        expect(await run('{"mcpServers": }')).toMatch(
          /^Error: \.mcp\.json is not JSON after comment removal: .+\. Nothing changed\.\n$/,
        )
        expect(await run('﻿{"mcpServers": {}}')).toBe(
          'Error: .mcp.json starts with a byte-order mark. Nothing changed.\n',
        )
        expect(await run('{"mcpServers": {"a": {"command": "x", "n": 9007199254740993}}}')).toBe(
          'Error: .mcp.json would not survive a rewrite: mcpServers.a.n holds a number a rewrite would change: an integer beyond 2^53 precision, a negative zero, or a non-finite value such as 1e309. Edit it by hand. Nothing changed.\n',
        )
        expect(await run('{"mcpServers": {"!!!": {"command": "x"}}}')).toBe(
          'Error: the name "!!!" in .mcp.json has no letters or digits to make an upstream name from. Rename it and rerun. Nothing changed.\n',
        )
        expect(
          await run(
            '{"mcpServers": {"github": {"command": "x"}}}',
            '{"mcpServers": {"github": {"command": "y"}}}',
          ),
        ).toBe(
          'Error: "github" is defined differently in .mcp.json and .cursor/mcp.json. Adopt one file: helio init --client .mcp.json\n',
        )
        expect(
          await run(
            '{"mcpServers": {"github": {"type": "http", "url": "http://127.0.0.1:3000/mcp/github"}}}',
          ),
        ).toBe(
          'Error: "github" in .mcp.json already looks like a Helio door (http://127.0.0.1:3000/mcp/github). Pass --force if it is not. Nothing changed.\n',
        )
        expect(await run('{"mcpServers": {"ws": {"type": "ws", "url": "ws://x"}}}')).toBe(
          'Found 1 server in 1 client config:\n  .mcp.json: ws (skipped)\nSkipped "ws" in .mcp.json: type "ws" has no Helio transport; it stays direct.\nError: no server in .mcp.json can be adopted (1 skipped, see above). Nothing changed.\n',
        )
        expect(
          await run(
            '{"mcpServers": {"h": {"type": "http", "url": "http://x/m", "headers": {"Mcp-Session-Id": "x"}}}}',
          ),
        ).toContain(
          'Error: the helio.yaml built from .mcp.json does not validate: upstreams.0.headers.Mcp-Session-Id: upstream.headers must not set reserved header "Mcp-Session-Id". Nothing changed.',
        )
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 40_000)

    it('names the -o output in the collapse refusal and in the validation refusal', async () => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'helio-cli-adopt-')))
      try {
        writeFileSync(
          join(dir, '.mcp.json'),
          JSON.stringify({
            mcpServers: { api: { type: 'http', url: 'http://bob:pw@127.0.0.1:9/${BASE}' } },
          }),
        )
        const collapse = await runCli(
          ['init', '--client', '-o', 'other.yaml'],
          { ...process.env, BASE: '/foo' },
          dir,
        )
        expect(collapse.code).toBe(1)
        expect(collapse.stderr.trim()).toBe(
          'Error: "api" in .mcp.json: its url already carries a username and password, and Claude Code would collapse its leading //; writing that collapsed url into other.yaml would copy the credential. Fix the url by hand. Nothing changed.',
        )
        writeFileSync(
          join(dir, '.mcp.json'),
          JSON.stringify({
            mcpServers: { api: { type: 'http', url: 'http://user:token@${HOST}/${API_PATH}' } },
          }),
        )
        const host = await runCli(
          ['init', '--client', '-o', 'other.yaml'],
          { ...process.env, HOST: 'h', API_PATH: '/v1' },
          dir,
        )
        expect(host.code).toBe(1)
        expect(host.stderr.trim()).toBe(
          'Error: "api" in .mcp.json: its url already carries a username and password, and Claude Code would collapse its leading //; writing that collapsed url into other.yaml would copy the credential. Fix the url by hand. Nothing changed.',
        )
        writeFileSync(
          join(dir, '.mcp.json'),
          JSON.stringify({
            mcpServers: {
              h: { type: 'http', url: 'http://x/m', headers: { 'Mcp-Session-Id': 'x' } },
            },
          }),
        )
        const invalid = await runCli(['init', '--client', '-o', 'other.yaml'], undefined, dir)
        expect(invalid.code).toBe(1)
        expect(invalid.stderr.trim()).toBe(
          'Error: the other.yaml built from .mcp.json does not validate: upstreams.0.headers.Mcp-Session-Id: upstream.headers must not set reserved header "Mcp-Session-Id". Nothing changed.',
        )
        expect(existsSync(join(dir, 'other.yaml'))).toBe(false)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 15_000)

    it('a second run refuses on each marker, and --force passes only the door marker', async () => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'helio-cli-adopt-')))
      try {
        writeAdoptTree(dir)
        expect((await runCli(['init', '--client'], undefined, dir)).code).toBe(0)
        // Marker 1: the manifest.
        const again = await runCli(['init', '--client', '--force'], undefined, dir)
        expect(again.code).toBe(1)
        expect(again.stderr.trim()).toBe(
          'Error: .helio-init-client.json exists; this project was already adopted. Run helio init --client --undo first. Nothing changed.',
        )
        // Marker 2: a backup sibling, with the manifest gone.
        rmSync(join(dir, '.helio-init-client.json'))
        const backupOnly = await runCli(['init', '--client', '--force'], undefined, dir)
        expect(backupOnly.code).toBe(1)
        expect(backupOnly.stderr.trim()).toBe(
          'Error: .mcp.json.helio-backup already exists; this file was already adopted. Run helio init --client --undo first. Nothing changed.',
        )
        // Marker 3: the door URL, with every backup gone; --force passes it.
        for (const b of [
          '.mcp.json.helio-backup',
          '.cursor/mcp.json.helio-backup',
          '.vscode/mcp.json.helio-backup',
        ])
          rmSync(join(dir, b))
        const door = await runCli(['init', '--client', '-o', 'second.yaml'], undefined, dir)
        expect(door.code).toBe(1)
        expect(door.stderr.trim()).toBe(
          'Error: "files" in .mcp.json already looks like a Helio door (http://127.0.0.1:3000/mcp/files). Pass --force if it is not. Nothing changed.',
        )
        const forced = await runCli(
          ['init', '--client', '-o', 'second.yaml', '--force'],
          undefined,
          dir,
        )
        expect(forced.code, forced.stderr).toBe(0)
        expect(forced.stderr).toContain(
          'Created second.yaml (4 upstreams; doors at http://127.0.0.1:3000/mcp/<name>)',
        )
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 30_000)

    it('a failed backup refuses with the could-not-back-up line and removes the backups already copied', async () => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'helio-cli-adopt-')))
      try {
        writeAdoptTree(dir)
        // The step-4 writability check catches a read-only directory first; a
        // directory in the backup's place makes copyFile itself fail (EISDIR).
        mkdirSync(join(dir, '.cursor', 'mcp.json.helio-backup'))
        const before = snapshotTree(dir)
        const { code, stderr } = await runCli(['init', '--client'], undefined, dir)
        expect(code).toBe(1)
        expect(stderr.trim().split('\n').at(-1)).toBe(
          'Error: .cursor/mcp.json.helio-backup already exists; this file was already adopted. Run helio init --client --undo first. Nothing changed.',
        )
        rmSync(join(dir, '.cursor', 'mcp.json.helio-backup'), { recursive: true })
        // A read-only directory is caught by the step-4 writability check, one line.
        chmodSync(join(dir, '.vscode'), 0o500)
        try {
          const ro = await runCli(['init', '--client'], undefined, dir)
          expect(ro.code).toBe(1)
          expect(ro.stderr.trim()).toBe(
            `Error: ${join(dir, '.vscode')} is not writable (EACCES). Nothing changed.`,
          )
          expect(existsSync(join(dir, '.mcp.json.helio-backup'))).toBe(false)
        } finally {
          chmodSync(join(dir, '.vscode'), 0o700)
        }
        // A dangling symlink at the third backup path passes every step-4 check
        // (nothing exists there, the directory is writable) and makes copyFile
        // fail at step 5, after the first two backups were copied.
        symlinkSync(join(dir, 'missing', 'target'), join(dir, '.vscode', 'mcp.json.helio-backup'))
        const failed = await runCli(['init', '--client'], undefined, dir)
        expect(failed.code).toBe(1)
        expect(failed.stderr.trim().split('\n').at(-1)).toBe(
          'Error: could not back up .vscode/mcp.json (ENOENT). Nothing changed.',
        )
        expect(existsSync(join(dir, '.mcp.json.helio-backup'))).toBe(false)
        expect(existsSync(join(dir, '.cursor', 'mcp.json.helio-backup'))).toBe(false)
        expect(existsSync(join(dir, '.helio-init-client.json'))).toBe(false)
        expect(existsSync(join(dir, 'helio.yaml'))).toBe(false)
        unlinkSync(join(dir, '.vscode', 'mcp.json.helio-backup'))
        expect(snapshotTree(dir)).toEqual(before)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 20_000)

    it('a failed manifest write (step 6) removes the backups it wrote and says so', async () => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'helio-cli-adopt-')))
      try {
        writeAdoptTree(dir)
        // The manifest's temp sibling is a directory, so its write fails after the backups.
        mkdirSync(join(dir, '.helio-init-client.json.helio-tmp'))
        const before = snapshotTree(dir)
        const { code, stderr } = await runCli(['init', '--client', '--force'], undefined, dir)
        expect(code).toBe(1)
        expect(stderr.trim().split('\n').at(-1)).toBe(
          'Error: could not write .helio-init-client.json (EISDIR). The backups were removed; nothing changed.',
        )
        expect(existsSync(join(dir, '.mcp.json.helio-backup'))).toBe(false)
        expect(existsSync(join(dir, '.helio-init-client.json'))).toBe(false)
        expect(existsSync(join(dir, 'helio.yaml'))).toBe(false)
        expect(snapshotTree(dir)).toEqual(before)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 20_000)

    it('a failed client rewrite (step 8) names what was written, the way back, and the temp it could not remove; --undo restores everything', async () => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'helio-cli-adopt-')))
      try {
        writeAdoptTree(dir)
        const before = snapshotTree(dir)
        // The third client file's temp sibling is a directory: writeFile fails
        // with EISDIR after helio.yaml and the first two files were written,
        // and the unlink of that temp fails too, so the line names it.
        mkdirSync(join(dir, '.vscode', 'mcp.json.helio-tmp'))
        const { code, stderr } = await runCli(['init', '--client'], undefined, dir)
        expect(code).toBe(1)
        const tail = stderr.trim().split('\n').slice(-2)
        expect(tail[0]).toBe(
          'Error: writing .vscode/mcp.json failed (EISDIR) after helio.yaml, .mcp.json and .cursor/mcp.json were written. Run helio init --client --undo to restore everything.',
        )
        expect(tail[1]).toBe('Could not remove .vscode/mcp.json.helio-tmp; delete it.')
        expect(existsSync(join(dir, 'helio.yaml'))).toBe(true)
        expect(readFileSync(join(dir, '.mcp.json'), 'utf-8')).toContain('/mcp/files')
        expect(readFileSync(join(dir, '.vscode', 'mcp.json'), 'utf-8')).toContain('search_ping')
        rmSync(join(dir, '.vscode', 'mcp.json.helio-tmp'), { recursive: true })

        const undo = await runCli(['init', '--client', '--undo'], undefined, dir)
        expect(undo.code, undo.stderr).toBe(0)
        expect(undo.stderr).toContain(
          'helio.yaml was left in place (from .helio-init-client.json); delete it if you no longer want it.',
        )
        rmSync(join(dir, 'helio.yaml'))
        expect(snapshotTree(dir)).toEqual(before)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 20_000)

    it('a failed config write (step 7) prints no success-tense line, and --undo then says the config was not written', async () => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'helio-cli-adopt-')))
      try {
        writeAdoptTree(dir)
        const before = snapshotTree(dir)
        mkdirSync(join(dir, 'helio.yaml.helio-tmp'))
        const { code, stderr } = await runCli(['init', '--client'], undefined, dir)
        expect(code).toBe(1)
        expect(stderr).not.toContain('Copied env')
        expect(stderr).not.toContain('Set CLAUDE_PROJECT_DIR')
        const tail = stderr.trim().split('\n').slice(-2)
        expect(tail[0]).toBe(
          'Error: writing helio.yaml failed (EISDIR) before any client file was rewritten. Run helio init --client --undo to clear the backups and the manifest.',
        )
        expect(tail[1]).toBe('Could not remove helio.yaml.helio-tmp; delete it.')
        expect(existsSync(join(dir, 'helio.yaml'))).toBe(false)
        rmSync(join(dir, 'helio.yaml.helio-tmp'), { recursive: true })
        const undo = await runCli(['init', '--client', '--undo'], undefined, dir)
        expect(undo.code, undo.stderr).toBe(0)
        expect(undo.stderr).toContain(
          'helio.yaml was not written (from .helio-init-client.json); nothing to remove.\n',
        )
        expect(undo.stderr).not.toContain('was left in place')
        expect(snapshotTree(dir)).toEqual(before)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 20_000)

    it('--undo names the read error of an unreadable manifest and leaves it alone', async () => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'helio-cli-adopt-')))
      try {
        writeAdoptTree(dir)
        expect((await runCli(['init', '--client'], undefined, dir)).code).toBe(0)
        chmodSync(join(dir, '.helio-init-client.json'), 0o000)
        try {
          const { code, stderr } = await runCli(['init', '--client', '--undo'], undefined, dir)
          expect(code).toBe(1)
          expect(stderr.trim()).toBe(
            'Error: could not read .helio-init-client.json (EACCES). Nothing changed.',
          )
          expect(existsSync(join(dir, '.mcp.json.helio-backup'))).toBe(true)
        } finally {
          chmodSync(join(dir, '.helio-init-client.json'), 0o644)
        }
        writeFileSync(join(dir, '.helio-init-client.json'), '{"version": 2}')
        const bad = await runCli(['init', '--client', '--undo'], undefined, dir)
        expect(bad.code).toBe(1)
        expect(bad.stderr.trim()).toBe(
          'Error: .helio-init-client.json is not a manifest this version reads. Nothing changed.',
        )
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 20_000)

    it('a step-8 failure on the only client file says the config was written, singular', async () => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'helio-cli-adopt-')))
      try {
        writeFileSync(
          join(dir, '.mcp.json'),
          JSON.stringify({ mcpServers: { files: { command: 'node' } } }),
        )
        mkdirSync(join(dir, '.mcp.json.helio-tmp'))
        const { code, stderr } = await runCli(['init', '--client'], undefined, dir)
        expect(code).toBe(1)
        expect(stderr).toContain(
          'Error: writing .mcp.json failed (EISDIR) after helio.yaml was written. Run helio init --client --undo to restore everything.\n',
        )
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 15_000)

    it('--undo without a manifest restores the backups it can see and says the output was not recorded; with nothing, refuses', async () => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'helio-cli-adopt-')))
      try {
        writeAdoptTree(dir)
        const before = snapshotTree(dir)
        expect((await runCli(['init', '--client'], undefined, dir)).code).toBe(0)
        rmSync(join(dir, '.helio-init-client.json'))
        const undo = await runCli(['init', '--client', '--undo'], undefined, dir)
        expect(undo.code, undo.stderr).toBe(0)
        expect(undo.stderr).toContain(
          'No manifest found; the helio.yaml this adoption wrote was not recorded and is left in place.\n',
        )
        expect(undo.stderr).toMatch(/Replaced \.mcp\.json with the backup/)
        rmSync(join(dir, 'helio.yaml'))
        expect(snapshotTree(dir)).toEqual(before)

        const nothing = await runCli(['init', '--client', '--undo'], undefined, dir)
        expect(nothing.code).toBe(1)
        expect(nothing.stderr.trim()).toBe(
          'Error: no backup found for .mcp.json (.mcp.json.helio-backup), .cursor/mcp.json (.cursor/mcp.json.helio-backup), .vscode/mcp.json (.vscode/mcp.json.helio-backup) and no manifest. Nothing to undo.',
        )
        const pathed = await runCli(['init', '--client', '.mcp.json', '--undo'], undefined, dir)
        expect(pathed.code).toBe(1)
        expect(pathed.stderr.trim()).toBe(
          'Error: no backup found for .mcp.json (.mcp.json.helio-backup) and no manifest. Nothing to undo.',
        )
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 20_000)

    it('--client on a .claude.json warns below two servers and drops the approval sentence from Next', async () => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'helio-cli-adopt-')))
      try {
        const file = join(dir, '.claude.json')
        writeFileSync(
          file,
          JSON.stringify(
            {
              numStartups: 3,
              mcpServers: { helio: { type: 'http', url: 'http://127.0.0.1:8080/mcp' } },
              projects: { '/p': { mcpServers: { x: { command: 'node' } } } },
            },
            null,
            2,
          ) + '\n',
        )
        const { code, stderr } = await runCli(['init', '--client', file], undefined, dir)
        expect(code, stderr).toBe(0)
        expect(stderr).toContain(
          `Warning: ${file} holds 1 server under mcpServers (per-project servers under projects.<dir>.mcpServers were not counted or adopted). Claude Code plugins and claude.ai connectors are not in this file and cannot be routed through Helio.\n`,
        )
        expect(stderr).toContain(
          'Next: run `helio start`. Restart your MCP client. Claude Code connects user-scope servers on its next start; no approval step.\n',
        )
        expect(stderr).toContain(`Undo: from this directory, helio init --client ${file} --undo\n`)
        const doc = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>
        expect(doc['numStartups']).toBe(3)
        expect(doc['mcpServers']).toEqual({
          helio: { type: 'http', url: 'http://127.0.0.1:3000/mcp/helio' },
        })
        expect(doc['projects']).toEqual({ '/p': { mcpServers: { x: { command: 'node' } } } })
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 15_000)

    it('adopts a two-server .mcp.json and helio start serves both doors with the authority lines (end to end)', async () => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'helio-cli-adopt-e2e-')))
      const listenPort = randomChildPort()
      const dashboardPort = randomChildPort()
      try {
        writeFileSync(
          join(dir, '.mcp.json'),
          JSON.stringify(
            {
              mcpServers: {
                files: { command: 'node', args: [STDIO_MCP_FIXTURE, 'files_ping'] },
                github: { command: 'node', args: [STDIO_MCP_FIXTURE, 'github_ping'] },
              },
            },
            null,
            2,
          ),
        )
        const adopt = await runCli(
          ['init', '--client', '-o', join(dir, 'helio.yaml')],
          undefined,
          dir,
        )
        expect(adopt.code, adopt.stderr).toBe(0)
        // The written ports are 3000 and 3100; the test moves them off the fixed ports.
        const text = readFileSync(join(dir, 'helio.yaml'), 'utf-8')
          .replace('\nlisten:\n  port: 3000\n', `\nlisten:\n  port: ${String(listenPort)}\n`)
          .replace('\n  port: 3100\n', `\n  port: ${String(dashboardPort)}\n`)
        writeFileSync(join(dir, 'helio.yaml'), text)
        const baseUrl = `http://127.0.0.1:${String(listenPort)}`
        const child = spawn('node', [CLI_PATH, 'start', '-c', join(dir, 'helio.yaml')], {
          stdio: ['ignore', 'ignore', 'pipe'],
          cwd: dir,
        })
        let stderr = ''
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf-8')
        })
        try {
          await waitForProxyHealthOrExit(child, baseUrl, 8_000, () => stderr)
          await vi.waitFor(
            () => {
              expect(stderr).toContain(
                'Authority surface: 2 tool-door pairs across 2 upstreams, none annotated',
              )
            },
            { timeout: 5_000, interval: 50 },
          )
          expect(stderr).toContain(
            'Policy coverage: 0 of 2 have a rule that can match them, default allow',
          )
          expect(stderr).toContain('Upstream[files]: node (stdio)')
          expect(stderr).toContain('Upstream[github]: node (stdio)')
          for (const [name, toolName] of [
            ['files', 'files_ping'],
            ['github', 'github_ping'],
          ] as const) {
            const res = await fetch(`${baseUrl}/mcp/${name}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
            })
            expect(res.status).toBe(200)
            const body = (await res.json()) as { result: { tools: Array<{ name: string }> } }
            expect(body.result.tools[0]?.name).toBe(toolName)
          }
        } finally {
          child.kill('SIGTERM')
          await new Promise<void>((resolve) =>
            child.once('close', () => {
              resolve()
            }),
          )
        }
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 30_000)

    it('passes an adopted entry env to the spawned child (end to end)', async () => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'helio-cli-adopt-env-')))
      const listenPort = randomChildPort()
      const dashboardPort = randomChildPort()
      // The child names its tool after a variable set only in the entry's env.
      const script = [
        "const rl = require('readline').createInterface({ input: process.stdin });",
        "rl.on('line', (line) => {",
        '  let req; try { req = JSON.parse(line) } catch { return }',
        '  if (req.id === undefined || req.id === null) return;',
        '  let result = {};',
        "  if (req.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'envprobe', version: '0' } };",
        "  else if (req.method === 'tools/list') result = { tools: [{ name: 'env_' + (process.env.HELIO_ADOPT_PROBE || 'UNSET'), description: 'x', inputSchema: { type: 'object' } }] };",
        "  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + String.fromCharCode(10));",
        '});',
      ].join('\n')
      try {
        writeFileSync(
          join(dir, '.mcp.json'),
          JSON.stringify(
            {
              mcpServers: {
                probe: {
                  command: 'node',
                  args: ['-e', script],
                  env: { HELIO_ADOPT_PROBE: 'from-entry-env' },
                },
              },
            },
            null,
            2,
          ),
        )
        const adopt = await runCli(['init', '--client'], undefined, dir)
        expect(adopt.code, adopt.stderr).toBe(0)
        expect(adopt.stderr).toContain(
          'Copied env for probe into helio.yaml (HELIO_ADOPT_PROBE); the file now holds those values',
        )
        const text = readFileSync(join(dir, 'helio.yaml'), 'utf-8')
          .replace('\nlisten:\n  port: 3000\n', `\nlisten:\n  port: ${String(listenPort)}\n`)
          .replace('\n  port: 3100\n', `\n  port: ${String(dashboardPort)}\n`)
        writeFileSync(join(dir, 'helio.yaml'), text)
        const baseUrl = `http://127.0.0.1:${String(listenPort)}`
        const child = spawn('node', [CLI_PATH, 'start', '-c', join(dir, 'helio.yaml')], {
          stdio: ['ignore', 'ignore', 'pipe'],
          cwd: dir,
          env: { ...process.env, HELIO_ADOPT_PROBE: undefined },
        })
        let stderr = ''
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf-8')
        })
        try {
          await waitForProxyHealthOrExit(child, baseUrl, 8_000, () => stderr)
          const res = await fetch(`${baseUrl}/mcp/probe`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
          })
          expect(res.status).toBe(200)
          const body = (await res.json()) as { result: { tools: Array<{ name: string }> } }
          expect(body.result.tools[0]?.name).toBe('env_from-entry-env')
        } finally {
          child.kill('SIGTERM')
          await new Promise<void>((resolve) =>
            child.once('close', () => {
              resolve()
            }),
          )
        }
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 30_000)
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
          'entry missing url on the default transport',
          `version: "1"\nupstreams:\n  - name: files\n${FOOTER}`,
          ['upstreams.0.url: "url" is required when transport is "streamable-http"'],
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
        [
          'evidence.requires rule under the default legacy_header chain',
          `${NAMED_HEADER}\npolicies:\n  rules:\n    - match:\n        tool: "*"\n      action: allow\n      evidence:\n        requires: [deploy_ticket]\n${FOOTER}`,
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

      it('accepts a singular config with an evidence-gated rule under the default chain', async () => {
        // The guard is named-mode only: singular mode keeps legacy_header
        // beside evidence-gated rules (wire sessions are proxy-relayed 1:1
        // there, so the forgeability concern the guard exists for is moot).
        const dir = mkdtempSync(join(tmpdir(), 'helio-cli-test-'))
        const configPath = join(dir, 'helio.yaml')
        writeFileSync(
          configPath,
          'version: "1"\n' +
            'upstream:\n' +
            '  url: "http://localhost:8080/mcp"\n' +
            'policies:\n' +
            '  rules:\n' +
            '    - match:\n' +
            '        tool: "*"\n' +
            '      action: allow\n' +
            '      requires: [deploy_ticket]\n' +
            FOOTER,
        )
        try {
          const { code, stderr } = await runCli(['validate', '-c', configPath])
          expect(code).toBe(0)
          expect(stderr).toContain(`Config is valid: ${configPath} (1 policy rule, 0 budgets)`)
        } finally {
          rmSync(dir, { recursive: true, force: true })
        }
      })

      it('accepts a named config with an evidence.requires rule on a header-only chain', async () => {
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
            '        tool: "*"\n' +
            '      action: allow\n' +
            '      evidence:\n' +
            '        requires: [deploy_ticket]\n' +
            FOOTER,
        )
        try {
          const { code, stderr } = await runCli(['validate', '-c', configPath])
          expect(code).toBe(0)
          expect(stderr).toContain(`Config is valid: ${configPath} (1 policy rule, 0 budgets)`)
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

    it('warns while still validating when a stdio upstream sets a url (issue #324)', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'helio-cli-test-'))
      const configPath = join(dir, 'helio.yaml')

      writeFileSync(
        configPath,
        'version: "1"\nupstream:\n  transport: stdio\n  command: node\n  url: "stdio://legacy"\ndashboard:\n  enabled: false\n',
      )

      try {
        const { code, stderr } = await runCli(['validate', '-c', configPath])
        expect(code).toBe(0)
        expect(stderr).toContain('upstream.url is ignored when transport is "stdio"')
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
      // scalar. Pins the rendered CLI output so a future message change fails
      // here instead of silently drifting from docs/configuration.md.
      writeFileSync(
        configPath,
        'version: "1"\nupstream:\n  transport: streamable-http\ndashboard:\n  enabled: false\n',
      )

      try {
        const { code, stderr } = await runCli(['validate', '-c', configPath])
        expect(code).toBe(1)
        expect(stderr).toContain('Invalid config: Invalid configuration (1 error)')
        expect(stderr).toContain(
          'upstream.url: "url" is required when transport is "streamable-http"',
        )
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

    it.each(COMPILE_FAILURE_FACES)(
      'reports %s on one line and exits 1 (issue #195)',
      async (_name, tail, expectedLine) => {
        const { dir, configPath } = writeCompileFailureConfig(tail)
        try {
          const result = await runCli(['validate', '-c', configPath])
          expect(result.code).toBe(1)
          expect(result.stderr).toContain(expectedLine)
          expect(result.stderr).not.toContain('Unhandled promise rejection')
        } finally {
          rmSync(dir, { recursive: true, force: true })
        }
      },
      15_000,
    )

    it.each(AUDIT_PATH_FACES)(
      'warns about an audit.path with %s on one line and still prints Config is valid (issue #388)',
      async (_name, build) => {
        const dir = mkdtempSync(join(tmpdir(), 'helio-cli-audit-path-'))
        try {
          const { auditPath, expectedBody } = build(dir)
          const configPath = writeAuditPathConfig(dir, auditPath)
          const result = await runCli(['validate', '-c', configPath], undefined, dir)
          // validate runs on whatever host has the file, which need not be the
          // one that will run start (a config for a container, a service
          // account's directory), so the directory state is a warning here and
          // a refusal on start and export.
          expect(result.code).toBe(0)
          expect(result.stderr).toContain(
            `Warning: ${expectedBody} (helio start will refuse this path)`,
          )
          expect(result.stderr).toContain('Config is valid')
        } finally {
          rmSync(dir, { recursive: true, force: true })
        }
      },
      15_000,
    )

    it.skipIf(!CAN_TEST_UNWRITABLE)(
      'warns about an audit.path in a directory this user cannot write and still prints Config is valid (issue #388)',
      async () => {
        const dir = mkdtempSync(join(tmpdir(), 'helio-cli-audit-ro-'))
        const roDir = join(dir, 'ro')
        mkdirSync(roDir)
        chmodSync(roDir, 0o500)
        try {
          const configPath = writeAuditPathConfig(dir, join(roDir, 'audit.db'))
          const result = await runCli(['validate', '-c', configPath], undefined, dir)
          expect(result.code).toBe(0)
          expect(result.stderr).toContain(
            `Warning: audit.path: directory ${roDir} is not writable by this user (helio start will refuse this path)`,
          )
          expect(result.stderr).toContain('Config is valid')
        } finally {
          chmodSync(roDir, 0o700)
          rmSync(dir, { recursive: true, force: true })
        }
      },
      15_000,
    )

    it.skipIf(!CAN_TEST_UNWRITABLE)(
      'warns about an audit.path in a directory this user cannot search and still prints Config is valid (issue #388)',
      async () => {
        const dir = mkdtempSync(join(tmpdir(), 'helio-cli-audit-wo-'))
        const woDir = join(dir, 'wo')
        mkdirSync(woDir)
        chmodSync(woDir, 0o200)
        try {
          const auditPath = join(woDir, 'audit.db')
          const configPath = writeAuditPathConfig(dir, auditPath)
          const result = await runCli(['validate', '-c', configPath], undefined, dir)
          expect(result.code).toBe(0)
          // The directory stat and W_OK pass on a 0200 directory; the file
          // stat is what fails, so the line names the file.
          expect(result.stderr).toContain(
            `Warning: audit.path: ${auditPath} cannot be accessed (EACCES) (helio start will refuse this path)`,
          )
          expect(result.stderr).toContain('Config is valid')
        } finally {
          chmodSync(woDir, 0o700)
          rmSync(dir, { recursive: true, force: true })
        }
      },
      15_000,
    )

    it.skipIf(!CAN_TEST_UNWRITABLE)(
      'accepts an existing audit database with its sidecars in a directory this user cannot write (issue #388)',
      async () => {
        const dir = mkdtempSync(join(tmpdir(), 'helio-cli-audit-sidecars-'))
        const dbDir = join(dir, 'db')
        mkdirSync(dbDir)
        try {
          const dbPath = seedReadOnlyDirWithSidecars(dbDir)
          const configPath = writeAuditPathConfig(dir, dbPath)
          const result = await runCli(['validate', '-c', configPath], undefined, dir)
          expect(result.code).toBe(0)
          expect(result.stderr).toContain('Config is valid')
          // An existing file needs no directory write; nothing to warn about.
          expect(result.stderr).not.toContain('Warning: audit.path')
        } finally {
          chmodSync(dbDir, 0o700)
          rmSync(dir, { recursive: true, force: true })
        }
      },
      15_000,
    )

    it.skipIf(!CAN_TEST_UNWRITABLE)(
      'accepts audit.path :memory: without looking at the working directory (issue #388)',
      async () => {
        const dir = mkdtempSync(join(tmpdir(), 'helio-cli-audit-memory-'))
        const cwd = join(dir, 'cwd')
        mkdirSync(cwd)
        chmodSync(cwd, 0o500)
        try {
          const configPath = writeAuditPathConfig(dir, ':memory:')
          const result = await runCli(['validate', '-c', configPath], undefined, cwd)
          expect(result.code).toBe(0)
          expect(result.stderr).toContain('Config is valid')
          // :memory: has no directory: the unwritable cwd is never looked at.
          expect(result.stderr).not.toContain('Warning: audit.path')
        } finally {
          chmodSync(cwd, 0o700)
          rmSync(dir, { recursive: true, force: true })
        }
      },
      15_000,
    )

    it('reports an empty audit.path as a schema error and exits 1 (issue #406)', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'helio-cli-audit-empty-'))
      try {
        const configPath = writeAuditPathConfig(dir, '')
        const result = await runCli(['validate', '-c', configPath], undefined, dir)
        expect(result.code).toBe(1)
        expect(result.stderr).toContain('Invalid config: Invalid configuration (1 error)')
        expect(result.stderr).toContain(
          '  audit.path: Too small: expected string to have >=1 characters',
        )
        expect(result.stderr).not.toContain('Config is valid')
        // The schema names the blank field; the directory check never runs,
        // so the working directory is not diagnosed as "a directory".
        expect(result.stderr).not.toContain('is a directory, not a file')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 15_000)

    it('reports a whitespace-only audit.path as a schema error and exits 1 (issue #406)', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'helio-cli-audit-spaces-'))
      try {
        const configPath = writeAuditPathConfig(dir, '   ')
        const result = await runCli(['validate', '-c', configPath], undefined, dir)
        expect(result.code).toBe(1)
        expect(result.stderr).toContain('Invalid config: Invalid configuration (1 error)')
        expect(result.stderr).toContain(
          '  audit.path: Too small: expected string to have >=1 characters',
        )
        expect(result.stderr).not.toContain('Config is valid')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 15_000)

    it('reports an audit.path that interpolates to nothing as a schema error (issue #406)', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'helio-cli-audit-empty-var-'))
      try {
        // A variable that is set but empty substitutes '' (an unset one is
        // already an interpolation error), so the blank reaches the schema.
        const configPath = writeAuditPathConfig(dir, '${HELIO406_TEST_PATH}')
        const result = await runCli(
          ['validate', '-c', configPath],
          { ...process.env, HELIO406_TEST_PATH: '' },
          dir,
        )
        expect(result.code).toBe(1)
        expect(result.stderr).toContain('Invalid config: Invalid configuration (1 error)')
        expect(result.stderr).toContain(
          '  audit.path: Too small: expected string to have >=1 characters',
        )
        expect(result.stderr).not.toContain('Config is valid')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 15_000)
  })

  describe('secret', () => {
    it('prints a fresh secret and its digest on stdout', async () => {
      const { code, stdout, stderr } = await runCli(['secret'])
      expect(code).toBe(0)
      expect(stderr).toBe('')
      const lines = stdout.trimEnd().split('\n')
      expect(lines).toHaveLength(2)
      const secret = /^secret: ([a-f0-9]{64})$/.exec(lines[0] ?? '')?.[1]
      const digest = /^digest: (sha256:[a-f0-9]{64})$/.exec(lines[1] ?? '')?.[1]
      expect(secret).toBeDefined()
      expect(digest).toBe(secretDigest(secret ?? ''))
    })

    it('prints a different pair each time', async () => {
      const first = await runCli(['secret'])
      const second = await runCli(['secret'])
      expect(first.stdout).not.toBe(second.stdout)
    }, 15_000)
  })

  describe('config hash', () => {
    it('prints the bare SHA-256 of the file bytes on stdout, matching the loader and shasum (issue #341)', async () => {
      const { dir, configPath } = writeStartConfig()
      try {
        const expected = createHash('sha256').update(readFileSync(configPath)).digest('hex')
        const { code, stdout, stderr } = await runCli(['config', 'hash', '-c', configPath])
        expect(code).toBe(0)
        expect(stdout).toBe(`${expected}\n`)
        expect(stderr).toBe('')
        // writeStartConfig names the file helio.yaml, so the default path resolves in `dir`.
        const byDefault = await runCli(['config', 'hash'], undefined, dir)
        expect(byDefault.code).toBe(0)
        expect(byDefault.stdout).toBe(`${expected}\n`)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 15_000)

    it('exits 1 with the read error on stderr and nothing on stdout for a missing file', async () => {
      const { code, stdout, stderr } = await runCli([
        'config',
        'hash',
        '-c',
        '/nonexistent/helio.yaml',
      ])
      expect(code).toBe(1)
      expect(stdout).toBe('')
      expect(stderr).toContain('Error: Cannot read config file: /nonexistent/helio.yaml')
    })

    it('prints the group help and exits 1 when no subcommand is given', async () => {
      const { code, stdout, stderr } = await runCli(['config'])
      expect(code).toBe(1)
      expect(`${stdout}${stderr}`).toContain('hash')
      // Observed on commander 14.0.3: the group help goes to stderr with exit 1.
      expect(`${stdout}${stderr}`).toContain('Usage: helio config')
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
      expect(contents).toMatch(/dashboard:[\s\S]*?api_secret:\s*"sha256:[a-f0-9]{64}"/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 15_000)

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
  }, 15_000)

  // --- helio start ---

  describe('start', () => {
    it('warns when the dashboard secret is a plaintext literal in the file', async () => {
      const { dir, configPath } = writeStartConfig()
      try {
        const stderr = await startAndCaptureStderr(['-c', configPath], {
          readyMarker: /Approvals:/,
        })
        expect(stderr).toContain(`dashboard.api_secret is stored as plaintext in ${configPath}`)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 15_000)

    it('does not warn when the dashboard secret comes from the environment', async () => {
      const { dir, configPath } = writeStartConfig()
      try {
        const original = readFileSync(configPath, 'utf-8')
        writeFileSync(
          configPath,
          original.replace(/api_secret: ".*"/, 'api_secret: "${HELIO_DASHBOARD_SECRET}"'),
        )
        const stderr = await startAndCaptureStderr(['-c', configPath], {
          readyMarker: /Approvals:/,
          env: { ...process.env, HELIO_DASHBOARD_SECRET: 'from-the-environment' },
        })
        expect(stderr).not.toContain('stored as plaintext')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 15_000)

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

    it('boots a mixed-era two-HTTP-upstream config with per-door era detection (issue #296)', async () => {
      // Two REAL HTTP fixtures — one legacy stateful, one 2026-07-28-only —
      // served by the SHIPPED binary. The smoke covers what the in-process
      // suite cannot: dist/cli.js composing two real HTTP upstreams, with
      // both door-tagged era lines on real process stderr.
      const legacy = await startSessionEnforcingHttpMcpServer()
      const modern = await startModernOnlyHttpMcpServer()
      const dir = mkdtempSync(join(tmpdir(), 'helio-cli-mixed-era-'))
      const configPath = join(dir, 'helio.yaml')
      const listenPort = randomChildPort()
      writeFileSync(
        configPath,
        `
version: "1"
upstreams:
  - name: alpha
    url: "http://127.0.0.1:${String(legacy.port)}/mcp"
  - name: beta
    url: "http://127.0.0.1:${String(modern.port)}/mcp"
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
      const baseUrl = `http://127.0.0.1:${String(listenPort)}`
      const child = spawn('node', [CLI_PATH, 'start', '-c', configPath], {
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      let stderr = ''
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf-8')
      })
      try {
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

        // One governed call per door. The legacy door needs its fixture's
        // handshake: initialize, then the minted wire session on the call.
        const initRes = await fetch(`${baseUrl}/mcp/alpha`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2025-06-18',
              capabilities: {},
              clientInfo: { name: 'cli-smoke', version: '1' },
            },
          }),
        })
        expect(initRes.status).toBe(200)
        const wireSession = initRes.headers.get('mcp-session-id')
        expect(wireSession).toBeTruthy()
        await fetch(`${baseUrl}/mcp/alpha`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'mcp-session-id': wireSession as string,
          },
          body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        })
        const alphaCall = await fetch(`${baseUrl}/mcp/alpha`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'mcp-session-id': wireSession as string,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: 'get_weather', arguments: { city: 'Berlin' } },
          }),
        })
        expect(alphaCall.status).toBe(200)
        const alphaBody = (await alphaCall.json()) as {
          error?: unknown
          result?: { content: Array<{ text: string }> }
        }
        expect(alphaBody.error).toBeUndefined()
        expect(alphaBody.result?.content[0]?.text).toBe('Sunny, 22°C in Berlin')

        const betaCall = await fetch(`${baseUrl}/mcp/beta`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-helio-session-id': 'cli-smoke-s1',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: { name: 'get_status', arguments: {} },
          }),
        })
        expect(betaCall.status).toBe(200)
        const betaBody = (await betaCall.json()) as {
          error?: unknown
          result?: { content: Array<{ text: string }> }
        }
        expect(betaBody.error).toBeUndefined()
        expect(betaBody.result?.content[0]?.text).toContain('get_status executed')

        // One deny probe per door: the mounts serve the GOVERNED forwarders.
        for (const [door, id] of [
          ['alpha', 4],
          ['beta', 5],
        ] as const) {
          const deniedRes = await fetch(`${baseUrl}/mcp/${door}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-helio-session-id': 'cli-smoke-s1',
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id,
              method: 'tools/call',
              params: { name: 'denied_probe', arguments: {} },
            }),
          })
          const deniedBody = (await deniedRes.json()) as {
            error?: { code: number; data?: { blocked?: boolean; rule?: string } }
          }
          expect(deniedBody.error?.code).toBe(-32001)
          expect(deniedBody.error?.data?.blocked).toBe(true)
          expect(deniedBody.error?.data?.rule).toBe('deny-probe')
        }

        // Both door-tagged era lines on the shipped binary's real stderr.
        expect(stderr).toContain(
          '[helio][alpha] Upstream MCP era detected: legacy (initialize handshake)',
        )
        expect(stderr).toContain(
          '[helio][beta] Upstream MCP era detected: modern (2026-07-28, via server/discover)',
        )

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
        await legacy.close()
        await modern.close()
      }
    }, 15_000)

    it('all-or-nothing boot: an unreachable entry fails startup naming it (issue #294)', async () => {
      const closedPort = await getClosedPort()
      const dir = mkdtempSync(join(tmpdir(), 'helio-cli-multi-fail-'))
      const configPath = join(dir, 'helio.yaml')
      const listenPort = randomChildPort()
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
        expect(result.stderr).toContain('(or upstreams[].url)')
        expect(result.stderr).not.toContain('Unhandled promise rejection')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 15_000)

    it('warns before connecting when more than 16 upstreams are configured (issue #294)', async () => {
      const closedPort = await getClosedPort()
      const dir = mkdtempSync(join(tmpdir(), 'helio-cli-multi-many-'))
      const configPath = join(dir, 'helio.yaml')
      const listenPort = randomChildPort()
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

    it('warns before spawning when a stdio upstream sets a url (issue #324)', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'helio-cli-stdio-url-'))
      const configPath = join(dir, 'helio.yaml')
      const listenPort = randomChildPort()
      // An absolute path under the tmpdir: a bare name would resolve through
      // PATH, and a found-but-exiting binary hits the stdio wrapper's retry
      // loop instead of failing fast with ENOENT.
      const missingCommand = join(dir, 'nonexistent-helio-stdio-324')
      writeFileSync(
        configPath,
        `version: "1"\nupstream:\n  transport: stdio\n  command: "${missingCommand}"\n  url: "stdio://legacy"\nlisten:\n  port: ${String(listenPort)}\n  host: 127.0.0.1\ndashboard:\n  enabled: false\naudit:\n  path: "${join(dir, 'audit.db')}"\n`,
      )
      try {
        const result = await runCli(['start', '-c', configPath])
        expect(result.code).toBe(1)
        const warningIndex = result.stderr.indexOf(
          '[helio] Warning: upstream.url is ignored when transport is "stdio"',
        )
        // ENOENT, never `spawn`: the warning text itself says "spawns", so a
        // `spawn` needle would match inside the warning line and tautologize
        // the ordering assert below.
        const failureIndex = result.stderr.indexOf('ENOENT')
        expect(warningIndex).toBeGreaterThanOrEqual(0)
        expect(failureIndex).toBeGreaterThanOrEqual(0)
        // The operator hears the warning even though the spawn fails: it
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
      const listenPort = randomChildPort()
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
        expect(result.stderr).toContain('(or upstreams[].url)')
        // Singular mode: the underlying message alone — no minted upstream
        // name, no crash dump.
        expect(result.stderr).not.toContain('upstream "')
        expect(result.stderr).not.toContain('Unhandled promise rejection')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 15_000)

    it.each(COMPILE_FAILURE_FACES)(
      'refuses %s on one line before anything starts (issue #195)',
      async (_name, tail, expectedLine) => {
        const { dir, configPath, auditPath } = writeCompileFailureConfig(tail)
        try {
          const result = await runCli(['start', '-c', configPath])
          expect(result.code).toBe(1)
          expect(result.stderr).toContain(expectedLine)
          // The same line validate prints: no rejection wrapper, no stack.
          expect(result.stderr).not.toContain('Unhandled promise rejection')
          expect(result.stderr).not.toMatch(/\n\s+at /)
          expect(result.stderr).not.toContain('Helio proxy listening')
          // Refused before any side effect: the audit DB is never opened.
          expect(existsSync(auditPath)).toBe(false)
        } finally {
          rmSync(dir, { recursive: true, force: true })
        }
      },
      15_000,
    )

    it('refuses a compile failure before a missing stdio command is spawned (issue #195)', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'helio-cli-compile-stdio-'))
      const configPath = join(dir, 'helio.yaml')
      const listenPort = randomChildPort()
      // An absolute path that does not exist: spawn fails fast with ENOENT
      // (the #324 shape), so the outcome is deterministic on either ordering.
      const missingCommand = join(dir, 'nonexistent-helio-stdio-195')
      writeFileSync(
        configPath,
        `version: "1"
upstream:
  transport: stdio
  command: "${missingCommand}"
listen:
  port: ${String(listenPort)}
  host: 127.0.0.1
dashboard:
  enabled: false
audit:
  path: "${join(dir, 'audit.db')}"
${RULE_CATASTROPHIC_TAIL}`,
      )
      try {
        const result = await runCli(['start', '-c', configPath])
        expect(result.code).toBe(1)
        // The compile refuses the file before the connect loop, so the stdio
        // command is never spawned and ENOENT never appears.
        expect(result.stderr).toContain(RULE_CATASTROPHIC_LINE)
        expect(result.stderr).not.toContain('ENOENT')
        expect(result.stderr).not.toContain('Unhandled promise rejection')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 15_000)

    it('prints a policy warning before a connect failure (issue #195)', async () => {
      const closedPort = await getClosedPort()
      const dir = mkdtempSync(join(tmpdir(), 'helio-cli-warn-order-'))
      const configPath = join(dir, 'helio.yaml')
      const listenPort = randomChildPort()
      // limits.key "agent" is the one semantic policy warning the schema lets
      // through; the sse upstream on a just-closed port fails with ECONNREFUSED.
      writeFileSync(
        configPath,
        `version: "1"
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
policies:
  default: allow
  rules:
    - name: throttle
      match:
        tool: "delete_*"
      action: rate_limit
      limits:
        max_calls: 5
        window: 1m
        key: agent
`,
      )
      try {
        const result = await runCli(['start', '-c', configPath])
        expect(result.code).toBe(1)
        const warningIndex = result.stderr.indexOf(
          'Warning: policy rule "throttle": limits.key "agent" is not yet supported',
        )
        const failureIndex = result.stderr.indexOf('is unreachable (ECONNREFUSED)')
        expect(warningIndex).toBeGreaterThanOrEqual(0)
        expect(failureIndex).toBeGreaterThanOrEqual(0)
        // The compile (warnings included) precedes the connect loop, so the
        // operator hears the policy warning even when the upstream is down.
        expect(warningIndex).toBeLessThan(failureIndex)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 15_000)

    it.each(AUDIT_PATH_FACES)(
      'refuses an audit.path with %s on one line before anything starts (issue #388)',
      async (_name, build) => {
        const dir = mkdtempSync(join(tmpdir(), 'helio-cli-audit-path-'))
        try {
          const { auditPath, expectedBody, absentAfter } = build(dir)
          const configPath = writeAuditPathConfig(dir, auditPath)
          const result = await runCli(['start', '-c', configPath], undefined, dir)
          expect(result.code).toBe(1)
          expect(result.stderr).toContain(`Invalid config: ${expectedBody}`)
          // The body validate warns with, as a refusal: no rejection wrapper, no stack.
          expect(result.stderr).not.toContain('Unhandled promise rejection')
          expect(result.stderr).not.toMatch(/\n\s+at /)
          expect(result.stderr).not.toContain('Helio proxy listening')
          // Refused, not repaired: the directory is never created.
          if (absentAfter !== undefined) expect(existsSync(absentAfter)).toBe(false)
        } finally {
          rmSync(dir, { recursive: true, force: true })
        }
      },
      15_000,
    )

    it.skipIf(!CAN_TEST_UNWRITABLE)(
      'refuses an audit.path in a directory this user cannot write on one line before anything starts (issue #388)',
      async () => {
        const dir = mkdtempSync(join(tmpdir(), 'helio-cli-audit-ro-'))
        const roDir = join(dir, 'ro')
        mkdirSync(roDir)
        chmodSync(roDir, 0o500)
        try {
          const configPath = writeAuditPathConfig(dir, join(roDir, 'audit.db'))
          const result = await runCli(['start', '-c', configPath], undefined, dir)
          expect(result.code).toBe(1)
          expect(result.stderr).toContain(
            `Invalid config: audit.path: directory ${roDir} is not writable by this user`,
          )
          expect(result.stderr).not.toContain('Unhandled promise rejection')
          expect(result.stderr).not.toMatch(/\n\s+at /)
          expect(result.stderr).not.toContain('Helio proxy listening')
        } finally {
          chmodSync(roDir, 0o700)
          rmSync(dir, { recursive: true, force: true })
        }
      },
      15_000,
    )

    it.skipIf(!CAN_TEST_UNWRITABLE)(
      'refuses an audit.path in a directory this user cannot search on one line before anything starts (issue #388)',
      async () => {
        const dir = mkdtempSync(join(tmpdir(), 'helio-cli-audit-wo-'))
        const woDir = join(dir, 'wo')
        mkdirSync(woDir)
        chmodSync(woDir, 0o200)
        try {
          const auditPath = join(woDir, 'audit.db')
          const configPath = writeAuditPathConfig(dir, auditPath)
          const result = await runCli(['start', '-c', configPath], undefined, dir)
          expect(result.code).toBe(1)
          expect(result.stderr).toContain(
            `Invalid config: audit.path: ${auditPath} cannot be accessed (EACCES)`,
          )
          expect(result.stderr).not.toContain('Unhandled promise rejection')
          expect(result.stderr).not.toMatch(/\n\s+at /)
          expect(result.stderr).not.toContain('Helio proxy listening')
        } finally {
          chmodSync(woDir, 0o700)
          rmSync(dir, { recursive: true, force: true })
        }
      },
      15_000,
    )

    it.skipIf(!CAN_TEST_UNWRITABLE)(
      'boots on an existing audit database with its sidecars in a directory this user cannot write (issue #388)',
      async () => {
        const dir = mkdtempSync(join(tmpdir(), 'helio-cli-audit-sidecars-'))
        const dbDir = join(dir, 'db')
        mkdirSync(dbDir)
        try {
          const dbPath = seedReadOnlyDirWithSidecars(dbDir)
          const configPath = writeAuditPathConfig(dir, dbPath)
          // The Audit: line prints after the listening line and the snapshot
          // resolves on the first match, so wait for both before asserting on it.
          const stderr = await startAndCaptureStderr(['-c', configPath], {
            readyMarker: [/Helio proxy listening/, /Audit: /],
          })
          expect(stderr).toContain('Helio proxy listening')
          expect(stderr).toContain(`Audit: ${dbPath}`)
          expect(stderr).not.toContain('Invalid config: audit.path')
        } finally {
          chmodSync(dbDir, 0o700)
          rmSync(dir, { recursive: true, force: true })
        }
      },
      15_000,
    )

    it('refuses a missing audit directory before a missing stdio command is spawned (issue #388)', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'helio-cli-audit-stdio-'))
      const configPath = join(dir, 'helio.yaml')
      const listenPort = randomChildPort()
      // An absolute path that does not exist: spawn fails fast with ENOENT
      // (the #324 shape), so the outcome is deterministic on either ordering.
      const missingCommand = join(dir, 'nonexistent-helio-stdio-388')
      const missingDir = join(dir, 'no-such-dir')
      writeFileSync(
        configPath,
        `version: "1"
upstream:
  transport: stdio
  command: "${missingCommand}"
listen:
  port: ${String(listenPort)}
  host: 127.0.0.1
dashboard:
  enabled: false
audit:
  path: "${join(missingDir, 'audit.db')}"
`,
      )
      try {
        const result = await runCli(['start', '-c', configPath])
        expect(result.code).toBe(1)
        // The audit check refuses the file before the connect loop, so the
        // stdio command is never spawned and ENOENT never appears.
        expect(result.stderr).toContain(
          `Invalid config: audit.path: directory ${missingDir} does not exist`,
        )
        expect(result.stderr).not.toContain('ENOENT')
        expect(result.stderr).not.toContain('Unhandled promise rejection')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 15_000)

    it('refuses an empty audit.path as a schema error before anything starts (issue #406)', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'helio-cli-audit-empty-start-'))
      try {
        const configPath = writeAuditPathConfig(dir, '')
        const result = await runCli(['start', '-c', configPath], undefined, dir)
        expect(result.code).toBe(1)
        expect(result.stderr).toContain('Error: Invalid configuration (1 error)')
        expect(result.stderr).toContain(
          '  audit.path: Too small: expected string to have >=1 characters',
        )
        expect(result.stderr).not.toContain('Helio proxy listening')
        expect(result.stderr).not.toContain('Unhandled promise rejection')
        // The schema fires first; the directory check never sees the blank.
        expect(result.stderr).not.toContain('is a directory, not a file')
        expect(result.stderr).not.toContain('Audit:')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 15_000)

    it('refuses a whitespace-only audit.path as a schema error before a missing stdio command is spawned (issue #406)', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'helio-cli-audit-spaces-stdio-'))
      const configPath = join(dir, 'helio.yaml')
      const listenPort = randomChildPort()
      // An absolute path that does not exist: spawn fails fast with ENOENT,
      // so the outcome is deterministic on either ordering. A whitespace-only
      // path would otherwise pass the directory check and open a temporary
      // database, and a plain start would never exit.
      const missingCommand = join(dir, 'nonexistent-helio-stdio-406')
      writeFileSync(
        configPath,
        `version: "1"
upstream:
  transport: stdio
  command: "${missingCommand}"
listen:
  port: ${String(listenPort)}
  host: 127.0.0.1
dashboard:
  enabled: false
audit:
  path: "   "
`,
      )
      try {
        const result = await runCli(['start', '-c', configPath], undefined, dir)
        expect(result.code).toBe(1)
        expect(result.stderr).toContain('Error: Invalid configuration (1 error)')
        expect(result.stderr).toContain(
          '  audit.path: Too small: expected string to have >=1 characters',
        )
        // Refused by the schema before the connect loop: the stdio command is
        // never spawned, nothing listens, nothing is recorded or created.
        expect(result.stderr).not.toContain('ENOENT')
        expect(result.stderr).not.toContain('Helio proxy listening')
        expect(result.stderr).not.toContain('Unhandled promise rejection')
        expect(result.stderr).not.toContain('is a directory, not a file')
        expect(readdirSync(dir)).toEqual(['helio.yaml'])
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

    it('writes exactly one policy_reload record per reload attempt (issue #341)', async () => {
      const { dir, configPath } = writeStartConfig()
      const auditPath = join(dir, 'audit.db')
      const child = spawn('node', [CLI_PATH, 'start', '-c', configPath], {
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      let stderr = ''
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf-8')
      })
      const waitFor = async (predicate: () => boolean, timeoutMs: number): Promise<void> => {
        const started = Date.now()
        while (Date.now() - started < timeoutMs) {
          if (predicate()) return
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
        throw new Error(`Timed out. stderr:\n${stderr}`)
      }
      // The hash every row is stamped with must be the ACTIVE config's, not the
      // bytes of a refused edit.
      const hashOf = (text: string): string =>
        createHash('sha256').update(text, 'utf-8').digest('hex')
      type ReloadRow = {
        outcome: string | null
        block_reason: string | null
        config_sha256: string | null
      }
      const reloadRows = (): ReloadRow[] => {
        if (!existsSync(auditPath)) return []
        const db = new Database(auditPath)
        try {
          return db
            .prepare(
              `SELECT json_extract(evidence_chain, '$.policy_reload.outcome') AS outcome, block_reason,
                      config_sha256
               FROM audit_records WHERE record_kind = 'policy_reload' ORDER BY created_at, rowid`,
            )
            .all() as ReloadRow[]
        } finally {
          db.close()
        }
      }
      try {
        await waitFor(() => stderr.includes(`Watching ${configPath} for policy changes`), 8_000)
        await new Promise((resolve) => setTimeout(resolve, 100)) // WATCH_ARM_GRACE_MS
        const original = readFileSync(configPath, 'utf-8')

        // 1. applied
        const appliedText = `${original}policies:\n  default: deny\n`
        writeFileSync(configPath, appliedText)
        await waitFor(() => stderr.includes('Policy reloaded: 0 rules (default: deny)'), 8_000)
        await waitFor(() => reloadRows().length >= 1, 5_000)
        expect(reloadRows()).toEqual([
          { outcome: 'applied', block_reason: null, config_sha256: hashOf(appliedText) },
        ])

        // 2. rejected_invalid
        writeFileSync(configPath, `${original}policies:\n  rules: [\n`)
        await waitFor(
          () => stderr.includes('Config reload failed (keeping current configuration)'),
          8_000,
        )
        await waitFor(() => reloadRows().length >= 2, 5_000)
        expect(reloadRows()[1]).toEqual({
          outcome: 'rejected_invalid',
          block_reason: 'rejected_invalid',
          config_sha256: hashOf(appliedText),
        })

        // 3. rejected_unroutable: the channel and the rule that needs it arrive in the same edit,
        //    so validation passes and only the running surface refuses it.
        writeFileSync(
          configPath,
          `${original}approval:\n  channels:\n    - type: webhook\n      name: hook\n      url: http://127.0.0.1:1/hook\npolicies:\n  rules:\n    - name: gated\n      match:\n        tool: delete_*\n      action: require_approval\n      approval:\n        channel: hook\n`,
        )
        await waitFor(
          () => stderr.includes('approval routing is not available in the running process'),
          8_000,
        )
        await waitFor(() => reloadRows().length >= 3, 5_000)
        expect(reloadRows()[2]).toEqual({
          outcome: 'rejected_unroutable',
          block_reason: 'rejected_unroutable',
          config_sha256: hashOf(appliedText),
        })
        expect(reloadRows()).toHaveLength(3)
      } finally {
        child.kill('SIGTERM')
        await waitForChildExit(child, 5_000).catch(() => undefined)
        rmSync(dir, { recursive: true, force: true })
      }
    }, 40_000)

    // uid 0 reads a mode-0000 file, so the loss cannot be provoked as root.
    it.skipIf(process.getuid?.() === 0)(
      're-arms the config watch and reloads once a replaced file can be read again (issue #352; skipped as root, which reads a mode-0000 file)',
      async () => {
        const { dir, configPath } = writeStartConfig()
        const auditPath = join(dir, 'audit.db')
        const child = spawn('node', [CLI_PATH, 'start', '-c', configPath], {
          stdio: ['ignore', 'ignore', 'pipe'],
        })
        let stderr = ''
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf-8')
        })
        const waitFor = async (predicate: () => boolean, timeoutMs: number): Promise<void> => {
          const started = Date.now()
          while (Date.now() - started < timeoutMs) {
            if (predicate()) return
            await new Promise((resolve) => setTimeout(resolve, 50))
          }
          throw new Error(`Timed out. stderr:\n${stderr}`)
        }
        const hashOf = (text: string): string =>
          createHash('sha256').update(text, 'utf-8').digest('hex')
        type ReloadRow = {
          outcome: string | null
          block_reason: string | null
          config_sha256: string | null
        }
        const reloadRows = (): ReloadRow[] => {
          if (!existsSync(auditPath)) return []
          const db = new Database(auditPath)
          try {
            return db
              .prepare(
                `SELECT json_extract(evidence_chain, '$.policy_reload.outcome') AS outcome, block_reason,
                        config_sha256
                 FROM audit_records WHERE record_kind = 'policy_reload' ORDER BY created_at, rowid`,
              )
              .all() as ReloadRow[]
          } finally {
            db.close()
          }
        }
        const watchingLine = `Watching ${configPath} for policy changes`
        const watchingLines = (): number => stderr.split(watchingLine).length - 1
        try {
          await waitFor(() => watchingLines() >= 1, 8_000)
          await new Promise((resolve) => setTimeout(resolve, 100)) // WATCH_ARM_GRACE_MS
          const original = readFileSync(configPath, 'utf-8')

          // 1. The file is replaced by a new inode this process cannot read:
          //    the watch is lost, the loss line says it is retrying, one row.
          const replacedText = `${original}policies:\n  default: deny\n`
          writeFileSync(`${configPath}.tmp`, replacedText)
          chmodSync(`${configPath}.tmp`, 0o000)
          renameSync(`${configPath}.tmp`, configPath)
          await waitFor(
            () =>
              stderr.includes(
                'Config watch failed (keeping current configuration; retrying every 1s until ' +
                  'the file can be read again): EACCES',
              ),
            8_000,
          )
          await waitFor(() => reloadRows().length >= 1, 5_000)
          expect(reloadRows()).toEqual([
            {
              outcome: 'watch_failed',
              block_reason: 'watch_failed',
              config_sha256: hashOf(original),
            },
          ])
          expect(watchingLines()).toBe(1)

          // 2. The repair: the watch re-arms, the Watching line prints again,
          //    and the replaced file reloads without an edit or a restart.
          chmodSync(configPath, 0o644)
          await waitFor(() => watchingLines() >= 2, 8_000)
          await waitFor(() => stderr.includes('Policy reloaded: 0 rules (default: deny)'), 8_000)
          await waitFor(() => reloadRows().length >= 2, 5_000)
          expect(reloadRows()).toEqual([
            {
              outcome: 'watch_failed',
              block_reason: 'watch_failed',
              config_sha256: hashOf(original),
            },
            { outcome: 'applied', block_reason: null, config_sha256: hashOf(replacedText) },
          ])

          // 3. A later in-place edit reloads through the fresh watch.
          await new Promise((resolve) => setTimeout(resolve, 100)) // WATCH_ARM_GRACE_MS
          const editedText = `${replacedText}# edited in place\n`
          writeFileSync(configPath, editedText)
          await waitFor(() => reloadRows().length >= 3, 8_000)
          expect(reloadRows()[2]).toEqual({
            outcome: 'applied',
            block_reason: null,
            config_sha256: hashOf(editedText),
          })
          expect(reloadRows()).toHaveLength(3)
        } finally {
          child.kill('SIGTERM')
          await waitForChildExit(child, 5_000).catch(() => undefined)
          rmSync(dir, { recursive: true, force: true })
        }
      },
      20_000,
    )

    it('refuses to start when HELIO_CONFIG_SHA256 does not match the file, naming both hashes (issue #341)', async () => {
      const { dir, configPath } = writeStartConfig()
      try {
        const fileHash = createHash('sha256').update(readFileSync(configPath)).digest('hex')
        const pinned = 'f'.repeat(64)
        const { code, stderr } = await runCli(['start', '-c', configPath], {
          ...process.env,
          HELIO_CONFIG_SHA256: pinned,
        })
        expect(code).toBe(1)
        expect(stderr).toContain(`HELIO_CONFIG_SHA256 does not match ${configPath}`)
        expect(stderr).toContain(`pinned sha256:${pinned}`)
        expect(stderr).toContain(`file sha256:${fileHash}`)
        expect(stderr).not.toContain('Helio proxy listening')

        const noHotReload = await runCli(['start', '-c', configPath, '--no-hot-reload'], {
          ...process.env,
          HELIO_CONFIG_SHA256: pinned,
        })
        expect(noHotReload.code).toBe(1)
        expect(noHotReload.stderr).toContain('does not match')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 15_000)

    it('refuses to start when HELIO_CONFIG_SHA256 is set but malformed, an empty value included', async () => {
      const { dir, configPath } = writeStartConfig()
      try {
        for (const value of ['', 'not-a-hash', `sha512:${'a'.repeat(64)}`]) {
          const { code, stderr } = await runCli(['start', '-c', configPath], {
            ...process.env,
            HELIO_CONFIG_SHA256: value,
          })
          expect(code, value).toBe(1)
          expect(stderr, value).toContain(
            'HELIO_CONFIG_SHA256 is set but is not a SHA-256 hex digest',
          )
        }
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 15_000)

    it('starts under a matching pin, in either form, and says so', async () => {
      const { dir, configPath } = writeStartConfig()
      try {
        const fileHash = createHash('sha256').update(readFileSync(configPath)).digest('hex')
        const stderr = await startAndCaptureStderr(['-c', configPath], {
          readyMarker: /for policy changes/,
          env: { ...process.env, HELIO_CONFIG_SHA256: `SHA256:${fileHash.toUpperCase()}` },
        })
        expect(stderr).toContain(
          `[helio] Config pinned to sha256:${fileHash.slice(0, 12)}: reloads with a different hash will be refused`,
        )
        expect(stderr).toContain(`Watching ${configPath} for policy changes`)
        // Pinned and writable: the posture line says a restart can still drop the pin.
        expect(stderr).toContain(
          'Reloads are pinned, so a changed file is refused, but a restart by this user can still drop the pin.',
        )
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 15_000)

    it('prints the enforcement posture line when the config is writable by this user (issue #341)', async () => {
      const { dir, configPath } = writeStartConfig()
      try {
        // Hot reload on, no pin: the live-change exposure.
        const live = await startAndCaptureStderr(['-c', configPath], {
          readyMarker: /Enforcement posture/,
        })
        expect(live).toContain(
          `[helio] Enforcement posture: ${configPath} is writable by this user. Any same-user process, including your agent, can change policy live. Run the proxy as its own user, or set HELIO_CONFIG_SHA256, to move up a tier (SECURITY.md, Process and filesystem boundaries).`,
        )

        // Hot reload off, no pin: the next restart loads the file.
        const deferred = await startAndCaptureStderr(['-c', configPath, '--no-hot-reload'], {
          readyMarker: /Enforcement posture/,
        })
        expect(deferred).toContain(
          `[helio] Enforcement posture: ${configPath} is writable by this user. Hot reload is off, so the next restart loads whatever is in the file. Run the proxy as its own user, or set HELIO_CONFIG_SHA256, to move up a tier (SECURITY.md, Process and filesystem boundaries).`,
        )
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 20_000)

    it('refuses a reload under the pin and records exactly one rejected_pinned row carrying the active hash', async () => {
      // Same harness as the single-row test, with the pin in the child's env.
      const { dir, configPath } = writeStartConfig()
      const auditPath = join(dir, 'audit.db')
      const fileHash = createHash('sha256').update(readFileSync(configPath)).digest('hex')
      const child = spawn('node', [CLI_PATH, 'start', '-c', configPath], {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...process.env, HELIO_CONFIG_SHA256: fileHash },
      })
      let stderr = ''
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf-8')
      })
      const waitFor = async (predicate: () => boolean, timeoutMs: number): Promise<void> => {
        const started = Date.now()
        while (Date.now() - started < timeoutMs) {
          if (predicate()) return
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
        throw new Error(`Timed out. stderr:\n${stderr}`)
      }
      type ReloadRow = {
        outcome: string | null
        block_reason: string | null
        config_sha256: string | null
      }
      const reloadRows = (): ReloadRow[] => {
        if (!existsSync(auditPath)) return []
        const db = new Database(auditPath)
        try {
          return db
            .prepare(
              `SELECT json_extract(evidence_chain, '$.policy_reload.outcome') AS outcome, block_reason,
                      config_sha256
               FROM audit_records WHERE record_kind = 'policy_reload' ORDER BY created_at, rowid`,
            )
            .all() as ReloadRow[]
        } finally {
          db.close()
        }
      }
      try {
        await waitFor(() => stderr.includes(`Watching ${configPath} for policy changes`), 8_000)
        expect(stderr).toContain(`[helio] Config pinned to sha256:${fileHash.slice(0, 12)}`)
        await new Promise((resolve) => setTimeout(resolve, 100)) // WATCH_ARM_GRACE_MS
        const original = readFileSync(configPath, 'utf-8')

        // A valid edit that would apply without the pin.
        writeFileSync(configPath, `${original}policies:\n  default: deny\n`)
        await waitFor(
          () =>
            stderr.includes(
              'Config reload failed (keeping current configuration): config hash sha256:',
            ),
          8_000,
        )
        await waitFor(() => reloadRows().length >= 1, 5_000)
        // Exactly one row, refused as pinned, stamped with the ACTIVE hash (the
        // pinned file's), never the refused bytes'.
        expect(reloadRows()).toEqual([
          { outcome: 'rejected_pinned', block_reason: 'rejected_pinned', config_sha256: fileHash },
        ])
        expect(stderr).not.toContain('Policy reloaded')
      } finally {
        child.kill('SIGTERM')
        await waitForChildExit(child, 5_000).catch(() => undefined)
        rmSync(dir, { recursive: true, force: true })
      }
    }, 30_000)

    it('shuts down cleanly on SIGINT with an active dashboard SSE stream', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'helio-cli-shutdown-'))
      const configPath = join(dir, 'helio.yaml')
      const listenPort = randomChildPort()
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
        await waitForProxyHealthOrExit(child, baseUrl, 8_000, () => stderr)

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
      const listenPort = randomChildPort()
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
      const listenPort = randomChildPort()
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
        await waitForProxyHealthOrExit(child, baseUrl, 8_000, () => stderr)

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
      const listenPort = randomChildPort()
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
        await waitForProxyHealthOrExit(child, baseUrl, 8_000, () => stderr)

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
      const listenPort = randomChildPort()
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
      const listenPort = randomChildPort()
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
      const listenPort = randomChildPort()
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
        await waitForProxyHealthOrExit(child, baseUrl, 8_000, () => stderr)

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

        // The url-less singular summary line (issue #313). It prints after the
        // listen banner, so it can race the ready marker — asserted here, after
        // the health wait, where stderr has kept accumulating.
        expect(stderr).toContain('Upstream: node (stdio)')
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

    // --- held ports (issue #375) ---

    /** Hold a 127.0.0.1 port in a raw server the test keeps open. */
    async function holdPort(): Promise<{ port: number; release: () => Promise<void> }> {
      const holder = createServer()
      await new Promise<void>((resolve, reject) => {
        holder.once('error', reject)
        holder.listen(0, '127.0.0.1', () => {
          resolve()
        })
      })
      const port = (holder.address() as AddressInfo).port
      return {
        port,
        release: () =>
          new Promise<void>((resolve) => {
            holder.close(() => {
              resolve()
            })
          }),
      }
    }

    type PortSetting = 'listen.port' | 'sdk.port' | 'dashboard.port'

    /**
     * Write a start config with `heldPort` on the named setting and free
     * ports on the other two. The SDK sideband and the dashboard are
     * enabled only when they carry the held port.
     */
    function writeHeldPortConfig(dir: string, setting: PortSetting, heldPort: number): string {
      const configPath = join(dir, 'helio.yaml')
      const base = randomChildPort()
      const listenPort = setting === 'listen.port' ? heldPort : base
      const sdkPort = setting === 'sdk.port' ? heldPort : base + 1
      const dashboardPort = setting === 'dashboard.port' ? heldPort : base + 2
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
  enabled: ${setting === 'dashboard.port' ? 'true' : 'false'}
  port: ${String(dashboardPort)}
  host: 127.0.0.1
  api_secret: "test-secret-375"
sdk:
  enabled: ${setting === 'sdk.port' ? 'true' : 'false'}
  port: ${String(sdkPort)}
  host: 127.0.0.1
audit:
  path: "${join(dir, 'audit.db')}"
`,
      )
      return configPath
    }

    it.each(['listen.port', 'sdk.port', 'dashboard.port'] as const)(
      'start with %s already in use exits 1 with one line naming the setting and no listening line (issue #375)',
      async (setting) => {
        const held = await holdPort()
        const dir = mkdtempSync(join(tmpdir(), 'helio-cli-held-port-'))
        const configPath = writeHeldPortConfig(dir, setting, held.port)
        try {
          const result = await runCli(['start', '-c', configPath])
          expect(result.code).toBe(1)
          expect(result.stderr).toContain(
            `${setting} ${String(held.port)} is already in use on 127.0.0.1 (EADDRINUSE). ` +
              `Stop the process holding it, or set ${setting} in ${configPath} to a free port.`,
          )
          // A diagnosis, not a crash: no listening line for a server that is
          // not bound, no crash-path wrapper, no stack.
          expect(result.stderr).not.toContain('Helio proxy listening')
          expect(result.stderr).not.toContain('SDK sideband listening')
          expect(result.stderr).not.toContain('Dashboard API listening')
          expect(result.stderr).not.toContain('Uncaught exception')
          expect(result.stderr).not.toContain('Unhandled promise rejection')
          expect(result.stderr).not.toMatch(/\n\s+at /)
        } finally {
          await held.release()
          rmSync(dir, { recursive: true, force: true })
        }
      },
      15_000,
    )

    it('start with a listen.host this machine cannot bind exits 1 with the bind error and the config path (issue #375)', async () => {
      // 192.0.2.1 is TEST-NET-1 (RFC 5737): never a local address, so the
      // bind fails with EADDRNOTAVAIL rather than EADDRINUSE.
      const dir = mkdtempSync(join(tmpdir(), 'helio-cli-bad-host-'))
      const configPath = join(dir, 'helio.yaml')
      const listenPort = randomChildPort()
      writeFileSync(
        configPath,
        `
version: "1"
upstream:
  url: "http://127.0.0.1:1/mcp"
  transport: streamable-http
listen:
  port: ${String(listenPort)}
  host: 192.0.2.1
dashboard:
  enabled: false
audit:
  path: "${join(dir, 'audit.db')}"
`,
      )
      try {
        const result = await runCli(['start', '-c', configPath])
        expect(result.code).toBe(1)
        expect(result.stderr).toContain(
          `listen.port ${String(listenPort)} on 192.0.2.1 cannot be bound: listen EADDRNOTAVAIL`,
        )
        expect(result.stderr).toContain(`Check listen.host and listen.port in ${configPath}.`)
        expect(result.stderr).not.toContain('Helio proxy listening')
        expect(result.stderr).not.toContain('Uncaught exception')
        expect(result.stderr).not.toMatch(/\n\s+at /)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 15_000)

    it('prints the listening line only once the listen server is bound (issue #375)', async () => {
      const { dir, configPath } = writeStartConfig()
      const original = readFileSync(configPath, 'utf-8')
      writeFileSync(configPath, original.replace('enabled: true', 'enabled: false'))
      const listenPort = Number(/port: (\d+)/.exec(original)?.[1])
      const child = spawn('node', [CLI_PATH, 'start', '-c', configPath], {
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      let stderr = ''
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new Error(`Timed out waiting for the listening line. stderr:\n${stderr}`))
          }, 8_000)
          timer.unref()
          child.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString('utf-8')
            if (stderr.includes('Helio proxy listening')) {
              clearTimeout(timer)
              resolve()
            }
          })
          child.once('close', (code) => {
            clearTimeout(timer)
            reject(
              new Error(
                `helio start exited ${String(code)} before the listening line. stderr:\n${stderr}`,
              ),
            )
          })
        })
        // ONE fresh connection the instant the marker lands: no retry and no
        // keep-alive socket. The line must mean the server is bound.
        const status = await new Promise<number>((resolve, reject) => {
          const req = httpRequest(
            { host: '127.0.0.1', port: listenPort, path: '/healthz', agent: false },
            (res) => {
              res.resume()
              resolve(res.statusCode ?? 0)
            },
          )
          req.on('error', reject)
          req.end()
        })
        expect(status).toBe(200)
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGTERM')
        }
        await waitForChildExit(child, 8_000)
        rmSync(dir, { recursive: true, force: true })
      }
    }, 15_000)

    it('start with listen.port already in use closes the stdio upstream child it had spawned (issue #375)', async () => {
      const held = await holdPort()
      const dir = mkdtempSync(join(tmpdir(), 'helio-cli-held-stdio-'))
      const configPath = join(dir, 'helio.yaml')
      const pidPath = join(dir, 'child.pid')
      // A child that ignores stdin EOF silently: error handlers on every
      // stream, stdin resumed, an interval keeping it alive. Its first
      // statement records its pid for the test.
      const childSource =
        `require('fs').writeFileSync('${pidPath}', String(process.pid)); ` +
        `for (const s of [process.stdin, process.stdout, process.stderr]) s.on('error', () => {}); ` +
        `process.stdin.resume(); setInterval(() => {}, 1000)`
      writeFileSync(
        configPath,
        `
version: "1"
upstream:
  transport: stdio
  command: "node"
  args:
    - "-e"
    - "${childSource}"
listen:
  port: ${String(held.port)}
  host: 127.0.0.1
dashboard:
  enabled: false
audit:
  path: "${join(dir, 'audit.db')}"
`,
      )
      let childPid: number | undefined
      try {
        const result = await runCli(['start', '-c', configPath])
        expect(result.code).toBe(1)
        const pid = Number(readFileSync(pidPath, 'utf-8'))
        expect(Number.isInteger(pid)).toBe(true)
        childPid = pid
        // The abort closes the forwarder, which signals the child. A child
        // that outlives the CLI's exit is the leak this pins.
        await vi.waitFor(
          () => {
            expect(() => process.kill(pid, 0)).toThrow(/ESRCH/)
          },
          { timeout: 4_000, interval: 20 },
        )
        expect(result.stderr).toContain(
          `listen.port ${String(held.port)} is already in use on 127.0.0.1 (EADDRINUSE).`,
        )
      } finally {
        if (childPid !== undefined) {
          try {
            process.kill(childPid, 'SIGKILL')
          } catch {
            // Already gone.
          }
        }
        await held.release()
        rmSync(dir, { recursive: true, force: true })
      }
    }, 15_000)
  })

  // --- helio export ---

  describe('export', () => {
    type InsertRecord = AuditRecordInput

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

    it('refuses an audit.path whose directory does not exist on one line (issue #388)', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'helio-cli-audit-export-'))
      const missingDir = join(dir, 'no-such-dir')
      try {
        const configPath = writeAuditPathConfig(dir, join(missingDir, 'audit.db'))
        const result = await runCli(['export', '-c', configPath])
        expect(result.code).toBe(1)
        expect(result.stderr).toContain(
          `Invalid config: audit.path: directory ${missingDir} does not exist`,
        )
        expect(result.stderr).not.toContain('Unhandled promise rejection')
        expect(result.stdout).toBe('')
        expect(existsSync(missingDir)).toBe(false)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 15_000)

    it.skipIf(!CAN_TEST_UNWRITABLE)(
      'exports from an existing audit database with its sidecars in a directory this user cannot write (issue #388)',
      async () => {
        const dir = mkdtempSync(join(tmpdir(), 'helio-cli-audit-sidecars-'))
        const dbDir = join(dir, 'db')
        mkdirSync(dbDir)
        try {
          const dbPath = seedReadOnlyDirWithSidecars(dbDir)
          const configPath = writeAuditPathConfig(dir, dbPath)
          const result = await runCli(['export', '-c', configPath])
          expect(result.code).toBe(0)
          expect(result.stderr).toContain('Exported 0 of 0 records')
          expect(result.stdout.trim()).toBe('[]')
        } finally {
          chmodSync(dbDir, 0o700)
          rmSync(dir, { recursive: true, force: true })
        }
      },
      15_000,
    )

    it('prints the audit store schema mismatch on one line without the rejection wrapper (issue #388)', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'helio-cli-audit-stale-'))
      const staleDb = join(dir, 'stale.db')
      try {
        const stale = new Database(staleDb)
        stale.exec('CREATE TABLE audit_records (id TEXT PRIMARY KEY, timestamp TEXT NOT NULL)')
        stale.close()
        const configPath = writeAuditPathConfig(dir, staleDb)
        const result = await runCli(['export', '-c', configPath])
        expect(result.code).toBe(1)
        // The store's own StartupError, printed verbatim through the same
        // door as start: no rejection wrapper, no stack.
        expect(result.stderr).toContain(
          '[helio] Audit DB schema mismatch: missing required columns',
        )
        expect(result.stderr).toContain(`Delete "${staleDb}"`)
        expect(result.stderr).not.toContain('Unhandled promise rejection')
        expect(result.stderr).not.toMatch(/\n\s+at /)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 15_000)

    it('refuses an empty audit.path as a schema error (issue #406)', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'helio-cli-audit-empty-export-'))
      try {
        const configPath = writeAuditPathConfig(dir, '')
        const result = await runCli(['export', '-c', configPath], undefined, dir)
        expect(result.code).toBe(1)
        expect(result.stderr).toContain('Error: Invalid configuration (1 error)')
        expect(result.stderr).toContain(
          '  audit.path: Too small: expected string to have >=1 characters',
        )
        // The schema fires first; the directory check never sees the blank.
        expect(result.stderr).not.toContain('is a directory, not a file')
        expect(result.stdout).toBe('')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 15_000)

    it('refuses a whitespace-only audit.path instead of exporting from a temporary database (issue #406)', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'helio-cli-audit-spaces-export-'))
      try {
        const configPath = writeAuditPathConfig(dir, '   ')
        const result = await runCli(['export', '-c', configPath], undefined, dir)
        expect(result.code).toBe(1)
        expect(result.stderr).toContain('Error: Invalid configuration (1 error)')
        expect(result.stderr).toContain(
          '  audit.path: Too small: expected string to have >=1 characters',
        )
        expect(result.stdout).toBe('')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 15_000)

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

// ---------------------------------------------------------------------------
// helio policy status, the startup surface lines and the readiness nudge
// (issue #396), through the built dist/cli.js
// ---------------------------------------------------------------------------

describe('helio policy status and the startup surface lines (issue #396)', () => {
  const ANNOTATED_TOOLS = [
    { name: 'send_email', annotations: { readOnlyHint: false, destructiveHint: false } },
    { name: 'delete_record', annotations: { readOnlyHint: false, destructiveHint: true } },
  ]
  const BARE_TOOLS = [{ name: 'read_file' }, { name: 'exec' }]

  /** A mock upstream whose tools/list lists `tools`. */
  function startToolsUpstream(tools: unknown[]): Promise<MockMcpServer> {
    return startMockMcpServer((payload) => {
      const id = payload['id'] ?? null
      if (payload['method'] === 'tools/list') return { jsonrpc: '2.0', id, result: { tools } }
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'ok' }] } }
    })
  }

  /**
   * A raw upstream for the failure shapes the canned-200 mock cannot
   * express: tools/list answers `status` after `delayMs`, everything else 200.
   */
  async function startRawUpstream(options: {
    status: number
    delayMs?: number
  }): Promise<{ url: string; close: () => Promise<void> }> {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => {
        chunks.push(chunk)
      })
      req.on('end', () => {
        let payload: Record<string, unknown> = {}
        try {
          payload = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Record<string, unknown>
        } catch {
          payload = {}
        }
        const id = payload['id'] ?? null
        const respond = () => {
          if (payload['method'] === 'tools/list') {
            res.writeHead(options.status, { 'content-type': 'application/json' })
            res.end(
              options.status >= 400
                ? JSON.stringify({ error: 'boom' })
                : JSON.stringify({ jsonrpc: '2.0', id, result: { tools: ANNOTATED_TOOLS } }),
            )
            return
          }
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ jsonrpc: '2.0', id, result: {} }))
        }
        if (payload['method'] === 'tools/list' && options.delayMs)
          setTimeout(respond, options.delayMs)
        else respond()
      })
    })
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve)
    })
    const port = (server.address() as AddressInfo).port
    return {
      url: `http://127.0.0.1:${String(port)}/mcp`,
      close: () =>
        new Promise<void>((resolve, reject) => {
          server.close((err) => {
            if (err) reject(err)
            else resolve()
          })
        }),
    }
  }

  /** Write a config against `upstreamUrl`; the dashboard is off unless a secret is given. */
  function writeConfig(options: {
    upstreamUrl: string
    rules?: string
    dashboardSecret?: string
    dashboardEnabled?: boolean
  }): {
    dir: string
    configPath: string
    auditPath: string
    listenPort: number
    dashboardPort: number
  } {
    const dir = mkdtempSync(join(tmpdir(), 'helio-cli-policy-status-'))
    const configPath = join(dir, 'helio.yaml')
    const auditPath = join(dir, 'audit.db')
    const listenPort = randomChildPort()
    const dashboardPort = listenPort + 1
    const dashboard =
      options.dashboardSecret !== undefined
        ? `dashboard:
  enabled: ${String(options.dashboardEnabled ?? true)}
  port: ${String(dashboardPort)}
  host: 127.0.0.1
  api_secret: "${options.dashboardSecret}"
`
        : `dashboard:
  enabled: false
`
    writeFileSync(
      configPath,
      `
version: "1"
upstream:
  url: "${options.upstreamUrl}"
  transport: streamable-http
listen:
  port: ${String(listenPort)}
  host: 127.0.0.1
policies:
  default: allow
  rules:${options.rules ?? ' []'}
${dashboard}audit:
  path: "${auditPath}"
`,
    )
    return { dir, configPath, auditPath, listenPort, dashboardPort }
  }

  const DENY_DESTRUCTIVE_RULE = `
    - name: block-destructive
      match:
        annotations:
          destructiveHint: true
      action: deny`

  /** Seed `calls` tool_call rows round-robin over `pairs` tool names at insert time. */
  function seedCalls(auditPath: string, calls: number, pairs: number): void {
    const store = new AuditStore({
      path: auditPath,
      retention: '90d',
      includeResponses: true,
      cleanupIntervalMs: 0,
    })
    const records: AuditRecordInput[] = []
    for (let i = 0; i < calls; i++) {
      records.push({
        timestamp: new Date().toISOString(),
        session_id: `s-${String(i % 5)}`,
        session_source: null,
        protocol_version: null,
        upstream: null,
        agent_id: null,
        environment: null,
        tool_name: `tool_${String(i % pairs)}`,
        tool_input: {},
        policy_decision: 'allow',
        block_reason: null,
        matched_rule: null,
        matched_rule_index: null,
        evidence_chain: null,
        approval_status: null,
        approved_by: null,
        upstream_response: null,
        upstream_error: null,
        upstream_http_status: 200,
        upstream_latency_ms: 1,
        total_duration_ms: 1,
        approval_wait_ms: 0,
        proxy_compute_ms: 1,
        flagged_destructive: false,
        dry_run: false,
        record_kind: 'tool_call',
        origin: 'mcp',
        metadata: null,
      })
    }
    const inserted = store.insertBatch(records)
    store.close()
    if (inserted !== calls) throw new Error(`seeded ${String(inserted)} of ${String(calls)}`)
  }

  const NUDGE_TAIL = 'helio policy status lists which tools are called and which have no rule.'

  /** Boot against a primed annotated upstream and return stderr through the Upstream: line. */
  async function bootStderr(args: {
    rules?: string
    seed?: { calls: number; pairs: number }
    tools?: unknown[]
  }): Promise<string> {
    const upstream = await startToolsUpstream(args.tools ?? ANNOTATED_TOOLS)
    const { dir, configPath, auditPath } = writeConfig({
      upstreamUrl: upstream.url,
      rules: args.rules,
    })
    try {
      if (args.seed) seedCalls(auditPath, args.seed.calls, args.seed.pairs)
      return await startAndCaptureStderr(['-c', configPath], {
        readyMarker: /^Upstream: /m,
        timeoutMs: 10_000,
      })
    } finally {
      await upstream.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('(a) helio policy without a subcommand prints the group help and exits 1', async () => {
    const { code, stdout, stderr } = await runCli(['policy'])
    expect(code).toBe(1)
    expect(`${stdout}${stderr}`).toContain('status')
    expect(`${stdout}${stderr}`).toContain('Usage: helio policy')
  })

  it('(b) prints the surface and coverage lines between the listening and Upstream lines with zero rules', async () => {
    const stderr = await bootStderr({})
    const listening = stderr.indexOf('Helio proxy listening')
    const surface = stderr.indexOf(
      'Authority surface: 2 tool-door pairs across 1 upstream, 1 annotated destructive\n',
    )
    const coverage = stderr.indexOf(
      'Policy coverage: 0 of 2 have a rule that can match them, default allow\n',
    )
    const upstreamLine = stderr.search(/^Upstream: /m)
    expect(surface).toBeGreaterThan(listening)
    expect(coverage).toBeGreaterThan(surface)
    expect(upstreamLine).toBeGreaterThan(coverage)
    expect(stderr).not.toContain('[helio] Authority surface')
    expect(stderr).not.toContain('Persisted:')
  }, 15_000)

  it('(c) counts the pairs a loaded rule can match', async () => {
    const stderr = await bootStderr({ rules: DENY_DESTRUCTIVE_RULE })
    expect(stderr).toContain(
      'Policy coverage: 1 of 2 have a rule that can match them, default allow',
    )
  }, 15_000)

  it('(d) prints the not-primed form and no coverage line when tools/list fails', async () => {
    const upstream = await startRawUpstream({ status: 500 })
    const { dir, configPath } = writeConfig({ upstreamUrl: upstream.url })
    try {
      const stderr = await startAndCaptureStderr(['-c', configPath], {
        readyMarker: /^Upstream: /m,
        timeoutMs: 10_000,
      })
      expect(stderr).toContain(
        `Authority surface: not primed on ${upstream.url} (upstream returned HTTP 500 to tools/list (session/initialize may be required)). helio policy status reports coverage once priming succeeds.`,
      )
      expect(stderr).not.toContain('Policy coverage:')
    } finally {
      await upstream.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 15_000)

  it('(e) prints none annotated for a zero-annotation upstream', async () => {
    const stderr = await bootStderr({ tools: BARE_TOOLS })
    expect(stderr).toContain(
      'Authority surface: 2 tool-door pairs across 1 upstream, none annotated',
    )
    expect(stderr).toContain(
      'Policy coverage: 0 of 2 have a rule that can match them, default allow',
    )
  }, 15_000)

  describe('(f) helio policy status against the running proxy', () => {
    it('prints the report as text and as json, echoing the window', async () => {
      const upstream = await startToolsUpstream(ANNOTATED_TOOLS)
      const secret = `status-secret-${String(randomChildPort())}`
      const { dir, configPath, dashboardPort } = writeConfig({
        upstreamUrl: upstream.url,
        dashboardSecret: secret,
        rules: DENY_DESTRUCTIVE_RULE,
      })
      const child = spawn('node', [CLI_PATH, 'start', '-c', configPath], {
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      let stderr = ''
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf-8')
      })
      const waitFor = async (predicate: () => boolean): Promise<void> => {
        const started = Date.now()
        while (Date.now() - started < 10_000) {
          if (predicate()) return
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
        throw new Error(`Timed out. stderr:\n${stderr}`)
      }
      try {
        await waitFor(() => stderr.includes('Dashboard API listening'))

        // The secret from the environment.
        const text = await runCli(['policy', 'status', '-c', configPath], {
          ...process.env,
          HELIO_DASHBOARD_SECRET: secret,
        })
        expect(text.stderr).toBe('')
        expect(text.code).toBe(0)
        expect(text.stdout).toContain('Authority surface')
        expect(text.stdout).toContain('2 tool-door pairs across 1 upstream')
        expect(text.stdout).toContain('1 annotated destructive')
        expect(text.stdout).toContain('1 of 2 have a rule that can match them')
        expect(text.stdout).toContain('Persisted (last 4h)')
        expect(text.stdout).toMatch(/delete_record\s+upstream\s+deny\s+rule "block-destructive"/)

        // The plaintext secret from the config file, no environment.
        const env = { ...process.env }
        delete env['HELIO_DASHBOARD_SECRET']
        const fromConfig = await runCli(['policy', 'status', '-c', configPath], env)
        expect(fromConfig.code).toBe(0)
        expect(fromConfig.stdout).toContain('Authority surface')

        const json = await runCli(
          ['policy', 'status', '-c', configPath, '--format', 'json', '--window', '7d'],
          { ...process.env, HELIO_DASHBOARD_SECRET: secret },
        )
        expect(json.code).toBe(0)
        const body = JSON.parse(json.stdout) as {
          schema_version: number
          window: string
          surface: { pairs: number }
          coverage: { matched: number }
          persisted: { window: string; calls_in_window: number }
          readiness: { suppressed: boolean }
        }
        expect(body.schema_version).toBe(1)
        expect(body.window).toBe('7d')
        expect(body.persisted.window).toBe('7d')
        expect(body.surface.pairs).toBe(2)
        expect(body.coverage.matched).toBe(1)
        expect(body.readiness.suppressed).toBe(true)

        const text7 = await runCli(['policy', 'status', '-c', configPath, '--window', '7d'], {
          ...process.env,
          HELIO_DASHBOARD_SECRET: secret,
        })
        expect(text7.stdout).toContain('Persisted (last 7d)')

        // A wrong secret is a 401 with one line naming the source tried.
        const wrong = await runCli(['policy', 'status', '-c', configPath], {
          ...process.env,
          HELIO_DASHBOARD_SECRET: 'not-the-secret',
        })
        expect(wrong.code).toBe(1)
        expect(wrong.stdout).toBe('')
        expect(wrong.stderr).toContain(
          `Error: the Helio dashboard API at http://127.0.0.1:${String(dashboardPort)} refused the secret from HELIO_DASHBOARD_SECRET`,
        )
      } finally {
        child.kill('SIGTERM')
        await waitForChildExit(child, 5_000).catch(() => undefined)
        await upstream.close()
        rmSync(dir, { recursive: true, force: true })
      }
    }, 30_000)

    it('refuses a bad --window or --format before any request', async () => {
      const { dir, configPath } = writeConfig({
        upstreamUrl: 'http://127.0.0.1:1/mcp',
        dashboardSecret: 'plain',
      })
      try {
        const window = await runCli(['policy', 'status', '-c', configPath, '--window', '31d'])
        expect(window.code).toBe(1)
        expect(window.stderr).toContain(
          'Error: --window must be a duration between 1m and 30d (for example 4h, 240m or 7d)',
        )
        const format = await runCli(['policy', 'status', '-c', configPath, '--format', 'xml'])
        expect(format.code).toBe(1)
        expect(format.stderr).toContain('Error: --format must be text or json')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 15_000)

    it('(g) exits 1 with one line when the dashboard API is not reachable', async () => {
      const { dir, configPath, dashboardPort } = writeConfig({
        upstreamUrl: 'http://127.0.0.1:1/mcp',
        dashboardSecret: 'plain',
      })
      try {
        const { code, stdout, stderr } = await runCli(['policy', 'status', '-c', configPath])
        expect(code).toBe(1)
        expect(stdout).toBe('')
        expect(stderr.trim()).toBe(
          `Error: cannot reach the Helio dashboard API at http://127.0.0.1:${String(dashboardPort)} (is helio start running with dashboard.enabled: true?)`,
        )
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 15_000)

    it('exits 1 with one line when the dashboard is disabled in the config', async () => {
      const { dir, configPath } = writeConfig({ upstreamUrl: 'http://127.0.0.1:1/mcp' })
      try {
        const { code, stderr } = await runCli(['policy', 'status', '-c', configPath])
        expect(code).toBe(1)
        expect(stderr).toContain(
          `Error: helio policy status reads the running proxy through the dashboard API, and dashboard.enabled is false in ${configPath}`,
        )
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 15_000)

    it('(i) refuses a resolved secret that is a digest before any request, whatever its source', async () => {
      const digest = secretDigest('the-real-secret')
      const { dir, configPath, dashboardPort } = writeConfig({
        upstreamUrl: 'http://127.0.0.1:1/mcp',
        dashboardSecret: digest,
      })
      let requests = 0
      const sink = createServer((_req, res) => {
        requests += 1
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{}')
      })
      await new Promise<void>((resolve) => {
        sink.listen(dashboardPort, '127.0.0.1', resolve)
      })
      try {
        const fromEnv = await runCli(['policy', 'status', '-c', configPath], {
          ...process.env,
          HELIO_DASHBOARD_SECRET: digest,
        })
        expect(fromEnv.code).toBe(1)
        expect(fromEnv.stderr.trim()).toBe(
          'Error: the dashboard secret from HELIO_DASHBOARD_SECRET is a sha256: digest; present the secret itself (the value helio init printed) in HELIO_DASHBOARD_SECRET and rerun',
        )

        const env = { ...process.env }
        delete env['HELIO_DASHBOARD_SECRET']
        const fromConfig = await runCli(['policy', 'status', '-c', configPath], env)
        expect(fromConfig.code).toBe(1)
        expect(fromConfig.stderr.trim()).toBe(
          `Error: the dashboard secret from dashboard.api_secret in ${configPath} is a sha256: digest; present the secret itself (the value helio init printed) in HELIO_DASHBOARD_SECRET and rerun`,
        )
        expect(requests).toBe(0)
      } finally {
        await new Promise<void>((resolve) => {
          sink.close(() => {
            resolve()
          })
        })
        rmSync(dir, { recursive: true, force: true })
      }
    }, 15_000)
  })

  describe('(h) the readiness nudge', () => {
    it('prints once when 100 calls across 7 pairs are persisted in the window and nothing is enforced', async () => {
      const stderr = await bootStderr({ seed: { calls: 100, pairs: 7 } })
      const line = 'Persisted: 100 calls across 7 tool-door pairs in the last 4h (audit rows since '
      expect(stderr).toContain(line)
      expect(stderr.split(line)).toHaveLength(2)
      expect(stderr).toContain(NUDGE_TAIL)
      expect(stderr).not.toContain('generate')
      expect(stderr.indexOf(line)).toBeGreaterThan(stderr.indexOf('Policy coverage:'))
    }, 15_000)

    it('is absent at 99 calls across 7 pairs', async () => {
      const stderr = await bootStderr({ seed: { calls: 99, pairs: 7 } })
      expect(stderr).not.toContain('Persisted:')
    }, 15_000)

    it('is absent at 100 calls across 2 pairs', async () => {
      const stderr = await bootStderr({ seed: { calls: 100, pairs: 2 } })
      expect(stderr).not.toContain('Persisted:')
    }, 15_000)

    it('is absent once a rule is loaded', async () => {
      const stderr = await bootStderr({
        seed: { calls: 100, pairs: 7 },
        rules: DENY_DESTRUCTIVE_RULE,
      })
      expect(stderr).not.toContain('Persisted:')
      expect(stderr).toContain('Policy coverage: 1 of 2')
    }, 15_000)
  })

  it('(j) reprints the coverage line after a hot reload that adds a rule', async () => {
    const upstream = await startToolsUpstream(ANNOTATED_TOOLS)
    const { dir, configPath } = writeConfig({ upstreamUrl: upstream.url })
    const child = spawn('node', [CLI_PATH, 'start', '-c', configPath], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8')
    })
    const waitFor = async (predicate: () => boolean): Promise<void> => {
      const started = Date.now()
      while (Date.now() - started < 10_000) {
        if (predicate()) return
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      throw new Error(`Timed out. stderr:\n${stderr}`)
    }
    try {
      await waitFor(() => stderr.includes(`Watching ${configPath} for policy changes`))
      expect(stderr).toContain(
        'Policy coverage: 0 of 2 have a rule that can match them, default allow',
      )
      await new Promise((resolve) => setTimeout(resolve, 100))
      const original = readFileSync(configPath, 'utf-8')
      writeFileSync(configPath, original.replace('  rules: []', `  rules:${DENY_DESTRUCTIVE_RULE}`))
      await waitFor(() => stderr.includes('[helio] Policy coverage:'))
      const reloaded = stderr.indexOf('[helio] Policy reloaded: 1 rule (default: allow)')
      const coverage = stderr.indexOf(
        '[helio] Policy coverage: 1 of 2 have a rule that can match them, default allow',
      )
      expect(reloaded).toBeGreaterThan(-1)
      expect(coverage).toBeGreaterThan(reloaded)
      // The surface did not change on a reload: its line is not reprinted.
      expect(stderr.split('Authority surface:')).toHaveLength(2)
    } finally {
      child.kill('SIGTERM')
      await waitForChildExit(child, 5_000).catch(() => undefined)
      await upstream.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)

  it('(k) a slow tools/list yields a surface line that agrees with whether the primed line preceded it', async () => {
    const upstream = await startRawUpstream({ status: 200, delayMs: 2_000 })
    const { dir, configPath } = writeConfig({ upstreamUrl: upstream.url })
    try {
      const stderr = await startAndCaptureStderr(['-c', configPath], {
        readyMarker: /^Upstream: /m,
        timeoutMs: 10_000,
      })
      const primedAt = stderr.indexOf('Annotation cache primed:')
      const surfaceAt = stderr.indexOf('Authority surface:')
      expect(surfaceAt).toBeGreaterThan(-1)
      if (primedAt !== -1 && primedAt < surfaceAt) {
        expect(stderr).toContain(
          'Authority surface: 2 tool-door pairs across 1 upstream, 1 annotated destructive',
        )
      } else {
        expect(stderr).toContain('Annotation cache priming did not complete within 1500ms')
        expect(stderr).toContain(
          `Authority surface: not primed on ${upstream.url} (priming did not complete within 1500ms). helio policy status reports coverage once priming succeeds.`,
        )
        expect(stderr).not.toContain('Policy coverage:')
      }
    } finally {
      await upstream.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 15_000)
})
