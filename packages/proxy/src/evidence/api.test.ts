import { describe, it, expect } from 'vitest'
import { createSidebandApp } from './api.js'
import { EvidenceStore } from './store.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setup(storeOptions?: {
  ttl?: number
  token?: string
  allowedEvidenceKeys?: readonly string[]
}) {
  let time = 1_000_000
  const store = new EvidenceStore({
    defaultTtlSeconds: storeOptions?.ttl ?? 300,
    cleanupIntervalMs: 0,
    allowedEvidenceKeys: storeOptions?.allowedEvidenceKeys,
    now: () => time,
  })
  const app = createSidebandApp(store, { token: storeOptions?.token })
  const advance = (ms: number) => {
    time += ms
  }

  const authHeaders =
    storeOptions?.token === undefined
      ? { 'content-type': 'application/json' }
      : {
          'content-type': 'application/json',
          authorization: `Bearer ${storeOptions.token}`,
        }

  const post = async (path: string, body: unknown) =>
    app.request(path, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(body),
    })

  const get = async (path: string) =>
    app.request(path, {
      headers: storeOptions?.token ? { authorization: `Bearer ${storeOptions.token}` } : {},
    })

  return { store, app, advance, post, get }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Sideband API', () => {
  // -----------------------------------------------------------------------
  // POST /evidence
  // -----------------------------------------------------------------------

  describe('POST /evidence', () => {
    it('stores evidence and returns 201', async () => {
      const { post, store } = setup()

      const res = await post('/evidence', {
        session_id: 's1',
        tool_name: 'get_order',
        evidence_key: 'orders.lookup',
        evidence_data: { orderId: 123 },
      })

      expect(res.status).toBe(201)
      expect(await res.json()).toEqual({ ok: true })
      expect(store.hasEvidence('s1', 'orders.lookup')).toBe(true)
    })

    it('passes custom ttl_seconds through', async () => {
      const { post, store, advance } = setup({ ttl: 600 })

      await post('/evidence', {
        session_id: 's1',
        tool_name: 't',
        evidence_key: 'k',
        evidence_data: null,
        ttl_seconds: 2,
      })

      advance(3_000) // past the custom 2s TTL
      expect(store.hasEvidence('s1', 'k')).toBe(false)
    })

    it('accepts any type for evidence_data', async () => {
      const { post, store } = setup()

      // null
      await post('/evidence', {
        session_id: 's1',
        tool_name: 't',
        evidence_key: 'null_data',
        evidence_data: null,
      })

      // array
      await post('/evidence', {
        session_id: 's1',
        tool_name: 't',
        evidence_key: 'array_data',
        evidence_data: [1, 2, 3],
      })

      // string
      await post('/evidence', {
        session_id: 's1',
        tool_name: 't',
        evidence_key: 'string_data',
        evidence_data: 'hello',
      })

      expect(store.hasEvidence('s1', 'null_data')).toBe(true)
      expect(store.hasEvidence('s1', 'array_data')).toBe(true)
      expect(store.hasEvidence('s1', 'string_data')).toBe(true)
    })

    it('returns 400 when session_id is missing', async () => {
      const { post } = setup()

      const res = await post('/evidence', {
        tool_name: 'get_order',
        evidence_key: 'k',
        evidence_data: null,
      })

      expect(res.status).toBe(400)
      const body = (await res.json()) as Record<string, unknown>
      expect(body['error']).toBe('Validation error')
    })

    it('returns 400 when tool_name is missing', async () => {
      const { post } = setup()

      const res = await post('/evidence', {
        session_id: 's1',
        evidence_key: 'k',
        evidence_data: null,
      })

      expect(res.status).toBe(400)
    })

    it('returns 400 when evidence_key is missing', async () => {
      const { post } = setup()

      const res = await post('/evidence', {
        session_id: 's1',
        tool_name: 't',
        evidence_data: null,
      })

      expect(res.status).toBe(400)
    })

    it('returns 400 when evidence_data is missing', async () => {
      const { post } = setup()

      const res = await post('/evidence', {
        session_id: 's1',
        tool_name: 't',
        evidence_key: 'k',
        // evidence_data omitted
      })

      expect(res.status).toBe(400)
    })

    it('returns 400 when session_id is empty string', async () => {
      const { post } = setup()

      const res = await post('/evidence', {
        session_id: '',
        tool_name: 't',
        evidence_key: 'k',
        evidence_data: null,
      })

      expect(res.status).toBe(400)
    })

    it('returns 400 for invalid JSON', async () => {
      const { app } = setup()

      const res = await app.request('/evidence', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json{{{',
      })

      expect(res.status).toBe(400)
      const body = (await res.json()) as Record<string, unknown>
      expect(body['error']).toBe('Invalid JSON')
    })

    it('returns 400 with capped allowlist diagnostics for unknown evidence keys', async () => {
      const allowedKeys = Array.from({ length: 25 }, (_, i) => `allowed.${String(i)}`)
      const { post, store } = setup({ allowedEvidenceKeys: allowedKeys })

      const res = await post('/evidence', {
        session_id: 's1',
        tool_name: 'get_order',
        evidence_key: 'rejected.key',
        evidence_data: { orderId: 1 },
      })

      expect(res.status).toBe(400)
      const body = (await res.json()) as Record<string, unknown>
      expect(body['code']).toBe('evidence_key_not_in_policy_allowlist')
      expect(body['key']).toBe('rejected.key')
      expect(body['allowed_key_count']).toBe(25)
      expect(body['truncated']).toBe(true)
      const listedKeys = body['allowed_keys'] as string[]
      expect(listedKeys).toHaveLength(20)
      expect(store.hasSeenEvidence('s1', 'rejected.key')).toBe(false)
      expect(store.getEvidence('s1', 'rejected.key')).toBeUndefined()
    })

    it('returns 503 when evidence write is attempted after store close', async () => {
      const { post, store } = setup()
      store.close()

      const res = await post('/evidence', {
        session_id: 's1',
        tool_name: 't',
        evidence_key: 'k',
        evidence_data: null,
      })

      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: 'sideband_shutting_down' })
    })
  })

  // -----------------------------------------------------------------------
  // POST /context
  // -----------------------------------------------------------------------

  describe('POST /context', () => {
    it('stores context and returns 201', async () => {
      const { post, store } = setup()

      const res = await post('/context', {
        session_id: 's1',
        key: 'agent_id',
        value: 'support-bot',
      })

      expect(res.status).toBe(201)
      expect(await res.json()).toEqual({ ok: true })
      expect(store.getContext('s1', 'agent_id')).toBe('support-bot')
    })

    it('accepts any type for value', async () => {
      const { post, store } = setup()

      await post('/context', {
        session_id: 's1',
        key: 'obj',
        value: { nested: true },
      })

      expect(store.getContext('s1', 'obj')).toEqual({ nested: true })
    })

    it('returns 400 when session_id is missing', async () => {
      const { post } = setup()

      const res = await post('/context', {
        key: 'k',
        value: 'v',
      })

      expect(res.status).toBe(400)
      const body = (await res.json()) as Record<string, unknown>
      expect(body['error']).toBe('Validation error')
    })

    it('returns 400 when key is missing', async () => {
      const { post } = setup()

      const res = await post('/context', {
        session_id: 's1',
        value: 'v',
      })

      expect(res.status).toBe(400)
    })

    it('returns 400 when value is missing', async () => {
      const { post } = setup()

      const res = await post('/context', {
        session_id: 's1',
        key: 'k',
        // value omitted
      })

      expect(res.status).toBe(400)
    })

    it('returns 400 for invalid JSON', async () => {
      const { app } = setup()

      const res = await app.request('/context', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{bad',
      })

      expect(res.status).toBe(400)
      const body = (await res.json()) as Record<string, unknown>
      expect(body['error']).toBe('Invalid JSON')
    })

    it('returns 503 when context write is attempted after store close', async () => {
      const { post, store } = setup()
      store.close()

      const res = await post('/context', {
        session_id: 's1',
        key: 'agent_id',
        value: 'bot',
      })

      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: 'sideband_shutting_down' })
    })
  })

  // -----------------------------------------------------------------------
  // GET /session/:session_id/state
  // -----------------------------------------------------------------------

  describe('GET /session/:session_id/state', () => {
    it('returns combined evidence and context', async () => {
      const { post, get } = setup()

      await post('/evidence', {
        session_id: 's1',
        tool_name: 'get_order',
        evidence_key: 'orders.lookup',
        evidence_data: { id: 42 },
      })
      await post('/context', {
        session_id: 's1',
        key: 'agent_id',
        value: 'bot-1',
      })

      const res = await get('/session/s1/state')
      expect(res.status).toBe(200)

      const body = (await res.json()) as Record<string, unknown>
      expect(body['session_id']).toBe('s1')

      const evidence = body['evidence'] as Record<string, unknown>
      expect(evidence['orders.lookup']).toBeDefined()

      const context = body['context'] as Record<string, unknown>
      expect(context['agent_id']).toBe('bot-1')
    })

    it('returns empty state for unknown session', async () => {
      const { get } = setup()

      const res = await get('/session/nonexistent/state')
      expect(res.status).toBe(200)

      const body = (await res.json()) as Record<string, unknown>
      expect(body['session_id']).toBe('nonexistent')
      expect(body['evidence']).toEqual({})
      expect(body['context']).toEqual({})
    })

    it('excludes expired evidence', async () => {
      const { post, get, advance } = setup({ ttl: 1 })

      await post('/evidence', {
        session_id: 's1',
        tool_name: 't',
        evidence_key: 'old',
        evidence_data: null,
      })

      advance(2_000)

      const res = await get('/session/s1/state')
      const body = (await res.json()) as Record<string, unknown>
      expect(body['evidence']).toEqual({})
    })
  })

  // -----------------------------------------------------------------------
  // GET /healthz
  // -----------------------------------------------------------------------

  describe('GET /healthz', () => {
    it('returns 200 with status ok', async () => {
      const { get } = setup()

      const res = await get('/healthz')
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ status: 'ok' })
    })
  })

  // -----------------------------------------------------------------------
  // Unknown routes
  // -----------------------------------------------------------------------

  describe('unknown routes', () => {
    it('returns 404 for unregistered paths', async () => {
      const { get } = setup()

      const res = await get('/unknown')
      expect(res.status).toBe(404)
    })
  })

  // -----------------------------------------------------------------------
  // Bearer authentication
  // -----------------------------------------------------------------------

  describe('bearer auth', () => {
    const TOKEN = 'deadbeef'.repeat(8)

    it('rejects POST /evidence without an Authorization header (401)', async () => {
      const store = new EvidenceStore({ cleanupIntervalMs: 0 })
      const app = createSidebandApp(store, { token: TOKEN })

      const res = await app.request('/evidence', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          session_id: 's1',
          tool_name: 't',
          evidence_key: 'k',
          evidence_data: null,
        }),
      })

      expect(res.status).toBe(401)
      expect(store.hasEvidence('s1', 'k')).toBe(false)
    })

    it('rejects POST /evidence with a mismatched token (401)', async () => {
      const store = new EvidenceStore({ cleanupIntervalMs: 0 })
      const app = createSidebandApp(store, { token: TOKEN })

      const res = await app.request('/evidence', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer the-wrong-token',
        },
        body: JSON.stringify({
          session_id: 's1',
          tool_name: 't',
          evidence_key: 'k',
          evidence_data: null,
        }),
      })

      expect(res.status).toBe(401)
      expect(store.hasEvidence('s1', 'k')).toBe(false)
    })

    it('accepts POST /evidence with the correct Bearer token (201)', async () => {
      const { post, store } = setup({ token: TOKEN })

      const res = await post('/evidence', {
        session_id: 's1',
        tool_name: 't',
        evidence_key: 'k',
        evidence_data: null,
      })

      expect(res.status).toBe(201)
      expect(store.hasEvidence('s1', 'k')).toBe(true)
    })

    it('rejects POST /context without a token (401)', async () => {
      const store = new EvidenceStore({ cleanupIntervalMs: 0 })
      const app = createSidebandApp(store, { token: TOKEN })

      const res = await app.request('/context', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session_id: 's1', key: 'k', value: 'v' }),
      })

      expect(res.status).toBe(401)
    })

    it('rejects GET /session/:id/state without a token (401)', async () => {
      const store = new EvidenceStore({ cleanupIntervalMs: 0 })
      const app = createSidebandApp(store, { token: TOKEN })

      const res = await app.request('/session/s1/state')
      expect(res.status).toBe(401)
    })

    it('allows GET /healthz without a token for container probes', async () => {
      const store = new EvidenceStore({ cleanupIntervalMs: 0 })
      const app = createSidebandApp(store, { token: TOKEN })

      const res = await app.request('/healthz')
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ status: 'ok' })
    })

    it('leaves every endpoint open when no token is configured (backwards compat)', async () => {
      const { post, get } = setup()

      const postRes = await post('/evidence', {
        session_id: 's1',
        tool_name: 't',
        evidence_key: 'k',
        evidence_data: null,
      })
      expect(postRes.status).toBe(201)

      const getRes = await get('/session/s1/state')
      expect(getRes.status).toBe(200)
    })
  })

  // -----------------------------------------------------------------------
  // CORS protection
  // -----------------------------------------------------------------------

  describe('cors protection', () => {
    const TOKEN = 'cafebabe'.repeat(8)

    it('rejects POST /evidence with an Origin header (403)', async () => {
      const store = new EvidenceStore({ cleanupIntervalMs: 0 })
      const app = createSidebandApp(store, { token: TOKEN })

      const res = await app.request('/evidence', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${TOKEN}`,
          origin: 'https://evil.example',
        },
        body: JSON.stringify({
          session_id: 's1',
          tool_name: 't',
          evidence_key: 'k',
          evidence_data: null,
        }),
      })

      expect(res.status).toBe(403)
      expect(store.hasEvidence('s1', 'k')).toBe(false)
    })

    it('rejects CORS preflight OPTIONS requests with 403', async () => {
      const store = new EvidenceStore({ cleanupIntervalMs: 0 })
      const app = createSidebandApp(store, { token: TOKEN })

      const res = await app.request('/evidence', {
        method: 'OPTIONS',
        headers: {
          origin: 'https://evil.example',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'authorization,content-type',
        },
      })

      expect(res.status).toBe(403)
    })

    it('CORS guard fires even when no token is configured', async () => {
      const store = new EvidenceStore({ cleanupIntervalMs: 0 })
      const app = createSidebandApp(store)

      const res = await app.request('/evidence', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'http://localhost:3000',
        },
        body: JSON.stringify({
          session_id: 's1',
          tool_name: 't',
          evidence_key: 'k',
          evidence_data: null,
        }),
      })

      expect(res.status).toBe(403)
    })

    it('rejects requests with a literal "null" Origin header', async () => {
      const store = new EvidenceStore({ cleanupIntervalMs: 0 })
      const app = createSidebandApp(store, { token: TOKEN })

      const res = await app.request('/evidence', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${TOKEN}`,
          origin: 'null',
        },
        body: JSON.stringify({
          session_id: 's1',
          tool_name: 't',
          evidence_key: 'k',
          evidence_data: null,
        }),
      })

      expect(res.status).toBe(403)
      expect(store.hasEvidence('s1', 'k')).toBe(false)
    })
  })
})
