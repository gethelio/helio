import { describe, it, expect } from 'vitest'
import { compilePolicies } from './parser.js'
import { matchRule, matchTool, matchAnnotations, matchInput, matchEnvironment } from './matchers.js'
import type { PoliciesConfig } from '../config/schema.js'
import type { AnnotationMatch, CompiledPolicyRule, InputCondition, MatchContext } from './types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Compile a single rule from a match config, using 'deny' as the action. */
function compileRule(match: PoliciesConfig['rules'][0]['match']): CompiledPolicyRule {
  const { policy } = compilePolicies({
    default: 'allow',
    dry_run: false,
    rules: [{ match, action: 'deny' }],
  })
  const rule = policy.rules[0]
  if (!rule) throw new Error('expected a compiled rule')
  return rule
}

/** Build a MatchContext with optional overrides. */
function ctx(overrides: Partial<MatchContext> = {}): MatchContext {
  return { ...overrides }
}

/** Extract the tool matcher from a compiled rule, asserting it exists. */
function toolMatcher(rule: CompiledPolicyRule) {
  const matcher = rule.match.tool
  if (!matcher) throw new Error('expected a tool matcher on the compiled rule')
  return matcher
}

// ---------------------------------------------------------------------------
// matchTool
// ---------------------------------------------------------------------------

