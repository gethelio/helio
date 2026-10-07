import { describe, it, expect, vi } from 'vitest'
import { AuditStore } from './store.js'
import {
  POLICY_SIMULATION_DECISION,
  POLICY_SIMULATION_TOOL_NAME,
  buildPolicySimulationRecord,
  readPolicySimulationEvidence,
  writePolicySimulationRecord,
} from './policy-simulation.js'
import type { PolicySimulationEvidence } from './policy-simulation.js'
import { buildPolicyReloadRecord } from './policy-reload.js'
import type { PolicyReloadFacts } from '../config/watcher.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CANDIDATE_HASH = 'c'.repeat(64)
const BASELINE_HASH = 'b'.repeat(64)

function evidence(overrides: Partial<PolicySimulationEvidence> = {}): PolicySimulationEvidence {
  return {
    candidate_sha256: CANDIDATE_HASH,
    helio_version: '0.15.0',
    baseline_config_sha256: BASELINE_HASH,
    epoch_selector: 'latest',
    epochs_simulated: 1,
    traffic_start: '2026-07-10T12:00:00.000Z',
    traffic_end: '2026-07-10T12:05:00.000Z',
    call_count: 6,
    delta_count: 4,
    deltas_deny: 1,
    deltas_approval: 1,
    deltas_limited: 1,
    deltas_dry_run: 1,
    deltas_allow: 0,
    fidelity_warning_count: 2,
    skipped_rows: 1,
    unreported: 0,
    annotation_source: 'trail',
    ...overrides,
  }
}

function reloadFacts(): PolicyReloadFacts {
  return {
    configPath: '/etc/helio/helio.yaml',
    outcome: 'applied',
    sha256Before: 'a'.repeat(64),
    sha256After: 'b'.repeat(64),
    ruleCountBefore: 0,
    ruleCountAfter: 0,
    defaultActionBefore: 'allow',
    defaultActionAfter: 'allow',
    budgetCountBefore: 0,
    budgetCountAfter: 0,
    rulesRemoved: [],
    restartRequiredPaths: [],
    error: null,
  }
}

function openStore(): AuditStore {
  return new AuditStore({
    path: ':memory:',
    retention: '90d',
    includeResponses: true,
    cleanupIntervalMs: 0,
  })
}

/** A store whose batch insert fails at the transaction level, as a full disk would. */
class FailingStore extends AuditStore {
  override insertBatch(): number {
    throw new Error('SQLITE_FULL: database or disk is full')
  }
}

// ---------------------------------------------------------------------------
// buildPolicySimulationRecord
// ---------------------------------------------------------------------------

describe('buildPolicySimulationRecord (issue #490)', () => {
  it('shapes the record on the reload sentinel: constant decision, null reason, the evidence under its key', () => {
    const record = buildPolicySimulationRecord({
      candidatePath: '/x/helio.candidate.yaml',
      environment: 'production',
      evidence: evidence(),
    })
    expect(record.record_kind).toBe('policy_simulation')
    expect(record.policy_decision).toBe(POLICY_SIMULATION_DECISION)
    expect(record.policy_decision).toBe('policy_simulation')
    expect(record.block_reason).toBeNull()
    expect(record.tool_name).toBe('helio.candidate.yaml')
    expect(record.tool_input).toEqual({})
    expect(record.origin).toBe('operator')
    expect(record.environment).toBe('production')
    expect(record.evidence_chain).toEqual({ policy_simulation: evidence() })
    expect(record.total_duration_ms).toBe(0)
    expect(record.approval_wait_ms).toBe(0)
    expect(record.proxy_compute_ms).toBe(0)
    expect(record.flagged_destructive).toBe(false)
    expect(record.dry_run).toBe(false)
    expect(record.session_id).toBeNull()
    expect(record.session_source).toBeNull()
    expect(record.agent_id).toBeNull()
    expect(record.matched_rule).toBeNull()
    expect(record.matched_rule_index).toBeNull()
    expect(record.approval_status).toBeNull()
    expect(record.approved_by).toBeNull()
    expect(record.upstream_response).toBeNull()
    expect(record.upstream_error).toBeNull()
    expect(record.upstream_http_status).toBeNull()
    expect(record.upstream_latency_ms).toBeNull()
    expect(record.metadata).toBeNull()
    expect(record.protocol_version).toBeNull()
    expect(record.upstream).toBeNull()
    expect(Date.parse(record.timestamp)).not.toBeNaN()
  })

  it('leaves config_sha256 to the writer', () => {
    const record = buildPolicySimulationRecord({
      candidatePath: '/x/helio.candidate.yaml',
      environment: null,
      evidence: evidence(),
    })
    expect('config_sha256' in record).toBe(false)
    expect(record.environment).toBeNull()
  })

  it('names a null candidate path with the sentinel tool name', () => {
    const record = buildPolicySimulationRecord({
      candidatePath: null,
      environment: null,
      evidence: evidence(),
    })
    expect(record.tool_name).toBe(POLICY_SIMULATION_TOOL_NAME)
    expect(record.tool_name).toBe('<policy_simulation>')
  })
})

