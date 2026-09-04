import { basename } from 'node:path'
import { z } from 'zod'
import { POLICY_RELOAD_OUTCOMES } from '../config/reload-outcomes.js'
import type { PolicyReloadOutcome } from '../config/reload-outcomes.js'
import type { PolicyReloadFacts } from '../config/watcher.js'
import type { AuditRecord, AuditRecordInput } from './types.js'

/** The constant `policy_decision` of a reload record; the outcome lives in `block_reason` and the evidence. */
export const POLICY_RELOAD_DECISION = 'policy_reload'

export interface PolicyReloadEvidence {
  readonly outcome: PolicyReloadOutcome
  readonly config_path: string
  readonly sha256_before: string
  readonly sha256_after: string | null
  readonly rule_count_before: number
  readonly rule_count_after: number | null
  readonly default_action_before: 'allow' | 'deny'
  readonly default_action_after: 'allow' | 'deny' | null
  readonly budget_count_before: number
  readonly budget_count_after: number | null
  readonly rules_removed: readonly string[]
  readonly restart_required_paths: readonly string[]
  readonly error: string | null
}

/** Map the watcher's facts to the wire shape persisted under `evidence_chain.policy_reload`. */
export function policyReloadEvidence(facts: PolicyReloadFacts): PolicyReloadEvidence {
  return {
    outcome: facts.outcome,
    config_path: facts.configPath,
    sha256_before: facts.sha256Before,
    sha256_after: facts.sha256After,
    rule_count_before: facts.ruleCountBefore,
    rule_count_after: facts.ruleCountAfter,
    default_action_before: facts.defaultActionBefore,
    default_action_after: facts.defaultActionAfter,
    budget_count_before: facts.budgetCountBefore,
    budget_count_after: facts.budgetCountAfter,
    rules_removed: [...facts.rulesRemoved],
    restart_required_paths: [...facts.restartRequiredPaths],
    error: facts.error,
  }
}

/**
 * Shape one reload attempt as an audit record (issue #341), on the drift
 * record precedent: the NOT NULL columns carry sentinels (`tool_name` is
 * the config basename, `tool_input` is `{}`, durations are 0), the
 * decision is the constant `policy_reload` so analytics can exclude the
 * kind, and the outcome is the `block_reason` (null when applied).
 */
export function buildPolicyReloadRecord(
  facts: PolicyReloadFacts,
  environment: string | null,
): AuditRecordInput {
  return {
    timestamp: new Date().toISOString(),
    session_id: null,
    session_source: null,
    agent_id: null,
    environment,
    tool_name: basename(facts.configPath),
    tool_input: {},
    policy_decision: POLICY_RELOAD_DECISION,
    block_reason: facts.outcome === 'applied' ? null : facts.outcome,
    matched_rule: null,
    matched_rule_index: null,
    evidence_chain: { policy_reload: policyReloadEvidence(facts) },
    approval_status: null,
    approved_by: null,
    upstream_response: null,
    upstream_error: null,
    upstream_http_status: null,
    upstream_latency_ms: null,
    total_duration_ms: 0,
    approval_wait_ms: 0,
    proxy_compute_ms: 0,
    flagged_destructive: false,
    dry_run: false,
    record_kind: 'policy_reload',
    origin: 'config',
    metadata: null,
    protocol_version: null,
    upstream: null,
  }
}

/** The persisted shape, validated whole on read: a partial object is not an event. */
const policyReloadEvidenceSchema = z
  .object({
    outcome: z.enum(POLICY_RELOAD_OUTCOMES),
    config_path: z.string(),
    sha256_before: z.string(),
    sha256_after: z.string().nullable(),
    rule_count_before: z.number(),
    rule_count_after: z.number().nullable(),
    default_action_before: z.enum(['allow', 'deny']),
    default_action_after: z.enum(['allow', 'deny']).nullable(),
    budget_count_before: z.number(),
    budget_count_after: z.number().nullable(),
    rules_removed: z.array(z.string()),
    restart_required_paths: z.array(z.string()),
    error: z.string().nullable(),
  })
  .strict()

/** The one narrowing read of a reload record's evidence; null for any other kind, a missing object, or a shape the builder did not write. */
export function readPolicyReloadEvidence(
  record: Pick<AuditRecord, 'record_kind' | 'evidence_chain'>,
): PolicyReloadEvidence | null {
  if (record.record_kind !== 'policy_reload') return null
  const parsed = policyReloadEvidenceSchema.safeParse(record.evidence_chain?.['policy_reload'])
  return parsed.success ? parsed.data : null
}
