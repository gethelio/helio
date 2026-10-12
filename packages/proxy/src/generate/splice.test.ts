import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import yaml from 'js-yaml'
import { appendRules, locateRootSection, verifySplice } from './splice.js'
import type { SpliceRefusal } from './splice.js'
import { allowRule } from '../policy/rule-text.js'
import { parseConfigSource } from '../config/loader.js'
import { DEMO_DEFAULT_PORTS, renderDemoConfig } from '../demo/config.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ROOT = join(import.meta.dirname, '../../../..')

const SHIPPED = [
  'examples/agent-budget/helio.yaml',
  'examples/basic/helio.yaml',
  'examples/budgets/helio.yaml',
  'examples/multi-upstream/helio.yaml',
  'examples/slack-approvals/helio.yaml',
  'examples/spend-limits/helio.yaml',
  'docker/helio.docker.yaml',
] as const

/** Every placeholder the shipped files name, set so the parse check can interpolate them. */
const ENV = {
  HELIO_DASHBOARD_SECRET: `sha256:${'ab'.repeat(32)}`,
  HELIO_SLACK_BOT_TOKEN: 'xoxb-test-token',
  HELIO_SLACK_SIGNING_SECRET: 'test-signing-secret',
  HELIO_SLACK_CHANNEL: '#approvals',
}

const RULE = allowRule('read_file', '')
const RULE_WITH_COMMENT = `# generated: confident read, name, hint and description agree; observed 3 times\n${RULE}`

function text(result: ReturnType<typeof appendRules>): string {
  if ('refused' in result) throw new Error(`refused: ${result.refused}`)
  return result.text
}

function refusal(result: ReturnType<typeof appendRules>): SpliceRefusal {
  if ('text' in result) throw new Error('accepted')
  return result.refused
}

function parse(raw: string, env: Record<string, string> = ENV) {
  const sha256 = createHash('sha256').update(raw).digest('hex')
  return parseConfigSource({ raw, sha256 }, 'x.yaml', env).config
}

/** The source and the candidate agree on every section but policies.rules, which grew by the rule. */
function expectAppended(source: string, candidate: string, appended = 1): void {
  const a = parse(source)
  const b = parse(candidate)
  const { policies: pa, ...restA } = a
  const { policies: pb, ...restB } = b
  expect(restB).toEqual(restA)
  const { rules: rulesA, ...policiesA } = pa
  const { rules: rulesB, ...policiesB } = pb
  expect(policiesB).toEqual(policiesA)
  expect(rulesB).toHaveLength(rulesA.length + appended)
  expect(rulesB.slice(0, rulesA.length)).toEqual(rulesA)
  const last = rulesB[rulesB.length - 1]
  expect(last?.name).toBe('allow-read_file')
  expect(last?.action).toBe('allow')
  expect(last?.match.tool).toBe('read_file')
}

const BARE_HEAD =
  "version: '1'\nupstream:\n  url: 'http://localhost:8080/mcp'\n  transport: streamable-http\n"
/** The schema wants a secret or an explicit choice for the dashboard, which defaults to enabled. */
const MINIMAL_HEAD = `${BARE_HEAD}dashboard:\n  enabled: false\n`

// ---------------------------------------------------------------------------
// The shipped configurations
// ---------------------------------------------------------------------------

describe('appendRules over the shipped configurations', () => {
  const files = [
    ...SHIPPED.map((file) => [file, readFileSync(join(ROOT, file), 'utf-8')] as const),
    ['helio-demo.yaml (renderDemoConfig)', renderDemoConfig(DEMO_DEFAULT_PORTS)] as const,
  ]

  for (const [label, source] of files) {
    it(`appends one rule to ${label} and copies every other byte`, () => {
      const candidate = text(appendRules(source, RULE))
      const span = locateRootSection(source, 'policies')
      if (span === null) throw new Error('no policies span')
      expect(candidate.slice(0, span.start)).toBe(source.slice(0, span.start))
      const tail = source.slice(span.end)
      expect(candidate.endsWith(tail)).toBe(true)
      expect(candidate.length - tail.length).toBeGreaterThan(span.end)
      expectAppended(source, candidate)
      const placeholders = source.match(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g) ?? []
      expect(candidate.match(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g) ?? []).toEqual(placeholders)
      expect(candidate).not.toContain(ENV.HELIO_DASHBOARD_SECRET)
      expect(candidate).not.toContain('xoxb-test-token')
    })
  }

  it('keeps every comment of the spend-limits example, between and after its rules', () => {
    const source = readFileSync(join(ROOT, 'examples/spend-limits/helio.yaml'), 'utf-8')
    const candidate = text(appendRules(source, RULE))
    const comments = (s: string) => s.split('\n').filter((line) => line.trimStart().startsWith('#'))
    expect(comments(candidate)).toEqual(comments(source))
    // The rule lands after allow-reads, before the blank line that precedes approval:.
    expect(candidate).toContain(
      '    - name: allow-reads\n' +
        '      match:\n' +
        '        annotations:\n' +
        '          readOnlyHint: true\n' +
        '      action: allow\n' +
        '    - name: "allow-read_file"\n' +
        '      match:\n' +
        '        tool: "read_file"\n' +
        '      action: allow\n' +
        '\n' +
        'approval:\n',
    )
  })

  it('indents a comment line of the fragment with the items', () => {
    const source = readFileSync(join(ROOT, 'examples/basic/helio.yaml'), 'utf-8')
    const candidate = text(appendRules(source, RULE_WITH_COMMENT))
    expect(candidate).toContain(
      '      action: allow\n' +
        '    # generated: confident read, name, hint and description agree; observed 3 times\n' +
        '    - name: "allow-read_file"\n',
    )
    expectAppended(source, candidate)
  })
})

