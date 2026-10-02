/**
 * `scripts/set-release-version.sh` stamps the release version into every file
 * that reaches a release artifact: the proxy and dashboard manifests, and the
 * MCP registry entry `packages/proxy/server.json` (issue #403), whose server
 * version and package version must both equal the npm version the registry
 * resolves. Each test copies the real files into a temp tree with the same
 * relative layout and runs the script there with `npm` on PATH; no git is
 * needed, and the repo's own files are never touched.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const REPO_ROOT = join(import.meta.dirname, '../../..')
const SCRIPT = 'scripts/set-release-version.sh'
const STAMPED_FILES = [
  'packages/proxy/package.json',
  'packages/dashboard/package.json',
  'packages/proxy/server.json',
] as const

const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** Copy the script and the stamped files into a fresh temp tree. */
function makeTree(): string {
  const root = mkdtempSync(join(tmpdir(), 'helio-release-stamp-'))
  roots.push(root)
  for (const rel of [SCRIPT, ...STAMPED_FILES]) {
    const target = join(root, rel)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(join(REPO_ROOT, rel), target)
  }
  return root
}

/** Run the script with the tree root as the working directory. */
function stamp(root: string, version: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    execFile('bash', [SCRIPT, version], { cwd: root }, (error, stdout, stderr) => {
      resolve({
        code: typeof error?.code === 'number' ? error.code : error ? 1 : 0,
        output: `${stdout}\n${stderr}`,
      })
    })
  })
}

interface Stamped {
  readonly version: string
  readonly packages?: readonly { readonly version: string }[]
}

function readJson(root: string, rel: string): { readonly raw: string; readonly json: Stamped } {
  const raw = readFileSync(join(root, rel), 'utf-8')
  return { raw, json: JSON.parse(raw) as Stamped }
}

describe('set-release-version.sh', () => {
  it('stamps both manifests and the registry entry, keeping the entry two-space with a newline', async () => {
    const root = makeTree()
    const { code, output } = await stamp(root, '1.2.3')
    expect(code, output).toBe(0)

    expect(readJson(root, 'packages/proxy/package.json').json.version).toBe('1.2.3')
    expect(readJson(root, 'packages/dashboard/package.json').json.version).toBe('1.2.3')

    const { raw, json } = readJson(root, 'packages/proxy/server.json')
    expect(json.version).toBe('1.2.3')
    expect(json.packages?.map((p) => p.version)).toEqual(['1.2.3'])
    expect(raw).toBe(JSON.stringify(json, null, 2) + '\n')
  })

  it('stamps every package in the entry, not only the first', async () => {
    const root = makeTree()
    const entryPath = join(root, 'packages/proxy/server.json')
    const entry = JSON.parse(readFileSync(entryPath, 'utf-8')) as {
      packages: { version: string }[]
    }
    entry.packages.push({ ...entry.packages[0], version: '0.0.0' })
    writeFileSync(entryPath, JSON.stringify(entry, null, 2) + '\n')

    const { code, output } = await stamp(root, '4.5.6')
    expect(code, output).toBe(0)
    const { json } = readJson(root, 'packages/proxy/server.json')
    expect(json.version).toBe('4.5.6')
    expect(json.packages?.map((p) => p.version)).toEqual(['4.5.6', '4.5.6'])
  })
})
