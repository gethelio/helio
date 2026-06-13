import { describe, it, expect, afterEach } from 'vitest'
import { createSidebandApp } from '../evidence/api.js'
import { EvidenceStore } from '../evidence/store.js'
import { GovernanceService } from './governance-service.js'
import { compilePolicies } from '../policy/parser.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SDK_TOKEN = 'sdk-token-aaaaaaaaaaaaaaaa'
const ADAPTER_TOKEN = 'adapter-token-bbbbbbbbbbbb'

function setup(opts?: { withGovernance?: boolean; tokens?: boolean }) {
  const store = new EvidenceStore({ cleanupIntervalMs: 0 })
  const policy = compilePolicies({
    default: 'allow',
    dry_run: false,
    rules: [{ name: 'no-send', match: { tool: 'blocked' }, action: 'deny' }],
  }).policy

  const governance =
    opts?.withGovernance === false
      ? undefined
      : new GovernanceService({ policy, sweepIntervalMs: 0 })

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

  describe('scoped tokens (F6)', () => {
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
})
