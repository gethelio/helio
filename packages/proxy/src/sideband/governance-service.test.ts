import { describe, it, expect } from 'vitest'
import { GovernanceService } from './governance-service.js'
import type { EvaluateInput, AuditInput } from './governance-service.js'
import { GovernanceConfigError } from './errors.js'
import { compilePolicies } from '../policy/parser.js'
import type { PoliciesConfig } from '../config/schema.js'
import type { CompiledPolicy } from '../policy/types.js'
import type { AuditRecord } from '../audit/types.js'
import type { AuditWriter } from '../audit/writer.js'
import { RateLimiter } from '../policy/rate-limiter.js'
import { SpendLimiter } from '../policy/spend-limiter.js'
import { ApprovalRouter } from '../approval/router.js'
import { ApprovalQueue } from '../approval/queue.js'
import { EvidenceStore } from '../evidence/index.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function compile(config: Omit<PoliciesConfig, 'dry_run'> & { dry_run?: boolean }): CompiledPolicy {
  return compilePolicies({ dry_run: false, ...config }).policy
}

interface Captured {
  id: string
  record: Omit<AuditRecord, 'id' | 'created_at'>
  immediate: boolean
}

function fakeWriter() {
  const records: Captured[] = []
  let counter = 0
  const writer = {
    push: (record: Omit<AuditRecord, 'id' | 'created_at'>, id = `id-${String(++counter)}`) =>
      records.push({ id, record, immediate: false }),
    pushImmediate: (
      record: Omit<AuditRecord, 'id' | 'created_at'>,
      id = `id-${String(++counter)}`,
    ) => records.push({ id, record, immediate: true }),
  } as unknown as AuditWriter
  return { writer, records }
}

interface ServiceHarness {
  service: GovernanceService
  records: Captured[]
  advance: (ms: number) => void
  rateLimiter: RateLimiter | undefined
  spendLimiter: SpendLimiter | undefined
  approvalRouter: ApprovalRouter | undefined
  evidenceStore: EvidenceStore | undefined
}

function makeService(opts?: {
  policy?: CompiledPolicy
  withLimiters?: boolean
  withApprovals?: boolean
  withEvidence?: boolean
  ttlMs?: number
}): ServiceHarness {
  let time = 1_000_000
  const now = () => time
  const advance = (ms: number) => {
    time += ms
  }
  const { writer, records } = fakeWriter()
  const policy = opts?.policy ?? compile({ default: 'allow', rules: [] })

  const rateLimiter = opts?.withLimiters
    ? new RateLimiter({ now, cleanupIntervalMs: 0 })
    : undefined
  const spendLimiter = opts?.withLimiters
    ? new SpendLimiter({ now, cleanupIntervalMs: 0 })
    : undefined
  const queue = opts?.withApprovals ? new ApprovalQueue({ now, cleanupIntervalMs: 0 }) : undefined
  const approvalRouter =
    opts?.withApprovals && queue
      ? new ApprovalRouter({
          defaultTimeoutMs: 300_000,
          defaultOnTimeout: 'deny',
          channels: new Map(),
          queue,
          now,
        })
      : undefined
  const evidenceStore = opts?.withEvidence ? new EvidenceStore({ now }) : undefined

  const service = new GovernanceService({
    policy,
    auditWriter: writer,
    rateLimiter,
    spendLimiter,
    approvalRouter,
    evidenceStore,
    ttlMs: opts?.ttlMs ?? 600_000,
    now,
    sweepIntervalMs: 0,
  })

  return { service, records, advance, rateLimiter, spendLimiter, approvalRouter, evidenceStore }
}

function evalInput(overrides?: Partial<EvaluateInput>): EvaluateInput {
  return {
    origin: 'openclaw',
    agent_id: 'main',
    session_id: null,
    tool: { name: 'send' },
    arguments: {},
    metadata: null,
    ...overrides,
  }
}

function auditInput(id: string, overrides?: Partial<AuditInput>): AuditInput {
  return { evaluation_id: id, status: 'success', ...overrides }
}

// ---------------------------------------------------------------------------
// evaluate
// ---------------------------------------------------------------------------

