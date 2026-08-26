import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GovernanceService } from './governance-service.js'
import type { EvaluateInput } from './governance-service.js'
import { compilePolicies } from '../policy/parser.js'
import { decide } from '../policy/decision-pipeline.js'
import type { AuditWriter } from '../audit/writer.js'

// Spy-mode module mock: the real decide() runs, its inputs are observable.
// Call history is FILE-WIDE — the beforeEach mockClear is load-bearing.
vi.mock('../policy/decision-pipeline.js', { spy: true })

// ---------------------------------------------------------------------------
// Sideband decide() input stays upstream-less (issue #295)
// ---------------------------------------------------------------------------

function makeService(): GovernanceService {
  const writer = { push: () => {}, pushImmediate: () => {} } as unknown as AuditWriter
  return new GovernanceService({
    policy: compilePolicies({ default: 'allow', dry_run: false, rules: [] }).policy,
    auditWriter: writer,
    ttlMs: 600_000,
    now: () => 1_000_000,
    sweepIntervalMs: 0,
  })
}

function evalInput(): EvaluateInput {
  return {
    origin: 'openclaw',
    agent_id: 'main',
    session_id: null,
    tool: { name: 'send' },
    arguments: {},
    metadata: null,
  }
}

beforeEach(() => {
  vi.mocked(decide).mockClear()
})

describe('GovernanceService — upstream-less decide input (issue #295)', () => {
  it('passes NO upstream key to decide() — sideband calls have no upstream', () => {
    // Guards the inertness design: upstream-scoped rules are inert on the
    // sideband because decide() copies an undefined input.upstream onto the
    // match context. A future accidental stamp here would light them up.
    const service = makeService()
    service.evaluate(evalInput())
    expect(vi.mocked(decide)).toHaveBeenCalledTimes(1)
    const input = vi.mocked(decide).mock.calls[0]?.[0]
    expect(input).toBeDefined()
    expect('upstream' in (input as object)).toBe(false)
  })
})
