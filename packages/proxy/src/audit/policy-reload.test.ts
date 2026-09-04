import { describe, it, expect } from 'vitest'
import {
  buildPolicyReloadRecord,
  policyReloadEvidence,
  readPolicyReloadEvidence,
} from './policy-reload.js'
import type { PolicyReloadFacts } from '../config/watcher.js'

function facts(overrides: Partial<PolicyReloadFacts> = {}): PolicyReloadFacts {
  return {
    configPath: '/etc/helio/helio.yaml',
    outcome: 'applied',
    sha256Before: 'a'.repeat(64),
    sha256After: 'b'.repeat(64),
    ruleCountBefore: 2,
    ruleCountAfter: 1,
    defaultActionBefore: 'deny',
    defaultActionAfter: 'allow',
    budgetCountBefore: 1,
    budgetCountAfter: 0,
    rulesRemoved: ['block-destructive'],
    restartRequiredPaths: [],
    error: null,
    ...overrides,
  }
}

describe('buildPolicyReloadRecord (issue #341)', () => {
  it('shapes an applied reload with the drift-record sentinels and the facts under evidence_chain', () => {
    const record = buildPolicyReloadRecord(facts(), 'prod')
    expect(record.record_kind).toBe('policy_reload')
    expect(record.origin).toBe('config')
    expect(record.policy_decision).toBe('policy_reload')
    expect(record.block_reason).toBeNull()
    expect(record.tool_name).toBe('helio.yaml')
    expect(record.tool_input).toEqual({})
    expect(record.environment).toBe('prod')
    expect(record.total_duration_ms).toBe(0)
    expect(record.approval_wait_ms).toBe(0)
    expect(record.proxy_compute_ms).toBe(0)
    expect(record.session_id).toBeNull()
    expect(record.upstream).toBeNull()
    expect(record.protocol_version).toBeNull()
    expect(record.evidence_chain).toEqual({
      policy_reload: {
        outcome: 'applied',
        config_path: '/etc/helio/helio.yaml',
        sha256_before: 'a'.repeat(64),
        sha256_after: 'b'.repeat(64),
        rule_count_before: 2,
        rule_count_after: 1,
        default_action_before: 'deny',
        default_action_after: 'allow',
        budget_count_before: 1,
        budget_count_after: 0,
        rules_removed: ['block-destructive'],
        restart_required_paths: [],
        error: null,
      },
    })
  })

  it('puts the outcome in block_reason on a refusal and never in policy_decision', () => {
    const record = buildPolicyReloadRecord(
      facts({
        outcome: 'rejected_pinned',
        sha256After: 'c'.repeat(64),
        ruleCountAfter: null,
        defaultActionAfter: null,
        budgetCountAfter: null,
        rulesRemoved: [],
        error: 'config hash does not match the pin',
      }),
      null,
    )
    expect(record.policy_decision).toBe('policy_reload')
    expect(record.block_reason).toBe('rejected_pinned')
    expect(record.environment).toBeNull()
    expect(readPolicyReloadEvidence(record)?.error).toBe('config hash does not match the pin')
    expect(
      policyReloadEvidence(facts({ outcome: 'rejected_invalid', sha256After: null })).sha256_after,
    ).toBeNull()
  })

  it('reads the evidence back from a record and refuses other kinds and empty chains', () => {
    const record = buildPolicyReloadRecord(facts(), null)
    expect(readPolicyReloadEvidence(record)?.rules_removed).toEqual(['block-destructive'])
    expect(
      readPolicyReloadEvidence({ record_kind: 'tool_call', evidence_chain: record.evidence_chain }),
    ).toBeNull()
    expect(
      readPolicyReloadEvidence({ record_kind: 'policy_reload', evidence_chain: null }),
    ).toBeNull()
    // A shape the builder never wrote is not an event: the whole object is validated, not one key.
    expect(
      readPolicyReloadEvidence({
        record_kind: 'policy_reload',
        evidence_chain: { policy_reload: { outcome: 'applied' } },
      }),
    ).toBeNull()
  })
})
