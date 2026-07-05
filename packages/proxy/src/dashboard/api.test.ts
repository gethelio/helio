import { describe, it, expect, afterEach, vi } from 'vitest'
import { HTTPException } from 'hono/http-exception'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDashboardApp, createDashboardAppWithLifecycle } from './api.js'
import type { DashboardAppDeps } from './api.js'
import { DashboardEventBus } from './event-bus.js'
import { AuditStore } from '../audit/store.js'
import type { AuditRecord } from '../audit/types.js'
import { ApprovalQueue } from '../approval/queue.js'
import { ApprovalRouter } from '../approval/router.js'
import { QueueChannel } from '../approval/channels.js'
import { RateLimiter } from '../policy/rate-limiter.js'
import { SpendLimiter } from '../policy/spend-limiter.js'
import { EvidenceStore } from '../evidence/store.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Safely index an array, throwing if the element is undefined. */
function at<T>(arr: readonly T[], index: number): T {
  const val = arr[index]
  if (val === undefined) throw new Error(`Expected element at index ${String(index)}`)
  return val
}

// ---------------------------------------------------------------------------
// Setup helper
// ---------------------------------------------------------------------------

function setup(options?: {
  apiSecret?: string
  adapterLiveness?: DashboardAppDeps['adapterLiveness']
}) {
  const auditStore = new AuditStore({
    path: ':memory:',
    retention: '90d',
    includeResponses: true,
    cleanupIntervalMs: 0,
  })
  const approvalQueue = new ApprovalQueue({ cleanupIntervalMs: 0 })
  const channels = new Map([['dashboard', new QueueChannel()]])
  const approvalRouter = new ApprovalRouter({
    defaultTimeoutMs: 300_000,
    defaultOnTimeout: 'deny',
    channels,
    queue: approvalQueue,
  })
  const rateLimiter = new RateLimiter({ cleanupIntervalMs: 0 })
  const spendLimiter = new SpendLimiter({ cleanupIntervalMs: 0 })
  const evidenceStore = new EvidenceStore({ cleanupIntervalMs: 0 })
  const eventBus = new DashboardEventBus()

  const app = createDashboardApp(
    {
      auditStore,
      approvalRouter,
      approvalQueue,
      rateLimiter,
      spendLimiter,
      evidenceStore,
      eventBus,
      adapterLiveness: options?.adapterLiveness,
    },
    { apiSecret: options?.apiSecret },
  )

  const get = (path: string, headers?: Record<string, string>) =>
    app.request(path, { headers: { ...headers } })
  const post = (path: string, body: unknown, headers?: Record<string, string>) =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })

  return {
    app,
    auditStore,
    approvalRouter,
    approvalQueue,
    rateLimiter,
    spendLimiter,
    evidenceStore,
    eventBus,
    get,
    post,
  }
}

/** Insert a test audit record and return the generated id. */
function insertAuditRecord(
  store: AuditStore,
  overrides: Partial<Omit<AuditRecord, 'id' | 'created_at'>> = {},
  createdAt?: string,
): string {
  const defaults: Omit<AuditRecord, 'id' | 'created_at'> = {
    timestamp: new Date().toISOString(),
    session_id: null,
    agent_id: null,
    environment: null,
    tool_name: 'test_tool',
    tool_input: {},
    policy_decision: 'allow',
    block_reason: null,
    matched_rule: null,
    matched_rule_index: null,
    evidence_chain: null,
    approval_status: null,
    approved_by: null,
    upstream_response: null,
    upstream_error: null,
    upstream_http_status: null,
    upstream_latency_ms: null,
    total_duration_ms: 1,
    approval_wait_ms: 0,
    proxy_compute_ms: 1,
    flagged_destructive: false,
    dry_run: false,
    record_kind: 'tool_call',
    origin: 'mcp',
    metadata: null,
  }

  return store.insert(
    {
      ...defaults,
      ...overrides,
      environment: overrides.environment ?? defaults.environment,
      matched_rule_index: overrides.matched_rule_index ?? defaults.matched_rule_index,
    },
    createdAt,
  )
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

let cleanup: Array<{ close: () => void }> = []

afterEach(() => {
  for (const c of cleanup) c.close()
  cleanup = []
})

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

describe('GET /api/health', () => {
  it('returns 200 with status, version, and uptime', async () => {
    const { get } = setup()
    const res = await get('/api/health')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.status).toBe('ok')
    expect(body.version).toBeDefined()
    expect(typeof body.uptime).toBe('number')
  })
})

// ---------------------------------------------------------------------------
// Feed
// ---------------------------------------------------------------------------

