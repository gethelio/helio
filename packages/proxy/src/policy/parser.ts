import picomatch from 'picomatch'
import safeRegex from 'safe-regex2'
import { parseDuration } from '../config/schema.js'
import type { PoliciesConfig, PolicyRule } from '../config/schema.js'
import { PolicyParseError } from './errors.js'
import type {
  CompiledApproval,
  CompiledLimits,
  CompiledMatch,
  CompiledPolicy,
  CompiledPolicyRule,
  CompilePoliciesResult,
  InputCondition,
  PolicyParseWarning,
  ToolMatcher,
} from './types.js'

/** Operators that can appear in an input condition object. */
const INPUT_OPERATORS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'regex'] as const

/**
 * Compile a validated PoliciesConfig into engine-ready form.
 *
 * Transforms raw config types into compiled types with pre-built glob
 * matchers, pre-compiled regexes, and pre-parsed durations. Returns
 * warnings for semantic issues (e.g. missing approval config).
 *
 * @throws {PolicyParseError} On invalid glob patterns or regex strings.
 */
export function compilePolicies(config: PoliciesConfig): CompilePoliciesResult {
  const warnings: PolicyParseWarning[] = []

  const rules = config.rules.map((rule, index) => compileRule(rule, index, warnings))

  const policy: CompiledPolicy = {
    defaultAction: config.default,
    flagDestructive: config.flag_destructive,
    ...(config.dry_run && { dryRun: true }),
    ...(config.on_tool_drift && { onToolDrift: config.on_tool_drift }),
    rules,
  }

  return { policy, warnings }
}

function compileRule(
  rule: PolicyRule,
  index: number,
  warnings: PolicyParseWarning[],
): CompiledPolicyRule {
  const match = compileMatch(rule.match, index, rule.name)
  const approval = compileApproval(rule.approval)
  const limits = compileLimits(rule.limits)

  checkSemanticWarnings(rule, index, warnings)

  return {
    index,
    ...(rule.name !== undefined && { name: rule.name }),
    match,
    action: rule.action,
    ...(approval !== undefined && { approval }),
    ...(rule.evidence !== undefined && { evidence: { requires: rule.evidence.requires } }),
    ...(rule.requires !== undefined && { requires: rule.requires }),
    ...(rule.requires_success !== undefined && { requiresSuccess: rule.requires_success }),
    ...(limits !== undefined && { limits }),
    ...(rule.feedback !== undefined && {
      feedback: {
        message: rule.feedback.message,
        ...(rule.feedback.suggestion !== undefined && { suggestion: rule.feedback.suggestion }),
      },
    }),
  }
}

function compileMatch(
  match: PolicyRule['match'],
  ruleIndex: number,
  ruleName?: string,
): CompiledMatch {
  return {
    ...(match.tool !== undefined && {
      tool: compileToolMatcher(match.tool, ruleIndex, ruleName),
    }),
    ...(match.annotations !== undefined && { annotations: { ...match.annotations } }),
    ...(match.input !== undefined && {
      input: flattenInputConditions(match.input, ruleIndex, ruleName),
    }),
    ...(match.environment !== undefined && { environment: match.environment }),
  }
}

function compileToolMatcher(pattern: string, ruleIndex: number, ruleName?: string): ToolMatcher {
  try {
    const test = picomatch(pattern, { dot: true })
    return { pattern, test }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new PolicyParseError(`invalid glob pattern "${pattern}": ${message}`, ruleIndex, ruleName)
  }
}

