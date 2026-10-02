#!/usr/bin/env node
/**
 * check-no-telemetry.mjs: the static half of the no-telemetry claim in
 * SECURITY.md (#401). It reads shipped source and fails, naming the file,
 * the line and the offending text, on anything that could carry a request
 * to a host Helio's operator did not configure.
 *
 * Four rules:
 *
 *  (a) Literals. Every `http://` or `https://` literal in the corpus must
 *      name a loopback or example host (`127.0.0.1`, `localhost`, the
 *      compose service names `mcp-server`, `helio-edge`, `helio`, and
 *      `host.docker.internal`) or be allowlisted by path AND literal in
 *      scripts/no-telemetry-allowlist.txt, which holds the printed
 *      documentation links and the example hostnames in doc comments. A
 *      row that matches nothing in its file is itself a failure. The URL
 *      text runs from the scheme to the first whitespace, quote,
 *      backtick, `)`, `>` or backslash (a source `\n` ends it); one
 *      trailing `.` is sentence punctuation and comes off; a bare scheme
 *      (`'http://' + host`) is the concatenation case and is skipped. A
 *      template literal passes only when its authority is `${...}` from
 *      the start, or a loopback host and a colon followed by `${...}`;
 *      any other `${` in the authority fails. Everything else goes
 *      through `new URL()`, and the parsed hostname is compared exactly,
 *      so userinfo, a loopback name used as a subdomain and an IPv6
 *      literal all fail.
 *  (b) Imports. No shipped proxy module names a network-shaped module
 *      (`http`, `https`, `http2`, `net`, `tls`, `dgram`, `dns`,
 *      `child_process`, `undici`, `worker_threads`, with or without the
 *      `node:` prefix, with or without a subpath such as `dns/promises`,
 *      in single quotes, double quotes or backticks) in a static import, a
 *      bare import, a dynamic `import()` or a `require()`, except the three
 *      listed below, each with its reason. The scan is line by line, so a
 *      dynamic `import(` whose specifier sits on the next line is not seen;
 *      Prettier keeps a short specifier on the call's line.
 *  (c) Call sites. Every `fetch(` and every `new WebClient(` in shipped
 *      proxy source is in a listed file, so a new outbound call anywhere
 *      else fails until a reviewer reads the added row. The list is by
 *      file: a new URL in a listed file is caught by rule (a), not here.
 *  (d) Bundling. packages/proxy/tsup.config.ts sets neither `noExternal`
 *      nor `skipNodeModulesBundle: false`. tsup's default is
 *      `skipNodeModulesBundle: true`: every dependency stays out of
 *      dist/cli.js and is loaded from node_modules at runtime. That default
 *      is what lets this script cover dist/cli.js through its source; were
 *      a dependency bundled, its URLs would sit in dist/cli.js where
 *      neither this check nor the bundle check in
 *      packages/proxy/scripts/check-dashboard-assets.ts reads.
 *
 * Corpus: the `.ts`, `.tsx`, `.js`, `.mjs` and `.py` files under
 * packages/proxy/src, packages/dashboard/src and packages/python-sdk/src,
 * tests excluded (`*.test.ts`, `*.test.tsx`, `__tests__/`, `tests/`). The
 * walk is by extension on purpose: a bare directory walk would also read
 * the gitignored `__pycache__/*.pyc` bytecode. The built dashboard bundle
 * is checked by check-dashboard-assets.ts at the end of every build. Out
 * of scope, stated: `docker/` and `examples/` (their runtime files carry
 * loopback addresses, compose service names and listening lines, and their
 * READMEs carry documentation links, none fetched; neither tree is in the
 * npm tarball) and the Docker image's base layers (Debian's, outside
 * Helio's claim).
 *
 * This is a tripwire, not a proof. A URL assembled from pieces, a
 * regex-escaped literal, a `\x2f` escape or a host read from an
 * environment variable is not a literal. The runtime half, the
 * `no telemetry (issue #401)` suite in packages/proxy/src/cli.test.ts,
 * traces every CLI command's sockets and is the proof for those paths.
 * Known limits of rule (a): the compose name `helio` is in the host class,
 * so a literal `https://helio/collect` passes; a `)` inside a URL ends the
 * match early (`https://127.0.0.1)/rest` reads as `127.0.0.1`); a template
 * `http://${HOST}@evil.example/` passes on its empty prefix.
 *
 * Usage: node scripts/check-no-telemetry.mjs [--repo-root <dir>]
 * Exit 1 with one `NO-TELEMETRY FAIL: <path>:<line> ...` line per offender,
 * or exit 0 with one `NO-TELEMETRY OK` line.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// Configuration: the corpus, the host class, the exceptions
// ---------------------------------------------------------------------------

const SOURCE_TREES = ['packages/proxy/src', 'packages/dashboard/src', 'packages/python-sdk/src']
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.py']
const TEST_DIRS = new Set(['__tests__', 'tests'])
const TEST_FILE = /\.test\.tsx?$/
const SKIPPED_DIRS = new Set(['node_modules', 'dist'])

const LOOPBACK_HOSTS = new Set([
  '127.0.0.1',
  'localhost',
  'mcp-server',
  'helio-edge',
  'helio',
  'host.docker.internal',
])

const ALLOWLIST_PATH = 'scripts/no-telemetry-allowlist.txt'
const PROXY_SRC = 'packages/proxy/src'
const TSUP_CONFIG = 'packages/proxy/tsup.config.ts'

const NETWORK_MODULES = [
  'http',
  'https',
  'http2',
  'net',
  'tls',
  'dgram',
  'dns',
  'child_process',
  'undici',
  'worker_threads',
]

/** The three shipped proxy modules allowed to name a network-shaped module. */
const IMPORT_EXCEPTIONS = [
  {
    file: 'demo/upstream.ts',
    module: 'node:http',
    reason: 'createServer: the demo upstream listens, it does not connect',
  },
  {
    file: 'server.ts',
    module: 'node:net',
    reason: 'import type { Socket }: a type for the inbound listener',
  },
  {
    file: 'transport/stdio-wrapper.ts',
    module: 'node:child_process',
    reason: 'spawn of the stdio upstream the operator configured',
  },
]

