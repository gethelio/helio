import { createHash, randomUUID } from 'node:crypto'
import type { AuditRecord } from '../../audit/types.js'
import { parseConfigSource } from '../../config/loader.js'
import type { PolicySimulationCandidate } from '../../policy/simulate/types.js'

// ---------------------------------------------------------------------------
// Audit rows and candidates for the policy simulation tests (issue #488):
// one builder per door, every column the matrix names present, so a test
// overrides only what its case is about.
// ---------------------------------------------------------------------------

/** The hash every row carries unless a test says otherwise. */
export const ROW_HASH = 'c'.repeat(64)

/** `2026-07-10T12:00:00.000Z` plus `minutes`, as a stored ISO instant. */
export function at(minutes: number): string {
  return new Date(Date.UTC(2026, 6, 10, 12, 0) + minutes * 60_000).toISOString()
}

/** An MCP door row: a forwarded allow with a JSON-RPC envelope, under a header session. */
export function mcpRow(overrides: Partial<AuditRecord> = {}): AuditRecord {
  const timestamp = overrides.timestamp ?? at(0)
  return {
    id: randomUUID(),
    timestamp,
    session_id: 's-1',
    session_source: 'header',
    agent_id: null,
    environment: null,
    tool_name: 'send_email',
    tool_input: {},
    policy_decision: 'allow',
    block_reason: null,
    matched_rule: null,
    matched_rule_index: null,
    evidence_chain: null,
    approval_status: null,
    approved_by: null,
    upstream_response: {
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: 'ok' }] },
    },
    upstream_error: null,
    upstream_http_status: 200,
    upstream_latency_ms: 5,
    total_duration_ms: 6,
    approval_wait_ms: 0,
    proxy_compute_ms: 1,
    flagged_destructive: false,
    dry_run: false,
    record_kind: 'tool_call',
    origin: 'mcp',
    metadata: null,
    protocol_version: null,
    upstream: null,
    config_sha256: ROW_HASH,
    created_at: timestamp,
    ...overrides,
  }
}

/** A sideband door row: an adapter-reported allow with a bare result and no MCP wire. */
export function sidebandRow(overrides: Partial<AuditRecord> = {}): AuditRecord {
  return mcpRow({
    origin: 'lab-adapter',
    session_source: 'sideband',
    upstream_response: { content: [{ type: 'text', text: 'ok' }] },
    upstream_http_status: null,
    upstream_latency_ms: 2,
    ...overrides,
  })
}

/** A sideband evaluation that expired unreported, committed when `committed` is true. */
export function expiredRow(committed: boolean, overrides: Partial<AuditRecord> = {}): AuditRecord {
  return sidebandRow({
    record_kind: 'evaluation_expired',
    upstream_response: null,
    upstream_latency_ms: null,
    evidence_chain: { sideband: { unreported: true, ...(committed ? { committed: true } : {}) } },
    ...overrides,
  })
}

/** Parse a config from YAML text the way the CLI reads a file, hashing the bytes. */
export function candidateFromYaml(raw: string): PolicySimulationCandidate {
  const source = { raw, sha256: createHash('sha256').update(raw, 'utf-8').digest('hex') }
  return { config: parseConfigSource(source, 'candidate.yaml', {}).config, source }
}

/** A config with the given policy rules and budgets, the rest at the schema defaults. */
export function candidateWith(parts: {
  readonly rules?: string
  readonly budgets?: string
  readonly policies?: string
  readonly session?: string
  readonly environment?: string
}): PolicySimulationCandidate {
  const lines = ["version: '1'", 'upstream:', "  url: 'http://127.0.0.1:8080/mcp'"]
  if (parts.environment !== undefined) lines.push(`environment: '${parts.environment}'`)
  if (parts.session !== undefined) lines.push('session:', parts.session)
  lines.push('policies:', '  default: allow')
  if (parts.policies !== undefined) lines.push(parts.policies)
  lines.push(parts.rules === undefined ? '  rules: []' : `  rules:\n${parts.rules}`)
  if (parts.budgets !== undefined) lines.push('budgets:', parts.budgets)
  // The schema demands a dashboard secret whenever anything can require
  // approval, and for an enabled dashboard otherwise; one line covers both.
  lines.push('dashboard:', "  api_secret: 'test-secret'")
  return candidateFromYaml(`${lines.join('\n')}\n`)
}
