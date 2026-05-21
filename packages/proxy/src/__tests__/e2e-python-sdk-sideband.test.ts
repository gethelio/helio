import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startHttpMcpServer } from './helpers/mcp-test-server.js'
import { startOnDynamicPort, makeConfig, sendMcpRequest } from './helpers/test-utils.js'
import type { ManagedServer } from './helpers/test-utils.js'
import { createApp } from '../server.js'
import { UpstreamForwarder } from '../upstream/forwarder.js'
import { compilePolicies } from '../policy/parser.js'
import { GovernedForwarder } from '../policy/governed-forwarder.js'
import { EvidenceStore, createSidebandApp } from '../evidence/index.js'

const execFileAsync = promisify(execFile)

const __testsDir = dirname(fileURLToPath(import.meta.url))
// Monorepo root: packages/proxy/src/__tests__ -> four levels up
const REPO_ROOT = join(__testsDir, '..', '..', '..', '..')
const SDK_SRC = join(REPO_ROOT, 'packages', 'python-sdk', 'src')

const SESSION_ID = 'e2e-python-session'

async function preflightPythonHelio(
  sdkSrc: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const helioInit = join(sdkSrc, 'helio', '__init__.py')
  if (!existsSync(helioInit)) {
    return {
      ok: false,
      reason: `Python SDK sources not found (expected ${helioInit}). Use a full monorepo checkout.`,
    }
  }
  try {
    await execFileAsync('python3', ['-c', 'import helio'], {
      env: { ...process.env, PYTHONPATH: sdkSrc },
      timeout: 10_000,
    })
    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      reason: `python3 could not import helio with PYTHONPATH=${sdkSrc}. Install Python 3 and, if needed, run: pip install -e ./packages/python-sdk. ${message}`,
    }
  }
}

const pyPreflight = await preflightPythonHelio(SDK_SRC)
if (!pyPreflight.ok) {
  // eslint-disable-next-line no-console
  console.warn(`[@gethelio/proxy] Skipping E2E Python SDK sideband tests: ${pyPreflight.reason}`)
}
const e2eDescribe = pyPreflight.ok ? describe : describe.skip

// Per-run bearer token used to exercise the sideband auth middleware over
// real HTTP. Generated fresh so a stale value from a prior run cannot
// accidentally satisfy auth.
const SDK_TOKEN = randomBytes(32).toString('hex')