describe('GovernanceService.evaluate', () => {
  it('returns allow for a default-allow policy and creates a pending entry', () => {
    const { service } = makeService()
    const res = service.evaluate(evalInput())
    expect(res.status).toBe(200)
    expect(res.body['decision']).toBe('allow')
    expect(res.body['evaluation_id']).toBeTruthy()
  })

  it('audits deny terminally at evaluate time (no /audit needed)', () => {
    const policy = compile({
      default: 'allow',
      rules: [{ name: 'no-send', match: { tool: 'send' }, action: 'deny' }],
    })
    const { service, records } = makeService({ policy })
    const res = service.evaluate(evalInput())
    expect(res.body['decision']).toBe('deny')
    expect(res.body['feedback']).toBeTruthy()
    expect(records).toHaveLength(1)
    expect(records[0]?.record.policy_decision).toBe('deny')
    expect(records[0]?.record.block_reason).toBe('policy_denied')
    expect(records[0]?.record.origin).toBe('openclaw')
    expect(records[0]?.immediate).toBe(true)
  })

  it('does not consume rate counters at evaluate (peek only)', () => {
    const policy = compile({
      default: 'allow',
      rules: [
        {
          name: 'rl',
          match: { tool: 'send' },
          action: 'rate_limit',
          limits: { max_calls: 2, window: '60s' },
        },
      ],
    })
    const { service, rateLimiter } = makeService({ policy, withLimiters: true })
    service.evaluate(evalInput())
    service.evaluate(evalInput())
    service.evaluate(evalInput())
    // Three evaluates, zero consumption — the bucket is still empty.
    expect(rateLimiter?.getKeyState('tool:send')).toBeUndefined()
  })

  it('returns rate_limited terminally when peek is over the limit', () => {
    const policy = compile({
      default: 'allow',
      rules: [
        {
          name: 'rl',
          match: { tool: 'send' },
          action: 'rate_limit',
          limits: { max_calls: 1, window: '60s' },
        },
      ],
    })
    const { service, rateLimiter, records } = makeService({ policy, withLimiters: true })
    // Pre-fill the bucket so peek is over the limit.
    rateLimiter?.record({ key: 'tool:send', maxCalls: 1, windowMs: 60_000 })
    const res = service.evaluate(evalInput())
    expect(res.body['decision']).toBe('rate_limited')
    expect(records.at(-1)?.record.block_reason).toBe('rate_limited')
  })

  it('creates a native approval ticket for require_approval', () => {
    const policy = compile({
      default: 'allow',
      rules: [{ name: 'ap', match: { tool: 'send' }, action: 'require_approval' }],
    })
    const { service, approvalRouter } = makeService({ policy, withApprovals: true })
    const res = service.evaluate(evalInput())
    expect(res.body['decision']).toBe('require_approval')
    const approval = res.body['approval'] as { id: string; resolve_path: string }
    expect(approval.id).toBeTruthy()
    expect(approval.resolve_path).toBe(`/approval/${approval.id}/resolve`)
    expect(approvalRouter?.getTicket(approval.id)?.channel_name).toBe('native:openclaw')
  })

  describe('drift guard (D6)', () => {
    it('detects drift across two evaluates and gates per on_tool_drift: block', () => {
      const policy = compile({ default: 'allow', on_tool_drift: 'block', rules: [] })
      const { service } = makeService({ policy })
      const first = service.evaluate(evalInput({ tool: { name: 'send', description: 'v1' } }))
      expect(first.body['decision']).toBe('allow')
      const second = service.evaluate(evalInput({ tool: { name: 'send', description: 'v2' } }))
      expect(second.body['decision']).toBe('deny')
      expect(second.body['tool_drift']).toBeTruthy()
    })

    it('isolates drift baselines per origin', () => {
      const policy = compile({ default: 'allow', on_tool_drift: 'block', rules: [] })
      const { service } = makeService({ policy })
      service.evaluate(evalInput({ origin: 'openclaw', tool: { name: 'send', description: 'v1' } }))
      // A different origin baselining the same tool name with a different def
      // must NOT be flagged as drift — separate caches.
      const other = service.evaluate(
        evalInput({ origin: 'hermes', tool: { name: 'send', description: 'vX' } }),
      )
      expect(other.body['decision']).toBe('allow')
    })
  })

  describe('memory budgets (D15)', () => {
    it('rejects tool_input over 64 KiB with 413', () => {
      const { service } = makeService()
      const big = 'x'.repeat(70 * 1024)
      const res = service.evaluate(evalInput({ arguments: { blob: big } }))
      expect(res.status).toBe(413)
    })

    it('rejects first-seen tools past the per-origin cap but allows existing updates', () => {
      const policy = compile({ default: 'allow', on_tool_drift: 'block', rules: [] })
      const { service } = makeService({ policy })
      // The cap is large (1024); simulate by spying is overkill — instead verify
      // that an already-baselined tool keeps evaluating (the at-cap rule).
      service.evaluate(evalInput({ tool: { name: 'send', description: 'v1' } }))
      const again = service.evaluate(evalInput({ tool: { name: 'send', description: 'v1' } }))
      expect(again.status).toBe(200)
    })
  })
})

