import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import { GovernedForwarder } from './governed-forwarder.js'
import { compilePolicies } from './parser.js'
import { RateLimiter } from './rate-limiter.js'
import { SpendLimiter } from './spend-limiter.js'
import { resetSessionGateWarningsForTests } from './session-gate.js'
import type { McpForwarder, McpRequest, ForwardResult, McpResponse } from '../mcp/types.js'
import type { PoliciesConfig } from '../config/schema.js'
import { AuditWriter } from '../audit/writer.js'
import { AuditStore } from '../audit/store.js'
import { EvidenceStore } from '../evidence/index.js'
import { BudgetEngine } from '../budget/engine.js'
import { compileBudgets } from '../budget/parser.js'
import { compileSessionIdentity } from '../mcp/session-resolver.js'
import { createStreamableHttpRoute } from '../transport/streamable-http.js'

// ---------------------------------------------------------------------------
// Session identity enforcement on the MCP door (issue #218; closes #214/#215)
// ---------------------------------------------------------------------------

function compile(config: Partial<PoliciesConfig> & Pick<PoliciesConfig, 'rules'>) {
  return compilePolicies({ default: 'allow', dry_run: false, ...config }).policy
}

function toolsCall(name: string, args: Record<string, unknown> = {}): McpRequest {
  return { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }
}

function withSession(request: McpRequest, id: string): McpRequest {
  return { ...request, session: { id, source: 'header' } }
}

function successResult(): ForwardResult {
  const response: McpResponse = {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'ok' }] } },
  }
  return { response, durationMs: 5 }
}

function mockForwarder(): McpForwarder & { forward: ReturnType<typeof vi.fn> } {
  return { forward: vi.fn().mockResolvedValue(successResult()) }
}

function errorOf(result: ForwardResult) {
  const body = result.response.body as Record<string, unknown>
  return body['error'] as
    | { code: number; message: string; data: Record<string, unknown> }
    | undefined
}

function dryRunPayloadOf(result: ForwardResult): Record<string, unknown> {
  const body = result.response.body as {
    result: { content: Array<{ text: string }> }
  }
  return JSON.parse(body.result.content[0]?.text ?? '{}') as Record<string, unknown>
}

const SESSION_RATE_RULE: PoliciesConfig['rules'] = [
  {
    match: { tool: 'send_email' },
    action: 'rate_limit',
    limits: { max_calls: 2, window: '1m', key: 'session' },
  },
]

const SESSION_SPEND_RULE: PoliciesConfig['rules'] = [
  {
    match: { tool: 'stripe_charge' },
    action: 'spend_limit',
    limits: {
      max_spend: { field: '$.amount', limit: 100, currency: 'USD', window: '1h', key: 'session' },
    },
  },
]

function sessionBudgetEngine() {
  return new BudgetEngine({
    budgets: compileBudgets([
      {
        name: 'per-run',
        limit: 50,
        currency: 'USD',
        window: 'session',
        key: 'session',
        on_exceed: 'deny',
        contributors: [{ match: { tool: 'stripe_charge' }, field: '$.amount' }],
      },
    ]),
  })
}

const ANONYMOUS = compileSessionIdentity({
  identity: [{ source: 'header', name: 'x-helio-session-id' }, { source: 'legacy_header' }],
  on_unresolved: 'anonymous',
})

function auditHarness() {
  const store = new AuditStore({
    path: ':memory:',
    retention: '90d',
    includeResponses: true,
    cleanupIntervalMs: 0,
  })
  const writer = new AuditWriter({ store, flushIntervalMs: 0 })
  return { store, writer }
}

