import { describe, it, expect } from 'vitest'
import { buildScanReport, emptyAllowPolicy, renderScanText } from './report.js'
import type { ScanReportInput } from './report.js'
import { surfaceToolsFromList } from './tools.js'
import { compilePolicies } from '../policy/parser.js'
import { compileBudgets } from '../budget/parser.js'
import { helioConfigSchema } from '../config/schema.js'

// ---------------------------------------------------------------------------
// Fixtures: an echo-like surface of seven tools and a small config
// ---------------------------------------------------------------------------

const GENERATED_AT = '2026-09-29T12:50:07.000Z'

const LIST_BODY = {
  jsonrpc: '2.0',
  id: 1,
  result: {
    tools: [
      {
        name: 'get_weather',
        annotations: { readOnlyHint: true, destructiveHint: false },
        inputSchema: { type: 'object', properties: { city: { type: 'string' } } },
      },
      {
        name: 'send_email',
        annotations: { readOnlyHint: false, destructiveHint: false },
        inputSchema: { type: 'object', properties: { to: { type: 'string' } } },
      },
      {
        name: 'delete_record',
        annotations: { readOnlyHint: false, destructiveHint: true },
        inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
      },
      {
        name: 'create_payment',
        annotations: { readOnlyHint: false, destructiveHint: false },
        inputSchema: {
          type: 'object',
          properties: { amount: { type: 'number' }, callback: { type: 'string' } },
        },
      },
      {
        name: 'paypal_payout',
        inputSchema: { type: 'object', properties: { total: { type: 'number' } } },
      },
      { name: 'exec' },
      {
        name: 'transfer_funds',
        inputSchema: { type: 'object', properties: { amount: { type: 'integer' } } },
      },
    ],
  },
}

const CONFIG = helioConfigSchema.parse({
  version: '1',
  upstream: { url: 'http://127.0.0.1:1/mcp' },
  dashboard: { enabled: false },
  policies: {
    default: 'allow',
    rules: [
      { name: 'allow-reads', match: { tool: 'get_*' }, action: 'allow' },
      { name: 'block-destructive', match: { tool: 'delete_*' }, action: 'deny' },
      { name: 'gh', match: { tool: 'github_*' }, action: 'deny' },
      {
        name: 'big-transfers',
        match: { tool: 'transfer_funds', input: { '$.amount': { gt: 1000 } } },
        action: 'deny',
      },
    ],
  },
  budgets: [
    {
      name: 'pot',
      limit: 10,
      currency: 'USD',
      window: '24h',
      key: 'global',
      on_exceed: 'deny',
      contributors: [{ match: { tool: 'stripe_*' }, field: '$.amount' }],
    },
  ],
})