// ---------------------------------------------------------------------------
// Shapes of the policies section
// ---------------------------------------------------------------------------

describe('appendRules over the shapes a hand-written file takes', () => {
  it('appends when policies: is the first key in the file', () => {
    const source = `policies:\n  default: deny\n  rules:\n    - name: a\n      match:\n        tool: x\n      action: allow\n${MINIMAL_HEAD}`
    const candidate = text(appendRules(source, RULE))
    expect(candidate).toBe(
      `policies:\n  default: deny\n  rules:\n    - name: a\n      match:\n        tool: x\n      action: allow\n${RULE.replace(/^(.)/gm, '    $1')}${MINIMAL_HEAD}`,
    )
    expectAppended(source, candidate)
  })

  it('appends when policies: is the last key in the file, with and without a trailing newline', () => {
    const withNewline = `${MINIMAL_HEAD}policies:\n  rules:\n    - name: a\n      match:\n        tool: x\n      action: allow\n`
    const expected = `${withNewline}${RULE.replace(/^(.)/gm, '    $1')}`
    expect(text(appendRules(withNewline, RULE))).toBe(expected)
    const without = withNewline.slice(0, -1)
    expect(text(appendRules(without, RULE))).toBe(expected.slice(0, -1))
    expectAppended(without, text(appendRules(without, RULE)))
  })

  it('inserts a policies: block ahead of the first later section when the file has none', () => {
    const source = `${BARE_HEAD}\n# The approval channel.\napproval:\n  timeout: 300s\n  channels:\n    - type: dashboard\naudit:\n  path: ./a.db\ndashboard:\n  enabled: false\n`
    const candidate = text(appendRules(source, RULE))
    expect(candidate).toBe(
      `${BARE_HEAD}\npolicies:\n  rules:\n${RULE.replace(/^(.)/gm, '    $1')}\n# The approval channel.\napproval:\n  timeout: 300s\n  channels:\n    - type: dashboard\naudit:\n  path: ./a.db\ndashboard:\n  enabled: false\n`,
    )
    expectAppended(source, candidate)
    expect(candidate).not.toContain('default:')
  })

  it('appends a policies: block at the end when the file has none and no later section', () => {
    const source = `${BARE_HEAD}listen:\n  port: 3000\n`
    const candidate = text(appendRules(source, RULE))
    expect(candidate).toBe(`${source}\npolicies:\n  rules:\n${RULE.replace(/^(.)/gm, '    $1')}`)
    const loaded = yaml.load(candidate) as { policies: { rules: unknown[] } }
    expect(Object.keys(loaded)).toEqual(['version', 'upstream', 'listen', 'policies'])
    expect(loaded.policies.rules).toHaveLength(1)
  })

  it('keeps the comment block that separates policies: from its neighbors with the neighbor', () => {
    const source = `${MINIMAL_HEAD}\n# Policy.\npolicies:\n  default: allow\n  rules:\n    - name: a\n      match:\n        tool: x\n      action: allow\n\n# Approval follows.\n# Two lines of it.\napproval:\n  timeout: 300s\n`
    const candidate = text(appendRules(source, RULE))
    expect(candidate).toContain(
      `      action: allow\n${RULE.replace(/^(.)/gm, '    $1')}\n# Approval follows.\n# Two lines of it.\napproval:\n`,
    )
    expectAppended(source, candidate)
  })

  it('replaces an empty flow list rules: [] with a block sequence, keeping a trailing comment', () => {
    const source = `${MINIMAL_HEAD}policies:\n  default: allow\n  rules: [] # none yet\n`
    const candidate = text(appendRules(source, RULE))
    expect(candidate).toBe(
      `${MINIMAL_HEAD}policies:\n  default: allow\n  rules: # none yet\n${RULE.replace(/^(.)/gm, '    $1')}`,
    )
    expectAppended(source, candidate)
  })

  it('adds rules: at the child indentation when policies: has none', () => {
    const source = `${MINIMAL_HEAD}policies:\n    default: allow\n    flag_destructive: log\n\napproval:\n  timeout: 300s\n`
    const candidate = text(appendRules(source, RULE))
    expect(candidate).toBe(
      `${MINIMAL_HEAD}policies:\n    default: allow\n    flag_destructive: log\n    rules:\n${RULE.replace(/^(.)/gm, '      $1')}\napproval:\n  timeout: 300s\n`,
    )
    expectAppended(source, candidate)
  })

  it('appends the items when rules: has no items yet (a null list the schema itself refuses)', () => {
    const source = `${MINIMAL_HEAD}policies:\n  rules:\n  default: allow\n`
    expect(() => parse(source)).toThrow('Invalid configuration')
    const candidate = text(appendRules(source, RULE))
    expect(candidate).toBe(
      `${MINIMAL_HEAD}policies:\n  rules:\n${RULE.replace(/^(.)/gm, '    $1')}  default: allow\n`,
    )
    const parsed = parse(candidate)
    expect(parsed.policies.default).toBe('allow')
    expect(parsed.policies.rules.map((rule) => rule.name)).toEqual(['allow-read_file'])
  })

  it('stops the sequence at a sibling key after rules: such as hot_reload:', () => {
    const source = `${MINIMAL_HEAD}policies:\n  rules:\n    - name: a\n      match:\n        tool: x\n      action: allow\n  hot_reload: false\n  default: allow\n`
    const candidate = text(appendRules(source, RULE))
    expect(candidate).toBe(
      `${MINIMAL_HEAD}policies:\n  rules:\n    - name: a\n      match:\n        tool: x\n      action: allow\n${RULE.replace(/^(.)/gm, '    $1')}  hot_reload: false\n  default: allow\n`,
    )
    expectAppended(source, candidate)
  })

  it('accepts items at the same indentation as rules:', () => {
    const source = `${MINIMAL_HEAD}policies:\n  default: allow\n  rules:\n  - name: a\n    match:\n      tool: x\n    action: allow\n`
    const candidate = text(appendRules(source, RULE))
    expect(candidate).toBe(`${source}${RULE.replace(/^(.)/gm, '  $1')}`)
    expectAppended(source, candidate)
  })

  it('appends after a last rule whose feedback.message is a block scalar', () => {
    const source = `${MINIMAL_HEAD}policies:\n  rules:\n    - name: a\n      match:\n        tool: x\n      action: deny\n      feedback:\n        message: |\n          Blocked.\n          Ask #sec.\n\napproval:\n  timeout: 300s\n`
    const candidate = text(appendRules(source, RULE))
    expect(candidate).toBe(
      `${MINIMAL_HEAD}policies:\n  rules:\n    - name: a\n      match:\n        tool: x\n      action: deny\n      feedback:\n        message: |\n          Blocked.\n          Ask #sec.\n${RULE.replace(/^(.)/gm, '    $1')}\napproval:\n  timeout: 300s\n`,
    )
    expectAppended(source, candidate)
    expect(parse(candidate).policies.rules[0]?.feedback?.message).toBe('Blocked.\nAsk #sec.\n')
  })

  it('appends after a block scalar with an indentation indicator whose blank line is content', () => {
    const source = `${MINIMAL_HEAD}policies:\n  rules:\n    - name: a\n      match:\n        tool: x\n      action: deny\n      feedback:\n        message: |2\n          hello\n\n          world\n      requires_success: true\n`
    const candidate = text(appendRules(source, RULE))
    expect(candidate).toBe(`${source}${RULE.replace(/^(.)/gm, '    $1')}`)
    expectAppended(source, candidate)
    const first = parse(candidate).policies.rules[0]
    expect(first?.feedback?.message).toBe('hello\n\nworld\n')
    expect(first?.action).toBe('deny')
  })

  it('accepts a comment line between rules: and its first item, and a # inside a quoted scalar', () => {
    const source = `${MINIMAL_HEAD}policies:\n  rules:\n    # the first rule\n    - name: 'a # not a comment'\n      match:\n        tool: "x#y"\n      action: allow\n`
    const candidate = text(appendRules(source, RULE))
    expect(candidate).toBe(`${source}${RULE.replace(/^(.)/gm, '    $1')}`)
    expectAppended(source, candidate)
    expect(parse(candidate).policies.rules[0]?.name).toBe('a # not a comment')
  })

  it('accepts a %YAML directive and a document start marker before the first key', () => {
    const source = `%YAML 1.2\n---\n${MINIMAL_HEAD}policies:\n  rules:\n    - name: a\n      match:\n        tool: x\n      action: allow\n`
    const candidate = text(appendRules(source, RULE))
    expect(candidate).toBe(`${source}${RULE.replace(/^(.)/gm, '    $1')}`)
    expectAppended(source, candidate)
  })

  it('keeps CRLF line endings and a UTF-8 BOM', () => {
    const source =
      `\uFEFF${MINIMAL_HEAD}policies:\n  rules:\n    - name: a\n      match:\n        tool: x\n      action: allow\napproval:\n  timeout: 300s\n`.replaceAll(
        '\n',
        '\r\n',
      )
    const candidate = text(appendRules(source, RULE))
    expect(candidate.startsWith('\uFEFF')).toBe(true)
    expect(candidate.split('\r\n').length).toBe(source.split('\r\n').length + 4)
    expect(candidate).not.toMatch(/[^\r]\n/)
    expect(candidate).toContain('      action: allow\r\n    - name: "allow-read_file"\r\n')
    expectAppended(source.replace('\uFEFF', ''), candidate.replace('\uFEFF', ''))
  })

  it('leaves an x- root key holding an anchor that policies: aliases alone', () => {
    const source = `${MINIMAL_HEAD}x-shared: &fb\n  message: 'Blocked.'\npolicies:\n  rules:\n    - name: a\n      match:\n        tool: x\n      action: deny\n      feedback: *fb\n`
    const candidate = text(appendRules(source, RULE))
    expect(candidate).toBe(`${source}${RULE.replace(/^(.)/gm, '    $1')}`)
    expectAppended(source, candidate)
    expect(parse(candidate).policies.rules[0]?.feedback?.message).toBe('Blocked.')
  })
})

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