/** Shipped proxy files allowed to call `fetch(`: the upstream forwarders, the
 * webhook channel and the three CLI readers of the running proxy's dashboard. */
const FETCH_FILES = new Set([
  'approval/webhook.ts',
  'baseline/client.ts',
  'policy/status-fetch.ts',
  'upstream/sse-forwarder.ts',
  'upstream/streamable-http-forwarder.ts',
  'upstream/upstream-session-manager.ts',
])

/** Shipped proxy files allowed to construct the Slack client. */
const WEBCLIENT_FILES = new Set(['approval/slack.ts'])

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** A URL literal: the scheme, then everything up to the first delimiter. */
const URL_LITERAL = /https?:\/\/[^\s'"`)>\\]*/g

/** A quoted specifier: group 1 is the full specifier, subpath included, compared exactly to an exception. */
const MODULE_SPECIFIER = `['"\`]((?:node:)?(?:${NETWORK_MODULES.join('|')})(?:/[^'"\`]*)?)['"\`]`
const IMPORT_FORMS = [
  { form: 'import from', pattern: new RegExp(`\\bfrom\\s+${MODULE_SPECIFIER}`) },
  { form: 'bare import', pattern: new RegExp(`\\bimport\\s+${MODULE_SPECIFIER}`) },
  { form: 'dynamic import', pattern: new RegExp(`\\bimport\\s*\\(\\s*${MODULE_SPECIFIER}`) },
  { form: 'require', pattern: new RegExp(`\\brequire\\s*\\(\\s*${MODULE_SPECIFIER}`) },
]

const FETCH_CALL = /\bfetch\s*\(/
const WEBCLIENT_CALL = /\bnew\s+WebClient\s*\(/
const TSUP_NO_EXTERNAL = /\bnoExternal\b/
const TSUP_BUNDLE_DEPS = /\bskipNodeModulesBundle\s*:\s*false\b/

function die(message) {
  console.error(`check-no-telemetry: ${message}`)
  process.exit(2)
}

function parseArgs(argv) {
  let repoRoot = null
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--repo-root') {
      const value = argv[++i]
      if (value === undefined) die('--repo-root requires a value')
      repoRoot = value
    } else {
      die(`unknown argument: ${arg}`)
    }
  }
  return resolve(repoRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), '..'))
}

