// ---------------------------------------------------------------------------
// Decision pipeline — the side-effect-free policy decision half shared by the
// MCP forwarder and the sideband governance API (issue #12, D2).
//
// `decide()` is the portion of the old GovernedForwarder.handleToolsCall that
// turns a tool call into a PolicyDecision: rule evaluation, drift gating,
// flag_destructive escalation, and evidence/dependency grounding. It computes
// what should happen but **never touches limiter state** — each caller applies
// the limiter step itself (the MCP path consumes via check() at execution
// time; the sideband peeks at /evaluate and records at /audit). Keeping this
// here means both paths share one engine instead of forking security-critical
// orchestration.
// ---------------------------------------------------------------------------

import type { CompiledPolicy, PolicyAction, ToolAnnotationHints } from './types.js'
import { evaluatePolicy } from './engine.js'
import type { PolicyDecision } from './engine.js'
import type { ToolDriftEvent } from './annotation-cache.js'
import type { EvidenceStore } from '../evidence/store.js'
import { checkEvidence, checkDependencies } from '../evidence/grounding.js'
import type { EvidenceCheckResult, DependencyCheckResult } from '../evidence/grounding.js'

/** Drift response mode resolved from `policies.on_tool_drift` (default block). */
export type DriftMode = 'block' | 'require_approval' | 'log'

/**
 * Everything `decide()` needs about one tool call. Annotation lookups are
 * passed in resolved (the MCP path reads them from its single cache; the
 * sideband from a per-origin cache) so the pipeline does not depend on any
 * particular cache instance.
 */
export interface DecideInput {
  readonly toolName: string
  readonly toolArguments: Record<string, unknown> | undefined
  readonly sessionId: string | undefined
  readonly policy: CompiledPolicy
  readonly environment: string | undefined
  readonly evidenceStore: EvidenceStore | undefined
  /** Baseline annotations — the definition the operator reviewed. */
  readonly baselineAnnotations: ToolAnnotationHints | undefined
  /** Latest-claim annotations — used for stricter-of-both in drift log mode. */
  readonly currentAnnotations: ToolAnnotationHints | undefined
  /** Active drift event for this tool, if its definition moved off baseline. */
  readonly driftEvent: ToolDriftEvent | undefined
}

/** The decision plus all the metadata the execution/audit steps consume. */
export interface PipelineDecision {
  /** Final decision after drift gate, flag_destructive, and evidence checks. */
  readonly decision: PolicyDecision
  /** The action before evidence checks may have overridden it to `deny`. */
  readonly originalAction: PolicyAction
  readonly driftEvent: ToolDriftEvent | undefined
  readonly driftMode: DriftMode
  readonly driftBlocked: boolean
  readonly flaggedDestructive: boolean
  readonly evidenceResult: EvidenceCheckResult | undefined
  readonly dependencyResult: DependencyCheckResult | undefined
  readonly evidenceBlocked: boolean
  readonly sessionBlocked: boolean
  readonly isDryRun: boolean
}

/**
 * Run the policy decision pipeline for one tool call.
 *
 * Pure with respect to limiter and audit state. The only side effect is an
 * operational `console.error` when `flag_destructive: log` matches an
 * unguarded destructive tool — preserved verbatim from the original forwarder
 * so MCP behavior is bit-identical.
 */
