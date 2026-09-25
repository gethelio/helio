import { describe, it, expect, vi } from 'vitest'
import { execFile } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEMO_DEFAULT_PORTS, renderDemoConfig, renderDemoReadme } from './config.js'
import { renderDemoUpstream } from './upstream.js'
import { DEMO_TOOLS, DEMO_UPSTREAMS } from './corpus.js'

// ---------------------------------------------------------------------------
// The rendered files: the config the sample checker validates through the
// docs page that pins it, the README, and the dependency-free upstream.
// ---------------------------------------------------------------------------

describe('renderDemoConfig', () => {
  const config = renderDemoConfig(DEMO_DEFAULT_PORTS)

  it('says on its first line that the file is sample traffic written by helio init --demo', () => {
    const [first] = config.split('\n')
    expect(first).toMatch(/^# /)
    expect(first).toContain('sample traffic')
    expect(first).toContain('helio init --demo')
  })

  it('names the two doors, the two rules, the pot and the open-mode dashboard on the default ports', () => {
    expect(config).toContain('name: demo-crm')
    expect(config).toContain("url: 'http://127.0.0.1:8080/crm'")
    expect(config).toContain('name: demo-billing')
    expect(config).toContain("url: 'http://127.0.0.1:8080/billing'")
    expect(config).toContain('port: 3000')
    expect(config).toContain('port: 3100')
    expect(config).toContain('environment: demo')
    expect(config).toContain('name: allow-reads')
    expect(config).toContain('name: block-destructive')
    expect(config).toContain('name: demo-payments')
    expect(config).toContain('on_exceed: deny')
    expect(config).toContain('path: ./helio-demo-audit.db')
    expect(config).toContain('allow_open_mode: true')
    expect(config).toContain('-c helio-demo.yaml')
  })

  it('carries no approval, evidence or requires block, so no secret is needed', () => {
    expect(config).not.toContain('require_approval')
    expect(config).not.toContain('api_secret')
    expect(config).not.toMatch(/^\s+evidence:/m)
    expect(config).not.toMatch(/^\s+requires:/m)
  })

  it('embeds the ports it is given', () => {
    const other = renderDemoConfig({ upstreamPort: 18080, listenPort: 13000, dashboardPort: 13100 })
    expect(other).toContain("url: 'http://127.0.0.1:18080/crm'")
    expect(other).toContain('port: 13000')
    expect(other).toContain('port: 13100')
    expect(other).not.toBe(config)
  })

  it('is shown verbatim in docs/demo.md as a column-0 yaml fence', () => {
    const page = readFileSync(join(import.meta.dirname, '../../../../docs/demo.md'), 'utf-8')
    expect(page).toContain(`\n\`\`\`yaml\n${config.trimEnd()}\n\`\`\`\n`)
  })
})

describe('renderDemoReadme', () => {
  const readme = renderDemoReadme()

  it('says what is sample, what to run and how to share a report', () => {
    expect(readme).toContain('helio init --demo')
    expect(readme).toContain('helio report activation -c helio-demo.yaml')
    expect(readme).toContain('node mcp-demo-server.mjs')
    expect(readme).toContain('helio start -c helio-demo.yaml')
    expect(readme).toContain('helio policy status -c helio-demo.yaml')
    expect(readme).toContain('--include-names')
    expect(readme).toContain('Error: Cannot read config file: helio.yaml')
    expect(readme).toContain('--force')
  })
})

describe('renderDemoUpstream', () => {
  const source = renderDemoUpstream()

  it('imports node:http and nothing else', () => {
    const imports = [...source.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1])
    expect(imports).toEqual(['node:http'])
    expect(source).not.toContain('require(')
  })

  it('serves five tools on /crm and five on /billing, answers initialize with the legacy revision, and calls with a sample text', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'helio-demo-upstream-'))
    const file = join(dir, 'mcp-demo-server.mjs')
    writeFileSync(file, source)
    let child: ChildProcess | undefined
    try {
      let stderr = ''
      child = execFile('node', [file], { env: { ...process.env, PORT: '0' } })
      child.stderr?.on('data', (chunk: Buffer | string) => {
        stderr += String(chunk)
      })
      const port = await vi.waitFor(() => {
        const match = stderr.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/)
        if (!match) throw new Error(`not listening yet: ${stderr}`)
        return Number(match[1])
      })
      const rpc = async (path: string, method: string, params?: unknown): Promise<unknown> => {
        const response = await fetch(`http://127.0.0.1:${String(port)}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        })
        return ((await response.json()) as { result: unknown }).result
      }
      const init = (await rpc('/crm', 'initialize')) as { protocolVersion: string }
      expect(init.protocolVersion).toBe('2025-06-18')
      const names = (list: unknown): string[] =>
        (list as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name)
      expect(names(await rpc('/crm', 'tools/list'))).toEqual(
        DEMO_TOOLS.filter((t) => t.upstream === DEMO_UPSTREAMS.crm).map((t) => t.name),
      )
      expect(names(await rpc('/billing', 'tools/list'))).toEqual(
        DEMO_TOOLS.filter((t) => t.upstream === DEMO_UPSTREAMS.billing).map((t) => t.name),
      )
      const crm = (await rpc('/crm', 'tools/list')) as {
        tools: Array<{ name: string; annotations?: Record<string, boolean> }>
      }
      expect(crm.tools.find((t) => t.name === 'export_customers')?.annotations).toBeUndefined()
      expect(crm.tools.find((t) => t.name === 'get_customer')?.annotations).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
      })
      const call = (await rpc('/billing', 'tools/call', {
        name: 'get_invoice',
        arguments: {},
      })) as {
        content: Array<{ type: string; text: string }>
      }
      expect(call.content).toEqual([{ type: 'text', text: 'get_invoice: ok (sample)' }])
    } finally {
      child?.kill()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
