import { describe, it, expect } from 'vitest'
import { compilePolicies } from './parser.js'
import { PolicyParseError } from './errors.js'
import type { PoliciesConfig } from '../config/schema.js'
import type { CompiledPolicyRule } from './types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function minimalPolicies(overrides: Partial<PoliciesConfig> = {}): PoliciesConfig {
  return {
    default: 'allow',
    dry_run: false,
    rules: [],
    ...overrides,
  }
}

/** Extract the first compiled rule, asserting it exists. */
function firstRule(config: PoliciesConfig) {
  const { policy, warnings } = compilePolicies(config)
  const rule = policy.rules[0]
  if (!rule) throw new Error('expected at least one compiled rule')
  return { rule, policy, warnings }
}

/** Extract a rule by index, asserting it exists. */
function ruleAt(rules: readonly CompiledPolicyRule[], index: number) {
  const rule = rules[index]
  if (!rule) throw new Error(`expected rule at index ${String(index)}`)
  return rule
}

// ---------------------------------------------------------------------------
// Minimal rules
// ---------------------------------------------------------------------------

describe('minimal rules', () => {
  it('compiles empty rules array', () => {
    const { policy, warnings } = compilePolicies(minimalPolicies())
    expect(policy.rules).toEqual([])
    expect(policy.defaultAction).toBe('allow')
    expect(warnings).toEqual([])
  })

  it('preserves default action "deny"', () => {
    const { policy } = compilePolicies(minimalPolicies({ default: 'deny' }))
    expect(policy.defaultAction).toBe('deny')
  })

  it('compiles a single catch-all allow rule', () => {
    const { rule, warnings } = firstRule(
      minimalPolicies({
        rules: [{ match: { tool: '*' }, action: 'allow' }],
      }),
    )
    expect(rule.action).toBe('allow')
    expect(rule.index).toBe(0)
    expect(rule.match.tool?.pattern).toBe('*')
    expect(warnings).toEqual([])
  })

  it('compiles a rule with empty match block (matches everything)', () => {
    const { rule } = firstRule(
      minimalPolicies({
        rules: [{ match: {}, action: 'allow' }],
      }),
    )
    expect(rule.match.tool).toBeUndefined()
    expect(rule.match.annotations).toBeUndefined()
    expect(rule.match.input).toBeUndefined()
    expect(rule.match.environment).toBeUndefined()
    expect(rule.action).toBe('allow')
  })
})

// ---------------------------------------------------------------------------
// Tool glob compilation
// ---------------------------------------------------------------------------