beforeEach(() => {
  resetSessionGateWarningsForTests()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('session-keyed limits under on_unresolved: deny (issue #218)', () => {
  it('denies an engaged session rate limit with block_reason session_unresolved', async () => {
    const { store, writer } = auditHarness()
    const inner = mockForwarder()
    const governed = new GovernedForwarder(inner, compile({ rules: SESSION_RATE_RULE }), {
      rateLimiter: new RateLimiter(),
      auditWriter: writer,
    })

    const result = await governed.forward(toolsCall('send_email'))

    expect(inner.forward).not.toHaveBeenCalled()
    const error = errorOf(result)
    expect(error?.data['reason']).toBe('session_unresolved')
    expect(error?.data['blocked']).toBe(true)
    expect(error?.message).toContain('tried: header "x-helio-session-id", legacy_header')

    writer.flush()
    const record = store.list().records[0]
    expect(record?.block_reason).toBe('session_unresolved')
    expect(record?.policy_decision).toBe('rate_limit')
    expect(record?.evidence_chain?.['session']).toEqual({
      unresolved: true,
      tried: 'header "x-helio-session-id", legacy_header',
    })
  })

  it('denies an engaged session spend limit while a resolved session passes', async () => {
    const inner = mockForwarder()
    const governed = new GovernedForwarder(inner, compile({ rules: SESSION_SPEND_RULE }), {
      spendLimiter: new SpendLimiter(),
    })

    const denied = await governed.forward(toolsCall('stripe_charge', { amount: 10 }))
    expect(errorOf(denied)?.data['reason']).toBe('session_unresolved')

    const allowed = await governed.forward(
      withSession(toolsCall('stripe_charge', { amount: 10 }), 'run-a'),
    )
    expect(errorOf(allowed)).toBeUndefined()
    expect(inner.forward).toHaveBeenCalledTimes(1)
  })

  it('denies an engaged session budget via the charge-inspection gate', async () => {
    const { store, writer } = auditHarness()
    const inner = mockForwarder()
    const engine = sessionBudgetEngine()
    const governed = new GovernedForwarder(inner, compile({ rules: [] }), {
      budgetEngine: engine,
      auditWriter: writer,
    })

    const result = await governed.forward(toolsCall('stripe_charge', { amount: 10 }))

    expect(inner.forward).not.toHaveBeenCalled()
    const error = errorOf(result)
    expect(error?.data['reason']).toBe('session_unresolved')
    expect(error?.data['control']).toBe('budget')

    writer.flush()
    const record = store.list().records[0]
    expect(record?.block_reason).toBe('session_unresolved')
    expect(record?.evidence_chain?.['session']).toMatchObject({ unresolved: true })
  })

  it('never materializes a session:unknown bucket on the enforce path (anti-drift)', async () => {
    const rateLimiter = new RateLimiter()
    const engine = sessionBudgetEngine()
    const governed = new GovernedForwarder(mockForwarder(), compile({ rules: SESSION_RATE_RULE }), {
      rateLimiter,
      budgetEngine: engine,
    })
    const budgeted = new GovernedForwarder(mockForwarder(), compile({ rules: [] }), {
      budgetEngine: engine,
    })

    await governed.forward(toolsCall('send_email'))
    await budgeted.forward(toolsCall('stripe_charge', { amount: 10 }))

    expect(rateLimiter.listKeyStates()).toHaveLength(0)
    expect(engine.listStates().flatMap((state) => state.buckets)).toHaveLength(0)
  })

  it('lets unresolved requests through controls that are not session-keyed', async () => {
    const inner = mockForwarder()
    const governed = new GovernedForwarder(
      inner,
      compile({
        rules: [
          {
            match: { tool: 'send_email' },
            action: 'rate_limit',
            limits: { max_calls: 5, window: '1m', key: 'tool' },
          },
        ],
      }),
      { rateLimiter: new RateLimiter() },
    )

    const result = await governed.forward(toolsCall('send_email'))
    expect(errorOf(result)).toBeUndefined()
    expect(inner.forward).toHaveBeenCalledTimes(1)
  })
})

describe('session-keyed limits under on_unresolved: anonymous (issue #218)', () => {
  it('pools into the literal session:unknown bucket and warns once', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const rateLimiter = new RateLimiter()
    const inner = mockForwarder()
    const governed = new GovernedForwarder(inner, compile({ rules: SESSION_RATE_RULE }), {
      rateLimiter,
      session: ANONYMOUS,
    })

    await governed.forward(toolsCall('send_email'))
    await governed.forward(toolsCall('send_email'))

    expect(inner.forward).toHaveBeenCalledTimes(2)
    // Bucket-key equality with the pre-change format: the literal unknown pot.
    const states = rateLimiter.listKeyStates()
    expect(states).toHaveLength(1)
    expect(states[0]?.key).toBe('session:unknown')
    expect(states[0]?.current).toBe(2)
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('unknown'))
  })

  it('pools session budgets into the unknown pot under anonymous', async () => {
    const engine = sessionBudgetEngine()
    const governed = new GovernedForwarder(mockForwarder(), compile({ rules: [] }), {
      budgetEngine: engine,
      session: ANONYMOUS,
    })

    await governed.forward(toolsCall('stripe_charge', { amount: 10 }))

    const buckets = engine.listStates().flatMap((state) => state.buckets)
    expect(buckets).toHaveLength(1)
    expect(buckets[0]?.bucket_key).toBe('budget:per-run:session:unknown')
    expect(buckets[0]?.spent).toBe(10)
  })

  it('still denies evidence-gated rules without identity under anonymous', async () => {
    const inner = mockForwarder()
    const governed = new GovernedForwarder(
      inner,
      compile({
        rules: [
          {
            match: { tool: 'process_refund' },
            action: 'allow',
            evidence: { requires: ['get_weather'] },
          },
        ],
      }),
      { evidenceStore: new EvidenceStore(), session: ANONYMOUS },
    )

    const result = await governed.forward(toolsCall('process_refund'))
    expect(inner.forward).not.toHaveBeenCalled()
    expect(errorOf(result)?.data['reason']).toBe('policy_denied')
    expect(errorOf(result)?.message).toContain('evidence.requires')
  })
})

