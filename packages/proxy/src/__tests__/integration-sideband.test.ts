import { describe, it, expect, afterAll } from 'vitest'
import { EvidenceStore } from '../evidence/index.js'
import { createSidebandApp } from '../evidence/index.js'
import { startOnDynamicPort } from './helpers/test-utils.js'
import type { ManagedServer } from './helpers/test-utils.js'

// ---------------------------------------------------------------------------
// Setup — sideband server with a controllable clock
// ---------------------------------------------------------------------------

let time = 1_000_000
const advance = (ms: number) => {
  time += ms
}

const store = new EvidenceStore({
  defaultTtlSeconds: 5,
  cleanupIntervalMs: 0,
  now: () => time,
})

const sidebandApp = createSidebandApp(store)
// Start before all tests (eagerly, outside beforeAll to keep it simple)
const server: ManagedServer = startOnDynamicPort(sidebandApp)
const baseUrl = `http://127.0.0.1:${String(server.port)}`

afterAll(async () => {
  await server.close()
  store.close()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function post(path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json: unknown = await res.json()
  return { status: res.status, body: json }
}

async function get(path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${path}`)
  const json: unknown = await res.json()
  return { status: res.status, body: json }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Sideband API integration', () => {
  it('GET /healthz returns ok', async () => {
    const res = await get('/healthz')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ status: 'ok' })
  })

  it('POST /evidence stores evidence via HTTP', async () => {
    const res = await post('/evidence', {
      session_id: 'integration-1',
      tool_name: 'get_order',
      evidence_key: 'orders.lookup',
      evidence_data: { orderId: 42, total: 99.99 },
    })

    expect(res.status).toBe(201)
    expect(res.body).toEqual({ ok: true })
  })

  it('POST /context stores context via HTTP', async () => {
    const res = await post('/context', {
      session_id: 'integration-1',
      key: 'agent_id',
      value: 'support-bot',
    })

    expect(res.status).toBe(201)
    expect(res.body).toEqual({ ok: true })
  })

  it('GET /session/:id/state returns combined evidence and context', async () => {
    const res = await get('/session/integration-1/state')
    expect(res.status).toBe(200)

    const body = res.body as Record<string, unknown>
    expect(body['session_id']).toBe('integration-1')

    const evidence = body['evidence'] as Record<string, unknown>
    expect(evidence['orders.lookup']).toBeDefined()

    const entry = evidence['orders.lookup'] as Record<string, unknown>
    expect(entry['data']).toEqual({ orderId: 42, total: 99.99 })
    expect(entry['tool_name']).toBe('get_order')

    const context = body['context'] as Record<string, unknown>
    expect(context['agent_id']).toBe('support-bot')
  })

  it('expired evidence is excluded from GET /session/:id/state', async () => {
    // Store evidence with a short custom TTL
    await post('/evidence', {
      session_id: 'integration-2',
      tool_name: 'tool_a',
      evidence_key: 'short_lived',
      evidence_data: 'temporary',
      ttl_seconds: 1,
    })

    // Also store context (no TTL)
    await post('/context', {
      session_id: 'integration-2',
      key: 'persistent_key',
      value: 'still here',
    })

    // Advance past the 1s TTL
    advance(2_000)

    const res = await get('/session/integration-2/state')
    const body = res.body as Record<string, unknown>

    // Evidence should be gone
    expect(body['evidence']).toEqual({})

    // Context should persist
    const context = body['context'] as Record<string, unknown>
    expect(context['persistent_key']).toBe('still here')
  })

  it('GET /session/:id/state returns empty state for unknown session', async () => {
    const res = await get('/session/nonexistent/state')
    expect(res.status).toBe(200)

    const body = res.body as Record<string, unknown>
    expect(body['session_id']).toBe('nonexistent')
    expect(body['evidence']).toEqual({})
    expect(body['context']).toEqual({})
  })

  it('POST /evidence returns 400 for invalid body', async () => {
    const res = await post('/evidence', {
      // missing session_id
      tool_name: 'get_order',
      evidence_key: 'k',
      evidence_data: null,
    })

    expect(res.status).toBe(400)
    const body = res.body as Record<string, unknown>
    expect(body['error']).toBe('Validation error')
    expect(body['details']).toBeDefined()
  })

  it('POST /context returns 400 for invalid body', async () => {
    const res = await post('/context', {
      // missing session_id
      key: 'k',
      value: 'v',
    })

    expect(res.status).toBe(400)
    const body = res.body as Record<string, unknown>
    expect(body['error']).toBe('Validation error')
  })

  it('POST /evidence returns 400 when key is not in policy allowlist', async () => {
    const localStore = new EvidenceStore({
      cleanupIntervalMs: 0,
      allowedEvidenceKeys: ['orders.lookup'],
    })
    const localApp = createSidebandApp(localStore)
    const localServer = startOnDynamicPort(localApp)
    const localBaseUrl = `http://127.0.0.1:${String(localServer.port)}`

    try {
      const res = await fetch(`${localBaseUrl}/evidence`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          session_id: 's-allowlist',
          tool_name: 'lookup',
          evidence_key: 'unknown.key',
          evidence_data: { id: 1 },
        }),
      })

      expect(res.status).toBe(400)
      const body = (await res.json()) as Record<string, unknown>
      expect(body['code']).toBe('evidence_key_not_in_policy_allowlist')
      expect(body['key']).toBe('unknown.key')
      expect(body['allowed_key_count']).toBe(1)
      expect(body['truncated']).toBe(false)
      expect(body['allowed_keys']).toEqual(['orders.lookup'])
    } finally {
      await localServer.close()
      localStore.close()
    }
  })

  it('POST /context returns 503 when store is closed', async () => {
    const localStore = new EvidenceStore({ cleanupIntervalMs: 0 })
    const localApp = createSidebandApp(localStore)
    const localServer = startOnDynamicPort(localApp)
    const localBaseUrl = `http://127.0.0.1:${String(localServer.port)}`

    try {
      localStore.close()

      const res = await fetch(`${localBaseUrl}/context`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          session_id: 's-closed',
          key: 'agent_id',
          value: 'bot',
        }),
      })

      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: 'sideband_shutting_down' })
    } finally {
      await localServer.close()
    }
  })
})