describe('GET /api/feed', () => {
  it('returns empty list when no records', async () => {
    const { get, auditStore } = setup()
    cleanup.push(auditStore)
    const res = await get('/api/feed')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.data).toEqual([])
    expect(body.total).toBe(0)
  })

  it('returns records in desc order by default', async () => {
    const { get, auditStore } = setup()
    cleanup.push(auditStore)
    insertAuditRecord(auditStore, { tool_name: 'first' })
    insertAuditRecord(auditStore, { tool_name: 'second' })
    const res = await get('/api/feed')
    const body = (await res.json()) as { data: AuditRecord[] }
    expect(body.data).toHaveLength(2)
    expect(at(body.data, 0).tool_name).toBe('second')
  })

  it('respects limit parameter', async () => {
    const { get, auditStore } = setup()
    cleanup.push(auditStore)
    insertAuditRecord(auditStore)
    insertAuditRecord(auditStore)
    insertAuditRecord(auditStore)
    const res = await get('/api/feed?limit=2')
    const body = (await res.json()) as { data: AuditRecord[]; total: number }
    expect(body.data).toHaveLength(2)
    expect(body.total).toBe(3)
  })

  it('respects offset parameter', async () => {
    const { get, auditStore } = setup()
    cleanup.push(auditStore)
    insertAuditRecord(auditStore, { tool_name: 'a' })
    insertAuditRecord(auditStore, { tool_name: 'b' })
    insertAuditRecord(auditStore, { tool_name: 'c' })
    const res = await get('/api/feed?limit=10&offset=1')
    const body = (await res.json()) as { data: AuditRecord[] }
    expect(body.data).toHaveLength(2)
  })

  it('normalizes the envelope to { data, total, limit, offset }', async () => {
    const { get, auditStore } = setup()
    cleanup.push(auditStore)
    insertAuditRecord(auditStore)
    const res = await get('/api/feed')
    const body = (await res.json()) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['data', 'limit', 'offset', 'total'])
    expect('records' in body).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Audit search
// ---------------------------------------------------------------------------

describe('GET /api/audit', () => {
  it('returns all records with no filters', async () => {
    const { get, auditStore } = setup()
    cleanup.push(auditStore)
    insertAuditRecord(auditStore)
    insertAuditRecord(auditStore)
    const res = await get('/api/audit')
    const body = (await res.json()) as Record<string, unknown>
    expect(body.data).toHaveLength(2)
    expect(body.total).toBe(2)
    // `page` is deliberately NOT echoed in the response — clients compute it
    // from offset/limit on read. Guard against regressions.
    expect('page' in body).toBe(false)
  })

  it('filters by tool name', async () => {
    const { get, auditStore } = setup()
    cleanup.push(auditStore)
    insertAuditRecord(auditStore, { tool_name: 'send_email' })
    insertAuditRecord(auditStore, { tool_name: 'read_data' })
    const res = await get('/api/audit?tool=send_email')
    const body = (await res.json()) as { data: AuditRecord[] }
    expect(body.data).toHaveLength(1)
    expect(at(body.data, 0).tool_name).toBe('send_email')
  })

  it('filters by policy decision', async () => {
    const { get, auditStore } = setup()
    cleanup.push(auditStore)
    insertAuditRecord(auditStore, { policy_decision: 'allow' })
    insertAuditRecord(auditStore, { policy_decision: 'deny' })
    insertAuditRecord(auditStore, { policy_decision: 'deny' })
    const res = await get('/api/audit?decision=deny')
    const body = (await res.json()) as { data: AuditRecord[] }
    expect(body.data).toHaveLength(2)
  })

  it('filters by block reason', async () => {
    const { get, auditStore } = setup()
    cleanup.push(auditStore)
    insertAuditRecord(auditStore, { policy_decision: 'deny', block_reason: 'evidence_missing' })
    insertAuditRecord(auditStore, { policy_decision: 'deny', block_reason: 'evidence_expired' })
    const res = await get('/api/audit?reason=evidence_missing')
    const body = (await res.json()) as { data: AuditRecord[] }
    expect(body.data).toHaveLength(1)
    expect(at(body.data, 0).block_reason).toBe('evidence_missing')
  })

  it('filters blocked=true via non-null block_reason', async () => {
    const { get, auditStore } = setup()
    cleanup.push(auditStore)
    insertAuditRecord(auditStore, { policy_decision: 'allow', block_reason: null })
    insertAuditRecord(auditStore, { policy_decision: 'deny', block_reason: 'policy_denied' })
    const res = await get('/api/audit?blocked=true')
    const body = (await res.json()) as { data: AuditRecord[] }
    expect(body.data).toHaveLength(1)
    expect(at(body.data, 0).block_reason).toBe('policy_denied')
  })

  it('filters by date range', async () => {
    const { get, auditStore } = setup()
    cleanup.push(auditStore)
    // from/to filter on created_at, so pass createdAt explicitly
    insertAuditRecord(auditStore, {}, '2025-01-01T00:00:00Z')
    insertAuditRecord(auditStore, {}, '2026-04-02T12:00:00Z')
    const res = await get('/api/audit?from=2026-01-01T00:00:00Z')
    const body = (await res.json()) as { data: AuditRecord[] }
    expect(body.data).toHaveLength(1)
  })

  it('filters by upstream_status_min', async () => {
    const { get, auditStore } = setup()
    cleanup.push(auditStore)
    insertAuditRecord(auditStore, { tool_name: 'ok', upstream_http_status: 200 })
    insertAuditRecord(auditStore, { tool_name: 'not-found', upstream_http_status: 404 })
    insertAuditRecord(auditStore, { tool_name: 'failure', upstream_http_status: 500 })
    const res = await get('/api/audit?upstream_status_min=500')
    const body = (await res.json()) as { data: AuditRecord[] }
    expect(body.data).toHaveLength(1)
    expect(at(body.data, 0).tool_name).toBe('failure')
  })

  it('filters by upstream_status_max', async () => {
    const { get, auditStore } = setup()
    cleanup.push(auditStore)
    insertAuditRecord(auditStore, { tool_name: 'ok', upstream_http_status: 200 })
    insertAuditRecord(auditStore, { tool_name: 'not-found', upstream_http_status: 404 })
    insertAuditRecord(auditStore, { tool_name: 'failure', upstream_http_status: 500 })
    const res = await get('/api/audit?upstream_status_max=404')
    const body = (await res.json()) as { data: AuditRecord[] }
    expect(body.data).toHaveLength(2)
    const names = body.data.map((r) => r.tool_name)
    expect(names).toEqual(expect.arrayContaining(['ok', 'not-found']))
  })

  it('supports offset parameter for pagination', async () => {
    const { get, auditStore } = setup()
    cleanup.push(auditStore)
    for (let i = 0; i < 5; i++) insertAuditRecord(auditStore, { tool_name: `tool_${String(i)}` })
    const res = await get('/api/audit?limit=2&offset=2')
    const body = (await res.json()) as Record<string, unknown>
    // `offset=2` + `limit=2` skips the first two records and returns the
    // next two of five. The response echoes `offset`, never `page`.
    expect(body.data).toHaveLength(2)
    expect(body.total).toBe(5)
    expect(body.offset).toBe(2)
    expect(body.limit).toBe(2)
    expect('page' in body).toBe(false)
  })

  it('returns total count regardless of pagination', async () => {
    const { get, auditStore } = setup()
    cleanup.push(auditStore)
    for (let i = 0; i < 10; i++) insertAuditRecord(auditStore)
    const res = await get('/api/audit?limit=3')
    const body = (await res.json()) as { total: number; data: AuditRecord[] }
    expect(body.total).toBe(10)
    expect(body.data).toHaveLength(3)
  })

  it('treats empty ?limit= as fallback, not a 500', async () => {
    const { get, auditStore } = setup()
    cleanup.push(auditStore)
    insertAuditRecord(auditStore)
    // Browsers submit empty form fields as `?foo=`. The handler must fall
    // back to the default via clampInt's NaN guard — not pass NaN into
    // better-sqlite3, which would 500. Belt-and-suspenders with the direct
    // clampInt("" → fallback) unit test at util/clamp.test.ts.
    const res = await get('/api/audit?limit=')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { limit: number; data: AuditRecord[] }
    expect(body.limit).toBe(50)
    expect(body.data).toHaveLength(1)
  })

  it('filters by origin and record_kind (#16)', async () => {
    const { get, auditStore } = setup()
    cleanup.push(auditStore)
    insertAuditRecord(auditStore, {
      tool_name: 'kept',
      origin: 'openclaw',
      record_kind: 'install_scan',
    })
    insertAuditRecord(auditStore, {
      tool_name: 'wrong_kind',
      origin: 'openclaw',
      record_kind: 'tool_call',
    })
    insertAuditRecord(auditStore, {
      tool_name: 'wrong_origin',
      origin: 'mcp',
      record_kind: 'install_scan',
    })

    const res = await get('/api/audit?origin=openclaw&record_kind=install_scan')
    const body = (await res.json()) as { total: number; data: AuditRecord[] }
    expect(res.status).toBe(200)
    expect(body.total).toBe(1)
    expect(body.data.map((r) => r.tool_name)).toEqual(['kept'])
  })

  it('filters by channel_id and sender_id (#16)', async () => {
    const { get, auditStore } = setup()
    cleanup.push(auditStore)
    insertAuditRecord(auditStore, {
      tool_name: 'kept',
      origin: 'openclaw',
      metadata: { channel_id: 'C123', sender_id: 'U1' },
    })
    insertAuditRecord(auditStore, {
      tool_name: 'other_sender',
      origin: 'openclaw',
      metadata: { channel_id: 'C123', sender_id: 'U2' },
    })
    insertAuditRecord(auditStore, { tool_name: 'mcp_no_meta', origin: 'mcp', metadata: null })

    const res = await get('/api/audit?channel_id=C123&sender_id=U1')
    const body = (await res.json()) as { total: number; data: AuditRecord[] }
    expect(res.status).toBe(200)
    expect(body.total).toBe(1)
    expect(body.data.map((r) => r.tool_name)).toEqual(['kept'])
  })
})

// ---------------------------------------------------------------------------
// Audit detail
// ---------------------------------------------------------------------------

describe('GET /api/audit/:id', () => {
  it('returns a record by ID', async () => {
    const { get, auditStore } = setup()
    cleanup.push(auditStore)
    const id = insertAuditRecord(auditStore, { tool_name: 'specific_tool' })
    const res = await get(`/api/audit/${id}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: AuditRecord }
    expect(body.data.id).toBe(id)
    expect(body.data.tool_name).toBe('specific_tool')
  })

  it('returns 404 for unknown ID', async () => {
    const { get, auditStore } = setup()
    cleanup.push(auditStore)
    const res = await get('/api/audit/nonexistent-id')
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Audit export
// ---------------------------------------------------------------------------

describe('GET /api/audit/export', () => {
  it('exports as JSON by default', async () => {
    const { get, auditStore } = setup()
    cleanup.push(auditStore)
    insertAuditRecord(auditStore, { tool_name: 'exported_tool' })
    const res = await get('/api/audit/export')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(res.headers.get('content-disposition')).toContain('helio-audit-export.json')
    const body = (await res.json()) as AuditRecord[]
    expect(body).toHaveLength(1)
    expect(at(body, 0).tool_name).toBe('exported_tool')
  })

  it('exports as CSV when format=csv', async () => {
    const { get, auditStore } = setup()
    cleanup.push(auditStore)
    insertAuditRecord(auditStore, { tool_name: 'csv_tool' })
    const res = await get('/api/audit/export?format=csv')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/csv')
    expect(res.headers.get('content-disposition')).toContain('helio-audit-export.csv')
    const text = await res.text()
    expect(text).toContain('id,timestamp,session_id')
    expect(text).toContain('csv_tool')
    const header = text.split('\n')[0] ?? ''
    expect(header).toContain('record_kind')
    expect(header).toContain('origin')
    expect(header).toContain('metadata')
  })

  it('respects filters in export', async () => {
    const { get, auditStore } = setup()
    cleanup.push(auditStore)
    insertAuditRecord(auditStore, { tool_name: 'keep', policy_decision: 'deny' })
    insertAuditRecord(auditStore, { tool_name: 'skip', policy_decision: 'allow' })
    const res = await get('/api/audit/export?decision=deny')
    const body = (await res.json()) as AuditRecord[]
    expect(body).toHaveLength(1)
    expect(at(body, 0).tool_name).toBe('keep')
  })

  it('respects upstream status filters in export', async () => {
    const { get, auditStore } = setup()
    cleanup.push(auditStore)
    insertAuditRecord(auditStore, { tool_name: 'ok', upstream_http_status: 200 })
    insertAuditRecord(auditStore, { tool_name: 'fail', upstream_http_status: 503 })
    const res = await get('/api/audit/export?upstream_status_min=500')
    const body = (await res.json()) as AuditRecord[]
    expect(body).toHaveLength(1)
    expect(at(body, 0).tool_name).toBe('fail')
  })

  it('export filters by origin (#16)', async () => {
    const { get, auditStore } = setup()
    cleanup.push(auditStore)
    insertAuditRecord(auditStore, { tool_name: 'adapter_call', origin: 'openclaw' })
    insertAuditRecord(auditStore, { tool_name: 'mcp_call', origin: 'mcp' })

    const res = await get('/api/audit/export?format=json&origin=openclaw')
    expect(res.status).toBe(200)
    const rows = (await res.json()) as AuditRecord[]
    const names = rows.map((r) => r.tool_name)
    expect(names).toContain('adapter_call')
    expect(names).not.toContain('mcp_call')
  })

  it('exports more than 1000 records in one request (#131)', async () => {
    const { get, auditStore } = setup()
    cleanup.push(auditStore)
    for (let i = 0; i < 1200; i++) {
      insertAuditRecord(auditStore)
    }

    const full = await get('/api/audit/export?limit=10000')
    expect(full.status).toBe(200)
    const fullBody = (await full.json()) as AuditRecord[]
    expect(fullBody).toHaveLength(1200)

    const partial = await get('/api/audit/export?limit=1100')
    const partialBody = (await partial.json()) as AuditRecord[]
    expect(partialBody).toHaveLength(1100)
  })
})

// ---------------------------------------------------------------------------
// Approvals list
// ---------------------------------------------------------------------------

describe('GET /api/approvals', () => {
  it('returns empty list when no tickets', async () => {
    const { get } = setup()
    const res = await get('/api/approvals')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: unknown[] }
    expect(body.data).toEqual([])
  })

  it('returns pending tickets', async () => {
    const { get, approvalQueue } = setup()
    approvalQueue.add({
      tool_name: 'send_payment',
      tool_input: {},
      matched_rule: null,
      rule_index: null,
      channel_name: 'dashboard',
      session_id: null,
      timeout_ms: 300_000,
    })
    const res = await get('/api/approvals')
    const body = (await res.json()) as { data: Array<{ tool_name: string }> }
    expect(body.data).toHaveLength(1)
    expect(at(body.data, 0).tool_name).toBe('send_payment')
  })

  it('filters by status', async () => {
    const { get, approvalQueue } = setup()
    approvalQueue.add({
      tool_name: 'a',
      tool_input: {},
      matched_rule: null,
      rule_index: null,
      channel_name: 'dashboard',
      session_id: null,
      timeout_ms: 300_000,
    })
    const ticket = approvalQueue.add({
      tool_name: 'b',
      tool_input: {},
      matched_rule: null,
      rule_index: null,
      channel_name: 'dashboard',
      session_id: null,
      timeout_ms: 300_000,
    })
    approvalQueue.resolve(ticket.id, 'approved', 'admin')
    const res = await get('/api/approvals?status=pending')
    const body = (await res.json()) as { data: unknown[] }
    expect(body.data).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Approve / Deny / Break-glass
// ---------------------------------------------------------------------------

describe('POST /api/approvals/:id/approve', () => {
  it('approves a pending ticket', async () => {
    const { post, approvalQueue, approvalRouter } = setup()
    // Submit via router to create a pending hold
    const submitPromise = approvalRouter.submit({
      tool_name: 'test',
      tool_input: {},
      matched_rule: undefined,
      session_id: null,
    })
    // Find the ticket
    const tickets = approvalQueue.listPending()
    expect(tickets).toHaveLength(1)

    const res = await post(`/api/approvals/${at(tickets, 0).id}/approve`, {
      approved_by: 'admin',
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean }
    expect(body.ok).toBe(true)

    // The submit promise should resolve with approved
    const outcome = await submitPromise
    expect(outcome.status).toBe('approved')
  })

  it('returns 404 for unknown ticket', async () => {
    const { post } = setup()
    const res = await post('/api/approvals/unknown-id/approve', { approved_by: 'admin' })
    expect(res.status).toBe(404)
  })

  it('returns 409 for already resolved ticket', async () => {
    const { post, approvalQueue, approvalRouter } = setup()
    void approvalRouter.submit({
      tool_name: 'test',
      tool_input: {},
      matched_rule: undefined,
      session_id: null,
    })
    const tickets = approvalQueue.listPending()
    approvalRouter.approve(at(tickets, 0).id, 'someone')

    const res = await post(`/api/approvals/${at(tickets, 0).id}/approve`, {
      approved_by: 'admin',
    })
    expect(res.status).toBe(409)
  })

  it('returns 400 for missing body', async () => {
    const { post, approvalQueue, approvalRouter } = setup()
    void approvalRouter.submit({
      tool_name: 'test',
      tool_input: {},
      matched_rule: undefined,
      session_id: null,
    })
    const tickets = approvalQueue.listPending()
    const res = await post(`/api/approvals/${at(tickets, 0).id}/approve`, {})
    expect(res.status).toBe(400)
  })
})

describe('POST /api/approvals/:id/deny', () => {
  it('denies a pending ticket with reason', async () => {
    const { post, approvalQueue, approvalRouter } = setup()
    const submitPromise = approvalRouter.submit({
      tool_name: 'test',
      tool_input: {},
      matched_rule: undefined,
      session_id: null,
    })
    const tickets = approvalQueue.listPending()

    const res = await post(`/api/approvals/${at(tickets, 0).id}/deny`, {
      denied_by: 'admin',
      reason: 'Not authorized',
    })
    expect(res.status).toBe(200)

    const outcome = await submitPromise
    expect(outcome.status).toBe('denied')
  })

  it('returns 404 for unknown ticket', async () => {
    const { post } = setup()
    const res = await post('/api/approvals/unknown-id/deny', { denied_by: 'admin' })
    expect(res.status).toBe(404)
  })

  it('returns 409 for already resolved ticket', async () => {
    const { post, approvalQueue, approvalRouter } = setup()
    void approvalRouter.submit({
      tool_name: 'test',
      tool_input: {},
      matched_rule: undefined,
      session_id: null,
    })
    const tickets = approvalQueue.listPending()
    approvalRouter.deny(at(tickets, 0).id, 'someone')

    const res = await post(`/api/approvals/${at(tickets, 0).id}/deny`, { denied_by: 'admin' })
    expect(res.status).toBe(409)
  })
})

describe('POST /api/approvals/:id/break-glass', () => {
  it('overrides a pending ticket', async () => {
    const { post, approvalQueue, approvalRouter } = setup()
    const submitPromise = approvalRouter.submit({
      tool_name: 'test',
      tool_input: {},
      matched_rule: undefined,
      session_id: null,
    })
    const tickets = approvalQueue.listPending()

    const res = await post(`/api/approvals/${at(tickets, 0).id}/break-glass`, {
      approved_by: 'admin',
      reason: 'Emergency',
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean }
    expect(body.ok).toBe(true)

    const outcome = await submitPromise
    expect(outcome.status).toBe('break_glass')
  })

  it('returns 404 for unknown ticket', async () => {
    const { post } = setup()
    const res = await post('/api/approvals/unknown-id/break-glass', {
      approved_by: 'admin',
      reason: 'Emergency',
    })
    expect(res.status).toBe(404)
  })

  it('returns 400 for missing reason', async () => {
    const { post, approvalQueue, approvalRouter } = setup()
    void approvalRouter.submit({
      tool_name: 'test',
      tool_input: {},
      matched_rule: undefined,
      session_id: null,
    })
    const tickets = approvalQueue.listPending()
    const res = await post(`/api/approvals/${at(tickets, 0).id}/break-glass`, {
      approved_by: 'admin',
    })
    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

describe('GET /api/limits', () => {
  it('returns empty limits when none active', async () => {
    const { get } = setup()
    const res = await get('/api/limits')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { rate_limits: unknown[]; spend_limits: unknown[] }
    expect(body.rate_limits).toEqual([])
    expect(body.spend_limits).toEqual([])
  })

  it('returns rate limit state after checks', async () => {
    const { get, rateLimiter } = setup()
    rateLimiter.check({ key: 'tool:send_email', maxCalls: 10, windowMs: 60_000 })
    const res = await get('/api/limits')
    const body = (await res.json()) as { rate_limits: Array<{ key: string; current: number }> }
    expect(body.rate_limits).toHaveLength(1)
    expect(at(body.rate_limits, 0).key).toBe('tool:send_email')
    expect(at(body.rate_limits, 0).current).toBe(1)
  })

  it('returns spend limit state after checks', async () => {
    const { get, spendLimiter } = setup()
    spendLimiter.check({ key: 'tool:payment', amount: 100, limit: 5000, windowMs: 86_400_000 })
    spendLimiter.setCurrency('tool:payment', 'GBP')
    const res = await get('/api/limits')
    const body = (await res.json()) as {
      spend_limits: Array<{ key: string; current_spend: number }>
    }
    expect(body.spend_limits).toHaveLength(1)
    expect(at(body.spend_limits, 0).current_spend).toBe(100)
  })
})

// ---------------------------------------------------------------------------
// Adapters (issue #126)
// ---------------------------------------------------------------------------

describe('GET /api/adapters', () => {
  it('returns an empty adapters list when the SDK sideband is not wired', async () => {
    const { get } = setup()
    const res = await get('/api/adapters')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ adapters: [] })
  })

  it('returns liveness entries from the registry in a raw envelope', async () => {
    const entries = [
      {
        origin: 'openclaw',
        adapter_version: '0.1.0',
        first_seen: '2026-07-04T12:00:00.000Z',
        last_seen: '2026-07-04T12:34:56.789Z',
      },
      {
        origin: 'sideband',
        adapter_version: null,
        first_seen: '2026-07-04T11:00:00.000Z',
        last_seen: '2026-07-04T11:00:00.000Z',
      },
    ]
    const { get } = setup({ adapterLiveness: { listAdapters: () => entries } })
    const res = await get('/api/adapters')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ adapters: entries })
  })

  it('requires auth like the other read endpoints when a secret is set', async () => {
    const { get } = setup({ apiSecret: 'test-secret' })
    const res = await get('/api/adapters')
    expect(res.status).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

describe('GET /api/analytics', () => {
  it('returns aggregate stats', async () => {
    const { get, auditStore } = setup()
    cleanup.push(auditStore)
    insertAuditRecord(auditStore, { policy_decision: 'allow' })
    insertAuditRecord(auditStore, {
      policy_decision: 'rate_limit',
      block_reason: 'rate_limited',
    })
    insertAuditRecord(auditStore, {
      policy_decision: 'spend_limit',
      dry_run: true,
    })
    const res = await get('/api/analytics')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      total: number
      by_decision: unknown[]
      allowed_total: number
      blocked_total: number
      dry_run_total: number
      applied_total: number
      by_block_reason: ReadonlyArray<{ reason: string; count: number }>
    }
    expect(body.total).toBe(3)
    expect(body.by_decision).toBeDefined()
    expect(body.allowed_total).toBe(2)
    expect(body.blocked_total).toBe(1)
    expect(body.dry_run_total).toBe(1)
    expect(body.applied_total).toBe(2)
    expect(body.by_block_reason).toEqual([{ reason: 'rate_limited', count: 1 }])
  })

  it('respects from/to parameters', async () => {
    const { get, auditStore } = setup()
    cleanup.push(auditStore)
    insertAuditRecord(auditStore, {}, '2025-01-01T00:00:00Z')
    insertAuditRecord(auditStore, {}, '2026-04-02T12:00:00Z')
    const res = await get('/api/analytics?from=2026-01-01T00:00:00Z')
    const body = (await res.json()) as { total: number }
    expect(body.total).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

describe('GET /api/evidence/:session_id', () => {
  it('returns session state with evidence', async () => {
    const { get, evidenceStore } = setup()
    evidenceStore.putEvidence('sess-1', {
      tool_name: 'lookup',
      evidence_key: 'order.data',
      data: { id: 123 },
    })
    const res = await get('/api/evidence/sess-1')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: { session_id: string; evidence: Record<string, unknown> }
    }
    expect(body.data.session_id).toBe('sess-1')
    expect(body.data.evidence['order.data']).toBeDefined()
  })

  it('returns empty state for unknown session', async () => {
    const { get } = setup()
    const res = await get('/api/evidence/unknown-session')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: { evidence: Record<string, unknown>; completed_tools: unknown[] }
    }
    expect(Object.keys(body.data.evidence)).toHaveLength(0)
    expect(body.data.completed_tools).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// SSE Events
// ---------------------------------------------------------------------------

describe('GET /api/events', () => {
  it('returns SSE content type', async () => {
    const { get } = setup()
    const res = await get('/api/events')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
  })

  it('streams events to connected clients', async () => {
    const { app, eventBus } = setup()

    const res = await app.request('/api/events')
    expect(res.status).toBe(200)
    expect(res.body).not.toBeNull()

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- asserted above
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()

    // Read initial data (heartbeat)
    const readWithTimeout = async (ms: number): Promise<string> => {
      const result = await Promise.race([
        reader.read().then((chunk) => {
          if (!chunk.value) return ''
          return decoder.decode(chunk.value as Uint8Array)
        }),
        new Promise<string>((_resolve, reject) => {
          setTimeout(() => {
            reject(new Error('timeout'))
          }, ms)
        }),
      ])
      return result
    }

    const initial = await readWithTimeout(1000)
    expect(initial).toContain('event: heartbeat')

    // Emit an event and read it
    eventBus.emit('action', {
      id: 'evt-1',
      tool_name: 'test_tool',
      policy_decision: 'allow',
      block_reason: null,
      approval_status: null,
      session_id: null,
      agent_id: null,
      environment: null,
      timestamp: '2026-04-02T12:00:00Z',
      total_duration_ms: 5,
      approval_wait_ms: 0,
      proxy_compute_ms: 5,
      flagged_destructive: false,
      dry_run: false,
      matched_rule: null,
      matched_rule_index: null,
      record_kind: 'tool_call',
      origin: 'mcp',
    })

    const eventData = await readWithTimeout(1000)
    expect(eventData).toContain('event: action')
    expect(eventData).toContain('test_tool')

    await reader.cancel()
  })

  it('accepts custom sseHeartbeatMs option', async () => {
    const { app } = (() => {
      const auditStore = new AuditStore({
        path: ':memory:',
        retention: '90d',
        includeResponses: true,
        cleanupIntervalMs: 0,
      })
      const approvalQueue = new ApprovalQueue({ cleanupIntervalMs: 0 })
      const channels = new Map([['dashboard', new QueueChannel()]])
      const approvalRouter = new ApprovalRouter({
        defaultTimeoutMs: 300_000,
        defaultOnTimeout: 'deny',
        channels,
        queue: approvalQueue,
      })
      const rateLimiter = new RateLimiter({ cleanupIntervalMs: 0 })
      const spendLimiter = new SpendLimiter({ cleanupIntervalMs: 0 })
      const evidenceStore = new EvidenceStore({ cleanupIntervalMs: 0 })
      const eventBus = new DashboardEventBus()

      const dashboardApp = createDashboardApp(
        {
          auditStore,
          approvalRouter,
          approvalQueue,
          rateLimiter,
          spendLimiter,
          evidenceStore,
          eventBus,
        },
        { sseHeartbeatMs: 5_000 },
      )
      return { app: dashboardApp }
    })()

    // Verify the app still serves SSE events correctly with custom heartbeat
    const res = await app.request('/api/events')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
  })

  it('lifecycle close drains active SSE clients and is idempotent', async () => {
    const auditStore = new AuditStore({
      path: ':memory:',
      retention: '90d',
      includeResponses: true,
      cleanupIntervalMs: 0,
    })
    const approvalQueue = new ApprovalQueue({ cleanupIntervalMs: 0 })
    const channels = new Map([['dashboard', new QueueChannel()]])
    const approvalRouter = new ApprovalRouter({
      defaultTimeoutMs: 300_000,
      defaultOnTimeout: 'deny',
      channels,
      queue: approvalQueue,
    })
    const rateLimiter = new RateLimiter({ cleanupIntervalMs: 0 })
    const spendLimiter = new SpendLimiter({ cleanupIntervalMs: 0 })
    const evidenceStore = new EvidenceStore({ cleanupIntervalMs: 0 })
    const eventBus = new DashboardEventBus()
    const lifecycle = createDashboardAppWithLifecycle(
      {
        auditStore,
        approvalRouter,
        approvalQueue,
        rateLimiter,
        spendLimiter,
        evidenceStore,
        eventBus,
      },
      { sseHeartbeatMs: 5_000 },
    )
    cleanup.push(
      auditStore,
      approvalQueue,
      rateLimiter,
      spendLimiter,
      evidenceStore,
      eventBus,
      lifecycle,
    )

    const res = await lifecycle.app.request('/api/events')
    expect(res.status).toBe(200)
    expect(res.body).not.toBeNull()

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- asserted above
    const reader = res.body!.getReader()

    lifecycle.close()
    lifecycle.close()

    const closeOutcome = await Promise.race([
      reader
        .read()
        .then(() => 'read')
        .catch(() => 'read'),
      new Promise<'timeout'>((resolve) => {
        setTimeout(() => {
          resolve('timeout')
        }, 1000)
      }),
    ])
    expect(closeOutcome).toBe('read')

    await reader.cancel()
  })
})

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe('Auth', () => {
  it('GET /api/auth/session reports auth-required but unauthenticated when secret is set', async () => {
    const { get } = setup({ apiSecret: 'test-secret' })
    const res = await get('/api/auth/session')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.auth_required).toBe(true)
    expect(body.authenticated).toBe(false)
  })

  it('POST /api/auth/session issues a session cookie for valid secret', async () => {
    const { post } = setup({ apiSecret: 'test-secret' })
    const res = await post('/api/auth/session', { secret: 'test-secret' })
    expect(res.status).toBe(200)
    const setCookie = res.headers.get('set-cookie')
    expect(setCookie).toContain('helio_session=')
    expect(setCookie).toContain('HttpOnly')
    const body = (await res.json()) as Record<string, unknown>
    expect(body.auth_required).toBe(true)
    expect(body.authenticated).toBe(true)
    expect(body.expires_at).toEqual(expect.any(String))
    expect(body.csrf_token).toEqual(expect.any(String))
  })

  it('cookie-authenticated GET /api/feed succeeds without bearer header', async () => {
    const { post, get } = setup({ apiSecret: 'test-secret' })
    const login = await post('/api/auth/session', { secret: 'test-secret' })
    const sessionCookie = login.headers.get('set-cookie')
    expect(sessionCookie).toBeTruthy()

    const res = await get('/api/feed', { cookie: sessionCookie ?? '' })
    expect(res.status).toBe(200)
  })

  it('treats malformed session cookie values as unauthorized', async () => {
    const { get } = setup({ apiSecret: 'test-secret' })
    // Invalid percent-encoding can throw during decodeURIComponent(). The auth
    // layer should fail closed with 401 rather than bubbling a 500.
    const res = await get('/api/feed', { cookie: 'helio_session=%E0%A4%A' })
    expect(res.status).toBe(401)
  })

  it('POST /api/auth/session rejects invalid secret', async () => {
    const { post } = setup({ apiSecret: 'test-secret' })
    const res = await post('/api/auth/session', { secret: 'wrong-secret' })
    expect(res.status).toBe(401)
  })

  it('POST /api/auth/session returns 400 for malformed payloads', async () => {
    const { app } = setup({ apiSecret: 'test-secret' })
    const res = await app.request('/api/auth/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.error).toBe('Validation error')
  })

  it('POST /api/auth/session returns 400 for invalid JSON body', async () => {
    const { app } = setup({ apiSecret: 'test-secret' })
    const res = await app.request('/api/auth/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.error).toBe('Invalid JSON')
  })

  it('GET /api/auth/session reports authenticated when session cookie is valid', async () => {
    const { post, get } = setup({ apiSecret: 'test-secret' })
    const login = await post('/api/auth/session', { secret: 'test-secret' })
    const sessionCookie = login.headers.get('set-cookie')
    expect(sessionCookie).toBeTruthy()

    const status = await get('/api/auth/session', { cookie: sessionCookie ?? '' })
    expect(status.status).toBe(200)
    const body = (await status.json()) as Record<string, unknown>
    expect(body.auth_required).toBe(true)
    expect(body.authenticated).toBe(true)
    expect(body.expires_at).toEqual(expect.any(String))
    expect(body.csrf_token).toEqual(expect.any(String))
  })

  it('POST /api/auth/logout clears session cookie', async () => {
    const { post } = setup({ apiSecret: 'test-secret' })
    const login = await post('/api/auth/session', { secret: 'test-secret' })
    const sessionCookie = login.headers.get('set-cookie')
    expect(sessionCookie).toBeTruthy()

    const logout = await post('/api/auth/logout', {}, { cookie: sessionCookie ?? '' })
    expect(logout.status).toBe(200)
    const clearedCookie = logout.headers.get('set-cookie')
    expect(clearedCookie).toContain('helio_session=')
    expect(clearedCookie).toContain('Max-Age=0')
  })

  it('requires CSRF header for cookie-authenticated mutating requests', async () => {
    const { post, approvalQueue, approvalRouter } = setup({ apiSecret: 'test-secret' })
    const login = await post('/api/auth/session', { secret: 'test-secret' })
    const sessionCookie = login.headers.get('set-cookie')
    expect(sessionCookie).toBeTruthy()

    void approvalRouter.submit({
      tool_name: 'test',
      tool_input: {},
      matched_rule: undefined,
      session_id: null,
    })
    const pending = approvalQueue.listPending()
    const ticketId = at(pending, 0).id

    const res = await post(
      `/api/approvals/${ticketId}/approve`,
      { approved_by: 'admin' },
      { cookie: sessionCookie ?? '' },
    )
    expect(res.status).toBe(403)
  })

  it('accepts cookie-authenticated mutating requests with valid CSRF header', async () => {
    const { post, approvalQueue, approvalRouter } = setup({ apiSecret: 'test-secret' })
    const login = await post('/api/auth/session', { secret: 'test-secret' })
    const sessionCookie = login.headers.get('set-cookie')
    const loginBody = (await login.json()) as Record<string, unknown>
    const csrfToken = typeof loginBody.csrf_token === 'string' ? loginBody.csrf_token : ''
    expect(sessionCookie).toBeTruthy()
    expect(csrfToken.length).toBeGreaterThan(0)

    const submitPromise = approvalRouter.submit({
      tool_name: 'test',
      tool_input: {},
      matched_rule: undefined,
      session_id: null,
    })
    const pending = approvalQueue.listPending()
    const ticketId = at(pending, 0).id

    const res = await post(
      `/api/approvals/${ticketId}/approve`,
      { approved_by: 'admin' },
      { cookie: sessionCookie ?? '', 'x-helio-csrf': csrfToken },
    )
    expect(res.status).toBe(200)
    const outcome = await submitPromise
    expect(outcome.status).toBe('approved')
  })

  it('rejects POST without auth when secret is set', async () => {
    const { post, approvalQueue, approvalRouter } = setup({ apiSecret: 'test-secret' })
    void approvalRouter.submit({
      tool_name: 'test',
      tool_input: {},
      matched_rule: undefined,
      session_id: null,
    })
    const pending = approvalQueue.listPending()
    expect(pending).toHaveLength(1)
    const ticketId = at(pending, 0).id

    const res = await post(`/api/approvals/${ticketId}/approve`, {
      approved_by: 'admin',
    })
    expect(res.status).toBe(401)
  })

  it('accepts POST with correct Bearer token', async () => {
    const { post, approvalQueue, approvalRouter } = setup({ apiSecret: 'test-secret' })
    const submitPromise = approvalRouter.submit({
      tool_name: 'test',
      tool_input: {},
      matched_rule: undefined,
      session_id: null,
    })
    const pending = approvalQueue.listPending()
    expect(pending).toHaveLength(1)
    const ticketId = at(pending, 0).id

    const res = await post(
      `/api/approvals/${ticketId}/approve`,
      { approved_by: 'admin' },
      { authorization: 'Bearer test-secret' },
    )
    expect(res.status).toBe(200)

    const outcome = await submitPromise
    expect(outcome.status).toBe('approved')
  })

  it('allows GET /api/health without auth even when secret is set', async () => {
    // Health endpoint stays open for container healthchecks and observability.
    const { get } = setup({ apiSecret: 'test-secret' })
    const res = await get('/api/health')
    expect(res.status).toBe(200)
  })

  it('rejects GET /api/feed without auth when secret is set', async () => {
    const { get } = setup({ apiSecret: 'test-secret' })
    const res = await get('/api/feed')
    expect(res.status).toBe(401)
  })

  it('rejects GET /api/audit without auth when secret is set', async () => {
    const { get } = setup({ apiSecret: 'test-secret' })
    const res = await get('/api/audit')
    expect(res.status).toBe(401)
  })

  it('rejects GET /api/analytics without auth when secret is set', async () => {
    const { get } = setup({ apiSecret: 'test-secret' })
    const res = await get('/api/analytics')
    expect(res.status).toBe(401)
  })

  it('rejects GET /api/limits without auth when secret is set', async () => {
    const { get } = setup({ apiSecret: 'test-secret' })
    const res = await get('/api/limits')
    expect(res.status).toBe(401)
  })

  it('rejects GET /api/approvals without auth when secret is set', async () => {
    const { get } = setup({ apiSecret: 'test-secret' })
    const res = await get('/api/approvals')
    expect(res.status).toBe(401)
  })

  it('rejects GET /api/evidence/:id without auth when secret is set', async () => {
    const { get } = setup({ apiSecret: 'test-secret' })
    const res = await get('/api/evidence/s1')
    expect(res.status).toBe(401)
  })

  it('accepts GET /api/feed with correct Bearer token', async () => {
    const { get } = setup({ apiSecret: 'test-secret' })
    const res = await get('/api/feed', { authorization: 'Bearer test-secret' })
    expect(res.status).toBe(200)
  })

  it('rejects GET /api/events without auth when secret is set', async () => {
    const { get } = setup({ apiSecret: 'test-secret' })
    // EventSource cannot set headers, so this path also accepts a ?token=
    // query parameter — but with no credentials at all it must still 401.
    const res = await get('/api/events')
    expect(res.status).toBe(401)
  })

  it('rejects GET /api/events with legacy ?token= query parameter', async () => {
    const { get } = setup({ apiSecret: 'test-secret' })
    // Security hardening removed query-param auth to keep secrets out of URLs.
    const res = await get('/api/events?token=test-secret')
    expect(res.status).toBe(401)
  })

  it('rejects GET /api/events with wrong ?token= query parameter', async () => {
    const { get } = setup({ apiSecret: 'test-secret' })
    const res = await get('/api/events?token=wrong-secret')
    expect(res.status).toBe(401)
  })

  it('does not honor ?token= on non-SSE paths', async () => {
    // Only /api/events accepts the query-param fallback. Letting every GET
    // accept ?token=... would leak the secret into server access logs for
    // routine navigation requests.
    const { get } = setup({ apiSecret: 'test-secret' })
    const res = await get('/api/feed?token=test-secret')
    expect(res.status).toBe(401)
  })

  // -------------------------------------------------------------------------
  // The consolidated /api/approvals mount is still auth-protected by
  // the dashboard's /api/* middleware even though the factory is created
  // with apiSecret: undefined. Regression against future drift.
  // -------------------------------------------------------------------------

  it('POST /api/approvals/:id/approve without auth returns 401', async () => {
    const { post, approvalRouter, approvalQueue } = setup({ apiSecret: 'test-secret' })
    void approvalRouter.submit({
      tool_name: 'test',
      tool_input: {},
      matched_rule: undefined,
      session_id: null,
    })
    const pending = approvalQueue.listPending()
    expect(pending).toHaveLength(1)
    const ticketId = at(pending, 0).id

    const res = await post(`/api/approvals/${ticketId}/approve`, { approved_by: 'admin' })
    expect(res.status).toBe(401)
  })

  it('POST /api/approvals/:id/deny without auth returns 401', async () => {
    const { post, approvalRouter, approvalQueue } = setup({ apiSecret: 'test-secret' })
    void approvalRouter.submit({
      tool_name: 'test',
      tool_input: {},
      matched_rule: undefined,
      session_id: null,
    })
    const pending = approvalQueue.listPending()
    const ticketId = at(pending, 0).id

    const res = await post(`/api/approvals/${ticketId}/deny`, { denied_by: 'admin' })
    expect(res.status).toBe(401)
  })

  it('POST /api/approvals/:id/break-glass without auth returns 401', async () => {
    const { post, approvalRouter, approvalQueue } = setup({ apiSecret: 'test-secret' })
    void approvalRouter.submit({
      tool_name: 'test',
      tool_input: {},
      matched_rule: undefined,
      session_id: null,
    })
    const pending = approvalQueue.listPending()
    const ticketId = at(pending, 0).id

    const res = await post(`/api/approvals/${ticketId}/break-glass`, {
      approved_by: 'admin',
      reason: 'emergency',
    })
    expect(res.status).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// SPA serves index.html without embedding auth secret material.
// ---------------------------------------------------------------------------

describe('SPA static serving', () => {
  const tmpDirs: string[] = []

  afterEach(() => {
    for (const dir of tmpDirs) {
      rmSync(dir, { recursive: true, force: true })
    }
    tmpDirs.length = 0
  })

  function makeStaticDir(indexHtml: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'helio-spa-test-'))
    writeFileSync(join(dir, 'index.html'), indexHtml)
    tmpDirs.push(dir)
    return dir
  }

  function setupWithStatic(options: { apiSecret?: string; indexHtml: string }) {
    const staticDir = makeStaticDir(options.indexHtml)
    const auditStore = new AuditStore({
      path: ':memory:',
      retention: '90d',
      includeResponses: true,
      cleanupIntervalMs: 0,
    })
    const approvalQueue = new ApprovalQueue({ cleanupIntervalMs: 0 })
    const channels = new Map([['dashboard', new QueueChannel()]])
    const approvalRouter = new ApprovalRouter({
      defaultTimeoutMs: 300_000,
      defaultOnTimeout: 'deny',
      channels,
      queue: approvalQueue,
    })
    const rateLimiter = new RateLimiter({ cleanupIntervalMs: 0 })
    const spendLimiter = new SpendLimiter({ cleanupIntervalMs: 0 })
    const evidenceStore = new EvidenceStore({ cleanupIntervalMs: 0 })
    const eventBus = new DashboardEventBus()

    const app = createDashboardApp(
      {
        auditStore,
        approvalRouter,
        approvalQueue,
        rateLimiter,
        spendLimiter,
        evidenceStore,
        eventBus,
      },
      { apiSecret: options.apiSecret, staticDir },
    )

    cleanup.push(
      auditStore,
      approvalQueue,
      approvalRouter,
      rateLimiter,
      spendLimiter,
      evidenceStore,
      eventBus,
    )
    return app
  }

  it('does not embed window.__HELIO_TOKEN__ in HTML when apiSecret is set', async () => {
    const app = setupWithStatic({
      apiSecret: 'test-secret',
      indexHtml: '<!doctype html><html><head><title>t</title></head><body></body></html>',
    })

    const res = await app.request('/some-spa-route')
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).not.toContain('window.__HELIO_TOKEN__')
  })

  it('serves plain index.html when the browser hits GET / directly', async () => {
    const app = setupWithStatic({
      apiSecret: 'test-secret',
      indexHtml: '<!doctype html><html><head><title>t</title></head><body></body></html>',
    })

    const res = await app.request('/')
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).not.toContain('window.__HELIO_TOKEN__')
  })

  it('serves plain index.html when the browser hits GET /index.html directly', async () => {
    const app = setupWithStatic({
      apiSecret: 'test-secret',
      indexHtml: '<!doctype html><html><head><title>t</title></head><body></body></html>',
    })

    const res = await app.request('/index.html')
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).not.toContain('window.__HELIO_TOKEN__')
  })

  it('still serves plain html when apiSecret is undefined', async () => {
    const app = setupWithStatic({
      apiSecret: undefined,
      indexHtml: '<!doctype html><html><head><title>t</title></head><body></body></html>',
    })

    const res = await app.request('/some-spa-route')
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).not.toContain('window.__HELIO_TOKEN__')
  })

  it('serves HTML unchanged when index.html has no </head> tag', async () => {
    const app = setupWithStatic({
      apiSecret: 'test-secret',
      indexHtml: '<html><body>no head</body></html>',
    })

    const res = await app.request('/')
    const body = await res.text()
    expect(body).toContain('no head')
    expect(body).not.toContain('window.__HELIO_TOKEN__')
  })
})

// ---------------------------------------------------------------------------
// Unknown /api/* routes must return JSON 404, not fall through to the SPA
// catch-all. Without the /api/* guard, a GET to an unknown sideband endpoint
// would be served the dashboard HTML with status 200 — an API client probing
// the surface would then try to parse an HTML body as JSON and get a
// confusing error.
// ---------------------------------------------------------------------------

describe('unknown /api/* routes', () => {
  const tmpDirs: string[] = []

  afterEach(() => {
    for (const dir of tmpDirs) {
      rmSync(dir, { recursive: true, force: true })
    }
    tmpDirs.length = 0
  })

  function makeStaticDir(indexHtml: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'helio-api404-test-'))
    writeFileSync(join(dir, 'index.html'), indexHtml)
    tmpDirs.push(dir)
    return dir
  }

  function setupWithStatic(options: { apiSecret?: string; indexHtml: string }) {
    const staticDir = makeStaticDir(options.indexHtml)
    const auditStore = new AuditStore({
      path: ':memory:',
      retention: '90d',
      includeResponses: true,
      cleanupIntervalMs: 0,
    })
    const approvalQueue = new ApprovalQueue({ cleanupIntervalMs: 0 })
    const channels = new Map([['dashboard', new QueueChannel()]])
    const approvalRouter = new ApprovalRouter({
      defaultTimeoutMs: 300_000,
      defaultOnTimeout: 'deny',
      channels,
      queue: approvalQueue,
    })
    const rateLimiter = new RateLimiter({ cleanupIntervalMs: 0 })
    const spendLimiter = new SpendLimiter({ cleanupIntervalMs: 0 })
    const evidenceStore = new EvidenceStore({ cleanupIntervalMs: 0 })
    const eventBus = new DashboardEventBus()

    const app = createDashboardApp(
      {
        auditStore,
        approvalRouter,
        approvalQueue,
        rateLimiter,
        spendLimiter,
        evidenceStore,
        eventBus,
      },
      { apiSecret: options.apiSecret, staticDir },
    )

    cleanup.push(
      auditStore,
      approvalQueue,
      approvalRouter,
      rateLimiter,
      spendLimiter,
      evidenceStore,
      eventBus,
    )
    return app
  }

  const INDEX_HTML = '<!doctype html><html><head><title>t</title></head><body></body></html>'

  it('GET /api/does-not-exist returns 404 JSON, not the SPA HTML', async () => {
    const app = setupWithStatic({ apiSecret: undefined, indexHtml: INDEX_HTML })

    const res = await app.request('/api/does-not-exist')

    expect(res.status).toBe(404)
    expect(res.headers.get('content-type') ?? '').toContain('application/json')
    const body = (await res.json()) as Record<string, unknown>
    expect(body.error).toBeDefined()
  })

  it('POST /api/does-not-exist returns 404 JSON', async () => {
    const app = setupWithStatic({ apiSecret: undefined, indexHtml: INDEX_HTML })

    const res = await app.request('/api/does-not-exist', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })

    expect(res.status).toBe(404)
    expect(res.headers.get('content-type') ?? '').toContain('application/json')
  })

  it('valid React Router route still falls through to the SPA HTML', async () => {
    // Regression: the /api/* 404 guard must not swallow non-api paths. React
    // Router routes like /audit/<id> still need to resolve to index.html.
    const app = setupWithStatic({ apiSecret: undefined, indexHtml: INDEX_HTML })

    const res = await app.request('/audit/abc123')

    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('<title>t</title>')
  })

  it('unknown /api/* path with bearer auth still returns 404 JSON', async () => {
    // Regression: the guard must sit after the /api/* bearer middleware, so
    // an unauthenticated unknown path still 401s; but an AUTHENTICATED
    // unknown path gets the JSON 404 rather than the SPA HTML.
    const app = setupWithStatic({ apiSecret: 'test-secret', indexHtml: INDEX_HTML })

    const res = await app.request('/api/does-not-exist', {
      headers: { authorization: 'Bearer test-secret' },
    })

    expect(res.status).toBe(404)
    expect(res.headers.get('content-type') ?? '').toContain('application/json')
  })
})

// ---------------------------------------------------------------------------
// Unhandled errors
// ---------------------------------------------------------------------------

describe('unhandled errors', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns the JSON error shape when a handler throws', async () => {
    const { auditStore, get } = setup()
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(auditStore, 'list').mockImplementation(() => {
      throw new Error('sqlite exploded')
    })

    const res = await get('/api/feed')

    expect(res.status).toBe(500)
    expect(res.headers.get('content-type') ?? '').toContain('application/json')
    expect(await res.json()).toEqual({ error: 'Internal server error' })
    expect(errSpy).toHaveBeenCalledWith('[helio] Unhandled dashboard API error:', expect.any(Error))
  })

  it('lets an HTTPException keep its intended response', async () => {
    const { auditStore, get } = setup()
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(auditStore, 'list').mockImplementation(() => {
      throw new HTTPException(418, { message: 'teapot' })
    })

    const res = await get('/api/feed')

    expect(res.status).toBe(418)
    expect(errSpy).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// CORS origin validation
// ---------------------------------------------------------------------------

describe('CORS origin validation', () => {
  // Origins that MUST be admitted: loopback plus genuine private-network IPv4
  // literals (Docker bridge, LAN).
  const allowed = [
    'http://localhost:5173',
    'http://127.0.0.1:3100',
    'http://192.168.1.20',
    'http://10.0.0.5',
    'http://172.16.0.1',
    'http://172.31.255.254',
  ]

  // Origins that MUST be rejected. The first four are the attack: public DNS
  // names whose hostname merely starts with a private-range prefix. The rest
  // are out-of-range or malformed addresses.
  const rejected = [
    'http://192.168.attacker.com',
    'http://10.evil.io',
    'http://172.16.pwn.example',
    'http://192.168.1.1.nip.io',
    'http://172.15.0.1',
    'http://172.32.0.1',
    'http://999.1.1.1',
    'https://evil.example.com',
  ]

  for (const origin of allowed) {
    it(`admits ${origin}`, async () => {
      const { get } = setup()
      const res = await get('/api/health', { origin })
      expect(res.headers.get('access-control-allow-origin')).toBe(origin)
    })
  }

  for (const origin of rejected) {
    it(`rejects ${origin}`, async () => {
      const { get } = setup()
      const res = await get('/api/health', { origin })
      expect(res.headers.get('access-control-allow-origin')).toBeNull()
    })
  }
})

describe('CORS origin validation — secure mode', () => {
  const SECRET = 'secure-mode-cors-secret'

  it('admits a private origin via CORS but still 401s without a credential', async () => {
    const { get } = setup({ apiSecret: SECRET })
    const res = await get('/api/feed', { origin: 'http://192.168.1.20' })
    expect(res.status).toBe(401)
    // CORS admits the origin, but the auth layer is the real gate.
    expect(res.headers.get('access-control-allow-origin')).toBe('http://192.168.1.20')
    // No credentials header, so a browser fetch cannot attach cookies.
    expect(res.headers.get('access-control-allow-credentials')).toBeNull()
  })

  it('rejects a spoofed origin and still 401s without a credential', async () => {
    const { get } = setup({ apiSecret: SECRET })
    const res = await get('/api/feed', { origin: 'http://192.168.attacker.com' })
    expect(res.status).toBe(401)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('issues the session cookie with SameSite=Lax', async () => {
    const { post } = setup({ apiSecret: SECRET })
    const res = await post('/api/auth/session', { secret: SECRET })
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie') ?? '').toMatch(/SameSite=Lax/i)
  })
})

describe('CORS origin validation — hostname normalization', () => {
  // The URL parser normalizes these numeric/octal forms to private IPv4
  // literals, so they are admitted. A browser only emits such an origin if the
  // page was actually served from that address (not an attacker-controlled DNS
  // name), so this is not a bypass — pinned here to keep the behavior stable.
  const admittedByNormalization = [
    'http://0x7f000001', // -> 127.0.0.1
    'http://3232235521', // -> 192.168.0.1
    'http://0300.0250.0.1', // -> 192.168.0.1
    'http://192.168.1.1.', // trailing dot -> 192.168.1.1
  ]

  const rejectedForms = [
    'http://192.168.1.1%2f@evil.com', // real host is evil.com
    'http://xn--bcher-kva.example', // punycode hostname, not an IP
    'http://[::1]', // IPv6 loopback is not in the allowlist
    'http://010.0.0.1', // octal -> 8.0.0.1, a public address
  ]

  for (const origin of admittedByNormalization) {
    it(`admits normalized private literal ${origin}`, async () => {
      const { get } = setup()
      const res = await get('/api/health', { origin })
      expect(res.headers.get('access-control-allow-origin')).toBe(origin)
    })
  }

  for (const origin of rejectedForms) {
    it(`rejects ${origin}`, async () => {
      const { get } = setup()
      const res = await get('/api/health', { origin })
      expect(res.headers.get('access-control-allow-origin')).toBeNull()
    })
  }
})
