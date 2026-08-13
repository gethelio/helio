import { describe, it, expect } from 'vitest'
import { buildHeaderMismatchAuditRecord } from './header-mismatch.js'
import type { HeaderMismatchRejection } from '../mcp/types.js'

const baseRejection: HeaderMismatchRejection = {
  reason: 'mismatched mcp-name header (expected transfer_funds, got list_orders)',
  method: 'tools/call',
  params: { name: 'transfer_funds', arguments: { amount: 5 } },
  bodyName: 'transfer_funds',
  protocolVersion: '2026-07-28',
  headers: {
    'mcp-method': 'tools/call',
    'mcp-name': 'list_orders',
    'mcp-protocol-version': '2026-07-28',
  },
  session: { id: 'run-a', source: 'header' },
  durationMs: 3.5,
}

describe('buildHeaderMismatchAuditRecord', () => {
  it('maps the full rejection onto the nameless-precedent record shape', () => {
    const record = buildHeaderMismatchAuditRecord(baseRejection, 'production')

    expect(record).toEqual({
      timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) as unknown,
      session_id: 'run-a',
      session_source: 'header',
      agent_id: null,
      environment: 'production',
      tool_name: 'transfer_funds',
      tool_input: {
        raw_params: { name: 'transfer_funds', arguments: { amount: 5 } },
        body_method: 'tools/call',
        mismatch_reason: 'mismatched mcp-name header (expected transfer_funds, got list_orders)',
        headers: {
          'mcp-method': 'tools/call',
          'mcp-name': 'list_orders',
          'mcp-protocol-version': '2026-07-28',
        },
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
      total_duration_ms: 3.5,
      approval_wait_ms: 0,
      proxy_compute_ms: 3.5,
      flagged_destructive: false,
      dry_run: false,
      record_kind: 'tool_call',
      origin: 'mcp',
      metadata: null,
      protocol_version: '2026-07-28',
    })
  })

  it('falls back to the reserved sentinel when the body carries no name', () => {
    const { bodyName: _bodyName, ...rest } = baseRejection
    const record = buildHeaderMismatchAuditRecord({ ...rest, method: 'tools/list' })

    expect(record.tool_name).toBe('<header_mismatch>')
  })

  it('wraps absent params as raw_params: null (parity with missing_tool_name)', () => {
    const { params: _params, ...rest } = baseRejection
    const record = buildHeaderMismatchAuditRecord(rest)

    expect(record.tool_input['raw_params']).toBeNull()
  })

  it('wraps scalar params losslessly under raw_params', () => {
    const record = buildHeaderMismatchAuditRecord({ ...baseRejection, params: 42 })

    expect(record.tool_input['raw_params']).toBe(42)
  })

  it('passes the present-headers set through verbatim', () => {
    const record = buildHeaderMismatchAuditRecord({
      ...baseRejection,
      headers: { 'mcp-name': 'list_orders' },
    })

    expect(record.tool_input['headers']).toEqual({ 'mcp-name': 'list_orders' })
  })

  it('records null protocol_version when the request carried no claim', () => {
    const { protocolVersion: _protocolVersion, ...rest } = baseRejection
    const record = buildHeaderMismatchAuditRecord(rest)

    expect(record.protocol_version).toBeNull()
  })

  it('records null session fields when no session resolved', () => {
    const { session: _session, ...rest } = baseRejection
    const record = buildHeaderMismatchAuditRecord(rest)

    expect(record.session_id).toBeNull()
    expect(record.session_source).toBeNull()
  })

  it('records null environment when none is configured', () => {
    const record = buildHeaderMismatchAuditRecord(baseRejection)

    expect(record.environment).toBeNull()
  })
})