/** Recursively collect corpus files under `rel`, as repo-relative paths. */
function walk(repoRoot, rel, out, failures) {
  const abs = join(repoRoot, rel)
  if (!existsSync(abs)) return
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (SKIPPED_DIRS.has(entry.name) || TEST_DIRS.has(entry.name)) continue
    const childRel = `${rel}/${entry.name}`
    let kind = entry
    if (entry.isSymbolicLink()) {
      try {
        kind = statSync(join(abs, entry.name))
      } catch {
        failures.push({ file: childRel, line: 0, message: 'dangling symlink in the corpus' })
        continue
      }
      if (kind.isDirectory()) continue
    }
    if (kind.isDirectory()) {
      walk(repoRoot, childRel, out, failures)
    } else if (
      kind.isFile() &&
      SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext)) &&
      !TEST_FILE.test(entry.name)
    ) {
      out.push(childRel)
    }
  }
}

/** Parse the allowlist into rows; a malformed row is a failure. */
function readAllowlist(repoRoot, failures) {
  const abs = join(repoRoot, ALLOWLIST_PATH)
  if (!existsSync(abs)) {
    failures.push({ file: ALLOWLIST_PATH, line: 0, message: 'allowlist file is missing' })
    return []
  }
  const rows = []
  const lines = readFileSync(abs, 'utf-8').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]
    if (text.trim() === '' || text.startsWith('#')) continue
    const fields = text.split('\t')
    if (fields.length !== 3 || fields.some((field) => field.trim() === '')) {
      failures.push({
        file: ALLOWLIST_PATH,
        line: i + 1,
        message: 'malformed row; expected path<TAB>literal<TAB>reason',
      })
      continue
    }
    rows.push({ line: i + 1, path: fields[0], literal: fields[1], used: false })
  }
  return rows
}

/**
 * Classify one URL literal: 'skip' (a bare scheme), 'pass' (loopback-class
 * host or an allowed template), or a failure message.
 */
