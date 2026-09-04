import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import yaml from 'js-yaml'
import { loadConfig } from './config/index.js'
import {
  renderSandboxCompose,
  renderSandboxConfig,
  renderSandboxReadme,
  sandboxImageTag,
  SANDBOX_FILES,
} from './sandbox-scaffold.js'

const CANONICAL_ORDER = [
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

interface ComposeService {
  image?: string
  networks?: string[]
  volumes?: string[]
  environment?: Record<string, string>
  ports?: string[]
  configs?: { source: string; target: string }[]
}
interface ComposeFile {
  services: {
    agent: ComposeService
    'helio-edge': ComposeService
    helio: ComposeService
    'mcp-server': ComposeService
  }
  networks: Record<string, { internal?: boolean } | null>
  configs?: { helio_edge_conf: { content: string } }
}

/** The N12 guard: sources an agent volume must never have. */
function isForbiddenAgentMountSource(source: string): boolean {
  const s = source.trim()
  if (['.', '..', './helio', './helio/', 'helio', 'helio/'].includes(s)) return true
  if (/(^|\/)\.env(\.[^/]*)?$/.test(s)) return true
  return s.includes('docker.sock')
}

describe('sandbox scaffold: helio/helio.yaml', () => {
  it('loads through loadConfig with the secret in the environment', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'helio-sandbox-config-'))
    const path = join(dir, 'helio.yaml')
    try {
      writeFileSync(path, renderSandboxConfig())
      const config = await loadConfig(path, { HELIO_DASHBOARD_SECRET: 'sandbox-test' })
      if (!('upstream' in config)) throw new Error('expected the singular upstream form')
      expect(config.upstream.url).toBe('http://mcp-server:8080/mcp')
      expect(config.listen.host).toBe('0.0.0.0')
      expect(config.dashboard.host).toBe('0.0.0.0')
      expect(config.audit.path).toBe('/data/helio-audit.db')
      expect(config.policies.rules).toHaveLength(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps the top-level keys in canonical order', () => {
    const text = renderSandboxConfig()
    let cursor = -1
    for (const key of CANONICAL_ORDER) {
      const match = new RegExp(`^${key}:`, 'm').exec(text)
      if (!match) continue
      expect(match.index, `\`${key}:\` is out of canonical order`).toBeGreaterThan(cursor)
      cursor = match.index
    }
    expect(cursor).toBeGreaterThan(-1)
  })
})

