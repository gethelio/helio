import { describe, it, expect, vi, afterEach } from 'vitest'
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
  maxSenderKeys?: number
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
    ...(opts?.maxSenderKeys !== undefined && { maxSenderKeys: opts.maxSenderKeys }),
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

// ---------------------------------------------------------------------------
// match.metadata + reserved-key rejection (issue #13)
// ---------------------------------------------------------------------------

describe('GovernanceService — match.metadata threading', () => {
  const denyOnChannel = compile({
    default: 'allow',
    rules: [{ match: { metadata: { channel_id: 'C1' } }, action: 'deny' }],
  })

  it('a metadata-keyed rule denies when the matching context is supplied', () => {
    const { service } = makeService({ policy: denyOnChannel })
    const res = service.evaluate(evalInput({ metadata: { channel_id: 'C1' } }))
    expect(res.body).toMatchObject({ decision: 'deny' })
  })

  it('the same rule is inert when the context differs / is absent', () => {
    const { service } = makeService({ policy: denyOnChannel })
    expect(service.evaluate(evalInput({ metadata: { channel_id: 'C2' } })).body).toMatchObject({
      decision: 'allow',
    })
    expect(service.evaluate(evalInput({ metadata: null })).body).toMatchObject({
      decision: 'allow',
    })
  })

  it('matches the virtual agent_id key against the request agent_id', () => {
    const policy = compile({
      default: 'allow',
      rules: [{ match: { metadata: { agent_id: 'main' } }, action: 'deny' }],
    })
    const { service } = makeService({ policy })
    expect(service.evaluate(evalInput({ agent_id: 'main', metadata: null })).body).toMatchObject({
      decision: 'deny',
    })
    expect(service.evaluate(evalInput({ agent_id: 'other', metadata: null })).body).toMatchObject({
      decision: 'allow',
    })
  })

  it('rejects a reserved agent_id key inside metadata at the SERVICE layer', () => {
    const { service } = makeService()
    const res = service.evaluate(evalInput({ metadata: { agent_id: 'spoofed' } }))
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ error: 'reserved_metadata_key', key: 'agent_id' })
  })

  it('rejects a reserved agent_id key inside install-scan metadata too', () => {
    const { service } = makeService()
    const res = service.installScan({
      origin: 'openclaw',
      agent_id: 'main',
      session_id: null,
      package: { name: 'left-pad', source: 'npm' },
      metadata: { agent_id: 'spoofed' },
    })
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ error: 'reserved_metadata_key', key: 'agent_id' })
  })
})

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

  describe('drift guard', () => {
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

  describe('memory budgets', () => {
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
// rule feedback on gating decisions (issue #78)
// ---------------------------------------------------------------------------

describe('GovernanceService.evaluate — rule feedback', () => {
  it('returns configured feedback on require_approval', () => {
    const policy = compile({
      default: 'allow',
      rules: [
        {
          name: 'ap',
          match: { tool: 'send' },
          action: 'require_approval',
          feedback: { message: 'Needs a human sign-off', suggestion: 'Ask in #ops' },
        },
      ],
    })
    const { service } = makeService({ policy, withApprovals: true })
    const res = service.evaluate(evalInput())
    expect(res.body['decision']).toBe('require_approval')
    expect(res.body['feedback']).toStrictEqual({
      message: 'Needs a human sign-off',
      suggestion: 'Ask in #ops',
    })
    expect(res.body['approval']).toBeTruthy()
  })

  it('omits feedback on require_approval when the rule configures none', () => {
    const policy = compile({
      default: 'allow',
      rules: [{ name: 'ap', match: { tool: 'send' }, action: 'require_approval' }],
    })
    const { service } = makeService({ policy, withApprovals: true })
    const res = service.evaluate(evalInput())
    expect(res.body['decision']).toBe('require_approval')
    expect(res.body).not.toHaveProperty('feedback')
  })

  it('returns configured feedback on a per-rule dry_run', () => {
    const policy = compile({
      default: 'allow',
      rules: [
        {
          name: 'shadow',
          match: { tool: 'send' },
          action: 'dry_run',
          feedback: { message: 'Would be blocked in enforce mode' },
        },
      ],
    })
    const { service } = makeService({ policy })
    const res = service.evaluate(evalInput())
    expect(res.body['decision']).toBe('dry_run')
    expect(res.body['feedback']).toStrictEqual({ message: 'Would be blocked in enforce mode' })
  })

  it('returns the underlying matched rule feedback under global dry_run', () => {
    const policy = compile({
      default: 'allow',
      dry_run: true,
      rules: [
        {
          name: 'no-send',
          match: { tool: 'send' },
          action: 'deny',
          feedback: { message: 'Sending is disabled' },
        },
      ],
    })
    const { service } = makeService({ policy })
    const res = service.evaluate(evalInput())
    expect(res.body['decision']).toBe('dry_run')
    expect(res.body['feedback']).toStrictEqual({ message: 'Sending is disabled' })
  })

  it('omits feedback under global dry_run when no rule matched', () => {
    const policy = compile({ default: 'allow', dry_run: true, rules: [] })
    const { service } = makeService({ policy })
    const res = service.evaluate(evalInput())
    expect(res.body['decision']).toBe('dry_run')
    expect(res.body).not.toHaveProperty('feedback')
  })

  it('omits feedback under global dry_run when the matched rule is a plain allow', () => {
    const policy = compile({
      default: 'deny',
      dry_run: true,
      rules: [
        {
          name: 'ok-send',
          match: { tool: 'send' },
          action: 'allow',
          feedback: { message: 'Sending is fine' },
        },
      ],
    })
    const { service } = makeService({ policy })
    const res = service.evaluate(evalInput())
    expect(res.body['decision']).toBe('dry_run')
    expect((res.body['dry_run'] as { would_forward: boolean }).would_forward).toBe(true)
    expect(res.body).not.toHaveProperty('feedback')
  })

  it('omits feedback on require_approval escalated by flag_destructive (no matched rule)', () => {
    const policy = compile({ default: 'allow', flag_destructive: 'require_approval', rules: [] })
    const { service } = makeService({ policy, withApprovals: true })
    const res = service.evaluate(
      evalInput({ tool: { name: 'send', annotations: { destructiveHint: true } } }),
    )
    expect(res.body['decision']).toBe('require_approval')
    expect(res.body['matched_rule']).toBeNull()
    expect(res.body).not.toHaveProperty('feedback')
  })

  it('keeps the reason fallback on deny when the rule configures no feedback', () => {
    const policy = compile({
      default: 'allow',
      rules: [{ name: 'no-send', match: { tool: 'send' }, action: 'deny' }],
    })
    const { service } = makeService({ policy })
    const res = service.evaluate(evalInput())
    expect(res.body['decision']).toBe('deny')
    expect(res.body['feedback']).toStrictEqual({ message: 'Matched "no-send" → deny' })
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
// deny_install (issue #13)
// ---------------------------------------------------------------------------

describe('GovernanceService.installScan — deny_install', () => {
  const blockEvilNpm = compile({
    default: 'allow',
    rules: [],
    install: {
      default: 'allow',
      rules: [
        { name: 'block-evil', match: { name: 'evil-*', source: 'npm' }, action: 'deny_install' },
      ],
    },
  })

  const scan = (
    service: GovernanceService,
    pkg: { name: string; source?: string },
    metadata: Record<string, unknown> | null = null,
  ) =>
    service.installScan({
      origin: 'openclaw',
      agent_id: 'main',
      session_id: null,
      package: pkg,
      metadata,
    })

  it('denies a matching install — decision deny, install_denied, policy_decision deny', () => {
    const { service, records } = makeService({ policy: blockEvilNpm })
    const res = scan(service, { name: 'evil-pkg', source: 'npm' })
    expect(res.status).toBe(200)
    expect(res.body['decision']).toBe('deny')
    expect(res.body['matched_rule']).toBe('block-evil')
    const rec = records.at(-1)?.record
    // policy_decision MUST be 'deny' (not 'deny_install'), else the dashboard
    // renders the blocked install as "allow".
    expect(rec?.policy_decision).toBe('deny')
    expect(rec?.block_reason).toBe('install_denied')
    expect(rec?.record_kind).toBe('install_scan')
  })

  it('allows a non-matching package name', () => {
    const { service } = makeService({ policy: blockEvilNpm })
    expect(scan(service, { name: 'left-pad', source: 'npm' }).body['decision']).toBe('allow')
  })

  it('respects the source matcher (evil-* but pip → no match)', () => {
    const { service } = makeService({ policy: blockEvilNpm })
    expect(scan(service, { name: 'evil-pkg', source: 'pip' }).body['decision']).toBe('allow')
  })

  it('honors install.default: deny', () => {
    const denyAll = compile({
      default: 'allow',
      rules: [],
      install: { default: 'deny', rules: [] },
    })
    const { service, records } = makeService({ policy: denyAll })
    const res = scan(service, { name: 'anything', source: 'npm' })
    expect(res.body['decision']).toBe('deny')
    expect(records.at(-1)?.record.block_reason).toBe('install_denied')
  })

  it('can gate installs on metadata (sender_id)', () => {
    const policy = compile({
      default: 'allow',
      rules: [],
      install: {
        default: 'allow',
        rules: [{ match: { metadata: { sender_id: 'U9' } }, action: 'deny_install' }],
      },
    })
    const { service } = makeService({ policy })
    expect(scan(service, { name: 'x', source: 'npm' }, { sender_id: 'U9' }).body['decision']).toBe(
      'deny',
    )
    expect(scan(service, { name: 'x', source: 'npm' }, { sender_id: 'U1' }).body['decision']).toBe(
      'allow',
    )
  })

  it('still allows with the observational reason when no install rules exist', () => {
    const { service } = makeService()
    const res = scan(service, { name: 'left-pad', source: 'npm' })
    expect(res.body['decision']).toBe('allow')
    expect(res.body['reason']).toBe('no install-time rules defined')
  })

  it('picks up install rules added by a hot-reload (updatePolicy)', () => {
    const { service } = makeService()
    expect(scan(service, { name: 'evil-pkg', source: 'npm' }).body['decision']).toBe('allow')
    service.updatePolicy(blockEvilNpm)
    expect(scan(service, { name: 'evil-pkg', source: 'npm' }).body['decision']).toBe('deny')
  })
})

// ---------------------------------------------------------------------------
// sender_id limit scoping (issue #13)
// ---------------------------------------------------------------------------

describe('GovernanceService — sender_id keyed limits', () => {
  const rateBySender = compile({
    default: 'allow',
    rules: [
      {
        match: { tool: 'send' },
        action: 'rate_limit',
        limits: { max_calls: 1, window: '1m', key: 'sender_id' },
      },
    ],
  })

  function consume(service: GovernanceService, sender: string) {
    const ev = service.evaluate(evalInput({ metadata: { sender_id: sender } }))
    const id = ev.body['evaluation_id'] as string
    service.audit(auditInput(id), 'h')
    return ev
  }

  it('keys the rate bucket by sender_id, not tool', () => {
    const { service, rateLimiter } = makeService({ policy: rateBySender, withLimiters: true })
    consume(service, 'U1')
    expect(rateLimiter?.getKeyState('sender:U1')?.current).toBe(1)
    expect(rateLimiter?.getKeyState('tool:send')).toBeUndefined()
  })

  it('gives different senders independent buckets', () => {
    const { service } = makeService({ policy: rateBySender, withLimiters: true })
    consume(service, 'U1') // U1 now at its limit
    // U1's next call is rate_limited; U2 is unaffected.
    expect(service.evaluate(evalInput({ metadata: { sender_id: 'U1' } })).body['decision']).toBe(
      'rate_limited',
    )
    expect(service.evaluate(evalInput({ metadata: { sender_id: 'U2' } })).body['decision']).toBe(
      'allow',
    )
  })

  it('falls back to sender:unknown when sender_id is absent', () => {
    const { service, rateLimiter } = makeService({ policy: rateBySender, withLimiters: true })
    const ev = service.evaluate(evalInput({ metadata: null }))
    const id = ev.body['evaluation_id'] as string
    service.audit(auditInput(id), 'h')
    expect(rateLimiter?.getKeyState('sender:unknown')?.current).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// sender-key reservation registry (issue #13)
// ---------------------------------------------------------------------------

describe('GovernanceService — sender-key cardinality registry', () => {
  // Rooms enough peek headroom that the limiter never blocks; the registry is
  // what we're exercising.
  const rateBySender = compile({
    default: 'allow',
    rules: [
      {
        match: { tool: 'send' },
        action: 'rate_limit',
        limits: { max_calls: 5, window: '1m', key: 'sender_id' },
      },
    ],
  })

  const evalSender = (sender: string) => evalInput({ metadata: { sender_id: sender } })

  it('admits distinct senders up to the cap, then fails new ones closed with 503', () => {
    const { service } = makeService({ policy: rateBySender, withLimiters: true, maxSenderKeys: 1 })
    // First sender reserves the only slot.
    expect(service.evaluate(evalSender('U1')).status).toBe(200)
    // A different sender would mint a second key → fail closed.
    const res = service.evaluate(evalSender('U2'))
    expect(res.status).toBe(503)
    expect(res.body['error']).toBe('limit_capacity_exhausted')
    // The already-reserved sender keeps working (not a new key).
    expect(service.evaluate(evalSender('U1')).status).toBe(200)
  })

  it('does not gate tool/session-keyed limits (no cross-door starvation)', () => {
    const sessionRule = compile({
      default: 'allow',
      rules: [
        {
          match: { tool: 'send' },
          action: 'rate_limit',
          limits: { max_calls: 5, window: '1m', key: 'session' },
        },
      ],
    })
    const { service } = makeService({ policy: sessionRule, withLimiters: true, maxSenderKeys: 1 })
    // Many distinct sessions never consume sender-registry slots.
    expect(service.evaluate(evalInput({ session_id: 'sess-a' })).status).toBe(200)
    expect(service.evaluate(evalInput({ session_id: 'sess-b' })).status).toBe(200)
    expect(service.evaluate(evalInput({ session_id: 'sess-c' })).status).toBe(200)
  })

  it('releases a reservation when its evaluation expires (sweep prune)', () => {
    const { service, advance } = makeService({
      policy: rateBySender,
      withLimiters: true,
      maxSenderKeys: 1,
      ttlMs: 1000,
    })
    service.evaluate(evalSender('U1')) // reserves U1 (pending, never audited)
    expect(service.evaluate(evalSender('U2')).status).toBe(503)

    advance(2000) // U1's evaluation passes TTL
    service.sweep() // expires the pending entry and prunes the freed key

    // The slot is now free for a new sender.
    expect(service.evaluate(evalSender('U2')).status).toBe(200)
  })

  it('lazily prunes an emptied bucket on a capacity-pressured evaluate', () => {
    const tightRate = compile({
      default: 'allow',
      rules: [
        {
          match: { tool: 'send' },
          action: 'rate_limit',
          limits: { max_calls: 1, window: '1m', key: 'sender_id' },
        },
      ],
    })
    const { service, advance } = makeService({
      policy: tightRate,
      withLimiters: true,
      maxSenderKeys: 1,
    })
    // U1 consumes its bucket.
    const ev = service.evaluate(evalSender('U1'))
    service.audit(auditInput(ev.body['evaluation_id'] as string), 'h')

    advance(61_000) // U1's window slides; its bucket is now empty/evictable

    // A new sender at cap triggers a lazy prune of the dead U1 key → admitted.
    expect(service.evaluate(evalSender('U2')).status).toBe(200)
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

  it('records evidence_chain.approval with denial_reason for a native denial', () => {
    const policy = compile({
      default: 'allow',
      rules: [{ name: 'ap', match: { tool: 'send' }, action: 'require_approval' }],
    })
    const { service, records } = makeService({ policy, withApprovals: true })
    const ev = service.evaluate(evalInput())
    const id = ev.body['evaluation_id'] as string
    const approval = ev.body['approval'] as { id: string }

    const resolve = service.resolveApproval(approval.id, {
      resolution: 'denied',
      resolved_by: 'telegram:@oli',
      reason: 'Too risky',
    })
    expect(resolve.status).toBe(200)

    const audited = service.audit(auditInput(id), 'h')
    expect(audited.status).toBe(201)
    const record = records.at(-1)?.record
    expect(record?.approval_status).toBe('denied')
    const chain = record?.evidence_chain as Record<string, unknown>
    expect(chain).not.toBeNull()
    const approvalBlock = chain['approval'] as Record<string, unknown>
    expect(approvalBlock['ticket_id']).toBe(approval.id)
    expect(approvalBlock['denial_reason']).toBe('Too risky')
    expect(approvalBlock).not.toHaveProperty('escalated_at')
  })

  it('records no approval block for a native approval without denial reason', () => {
    const policy = compile({
      default: 'allow',
      rules: [{ name: 'ap', match: { tool: 'send' }, action: 'require_approval' }],
    })
    const { service, records } = makeService({ policy, withApprovals: true })
    const ev = service.evaluate(evalInput())
    const id = ev.body['evaluation_id'] as string
    const approval = ev.body['approval'] as { id: string }

    service.resolveApproval(approval.id, { resolution: 'approved', resolved_by: 'x' })

    expect(service.audit(auditInput(id), 'h').status).toBe(201)
    expect(records.at(-1)?.record.evidence_chain).toBeNull()
  })

  it('replays /audit idempotently with the approval block intact', () => {
    const policy = compile({
      default: 'allow',
      rules: [{ name: 'ap', match: { tool: 'send' }, action: 'require_approval' }],
    })
    const { service, records } = makeService({ policy, withApprovals: true })
    const ev = service.evaluate(evalInput())
    const id = ev.body['evaluation_id'] as string
    const approval = ev.body['approval'] as { id: string }

    service.resolveApproval(approval.id, {
      resolution: 'denied',
      resolved_by: 'x',
      reason: 'nope',
    })

    const first = service.audit(auditInput(id), 'h')
    expect(first.status).toBe(201)
    const recordCount = records.length

    const replay = service.audit(auditInput(id), 'h')
    expect(replay.status).toBe(200)
    expect(replay.body['already_finalized']).toBe(true)
    expect(replay.body['audit_record_id']).toBe(first.body['audit_record_id'])
    expect(records.length).toBe(recordCount)

    const chain = records.at(-1)?.record.evidence_chain as Record<string, unknown>
    expect((chain['approval'] as Record<string, unknown>)['denial_reason']).toBe('nope')
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
// actual_amount validation and memory-budget overshoot
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

// ---------------------------------------------------------------------------
// /audit evidence population (issue #11)
// ---------------------------------------------------------------------------

describe('audit evidence', () => {
  type Outcome = { evidence_key: string; stored: boolean; reason?: string }

  function evalAudit(
    harness: ServiceHarness,
    evidence: AuditInput['evidence'],
    opts?: { status?: AuditInput['status']; sessionId?: string | null; hash?: string },
  ) {
    const ev = harness.service.evaluate(
      evalInput({ session_id: opts?.sessionId === undefined ? 'oc:s1' : opts.sessionId }),
    )
    const id = ev.body['evaluation_id'] as string
    const res = harness.service.audit(
      auditInput(id, { status: opts?.status ?? 'success', evidence }),
      opts?.hash ?? 'h',
    )
    return { id, res, outcomes: res.body['evidence'] as Outcome[] | undefined }
  }

  it('writes evidence to the store on a successful audit and reports stored:true', () => {
    const h = makeService({ withEvidence: true })
    const { res, outcomes } = evalAudit(h, [
      { evidence_key: 'recipient', evidence_data: { to: 'a@b.com' } },
    ])

    expect(res.status).toBe(201)
    expect(outcomes).toEqual([{ evidence_key: 'recipient', stored: true }])
    expect(h.evidenceStore?.getEvidence('oc:s1', 'recipient')?.data).toEqual({ to: 'a@b.com' })
    expect(h.evidenceStore?.getEvidence('oc:s1', 'recipient')?.tool_name).toBe('send')
  })

  it('ignores evidence when the call errored (success-only)', () => {
    const h = makeService({ withEvidence: true })
    const { res, outcomes } = evalAudit(h, [{ evidence_key: 'recipient', evidence_data: 'x' }], {
      status: 'error',
    })

    expect(res.status).toBe(201)
    expect(outcomes).toBeUndefined()
    expect(h.evidenceStore?.hasEvidence('oc:s1', 'recipient')).toBe(false)
  })

  it('ignores evidence when status is not_executed', () => {
    const h = makeService({ withEvidence: true })
    const { outcomes } = evalAudit(h, [{ evidence_key: 'recipient', evidence_data: 'x' }], {
      status: 'not_executed',
    })

    expect(outcomes).toBeUndefined()
    expect(h.evidenceStore?.hasEvidence('oc:s1', 'recipient')).toBe(false)
  })

  it('soft-fails an allowlist-rejected key but still finalizes 201', () => {
    const h = makeService({ withEvidence: true })
    h.evidenceStore?.setAllowedEvidenceKeys(['allowed'])
    const { res, outcomes } = evalAudit(h, [{ evidence_key: 'blocked', evidence_data: 'x' }])

    expect(res.status).toBe(201)
    expect(outcomes).toEqual([
      { evidence_key: 'blocked', stored: false, reason: 'key_not_in_policy_allowlist' },
    ])
    expect(h.evidenceStore?.hasEvidence('oc:s1', 'blocked')).toBe(false)
  })

  it('soft-drops an oversized entry with reason too_large (no 413)', () => {
    const h = makeService({ withEvidence: true })
    const big = 'x'.repeat(70 * 1024)
    const { res, outcomes } = evalAudit(h, [{ evidence_key: 'big', evidence_data: big }])

    expect(res.status).toBe(201)
    expect(outcomes).toEqual([{ evidence_key: 'big', stored: false, reason: 'too_large' }])
    expect(h.evidenceStore?.hasEvidence('oc:s1', 'big')).toBe(false)
  })

  it('soft-drops entries beyond MAX_EVIDENCE_ENTRIES with reason too_many', () => {
    const h = makeService({ withEvidence: true })
    const entries = Array.from({ length: 18 }, (_, i) => ({
      evidence_key: `k${String(i)}`,
      evidence_data: i,
    }))
    const { res, outcomes } = evalAudit(h, entries)

    expect(res.status).toBe(201)
    expect(outcomes).toHaveLength(18)
    expect(outcomes?.slice(0, 16).every((o) => o.stored)).toBe(true)
    expect(outcomes?.slice(16)).toEqual([
      { evidence_key: 'k16', stored: false, reason: 'too_many' },
      { evidence_key: 'k17', stored: false, reason: 'too_many' },
    ])
    expect(h.evidenceStore?.hasEvidence('oc:s1', 'k15')).toBe(true)
    expect(h.evidenceStore?.hasEvidence('oc:s1', 'k16')).toBe(false)
  })

  it('soft-fails with reason no_session when the evaluation has no session', () => {
    const h = makeService({ withEvidence: true })
    const { res, outcomes } = evalAudit(h, [{ evidence_key: 'k', evidence_data: 'x' }], {
      sessionId: null,
    })

    expect(res.status).toBe(201)
    expect(outcomes).toEqual([{ evidence_key: 'k', stored: false, reason: 'no_session' }])
  })

  it('soft-fails with reason evidence_unavailable when the service has no evidence store', () => {
    const h = makeService() // no withEvidence → evidenceStore undefined
    const { res, outcomes } = evalAudit(h, [{ evidence_key: 'k', evidence_data: 'x' }])

    expect(res.status).toBe(201)
    expect(outcomes).toEqual([{ evidence_key: 'k', stored: false, reason: 'evidence_unavailable' }])
  })

  it('soft-fails with reason closed when the store is shutting down — still 201, never 503', () => {
    const h = makeService({ withEvidence: true })
    h.evidenceStore?.close()
    const { res, outcomes } = evalAudit(h, [{ evidence_key: 'k', evidence_data: 'x' }])

    expect(res.status).toBe(201)
    expect(outcomes).toEqual([{ evidence_key: 'k', stored: false, reason: 'closed' }])
  })

  it('does not re-write evidence on an idempotent replay', () => {
    const h = makeService({ withEvidence: true })
    const { id } = evalAudit(h, [{ evidence_key: 'k', evidence_data: 'v' }])
    const firstExpiry = h.evidenceStore?.getEvidence('oc:s1', 'k')?.expires_at

    h.advance(10_000)
    const replay = h.service.audit(
      auditInput(id, { evidence: [{ evidence_key: 'k', evidence_data: 'v' }] }),
      'h',
    )

    expect(replay.status).toBe(200)
    expect(replay.body['already_finalized']).toBe(true)
    // No re-write → TTL/expiry unchanged despite the 10s advance.
    expect(h.evidenceStore?.getEvidence('oc:s1', 'k')?.expires_at).toBe(firstExpiry)
  })

  it('is a no-op (no outcomes) when no evidence is supplied', () => {
    const h = makeService({ withEvidence: true })
    const { outcomes } = evalAudit(h, undefined)
    expect(outcomes).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// adapter liveness registry (issue #126)
// ---------------------------------------------------------------------------

describe('GovernanceService adapter liveness registry', () => {
  const BASE = 1_000_000
  const iso = (ms: number) => new Date(ms).toISOString()

  afterEach(() => {
    vi.restoreAllMocks()
  })

  const installInput = (origin: string) => ({
    origin,
    agent_id: null,
    session_id: null,
    package: { name: 'left-pad' },
    metadata: null,
  })

  it('evaluate records first_seen/last_seen with a null version when none is supplied', () => {
    const { service } = makeService()
    service.evaluate(evalInput())
    expect(service.listAdapters()).toEqual([
      {
        origin: 'openclaw',
        adapter_version: null,
        first_seen: iso(BASE),
        last_seen: iso(BASE),
      },
    ])
  })

  it('records the supplied version, updates last-write-wins, and keeps first_seen', () => {
    const { service, advance } = makeService()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    service.evaluate(evalInput({ adapter_version: '0.1.0' }))
    advance(5_000)
    service.evaluate(evalInput({ adapter_version: '0.2.0' }))
    expect(service.listAdapters()).toEqual([
      {
        origin: 'openclaw',
        adapter_version: '0.2.0',
        first_seen: iso(BASE),
        last_seen: iso(BASE + 5_000),
      },
    ])
  })

  it('retains the last supplied version when a later evaluate omits it', () => {
    const { service, advance } = makeService()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    service.evaluate(evalInput({ adapter_version: '0.1.0' }))
    advance(1_000)
    service.evaluate(evalInput())
    expect(service.listAdapters()[0]).toMatchObject({
      adapter_version: '0.1.0',
      last_seen: iso(BASE + 1_000),
    })
  })

  it('ignores an empty or over-64-char adapter_version (embedder path)', () => {
    const { service } = makeService()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    service.evaluate(evalInput({ adapter_version: '' }))
    expect(service.listAdapters()[0]?.adapter_version).toBeNull()
    service.evaluate(evalInput({ adapter_version: 'v'.repeat(65) }))
    expect(service.listAdapters()[0]?.adapter_version).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })

  it('escapes a caller-controlled origin in version log lines (embedder path)', () => {
    const { service } = makeService()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const evil = 'x\n[helio] forged line'
    service.evaluate(evalInput({ origin: evil, adapter_version: '1.0' }))
    const line = String(spy.mock.calls[0]?.[0])
    expect(line).not.toMatch(/\n/)
    expect(line).toContain(JSON.stringify(evil))
  })

  it('does not refresh last_seen when the audit write throws (audit not finalized)', () => {
    let time = BASE
    const throwingWriter = {
      push: () => {
        throw new Error('disk full')
      },
      pushImmediate: () => {
        throw new Error('disk full')
      },
    } as unknown as AuditWriter
    const service = new GovernanceService({
      policy: compile({ default: 'allow', rules: [] }),
      auditWriter: throwingWriter,
      ttlMs: 600_000,
      now: () => time,
      sweepIntervalMs: 0,
    })
    const ev = service.evaluate(evalInput())
    const id = ev.body['evaluation_id'] as string
    time += 5_000
    expect(() => service.audit(auditInput(id), 'h')).toThrow()
    expect(service.listAdapters()[0]?.last_seen).toBe(iso(BASE))
  })

  it('logs first sighting and version changes with the version JSON-escaped', () => {
    const { service } = makeService()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    service.evaluate(evalInput({ adapter_version: '0.1.0' }))
    service.evaluate(evalInput({ adapter_version: '0.2\n"evil' }))

    const lines = spy.mock.calls.map((c) => String(c[0]))
    expect(lines[0]).toBe('[helio] adapter origin "openclaw" reports version "0.1.0"')
    expect(lines[1]).toBe(
      `[helio] adapter origin "openclaw" version changed "0.1.0" -> ${JSON.stringify('0.2\n"evil')}`,
    )
    // The raw newline must not survive into the log line.
    expect(lines[1]).not.toMatch(/\n/)
  })

  it('caps version log lines at 5 per origin per boot, then one suppression summary', () => {
    const { service } = makeService()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    for (let i = 1; i <= 7; i++) {
      service.evaluate(evalInput({ adapter_version: `0.${String(i)}.0` }))
    }
    const lines = spy.mock.calls.map((c) => String(c[0]))
    const versionLines = lines.filter((l) => l.includes('version'))
    const summaryLines = lines.filter((l) => l.includes('suppressing'))
    expect(versionLines.filter((l) => !l.includes('suppressing'))).toHaveLength(5)
    expect(summaryLines).toHaveLength(1)
    // The 7th change added nothing beyond the summary already emitted at the 6th.
    expect(lines).toHaveLength(6)
  })

  it('install-scan refreshes last_seen for a known origin but never creates one', () => {
    const { service, advance } = makeService()
    service.evaluate(evalInput())
    advance(2_000)
    service.installScan(installInput('openclaw'))
    expect(service.listAdapters()[0]).toMatchObject({ last_seen: iso(BASE + 2_000) })

    service.installScan(installInput('unseen-origin'))
    expect(service.listAdapters().map((a) => a.origin)).toEqual(['openclaw'])
  })

  it('audit refreshes last_seen on the successful first finalize', () => {
    const { service, advance } = makeService()
    const ev = service.evaluate(evalInput())
    const id = ev.body['evaluation_id'] as string
    advance(3_000)
    expect(service.audit(auditInput(id), 'h').status).toBe(201)
    expect(service.listAdapters()[0]).toMatchObject({ last_seen: iso(BASE + 3_000) })
  })

  it('audit does not refresh on approval_unresolved, invalid_actual_amount, or no_spend_rule', () => {
    const policy = compile({
      default: 'allow',
      rules: [{ name: 'ap', match: { tool: 'gated' }, action: 'require_approval' }],
    })
    const { service, advance } = makeService({ policy, withApprovals: true })

    // approval_unresolved 409
    const gated = service.evaluate(evalInput({ tool: { name: 'gated' } }))
    const gatedId = gated.body['evaluation_id'] as string
    advance(1_000)
    expect(service.audit(auditInput(gatedId), 'h').status).toBe(409)
    expect(service.listAdapters()[0]?.last_seen).toBe(iso(BASE))

    // invalid_actual_amount / no_spend_rule 400s on a plain allow evaluation
    const plain = service.evaluate(evalInput())
    const plainId = plain.body['evaluation_id'] as string
    advance(1_000)
    expect(service.audit(auditInput(plainId, { actual_amount: -1 }), 'h').status).toBe(400)
    expect(service.audit(auditInput(plainId, { actual_amount: 1 }), 'h').status).toBe(400)
    expect(service.listAdapters()[0]?.last_seen).toBe(iso(BASE + 1_000))
  })

  it('audit does not refresh on evaluation_expired or on a tombstone replay', () => {
    const { service, advance } = makeService({ ttlMs: 10_000 })

    // Expired: never audited in time.
    const ev = service.evaluate(evalInput())
    const id = ev.body['evaluation_id'] as string
    advance(10_000)
    expect(service.audit(auditInput(id), 'h').status).toBe(404)
    expect(service.listAdapters()[0]?.last_seen).toBe(iso(BASE))

    // Replay: refresh happens at first finalize only.
    const ev2 = service.evaluate(evalInput())
    const id2 = ev2.body['evaluation_id'] as string
    advance(1_000)
    expect(service.audit(auditInput(id2), 'h').status).toBe(201)
    advance(1_000)
    expect(service.audit(auditInput(id2), 'h').status).toBe(200)
    expect(service.listAdapters()[0]?.last_seen).toBe(iso(BASE + 11_000))
  })

  it('keeps last_seen monotonic when the clock moves backward', () => {
    const { service, advance } = makeService()
    service.evaluate(evalInput())
    advance(-500_000)
    service.evaluate(evalInput())
    expect(service.listAdapters()[0]?.last_seen).toBe(iso(BASE))
  })

  it('a 33rd origin is refused by evaluate and leaves no registry entry', () => {
    const { service } = makeService()
    for (let i = 0; i < 32; i++) {
      expect(service.evaluate(evalInput({ origin: `origin-${String(i)}` })).status).toBe(200)
    }
    const res = service.evaluate(evalInput({ origin: 'origin-32' }))
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'origin_limit_exceeded' })
    expect(service.listAdapters()).toHaveLength(32)
    expect(service.listAdapters().some((a) => a.origin === 'origin-32')).toBe(false)
  })

  it('listAdapters sorts by last_seen descending', () => {
    const { service, advance } = makeService()
    service.evaluate(evalInput({ origin: 'older' }))
    advance(1_000)
    service.evaluate(evalInput({ origin: 'newer' }))
    expect(service.listAdapters().map((a) => a.origin)).toEqual(['newer', 'older'])
  })

  it('close() clears the registry', () => {
    const { service } = makeService()
    service.evaluate(evalInput())
    service.close()
    expect(service.listAdapters()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// memory budget caps — per-origin tool baselines
// (The 32-origin cap is pinned by the registry describe's 33rd-origin test.)
// ---------------------------------------------------------------------------

describe('GovernanceService tool baseline cap', () => {
  it('refuses the 1,025th first-seen definition but keeps updating baselined tools', () => {
    const { service } = makeService()
    for (let i = 0; i < 1_024; i++) {
      const res = service.evaluate(
        evalInput({ tool: { name: `tool-${String(i)}`, description: 'd' } }),
      )
      expect(res.status).toBe(200)
    }

    // First-seen definition past the cap is refused fail-closed…
    const over = service.evaluate(evalInput({ tool: { name: 'tool-1024', description: 'd' } }))
    expect(over.status).toBe(400)
    expect(over.body).toEqual({ error: 'tool_baseline_limit' })

    // …while a definition UPDATE for an already-baselined tool still proceeds
    // at cap: the evaluation runs (200, no error) and the changed definition
    // is ingested — visible as a drift block under the default drift mode.
    const update = service.evaluate(evalInput({ tool: { name: 'tool-0', description: 'changed' } }))
    expect(update.status).toBe(200)
    expect(update.body['error']).toBeUndefined()
    expect(update.body['tool_drift']).toBeDefined()
  })
})