describe('dry-run reports session_unresolved instead of denying (issue #218)', () => {
  it('marks an engaged session rate limit with the named field', async () => {
    const governed = new GovernedForwarder(
      mockForwarder(),
      compile({ rules: SESSION_RATE_RULE, dry_run: true }),
      { rateLimiter: new RateLimiter() },
    )

    const result = await governed.forward(toolsCall('send_email'))

    expect(errorOf(result)).toBeUndefined()
    const payload = dryRunPayloadOf(result)
    expect(payload['dry_run']).toBe(true)
    expect(payload['would_forward']).toBe(false)
    expect(payload['limits_ok']).toBe(false)
    expect(payload['session_unresolved']).toBe(true)
  })

  it('marks an engaged session budget with the named field', async () => {
    const governed = new GovernedForwarder(mockForwarder(), compile({ rules: [], dry_run: true }), {
      budgetEngine: sessionBudgetEngine(),
    })

    const result = await governed.forward(toolsCall('stripe_charge', { amount: 10 }))

    const payload = dryRunPayloadOf(result)
    expect(payload['would_forward']).toBe(false)
    expect(payload['limits_ok']).toBe(false)
    expect(payload['session_unresolved']).toBe(true)
  })

  it('reports clean when the session is resolved (no marker)', async () => {
    const governed = new GovernedForwarder(
      mockForwarder(),
      compile({ rules: SESSION_RATE_RULE, dry_run: true }),
      { rateLimiter: new RateLimiter() },
    )

    const result = await governed.forward(withSession(toolsCall('send_email'), 'run-a'))

    const payload = dryRunPayloadOf(result)
    expect(payload['would_forward']).toBe(true)
    expect(payload['session_unresolved']).toBeUndefined()
  })

  it('keeps the grounded-rule sessionBlocked hard-deny under global dry-run', async () => {
    const inner = mockForwarder()
    const governed = new GovernedForwarder(
      inner,
      compile({
        dry_run: true,
        rules: [
          {
            match: { tool: 'process_refund' },
            action: 'allow',
            evidence: { requires: ['get_weather'] },
          },
        ],
      }),
      { evidenceStore: new EvidenceStore() },
    )

    const result = await governed.forward(toolsCall('process_refund'))
    // Pre-existing behavior, deliberately unchanged: dry-run is suppressed
    // and the deny is real.
    expect(errorOf(result)?.data['reason']).toBe('policy_denied')
    expect(inner.forward).not.toHaveBeenCalled()
  })
})