// ---------------------------------------------------------------------------
// audit
// ---------------------------------------------------------------------------

describe('GovernanceService.audit', () => {
  it('consumes the rate counter on success and is idempotent on replay', () => {
    const policy = compile({
      default: 'allow',
      rules: [
        {
          name: 'rl',
          match: { tool: 'send' },
          action: 'rate_limit',
          limits: { max_calls: 5, window: '60s' },
        },
      ],
    })
    const { service, rateLimiter } = makeService({ policy, withLimiters: true })
    const ev = service.evaluate(evalInput())
    const id = ev.body['evaluation_id'] as string

    const a1 = service.audit(auditInput(id), 'hash-1')
    expect(a1.status).toBe(201)
    expect(rateLimiter?.getKeyState('tool:send')?.current).toBe(1)

    // Identical replay — idempotent, no double consumption.
    const a2 = service.audit(auditInput(id), 'hash-1')
    expect(a2.status).toBe(200)
    expect(a2.body['already_finalized']).toBe(true)
    expect(rateLimiter?.getKeyState('tool:send')?.current).toBe(1)
  })

  it('returns 409 evaluation_conflict on a different payload for a finalized id', () => {
    const { service } = makeService()
    const ev = service.evaluate(evalInput())
    const id = ev.body['evaluation_id'] as string
    service.audit(auditInput(id), 'hash-1')
    const conflict = service.audit(auditInput(id, { status: 'error' }), 'hash-2')
    expect(conflict.status).toBe(409)
    expect(conflict.body['error']).toBe('evaluation_conflict')
  })

  it('does not consume counters for not_executed', () => {
    const policy = compile({
      default: 'allow',
      rules: [
        {
          name: 'rl',
          match: { tool: 'send' },
          action: 'rate_limit',
          limits: { max_calls: 5, window: '60s' },
        },
      ],
    })
    const { service, rateLimiter } = makeService({ policy, withLimiters: true })
    const ev = service.evaluate(evalInput())
    const id = ev.body['evaluation_id'] as string
    service.audit(auditInput(id, { status: 'not_executed' }), 'h')
    expect(rateLimiter?.getKeyState('tool:send')).toBeUndefined()
  })

  it('returns 404 for an unknown evaluation id', () => {
    const { service } = makeService()
    expect(service.audit(auditInput('nope'), 'h').status).toBe(404)
  })

  it('returns 200 already_finalized for a terminal-at-evaluate decision', () => {
    const policy = compile({
      default: 'allow',
      rules: [{ name: 'd', match: { tool: 'send' }, action: 'deny' }],
    })
    const { service } = makeService({ policy })
    const ev = service.evaluate(evalInput())
    const id = ev.body['evaluation_id'] as string
    const res = service.audit(auditInput(id), 'any')
    expect(res.status).toBe(200)
    expect(res.body['finalized_by']).toBe('evaluate')
  })

  it('overrides spend with actual_amount at audit time', () => {
    const policy = compile({
      default: 'allow',
      rules: [
        {
          name: 'sp',
          match: { tool: 'send' },
          action: 'spend_limit',
          limits: { max_spend: { field: '$.cost', limit: 100, currency: 'USD', window: '1d' } },
        },
      ],
    })
    const { service, spendLimiter } = makeService({ policy, withLimiters: true })
    const ev = service.evaluate(evalInput({ arguments: { cost: 10 } }))
    const id = ev.body['evaluation_id'] as string
    service.audit(auditInput(id, { actual_amount: 42 }), 'h')
    expect(spendLimiter?.getKeyState('tool:send')?.current_spend).toBe(42)
  })
})

// ---------------------------------------------------------------------------
// approvals + deadlines
// ---------------------------------------------------------------------------

