import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { z } from 'zod'
import type { AuditStore } from './store.js'
import type { AuditRecord, AuditRecordInput } from './types.js'
import { AuditWriter } from './writer.js'

// ---------------------------------------------------------------------------
// The policy simulation provenance record (issue #490): one row per
// `helio policy simulate` run, on the reload-record precedent. The decision
// column holds a constant so analytics can exclude the kind, the candidate's
// hash is the row's `config_sha256` (the writer stamps it), and the run's
// facts live under `evidence_chain.policy_simulation`.
// ---------------------------------------------------------------------------

/** The constant `policy_decision` of a simulation record. */
export const POLICY_SIMULATION_DECISION = 'policy_simulation'

/** The `tool_name` sentinel when the candidate has no path (a library caller). */
export const POLICY_SIMULATION_TOOL_NAME = '<policy_simulation>'

/** The facts of one run, persisted under `evidence_chain.policy_simulation`. */
export interface PolicySimulationEvidence {
  readonly candidate_sha256: string
  readonly helio_version: string
  /** The selected epoch's hash; null for a null-hash run and under `--across-configs`. */
  readonly baseline_config_sha256: string | null
  readonly epoch_selector: 'latest' | 'all' | 'config_sha'
  /** 1, or the count of epochs under `--across-configs`. */
  readonly epochs_simulated: number
  /** The first replayed row's `timestamp`; null on an empty window. */
  readonly traffic_start: string | null
  /** The last replayed row's `timestamp`; null on an empty window. */
  readonly traffic_end: string | null
  readonly call_count: number
  readonly delta_count: number
  /** Deltas the candidate would block. */
  readonly deltas_deny: number
  /** Deltas the candidate would hold for approval, answered live or not. */
  readonly deltas_approval: number
  /** Deltas that pass under a rate or spend limit. */
  readonly deltas_limited: number
  /** Deltas the candidate decides but would not enforce. */
  readonly deltas_dry_run: number
  /** Deltas the candidate would plainly allow. The five counts sum to `delta_count`. */
  readonly deltas_allow: number
  readonly fidelity_warning_count: number
  /** Rows the skip predicate removed: rejections and kill-switch refusals. */
  readonly skipped_rows: number
  readonly unreported: number
  readonly annotation_source: 'trail' | 'demo'
}

/** What the builder takes: where the candidate came from, the operator's environment label, the facts. */
export interface PolicySimulationRecordInput {
  readonly candidatePath: string | null
  readonly environment: string | null
  readonly evidence: PolicySimulationEvidence
}

/**
 * Shape one simulation run as an audit record, on the reload sentinel
 * (issue #341): the NOT NULL columns carry sentinels (`tool_name` is the
 * candidate's basename, `tool_input` is `{}`, durations are 0), the
 * decision is the constant `policy_simulation`, `block_reason` is null (a
 * simulation has no outcome to refuse) and `config_sha256` is left to the
 * writer, which stamps the candidate's hash.
 */
export function buildPolicySimulationRecord(input: PolicySimulationRecordInput): AuditRecordInput {
  return {
    timestamp: new Date().toISOString(),
    session_id: null,
    session_source: null,
    agent_id: null,
    environment: input.environment,
    tool_name:
      input.candidatePath === null ? POLICY_SIMULATION_TOOL_NAME : basename(input.candidatePath),
    tool_input: {},
    policy_decision: POLICY_SIMULATION_DECISION,
    block_reason: null,
    matched_rule: null,
    matched_rule_index: null,
    evidence_chain: { policy_simulation: input.evidence },
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
    record_kind: 'policy_simulation',
    origin: 'operator',
    metadata: null,
    protocol_version: null,
    upstream: null,
  }
}

/** The persisted shape, validated whole on read: a partial object is not a run. */
const policySimulationEvidenceSchema = z
  .object({
    candidate_sha256: z.string(),
    helio_version: z.string(),
    baseline_config_sha256: z.string().nullable(),
    epoch_selector: z.enum(['latest', 'all', 'config_sha']),
    epochs_simulated: z.number(),
    traffic_start: z.string().nullable(),
    traffic_end: z.string().nullable(),
    call_count: z.number(),
    delta_count: z.number(),
    deltas_deny: z.number(),
    deltas_approval: z.number(),
    deltas_limited: z.number(),
    deltas_dry_run: z.number(),
    deltas_allow: z.number(),
    fidelity_warning_count: z.number(),
    skipped_rows: z.number(),
    unreported: z.number(),
    annotation_source: z.enum(['trail', 'demo']),
  })
  .strict()

/** The one narrowing read of a simulation record's evidence; null for any other kind, a missing object, or a shape the builder did not write. */
export function readPolicySimulationEvidence(
  record: Pick<AuditRecord, 'record_kind' | 'evidence_chain'>,
): PolicySimulationEvidence | null {
  if (record.record_kind !== 'policy_simulation') return null
  const parsed = policySimulationEvidenceSchema.safeParse(
    record.evidence_chain?.['policy_simulation'],
  )
  return parsed.success ? parsed.data : null
}

/**
 * Write one simulation record through the audit writer and observe the
 * outcome: the writer's `push` returns nothing and its `flush` drops the
 * batch on a transaction failure after printing its own error line, so
 * the row is read back by the id minted here. Returns the id when the row
 * is in the store, null when the insert was dropped. The store stays
 * open; the caller closes it.
 */
export function writePolicySimulationRecord(
  store: AuditStore,
  record: AuditRecordInput,
  candidateSha256: string,
): string | null {
  const writer = new AuditWriter({ store, flushIntervalMs: 0, configSha256: candidateSha256 })
  const id = randomUUID()
  writer.push(record, id)
  writer.flush()
  return store.get(id) === undefined ? null : id
}