describe('matchTool', () => {
  it('exact tool name matches', () => {
    const rule = compileRule({ tool: 'create_payment' })
    expect(matchTool(toolMatcher(rule), ctx({ toolName: 'create_payment' }))).toBe(true)
  })

  it('exact tool name does not match different name', () => {
    const rule = compileRule({ tool: 'create_payment' })
    expect(matchTool(toolMatcher(rule), ctx({ toolName: 'delete_payment' }))).toBe(false)
  })

  it('wildcard suffix matches matching names', () => {
    const rule = compileRule({ tool: 'send_*' })
    expect(matchTool(toolMatcher(rule), ctx({ toolName: 'send_email' }))).toBe(true)
    expect(matchTool(toolMatcher(rule), ctx({ toolName: 'send_sms' }))).toBe(true)
  })

  it('wildcard suffix does not match non-matching names', () => {
    const rule = compileRule({ tool: 'send_*' })
    expect(matchTool(toolMatcher(rule), ctx({ toolName: 'receive_email' }))).toBe(false)
  })

  it('star matches any tool name', () => {
    const rule = compileRule({ tool: '*' })
    expect(matchTool(toolMatcher(rule), ctx({ toolName: 'anything' }))).toBe(true)
    expect(matchTool(toolMatcher(rule), ctx({ toolName: 'create_payment' }))).toBe(true)
  })

  it('brace expansion matches included names', () => {
    const rule = compileRule({ tool: 'db.{read,write}' })
    expect(matchTool(toolMatcher(rule), ctx({ toolName: 'db.read' }))).toBe(true)
    expect(matchTool(toolMatcher(rule), ctx({ toolName: 'db.write' }))).toBe(true)
  })

  it('brace expansion does not match excluded names', () => {
    const rule = compileRule({ tool: 'db.{read,write}' })
    expect(matchTool(toolMatcher(rule), ctx({ toolName: 'db.delete' }))).toBe(false)
  })

  it('returns false when toolName is undefined', () => {
    const rule = compileRule({ tool: '*' })
    expect(matchTool(toolMatcher(rule), ctx())).toBe(false)
  })

  it('handles tool names with dots', () => {
    const rule = compileRule({ tool: 'api.users.*' })
    expect(matchTool(toolMatcher(rule), ctx({ toolName: 'api.users.create' }))).toBe(true)
    expect(matchTool(toolMatcher(rule), ctx({ toolName: 'api.orders.create' }))).toBe(false)
  })

  it('handles tool names with underscores', () => {
    const rule = compileRule({ tool: 'my_tool_*' })
    expect(matchTool(toolMatcher(rule), ctx({ toolName: 'my_tool_v2' }))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// matchAnnotations
// ---------------------------------------------------------------------------

describe('matchAnnotations', () => {
  it('matches when required destructiveHint is true and actual is true', () => {
    const required: AnnotationMatch = { destructiveHint: true }
    expect(matchAnnotations(required, ctx({ annotations: { destructiveHint: true } }))).toBe(true)
  })

  it('does not match when required destructiveHint is true and actual is false', () => {
    const required: AnnotationMatch = { destructiveHint: true }
    expect(matchAnnotations(required, ctx({ annotations: { destructiveHint: false } }))).toBe(false)
  })

  it('matches when required readOnlyHint is true and actual is true', () => {
    const required: AnnotationMatch = { readOnlyHint: true }
    expect(matchAnnotations(required, ctx({ annotations: { readOnlyHint: true } }))).toBe(true)
  })

  it('does not match when required readOnlyHint is false and actual is true', () => {
    const required: AnnotationMatch = { readOnlyHint: false }
    expect(matchAnnotations(required, ctx({ annotations: { readOnlyHint: true } }))).toBe(false)
  })

  it('uses MCP default for destructiveHint (true) when not present on tool', () => {
    const required: AnnotationMatch = { destructiveHint: true }
    // annotations present but destructiveHint not specified → default is true
    expect(matchAnnotations(required, ctx({ annotations: {} }))).toBe(true)
  })

  it('does not match destructiveHint false against MCP default (true)', () => {
    const required: AnnotationMatch = { destructiveHint: false }
    expect(matchAnnotations(required, ctx({ annotations: {} }))).toBe(false)
  })

  it('uses MCP default for readOnlyHint (false) when not present on tool', () => {
    const required: AnnotationMatch = { readOnlyHint: false }
    expect(matchAnnotations(required, ctx({ annotations: {} }))).toBe(true)
  })

  it('uses MCP default for idempotentHint (false) when not present on tool', () => {
    const required: AnnotationMatch = { idempotentHint: false }
    expect(matchAnnotations(required, ctx({ annotations: {} }))).toBe(true)
  })

  it('uses MCP default for openWorldHint (true) when not present on tool', () => {
    const required: AnnotationMatch = { openWorldHint: true }
    expect(matchAnnotations(required, ctx({ annotations: {} }))).toBe(true)
  })

  it('applies MCP defaults when ctx.annotations is entirely undefined', () => {
    // destructiveHint defaults to true, so this should match
    expect(matchAnnotations({ destructiveHint: true }, ctx())).toBe(true)
    // readOnlyHint defaults to false, so requiring true should not match
    expect(matchAnnotations({ readOnlyHint: true }, ctx())).toBe(false)
  })

  it('only checks fields specified in required — ignores unspecified', () => {
    const required: AnnotationMatch = { readOnlyHint: true }
    // destructiveHint is true on tool but not checked by the rule
    expect(
      matchAnnotations(
        required,
        ctx({ annotations: { readOnlyHint: true, destructiveHint: true } }),
      ),
    ).toBe(true)
  })

  it('multiple annotation conditions are AND-combined', () => {
    const required: AnnotationMatch = { readOnlyHint: true, destructiveHint: false }
    expect(
      matchAnnotations(
        required,
        ctx({ annotations: { readOnlyHint: true, destructiveHint: false } }),
      ),
    ).toBe(true)
  })

  it('fails if any single annotation condition does not match', () => {
    const required: AnnotationMatch = { readOnlyHint: true, destructiveHint: false }
    // readOnlyHint matches but destructiveHint does not
    expect(
      matchAnnotations(
        required,
        ctx({ annotations: { readOnlyHint: true, destructiveHint: true } }),
      ),
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// matchInput — path resolution
// ---------------------------------------------------------------------------

describe('matchInput', () => {
  describe('path resolution', () => {
    it('resolves simple path $.field', () => {
      const conditions: InputCondition[] = [{ path: '$.amount', operator: 'eq', value: 100 }]
      expect(matchInput(conditions, ctx({ toolArguments: { amount: 100 } }))).toBe(true)
    })

    it('resolves nested path $.user.name', () => {
      const conditions: InputCondition[] = [{ path: '$.user.name', operator: 'eq', value: 'alice' }]
      expect(matchInput(conditions, ctx({ toolArguments: { user: { name: 'alice' } } }))).toBe(true)
    })

    it('resolves deeply nested path $.a.b.c.d', () => {
      const conditions: InputCondition[] = [{ path: '$.a.b.c.d', operator: 'eq', value: 42 }]
      expect(matchInput(conditions, ctx({ toolArguments: { a: { b: { c: { d: 42 } } } } }))).toBe(
        true,
      )
    })

    it('returns undefined for missing top-level field (condition fails)', () => {
      const conditions: InputCondition[] = [{ path: '$.missing', operator: 'eq', value: 'x' }]
      expect(matchInput(conditions, ctx({ toolArguments: { other: 'y' } }))).toBe(false)
    })

    it('returns undefined for missing nested field (condition fails)', () => {
      const conditions: InputCondition[] = [{ path: '$.user.email', operator: 'eq', value: 'x' }]
      expect(matchInput(conditions, ctx({ toolArguments: { user: { name: 'alice' } } }))).toBe(
        false,
      )
    })

    it('returns undefined when intermediate value is null', () => {
      const conditions: InputCondition[] = [{ path: '$.user.name', operator: 'eq', value: 'x' }]
      expect(matchInput(conditions, ctx({ toolArguments: { user: null } }))).toBe(false)
    })

    it('returns undefined when intermediate value is a primitive', () => {
      const conditions: InputCondition[] = [{ path: '$.user.name', operator: 'eq', value: 'x' }]
      expect(matchInput(conditions, ctx({ toolArguments: { user: 'string_value' } }))).toBe(false)
    })

    it('handles path "$" returning the entire args object', () => {
      const args = { amount: 100 }
      const conditions: InputCondition[] = [{ path: '$', operator: 'eq', value: args }]
      expect(matchInput(conditions, ctx({ toolArguments: args }))).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------
  // matchInput — eq operator
  // ---------------------------------------------------------------------------

  describe('eq operator', () => {
    it('matches equal string values', () => {
      const conditions: InputCondition[] = [{ path: '$.status', operator: 'eq', value: 'active' }]
      expect(matchInput(conditions, ctx({ toolArguments: { status: 'active' } }))).toBe(true)
    })

    it('matches equal number values', () => {
      const conditions: InputCondition[] = [{ path: '$.count', operator: 'eq', value: 5 }]
      expect(matchInput(conditions, ctx({ toolArguments: { count: 5 } }))).toBe(true)
    })

    it('matches equal boolean values', () => {
      const conditions: InputCondition[] = [{ path: '$.flag', operator: 'eq', value: true }]
      expect(matchInput(conditions, ctx({ toolArguments: { flag: true } }))).toBe(true)
    })

    it('does not match different values', () => {
      const conditions: InputCondition[] = [{ path: '$.status', operator: 'eq', value: 'active' }]
      expect(matchInput(conditions, ctx({ toolArguments: { status: 'inactive' } }))).toBe(false)
    })

    it('does not match when value is undefined (path missing)', () => {
      const conditions: InputCondition[] = [{ path: '$.missing', operator: 'eq', value: 'x' }]
      expect(matchInput(conditions, ctx({ toolArguments: {} }))).toBe(false)
    })

    it('uses strict equality — "5" does not equal 5', () => {
      const conditions: InputCondition[] = [{ path: '$.val', operator: 'eq', value: 5 }]
      expect(matchInput(conditions, ctx({ toolArguments: { val: '5' } }))).toBe(false)
    })

    it('null eq null matches', () => {
      const conditions: InputCondition[] = [{ path: '$.val', operator: 'eq', value: null }]
      expect(matchInput(conditions, ctx({ toolArguments: { val: null } }))).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------
  // matchInput — neq operator
  // ---------------------------------------------------------------------------

  describe('neq operator', () => {
    it('matches when values differ', () => {
      const conditions: InputCondition[] = [{ path: '$.status', operator: 'neq', value: 'deleted' }]
      expect(matchInput(conditions, ctx({ toolArguments: { status: 'active' } }))).toBe(true)
    })

    it('does not match when values are equal', () => {
      const conditions: InputCondition[] = [{ path: '$.status', operator: 'neq', value: 'active' }]
      expect(matchInput(conditions, ctx({ toolArguments: { status: 'active' } }))).toBe(false)
    })

    it('does not match when path does not exist', () => {
      const conditions: InputCondition[] = [{ path: '$.missing', operator: 'neq', value: 'x' }]
      expect(matchInput(conditions, ctx({ toolArguments: {} }))).toBe(false)
    })

    it('does not match undefined neq undefined', () => {
      const conditions: InputCondition[] = [
        { path: '$.missing', operator: 'neq', value: undefined },
      ]
      expect(matchInput(conditions, ctx({ toolArguments: {} }))).toBe(false)
    })
  })

  // ---------------------------------------------------------------------------
  // matchInput — gt operator
  // ---------------------------------------------------------------------------

  describe('gt operator', () => {
    it('matches when resolved > condition value', () => {
      const conditions: InputCondition[] = [{ path: '$.amount', operator: 'gt', value: 100 }]
      expect(matchInput(conditions, ctx({ toolArguments: { amount: 200 } }))).toBe(true)
    })

    it('does not match when resolved == condition value', () => {
      const conditions: InputCondition[] = [{ path: '$.amount', operator: 'gt', value: 100 }]
      expect(matchInput(conditions, ctx({ toolArguments: { amount: 100 } }))).toBe(false)
    })

    it('does not match when resolved < condition value', () => {
      const conditions: InputCondition[] = [{ path: '$.amount', operator: 'gt', value: 100 }]
      expect(matchInput(conditions, ctx({ toolArguments: { amount: 50 } }))).toBe(false)
    })

    it('returns false when resolved value is not a number', () => {
      const conditions: InputCondition[] = [{ path: '$.amount', operator: 'gt', value: 100 }]
      expect(matchInput(conditions, ctx({ toolArguments: { amount: 'high' } }))).toBe(false)
    })

    it('returns false when resolved value is undefined', () => {
      const conditions: InputCondition[] = [{ path: '$.missing', operator: 'gt', value: 100 }]
      expect(matchInput(conditions, ctx({ toolArguments: {} }))).toBe(false)
    })

    it('returns false when resolved value is a numeric string', () => {
      const conditions: InputCondition[] = [{ path: '$.amount', operator: 'gt', value: 100 }]
      expect(matchInput(conditions, ctx({ toolArguments: { amount: '200' } }))).toBe(false)
    })
  })

  // ---------------------------------------------------------------------------
  // matchInput — gte operator
  // ---------------------------------------------------------------------------

  describe('gte operator', () => {
    it('matches when resolved > condition value', () => {
      const conditions: InputCondition[] = [{ path: '$.amount', operator: 'gte', value: 100 }]
      expect(matchInput(conditions, ctx({ toolArguments: { amount: 200 } }))).toBe(true)
    })

    it('matches when resolved == condition value', () => {
      const conditions: InputCondition[] = [{ path: '$.amount', operator: 'gte', value: 100 }]
      expect(matchInput(conditions, ctx({ toolArguments: { amount: 100 } }))).toBe(true)
    })

    it('does not match when resolved < condition value', () => {
      const conditions: InputCondition[] = [{ path: '$.amount', operator: 'gte', value: 100 }]
      expect(matchInput(conditions, ctx({ toolArguments: { amount: 50 } }))).toBe(false)
    })

    it('returns false for non-numeric values', () => {
      const conditions: InputCondition[] = [{ path: '$.amount', operator: 'gte', value: 100 }]
      expect(matchInput(conditions, ctx({ toolArguments: { amount: true } }))).toBe(false)
    })
  })

  // ---------------------------------------------------------------------------
  // matchInput — lt operator
  // ---------------------------------------------------------------------------

  describe('lt operator', () => {
    it('matches when resolved < condition value', () => {
      const conditions: InputCondition[] = [{ path: '$.amount', operator: 'lt', value: 100 }]
      expect(matchInput(conditions, ctx({ toolArguments: { amount: 50 } }))).toBe(true)
    })

    it('does not match when resolved == condition value', () => {
      const conditions: InputCondition[] = [{ path: '$.amount', operator: 'lt', value: 100 }]
      expect(matchInput(conditions, ctx({ toolArguments: { amount: 100 } }))).toBe(false)
    })

    it('does not match when resolved > condition value', () => {
      const conditions: InputCondition[] = [{ path: '$.amount', operator: 'lt', value: 100 }]
      expect(matchInput(conditions, ctx({ toolArguments: { amount: 200 } }))).toBe(false)
    })

    it('returns false for non-numeric values', () => {
      const conditions: InputCondition[] = [{ path: '$.amount', operator: 'lt', value: 100 }]
      expect(matchInput(conditions, ctx({ toolArguments: { amount: null } }))).toBe(false)
    })
  })

  // ---------------------------------------------------------------------------
  // matchInput — lte operator
  // ---------------------------------------------------------------------------

  describe('lte operator', () => {
    it('matches when resolved < condition value', () => {
      const conditions: InputCondition[] = [{ path: '$.amount', operator: 'lte', value: 100 }]
      expect(matchInput(conditions, ctx({ toolArguments: { amount: 50 } }))).toBe(true)
    })

    it('matches when resolved == condition value', () => {
      const conditions: InputCondition[] = [{ path: '$.amount', operator: 'lte', value: 100 }]
      expect(matchInput(conditions, ctx({ toolArguments: { amount: 100 } }))).toBe(true)
    })

    it('does not match when resolved > condition value', () => {
      const conditions: InputCondition[] = [{ path: '$.amount', operator: 'lte', value: 100 }]
      expect(matchInput(conditions, ctx({ toolArguments: { amount: 200 } }))).toBe(false)
    })

    it('returns false for non-numeric values', () => {
      const conditions: InputCondition[] = [{ path: '$.amount', operator: 'lte', value: 100 }]
      expect(matchInput(conditions, ctx({ toolArguments: { amount: '50' } }))).toBe(false)
    })
  })

  // ---------------------------------------------------------------------------
  // matchInput — contains operator
  // ---------------------------------------------------------------------------

  describe('contains operator', () => {
    it('matches when string value contains substring', () => {
      const conditions: InputCondition[] = [
        { path: '$.desc', operator: 'contains', value: 'urgent' },
      ]
      expect(matchInput(conditions, ctx({ toolArguments: { desc: 'This is urgent!' } }))).toBe(true)
    })

    it('does not match when string value does not contain substring', () => {
      const conditions: InputCondition[] = [
        { path: '$.desc', operator: 'contains', value: 'urgent' },
      ]
      expect(matchInput(conditions, ctx({ toolArguments: { desc: 'This is normal' } }))).toBe(false)
    })

    it('is case-sensitive', () => {
      const conditions: InputCondition[] = [
        { path: '$.desc', operator: 'contains', value: 'Urgent' },
      ]
      expect(matchInput(conditions, ctx({ toolArguments: { desc: 'this is urgent' } }))).toBe(false)
    })

    it('returns false when resolved value is not a string', () => {
      const conditions: InputCondition[] = [{ path: '$.count', operator: 'contains', value: '5' }]
      expect(matchInput(conditions, ctx({ toolArguments: { count: 5 } }))).toBe(false)
    })

    it('returns false when resolved value is undefined', () => {
      const conditions: InputCondition[] = [{ path: '$.missing', operator: 'contains', value: 'x' }]
      expect(matchInput(conditions, ctx({ toolArguments: {} }))).toBe(false)
    })

    it('returns false when resolved value is an array', () => {
      const conditions: InputCondition[] = [
        { path: '$.tags', operator: 'contains', value: 'urgent' },
      ]
      expect(
        matchInput(conditions, ctx({ toolArguments: { tags: ['urgent', 'important'] } })),
      ).toBe(false)
    })
  })

  // ---------------------------------------------------------------------------
  // matchInput — regex operator
  // ---------------------------------------------------------------------------

  describe('regex operator', () => {
    it('matches when regex matches string value', () => {
      const conditions: InputCondition[] = [
        { path: '$.email', operator: 'regex', value: '@example\\.com$', regex: /@example\.com$/ },
      ]
      expect(matchInput(conditions, ctx({ toolArguments: { email: 'user@example.com' } }))).toBe(
        true,
      )
    })

    it('does not match when regex does not match', () => {
      const conditions: InputCondition[] = [
        { path: '$.email', operator: 'regex', value: '@example\\.com$', regex: /@example\.com$/ },
      ]
      expect(matchInput(conditions, ctx({ toolArguments: { email: 'user@other.com' } }))).toBe(
        false,
      )
    })

    it('supports partial matches (no anchoring required)', () => {
      const conditions: InputCondition[] = [
        { path: '$.name', operator: 'regex', value: 'test', regex: /test/ },
      ]
      expect(matchInput(conditions, ctx({ toolArguments: { name: 'my_test_tool' } }))).toBe(true)
    })

    it('returns false when resolved value is not a string', () => {
      const conditions: InputCondition[] = [
        { path: '$.count', operator: 'regex', value: '\\d+', regex: /\d+/ },
      ]
      expect(matchInput(conditions, ctx({ toolArguments: { count: 42 } }))).toBe(false)
    })

    it('returns false when resolved value is undefined', () => {
      const conditions: InputCondition[] = [
        { path: '$.missing', operator: 'regex', value: '.*', regex: /.*/ },
      ]
      expect(matchInput(conditions, ctx({ toolArguments: {} }))).toBe(false)
    })

    it('returns false when condition.regex is undefined (defensive)', () => {
      const conditions: InputCondition[] = [{ path: '$.name', operator: 'regex', value: 'test' }]
      expect(matchInput(conditions, ctx({ toolArguments: { name: 'test' } }))).toBe(false)
    })
  })

  // ---------------------------------------------------------------------------
  // matchInput — multiple conditions (AND semantics)
  // ---------------------------------------------------------------------------

  describe('multiple conditions (AND semantics)', () => {
    it('matches when all conditions are satisfied', () => {
      const conditions: InputCondition[] = [
        { path: '$.amount', operator: 'gt', value: 100 },
        { path: '$.amount', operator: 'lt', value: 5000 },
        { path: '$.currency', operator: 'eq', value: 'USD' },
      ]
      expect(matchInput(conditions, ctx({ toolArguments: { amount: 500, currency: 'USD' } }))).toBe(
        true,
      )
    })

    it('fails when one condition is not satisfied', () => {
      const conditions: InputCondition[] = [
        { path: '$.amount', operator: 'gt', value: 100 },
        { path: '$.currency', operator: 'eq', value: 'USD' },
      ]
      expect(matchInput(conditions, ctx({ toolArguments: { amount: 500, currency: 'GBP' } }))).toBe(
        false,
      )
    })

    it('fails when all conditions are not satisfied', () => {
      const conditions: InputCondition[] = [
        { path: '$.amount', operator: 'gt', value: 1000 },
        { path: '$.currency', operator: 'eq', value: 'USD' },
      ]
      expect(matchInput(conditions, ctx({ toolArguments: { amount: 50, currency: 'GBP' } }))).toBe(
        false,
      )
    })
  })

  // ---------------------------------------------------------------------------
  // matchInput — edge cases
  // ---------------------------------------------------------------------------

  describe('edge cases', () => {
    it('returns true for empty conditions array', () => {
      expect(matchInput([], ctx({ toolArguments: { x: 1 } }))).toBe(true)
    })

    it('returns false when ctx.toolArguments is undefined and conditions exist', () => {
      const conditions: InputCondition[] = [{ path: '$.x', operator: 'eq', value: 1 }]
      expect(matchInput(conditions, ctx())).toBe(false)
    })

    it('handles array values in arguments', () => {
      const conditions: InputCondition[] = [{ path: '$.tags', operator: 'eq', value: 'urgent' }]
      // tags is an array, not a string — eq against a string should fail
      expect(matchInput(conditions, ctx({ toolArguments: { tags: ['urgent'] } }))).toBe(false)
    })

    it('returns false for NaN values with numeric operators', () => {
      const conditions: InputCondition[] = [{ path: '$.amount', operator: 'gt', value: 100 }]
      expect(matchInput(conditions, ctx({ toolArguments: { amount: NaN } }))).toBe(false)
    })

    it('blocks __proto__ path traversal', () => {
      const conditions: InputCondition[] = [
        { path: '$.__proto__.polluted', operator: 'eq', value: true },
      ]
      expect(matchInput(conditions, ctx({ toolArguments: {} }))).toBe(false)
    })

    it('blocks constructor path traversal', () => {
      const conditions: InputCondition[] = [
        { path: '$.constructor', operator: 'neq', value: undefined },
      ]
      // resolvePath returns undefined for unsafe segments, so neq undefined → false
      expect(matchInput(conditions, ctx({ toolArguments: {} }))).toBe(false)
    })

    it('blocks prototype path traversal', () => {
      const conditions: InputCondition[] = [{ path: '$.prototype', operator: 'eq', value: 'x' }]
      expect(matchInput(conditions, ctx({ toolArguments: {} }))).toBe(false)
    })
  })
})

// ---------------------------------------------------------------------------
// matchEnvironment
// ---------------------------------------------------------------------------

describe('matchEnvironment', () => {
  it('matches exact environment string', () => {
    expect(matchEnvironment('production', ctx({ environment: 'production' }))).toBe(true)
  })

  it('does not match different environment', () => {
    expect(matchEnvironment('production', ctx({ environment: 'staging' }))).toBe(false)
  })

  it('returns false when ctx.environment is undefined', () => {
    expect(matchEnvironment('production', ctx())).toBe(false)
  })

  it('is case-sensitive', () => {
    expect(matchEnvironment('Production', ctx({ environment: 'production' }))).toBe(false)
  })

  it('matches empty string to empty string', () => {
    expect(matchEnvironment('', ctx({ environment: '' }))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// matchRule — integration
// ---------------------------------------------------------------------------

describe('matchRule', () => {
  it('empty match block matches everything', () => {
    const rule = compileRule({})
    expect(matchRule(rule, ctx())).toBe(true)
    expect(matchRule(rule, ctx({ toolName: 'anything', environment: 'prod' }))).toBe(true)
  })

  it('tool-only rule matches correct tool', () => {
    const rule = compileRule({ tool: 'send_*' })
    expect(matchRule(rule, ctx({ toolName: 'send_email' }))).toBe(true)
  })

  it('tool-only rule does not match wrong tool', () => {
    const rule = compileRule({ tool: 'send_*' })
    expect(matchRule(rule, ctx({ toolName: 'receive_email' }))).toBe(false)
  })

  it('annotations-only rule matches when annotations satisfy', () => {
    const rule = compileRule({ annotations: { destructiveHint: true } })
    expect(matchRule(rule, ctx({ annotations: { destructiveHint: true } }))).toBe(true)
  })

  it('annotations-only rule does not match when annotations differ', () => {
    const rule = compileRule({ annotations: { readOnlyHint: true } })
    expect(matchRule(rule, ctx({ annotations: { readOnlyHint: false } }))).toBe(false)
  })

  it('environment-only rule matches correct environment', () => {
    const rule = compileRule({ environment: 'production' })
    expect(matchRule(rule, ctx({ environment: 'production' }))).toBe(true)
  })

  it('environment-only rule does not match wrong environment', () => {
    const rule = compileRule({ environment: 'production' })
    expect(matchRule(rule, ctx({ environment: 'staging' }))).toBe(false)
  })

  it('combined tool + environment — both match', () => {
    const rule = compileRule({ tool: 'deploy_*', environment: 'production' })
    expect(matchRule(rule, ctx({ toolName: 'deploy_service', environment: 'production' }))).toBe(
      true,
    )
  })

  it('combined tool + environment — tool matches, environment does not', () => {
    const rule = compileRule({ tool: 'deploy_*', environment: 'production' })
    expect(matchRule(rule, ctx({ toolName: 'deploy_service', environment: 'staging' }))).toBe(false)
  })

  it('combined tool + environment — environment matches, tool does not', () => {
    const rule = compileRule({ tool: 'deploy_*', environment: 'production' })
    expect(matchRule(rule, ctx({ toolName: 'read_config', environment: 'production' }))).toBe(false)
  })

  it('rule with input conditions matches correct arguments', () => {
    const rule = compileRule({
      tool: 'create_payment',
      input: { '$.amount': { gt: 1000 } },
    })
    expect(
      matchRule(rule, ctx({ toolName: 'create_payment', toolArguments: { amount: 5000 } })),
    ).toBe(true)
  })

  it('rule with input conditions does not match wrong arguments', () => {
    const rule = compileRule({
      tool: 'create_payment',
      input: { '$.amount': { gt: 1000 } },
    })
    expect(
      matchRule(rule, ctx({ toolName: 'create_payment', toolArguments: { amount: 50 } })),
    ).toBe(false)
  })

  it('combined tool + annotations + input + environment — all match', () => {
    const rule = compileRule({
      tool: 'create_payment',
      annotations: { destructiveHint: true },
      input: { '$.amount': { gt: 100 } },
      environment: 'production',
    })
    expect(
      matchRule(
        rule,
        ctx({
          toolName: 'create_payment',
          annotations: { destructiveHint: true },
          toolArguments: { amount: 500 },
          environment: 'production',
        }),
      ),
    ).toBe(true)
  })

  it('combined rule — one dimension fails causes overall mismatch', () => {
    const rule = compileRule({
      tool: 'create_payment',
      annotations: { destructiveHint: true },
      input: { '$.amount': { gt: 100 } },
      environment: 'production',
    })
    // everything matches except environment
    expect(
      matchRule(
        rule,
        ctx({
          toolName: 'create_payment',
          annotations: { destructiveHint: true },
          toolArguments: { amount: 500 },
          environment: 'staging',
        }),
      ),
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// matchRule with compiled policies — end-to-end
// ---------------------------------------------------------------------------

describe('matchRule with compiled policies', () => {
  it('finds correct matching rule in multi-rule policy', () => {
    const { policy } = compilePolicies({
      default: 'allow',
      dry_run: false,
      rules: [
        { match: { tool: 'read_*' }, action: 'allow' },
        { match: { tool: 'write_*' }, action: 'deny' },
        { match: { tool: '*' }, action: 'require_approval' },
      ],
    })

    const writeCtx = ctx({ toolName: 'write_file' })

    // First rule should not match
    const rule0 = policy.rules[0]
    if (!rule0) throw new Error('expected rule 0')
    expect(matchRule(rule0, writeCtx)).toBe(false)

    // Second rule should match
    const rule1 = policy.rules[1]
    if (!rule1) throw new Error('expected rule 1')
    expect(matchRule(rule1, writeCtx)).toBe(true)
    expect(rule1.action).toBe('deny')
  })

  it('no rules match — all return false', () => {
    const { policy } = compilePolicies({
      default: 'allow',
      dry_run: false,
      rules: [
        { match: { tool: 'read_*' }, action: 'allow' },
        { match: { tool: 'write_*' }, action: 'deny' },
      ],
    })

    const deleteCtx = ctx({ toolName: 'delete_file' })
    const matched = policy.rules.find((r) => matchRule(r, deleteCtx))
    expect(matched).toBeUndefined()
  })

  it('catch-all rule at end matches everything', () => {
    const { policy } = compilePolicies({
      default: 'deny',
      dry_run: false,
      rules: [
        { match: { tool: 'read_*' }, action: 'allow' },
        { match: { tool: '*' }, action: 'deny' },
      ],
    })

    const unknownCtx = ctx({ toolName: 'unknown_tool' })
    const matched = policy.rules.find((r) => matchRule(r, unknownCtx))
    expect(matched).toBeDefined()
    expect(matched?.action).toBe('deny')
  })
})
