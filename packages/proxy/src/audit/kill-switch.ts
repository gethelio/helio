import { z } from 'zod'
import type { AuditRecord, AuditRecordInput } from './types.js'

// ---------------------------------------------------------------------------
// The kill and resume records (issue #402), on the reload-record precedent:
// the NOT NULL columns carry sentinels, the decision is the constant
// `kill_switch` so analytics can exclude the kind, the outcome is the
// `block_reason` (`kill_switch` for a kill, null for a resume) and the facts
// live under `evidence_chain.kill_switch`.
// ---------------------------------------------------------------------------

/** The constant `policy_decision` of a kill or resume record. */
export const KILL_SWITCH_DECISION = 'kill_switch'

/** The sentinel `tool_name` of a kill or resume record. */
export const KILL_SWITCH_TOOL_NAME = '<kill_switch>'

export interface KillSwitchEvidence {
  readonly action: 'kill' | 'resume'
  /** The trigger: the marker file, the boot variable, or the endpoint. */
  readonly surface: 'file' | 'env' | 'api'
  /** The credential or body actor behind an api trigger; null for the file and the variable. */
  readonly actor: string | null
  /** Whether the marker file backed the halt (for a resume: the halt lifted). */
  readonly durable: boolean
  /** True when the edge fired at boot, from a present marker or the variable. */
  readonly at_boot: boolean
  /** Approval tickets pending at the transition: what was in flight. */
  readonly pending_approvals: number
}

/** Shape one kill-switch transition as an audit record. */
export function buildKillSwitchRecord(
  event: KillSwitchEvidence,
  environment: string | null,
): AuditRecordInput {
  return {
    timestamp: new Date().toISOString(),
    session_id: null,
    session_source: null,
    agent_id: null,
    environment,
    tool_name: KILL_SWITCH_TOOL_NAME,
    tool_input: {},
    policy_decision: KILL_SWITCH_DECISION,
    block_reason: event.action === 'kill' ? 'kill_switch' : null,
    matched_rule: null,
    matched_rule_index: null,
    evidence_chain: { kill_switch: { ...event } },
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
    record_kind: 'kill_switch',
    origin: 'operator',
    metadata: null,
    protocol_version: null,
    upstream: null,
  }
}

/** The persisted shape, validated whole on read: a partial object is not an event. */
const killSwitchEvidenceSchema = z
  .object({
    action: z.enum(['kill', 'resume']),
    surface: z.enum(['file', 'env', 'api']),
    actor: z.string().nullable(),
    durable: z.boolean(),
    at_boot: z.boolean(),
    pending_approvals: z.number(),
  })
  .strict()

/** The one narrowing read of a kill-switch record's evidence; null for any other kind or shape. */
export function readKillSwitchEvidence(
  record: Pick<AuditRecord, 'record_kind' | 'evidence_chain'>,
): KillSwitchEvidence | null {
  if (record.record_kind !== 'kill_switch') return null
  const parsed = killSwitchEvidenceSchema.safeParse(record.evidence_chain?.['kill_switch'])
  return parsed.success ? parsed.data : null
}
