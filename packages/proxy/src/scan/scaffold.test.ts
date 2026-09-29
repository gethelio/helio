import { describe, it, expect } from 'vitest'
import yaml from 'js-yaml'
import { renderScanTemplate } from './scaffold.js'
import { buildScanReport, emptyAllowPolicy } from './report.js'
import type { ScanReport } from './report.js'
import { surfaceToolsFromList } from './tools.js'
import { helioConfigSchema } from '../config/schema.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DIGEST = `sha256:${'ab'.repeat(32)}`

const TOOLS = [
  { name: 'get_weather', annotations: { readOnlyHint: true, destructiveHint: false } },
  { name: 'delete_record', annotations: { readOnlyHint: false, destructiveHint: true } },
  { name: 'exec' },
  {
    name: 'create_payment',
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: { type: 'object', properties: { amount: { type: 'number' } } },
  },
  {
    name: 'paypal_payout',
    inputSchema: { type: 'object', properties: { total: { type: 'number' } } },
  },
]

function report(tools: unknown[] = TOOLS, upstream?: string): ScanReport {
  const listed = surfaceToolsFromList({ result: { tools } })
  if (listed === null) throw new Error('fixture')
  return buildScanReport({
    target: {
      label: 'http://127.0.0.1:8080/mcp',
      transport: 'streamable-http',
      upstream,
      config: upstream === undefined ? undefined : 'helio.yaml',
    },
    generatedAt: '2026-09-29T12:50:07.000Z',
    policy: emptyAllowPolicy(),
    policyLoaded: false,
    budgets: [],
    environment: undefined,
    listed,
    unavailable: undefined,
  })
}

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