describe('appendRules refusals', () => {
  it.each([
    ['a tab before the colon', 'policies\t:'],
    ['a quoted key', '"policies":'],
    ['a space before the colon', 'policies :'],
  ])('refuses %s as policies_key_unlocatable and writes no second block', (_label, key) => {
    const source = `${MINIMAL_HEAD}${key}\n  rules:\n    - name: a\n      match:\n        tool: x\n      action: allow\n`
    expect((yaml.load(source) as Record<string, unknown>)['policies']).toBeDefined()
    expect(refusal(appendRules(source, RULE))).toBe('policies_key_unlocatable')
  })

  it('refuses a file with lone carriage returns as its line endings', () => {
    const source = `${MINIMAL_HEAD}policies:\n  rules: []\n`.replaceAll('\n', '\r')
    expect(refusal(appendRules(source, RULE))).toBe('line_endings_unsupported')
  })

  it('refuses a non-empty flow sequence, an alias and an anchor on rules:', () => {
    const items = '[{ name: a, match: { tool: x }, action: allow }]'
    expect(refusal(appendRules(`${MINIMAL_HEAD}policies:\n  rules: ${items}\n`, RULE))).toBe(
      'rules_not_block_sequence',
    )
    expect(
      refusal(
        appendRules(
          `${MINIMAL_HEAD}x-r: &shared\n  - name: a\n    match:\n      tool: x\n    action: allow\npolicies:\n  rules: *shared\n`,
          RULE,
        ),
      ),
    ).toBe('rules_not_block_sequence')
    expect(
      refusal(
        appendRules(
          `${MINIMAL_HEAD}policies:\n  rules: &r\n    - name: a\n      match:\n        tool: x\n      action: allow\n`,
          RULE,
        ),
      ),
    ).toBe('rules_not_block_sequence')
  })

  it('refuses a merge key inside the policies: span', () => {
    const source = `${MINIMAL_HEAD}x-base: &base\n  default: allow\npolicies:\n  <<: *base\n  rules:\n    - name: a\n      match:\n        tool: x\n      action: allow\n`
    expect(refusal(appendRules(source, RULE))).toBe('merge_key_in_policies')
  })

  it('refuses an anchor defined inside policies: that a later section aliases', () => {
    const source = `${MINIMAL_HEAD}policies:\n  rules:\n    - name: a\n      match: &m\n        tool: x\n      action: allow\nbudgets:\n  - name: b\n    limit: 1\n    currency: USD\n    window: 1h\n    contributors:\n      - match: *m\n        field: '$.amount'\n`
    expect(refusal(appendRules(source, RULE))).toBe('anchor_used_outside_policies')
  })

  it('refuses a second document', () => {
    const source = `${MINIMAL_HEAD}policies:\n  rules: []\n---\nversion: '1'\n`
    expect(refusal(appendRules(source, RULE))).toBe('multiple_documents')
  })

  it('refuses a policies value that is not a block mapping', () => {
    expect(
      refusal(appendRules(`${MINIMAL_HEAD}policies: { default: allow, rules: [] }\n`, RULE)),
    ).toBe('policies_not_block_mapping')
    expect(refusal(appendRules(`${MINIMAL_HEAD}policies:\n`, RULE))).toBe(
      'policies_not_block_mapping',
    )
  })

  it('refuses a file js-yaml cannot load and a root that is not a mapping', () => {
    expect(refusal(appendRules(`${MINIMAL_HEAD}policies:\n  rules: [\n`, RULE))).toBe(
      'yaml_unparsable',
    )
    expect(refusal(appendRules('- a\n- b\n', RULE))).toBe('root_not_mapping')
  })
})

