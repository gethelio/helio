import { describe, it, expect, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { createSidebandApp } from '../evidence/api.js'
import { EvidenceStore } from '../evidence/store.js'
import { GovernanceService } from './governance-service.js'
import { BudgetEngine } from '../budget/engine.js'
import type { BudgetLedgerSink } from '../budget/engine.js'
import { BudgetLedger } from '../budget/ledger.js'
import { compileBudgets } from '../budget/parser.js'
import { compilePolicies } from '../policy/parser.js'
import { ApprovalRouter } from '../approval/router.js'
import { ApprovalQueue } from '../approval/queue.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SDK_TOKEN = 'sdk-token-aaaaaaaaaaaaaaaa'
const ADAPTER_TOKEN = 'adapter-token-bbbbbbbbbbbb'

function setup(opts?: {
  withGovernance?: boolean
  withApprovals?: boolean
  tokens?: boolean
  policy?: Parameters<typeof compilePolicies>[0]
}) {
  const store = new EvidenceStore({ cleanupIntervalMs: 0 })
  const policy = compilePolicies(
    opts?.policy ?? {
      default: 'allow',
      dry_run: false,
      rules: [{ name: 'no-send', match: { tool: 'blocked' }, action: 'deny' }],
    },
  ).policy

  const approvalRouter = opts?.withApprovals
    ? new ApprovalRouter({
        defaultTimeoutMs: 300_000,
        defaultOnTimeout: 'deny',
        channels: new Map(),
        queue: new ApprovalQueue({ cleanupIntervalMs: 0 }),
      })
    : undefined

  const governance =
    opts?.withGovernance === false
      ? undefined
      : // Wire the same EvidenceStore into the service, mirroring production
        // (cli.ts) so the /audit evidence path is exercised end-to-end.
        new GovernanceService({ policy, sweepIntervalMs: 0, evidenceStore: store, approvalRouter })

  const app = createSidebandApp(store, {
    token: opts?.tokens ? SDK_TOKEN : undefined,
    adapterToken: opts?.tokens ? ADAPTER_TOKEN : undefined,
    governance,
  })

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })

  return { app, store, governance, post }
}