// ---------------------------------------------------------------------------
// readPolicySimulationEvidence
// ---------------------------------------------------------------------------

describe('readPolicySimulationEvidence (issue #490)', () => {
  it('returns the evidence the builder wrote', () => {
    const record = buildPolicySimulationRecord({
      candidatePath: '/x/helio.candidate.yaml',
      environment: null,
      evidence: evidence({
        baseline_config_sha256: null,
        epoch_selector: 'all',
        epochs_simulated: 3,
      }),
    })
    expect(readPolicySimulationEvidence(record)).toEqual(
      evidence({ baseline_config_sha256: null, epoch_selector: 'all', epochs_simulated: 3 }),
    )
  })

  it('answers null for a policy_reload record', () => {
    expect(readPolicySimulationEvidence(buildPolicyReloadRecord(reloadFacts(), null))).toBeNull()
  })

  it('answers null when the blob misses candidate_sha256', () => {
    const { candidate_sha256: _dropped, ...partial } = evidence()
    expect(
      readPolicySimulationEvidence({
        record_kind: 'policy_simulation',
        evidence_chain: { policy_simulation: partial },
      }),
    ).toBeNull()
  })

  it('answers null when the blob carries a key the builder does not write', () => {
    expect(
      readPolicySimulationEvidence({
        record_kind: 'policy_simulation',
        evidence_chain: { policy_simulation: { ...evidence(), record_id: 'planted' } },
      }),
    ).toBeNull()
  })

  it('answers null for a record without evidence', () => {
    expect(
      readPolicySimulationEvidence({ record_kind: 'policy_simulation', evidence_chain: null }),
    ).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// writePolicySimulationRecord
// ---------------------------------------------------------------------------

describe('writePolicySimulationRecord (issue #490)', () => {
  it('writes the one row through the real writer, stamped with the candidate hash, and returns its id', () => {
    const store = openStore()
    try {
      const record = buildPolicySimulationRecord({
        candidatePath: '/x/helio.candidate.yaml',
        environment: null,
        evidence: evidence(),
      })
      const id = writePolicySimulationRecord(store, record, CANDIDATE_HASH)
      expect(id).not.toBeNull()
      const row = store.get(id as string)
      expect(row).toBeDefined()
      expect(row?.record_kind).toBe('policy_simulation')
      expect(row?.config_sha256).toBe(CANDIDATE_HASH)
      expect(row?.tool_name).toBe('helio.candidate.yaml')
      expect(Date.parse(row?.created_at ?? '')).not.toBeNaN()
      expect(readPolicySimulationEvidence(row as NonNullable<typeof row>)).toEqual(evidence())
      expect(store.count()).toBe(1)
    } finally {
      store.close()
    }
  })

  it('returns null and leaves no row when the batch insert fails, after the writer said so', () => {
    const store = new FailingStore({
      path: ':memory:',
      retention: '90d',
      includeResponses: true,
      cleanupIntervalMs: 0,
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const record = buildPolicySimulationRecord({
        candidatePath: '/x/helio.candidate.yaml',
        environment: null,
        evidence: evidence(),
      })
      const id = writePolicySimulationRecord(store, record, CANDIDATE_HASH)
      expect(id).toBeNull()
      expect(store.count()).toBe(0)
      expect(errorSpy).toHaveBeenCalledTimes(1)
      expect(String(errorSpy.mock.calls[0]?.[0])).toContain(
        '[helio] AuditWriter: batch flush failed:',
      )
    } finally {
      errorSpy.mockRestore()
      store.close()
    }
  })
})