describe('sandbox scaffold: compose.yaml', () => {
  const compose = yaml.load(renderSandboxCompose({ imageTag: '1.2.3' })) as ComposeFile
  const { services, networks } = compose

  it('has exactly the four services', () => {
    expect(Object.keys(services).sort()).toEqual(['agent', 'helio', 'helio-edge', 'mcp-server'])
  })

  it('keeps agent on edge only, with no volumes key at all', () => {
    expect(services.agent.networks).toEqual(['edge'])
    expect(services.agent.volumes).toBeUndefined()
    expect(services.agent.environment).toBeUndefined()
    expect(services.agent.ports).toBeUndefined()
  })

  it('rejects the forbidden agent mount sources (guard for later edits)', () => {
    for (const source of [
      '.',
      '..',
      './helio',
      'helio/',
      '.env',
      './.env',
      '/var/run/docker.sock',
    ]) {
      expect(isForbiddenAgentMountSource(source), source).toBe(true)
    }
    expect(isForbiddenAgentMountSource('./workspace')).toBe(false)
    for (const volume of services.agent.volumes ?? []) {
      expect(isForbiddenAgentMountSource(volume.split(':')[0] ?? ''), volume).toBe(false)
    }
  })

  it('never attaches helio to edge', () => {
    expect(services.helio.networks).toEqual(['plane', 'internal'])
    expect(services['helio-edge'].networks).toEqual(['edge', 'plane'])
    expect(services['mcp-server'].networks).toEqual(['internal'])
  })

  it('gives only helio an environment and a host-loopback port', () => {
    for (const [name, service] of Object.entries(services)) {
      if (name === 'helio') continue
      expect(service.environment, name).toBeUndefined()
      expect(service.ports, name).toBeUndefined()
    }
    expect(Object.keys(services.helio.environment ?? {})).toEqual(['HELIO_DASHBOARD_SECRET'])
    expect(services.helio.ports).toEqual(['127.0.0.1:3100:3100'])
  })

  it('mounts ./helio read-only into helio only', () => {
    expect(services.helio.volumes).toContain('./helio:/config:ro')
    for (const [name, service] of Object.entries(services)) {
      if (name === 'helio') continue
      for (const volume of service.volumes ?? [])
        expect(volume, name).not.toMatch(/^\.\/helio(\/|:)/)
    }
  })

  it('marks internal as internal and the other two networks not', () => {
    expect(Object.keys(networks).sort()).toEqual(['edge', 'internal', 'plane'])
    expect(networks.internal?.internal).toBe(true)
    expect(networks.edge?.internal).toBeUndefined()
    expect(networks.plane?.internal).toBeUndefined()
  })

  it('forwards port 3000 to helio through the Docker resolver', () => {
    const content = compose.configs?.helio_edge_conf.content ?? ''
    expect(content).toContain('listen 3000;')
    expect(content).toContain('resolver 127.0.0.11')
    expect(content).toContain('proxy_timeout 1h;')
    expect(content).toContain('set $$helio helio:3000;')
    expect(content).toContain('proxy_pass $$helio;')
    expect(services['helio-edge'].configs?.[0]).toEqual({
      source: 'helio_edge_conf',
      target: '/etc/nginx/nginx.conf',
    })
  })

  it('pins the helio image to the given tag and maps a source build to latest', () => {
    expect(services.helio.image).toBe('ghcr.io/gethelio/helio:1.2.3')
    expect(sandboxImageTag('0.0.0')).toBe('latest')
    expect(sandboxImageTag('0.14.0')).toBe('0.14.0')
    expect(SANDBOX_FILES).toEqual(['compose.yaml', 'helio/helio.yaml', 'helio/README.md'])
  })
})

describe('sandbox scaffold: helio/README.md', () => {
  const readme = renderSandboxReadme()

  it('carries the five hard constraints verbatim', () => {
    for (const line of [
      'Never mount `.` or `.env` into the `agent` service.',
      'Never mount `docker.sock` into it; an agent with the socket is the host.',
      'Secrets only on the `helio` service.',
      '`./helio/` is never mounted into `agent`.',
      '`edge` has internet egress',
    ]) {
      expect(readme).toContain(line)
    }
  })

  it('carries the four checks verbatim', () => {
    for (const command of [
      'curl -s -m 3 http://mcp-server:8080/mcp; echo "exit: $?"',
      'ls /config /workspace/helio 2>&1; echo "exit: $?"',
      'curl -s -m 3 http://helio:3100/api/health; echo "exit: $?"',
      'env | grep -iE \'helio|upstream|secret\'; echo "exit: $?"',
      'http://helio-edge:3000/mcp',
    ]) {
      expect(readme).toContain(command)
    }
  })

  it('carries the dev-container snippet and the Desktop residual', () => {
    expect(readme).toContain('"dockerComposeFile": "../../compose.yaml"')
    expect(readme).toContain('"service": "agent"')
    expect(readme).toContain('host.docker.internal:3100')
    expect(readme).toContain('`/api/health` answers without it')
  })
})

describe('sandbox scaffold: the sidecar page shows what the command writes', () => {
  const page = readFileSync(
    join(import.meta.dirname, '../../../docs/deployment-sidecar.md'),
    'utf-8',
  )
  it('contains the generated compose.yaml and helio/helio.yaml verbatim', () => {
    expect(page).toContain(renderSandboxCompose({ imageTag: 'latest' }).trimEnd())
    expect(page).toContain(renderSandboxConfig().trimEnd())
  })
})
