import { describe, it, expect } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { renderScanTemplate, writeScaffold } from './scaffold.js'
import { StartupError } from '../startup-error.js'
import { buildScanReport, emptyAllowPolicy } from './report.js'
import type { ScanReport } from './report.js'
import { surfaceToolsFromList } from './tools.js'
import { helioConfigSchema } from '../config/schema.js'
import { compilePolicies } from '../policy/parser.js'
import { compileBudgets } from '../budget/parser.js'

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
      '    - name: "approve-delete_record"\n      match:\n        tool: "delete_record"\n      action: require_approval\n      approval:\n        channel: dashboard\n',
    )
    expect(text).toContain(
      '    - name: "allow-get_weather"\n      match:\n        tool: "get_weather"\n      action: allow\n',
    )
    expect(text).not.toContain('name: approve-create_payment')
  })

  it('comments a rule per default-destructive tool, naming the MCP default', () => {
    expect(text).toContain(
      '    # exec sets no destructiveHint: destructive by MCP default\n    # - name: "approve-exec"\n    #   match:\n    #     tool: "exec"\n    #   action: require_approval\n    #   approval:\n    #     channel: dashboard\n',
    )
    expect(text).toContain(
      '    # paypal_payout sets no destructiveHint: destructive by MCP default\n',
    )
  })

  it('comments a budget with one contributor per amount-like candidate', () => {
    expect(text).toContain('# budgets:\n#   # candidates from the live schema, not certainties\n')
    expect(text).toContain(
      '#       - match:\n#           tool: "create_payment"\n#         field: "$.amount"\n',
    )
    expect(text).toContain(
      '#       - match:\n#           tool: "paypal_payout"\n#         field: "$.total"\n',
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
      const { policy } = compilePolicies(parsed.policies)
      expect(policy.rules[0]?.match.tool?.test("it's Hello, 世界")).toBe(true)
      expect(policy.rules[0]?.match.tool?.test('its Hello, 世界')).toBe(false)
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

describe('renderScanTemplate against hostile or credentialed input', () => {
  it('writes a config URL with its userinfo removed, placeholders intact', () => {
    const text = renderScanTemplate({
      report: report(TOOLS, undefined),
      rawUpstream: { url: 'http://user:secret@host/mcp?key=${API_KEY}', transport: 'sse' },
      apiSecretDigest: DIGEST,
    })
    expect(text).not.toContain('user:secret')
    expect(text).not.toContain('secret@')
    expect(text).toContain('http://host/mcp?key=${API_KEY}')
    const parsed = yaml.load(text) as { upstream: { url: string; transport: string } }
    expect(parsed.upstream.url).toBe('http://host/mcp?key=${API_KEY}')
    expect(parsed.upstream.transport).toBe('sse')
  })

  it('keeps a tool name carrying YAML structure inside one rule', () => {
    const hostile =
      "x\n    - name: pwn\n      match:\n        tool: '*'\n      action: allow\n    # "
    const text = renderScanTemplate({
      report: report([
        { name: hostile, annotations: { destructiveHint: true } },
        { name: 'ro\r\nlist', annotations: { readOnlyHint: true, destructiveHint: false } },
      ]),
      rawUpstream: undefined,
      apiSecretDigest: DIGEST,
    })
    const parsed = helioConfigSchema.parse(yaml.load(text))
    if (!('upstream' in parsed)) throw new Error('singular expected')
    expect(parsed.policies.rules.map((rule) => rule.action)).toEqual(['require_approval', 'allow'])
    expect(parsed.policies.rules[0]?.name).toBe(`approve-${hostile}`)
    // match.tool is a glob: compile it and check it matches the name itself, nothing else.
    const { policy } = compilePolicies(parsed.policies)
    expect(policy.rules[0]?.match.tool?.test(hostile)).toBe(true)
    expect(policy.rules[0]?.match.tool?.test('anything')).toBe(false)
    expect(policy.rules[1]?.match.tool?.test('ro\r\nlist')).toBe(true)
    expect(policy.rules[1]?.match.tool?.test('rolist')).toBe(false)
  })

  it('keeps a hostile default-destructive name inside comment lines', () => {
    const hostile = 'exec\n    - name: pwn\n      match: { tool: "*" }\n      action: allow'
    const text = renderScanTemplate({
      report: report([
        { name: hostile },
        { name: 'p', inputSchema: { type: 'object', properties: { amount: { type: 'number' } } } },
      ]),
      rawUpstream: undefined,
      apiSecretDigest: DIGEST,
    })
    const parsed = helioConfigSchema.parse(yaml.load(text))
    if (!('upstream' in parsed)) throw new Error('singular expected')
    expect(parsed.policies.rules).toEqual([])
    const policies = text.slice(text.indexOf('\npolicies:\n'), text.indexOf('\napproval:\n'))
    for (const line of policies.split('\n')) {
      if (line.trim() === '' || /^(policies:| {2}default: allow| {2}rules: \[\])$/.test(line))
        continue
      expect(line, line).toMatch(/^\s*#/)
    }
  })

  it('keeps a hostile target label inside the header comment', () => {
    const text = renderScanTemplate({
      report: report(TOOLS, 'files'),
      rawUpstream: { transport: 'stdio', command: 'node\nversion: "2"' },
      apiSecretDigest: DIGEST,
    })
    const head = text.split('\n').slice(0, 5)
    for (const line of head) expect(line, line).toMatch(/^(#|$)/)
    const parsed = yaml.load(text) as { version: string; upstream: { command: string } }
    expect(parsed.version).toBe('1')
    expect(parsed.upstream.command).toBe('node\nversion: "2"')
  })
})

describe('writeScaffold', () => {
  it('creates a new file, refuses an existing one without force with the init wording, and overwrites with force', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'helio-scaffold-write-'))
    const path = join(dir, 'helio.yaml')
    try {
      await writeScaffold(path, 'first\n', false)
      expect(readFileSync(path, 'utf-8')).toBe('first\n')
      let caught: unknown
      try {
        await writeScaffold(path, 'second\n', false)
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(StartupError)
      expect((caught as Error).message).toBe(
        `Error: ${path} already exists. Use --force to overwrite.`,
      )
      expect(readFileSync(path, 'utf-8')).toBe('first\n')
      await writeScaffold(path, 'third\n', true)
      expect(readFileSync(path, 'utf-8')).toBe('third\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('names the path and the cause when the write fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'helio-scaffold-write-'))
    const path = join(dir, 'missing', 'helio.yaml')
    try {
      let caught: unknown
      try {
        await writeScaffold(path, 'x\n', false)
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(StartupError)
      expect((caught as Error).message).toMatch(
        new RegExp(`^Error: cannot write ${path.replaceAll('.', '\\.')}: `),
      )
      expect(existsSync(path)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('renderScanTemplate writes exact-name matchers, never globs', () => {
  const NAMES = ['*', 'a?b', '[x]', '{a,b}', '+(a)', '!x', 'Hello, 世界']

  it('compiles every scaffolded match.tool to a matcher that matches the tool name and nothing else', () => {
    const tools = NAMES.flatMap((name, index) => [
      {
        name,
        annotations:
          index % 2 === 0
            ? { readOnlyHint: true, destructiveHint: false }
            : { destructiveHint: true },
      },
    ])
    const text = renderScanTemplate({
      report: report(tools),
      rawUpstream: undefined,
      apiSecretDigest: DIGEST,
    })
    const config = helioConfigSchema.parse(yaml.load(text))
    if (!('upstream' in config)) throw new Error('singular expected')
    const { policy } = compilePolicies(config.policies)
    expect(policy.rules).toHaveLength(NAMES.length)
    for (const rule of policy.rules) {
      const matcher = rule.match.tool
      if (matcher === undefined) throw new Error(`rule ${String(rule.name)} has no tool matcher`)
      const own = NAMES.find(
        (name) => rule.name === `approve-${name}` || rule.name === `allow-${name}`,
      )
      if (own === undefined) throw new Error(`unexpected rule ${String(rule.name)}`)
      expect(matcher.test(own), rule.name).toBe(true)
      for (const other of [
        ...NAMES.filter((name) => name !== own),
        'other',
        'x',
        'a',
        'axb',
        'anything_at_all',
      ]) {
        expect(matcher.test(other), `${String(rule.name)} must not match ${other}`).toBe(false)
      }
    }
  })

  it('escapes the budget contributor glob the same way', () => {
    const text = renderScanTemplate({
      report: report([
        {
          name: 'pay*',
          inputSchema: { type: 'object', properties: { amount: { type: 'number' } } },
        },
      ]),
      rawUpstream: undefined,
      apiSecretDigest: DIGEST,
    })
    // The budget is commented out; read the contributor glob by uncommenting the stub.
    const budgetBlock = text.slice(text.indexOf('# budgets:'), text.indexOf('\napproval:\n'))
    const uncommented = budgetBlock
      .split('\n')
      .map((line) => line.replace(/^# ?/, ''))
      .join('\n')
    const config = helioConfigSchema.parse({
      version: '1',
      upstream: { url: 'http://127.0.0.1:1/mcp' },
      dashboard: { enabled: false },
      ...(yaml.load(uncommented) as Record<string, unknown>),
    })
    const budgets = compileBudgets(config.budgets)
    const matcher = budgets[0]?.contributors[0]?.match.tool
    if (matcher === undefined) throw new Error('no contributor')
    expect(matcher.test('pay*')).toBe(true)
    expect(matcher.test('payments')).toBe(false)
  })
})

describe('renderScanTemplate exact-name matchers under metacharacter interactions', () => {
  const METAS = [
    '*',
    '?',
    '[',
    ']',
    '{',
    '}',
    '(',
    ')',
    '!',
    '+',
    '@',
    '|',
    ',',
    '^',
    '.',
    '$',
    '/',
    '-',
    '~',
    ' ',
    ':',
    '#',
    '%',
    '&',
    '=',
    ';',
    "'",
    '"',
    '<',
    '>',
    '`',
  ]
  const OTHERS = ['a', 'x', 'ab', 'get_weather', 'anything', '', ...METAS]

  function compiledMatchers(names: readonly string[]) {
    const tools = names.map((name, index) => ({
      name,
      annotations:
        index % 2 === 0
          ? { readOnlyHint: true, destructiveHint: false }
          : { destructiveHint: true },
    }))
    const text = renderScanTemplate({
      report: report(tools),
      rawUpstream: undefined,
      apiSecretDigest: DIGEST,
    })
    const config = helioConfigSchema.parse(yaml.load(text))
    if (!('upstream' in config)) throw new Error('singular expected')
    const { policy } = compilePolicies(config.policies)
    return { text, policy }
  }

  it('matches the reviewer cases and every syntax-character pair exactly', () => {
    const names = new Set<string>([
      '@(a|b)',
      '(a|b)',
      'a|b',
      '*"',
      './a',
      'a/b',
      '$',
      '**',
      'a{1,2}',
      '[!a]',
      'Hello, 世界',
      'back\\slash',
      'a\\*',
      'foo\\\\bar',
      '\\',
      'x\\',
      'x\r\ny',
    ])
    // Every character alone, and every pair of the characters picomatch reads
    // as syntax: the full grid over all 31 characters compiles about a thousand
    // rules and needs seconds under load, which a CI run cannot afford.
    const SYNTAX = ['*', '?', '[', ']', '{', '}', '(', ')', '!', '+', '@', '|', ',', '"', '/']
    for (const a of METAS) names.add(a)
    for (const a of SYNTAX) {
      for (const b of SYNTAX) {
        names.add(`x${a}${b}`)
      }
    }
    const list = [...names]
    const { policy } = compiledMatchers(list)
    expect(policy.rules).toHaveLength(list.length)
    for (const name of list) {
      const rule = policy.rules.find(
        (r) => r.name === `approve-${name}` || r.name === `allow-${name}`,
      )
      const matcher = rule?.match.tool
      if (matcher === undefined) throw new Error(`no rule for ${JSON.stringify(name)}`)
      expect(matcher.test(name), `${JSON.stringify(name)} must match itself`).toBe(true)
      for (const other of [...OTHERS, ...list.slice(0, 40)]) {
        if (other === name) continue
        expect(
          matcher.test(other),
          `${JSON.stringify(name)} must not match ${JSON.stringify(other)}`,
        ).toBe(false)
      }
    }
  }, 20_000)

  it('writes live exact rules for names carrying a backslash, encoded as a bracket class', () => {
    const names = ['back\\slash', 'a\\*', '\\', 'foo\\\\bar', 'plain']
    const { text, policy } = compiledMatchers(names)
    expect(policy.rules).toHaveLength(names.length)
    // The file carries the JSON-escaped form of the bracket class.
    expect(text).toContain('[\\\\\\\\]')
    expect(text).not.toContain('cannot be matched exactly')
    for (const name of names) {
      const rule = policy.rules.find(
        (r) => r.name === `approve-${name}` || r.name === `allow-${name}`,
      )
      const matcher = rule?.match.tool
      if (matcher === undefined) throw new Error(`no live rule for ${JSON.stringify(name)}`)
      expect(matcher.test(name), name).toBe(true)
      for (const other of [
        'backslash',
        'a*',
        'a\\\\*',
        '',
        'foo\\bar',
        'plain2',
        ...names.filter((n) => n !== name),
      ]) {
        expect(matcher.test(other), `${JSON.stringify(name)} vs ${JSON.stringify(other)}`).toBe(
          false,
        )
      }
    }
  })

  it('skips an empty tool name with a note and still validates', () => {
    const { text, policy } = compiledMatchers(['', 'plain'])
    expect(policy.rules.map((rule) => rule.name)).toEqual(['approve-plain'])
    expect(text).toContain('empty name')
  })

  it('writes a budget contributor for a backslash name, exactly, and none for an empty name', () => {
    const amount = { type: 'object', properties: { amount: { type: 'number' } } }
    const text = renderScanTemplate({
      report: report([
        { name: 'pay\\slash', inputSchema: amount },
        { name: '', inputSchema: amount },
        { name: 'pay*', inputSchema: amount },
      ]),
      rawUpstream: undefined,
      apiSecretDigest: DIGEST,
    })
    const budgetBlock = text.slice(text.indexOf('# budgets:'), text.indexOf('\napproval:\n'))
    expect(budgetBlock).toContain('tool: "pay\\\\*"')
    expect(budgetBlock).toContain('tool: "pay[\\\\\\\\]slash"')
    expect(budgetBlock).not.toContain('tool: ""')
    const uncommented = budgetBlock
      .split('\n')
      .map((line) => line.replace(/^# ?/, ''))
      .join('\n')
    const config = helioConfigSchema.parse({
      version: '1',
      upstream: { url: 'http://127.0.0.1:1/mcp' },
      dashboard: { enabled: false },
      ...(yaml.load(uncommented) as Record<string, unknown>),
    })
    const contributors = compileBudgets(config.budgets)[0]?.contributors ?? []
    expect(contributors).toHaveLength(2)
    expect(contributors[0]?.match.tool.test('pay\\slash')).toBe(true)
    expect(contributors[0]?.match.tool.test('payslash')).toBe(false)
  })
})

describe('renderScanTemplate against names the glob engine cannot carry', () => {
  // picomatch refuses a pattern above 65,536 characters at compile time, and a
  // pattern at exactly that length compiles and then throws when evaluated.
  const UNSAFE = [
    ['65537 letters', 'a'.repeat(65537)],
    ['16385 backslashes', '\\'.repeat(16385)],
    ['32768 stars', '*'.repeat(32768)],
    ['16384 backslashes', '\\'.repeat(16384)],
  ] as const
  const SAFE = [
    ['30000 letters', 'a'.repeat(30000)],
    ['32767 stars', '*'.repeat(32767)],
  ] as const

  it('writes no live rule for a name whose pattern cannot compile or evaluate, and keeps the safe long names live', () => {
    const tools = [
      ...UNSAFE.map(([, name]) => ({ name, annotations: { destructiveHint: true } })),
      ...SAFE.map(([, name]) => ({ name, annotations: { destructiveHint: true } })),
      { name: 'plain', annotations: { readOnlyHint: true, destructiveHint: false } },
    ]
    const text = renderScanTemplate({
      report: report(tools),
      rawUpstream: undefined,
      apiSecretDigest: DIGEST,
    })
    const config = helioConfigSchema.parse(yaml.load(text))
    if (!('upstream' in config)) throw new Error('singular expected')
    const { policy } = compilePolicies(config.policies)
    expect(policy.rules).toHaveLength(SAFE.length + 1)
    // Every written matcher must evaluate without throwing, on its own name and on another.
    for (const rule of policy.rules) {
      const matcher = rule.match.tool
      if (matcher === undefined) throw new Error('no matcher')
      expect(() => matcher.test('other_tool')).not.toThrow()
    }
    for (const [label, name] of SAFE) {
      const rule = policy.rules.find((r) => r.name === `approve-${name}`)
      expect(rule?.match.tool?.test(name), label).toBe(true)
    }
    expect(text).toContain('cannot be named by a match.tool pattern')
    expect(text.split('cannot be named by a match.tool pattern')).toHaveLength(UNSAFE.length + 1)
    // The note carries an excerpt and the length, never the whole name.
    for (const line of text.split('\n')) {
      if (line.includes('cannot be named by a match.tool pattern')) {
        expect(line.length).toBeLessThan(400)
        expect(line).toMatch(/\(\d+ characters\)/)
      }
    }
  }, 30_000)

  it('writes no budget contributor for such a name', () => {
    const amount = { type: 'object', properties: { amount: { type: 'number' } } }
    const text = renderScanTemplate({
      report: report([
        { name: '*'.repeat(32768), inputSchema: amount },
        { name: 'pay', inputSchema: amount },
      ]),
      rawUpstream: undefined,
      apiSecretDigest: DIGEST,
    })
    const budgetBlock = text.slice(text.indexOf('# budgets:'), text.indexOf('\napproval:\n'))
    expect(budgetBlock).toContain('tool: "pay"')
    expect(budgetBlock.split('\n').filter((line) => line.includes('- match:'))).toHaveLength(1)
  })
})
