import { describe, it, expect } from 'vitest'
import {
  KILL_SWITCH_DECISION,
  KILL_SWITCH_TOOL_NAME,
  buildKillSwitchRecord,
  readKillSwitchEvidence,
} from './kill-switch.js'
import type { KillSwitchEvidence } from './kill-switch.js'

function event(overrides: Partial<KillSwitchEvidence> = {}): KillSwitchEvidence {
  return {
    action: 'kill',
    surface: 'file',
    actor: null,
    durable: true,
    at_boot: false,
    pending_approvals: 2,
    ...overrides,
  }
}

describe('buildKillSwitchRecord (issue #402)', () => {
  it('shapes a kill on the reload-record precedent: sentinels, the constant decision, the outcome in block_reason', () => {
    const record = buildKillSwitchRecord(event(), 'prod')
    expect(KILL_SWITCH_DECISION).toBe('kill_switch')
    expect(KILL_SWITCH_TOOL_NAME).toBe('<kill_switch>')
    expect(record.record_kind).toBe('kill_switch')
    expect(record.origin).toBe('operator')
    expect(record.policy_decision).toBe('kill_switch')
    expect(record.block_reason).toBe('kill_switch')
    expect(record.tool_name).toBe('<kill_switch>')
    expect(record.tool_input).toEqual({})
    expect(record.environment).toBe('prod')
    expect(record.matched_rule).toBeNull()
    expect(record.matched_rule_index).toBeNull()
    expect(record.total_duration_ms).toBe(0)
    expect(record.approval_wait_ms).toBe(0)
    expect(record.proxy_compute_ms).toBe(0)
    expect(record.session_id).toBeNull()
    expect(record.session_source).toBeNull()
    expect(record.upstream).toBeNull()
    expect(record.protocol_version).toBeNull()
    expect(record.dry_run).toBe(false)
    expect(record.flagged_destructive).toBe(false)
    expect(record.approval_status).toBeNull()
    expect(record.upstream_response).toBeNull()
    expect(record.metadata).toBeNull()
    expect(record.evidence_chain).toEqual({
      kill_switch: {
        action: 'kill',
        surface: 'file',
        actor: null,
        durable: true,
        at_boot: false,
        pending_approvals: 2,
      },
    })
    expect(Date.parse(record.timestamp)).not.toBeNaN()
  })

  it('shapes a resume with a null block_reason and the facts under the same key', () => {
    const record = buildKillSwitchRecord(
      event({
        action: 'resume',
        surface: 'api',
        actor: 'alice',
        durable: false,
        pending_approvals: 0,
      }),
      null,
    )
    expect(record.record_kind).toBe('kill_switch')
    expect(record.policy_decision).toBe('kill_switch')
    expect(record.block_reason).toBeNull()
    expect(record.environment).toBeNull()
    expect(record.evidence_chain).toEqual({
      kill_switch: {
        action: 'resume',
        surface: 'api',
        actor: 'alice',
        durable: false,
        at_boot: false,
        pending_approvals: 0,
      },
    })
  })

  it('marks a boot under a marker or the variable', () => {
    const record = buildKillSwitchRecord(
      event({ surface: 'env', durable: false, at_boot: true }),
      null,
    )
    expect(record.block_reason).toBe('kill_switch')
    expect(readKillSwitchEvidence(record)).toMatchObject({
      surface: 'env',
      at_boot: true,
      durable: false,
    })
  })
})

describe('readKillSwitchEvidence', () => {
  it('reads back what the builder wrote', () => {
    const record = buildKillSwitchRecord(event({ actor: 'bearer' }), null)
    expect(readKillSwitchEvidence(record)).toEqual(event({ actor: 'bearer' }))
  })

  it('is null for another kind, a missing chain, a partial object and an extra key', () => {
    const record = buildKillSwitchRecord(event(), null)
    expect(readKillSwitchEvidence({ ...record, record_kind: 'policy_reload' })).toBeNull()
    expect(readKillSwitchEvidence({ ...record, evidence_chain: null })).toBeNull()
    expect(
      readKillSwitchEvidence({
        ...record,
        evidence_chain: { kill_switch: { action: 'kill', surface: 'file' } },
      }),
    ).toBeNull()
    expect(
      readKillSwitchEvidence({
        ...record,
        evidence_chain: { kill_switch: { ...event(), extra: true } },
      }),
    ).toBeNull()
    expect(
      readKillSwitchEvidence({
        ...record,
        evidence_chain: { kill_switch: { ...event(), surface: 'slack' } },
      }),
    ).toBeNull()
  })
})
