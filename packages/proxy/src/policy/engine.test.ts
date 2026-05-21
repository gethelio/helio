import { describe, it, expect } from 'vitest'
import { evaluatePolicy } from './engine.js'
import { compilePolicies } from './parser.js'
import type { PoliciesConfig } from '../config/schema.js'
import type { MatchContext } from './types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function compile(config: Omit<PoliciesConfig, 'dry_run'> & { dry_run?: boolean }) {
  return compilePolicies({ dry_run: false, ...config }).policy
}

function ctx(overrides: Partial<MatchContext> = {}): MatchContext {
  return { ...overrides }
}

// ---------------------------------------------------------------------------
// evaluatePolicy
// ---------------------------------------------------------------------------

describe('evaluatePolicy', () => {
  it('returns allow when a matching allow rule is found', () => {
    const policy = compile({
      default: 'deny',
      rules: [{ match: { tool: 'get_weather' }, action: 'allow' }],
    })
    const decision = evaluatePolicy(policy, ctx({ toolName: 'get_weather' }))
    expect(decision.action).toBe('allow')
    expect(decision.matchedRule).toBeDefined()
    expect(decision.matchedRule?.action).toBe('allow')
  })

  it('returns deny when a matching deny rule is found', () => {
    const policy = compile({
      default: 'allow',
      rules: [{ match: { tool: 'delete_*' }, action: 'deny' }],
    })
    const decision = evaluatePolicy(policy, ctx({ toolName: 'delete_record' }))
    expect(decision.action).toBe('deny')
    expect(decision.matchedRule).toBeDefined()
  })

  it('first-match-wins: earlier rule takes precedence', () => {
    const policy = compile({
      default: 'deny',
      rules: [
        { name: 'allow-weather', match: { tool: 'get_weather' }, action: 'allow' },
        { name: 'deny-all', match: { tool: '*' }, action: 'deny' },
      ],
    })
    const decision = evaluatePolicy(policy, ctx({ toolName: 'get_weather' }))
    expect(decision.action).toBe('allow')
    expect(decision.matchedRule?.name).toBe('allow-weather')
  })

  it('first-match-wins: later catch-all applies to unmatched tools', () => {
    const policy = compile({
      default: 'allow',
      rules: [
        { name: 'allow-weather', match: { tool: 'get_weather' }, action: 'allow' },
        { name: 'deny-all', match: { tool: '*' }, action: 'deny' },
      ],
    })
    const decision = evaluatePolicy(policy, ctx({ toolName: 'send_email' }))
    expect(decision.action).toBe('deny')
    expect(decision.matchedRule?.name).toBe('deny-all')
  })

  it('applies default allow when no rule matches', () => {
    const policy = compile({
      default: 'allow',
      rules: [{ match: { tool: 'specific_tool' }, action: 'deny' }],
    })
    const decision = evaluatePolicy(policy, ctx({ toolName: 'unmatched_tool' }))
    expect(decision.action).toBe('allow')
    expect(decision.matchedRule).toBeUndefined()
    expect(decision.reason).toContain('default')
    expect(decision.reason).toContain('allow')
  })

  it('applies default deny when no rule matches', () => {
    const policy = compile({
      default: 'deny',
      rules: [{ match: { tool: 'specific_tool' }, action: 'allow' }],
    })
    const decision = evaluatePolicy(policy, ctx({ toolName: 'unmatched_tool' }))
    expect(decision.action).toBe('deny')
    expect(decision.matchedRule).toBeUndefined()
    expect(decision.reason).toContain('default')
    expect(decision.reason).toContain('deny')
  })

  it('applies default when rules array is empty', () => {
    const policy = compile({ default: 'allow', rules: [] })
    const decision = evaluatePolicy(policy, ctx({ toolName: 'anything' }))
    expect(decision.action).toBe('allow')
    expect(decision.matchedRule).toBeUndefined()
  })

  it('matches on annotations', () => {
    const policy = compile({
      default: 'allow',
      rules: [
        {
          match: { annotations: { destructiveHint: true } },
          action: 'deny',
        },
      ],
    })
    const decision = evaluatePolicy(
      policy,
      ctx({ toolName: 'delete_record', annotations: { destructiveHint: true } }),
    )
    expect(decision.action).toBe('deny')
    expect(decision.matchedRule).toBeDefined()
  })

  it('matches on input conditions', () => {
    const policy = compile({
      default: 'allow',
      rules: [
        {
          match: { input: { '$.amount': { gt: 1000 } } },
          action: 'deny',
        },
      ],
    })
    const decision = evaluatePolicy(
      policy,
      ctx({ toolName: 'create_payment', toolArguments: { amount: 5000 } }),
    )
    expect(decision.action).toBe('deny')
  })

  it('does not match when input condition is not met', () => {
    const policy = compile({
      default: 'allow',
      rules: [
        {
          match: { input: { '$.amount': { gt: 1000 } } },
          action: 'deny',
        },
      ],
    })
    const decision = evaluatePolicy(
      policy,
      ctx({ toolName: 'create_payment', toolArguments: { amount: 500 } }),
    )
    expect(decision.action).toBe('allow')
    expect(decision.matchedRule).toBeUndefined()
  })

  it('matches on environment', () => {
    const policy = compile({
      default: 'allow',
      rules: [
        {
          match: { tool: '*', environment: 'production' },
          action: 'deny',
        },
      ],
    })
    const decision = evaluatePolicy(
      policy,
      ctx({ toolName: 'send_email', environment: 'production' }),
    )
    expect(decision.action).toBe('deny')
  })

  it('does not match when environment differs', () => {
    const policy = compile({
      default: 'allow',
      rules: [
        {
          match: { tool: '*', environment: 'production' },
          action: 'deny',
        },
      ],
    })
    const decision = evaluatePolicy(policy, ctx({ toolName: 'send_email', environment: 'staging' }))
    expect(decision.action).toBe('allow')
    expect(decision.matchedRule).toBeUndefined()
  })

  it('returns unimplemented actions faithfully', () => {
    const policy = compile({
      default: 'allow',
      rules: [{ match: { tool: 'send_*' }, action: 'require_approval' }],
    })
    const decision = evaluatePolicy(policy, ctx({ toolName: 'send_email' }))
    expect(decision.action).toBe('require_approval')
    expect(decision.matchedRule).toBeDefined()
  })

  it('reason includes rule name when present', () => {
    const policy = compile({
      default: 'allow',
      rules: [{ name: 'block-writes', match: { tool: 'send_*' }, action: 'deny' }],
    })
    const decision = evaluatePolicy(policy, ctx({ toolName: 'send_email' }))
    expect(decision.reason).toContain('block-writes')
  })

  it('reason uses rule index when name is absent', () => {
    const policy = compile({
      default: 'allow',
      rules: [{ match: { tool: 'send_*' }, action: 'deny' }],
    })
    const decision = evaluatePolicy(policy, ctx({ toolName: 'send_email' }))
    expect(decision.reason).toContain('rule[0]')
  })
})