// ---------------------------------------------------------------------------
// The self-check
// ---------------------------------------------------------------------------

describe('verifySplice', () => {
  const fragment = RULE
  const items = yaml.load(fragment)

  it('accepts the source rules followed by exactly the appended items', () => {
    const source = `${MINIMAL_HEAD}policies:\n  default: allow\n  rules:\n    - name: a\n      match:\n        tool: x\n      action: allow\n`
    const candidate = `${source}${RULE.replace(/^(.)/gm, '    $1')}`
    expect(verifySplice(source, candidate, fragment)).toBe(true)
    expect(items).toHaveLength(1)
  })

  it('reads a missing policies as {} and a missing rules as [] on the unvalidated parse', () => {
    const noPolicies = MINIMAL_HEAD
    const added = `${MINIMAL_HEAD}policies:\n  rules:\n${RULE.replace(/^(.)/gm, '    $1')}`
    expect(verifySplice(noPolicies, added, fragment)).toBe(true)
    const noRules = `${MINIMAL_HEAD}policies:\n  default: deny\n`
    const addedRules = `${noRules}  rules:\n${RULE.replace(/^(.)/gm, '    $1')}`
    expect(verifySplice(noRules, addedRules, fragment)).toBe(true)
  })

  it('rejects a changed root key order, a changed sibling value, a changed policies key and a different list', () => {
    const source = `${MINIMAL_HEAD}policies:\n  default: allow\n  rules:\n    - name: a\n      match:\n        tool: x\n      action: allow\napproval:\n  timeout: 300s\n`
    const good = `${MINIMAL_HEAD}policies:\n  default: allow\n  rules:\n    - name: a\n      match:\n        tool: x\n      action: allow\n${RULE.replace(/^(.)/gm, '    $1')}approval:\n  timeout: 300s\n`
    expect(verifySplice(source, good, fragment)).toBe(true)
    expect(verifySplice(source, good.replace('timeout: 300s', 'timeout: 30s'), fragment)).toBe(
      false,
    )
    expect(verifySplice(source, good.replace('default: allow', 'default: deny'), fragment)).toBe(
      false,
    )
    expect(verifySplice(source, good.replace('tool: "read_file"', 'tool: "other"'), fragment)).toBe(
      false,
    )
    expect(verifySplice(source, `${good}${RULE.replace(/^(.)/gm, '    $1')}`, fragment)).toBe(false)
    const reordered = `approval:\n  timeout: 300s\n${MINIMAL_HEAD}policies:\n  default: allow\n  rules:\n    - name: a\n      match:\n        tool: x\n      action: allow\n${RULE.replace(/^(.)/gm, '    $1')}`
    expect(verifySplice(source, reordered, fragment)).toBe(false)
    expect(verifySplice(source, `${good}oops: [\n`, fragment)).toBe(false)
  })

  it('compares an uninterpolated placeholder as the literal it is', () => {
    const source = `${BARE_HEAD}policies:\n  rules: []\ndashboard:\n  api_secret: '\${HELIO_DASHBOARD_SECRET}'\n`
    const candidate = text(appendRules(source, RULE))
    expect(candidate).toContain("api_secret: '${HELIO_DASHBOARD_SECRET}'")
    expect(verifySplice(source, candidate, fragment)).toBe(true)
  })
})