export function decide(input: DecideInput): PipelineDecision {
  const { toolName, toolArguments, sessionId, policy, environment, evidenceStore } = input

  const annotations = input.baselineAnnotations
  const driftEvent = input.driftEvent
  const driftMode: DriftMode = policy.onToolDrift ?? 'block'

  let decision = evaluatePolicy(policy, {
    toolName,
    annotations,
    toolArguments,
    environment,
  })

  // In log mode a drifted tool is evaluated against BOTH the baseline
  // annotations (what the operator reviewed) and the current upstream claim —
  // the stricter decision wins, so a definition flip cannot weaken enforcement
  // in either direction.
  if (driftEvent && driftMode === 'log') {
    const currentDecision = evaluatePolicy(policy, {
      toolName,
      annotations: input.currentAnnotations,
      toolArguments,
      environment,
    })
    decision = stricterDecision(decision, currentDecision)
  }

  // Irreversible action detection: when no explicit rule matched, check if the
  // tool is destructive and apply flag_destructive behavior.
  const baselineDestructive = annotations?.destructiveHint ?? true // MCP default
  const currentDestructive =
    driftEvent && driftMode === 'log' ? (input.currentAnnotations?.destructiveHint ?? true) : false
  const isDestructive = baselineDestructive || currentDestructive
  let flaggedDestructive = false

  if (isDestructive && !decision.matchedRule && policy.flagDestructive) {
    flaggedDestructive = true

    if (policy.flagDestructive === 'log') {
      // eslint-disable-next-line no-console -- Intentional operational warning
      console.error(`[helio] Destructive tool detected: ${toolName} (no matching rule)`)
    } else {
      // require_approval — override the decision to escalate
      decision = {
        action: 'require_approval',
        matchedRule: undefined,
        reason: `Destructive tool "${toolName}" auto-escalated by flag_destructive policy`,
      }
    }
  }

  // Tool definition drift gate: a drifted tool no longer matches the definition
  // the operator reviewed, so on_tool_drift overrides whatever rule evaluation
  // produced ("log" leaves the decision untouched).
  let driftBlocked = false
  if (driftEvent && driftMode !== 'log') {
    driftBlocked = driftMode === 'block'
    decision = {
      action: driftMode === 'block' ? 'deny' : 'require_approval',
      matchedRule: undefined,
      reason: `Tool "${toolName}" definition drifted from baseline (${driftEvent.changes
        .map((change) => change.aspect)
        .join(', ')})`,
    }
  }

  // Capture original action before evidence checks may override to 'deny'
  const originalAction = decision.action

  // Evidence grounding + dependency chain checks. Gate all non-deny actions
  // (allow, require_approval, dry_run, etc.)
  let evidenceResult: EvidenceCheckResult | undefined
  let dependencyResult: DependencyCheckResult | undefined
  let evidenceBlocked = false
  let sessionBlocked = false

  const requiresGroundedSession =
    decision.action !== 'deny' &&
    !!decision.matchedRule &&
    ((decision.matchedRule.evidence?.requires.length ?? 0) > 0 ||
      (decision.matchedRule.requires?.length ?? 0) > 0)

  if (requiresGroundedSession && !sessionId) {
    sessionBlocked = true
    evidenceBlocked = true
    decision = {
      action: 'deny',
      matchedRule: decision.matchedRule,
      reason: 'Mcp-Session-Id is required for evidence/dependency-gated policy rules',
    }
  }

  if (decision.action !== 'deny' && evidenceStore && sessionId && decision.matchedRule) {
    const rule = decision.matchedRule

    // Check evidence.requires
    if (rule.evidence?.requires.length) {
      evidenceResult = checkEvidence(evidenceStore, sessionId, rule.evidence.requires)
      if (!evidenceResult.satisfied) {
        evidenceBlocked = true
        const problemKeys = [...evidenceResult.missing, ...evidenceResult.expired]
        decision = {
          action: 'deny',
          matchedRule: rule,
          reason: `Required evidence not satisfied: ${problemKeys.join(', ')}`,
        }
      }
    }

    // Check requires (dependency chains) — only if evidence check passed
    if (!evidenceBlocked && rule.requires?.length) {
      dependencyResult = checkDependencies(evidenceStore, sessionId, rule.requires, {
        requireSuccess: rule.requiresSuccess ?? true,
      })
      if (!dependencyResult.satisfied) {
        evidenceBlocked = true
        decision = {
          action: 'deny',
          matchedRule: rule,
          reason: `Required tool calls not completed: ${dependencyResult.missing.join(', ')}`,
        }
      }
    }
  }

  // Dry-run detection: per-rule (action: dry_run) or global (policies.dry_run)
  const isPerRuleDryRun = originalAction === 'dry_run'
  const isGlobalDryRun = policy.dryRun === true
  const isDryRun = (isPerRuleDryRun || isGlobalDryRun) && !sessionBlocked

  return {
    decision,
    originalAction,
    driftEvent,
    driftMode,
    driftBlocked,
    flaggedDestructive,
    evidenceResult,
    dependencyResult,
    evidenceBlocked,
    sessionBlocked,
    isDryRun,
  }
}

/**
 * Strictness ranking for policy actions — higher wins in stricter-of-both
 * (log-mode drift evaluation). The ranking encodes whether an action can reach
 * upstream and how strongly the operator constrained it:
 * - deny and require_approval dominate everything (require_approval may
 *   forward, but only through an explicit human gate);
 * - dry_run outranks the limit actions and allow because it never forwards;
 * - between the two limit actions, cross-conflicts (baseline matches one,
 *   current matches the other) deterministically pick spend_limit. Log mode is
 *   advisory by operator choice; operators needing hard guarantees use the
 *   default "block".
 */
const ACTION_SEVERITY: Record<PolicyAction, number> = {
  deny: 5,
  require_approval: 4,
  dry_run: 3,
  spend_limit: 2,
  rate_limit: 1,
  allow: 0,
}

/** Pick the stricter of two policy decisions (ties keep the first). */
export function stricterDecision(a: PolicyDecision, b: PolicyDecision): PolicyDecision {
  return ACTION_SEVERITY[b.action] > ACTION_SEVERITY[a.action] ? b : a
}
