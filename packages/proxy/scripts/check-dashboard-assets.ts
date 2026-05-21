import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptsDir = dirname(fileURLToPath(import.meta.url))
const proxyDir = resolve(scriptsDir, '..')
const dashboardIndexPath = resolve(proxyDir, 'dist/dashboard-assets/index.html')
const dashboardAssetsDirPath = resolve(proxyDir, 'dist/dashboard-assets/assets')

if (!existsSync(dashboardIndexPath) || !existsSync(dashboardAssetsDirPath)) {
  // eslint-disable-next-line no-console -- build script error output
  console.error(
    `[helio] Missing bundled dashboard assets at ${dashboardIndexPath} or ${dashboardAssetsDirPath}. Run "pnpm --filter @gethelio/proxy build" before packaging.`,
  )
  process.exit(1)
}

const dashboardIndexSize = statSync(dashboardIndexPath).size
if (dashboardIndexSize <= 0) {
  // eslint-disable-next-line no-console -- build script error output
  console.error(`[helio] Bundled dashboard index is empty at ${dashboardIndexPath}.`)
  process.exit(1)
}

const dashboardAssetsEntries = readdirSync(dashboardAssetsDirPath)
if (dashboardAssetsEntries.length === 0) {
  // eslint-disable-next-line no-console -- build script error output
  console.error(`[helio] Bundled dashboard assets directory is empty at ${dashboardAssetsDirPath}.`)
  process.exit(1)
}

const dashboardIndexHtml = readFileSync(dashboardIndexPath, 'utf-8')
if (!dashboardIndexHtml.includes('assets/')) {
  // eslint-disable-next-line no-console -- build script error output
  console.error(
    `[helio] Bundled dashboard index at ${dashboardIndexPath} does not reference the assets directory.`,
  )
  process.exit(1)
}

// eslint-disable-next-line no-console -- build script status output
console.error(
  `[helio] Verified bundled dashboard assets at ${dashboardIndexPath} and ${dashboardAssetsDirPath}`,
)