function input(overrides: Partial<ScanReportInput> = {}): ScanReportInput {
  const listed = surfaceToolsFromList(LIST_BODY)
  if (listed === null) throw new Error('fixture body is not a tools/list')
  return {
    target: {
      label: 'http://127.0.0.1:8080/mcp',
      transport: 'streamable-http',
      upstream: undefined,
      config: 'helio.yaml',
    },
    generatedAt: GENERATED_AT,
    policy: compilePolicies(CONFIG.policies).policy,
    policyLoaded: true,
    budgets: compileBudgets(CONFIG.budgets),
    environment: undefined,
    listed,
    unavailable: undefined,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// buildScanReport
// ---------------------------------------------------------------------------

describe('buildScanReport', () => {
  it('assembles the JSON document with the surface, the coverage, the tools, the no-match list and the summary', () => {
    const report = buildScanReport(input())
    expect(report.schema_version).toBe(1)
    expect(report.generated_at).toBe(GENERATED_AT)
    expect(report.target).toEqual({
      label: 'http://127.0.0.1:8080/mcp',
      transport: 'streamable-http',
      upstream: null,
      config: 'helio.yaml',
    })
    expect(report.policy).toEqual({
      rule_count: 4,
      default_action: 'allow',
      flag_destructive: null,
      on_tool_drift: 'block',
      dry_run: false,
    })
    expect(report.surface).not.toHaveProperty('coverage')
    expect(report.surface.pairs).toBe(7)
    expect(report.surface.annotated_destructive).toBe(1)
    expect(report.surface.default_destructive).toBe(3)
    expect(report.coverage.pairs).toHaveLength(7)
    expect(report.coverage.matched).toBe(2)
    expect(report.coverage.conditional).toBe(1)

    expect(report.tools.map((t) => t.name)).toEqual([
      'get_weather',
      'send_email',
      'delete_record',
      'create_payment',
      'paypal_payout',
      'exec',
      'transfer_funds',
    ])
    expect(report.tools[0]).toEqual({
      name: 'get_weather',
      destructive: 'no',
      hints: {
        destructiveHint: { value: false, source: 'server' },
        readOnlyHint: { value: true, source: 'server' },
      },
      candidates: [],
    })
    expect(report.tools[2]?.destructive).toBe('annotated')
    expect(report.tools[2]?.hints.destructiveHint).toEqual({ value: true, source: 'server' })
    expect(report.tools[3]?.candidates).toEqual([
      { kind: 'amount', path: '$.amount', by: 'name' },
      { kind: 'url', path: '$.callback', by: 'name' },
    ])
    expect(report.tools[5]).toEqual({
      name: 'exec',
      destructive: 'default',
      hints: {
        destructiveHint: { value: true, source: 'default' },
        readOnlyHint: { value: false, source: 'default' },
      },
      candidates: [],
    })

    expect(report.duplicates).toEqual([])
    expect(report.unmatched_rules).toEqual([
      { kind: 'rule', name: 'gh', index: 2, pattern: 'github_*', upstreams: null },
      {
        kind: 'budget_contributor',
        name: 'pot',
        index: 0,
        contributor_index: 0,
        pattern: 'stripe_*',
        upstreams: null,
      },
    ])
    expect(report.summary).toEqual({
      tools: 7,
      destructive: 4,
      destructive_by_default: 3,
      governed: 2,
      conditional: 1,
    })
    expect(report.summary.governed).toBe(report.coverage.matched)
  })

  it('carries policy: null with no config while the coverage still says default allow', () => {
    const report = buildScanReport(
      input({
        policy: emptyAllowPolicy(),
        policyLoaded: false,
        budgets: [],
        target: {
          label: 'http://127.0.0.1:8080/mcp',
          transport: 'streamable-http',
          upstream: undefined,
          config: undefined,
        },
      }),
    )
    expect(report.policy).toBeNull()
    expect(report.target.config).toBeNull()
    expect(report.coverage.default_action).toBe('allow')
    expect(report.coverage.matched).toBe(0)
    expect(report.summary.governed).toBe(0)
    expect(report.unmatched_rules).toEqual([])
  })

  it('fills surface.unavailable and empties the lists when the list failed', () => {
    const line = 'Error: cannot list tools on http://127.0.0.1:8080/mcp (ECONNREFUSED)'
    const report = buildScanReport(input({ listed: null, unavailable: line }))
    expect(report.surface.unavailable).toEqual([
      { name: 'http://127.0.0.1:8080/mcp', reason: line },
    ])
    expect(report.surface.doors[0]?.available).toBe(false)
    expect(report.tools).toEqual([])
    expect(report.unmatched_rules).toEqual([])
    expect(report.coverage.pairs).toEqual([])
    expect(report.summary).toEqual({
      tools: 0,
      destructive: 0,
      destructive_by_default: 0,
      governed: 0,
      conditional: 0,
    })
  })

  it('names the door on a named config and records the duplicates', () => {
    const body = {
      result: { tools: [{ name: 'dup', annotations: { readOnlyHint: true } }, { name: 'dup' }] },
    }
    const listed = surfaceToolsFromList(body)
    if (listed === null) throw new Error('fixture')
    const report = buildScanReport(
      input({
        listed,
        target: { label: 'http://x/crm', transport: 'sse', upstream: 'crm', config: 'cfg.yaml' },
      }),
    )
    expect(report.target.upstream).toBe('crm')
    expect(report.coverage.pairs[0]?.door).toEqual({ kind: 'upstream', name: 'crm' })
    expect(report.duplicates).toEqual([{ name: 'dup', count: 2 }])
    expect(report.tools[0]?.hints.readOnlyHint).toEqual({ value: false, source: 'default' })
  })
})

// ---------------------------------------------------------------------------
// renderScanText
// ---------------------------------------------------------------------------

describe('renderScanText', () => {
  it('prints the header, the two surface lines, the tools, the no-match section and the summary', () => {
    const text = renderScanText(buildScanReport(input()))
    expect(text.split('\n')).toEqual([
      'Scan of http://127.0.0.1:8080/mcp (streamable-http), 2026-09-29 12:50 UTC',
      'Authority surface: 7 tool-door pairs across 1 upstream, 1 annotated destructive',
      'Policy coverage: 2 of 7 have a rule that can match them, 1 covered only when arguments match, default allow (helio.yaml)',
      '',
      'Tools',
      '  get_weather     read-only (server)           not destructive (server)   allow  rule "allow-reads"',
      '  send_email      not read-only (server)       not destructive (server)   allow  no rule, default allow',
      '  delete_record   not read-only (server)       destructive (server)       deny   rule "block-destructive"',
      '  create_payment  not read-only (server)       not destructive (server)   allow  no rule, default allow  candidate: amount $.amount; url $.callback',
      '  paypal_payout   not read-only (MCP default)  destructive (MCP default)  allow  no rule, default allow  candidate: amount $.total',
      '  exec            not read-only (MCP default)  destructive (MCP default)  allow  no rule, default allow',
      '  transfer_funds  not read-only (MCP default)  destructive (MCP default)  allow  no rule, default allow; "big-transfers" only when arguments match  candidate: amount $.amount',
      '',
      'Rules that match no tool on this upstream (2)',
      '  rule "gh" (rules[2]): match.tool github_*',
      '  budget "pot" contributor 0: match.tool stripe_*',
      '  (a rule written ahead of a tool the upstream has not shipped yet is fine; this never blocks anything)',
      '',
      'Summary: 7 tools exposed, 4 destructive (3 by MCP default), 2 governed, 1 only when arguments match',
    ])
  })

  it('says how to cross-check coverage when no config was loaded and counts 0 governed', () => {
    const text = renderScanText(
      buildScanReport(
        input({
          policy: emptyAllowPolicy(),
          policyLoaded: false,
          budgets: [],
          target: {
            label: 'http://h/mcp',
            transport: 'sse',
            upstream: undefined,
            config: undefined,
          },
        }),
      ),
    )
    const lines = text.split('\n')
    expect(lines[0]).toBe('Scan of http://h/mcp (sse), 2026-09-29 12:50 UTC')
    expect(lines[2]).toBe('Policy coverage: 0 of 7 have a rule that can match them, default allow')
    expect(lines[3]).toBe('  no config loaded: pass -c helio.yaml to cross-check coverage')
    expect(text).not.toContain('Rules that match no tool')
    expect(lines.at(-1)).toBe(
      'Summary: 7 tools exposed, 4 destructive (3 by MCP default), 0 governed',
    )
  })

  it('ends on the failure line for an unavailable target and prints no surface line', () => {
    const line = 'Error: cannot list tools on http://127.0.0.1:8080/mcp (ECONNREFUSED)'
    const text = renderScanText(buildScanReport(input({ listed: null, unavailable: line })))
    expect(text.split('\n')).toEqual([
      'Scan of http://127.0.0.1:8080/mcp (streamable-http), 2026-09-29 12:50 UTC',
      line,
    ])
  })

  it('warns about a duplicated name and names a scoped or nameless unmatched rule', () => {
    const named = helioConfigSchema.parse({
      version: '1',
      upstreams: [
        { name: 'crm', url: 'http://x/crm' },
        { name: 'files', url: 'http://x/files' },
      ],
      dashboard: { enabled: false },
      policies: {
        default: 'deny',
        rules: [
          { name: 'crm-only-gets', match: { tool: 'get_*', upstreams: ['crm'] }, action: 'allow' },
          { match: { tool: 'stripe_*' }, action: 'deny' },
        ],
      },
    })
    const listed = surfaceToolsFromList({
      result: { tools: [{ name: 'dup', annotations: { readOnlyHint: true } }, { name: 'dup' }] },
    })
    if (listed === null) throw new Error('fixture')
    const text = renderScanText(
      buildScanReport(
        input({
          listed,
          policy: compilePolicies(named.policies).policy,
          budgets: [],
          target: {
            label: 'http://x/crm',
            transport: 'streamable-http',
            upstream: 'crm',
            config: 'cfg.yaml',
          },
        }),
      ),
    )
    expect(text).toContain(
      'Warning: "dup" appears 2 times in tools/list; its annotations are read as unset',
    )
    expect(text).toContain(
      '  dup  not read-only (MCP default)  destructive (MCP default)  deny  no rule, default deny',
    )
    expect(text).toContain('Rules that match no tool on this upstream (2)')
    expect(text).toContain('  rule "crm-only-gets" (rules[0], upstreams: crm): match.tool get_*')
    expect(text).toContain('  rule rules[1]: match.tool stripe_*')
    expect(text.split('\n').at(-1)).toBe(
      'Summary: 1 tool exposed, 1 destructive (1 by MCP default), 0 governed',
    )
  })
})