e2eDescribe('E2E: Python SDK → sideband → proxy → evidence grounding', () => {
  let upstream: { port: number; close: () => Promise<void> }
  let proxyManaged: ManagedServer
  let proxyUrl: string
  let sidebandManaged: ManagedServer
  let sidebandUrl: string
  let evidenceStore: EvidenceStore

  beforeAll(async () => {
    // 1. Start mock upstream MCP server
    upstream = await startHttpMcpServer()

    // 2. Create evidence store (no background cleanup in tests)
    evidenceStore = new EvidenceStore({ cleanupIntervalMs: 0 })

    // 3. Build proxy with evidence-requiring policy
    const config = makeConfig({
      upstream: { url: `http://127.0.0.1:${String(upstream.port)}/mcp` },
      policies: {
        default: 'deny',
        rules: [
          {
            name: 'weather-needs-evidence',
            match: { tool: 'get_weather' },
            action: 'allow',
            evidence: { requires: ['orders.lookup'] },
          },
        ],
      },
    })

    const forwarder = new UpstreamForwarder({ url: config.upstream.url })
    const { policy } = compilePolicies(config.policies)
    const governed = new GovernedForwarder(forwarder, policy, { evidenceStore })
    const app = createApp(config, governed)
    proxyManaged = startOnDynamicPort(app)
    proxyUrl = `http://127.0.0.1:${String(proxyManaged.port)}/mcp`

    // Prime annotation cache
    await sendMcpRequest(proxyUrl, 'tools/list')

    // 4. Start sideband server (shared evidence store) with the per-run
    // bearer token enforced, so the full middleware stack is exercised
    // end-to-end over real HTTP — not just via Hono's in-memory
    // `app.request()` simulator used by `evidence/api.test.ts`.
    const sidebandApp = createSidebandApp(evidenceStore, { token: SDK_TOKEN })
    sidebandManaged = startOnDynamicPort(sidebandApp)
    sidebandUrl = `http://127.0.0.1:${String(sidebandManaged.port)}`
  })

  afterAll(async () => {
    await proxyManaged.close()
    await sidebandManaged.close()
    await upstream.close()
    evidenceStore.close()
  })

  it('blocks tool call when evidence is missing (self-repair feedback)', async () => {
    const { body } = await sendMcpRequest(
      proxyUrl,
      'tools/call',
      { name: 'get_weather', arguments: { city: 'London' } },
      1,
      { sessionId: SESSION_ID },
    )

    const error = body['error'] as { code: number; message: string; data: Record<string, unknown> }
    expect(error.code).toBe(-32001)
    expect(error.data['reason']).toBe('evidence_missing')
    expect(error.data['missing_evidence']).toEqual(['orders.lookup'])
    expect(error.data['retry_allowed']).toBe(true)
    expect(typeof error.data['suggestion']).toBe('string')
    expect(error.data['suggestion']).toContain('orders.lookup')
  })

  it('Python SDK submits evidence via sideband, then tool call succeeds', async () => {
    const scriptPath = join(__testsDir, 'helpers', 'e2e_sdk_script.py')

    // Spawn Python subprocess to mark evidence — the SDK picks up the
    // bearer token from `HELIO_SDK_TOKEN` at construction time and bakes
    // it into every sideband request as `Authorization: Bearer <token>`.
    const { stdout } = await execFileAsync('python3', [scriptPath, sidebandUrl, SESSION_ID], {
      env: { ...process.env, PYTHONPATH: SDK_SRC, HELIO_SDK_TOKEN: SDK_TOKEN },
      timeout: 10_000,
    })

    // Verify SDK script output
    const sdkResult = JSON.parse(stdout.trim()) as Record<string, unknown>
    expect(sdkResult['session_id']).toBe(SESSION_ID)
    expect(sdkResult['satisfied']).toEqual(['orders.lookup'])
    expect(sdkResult['missing']).toEqual([])
    expect(sdkResult['evidence_keys']).toEqual(['orders.lookup'])

    // Now call the tool WITH evidence present — should succeed
    const { body } = await sendMcpRequest(
      proxyUrl,
      'tools/call',
      { name: 'get_weather', arguments: { city: 'London' } },
      2,
      { sessionId: SESSION_ID },
    )

    // Should be a success response (no error field)
    expect(body['error']).toBeUndefined()
    const result = body['result'] as { content: Array<{ type: string; text: string }> }
    expect(result.content[0]?.text).toBe('Sunny, 22°C in London')
  })

  it('rejects SDK requests that omit the sideband bearer token (401)', async () => {
    // Defense-in-depth: boot a real Python SDK process against the real
    // sideband over real HTTP with no `HELIO_SDK_TOKEN` in env, and assert
    // the middleware denies it. This catches regressions the unit-level
    // suites cannot — header-case bugs, Hono middleware ordering, or env
    // var propagation breaks — none of which surface in `app.request()`.
    const scriptPath = join(__testsDir, 'helpers', 'e2e_sdk_script.py')

    // Build a clean env with `HELIO_SDK_TOKEN` explicitly removed so a
    // host shell that happens to export the variable cannot silently
    // satisfy auth and mask a regression.
    const cleanEnv: NodeJS.ProcessEnv = { ...process.env, PYTHONPATH: SDK_SRC }
    delete cleanEnv.HELIO_SDK_TOKEN

    let caught: (Error & { code?: number; stderr?: string }) | null = null
    try {
      await execFileAsync('python3', [scriptPath, sidebandUrl, 'e2e-python-unauth-session'], {
        env: cleanEnv,
        timeout: 10_000,
      })
    } catch (e) {
      caught = e as Error & { code?: number; stderr?: string }
    }

    expect(caught).not.toBeNull()
    expect(caught?.code).toBe(1)

    // The helper script emits one JSON line to stderr on HelioError. Scan
    // backwards for the first `{...}` line so an unrelated Python crash
    // (e.g. a broken PYTHONPATH yielding a ModuleNotFoundError traceback)
    // surfaces as a clear assertion failure instead of a confusing
    // SyntaxError from `JSON.parse`.
    const stderr = caught?.stderr ?? ''
    const jsonLine = stderr
      .split('\n')
      .map((line) => line.trim())
      .reverse()
      .find((line) => line.startsWith('{') && line.endsWith('}'))
    expect(
      jsonLine,
      `expected a JSON error line in subprocess stderr, got:\n${stderr}`,
    ).toBeDefined()
    const errorPayload = JSON.parse(jsonLine ?? '') as { error: string; status_code: number }
    expect(errorPayload.status_code).toBe(401)
  })
})
