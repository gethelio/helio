import { cp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptsDir = dirname(fileURLToPath(import.meta.url))
const proxyDir = resolve(scriptsDir, '..')
const dashboardDistDir = resolve(proxyDir, '../dashboard/dist')
const dashboardIndexPath = resolve(dashboardDistDir, 'index.html')
const bundledDashboardDir = resolve(proxyDir, 'dist/dashboard-assets')

async function main(): Promise<void> {
  if (!existsSync(dashboardIndexPath)) {
    throw new Error(
      `Dashboard build output missing at ${dashboardIndexPath}. Run "pnpm --filter @gethelio/dashboard build" first.`,
    )
  }

  await rm(bundledDashboardDir, { recursive: true, force: true })
  await cp(dashboardDistDir, bundledDashboardDir, { recursive: true })

  // eslint-disable-next-line no-console -- build script status output
  console.error(`[helio] Bundled dashboard assets into ${bundledDashboardDir}`)
}

void main().catch((error: unknown) => {
  // eslint-disable-next-line no-console -- build script error output
  console.error('[helio] Failed to bundle dashboard assets:', error)
  process.exit(1)
})