describe('tool glob compilation', () => {
  it('exact match works', () => {
    const { rule } = firstRule(
      minimalPolicies({
        rules: [{ match: { tool: 'create_payment' }, action: 'allow' }],
      }),
    )
    const matcher = rule.match.tool
    expect(matcher).toBeDefined()
    expect(matcher?.pattern).toBe('create_payment')
    expect(matcher?.test('create_payment')).toBe(true)
    expect(matcher?.test('delete_payment')).toBe(false)
  })

  it('wildcard suffix matches', () => {
    const { rule } = firstRule(
      minimalPolicies({
        rules: [{ match: { tool: 'send_*' }, action: 'allow' }],
      }),
    )
    const matcher = rule.match.tool
    expect(matcher?.test('send_email')).toBe(true)
    expect(matcher?.test('send_sms')).toBe(true)
    expect(matcher?.test('receive_email')).toBe(false)
  })

  it('star matches everything', () => {
    const { rule } = firstRule(
      minimalPolicies({
        rules: [{ match: { tool: '*' }, action: 'allow' }],
      }),
    )
    const matcher = rule.match.tool
    expect(matcher?.test('anything')).toBe(true)
    expect(matcher?.test('foo_bar_baz')).toBe(true)
  })

  it('brace expansion works', () => {
    const { rule } = firstRule(
      minimalPolicies({
        rules: [{ match: { tool: 'db.{read,write}' }, action: 'allow' }],
      }),
    )
    const matcher = rule.match.tool
    expect(matcher?.test('db.read')).toBe(true)
    expect(matcher?.test('db.write')).toBe(true)
    expect(matcher?.test('db.delete')).toBe(false)
  })

  it('rule without tool matcher has no tool field', () => {
    const { rule } = firstRule(
      minimalPolicies({
        rules: [{ match: { environment: 'production' }, action: 'deny' }],
      }),
    )
    expect(rule.match.tool).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Annotation matching
// ---------------------------------------------------------------------------

describe('annotation matching', () => {
  it('preserves readOnlyHint: false', () => {
    const { rule } = firstRule(
      minimalPolicies({
        rules: [{ match: { annotations: { readOnlyHint: false } }, action: 'deny' }],
      }),
    )
    expect(rule.match.annotations?.readOnlyHint).toBe(false)
  })

  it('preserves destructiveHint: true', () => {
    const { rule } = firstRule(
      minimalPolicies({
        rules: [{ match: { annotations: { destructiveHint: true } }, action: 'deny' }],
      }),
    )
    expect(rule.match.annotations?.destructiveHint).toBe(true)
  })

  it('preserves multiple annotations', () => {
    const { rule } = firstRule(
      minimalPolicies({
        rules: [
          {
            match: {
              annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
            },
            action: 'allow',
          },
        ],
      }),
    )
    const annotations = rule.match.annotations
    expect(annotations).toBeDefined()
    expect(annotations?.readOnlyHint).toBe(true)
    expect(annotations?.destructiveHint).toBe(false)
    expect(annotations?.idempotentHint).toBe(true)
    expect(annotations?.openWorldHint).toBeUndefined()
  })

  it('rule without annotations has no annotations field', () => {
    const { rule } = firstRule(
      minimalPolicies({
        rules: [{ match: { tool: '*' }, action: 'allow' }],
      }),
    )
    expect(rule.match.annotations).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Input condition flattening
// ---------------------------------------------------------------------------

describe('input condition flattening', () => {
  it('single path, single operator', () => {
    const { rule } = firstRule(
      minimalPolicies({
        rules: [
          {
            match: { input: { '$.amount': { gt: 1000 } } },
            action: 'deny',
          },
        ],
      }),
    )
    const input = rule.match.input
    expect(input).toBeDefined()
    expect(input).toHaveLength(1)
    expect(input?.[0]?.path).toBe('$.amount')
    expect(input?.[0]?.operator).toBe('gt')
    expect(input?.[0]?.value).toBe(1000)
    expect(input?.[0]?.regex).toBeUndefined()
  })

  it('single path, multiple operators flattens to multiple entries', () => {
    const { rule } = firstRule(
      minimalPolicies({
        rules: [
          {
            match: { input: { '$.amount': { gt: 100, lt: 5000 } } },
            action: 'deny',
          },
        ],
      }),
    )
    const input = rule.match.input
    expect(input).toBeDefined()
    expect(input).toHaveLength(2)

    const gtCondition = input?.find((c) => c.operator === 'gt')
    expect(gtCondition?.path).toBe('$.amount')
    expect(gtCondition?.value).toBe(100)

    const ltCondition = input?.find((c) => c.operator === 'lt')
    expect(ltCondition?.path).toBe('$.amount')
    expect(ltCondition?.value).toBe(5000)
  })

  it('multiple paths produce separate entries', () => {
    const { rule } = firstRule(
      minimalPolicies({
        rules: [
          {
            match: {
              input: {
                '$.amount': { gt: 100 },
                '$.currency': { eq: 'GBP' },
              },
            },
            action: 'deny',
          },
        ],
      }),
    )
    const input = rule.match.input
    expect(input).toBeDefined()
    expect(input).toHaveLength(2)
    expect(input?.map((c) => c.path)).toContain('$.amount')
    expect(input?.map((c) => c.path)).toContain('$.currency')
  })

  it('regex operator pre-compiles to RegExp', () => {
    const { rule } = firstRule(
      minimalPolicies({
        rules: [
          {
            match: { input: { '$.email': { regex: '^admin@' } } },
            action: 'deny',
          },
        ],
      }),
    )
    const input = rule.match.input
    expect(input).toBeDefined()
    expect(input).toHaveLength(1)
    const cond = input?.[0]
    expect(cond?.operator).toBe('regex')
    expect(cond?.value).toBe('^admin@')
    expect(cond?.regex).toBeInstanceOf(RegExp)
    expect(cond?.regex?.test('admin@example.com')).toBe(true)
    expect(cond?.regex?.test('user@example.com')).toBe(false)
  })

  it('invalid regex throws PolicyParseError', () => {
    expect(() =>
      compilePolicies(
        minimalPolicies({
          rules: [
            {
              match: { input: { '$.name': { regex: '[invalid(' } } },
              action: 'deny',
            },
          ],
        }),
      ),
    ).toThrow(PolicyParseError)
  })

  it('invalid regex error includes path and rule index', () => {
    try {
      compilePolicies(
        minimalPolicies({
          rules: [
            {
              name: 'bad-regex-rule',
              match: { input: { '$.field': { regex: '[invalid(' } } },
              action: 'deny',
            },
          ],
        }),
      )
      expect.fail('expected PolicyParseError')
    } catch (err) {
      expect(err).toBeInstanceOf(PolicyParseError)
      const parseErr = err as PolicyParseError
      expect(parseErr.ruleIndex).toBe(0)
      expect(parseErr.ruleName).toBe('bad-regex-rule')
      expect(parseErr.message).toContain('$.field')
      expect(parseErr.message).toContain('[invalid(')
    }
  })

  it('rejects catastrophic nested-quantifier regex patterns at compile time', () => {
    expect(() =>
      compilePolicies(
        minimalPolicies({
          rules: [
            {
              name: 'redos-nested',
              match: { input: { '$.name': { regex: '^(a+)+$' } } },
              action: 'deny',
            },
          ],
        }),
      ),
    ).toThrow(PolicyParseError)
  })

  it('rejects catastrophic nested-star regex patterns at compile time', () => {
    expect(() =>
      compilePolicies(
        minimalPolicies({
          rules: [
            {
              name: 'redos-nested-star',
              match: { input: { '$.name': { regex: '(a*)*$' } } },
              action: 'deny',
            },
          ],
        }),
      ),
    ).toThrow(PolicyParseError)
  })

  it('catastrophic regex error mentions the offending pattern and rule name', () => {
    try {
      compilePolicies(
        minimalPolicies({
          rules: [
            {
              name: 'redos-rule',
              match: { input: { '$.payload': { regex: '^(a+)+$' } } },
              action: 'deny',
            },
          ],
        }),
      )
      expect.fail('expected PolicyParseError')
    } catch (err) {
      expect(err).toBeInstanceOf(PolicyParseError)
      const parseErr = err as PolicyParseError
      expect(parseErr.ruleName).toBe('redos-rule')
      expect(parseErr.message).toContain('$.payload')
      expect(parseErr.message).toContain('(a+)+')
    }
  })

  it('accepts a safe regex with a bounded quantifier', () => {
    expect(() =>
      compilePolicies(
        minimalPolicies({
          rules: [
            {
              match: { input: { '$.email': { regex: '^[a-z0-9._%+-]+@[a-z0-9.-]+$' } } },
              action: 'deny',
            },
          ],
        }),
      ),
    ).not.toThrow()
  })

  it('eq operator with various value types', () => {
    const { rule } = firstRule(
      minimalPolicies({
        rules: [
          {
            match: {
              input: {
                '$.status': { eq: 'active' },
                '$.count': { eq: 42 },
              },
            },
            action: 'allow',
          },
        ],
      }),
    )
    const input = rule.match.input
    expect(input).toBeDefined()
    const statusCond = input?.find((c) => c.path === '$.status')
    expect(statusCond?.value).toBe('active')

    const countCond = input?.find((c) => c.path === '$.count')
    expect(countCond?.value).toBe(42)
  })

  it('contains operator is preserved', () => {
    const { rule } = firstRule(
      minimalPolicies({
        rules: [
          {
            match: { input: { '$.description': { contains: 'urgent' } } },
            action: 'deny',
          },
        ],
      }),
    )
    const cond = rule.match.input?.[0]
    expect(cond?.operator).toBe('contains')
    expect(cond?.value).toBe('urgent')
  })

  it('neq operator is preserved', () => {
    const { rule } = firstRule(
      minimalPolicies({
        rules: [
          {
            match: { input: { '$.status': { neq: 'deleted' } } },
            action: 'allow',
          },
        ],
      }),
    )
    const cond = rule.match.input?.[0]
    expect(cond?.operator).toBe('neq')
    expect(cond?.value).toBe('deleted')
  })
})

// ---------------------------------------------------------------------------
// Duration parsing
// ---------------------------------------------------------------------------

describe('duration parsing', () => {
  it('parses approval timeout to milliseconds', () => {
    const { rule } = firstRule(
      minimalPolicies({
        rules: [
          {
            match: { tool: '*' },
            action: 'require_approval',
            approval: { channel: 'slack', timeout: '300s' },
          },
        ],
      }),
    )
    expect(rule.approval?.timeoutMs).toBe(300_000)
  })

  it('parses limits window to milliseconds', () => {
    const { rule } = firstRule(
      minimalPolicies({
        rules: [
          {
            match: { tool: '*' },
            action: 'rate_limit',
            limits: { max_calls: 100, window: '1h' },
          },
        ],
      }),
    )
    expect(rule.limits?.windowMs).toBe(3_600_000)
  })

  it('parses spend limit window to milliseconds', () => {
    const { rule } = firstRule(
      minimalPolicies({
        rules: [
          {
            match: { tool: '*' },
            action: 'spend_limit',
            limits: {
              max_spend: { field: 'input.amount', limit: 5000, currency: 'GBP', window: '24h' },
            },
          },
        ],
      }),
    )
    expect(rule.limits?.maxSpend?.windowMs).toBe(86_400_000)
  })

  it('parses spend limit key when provided', () => {
    const { rule } = firstRule(
      minimalPolicies({
        rules: [
          {
            match: { tool: '*' },
            action: 'spend_limit',
            limits: {
              max_spend: {
                field: '$.amount',
                limit: 5000,
                currency: 'GBP',
                window: '24h',
                key: 'session',
              },
            },
          },
        ],
      }),
    )
    expect(rule.limits?.maxSpend?.key).toBe('session')
  })

  it('omits spend limit key when not provided', () => {
    const { rule } = firstRule(
      minimalPolicies({
        rules: [
          {
            match: { tool: '*' },
            action: 'spend_limit',
            limits: {
              max_spend: { field: '$.amount', limit: 5000, currency: 'GBP', window: '24h' },
            },
          },
        ],
      }),
    )
    expect(rule.limits?.maxSpend?.key).toBeUndefined()
  })

  it('parses escalation_after to escalationAfterMs', () => {
    const { rule } = firstRule(
      minimalPolicies({
        rules: [
          {
            match: { tool: '*' },
            action: 'require_approval',
            approval: { channel: 'slack', timeout: '300s', escalation_after: '120s' },
          },
        ],
      }),
    )
    expect(rule.approval?.escalationAfterMs).toBe(120_000)
  })

  it('approval without escalation_after has no escalationAfterMs', () => {
    const { rule } = firstRule(
      minimalPolicies({
        rules: [
          {
            match: { tool: '*' },
            action: 'require_approval',
            approval: { channel: 'slack', timeout: '300s' },
          },
        ],
      }),
    )
    expect(rule.approval?.escalationAfterMs).toBeUndefined()
  })

  it('approval without timeout has no timeoutMs', () => {
    const { rule } = firstRule(
      minimalPolicies({
        rules: [
          {
            match: { tool: '*' },
            action: 'require_approval',
            approval: { channel: 'slack' },
          },
        ],
      }),
    )
    expect(rule.approval?.timeoutMs).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Evidence and requires
// ---------------------------------------------------------------------------

describe('evidence and requires', () => {
  it('preserves evidence requires array', () => {
    const { rule } = firstRule(
      minimalPolicies({
        rules: [
          {
            match: { tool: 'process_refund' },
            action: 'deny',
            evidence: { requires: ['orders.lookup'] },
          },
        ],
      }),
    )
    expect(rule.evidence?.requires).toEqual(['orders.lookup'])
  })

  it('preserves requires (dependency chains)', () => {
    const { rule } = firstRule(
      minimalPolicies({
        rules: [
          {
            match: { tool: 'process_refund' },
            action: 'deny',
            requires: ['orders.lookup', 'customer.verify'],
          },
        ],
      }),
    )
    expect(rule.requires).toEqual(['orders.lookup', 'customer.verify'])
  })

  it('defaults requiresSuccess to undefined (successful calls required)', () => {
    const { rule } = firstRule(
      minimalPolicies({
        rules: [
          {
            match: { tool: 'process_refund' },
            action: 'deny',
            requires: ['orders.lookup'],
          },
        ],
      }),
    )
    expect(rule.requiresSuccess).toBeUndefined()
  })

  it('preserves requires_success: false as an explicit opt-out', () => {
    const { rule } = firstRule(
      minimalPolicies({
        rules: [
          {
            match: { tool: 'process_refund' },
            action: 'deny',
            requires: ['orders.lookup'],
            requires_success: false,
          },
        ],
      }),
    )
    expect(rule.requiresSuccess).toBe(false)
  })

  it('preserves requires_success: true when explicitly set', () => {
    const { rule } = firstRule(
      minimalPolicies({
        rules: [
          {
            match: { tool: 'process_refund' },
            action: 'deny',
            requires: ['orders.lookup'],
            requires_success: true,
          },
        ],
      }),
    )
    expect(rule.requiresSuccess).toBe(true)
  })

  it('rule without evidence/requires omits those fields', () => {
    const { rule } = firstRule(
      minimalPolicies({
        rules: [{ match: { tool: '*' }, action: 'allow' }],
      }),
    )
    expect(rule.evidence).toBeUndefined()
    expect(rule.requires).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Semantic warnings
// ---------------------------------------------------------------------------

describe('semantic warnings', () => {
  it('warns when require_approval has no approval config', () => {
    const { warnings } = compilePolicies(
      minimalPolicies({
        rules: [{ match: { tool: '*' }, action: 'require_approval' }],
      }),
    )
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.ruleIndex).toBe(0)
    expect(warnings[0]?.message).toContain('require_approval')
    expect(warnings[0]?.message).toContain('approval')
  })

  it('warns when rate_limit has no max_calls', () => {
    const { warnings } = compilePolicies(
      minimalPolicies({
        rules: [{ match: { tool: '*' }, action: 'rate_limit' }],
      }),
    )
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.message).toContain('rate_limit')
    expect(warnings[0]?.message).toContain('max_calls')
  })

  it('warns when limits.key is "agent"', () => {
    const { warnings } = compilePolicies(
      minimalPolicies({
        rules: [
          {
            match: { tool: '*' },
            action: 'rate_limit',
            limits: { max_calls: 10, window: '1h', key: 'agent' },
          },
        ],
      }),
    )
    const agentWarning = warnings.find((w) => w.message.includes('agent'))
    expect(agentWarning).toBeDefined()
    expect(agentWarning?.message).toContain('not yet supported')
    expect(agentWarning?.message).toContain('tool')
    expect(agentWarning?.message).toContain('session')
  })

  it('warns when max_spend.key is "agent"', () => {
    const { warnings } = compilePolicies(
      minimalPolicies({
        rules: [
          {
            match: { tool: '*' },
            action: 'spend_limit',
            limits: {
              max_spend: {
                field: '$.amount',
                limit: 5000,
                currency: 'GBP',
                window: '24h',
                key: 'agent',
              },
            },
          },
        ],
      }),
    )
    const agentWarning = warnings.find((w) => w.message.includes('max_spend.key'))
    expect(agentWarning).toBeDefined()
    expect(agentWarning?.message).toContain('not yet supported')
  })

  it('warns when spend_limit has no max_spend', () => {
    const { warnings } = compilePolicies(
      minimalPolicies({
        rules: [{ match: { tool: '*' }, action: 'spend_limit' }],
      }),
    )
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.message).toContain('spend_limit')
    expect(warnings[0]?.message).toContain('max_spend')
  })

  it('accumulates warnings across multiple rules with correct indices', () => {
    const { warnings } = compilePolicies(
      minimalPolicies({
        rules: [
          { match: { tool: 'a' }, action: 'allow' },
          { name: 'rule-1', match: { tool: 'b' }, action: 'require_approval' },
          { match: { tool: 'c' }, action: 'allow' },
          { name: 'rule-3', match: { tool: 'd' }, action: 'spend_limit' },
        ],
      }),
    )
    expect(warnings).toHaveLength(2)
    expect(warnings[0]?.ruleIndex).toBe(1)
    expect(warnings[0]?.ruleName).toBe('rule-1')
    expect(warnings[1]?.ruleIndex).toBe(3)
    expect(warnings[1]?.ruleName).toBe('rule-3')
  })

  it('no warnings for properly configured rules', () => {
    const { warnings } = compilePolicies(
      minimalPolicies({
        rules: [
          {
            match: { tool: '*' },
            action: 'require_approval',
            approval: { channel: 'slack' },
          },
          {
            match: { tool: '*' },
            action: 'rate_limit',
            limits: { max_calls: 100, window: '1h' },
          },
        ],
      }),
    )
    expect(warnings).toEqual([])
  })

  it('warns when escalation_after is set without delegates', () => {
    const { warnings } = compilePolicies(
      minimalPolicies({
        rules: [
          {
            match: { tool: '*' },
            action: 'require_approval',
            approval: { channel: 'slack', timeout: '300s', escalation_after: '120s' },
          },
        ],
      }),
    )
    const escalationWarning = warnings.find((w) => w.message.includes('escalation_after'))
    expect(escalationWarning).toBeDefined()
    expect(escalationWarning?.message).toContain('delegates')
    expect(escalationWarning?.message).toContain('re-notify the primary channel')
  })

  it('warns when escalation_after >= timeout', () => {
    const { warnings } = compilePolicies(
      minimalPolicies({
        rules: [
          {
            match: { tool: '*' },
            action: 'require_approval',
            approval: {
              channel: 'slack',
              timeout: '120s',
              delegates: ['fallback'],
              escalation_after: '120s',
            },
          },
        ],
      }),
    )
    const escalationWarning = warnings.find((w) => w.message.includes('escalation_after'))
    expect(escalationWarning).toBeDefined()
    expect(escalationWarning?.message).toContain('never fire')
  })

  it('no warning for escalation_after < timeout with delegates', () => {
    const { warnings } = compilePolicies(
      minimalPolicies({
        rules: [
          {
            match: { tool: '*' },
            action: 'require_approval',
            approval: {
              channel: 'slack',
              timeout: '300s',
              delegates: ['fallback'],
              escalation_after: '120s',
            },
          },
        ],
      }),
    )
    const escalationWarning = warnings.find((w) => w.message.includes('escalation_after'))
    expect(escalationWarning).toBeUndefined()
  })

  it('warns when dry_run action has approval config', () => {
    const { warnings } = compilePolicies(
      minimalPolicies({
        rules: [
          {
            match: { tool: '*' },
            action: 'dry_run',
            approval: { channel: 'slack' },
          },
        ],
      }),
    )
    const dryRunWarning = warnings.find((w) => w.message.includes('dry_run'))
    expect(dryRunWarning).toBeDefined()
    expect(dryRunWarning?.message).toContain('approval')
    expect(dryRunWarning?.message).toContain('ignored')
  })

  it('warns when dry_run action has limits config', () => {
    const { warnings } = compilePolicies(
      minimalPolicies({
        rules: [
          {
            match: { tool: '*' },
            action: 'dry_run',
            limits: { max_calls: 10, window: '1h' },
          },
        ],
      }),
    )
    const dryRunWarning = warnings.find((w) => w.message.includes('dry_run'))
    expect(dryRunWarning).toBeDefined()
    expect(dryRunWarning?.message).toContain('limits')
    expect(dryRunWarning?.message).toContain('ignored')
  })

  it('no warning for dry_run action without approval or limits', () => {
    const { warnings } = compilePolicies(
      minimalPolicies({
        rules: [{ match: { tool: '*' }, action: 'dry_run' }],
      }),
    )
    expect(warnings).toEqual([])
  })

  it('includes rule name in warnings when available', () => {
    const { warnings } = compilePolicies(
      minimalPolicies({
        rules: [
          {
            name: 'approve-writes',
            match: { tool: '*' },
            action: 'require_approval',
          },
        ],
      }),
    )
    expect(warnings[0]?.ruleName).toBe('approve-writes')
  })
})

// ---------------------------------------------------------------------------
// Global dry_run compilation
// ---------------------------------------------------------------------------

describe('global dry_run compilation', () => {
  it('sets policy.dryRun when dry_run is true', () => {
    const { policy } = compilePolicies(minimalPolicies({ dry_run: true }))
    expect(policy.dryRun).toBe(true)
  })

  it('leaves policy.dryRun undefined when dry_run is false', () => {
    const { policy } = compilePolicies(minimalPolicies({ dry_run: false }))
    expect(policy.dryRun).toBeUndefined()
  })

  it('leaves policy.dryRun undefined when dry_run is not set', () => {
    const { policy } = compilePolicies(minimalPolicies())
    expect(policy.dryRun).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Rule ordering and flagDestructive
// ---------------------------------------------------------------------------

describe('rule ordering and flagDestructive', () => {
  it('preserves definition order with correct index values', () => {
    const { policy } = compilePolicies(
      minimalPolicies({
        rules: [
          { name: 'first', match: { tool: 'a_*' }, action: 'allow' },
          { name: 'second', match: { tool: 'b_*' }, action: 'deny' },
          { name: 'third', match: { tool: 'c_*' }, action: 'allow' },
        ],
      }),
    )
    expect(policy.rules).toHaveLength(3)
    const r0 = ruleAt(policy.rules, 0)
    const r1 = ruleAt(policy.rules, 1)
    const r2 = ruleAt(policy.rules, 2)
    expect(r0.index).toBe(0)
    expect(r0.name).toBe('first')
    expect(r1.index).toBe(1)
    expect(r1.name).toBe('second')
    expect(r2.index).toBe(2)
    expect(r2.name).toBe('third')
  })

  it('preserves flagDestructive from config', () => {
    const { policy } = compilePolicies(minimalPolicies({ flag_destructive: 'require_approval' }))
    expect(policy.flagDestructive).toBe('require_approval')
  })

  it('flagDestructive defaults to undefined when not set', () => {
    const { policy } = compilePolicies(minimalPolicies())
    expect(policy.flagDestructive).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Full complex rule
// ---------------------------------------------------------------------------

describe('full complex rule', () => {
  it('compiles a rule with every field populated', () => {
    const { rule, policy, warnings } = firstRule(
      minimalPolicies({
        flag_destructive: 'log',
        rules: [
          {
            name: 'approve-high-value-payments',
            match: {
              tool: 'create_payment',
              annotations: { readOnlyHint: false, destructiveHint: false },
              input: {
                '$.amount': { gt: 1000, lte: 50000 },
                '$.currency': { eq: 'GBP' },
              },
              environment: 'production',
            },
            action: 'require_approval',
            approval: {
              channel: 'slack',
              timeout: '5m',
              delegates: ['#fallback-approvers'],
            },
            evidence: {
              requires: ['orders.lookup', 'customer.verify'],
            },
            requires: ['auth.check'],
            limits: {
              max_calls: 50,
              window: '1h',
              key: 'agent',
              max_spend: {
                field: 'input.amount',
                limit: 10000,
                currency: 'GBP',
                window: '24h',
              },
            },
            feedback: {
              message: 'High-value payments require approval from the finance team.',
            },
          },
        ],
      }),
    )

    expect(policy.flagDestructive).toBe('log')
    expect(rule.index).toBe(0)
    expect(rule.name).toBe('approve-high-value-payments')
    expect(rule.action).toBe('require_approval')

    // Match — tool
    expect(rule.match.tool?.pattern).toBe('create_payment')
    expect(rule.match.tool?.test('create_payment')).toBe(true)
    expect(rule.match.tool?.test('delete_payment')).toBe(false)

    // Match — annotations
    expect(rule.match.annotations?.readOnlyHint).toBe(false)
    expect(rule.match.annotations?.destructiveHint).toBe(false)

    // Match — input (flattened: 2 from $.amount + 1 from $.currency = 3)
    const input = rule.match.input
    expect(input).toBeDefined()
    expect(input).toHaveLength(3)
    const amountGt = input?.find((c) => c.path === '$.amount' && c.operator === 'gt')
    expect(amountGt?.value).toBe(1000)
    const amountLte = input?.find((c) => c.path === '$.amount' && c.operator === 'lte')
    expect(amountLte?.value).toBe(50000)
    const currencyEq = input?.find((c) => c.path === '$.currency' && c.operator === 'eq')
    expect(currencyEq?.value).toBe('GBP')

    // Match — environment
    expect(rule.match.environment).toBe('production')

    // Approval
    expect(rule.approval?.channel).toBe('slack')
    expect(rule.approval?.timeoutMs).toBe(300_000)
    expect(rule.approval?.delegates).toEqual(['#fallback-approvers'])

    // Evidence
    expect(rule.evidence?.requires).toEqual(['orders.lookup', 'customer.verify'])

    // Requires
    expect(rule.requires).toEqual(['auth.check'])

    // Limits
    expect(rule.limits?.maxCalls).toBe(50)
    expect(rule.limits?.windowMs).toBe(3_600_000)
    expect(rule.limits?.key).toBe('agent')
    expect(rule.limits?.maxSpend?.field).toBe('input.amount')
    expect(rule.limits?.maxSpend?.limit).toBe(10000)
    expect(rule.limits?.maxSpend?.currency).toBe('GBP')
    expect(rule.limits?.maxSpend?.windowMs).toBe(86_400_000)

    // Feedback
    expect(rule.feedback?.message).toBe(
      'High-value payments require approval from the finance team.',
    )

    // One warning: key "agent" is not yet supported
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.message).toContain('agent')
    expect(warnings[0]?.message).toContain('not yet supported')
  })
})

// ---------------------------------------------------------------------------
// PolicyParseError
// ---------------------------------------------------------------------------

describe('PolicyParseError', () => {
  it('formats error message with rule index', () => {
    const err = new PolicyParseError('something went wrong', 3)
    expect(err.message).toBe('Policy rule 3: something went wrong')
    expect(err.ruleIndex).toBe(3)
    expect(err.ruleName).toBeUndefined()
  })

  it('formats error message with rule index and name', () => {
    const err = new PolicyParseError('bad pattern', 1, 'my-rule')
    expect(err.message).toBe('Policy rule 1 ("my-rule"): bad pattern')
    expect(err.ruleIndex).toBe(1)
    expect(err.ruleName).toBe('my-rule')
  })
})
