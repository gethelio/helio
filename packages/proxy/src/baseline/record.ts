import type { AuditRecordInput } from '../audit/types.js'
import type { ToolDriftChange } from '../policy/annotation-cache.js'

// ---------------------------------------------------------------------------
// The baseline_accepted record (issue #60), on the kill-switch record's
// shape: a `drift_event` like `tool_drift` and `tool_drift_reverted`, the
// third state of the drift lifecycle, so the dashboard's Drift chip and the
// analytics exclusions already cover it. `tool_name` is the real tool,
// `approved_by` the operator, and the facts live under
// `evidence_chain.baseline_accepted` beside the drift's `changes`.
// ---------------------------------------------------------------------------

/** The constant `policy_decision` of an acceptance record. */
export const BASELINE_ACCEPTED_DECISION = 'baseline_accepted'

export interface BaselineAcceptedEvidence {
  /** The operator or credential that accepted the change. */
  readonly by: string
  readonly previous_fingerprint: string
  readonly fingerprint: string
  /** When the replaced baseline was first seen; null when it was never persisted. */
  readonly first_seen: string | null
  /** False under `persist_baselines: false`: the acceptance lives in memory only. */
  readonly persisted: boolean
}

export interface BaselineAcceptedRecordParams {
  readonly tool: string
  /** The configured upstream name, or null on a singular door. */
  readonly upstream: string | null
  readonly environment: string | null
  /** The drift event's changes, what the operator reviewed. */
  readonly changes: readonly ToolDriftChange[]
  readonly accepted: BaselineAcceptedEvidence
}

/** Shape one baseline acceptance as an audit record. */
export function buildBaselineAcceptedRecord(
  params: BaselineAcceptedRecordParams,
): AuditRecordInput {
  return {
    timestamp: new Date().toISOString(),
    session_id: null,
    session_source: null,
    agent_id: null,
    environment: params.environment,
    tool_name: params.tool,
    tool_input: {},
    policy_decision: BASELINE_ACCEPTED_DECISION,
    block_reason: null,
    matched_rule: null,
    matched_rule_index: null,
    evidence_chain: {
      tool_drift: { changes: params.changes },
      baseline_accepted: { ...params.accepted },
    },
    approval_status: null,
    approved_by: params.accepted.by,
    upstream_response: null,
    upstream_error: null,
    upstream_http_status: null,
    upstream_latency_ms: null,
    total_duration_ms: 0,
    approval_wait_ms: 0,
    proxy_compute_ms: 0,
    flagged_destructive: false,
    dry_run: false,
    record_kind: 'drift_event',
    origin: 'mcp',
    metadata: null,
    // An acceptance is an operator action, not a request: no protocol claim exists.
    protocol_version: null,
    upstream: params.upstream,
  }
}
