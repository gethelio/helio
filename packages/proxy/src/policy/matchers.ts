// ---------------------------------------------------------------------------
// Policy matchers — runtime evaluation of compiled policy rules.
//
// Each matcher tests one dimension of a CompiledMatch against a MatchContext.
// The top-level matchRule function AND-combines all dimensions.
// ---------------------------------------------------------------------------

import type {
  AnnotationMatch,
  CompiledPolicyRule,
  InputCondition,
  MatchContext,
  ToolAnnotationHints,
  ToolMatcher,
} from './types.js'

// ---------------------------------------------------------------------------
// MCP annotation defaults (per spec)
// ---------------------------------------------------------------------------

const ANNOTATION_DEFAULTS: Required<ToolAnnotationHints> = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/** Segments that must not be traversed to prevent prototype pollution. */
const UNSAFE_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * Resolve a JSONPath-style dot-path against a tool arguments object.
 *
 * Supports simple property access: `$.amount`, `$.user.name`, `$.a.b.c`.
 * Returns `undefined` if the path does not exist or any intermediate
 * value is null/undefined/non-object.
 */
export function resolvePath(path: string, args: Readonly<Record<string, unknown>>): unknown {
  if (path === '$') return args

  const normalized = path.startsWith('$.') ? path.slice(2) : path
  const segments = normalized.split('.')

  let current: unknown = args
  for (const segment of segments) {
    if (UNSAFE_SEGMENTS.has(segment)) return undefined
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined
    }
    current = (current as Record<string, unknown>)[segment]
  }

  return current
}

// ---------------------------------------------------------------------------
// Condition evaluation
// ---------------------------------------------------------------------------

/** Evaluate a single input condition against a resolved value. */
function evaluateCondition(condition: InputCondition, value: unknown): boolean {
  switch (condition.operator) {
    case 'eq':
      return value === condition.value
    case 'neq':
      return value !== undefined && value !== condition.value
    case 'gt':
      return (
        typeof value === 'number' && typeof condition.value === 'number' && value > condition.value
      )
    case 'gte':
      return (
        typeof value === 'number' && typeof condition.value === 'number' && value >= condition.value
      )
    case 'lt':
      return (
        typeof value === 'number' && typeof condition.value === 'number' && value < condition.value
      )
    case 'lte':
      return (
        typeof value === 'number' && typeof condition.value === 'number' && value <= condition.value
      )
    case 'contains':
      return (
        typeof value === 'string' &&
        typeof condition.value === 'string' &&
        value.includes(condition.value)
      )
    case 'regex':
      return (
        typeof value === 'string' && condition.regex !== undefined && condition.regex.test(value)
      )
  }
}

// ---------------------------------------------------------------------------
// Individual matchers
// ---------------------------------------------------------------------------

/**
 * Test whether the tool name matches the compiled glob pattern.
 * Returns false if `ctx.toolName` is undefined.
 */
export function matchTool(matcher: ToolMatcher, ctx: MatchContext): boolean {
  if (ctx.toolName === undefined) return false
  return matcher.test(ctx.toolName)
}

/**
 * Test whether the tool's annotations satisfy the required annotation conditions.
 *
 * Only checks annotation fields that are explicitly set in the AnnotationMatch.
 * When an annotation field is missing from the tool's metadata, MCP spec defaults
 * are applied (destructiveHint=true, readOnlyHint=false, etc.).
 */
export function matchAnnotations(required: AnnotationMatch, ctx: MatchContext): boolean {
  const keys = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const

  for (const key of keys) {
    const requiredValue = required[key]
    if (requiredValue === undefined) continue

    const actual = ctx.annotations?.[key] ?? ANNOTATION_DEFAULTS[key]
    if (actual !== requiredValue) return false
  }

  return true
}

/**
 * Test whether ALL input conditions match against the tool arguments.
 * Returns false if `ctx.toolArguments` is undefined and conditions exist.
 * All conditions are AND'd — every condition must pass.
 */
export function matchInput(conditions: readonly InputCondition[], ctx: MatchContext): boolean {
  if (conditions.length === 0) return true
  if (ctx.toolArguments === undefined) return false

  for (const condition of conditions) {
    const resolved = resolvePath(condition.path, ctx.toolArguments)
    if (!evaluateCondition(condition, resolved)) return false
  }

  return true
}

/**
 * Test whether the context's environment matches the required environment string.
 * Returns false if `ctx.environment` is undefined. Case-sensitive exact match.
 */
export function matchEnvironment(required: string, ctx: MatchContext): boolean {
  if (ctx.environment === undefined) return false
  return ctx.environment === required
}

// ---------------------------------------------------------------------------
// Top-level rule matcher
// ---------------------------------------------------------------------------

/**
 * Evaluate whether a compiled policy rule matches the given context.
 *
 * All present conditions in the rule's match block are AND'd together.
 * A condition that is absent/undefined in the CompiledMatch is treated
 * as "don't care" — it always passes. Short-circuits on the first false.
 */
export function matchRule(rule: CompiledPolicyRule, ctx: MatchContext): boolean {
  const { match } = rule

  if (match.tool !== undefined && !matchTool(match.tool, ctx)) return false
  if (match.annotations !== undefined && !matchAnnotations(match.annotations, ctx)) return false
  if (match.input !== undefined && !matchInput(match.input, ctx)) return false
  if (match.environment !== undefined && !matchEnvironment(match.environment, ctx)) return false

  return true
}