describe('#215 regression: distinct identities get distinct buckets on the MCP door', () => {
  it('rate-limits two x-helio-session-id values independently', async () => {
    const rateLimiter = new RateLimiter()
    const inner = mockForwarder()
    const governed = new GovernedForwarder(inner, compile({ rules: SESSION_RATE_RULE }), {
      rateLimiter,
    })
    const app = new Hono()
    app.route('/mcp', createStreamableHttpRoute(governed))

    const post = (session: string) =>
      app.request('/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-helio-session-id': session },
        body: JSON.stringify(toolsCall('send_email')),
      })

    // Exhaust client A's 2-call window; client B must be unaffected.
    await post('client-a')
    await post('client-a')
    const deniedA = (await (await post('client-a')).json()) as Record<string, unknown>
    expect(deniedA['error']).toBeDefined()

    const allowedB = (await (await post('client-b')).json()) as Record<string, unknown>
    expect(allowedB['error']).toBeUndefined()

    const keys = rateLimiter
      .listKeyStates()
      .map((state) => state.key)
      .sort()
    expect(keys).toEqual(['session:client-a', 'session:client-b'])
  })

  it('keeps distinct budget pots per identity', async () => {
    const engine = sessionBudgetEngine()
    const governed = new GovernedForwarder(mockForwarder(), compile({ rules: [] }), {
      budgetEngine: engine,
    })

    await governed.forward(withSession(toolsCall('stripe_charge', { amount: 30 }), 'client-a'))
    await governed.forward(withSession(toolsCall('stripe_charge', { amount: 30 }), 'client-b'))
    // Client A's pot is nearly spent; a further 30 breaches A but not B.
    const deniedA = await governed.forward(
      withSession(toolsCall('stripe_charge', { amount: 30 }), 'client-a'),
    )
    expect(errorOf(deniedA)?.data['reason']).toBe('budget_exceeded')

    const bucketKeys = engine
      .listStates()
      .flatMap((state) => state.buckets)
      .map((bucket) => bucket.bucket_key)
      .sort()
    expect(bucketKeys).toEqual([
      'budget:per-run:session:client-a',
      'budget:per-run:session:client-b',
    ])
  })
})

describe('#214 regression: evidence gating works from x-helio-session-id alone', () => {
  it('evaluates an evidence-gated rule end-to-end with no Mcp-Session-Id', async () => {
    const evidenceStore = new EvidenceStore()
    const inner = mockForwarder()
    const governed = new GovernedForwarder(
      inner,
      compile({
        rules: [
          {
            match: { tool: 'process_refund' },
            action: 'allow',
            evidence: { requires: ['get_weather'] },
          },
        ],
      }),
      { evidenceStore },
    )
    const app = new Hono()
    app.route('/mcp', createStreamableHttpRoute(governed))

    const post = () =>
      app.request('/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-helio-session-id': 'run-a' },
        body: JSON.stringify(toolsCall('process_refund')),
      })

    // Without evidence the rule denies — proving the gate evaluated for the
    // header-resolved session rather than short-circuiting on no session.
    const denied = (await (await post()).json()) as { error?: { message: string } }
    expect(denied.error?.message).toContain('Evidence grounding failed')

    evidenceStore.putEvidence('run-a', {
      evidence_key: 'get_weather',
      data: { ok: true },
      tool_name: 'get_weather',
    })
    const allowed = (await (await post()).json()) as { error?: unknown }
    expect(allowed.error).toBeUndefined()
    expect(inner.forward).toHaveBeenCalledTimes(1)
  })
})