function expectCanonicalOrder(contents: string): void {
  let cursor = -1
  for (const key of CANONICAL_ORDER) {
    const match = new RegExp(`^(?:#\\s*)?${key}:`, 'm').exec(contents)
    expect(match, `top-level \`${key}:\` stub missing`).not.toBeNull()
    const index = match?.index ?? -1
    expect(index, `\`${key}:\` is out of canonical order`).toBeGreaterThan(cursor)
    cursor = index
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('renderScanTemplate', () => {
  const text = renderScanTemplate({
    report: report(),
    rawUpstream: undefined,
    apiSecretDigest: DIGEST,
  })

  it('names the target, the instant and the counts in its header', () => {
    const head = text.split('\n').slice(0, 4).join('\n')
    expect(head).toContain('helio scan')
    expect(head).toContain('http://127.0.0.1:8080/mcp (streamable-http)')
    expect(head).toContain('2026-09-29 12:50 UTC')
    expect(head).toContain('5 tools exposed, 3 destructive (2 by MCP default)')
  })

  it('writes the bare URL as the upstream and the twelve stubs in canonical order', () => {
    expect(text).toContain(
      'upstream:\n  url: "http://127.0.0.1:8080/mcp"\n  transport: streamable-http\n',
    )
    expect(text).toContain('#   headers:\n#     Authorization: "Bearer ${UPSTREAM_TOKEN}"\n')
    expect(text).toContain('\n# upstreams:\n')
    expect(text).toContain('\n# environment: production\n')
    expectCanonicalOrder(text)
  })

  it('keeps default allow with its own production-deny comment', () => {
    expect(text).toContain(
      '  # Production posture is deny; allow keeps the first helio start from blocking anything by surprise.\n  default: allow\n',
    )
  })

  it('writes a live require_approval rule per annotated-destructive tool and a live allow per read-only tool', () => {
    expect(text).toContain(
      "    - name: approve-delete_record\n      match:\n        tool: 'delete_record'\n      action: require_approval\n      approval:\n        channel: dashboard\n",
    )
    expect(text).toContain(
      "    - name: allow-get_weather\n      match:\n        tool: 'get_weather'\n      action: allow\n",
    )
    expect(text).not.toContain('name: approve-create_payment')
  })

  it('comments a rule per default-destructive tool, naming the MCP default', () => {
    expect(text).toContain(
      "    # exec sets no destructiveHint: destructive by MCP default\n    # - name: approve-exec\n    #   match:\n    #     tool: 'exec'\n    #   action: require_approval\n    #   approval:\n    #     channel: dashboard\n",
    )
    expect(text).toContain(
      '    # paypal_payout sets no destructiveHint: destructive by MCP default\n',
    )
  })

  it('comments a budget with one contributor per amount-like candidate', () => {
    expect(text).toContain('# budgets:\n#   # candidates from the live schema, not certainties\n')
    expect(text).toContain(
      "#       - match:\n#           tool: 'create_payment'\n#         field: '$.amount'\n",
    )
    expect(text).toContain(
      "#       - match:\n#           tool: 'paypal_payout'\n#         field: '$.total'\n",
    )
  })

  it('ships the dashboard channel and the dashboard block live with the minted digest', () => {
    expect(text).toContain(
      'approval:\n  timeout: 300s\n  default_on_timeout: deny\n  channels:\n    - type: dashboard\n',
    )
    expect(text).toContain(
      `dashboard:\n  enabled: true\n  port: 3100\n  host: 127.0.0.1\n  api_secret: "${DIGEST}"\n`,
    )
  })

  it('parses and validates as a config', () => {
    const parsed = helioConfigSchema.safeParse(yaml.load(text))
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true)
    if (parsed.success && 'upstream' in parsed.data) {
      expect(parsed.data.upstream.url).toBe('http://127.0.0.1:8080/mcp')
      expect(parsed.data.policies.rules.map((rule) => rule.name)).toEqual([
        'approve-delete_record',
        'allow-get_weather',
      ])
    }
  })

  it('writes rules: [] when no tool is annotated destructive or read-only, and the dashboard stays live', () => {
    const bare = renderScanTemplate({
      report: report([{ name: 'exec' }, { name: 'ls', annotations: { destructiveHint: false } }]),
      rawUpstream: undefined,
      apiSecretDigest: DIGEST,
    })
    expect(bare).toContain('  rules: []\n')
    expect(bare).toContain('    # exec sets no destructiveHint: destructive by MCP default\n')
    expect(bare).toContain(`  api_secret: "${DIGEST}"\n`)
    expect(bare).toContain('# budgets:\n')
    expect(bare).not.toContain('#       - match:')
    expect(helioConfigSchema.safeParse(yaml.load(bare)).success).toBe(true)
  })

  it('quotes a tool name so it round-trips through YAML', () => {
    const odd = renderScanTemplate({
      report: report([{ name: "it's Hello, 世界", annotations: { destructiveHint: true } }]),
      rawUpstream: undefined,
      apiSecretDigest: DIGEST,
    })
    const parsed = helioConfigSchema.parse(yaml.load(odd))
    if ('upstream' in parsed) {
      expect(parsed.policies.rules[0]?.match.tool).toBe("it's Hello, 世界")
    }
  })

  it('writes a config target from the raw file text: placeholders intact, headers and name never copied', () => {
    const text = renderScanTemplate({
      report: report(TOOLS, 'files'),
      rawUpstream: {
        name: 'files',
        transport: 'stdio',
        command: 'node',
        args: ['server.js'],
        env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' },
        headers: { Authorization: 'Bearer ${GITHUB_TOKEN}' },
      },
      apiSecretDigest: DIGEST,
    })
    const upstreamBlock = text.slice(
      text.indexOf('\nupstream:\n'),
      text.indexOf('\n# upstreams:\n'),
    )
    expect(upstreamBlock).toContain('transport: stdio')
    expect(upstreamBlock).toContain('command: node')
    expect(upstreamBlock).toContain('server.js')
    expect(upstreamBlock).toContain('${GITHUB_TOKEN}')
    expect(upstreamBlock).not.toContain('name: files')
    expect(upstreamBlock).not.toMatch(/^\s{2}headers:/m)
    expect(upstreamBlock).toContain('#     Authorization: "Bearer ${UPSTREAM_TOKEN}"')
    const parsed = yaml.load(text) as { upstream: Record<string, unknown> }
    expect(parsed.upstream['env']).toEqual({ GITHUB_TOKEN: '${GITHUB_TOKEN}' })
    expect(parsed.upstream['headers']).toBeUndefined()
  })
})