const evalBody = (overrides?: Record<string, unknown>) => ({
  origin: 'openclaw',
  tool: { name: 'send' },
  arguments: {},
  ...overrides,
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('sideband governance routes', () => {
  let store: EvidenceStore | null = null
  let governance: GovernanceService | null = null
  afterEach(() => {
    store?.close()
    governance?.close()
    store = null
    governance = null
  })

  it('evaluates a tool call and returns a decision', async () => {
    const ctx = setup()
    store = ctx.store
    governance = ctx.governance ?? null
    const res = await ctx.post('/evaluate', evalBody())
    expect(res.status).toBe(200)
    const json = (await res.json()) as { decision: string; evaluation_id: string }
    expect(json.decision).toBe('allow')
    expect(json.evaluation_id).toBeTruthy()
  })

  it('returns 503 governance_unavailable when no service is wired', async () => {
    const ctx = setup({ withGovernance: false })
    store = ctx.store
    const res = await ctx.post('/evaluate', evalBody())
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: string }).error).toBe('governance_unavailable')
  })

  it('gates an evaluate on match.metadata.channel_id end-to-end', async () => {
    const ctx = setup({
      policy: {
        default: 'allow',
        dry_run: false,
        rules: [{ name: 'block-chan', match: { metadata: { channel_id: 'C1' } }, action: 'deny' }],
      },
    })
    store = ctx.store
    governance = ctx.governance ?? null

    const denied = await ctx.post('/evaluate', evalBody({ metadata: { channel_id: 'C1' } }))
    expect(((await denied.json()) as { decision: string }).decision).toBe('deny')

    const allowed = await ctx.post('/evaluate', evalBody({ metadata: { channel_id: 'C2' } }))
    expect(((await allowed.json()) as { decision: string }).decision).toBe('allow')
  })

  it('carries configured rule feedback on a dry_run decision end-to-end', async () => {
    const ctx = setup({
      policy: {
        default: 'allow',
        dry_run: false,
        rules: [
          {
            name: 'shadow-send',
            match: { tool: 'send' },
            action: 'dry_run',
            feedback: { message: 'Shadow mode: send would be governed' },
          },
        ],
      },
    })
    store = ctx.store
    governance = ctx.governance ?? null
    const res = await ctx.post('/evaluate', evalBody())
    expect(res.status).toBe(200)
    const json = (await res.json()) as { decision: string; feedback?: { message: string } }
    expect(json.decision).toBe('dry_run')
    expect(json.feedback).toStrictEqual({ message: 'Shadow mode: send would be governed' })
  })

  it('carries configured rule feedback on a require_approval decision end-to-end', async () => {
    const ctx = setup({
      withApprovals: true,
      policy: {
        default: 'allow',
        dry_run: false,
        rules: [
          {
            name: 'approve-send',
            match: { tool: 'send' },
            action: 'require_approval',
            feedback: { message: 'Manager sign-off required', suggestion: 'Ask in #ops' },
          },
        ],
      },
    })
    store = ctx.store
    governance = ctx.governance ?? null
    const res = await ctx.post('/evaluate', evalBody())
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      decision: string
      feedback?: { message: string; suggestion?: string }
      approval?: { id: string }
    }
    expect(json.decision).toBe('require_approval')
    expect(json.feedback).toStrictEqual({
      message: 'Manager sign-off required',
      suggestion: 'Ask in #ops',
    })
    expect(json.approval?.id).toBeTruthy()
  })

  it('denies a matching install through /install-scan end-to-end (deny_install)', async () => {
    const ctx = setup({
      policy: {
        default: 'allow',
        dry_run: false,
        rules: [],
        install: {
          default: 'allow',
          rules: [
            {
              name: 'block-evil',
              match: { name: 'evil-*', source: 'npm' },
              action: 'deny_install',
            },
          ],
        },
      },
    })
    store = ctx.store
    governance = ctx.governance ?? null
    const res = await ctx.post('/install-scan', {
      origin: 'openclaw',
      package: { name: 'evil-pkg', source: 'npm' },
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { decision: string; matched_rule: string }
    expect(json.decision).toBe('deny')
    expect(json.matched_rule).toBe('block-evil')
  })

  it('rejects a reserved agent_id key inside metadata with 400', async () => {
    const ctx = setup()
    store = ctx.store
    governance = ctx.governance ?? null
    const res = await ctx.post('/evaluate', evalBody({ metadata: { agent_id: 'spoofed' } }))
    expect(res.status).toBe(400)
    expect((await res.json()) as { error: string }).toMatchObject({
      error: 'reserved_metadata_key',
    })
  })

  it('rejects malformed JSON with 400', async () => {
    const ctx = setup()
    store = ctx.store
    governance = ctx.governance ?? null
    const res = await ctx.post('/evaluate', '{ not json')
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('Invalid JSON')
  })

  it('rejects a bad origin with a validation error', async () => {
    const ctx = setup()
    store = ctx.store
    governance = ctx.governance ?? null
    const res = await ctx.post('/evaluate', evalBody({ origin: 'NOT VALID!' }))
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('Validation error')
  })

  it('rejects oversized metadata with 413', async () => {
    const ctx = setup()
    store = ctx.store
    governance = ctx.governance ?? null
    const res = await ctx.post('/evaluate', evalBody({ metadata: { blob: 'x'.repeat(5000) } }))
    expect(res.status).toBe(413)
  })

  it('refuses cross-origin (browser) requests on governance routes', async () => {
    const ctx = setup()
    store = ctx.store
    governance = ctx.governance ?? null
    const res = await ctx.post('/evaluate', evalBody(), { origin: 'http://evil.local' })
    expect(res.status).toBe(403)
  })

  describe('scoped tokens', () => {
    it('governance routes require the adapter token, not the SDK token', async () => {
      const ctx = setup({ tokens: true })
      store = ctx.store
      governance = ctx.governance ?? null

      // No token → 401
      expect((await ctx.post('/evaluate', evalBody())).status).toBe(401)
      // SDK token is the wrong scope → 401
      expect(
        (await ctx.post('/evaluate', evalBody(), { authorization: `Bearer ${SDK_TOKEN}` })).status,
      ).toBe(401)
      // Adapter token → ok
      expect(
        (await ctx.post('/evaluate', evalBody(), { authorization: `Bearer ${ADAPTER_TOKEN}` }))
          .status,
      ).toBe(200)
    })

    it('evidence routes reject the adapter token (wrong scope)', async () => {
      const ctx = setup({ tokens: true })
      store = ctx.store
      governance = ctx.governance ?? null

      const body = {
        session_id: 's1',
        tool_name: 't',
        evidence_key: 'k',
        evidence_data: { x: 1 },
      }
      expect(
        (await ctx.post('/evidence', body, { authorization: `Bearer ${ADAPTER_TOKEN}` })).status,
      ).toBe(401)
      expect(
        (await ctx.post('/evidence', body, { authorization: `Bearer ${SDK_TOKEN}` })).status,
      ).toBe(201)
    })
  })

  it('runs the full evaluate → audit loop', async () => {
    const ctx = setup()
    store = ctx.store
    governance = ctx.governance ?? null

    const ev = await ctx.post('/evaluate', evalBody())
    const { evaluation_id } = (await ev.json()) as { evaluation_id: string }

    const audit = await ctx.post('/audit', { evaluation_id, status: 'success', duration_ms: 12 })
    expect(audit.status).toBe(201)
    const json = (await audit.json()) as { ok: boolean; audit_record_id: string }
    expect(json.ok).toBe(true)
    expect(json.audit_record_id).toBeTruthy()

    // Idempotent replay of the same payload.
    const replay = await ctx.post('/audit', {
      evaluation_id,
      status: 'success',
      duration_ms: 12,
    })
    expect(replay.status).toBe(200)
    expect(((await replay.json()) as { already_finalized: boolean }).already_finalized).toBe(true)
  })

  it('returns observational allow for install-scan', async () => {
    const ctx = setup()
    store = ctx.store
    governance = ctx.governance ?? null
    const res = await ctx.post('/install-scan', {
      origin: 'openclaw',
      package: { name: 'left-pad', source: 'npm' },
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { decision: string }).decision).toBe('allow')
  })

  it('accepts an evidence array on /audit and writes it to the store', async () => {
    const ctx = setup()
    store = ctx.store
    governance = ctx.governance ?? null

    const ev = await ctx.post('/evaluate', evalBody({ session_id: 'oc:s1' }))
    const { evaluation_id } = (await ev.json()) as { evaluation_id: string }
    const audit = await ctx.post('/audit', {
      evaluation_id,
      status: 'success',
      evidence: [{ evidence_key: 'recipient', evidence_data: { to: 'a@b.com' } }],
    })

    expect(audit.status).toBe(201)
    const json = (await audit.json()) as { evidence: { evidence_key: string; stored: boolean }[] }
    expect(json.evidence).toEqual([{ evidence_key: 'recipient', stored: true }])
    expect(ctx.store.getEvidence('oc:s1', 'recipient')?.data).toEqual({ to: 'a@b.com' })
  })

  it('does not reject an over-count evidence array at the route (no .max) — soft-drops in service', async () => {
    const ctx = setup()
    store = ctx.store
    governance = ctx.governance ?? null

    const ev = await ctx.post('/evaluate', evalBody({ session_id: 'oc:s1' }))
    const { evaluation_id } = (await ev.json()) as { evaluation_id: string }
    const evidence = Array.from({ length: 17 }, (_, i) => ({
      evidence_key: `k${String(i)}`,
      evidence_data: i,
    }))
    const audit = await ctx.post('/audit', { evaluation_id, status: 'success', evidence })

    expect(audit.status).toBe(201) // NOT 400 — the route has no .max() refinement
    const json = (await audit.json()) as {
      evidence: { evidence_key: string; stored: boolean; reason?: string }[]
    }
    expect(json.evidence).toHaveLength(17)
    expect(json.evidence[16]).toEqual({ evidence_key: 'k16', stored: false, reason: 'too_many' })
  })

  it('treats divergent evidence under the same evaluation_id as a 409 conflict', async () => {
    const ctx = setup()
    store = ctx.store
    governance = ctx.governance ?? null

    const ev = await ctx.post('/evaluate', evalBody({ session_id: 'oc:s1' }))
    const { evaluation_id } = (await ev.json()) as { evaluation_id: string }

    const first = await ctx.post('/audit', {
      evaluation_id,
      status: 'success',
      evidence: [{ evidence_key: 'k', evidence_data: 'v1' }],
    })
    expect(first.status).toBe(201)

    const divergent = await ctx.post('/audit', {
      evaluation_id,
      status: 'success',
      evidence: [{ evidence_key: 'k', evidence_data: 'v2' }],
    })
    expect(divergent.status).toBe(409)
    expect(((await divergent.json()) as { error: string }).error).toBe('evaluation_conflict')
  })

  it('treats identical evidence (any entry order) as an idempotent replay', async () => {
    const ctx = setup()
    store = ctx.store
    governance = ctx.governance ?? null

    const ev = await ctx.post('/evaluate', evalBody({ session_id: 'oc:s1' }))
    const { evaluation_id } = (await ev.json()) as { evaluation_id: string }
    const a = { evidence_key: 'a', evidence_data: 1 }
    const b = { evidence_key: 'b', evidence_data: 2 }

    const first = await ctx.post('/audit', { evaluation_id, status: 'success', evidence: [a, b] })
    expect(first.status).toBe(201)

    // Same entries, reversed order → must hash identically (sorted tuple).
    const replay = await ctx.post('/audit', { evaluation_id, status: 'success', evidence: [b, a] })
    expect(replay.status).toBe(200)
    expect(((await replay.json()) as { already_finalized: boolean }).already_finalized).toBe(true)
  })

  it('soft-fails evidence with reason closed over HTTP — /audit stays 201, never 503', async () => {
    const ctx = setup()
    store = ctx.store
    governance = ctx.governance ?? null

    const ev = await ctx.post('/evaluate', evalBody({ session_id: 'oc:s1' }))
    const { evaluation_id } = (await ev.json()) as { evaluation_id: string }
    ctx.store.close() // standalone /evidence would 503; /audit must not inherit that

    const audit = await ctx.post('/audit', {
      evaluation_id,
      status: 'success',
      evidence: [{ evidence_key: 'k', evidence_data: 'x' }],
    })
    expect(audit.status).toBe(201)
    const json = (await audit.json()) as { evidence: { evidence_key: string; reason?: string }[] }
    expect(json.evidence).toEqual([{ evidence_key: 'k', stored: false, reason: 'closed' }])
  })

  it('rejects an over-1MiB /audit body with 413 (gross body limit, not an evidence cap)', async () => {
    const ctx = setup()
    store = ctx.store
    governance = ctx.governance ?? null

    const ev = await ctx.post('/evaluate', evalBody({ session_id: 'oc:s1' }))
    const { evaluation_id } = (await ev.json()) as { evaluation_id: string }

    const huge = 'x'.repeat(1_200 * 1024) // ~1.2 MiB > the 1 MiB sideband body limit
    const body = JSON.stringify({
      evaluation_id,
      status: 'success',
      evidence: [{ evidence_key: 'k', evidence_data: huge }],
    })
    // Set content-length explicitly — the real Node server sets it, and hono's
    // bodyLimit checks it to fail fast with 413 before the body is parsed.
    const res = await ctx.post('/audit', body, {
      'content-length': String(Buffer.byteLength(body)),
    })
    expect(res.status).toBe(413)
    expect(((await res.json()) as { error: string }).error).toBe('request_body_too_large')
  })
})