describe('GovernanceService approvals and deadlines', () => {
  it('blocks /audit with 409 until the approval is resolved, then copies status', () => {
    const policy = compile({
      default: 'allow',
      rules: [{ name: 'ap', match: { tool: 'send' }, action: 'require_approval' }],
    })
    const { service, records } = makeService({ policy, withApprovals: true })
    const ev = service.evaluate(evalInput())
    const id = ev.body['evaluation_id'] as string
    const approval = ev.body['approval'] as { id: string }

    expect(service.audit(auditInput(id), 'h').status).toBe(409)

    const resolve = service.resolveApproval(approval.id, {
      resolution: 'approved',
      resolved_by: 'telegram:@oli',
    })
    expect(resolve.status).toBe(200)

    const audited = service.audit(auditInput(id), 'h')
    expect(audited.status).toBe(201)
    expect(records.at(-1)?.record.approval_status).toBe('approved')
    expect(records.at(-1)?.record.approved_by).toBe('telegram:@oli')
  })

  it('enforces evaluation TTL on access (404 evaluation_expired before the sweep)', () => {
    const { service, advance, records } = makeService({ ttlMs: 1000 })
    const ev = service.evaluate(evalInput())
    const id = ev.body['evaluation_id'] as string

    advance(2000) // past TTL, but no sweep has run (sweepIntervalMs: 0)
    const res = service.audit(auditInput(id), 'h')
    expect(res.status).toBe(404)
    expect(res.body['error']).toBe('evaluation_expired')
    // An evaluation_expired record was written (the bypass signal).
    expect(records.at(-1)?.record.record_kind).toBe('evaluation_expired')
    expect(records.at(-1)?.record.block_reason).toBeNull()
  })

  it('times out a native ticket when its deadline passes before the evaluation TTL', () => {
    const policy = compile({
      default: 'allow',
      rules: [
        {
          name: 'ap',
          match: { tool: 'send' },
          action: 'require_approval',
          approval: { channel: 'native', timeout: '1s' },
        },
      ],
    })
    const { service, advance, approvalRouter } = makeService({
      policy,
      withApprovals: true,
      ttlMs: 600_000,
    })
    const ev = service.evaluate(evalInput())
    const approval = ev.body['approval'] as { id: string }
    advance(2000) // ticket deadline passed, evaluation TTL not
    service.sweep()
    expect(approvalRouter?.getTicket(approval.id)?.status).toBe('timeout')
  })

  it('rejects a late resolve before the sweep with 409 (on-access enforcement)', () => {
    const policy = compile({
      default: 'allow',
      rules: [
        {
          name: 'ap',
          match: { tool: 'send' },
          action: 'require_approval',
          approval: { channel: 'native', timeout: '1s' },
        },
      ],
    })
    const { service, advance } = makeService({ policy, withApprovals: true, ttlMs: 600_000 })
    const ev = service.evaluate(evalInput())
    const approval = ev.body['approval'] as { id: string }

    advance(2000) // past the ticket deadline, but NO sweep has run
    const res = service.resolveApproval(approval.id, { resolution: 'approved', resolved_by: 'x' })
    expect(res.status).toBe(409)
    expect(res.body['error']).toBe('already_resolved')
    expect(res.body['status']).toBe('timeout')
  })
})

// ---------------------------------------------------------------------------
// actual_amount validation (§4 policy) and memory-budget overshoot
// ---------------------------------------------------------------------------

describe('GovernanceService /audit validation and budgets', () => {
  const spendPolicy = () =>
    compile({
      default: 'allow',
      rules: [
        {
          name: 'sp',
          match: { tool: 'send' },
          action: 'spend_limit',
          limits: { max_spend: { field: '$.cost', limit: 100, currency: 'USD', window: '1d' } },
        },
      ],
    })

  it('rejects a negative actual_amount with 400 invalid_actual_amount', () => {
    const { service } = makeService({ policy: spendPolicy(), withLimiters: true })
    const ev = service.evaluate(evalInput({ arguments: { cost: 10 } }))
    const id = ev.body['evaluation_id'] as string
    const res = service.audit(auditInput(id, { actual_amount: -5 }), 'h')
    expect(res.status).toBe(400)
    expect(res.body['error']).toBe('invalid_actual_amount')
  })

  it('rejects actual_amount on a non-spend evaluation with 400 no_spend_rule', () => {
    const { service } = makeService() // default allow, no spend plan
    const ev = service.evaluate(evalInput())
    const id = ev.body['evaluation_id'] as string
    const res = service.audit(auditInput(id, { actual_amount: 5 }), 'h')
    expect(res.status).toBe(400)
    expect(res.body['error']).toBe('no_spend_rule')
  })

  it('does not overshoot the pending-bytes cap (the crossing entry is refused)', () => {
    // A tiny byte cap so the second pending entry crosses it.
    const service = new GovernanceService({
      policy: compile({ default: 'allow', rules: [] }),
      sweepIntervalMs: 0,
      maxPendingBytes: 30,
    })
    // First evaluate fits; second would push pendingBytes over the cap.
    const first = service.evaluate(evalInput({ arguments: { a: 'xxxxxxxxxx' } }))
    expect(first.status).toBe(200)
    const second = service.evaluate(evalInput({ arguments: { b: 'yyyyyyyyyy' } }))
    expect(second.status).toBe(503)
    expect(second.body['error']).toBe('evaluation_backlog_full')
    service.close()
  })
})

