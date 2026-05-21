import type { CompiledPolicy, CompiledPolicyRule, MatchContext, PolicyAction } from './types.js'
import { matchRule } from './matchers.js'

// ---------------------------------------------------------------------------
// Policy decision — the result of evaluating a request against the policy.
// ---------------------------------------------------------------------------

/** The result of evaluating a tools/call request against the compiled policy. */
export interface PolicyDecision {
  /** The action dictated by the matched rule (or the default policy). */
  readonly action: PolicyAction
  /** The rule that matched, if any. Undefined when the default policy was applied. */
  readonly matchedRule?: CompiledPolicyRule
  /** Human-readable explanation of the decision. */
  readonly reason: string
}

// ---------------------------------------------------------------------------
// Policy evaluation — first-match-wins against compiled rules.
// ---------------------------------------------------------------------------

/**
 * Evaluate a tools/call request against the compiled policy.
 *
 * Iterates the policy rules in definition order and returns the decision from
 * the first matching rule (first-match-wins). If no rule matches, the policy's
 * default action is applied.
 *
 * This function is pure and synchronous — no I/O, no side effects. It is the
 * hot path and must complete in well under 1ms for any reasonable rule count.
 */
export function evaluatePolicy(policy: CompiledPolicy, ctx: MatchContext): PolicyDecision {
  for (const rule of policy.rules) {
    if (matchRule(rule, ctx)) {
      const ruleName = rule.name ? `"${rule.name}"` : `rule[${String(rule.index)}]`
      return {
        action: rule.action,
        matchedRule: rule,
        reason: `Matched ${ruleName} → ${rule.action}`,
      }
    }
  }

  return {
    action: policy.defaultAction,
    matchedRule: undefined,
    reason: `No matching rule; applied default policy: ${policy.defaultAction}`,
  }
}