describe('POST /evaluate — budget_exceeded over HTTP (issue #14)', () => {
  it('returns the budget decision, limits block, and feedback through the route layer', async () => {
    const policy = compilePolicies({ default: 'allow', dry_run: false, rules: [] }).policy
    const budgetEngine = new BudgetEngine({
      budgets: compileBudgets([
        {
          name: 'cap',
          limit: 10,
          currency: 'USD',
          window: '24h',
          key: 'global',
          on_exceed: 'deny',
          contributors: [{ tool: 'send', field: '$.amount' }],
        },
      ]),
      cleanupIntervalMs: 0,
    })
    const governance = new GovernanceService({ policy, budgetEngine, sweepIntervalMs: 0 })
    const store = new EvidenceStore()
    const app = createSidebandApp(store, { governance })

    const res = await app.request('/evaluate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        origin: 'openclaw',
        tool: { name: 'send' },
        arguments: { amount: 50 },
      }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['decision']).toBe('budget_exceeded')
    const limits = body['limits'] as { budgets: Array<Record<string, unknown>> }
    expect(limits.budgets[0]?.['name']).toBe('cap')
    expect(limits.budgets[0]?.['reset_at_ms']).toBeDefined()
    const feedback = body['feedback'] as { message: string }
    expect(feedback.message).toContain('"cap"')

    budgetEngine.close()
    governance.close()
    store.close()
  })

  it('a budget ledger fault maps to a 500 on /audit; the adapter retry gets 201 (PR 2)', async () => {
    const policy = compilePolicies({ default: 'allow', dry_run: false, rules: [] }).policy
    const db = new Database(':memory:')
    const ledger = new BudgetLedger({ database: db })
    let failNext = true
    const failOnce: BudgetLedgerSink = {
      commitAll: (rows) => {
        if (failNext) {
          failNext = false
          throw new Error('disk full')
        }
        ledger.commitAll(rows)
      },
    }
    const budgetEngine = new BudgetEngine({
      budgets: compileBudgets([
        {
          name: 'cap',
          limit: 100,
          currency: 'USD',
          window: '24h',
          key: 'global',
          on_exceed: 'deny',
          contributors: [{ tool: 'send', field: '$.amount' }],
        },
      ]),
      cleanupIntervalMs: 0,
      ledger: failOnce,
    })
    const governance = new GovernanceService({ policy, budgetEngine, sweepIntervalMs: 0 })
    const store = new EvidenceStore()
    const app = createSidebandApp(store, { governance })
    const post = (path: string, body: unknown) =>
      app.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })

    const evalRes = await post('/evaluate', {
      origin: 'openclaw',
      tool: { name: 'send' },
      arguments: { amount: 30 },
    })
    const evaluationId = ((await evalRes.json()) as Record<string, unknown>)['evaluation_id']

    // First /audit: the durable write fails → 500, nothing committed, the
    // pending entry survives for the idempotent retry.
    const failed = await post('/audit', { evaluation_id: evaluationId, status: 'success' })
    expect(failed.status).toBe(500)
    const countRows = () =>
      (db.prepare('SELECT COUNT(*) AS count FROM budget_events').get() as { count: number }).count
    expect(countRows()).toBe(0)

    const retry = await post('/audit', { evaluation_id: evaluationId, status: 'success' })
    expect(retry.status).toBe(201)
    expect(countRows()).toBe(1)

    budgetEngine.close()
    governance.close()
    store.close()
  })
})