function classifyLiteral(text) {
  if (text === 'http://' || text === 'https://') return { verdict: 'skip' }
  const authority = text.slice(text.indexOf('://') + 3).split(/[/?#]/, 1)[0]
  const templateAt = authority.indexOf('${')
  if (templateAt !== -1) {
    const prefix = authority.slice(0, templateAt)
    const prefixHost = prefix.endsWith(':') ? prefix.slice(0, -1) : null
    if (prefix === '' || (prefixHost !== null && LOOPBACK_HOSTS.has(prefixHost))) {
      return { verdict: 'pass' }
    }
    return { verdict: 'fail', message: `templated URL with a non-loopback authority prefix` }
  }
  let hostname
  try {
    hostname = new URL(text).hostname
  } catch {
    return { verdict: 'fail', message: 'URL literal does not parse' }
  }
  if (LOOPBACK_HOSTS.has(hostname)) return { verdict: 'pass' }
  return { verdict: 'unlisted', hostname }
}

function checkLiterals(file, lines, rows, failures) {
  const fileRows = rows.filter((row) => row.path === file)
  for (let i = 0; i < lines.length; i++) {
    for (const match of lines[i].matchAll(URL_LITERAL)) {
      const text = match[0].endsWith('.') ? match[0].slice(0, -1) : match[0]
      const result = classifyLiteral(text)
      if (result.verdict === 'skip' || result.verdict === 'pass') continue
      if (result.verdict === 'fail') {
        failures.push({ file, line: i + 1, message: `${result.message}: ${text}` })
        continue
      }
      const row = fileRows.find((candidate) => candidate.literal === text)
      if (row) {
        row.used = true
        continue
      }
      failures.push({
        file,
        line: i + 1,
        message: `non-loopback host "${result.hostname}" not allowlisted for this file: ${text}`,
      })
    }
  }
}

function checkImports(file, proxyRel, lines, failures) {
  for (let i = 0; i < lines.length; i++) {
    for (const { form, pattern } of IMPORT_FORMS) {
      const match = pattern.exec(lines[i])
      if (!match) continue
      const specifier = match[1]
      const allowed = IMPORT_EXCEPTIONS.some(
        (exception) => exception.file === proxyRel && exception.module === specifier,
      )
      if (allowed) continue
      failures.push({
        file,
        line: i + 1,
        message: `network-shaped module "${specifier}" (${form}) outside the named exceptions: ${lines[i].trim()}`,
      })
    }
  }
}

function checkCallSites(file, proxyRel, lines, failures) {
  for (let i = 0; i < lines.length; i++) {
    if (FETCH_CALL.test(lines[i]) && !FETCH_FILES.has(proxyRel)) {
      failures.push({
        file,
        line: i + 1,
        message: `fetch( in a file not on the call-site list: ${lines[i].trim()}`,
      })
    }
    if (WEBCLIENT_CALL.test(lines[i]) && !WEBCLIENT_FILES.has(proxyRel)) {
      failures.push({
        file,
        line: i + 1,
        message: `new WebClient( in a file not on the call-site list: ${lines[i].trim()}`,
      })
    }
  }
}

function checkBundling(repoRoot, failures) {
  const abs = join(repoRoot, TSUP_CONFIG)
  if (!existsSync(abs)) {
    failures.push({ file: TSUP_CONFIG, line: 0, message: 'tsup config is missing' })
    return
  }
  const lines = readFileSync(abs, 'utf-8').split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (TSUP_NO_EXTERNAL.test(lines[i])) {
      failures.push({
        file: TSUP_CONFIG,
        line: i + 1,
        message: `noExternal would bundle a dependency into dist/cli.js: ${lines[i].trim()}`,
      })
    }
    if (TSUP_BUNDLE_DEPS.test(lines[i])) {
      failures.push({
        file: TSUP_CONFIG,
        line: i + 1,
        message: `skipNodeModulesBundle: false would bundle every dependency into dist/cli.js: ${lines[i].trim()}`,
      })
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const repoRoot = parseArgs(process.argv.slice(2))
  const failures = []
  const files = []
  for (const tree of SOURCE_TREES) walk(repoRoot, tree, files, failures)
  files.sort()

  const rows = readAllowlist(repoRoot, failures)
  const corpus = new Set(files)
  for (const row of rows) {
    if (!corpus.has(row.path)) {
      failures.push({
        file: ALLOWLIST_PATH,
        line: row.line,
        message: `row for ${row.path} names a file outside the corpus (stale or misfiled)`,
      })
      row.used = true
    }
  }

  let literals = 0
  for (const file of files) {
    const lines = readFileSync(join(repoRoot, file), 'utf-8').split('\n')
    for (const line of lines) literals += (line.match(URL_LITERAL) ?? []).length
    checkLiterals(file, lines, rows, failures)
    if (file.startsWith(`${PROXY_SRC}/`)) {
      const proxyRel = file.slice(PROXY_SRC.length + 1)
      checkImports(file, proxyRel, lines, failures)
      checkCallSites(file, proxyRel, lines, failures)
    }
  }
  for (const row of rows) {
    if (!row.used) {
      failures.push({
        file: ALLOWLIST_PATH,
        line: row.line,
        message: `row for ${row.path} (${row.literal}) matches nothing in its file (stale or misfiled)`,
      })
    }
  }

  checkBundling(repoRoot, failures)

  if (failures.length > 0) {
    failures.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line))
    for (const failure of failures) {
      const where = failure.line > 0 ? `${failure.file}:${failure.line}` : failure.file
      console.error(`NO-TELEMETRY FAIL: ${where} ${failure.message}`)
    }
    process.exitCode = 1
    return
  }
  console.log(
    `NO-TELEMETRY OK: ${files.length} source files, ${literals} URL literals, ${rows.length} allowlist rows, imports and call sites in place, tsup bundles no dependency`,
  )
}

main()
