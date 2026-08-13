import type { HeaderMismatchRejection } from '../mcp/types.js'
import type { AuditRecord } from './types.js'

/**
 * Map a header/body agreement rejection (issue #226) onto the audit record
 * shape, mirroring the `missing_tool_name` precedent: `policy_decision:
 * 'rejected'`, no rule evaluated, nothing forwarded, written by the caller
 * via `pushImmediate`. The snake_case mapping lives here alone — the
 * rejection payload itself stays camelCase protocol facts (`mcp/types.ts`).
 *
 * `record_kind` stays `'tool_call'` for the whole class, non-tool methods
 * included: it is the MCP-door request bucket, and `block_reason` is the
 * query key. `tool_name` carries the body's name-bearing field (the body
 * truth an investigator filters for) when the method has one, else the
 * reserved `'<header_mismatch>'` sentinel — either way `top_tools` already
 * excludes rejected records, so these rows never pollute tool rankings.
 */
export function buildHeaderMismatchAuditRecord(
  rejection: HeaderMismatchRejection,
  environment?: string,
): Omit<AuditRecord, 'id' | 'created_at'> {
  return {
    timestamp: new Date().toISOString(),
    session_id: rejection.session?.id ?? null,
    session_source: rejection.session?.source ?? null,
    agent_id: null,
    environment: environment ?? null,
    tool_name: rejection.bodyName ?? '<header_mismatch>',
    // Wrap parity with the nameless precedent: the wire params always nest
    // under `raw_params`, so a wrapped scalar can never be confused with an
    // object that happens to contain a `raw_params` key. Headers are the
    // present markers only, verbatim as received.
    tool_input: {
      raw_params: rejection.params ?? null,
      body_method: rejection.method,
      mismatch_reason: rejection.reason,
      headers: { ...rejection.headers },
    },
    policy_decision: 'rejected',
    block_reason: 'header_mismatch',
    matched_rule: null,
    matched_rule_index: null,
    evidence_chain: null,
    approval_status: null,
    approved_by: null,
    upstream_response: null,
    upstream_error: null,
    upstream_http_status: null,
    upstream_latency_ms: null,
    total_duration_ms: rejection.durationMs,
    approval_wait_ms: 0,
    proxy_compute_ms: rejection.durationMs,
    flagged_destructive: false,
    dry_run: false,
    record_kind: 'tool_call',
    origin: 'mcp',
    metadata: null,
    protocol_version: rejection.protocolVersion ?? null,
  }
}
