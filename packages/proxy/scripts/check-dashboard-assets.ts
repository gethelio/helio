/**
 * Verifies the dashboard bundle that pnpm build copied into dist/dashboard-assets:
 * it exists and is non-empty, index.html references the assets directory, and,
 * for the no-telemetry claim in SECURITY.md (#401), every http(s) literal in the
 * bundle is a known library string and the JS carries no request sink beyond
 * fetch and EventSource (which the dashboard uses on same-origin /api paths).
 * A library upgrade that adds a new error-page host fails the build here, and a
 * reviewer adds the row.
 *
 * Usage: tsx scripts/check-dashboard-assets.ts [--dist-dir <dir>]
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptsDir = dirname(fileURLToPath(import.meta.url))
const proxyDir = resolve(scriptsDir, '..')

function fail(message: string): never {
  // eslint-disable-next-line no-console -- build script error output
  console.error(`[helio] ${message}`)
  process.exit(1)
}

function parseDistDir(argv: readonly string[]): string {
  let distDir = resolve(proxyDir, 'dist/dashboard-assets')
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dist-dir') {
      const value = argv[i + 1]
      if (value === undefined) fail('--dist-dir requires a value')
      distDir = resolve(value)
      i++
    } else {
      fail(`unknown argument: ${argv[i]}`)
    }
  }
  return distDir
}

const distDir = parseDistDir(process.argv.slice(2))
const dashboardIndexPath = join(distDir, 'index.html')
const dashboardAssetsDirPath = join(distDir, 'assets')

if (!existsSync(dashboardIndexPath) || !existsSync(dashboardAssetsDirPath)) {
  fail(
    `Missing bundled dashboard assets at ${dashboardIndexPath} or ${dashboardAssetsDirPath}. Run "pnpm --filter @gethelio/proxy build" before packaging.`,
  )
}

const dashboardIndexSize = statSync(dashboardIndexPath).size
if (dashboardIndexSize <= 0) {
  fail(`Bundled dashboard index is empty at ${dashboardIndexPath}.`)
}

const dashboardAssetsEntries = readdirSync(dashboardAssetsDirPath)
if (dashboardAssetsEntries.length === 0) {
  fail(`Bundled dashboard assets directory is empty at ${dashboardAssetsDirPath}.`)
}

const dashboardIndexHtml = readFileSync(dashboardIndexPath, 'utf-8')
if (!dashboardIndexHtml.includes('assets/')) {
  fail(`Bundled dashboard index at ${dashboardIndexPath} does not reference the assets directory.`)
}

// ---------------------------------------------------------------------------
// No-telemetry: every URL literal in the bundle is a known library string
// ---------------------------------------------------------------------------

/** Library strings that carry a path: anything appended to them stays on that host. */
const ALLOWED_URL_PREFIXES: readonly string[] = [
  'http://www.w3.org/', // XML namespaces (SVG, xlink, MathML, XHTML)
  'https://react.dev/errors/', // React's minified error links
  'https://reactrouter.com/', // React Router's deprecation and picking-a-router links
  'https://redux.js.org/Errors', // Redux's minified error links (`Errors?code=`)
  'https://redux-toolkit.js.org/Errors', // Redux Toolkit's minified error links
]

/** Bare library strings, matched whole so a longer host cannot ride them. */
const ALLOWED_URLS: ReadonlySet<string> = new Set([
  'http://localhost', // React Router's URL base when no window is present
  'https://tailwindcss.com', // the Tailwind license banner in the CSS
  'https://bit.ly/3cXEKWf', // Recharts' hint on a missing ResponsiveContainer size
])

/**
 * A URL literal runs from the scheme to the first whitespace, quote, backtick,
 * `)`, `>` or backslash, the same delimiter class as scripts/check-no-telemetry.mjs,
 * so userinfo (`https://tailwindcss.com@evil.example/`) and an IPv6 host stay in
 * the matched text and fail the comparison below instead of being cut off.
 */
const URL_LITERAL = /https?:\/\/[^\s'"`)>\\]*/g

/** Request sinks the dashboard never uses; its requests are fetch and EventSource on /api paths. */
const REQUEST_SINKS: readonly RegExp[] = [/XMLHttpRequest/, /sendBeacon/, /new WebSocket\(/]

function isKnownLibraryUrl(literal: string): boolean {
  return (
    ALLOWED_URLS.has(literal) || ALLOWED_URL_PREFIXES.some((prefix) => literal.startsWith(prefix))
  )
}

const bundleFiles = [
  dashboardIndexPath,
  ...dashboardAssetsEntries
    .filter((name) => name.endsWith('.js') || name.endsWith('.css'))
    .map((name) => join(dashboardAssetsDirPath, name)),
]

for (const file of bundleFiles) {
  const text = readFileSync(file, 'utf-8')
  for (const match of text.matchAll(URL_LITERAL)) {
    if (!isKnownLibraryUrl(match[0])) {
      fail(
        `Bundled dashboard asset ${file} carries a URL literal outside the known library strings: ${match[0]}`,
      )
    }
  }
  if (file.endsWith('.js')) {
    for (const sink of REQUEST_SINKS) {
      if (sink.test(text)) {
        fail(
          `Bundled dashboard asset ${file} carries a request sink the dashboard does not use: ${sink.source}`,
        )
      }
    }
  }
}

// eslint-disable-next-line no-console -- build script status output
console.error(
  `[helio] Verified bundled dashboard assets at ${dashboardIndexPath} and ${dashboardAssetsDirPath}: ${String(bundleFiles.length)} files, every URL literal a known library string, no request sink beyond fetch and EventSource`,
)
