import { describe, it, expect, vi } from 'vitest'
import { AuditStore } from './store.js'
import {
  POLICY_GENERATION_DECISION,
  POLICY_GENERATION_TOOL_NAME,
  buildPolicyGenerationRecord,
  readPolicyGenerationEvidence,
  writePolicyGenerationRecord,
} from './policy-generation.js'
import type { PolicyGenerationEvidence } from './policy-generation.js'
import { buildPolicyReloadRecord } from './policy-reload.js'
import type { PolicyReloadFacts } from '../config/watcher.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CANDIDATE_HASH = 'c'.repeat(64)
const SOURCE_HASH = 's'.repeat(64)

function evidence(overrides: Partial<PolicyGenerationEvidence> = {}): PolicyGenerationEvidence {
  return {
    candidate_sha256: CANDIDATE_HASH,
    source_config_sha256: SOURCE_HASH,
    helio_version: '0.15.0',
    traffic_start: '2026-07-10T12:00:00.000Z',
    traffic_end: '2026-07-10T12:05:00.000Z',
    call_count: 352,
    pairs_observed: 8,
    pairs_exposed: 10,
    rules_generated: 1,
    rules_kept: 6,
    needs_decision: 3,
    eligible_unobserved: 0,
    needs_dashboard: 0,
    default_action: { source: 'allow', candidate: 'allow' },
    annotation_source: 'proxy',
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
// buildPolicyGenerationRecord
// ---------------------------------------------------------------------------

describe('buildPolicyGenerationRecord (issue #522)', () => {
  it('shapes the record on the simulation sentinel: constant decision, null reason, the evidence under its key', () => {
    const record = buildPolicyGenerationRecord({
      candidatePath: '/x/helio.candidate.yaml',
      environment: 'production',
      evidence: evidence(),
    })
    expect(record.record_kind).toBe('policy_generation')
    expect(record.policy_decision).toBe(POLICY_GENERATION_DECISION)
    expect(record.policy_decision).toBe('policy_generation')
    expect(record.block_reason).toBeNull()
    expect(record.tool_name).toBe('helio.candidate.yaml')
    expect(record.tool_input).toEqual({})
    expect(record.origin).toBe('operator')
    expect(record.environment).toBe('production')
    expect(record.evidence_chain).toEqual({ policy_generation: evidence() })
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
    const record = buildPolicyGenerationRecord({
      candidatePath: '/x/helio.candidate.yaml',
      environment: null,
      evidence: evidence(),
    })
    expect('config_sha256' in record).toBe(false)
    expect(record.environment).toBeNull()
  })

  it('names a null candidate path with the sentinel tool name', () => {
    const record = buildPolicyGenerationRecord({
      candidatePath: null,
      environment: null,
      evidence: evidence({ candidate_sha256: null }),
    })
    expect(record.tool_name).toBe(POLICY_GENERATION_TOOL_NAME)
    expect(record.tool_name).toBe('<policy_generation>')
  })
})

// ---------------------------------------------------------------------------
// readPolicyGenerationEvidence
// ---------------------------------------------------------------------------

describe('readPolicyGenerationEvidence (issue #522)', () => {
  it('returns the evidence the builder wrote', () => {
    const record = buildPolicyGenerationRecord({
      candidatePath: '/x/helio.candidate.yaml',
      environment: null,
      evidence: evidence({ traffic_start: null, traffic_end: null, call_count: 0 }),
    })
    expect(readPolicyGenerationEvidence(record)).toEqual(
      evidence({ traffic_start: null, traffic_end: null, call_count: 0 }),
    )
  })

  it('returns a zero-rule run with a null candidate hash and a null candidate default', () => {
    const zero = evidence({
      candidate_sha256: null,
      rules_generated: 0,
      default_action: { source: 'deny', candidate: null },
      annotation_source: 'demo',
    })
    const record = buildPolicyGenerationRecord({
      candidatePath: null,
      environment: null,
      evidence: zero,
    })
    expect(readPolicyGenerationEvidence(record)).toEqual(zero)
  })

  it('answers null for a policy_reload record', () => {
    expect(readPolicyGenerationEvidence(buildPolicyReloadRecord(reloadFacts(), null))).toBeNull()
  })

  it('answers null for a policy_simulation record carrying a generation-shaped blob', () => {
    expect(
      readPolicyGenerationEvidence({
        record_kind: 'policy_simulation',
        evidence_chain: { policy_generation: evidence() },
      }),
    ).toBeNull()
  })

  it('answers null when the blob misses candidate_sha256', () => {
    const { candidate_sha256: _dropped, ...partial } = evidence()
    expect(
      readPolicyGenerationEvidence({
        record_kind: 'policy_generation',
        evidence_chain: { policy_generation: partial },
      }),
    ).toBeNull()
  })

  it('answers null when the blob carries a key the builder does not write', () => {
    expect(
      readPolicyGenerationEvidence({
        record_kind: 'policy_generation',
        evidence_chain: { policy_generation: { ...evidence(), record_id: 'planted' } },
      }),
    ).toBeNull()
  })

  it('answers null when annotation_source is outside the enum', () => {
    expect(
      readPolicyGenerationEvidence({
        record_kind: 'policy_generation',
        evidence_chain: { policy_generation: { ...evidence(), annotation_source: 'trail' } },
      }),
    ).toBeNull()
  })

  it('answers null for a record without evidence', () => {
    expect(
      readPolicyGenerationEvidence({ record_kind: 'policy_generation', evidence_chain: null }),
    ).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// writePolicyGenerationRecord
// ---------------------------------------------------------------------------

describe('writePolicyGenerationRecord (issue #522)', () => {
  it('writes the one row through the real writer, stamped with the candidate hash, and returns its id', () => {
    const store = openStore()
    try {
      const record = buildPolicyGenerationRecord({
        candidatePath: '/x/helio.candidate.yaml',
        environment: null,
        evidence: evidence(),
      })
      const id = writePolicyGenerationRecord(store, record, CANDIDATE_HASH)
      expect(id).not.toBeNull()
      const row = store.get(id as string)
      expect(row).toBeDefined()
      expect(row?.record_kind).toBe('policy_generation')
      expect(row?.config_sha256).toBe(CANDIDATE_HASH)
      expect(row?.tool_name).toBe('helio.candidate.yaml')
      expect(Date.parse(row?.created_at ?? '')).not.toBeNaN()
      expect(readPolicyGenerationEvidence(row as NonNullable<typeof row>)).toEqual(evidence())
      expect(store.count()).toBe(1)
    } finally {
      store.close()
    }
  })

  it('writes a zero-rule run with no hash: the row has a null config_sha256', () => {
    const store = openStore()
    try {
      const zero = evidence({ candidate_sha256: null, rules_generated: 0 })
      const record = buildPolicyGenerationRecord({
        candidatePath: null,
        environment: null,
        evidence: zero,
      })
      const id = writePolicyGenerationRecord(store, record, null)
      expect(id).not.toBeNull()
      const row = store.get(id as string)
      expect(row?.config_sha256).toBeNull()
      expect(row?.tool_name).toBe('<policy_generation>')
      expect(readPolicyGenerationEvidence(row as NonNullable<typeof row>)).toEqual(zero)
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
      const record = buildPolicyGenerationRecord({
        candidatePath: '/x/helio.candidate.yaml',
        environment: null,
        evidence: evidence(),
      })
      const id = writePolicyGenerationRecord(store, record, CANDIDATE_HASH)
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