function flattenInputConditions(
  input: Record<string, Record<string, unknown>>,
  ruleIndex: number,
  ruleName?: string,
): InputCondition[] {
  const conditions: InputCondition[] = []

  for (const [path, conditionObj] of Object.entries(input)) {
    for (const op of INPUT_OPERATORS) {
      const value = conditionObj[op]
      if (value === undefined) continue

      if (op === 'regex') {
        if (typeof value !== 'string') {
          throw new PolicyParseError(
            `regex value for input path "${path}" must be a string`,
            ruleIndex,
            ruleName,
          )
        }
        // Reject catastrophic-backtracking patterns at compile time so a
        // fat-fingered operator regex cannot hang the policy hot path on a
        // large tool input. safe-regex2 is a static analyzer — zero runtime
        // cost after load — and rejects nested-quantifier and
        // overlapping-alternation patterns that ret's AST walker flags as
        // exponential.
        if (!safeRegex(value)) {
          throw new PolicyParseError(
            `catastrophic regex "${value}" for input path "${path}": ` +
              `pattern is vulnerable to ReDoS and has been rejected. ` +
              `Rewrite with bounded quantifiers (e.g. {1,100}) or split into simpler rules.`,
            ruleIndex,
            ruleName,
          )
        }
        let compiledRegex: RegExp
        try {
          compiledRegex = new RegExp(value)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          throw new PolicyParseError(
            `invalid regex "${value}" for input path "${path}": ${msg}`,
            ruleIndex,
            ruleName,
          )
        }
        conditions.push({ path, operator: op, value, regex: compiledRegex })
      } else {
        conditions.push({ path, operator: op, value })
      }
    }
  }

  return conditions
}

function compileApproval(approval: PolicyRule['approval']): CompiledApproval | undefined {
  if (!approval) return undefined

  return {
    channel: approval.channel,
    ...(approval.timeout !== undefined && { timeoutMs: parseDuration(approval.timeout) }),
    ...(approval.delegates !== undefined && { delegates: approval.delegates }),
    ...(approval.escalation_after !== undefined && {
      escalationAfterMs: parseDuration(approval.escalation_after),
    }),
  }
}

function compileLimits(limits: PolicyRule['limits']): CompiledLimits | undefined {
  if (!limits) return undefined

  return {
    ...(limits.max_calls !== undefined && { maxCalls: limits.max_calls }),
    ...(limits.window !== undefined && { windowMs: parseDuration(limits.window) }),
    ...(limits.key !== undefined && { key: limits.key }),
    ...(limits.max_spend !== undefined && {
      maxSpend: {
        field: limits.max_spend.field,
        limit: limits.max_spend.limit,
        currency: limits.max_spend.currency,
        windowMs: parseDuration(limits.max_spend.window),
        ...(limits.max_spend.key !== undefined && { key: limits.max_spend.key }),
      },
    }),
  }
}

function checkSemanticWarnings(
  rule: PolicyRule,
  index: number,
  warnings: PolicyParseWarning[],
): void {
  const warn = (message: string) =>
    warnings.push({ ruleIndex: index, ruleName: rule.name, message })

  if (rule.action === 'require_approval' && !rule.approval) {
    warn('action is "require_approval" but no "approval" configuration is provided')
  }

  if (rule.action === 'rate_limit' && !rule.limits?.max_calls) {
    warn('action is "rate_limit" but no "limits.max_calls" is configured')
  }

  if (rule.limits?.key === 'agent') {
    warn(
      'limits.key "agent" is not yet supported — agent identity is not available on MCP requests. Use "tool" or "session" instead.',
    )
  }

  if (rule.limits?.max_spend?.key === 'agent') {
    warn(
      'limits.max_spend.key "agent" is not yet supported — agent identity is not available on MCP requests. Use "tool" or "session" instead.',
    )
  }

  if (rule.action === 'spend_limit' && !rule.limits?.max_spend) {
    warn('action is "spend_limit" but no "limits.max_spend" is configured')
  }

  if (rule.action === 'dry_run' && rule.approval) {
    warn('action is "dry_run" but "approval" configuration is present (will be ignored)')
  }

  if (rule.action === 'dry_run' && rule.limits) {
    warn('action is "dry_run" but "limits" configuration is present (will be ignored)')
  }

  if (rule.approval?.escalation_after && !rule.approval.delegates?.length) {
    warn(
      '"escalation_after" is set but no "delegates" are configured — escalation will re-notify the primary channel',
    )
  }

  if (rule.approval?.escalation_after && rule.approval.timeout) {
    const escalationMs = parseDuration(rule.approval.escalation_after)
    const timeoutMs = parseDuration(rule.approval.timeout)
    if (escalationMs >= timeoutMs) {
      warn(
        '"escalation_after" is >= "timeout" — escalation will never fire before the approval times out',
      )
    }
  }
}