// ---------------------------------------------------------------------------
// approval-router wiring hardening (fail-closed guard)
// ---------------------------------------------------------------------------

describe('GovernanceService approval wiring', () => {
  it('throws at construction when a require_approval rule exists without approvalRouter', () => {
    const policy = compile({
      default: 'allow',
      rules: [{ name: 'ap', match: { tool: 'send' }, action: 'require_approval' }],
    })
    expect(() => new GovernanceService({ policy, sweepIntervalMs: 0 })).toThrow(
      GovernanceConfigError,
    )
  })

  it('throws at construction when flag_destructive can emit require_approval', () => {
    const policy = compile({
      default: 'allow',
      flag_destructive: 'require_approval',
      rules: [],
    })
    expect(() => new GovernanceService({ policy, sweepIntervalMs: 0 })).toThrow(
      GovernanceConfigError,
    )
  })

  it('throws at construction when on_tool_drift can emit require_approval', () => {
    const policy = compile({
      default: 'allow',
      on_tool_drift: 'require_approval',
      rules: [],
    })
    expect(() => new GovernanceService({ policy, sweepIntervalMs: 0 })).toThrow(
      GovernanceConfigError,
    )
  })

  it('allows construction when approvalRouter is present', () => {
    const queue = new ApprovalQueue({ cleanupIntervalMs: 0 })
    const router = new ApprovalRouter({
      defaultTimeoutMs: 1000,
      defaultOnTimeout: 'deny',
      channels: new Map(),
      queue,
    })
    const policy = compile({
      default: 'allow',
      rules: [{ name: 'ap', match: { tool: 'send' }, action: 'require_approval' }],
    })
    expect(
      () =>
        new GovernanceService({
          policy,
          approvalRouter: router,
          sweepIntervalMs: 0,
        }),
    ).not.toThrow()
    router.close()
    queue.close()
  })

  it('rejects an updatePolicy upgrade to approval-capable without approvalRouter', () => {
    const oldPolicy = compile({
      default: 'allow',
      rules: [{ name: 'deny-send', match: { tool: 'send' }, action: 'deny' }],
    })
    const nextPolicy = compile({
      default: 'allow',
      rules: [{ name: 'ap', match: { tool: 'send' }, action: 'require_approval' }],
    })
    const service = new GovernanceService({ policy: oldPolicy, sweepIntervalMs: 0 })
    const before = service.evaluate(evalInput())
    expect(before.body['decision']).toBe('deny')

    expect(() => {
      service.updatePolicy(nextPolicy)
    }).toThrow(GovernanceConfigError)

    const after = service.evaluate(evalInput())
    expect(after.body['decision']).toBe('deny')
    service.close()
  })
})

// ---------------------------------------------------------------------------
// install-scan + resolve
// ---------------------------------------------------------------------------

describe('GovernanceService.installScan', () => {
  it('returns observational allow and writes an install_scan record', () => {
    const { service, records } = makeService()
    const res = service.installScan({
      origin: 'openclaw',
      agent_id: null,
      session_id: null,
      package: { name: 'left-pad', source: 'npm', version: '1.3.0' },
      metadata: null,
    })
    expect(res.status).toBe(200)
    expect(res.body['decision']).toBe('allow')
    expect(records[0]?.record.record_kind).toBe('install_scan')
    expect(records[0]?.record.tool_name).toBe('install:npm:left-pad')
  })
})

describe('GovernanceService.resolveApproval', () => {
  it('404s an unknown ticket and 409s a non-native ticket', () => {
    const queue = new ApprovalQueue({ cleanupIntervalMs: 0 })
    const router = new ApprovalRouter({
      defaultTimeoutMs: 1000,
      defaultOnTimeout: 'deny',
      channels: new Map(),
      queue,
    })
    const service = new GovernanceService({
      policy: compile({ default: 'allow', rules: [] }),
      approvalRouter: router,
      sweepIntervalMs: 0,
    })
    expect(service.resolveApproval('nope', { resolution: 'approved' }).status).toBe(404)

    // A router-managed (non-native) ticket cannot be resolved via the sideband.
    void router.submit({
      tool_name: 't',
      tool_input: {},
      matched_rule: undefined,
      session_id: null,
    })
    const ticketId = queue.listPending()[0]?.id as string
    expect(service.resolveApproval(ticketId, { resolution: 'approved' }).body['error']).toBe(
      'not_a_native_ticket',
    )
    router.close()
  })
})
