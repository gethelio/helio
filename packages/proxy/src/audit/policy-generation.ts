import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { z } from 'zod'
import type { AuditStore } from './store.js'
import type { AuditRecord, AuditRecordInput } from './types.js'
import { AuditWriter } from './writer.js'

// ---------------------------------------------------------------------------
// The policy generation provenance record (issue #522): one row per
// generation run that classified definitions, on the simulation-record
// precedent. The decision column holds a constant so analytics can exclude
// the kind; the row's `config_sha256` is the candidate's hash when a
// candidate was written (the writer stamps it) and null otherwise; the run's
// facts live under `evidence_chain.policy_generation`.
// ---------------------------------------------------------------------------

/** The constant `policy_decision` of a generation record. */
export const POLICY_GENERATION_DECISION = 'policy_generation'

/** The `tool_name` sentinel when no candidate file was written. */
export const POLICY_GENERATION_TOOL_NAME = '<policy_generation>'

/** The facts of one run, persisted under `evidence_chain.policy_generation`. */
export interface PolicyGenerationEvidence {
  /** The written candidate's hash; null when no file was written. */
  readonly candidate_sha256: string | null
  readonly source_config_sha256: string
  readonly helio_version: string
  /** `MIN(created_at)` of the window's observed rows; null on an empty window. */
  readonly traffic_start: string | null
  /** `MAX(created_at)` of the window's observed rows; null on an empty window. */
  readonly traffic_end: string | null
  readonly call_count: number
  /** Rows grouped by (tool, upstream, origin), on a listed door or not. */
  readonly pairs_observed: number
  /** Definition pairs classified. */
  readonly pairs_exposed: number
  /** Rules in the written candidate; 0 on a refusal or an empty writable set. */
  readonly rules_generated: number
  readonly rules_kept: number
  readonly needs_decision: number
  readonly eligible_unobserved: number
  /** Pairs under the two `Needs dashboard.*` headings together. */
  readonly needs_dashboard: number
  /** The source default always; the candidate half null when no file was written. */
  readonly default_action: {
    readonly source: 'allow' | 'deny'
    readonly candidate: 'allow' | 'deny' | null
  }
  readonly annotation_source: 'proxy' | 'demo'
}

/** What the builder takes: where the candidate went, the operator's environment label, the facts. */
export interface PolicyGenerationRecordInput {
  readonly candidatePath: string | null
  readonly environment: string | null
  readonly evidence: PolicyGenerationEvidence
}

/**
 * Shape one generation run as an audit record, on the simulation sentinel
 * (issue #490): the NOT NULL columns carry sentinels (`tool_name` is the
 * candidate's basename or `<policy_generation>` when none was written,
 * `tool_input` is `{}`, durations are 0), the decision is the constant
 * `policy_generation`, `block_reason` is null (a generation has no outcome
 * to refuse) and `config_sha256` is left to the writer.
 */
export function buildPolicyGenerationRecord(input: PolicyGenerationRecordInput): AuditRecordInput {
  return {
    timestamp: new Date().toISOString(),
    session_id: null,
    session_source: null,
    agent_id: null,
    environment: input.environment,
    tool_name:
      input.candidatePath === null ? POLICY_GENERATION_TOOL_NAME : basename(input.candidatePath),
    tool_input: {},
    policy_decision: POLICY_GENERATION_DECISION,
    block_reason: null,
    matched_rule: null,
    matched_rule_index: null,
    evidence_chain: { policy_generation: input.evidence },
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
    record_kind: 'policy_generation',
    origin: 'operator',
    metadata: null,
    protocol_version: null,
    upstream: null,
  }
}

/** The persisted shape, validated whole on read: a partial object is not a run. */
const policyGenerationEvidenceSchema = z
  .object({
    candidate_sha256: z.string().nullable(),
    source_config_sha256: z.string(),
    helio_version: z.string(),
    traffic_start: z.string().nullable(),
    traffic_end: z.string().nullable(),
    call_count: z.number(),
    pairs_observed: z.number(),
    pairs_exposed: z.number(),
    rules_generated: z.number(),
    rules_kept: z.number(),
    needs_decision: z.number(),
    eligible_unobserved: z.number(),
    needs_dashboard: z.number(),
    default_action: z
      .object({
        source: z.enum(['allow', 'deny']),
        candidate: z.enum(['allow', 'deny']).nullable(),
      })
      .strict(),
    annotation_source: z.enum(['proxy', 'demo']),
  })
  .strict()

/** The one narrowing read of a generation record's evidence; null for any other kind, a missing object, or a shape the builder did not write. */
export function readPolicyGenerationEvidence(
  record: Pick<AuditRecord, 'record_kind' | 'evidence_chain'>,
): PolicyGenerationEvidence | null {
  if (record.record_kind !== 'policy_generation') return null
  const parsed = policyGenerationEvidenceSchema.safeParse(
    record.evidence_chain?.['policy_generation'],
  )
  return parsed.success ? parsed.data : null
}

/**
 * Write one generation record through the audit writer and observe the
 * outcome: the writer's `push` returns nothing and its `flush` drops the
 * batch on a transaction failure after printing its own error line, so
 * the row is read back by the id minted here. With a candidate hash the
 * writer stamps it onto the row; with null the writer is built without a
 * hash and stamps null, so the column stays null. Returns the id when the
 * row is in the store, null when the insert was dropped. The store stays
 * open; the caller closes it.
 */
export function writePolicyGenerationRecord(
  store: AuditStore,
  record: AuditRecordInput,
  candidateSha256: string | null,
): string | null {
  const writer = new AuditWriter({
    store,
    flushIntervalMs: 0,
    ...(candidateSha256 === null ? {} : { configSha256: candidateSha256 }),
  })
  const id = randomUUID()
  writer.push(record, id)
  writer.flush()
  return store.get(id) === undefined ? null : id
}
