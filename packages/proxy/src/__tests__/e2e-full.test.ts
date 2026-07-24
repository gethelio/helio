/**
 * Comprehensive End-to-End Integration Test
 *
 * Exercises the complete Helio MVP feature set in a single scenario:
 * mock MCP server → proxy with all components → audit, evidence,
 * approvals, rate limits, spend limits, dry-run, dashboard API, SSE.
 *
 * This is the gold standard. If it passes, the MVP works.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startHttpMcpServer } from './helpers/mcp-test-server.js'
import { startOnDynamicPort, makeConfig, sendMcpRequest } from './helpers/test-utils.js'
import type { ManagedServer } from './helpers/test-utils.js'
import { parseDuration } from '../config/index.js'
import type { PoliciesConfig } from '../config/index.js'
import { createApp } from '../server.js'
import { StreamableHttpForwarder } from '../upstream/streamable-http-forwarder.js'
import { compilePolicies } from '../policy/index.js'
import { GovernedForwarder } from '../policy/governed-forwarder.js'
import { AuditStore, AuditWriter } from '../audit/index.js'
import { EvidenceStore, createSidebandApp } from '../evidence/index.js'
import { ApprovalQueue, ApprovalRouter, createChannels } from '../approval/index.js'
import { RateLimiter } from '../policy/index.js'
import { SpendLimiter } from '../policy/index.js'
import { BudgetEngine } from '../budget/engine.js'
import { compileBudgets } from '../budget/parser.js'
import { GovernanceService } from '../sideband/governance-service.js'
import { createDashboardApp, DashboardEventBus } from '../dashboard/index.js'
import type { DashboardEventType, DashboardEvents } from '../dashboard/index.js'

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let upstream: { port: number; close: () => Promise<void> }
let proxyManaged: ManagedServer
let sidebandManaged: ManagedServer
let dashboardManaged: ManagedServer

let proxyUrl: string
let sidebandUrl: string
let dashboardUrl: string

let auditStore: AuditStore
let auditWriter: AuditWriter
let approvalQueue: ApprovalQueue
let approvalRouter: ApprovalRouter
let rateLimiter: RateLimiter
let spendLimiter: SpendLimiter
let budgetEngine: BudgetEngine
let governanceService: GovernanceService
let evidenceStore: EvidenceStore
let eventBus: DashboardEventBus
let unsubscribeEvents: () => void

const collectedEvents: { type: DashboardEventType; data: DashboardEvents[DashboardEventType] }[] =
  []

// ---------------------------------------------------------------------------
// Policy configuration — 8 rules covering every action type
// ---------------------------------------------------------------------------

const policiesConfig: PoliciesConfig = {
  default: 'deny' as const,
  flag_destructive: 'log' as const,
  dry_run: false,
  rules: [
    // 0: Rate-limited weather (specific input match — must be before allow-weather)
    {
      name: 'rate-limit-weather',
      match: { tool: 'get_weather', input: { '$.city': { eq: 'RateLimitCity' } } },
      action: 'rate_limit' as const,
      limits: { max_calls: 2, window: '60s' },
    },
    // 1: Allow weather (general match)
    {
      name: 'allow-weather',
      match: { tool: 'get_weather' },
      action: 'allow' as const,
    },
    // 2: Deny email
    {
      name: 'deny-email',
      match: { tool: 'send_email' },
      action: 'deny' as const,
      feedback: { message: 'Emails are blocked' },
    },
    // 3: Allow order lookup
    {
      name: 'allow-lookup',
      match: { tool: 'lookup_order' },
      action: 'allow' as const,
    },
    // 3b: Allowed probe tool for the named-budget flow (issue #14) — the
    // budget gate, not the rule, is what constrains it.
    {
      name: 'allow-budgeted-probe',
      match: { tool: 'budgeted_*' },
      action: 'allow' as const,
    },
    // 3c: Allowed probe for the break-glass flow (issue #14, PR 3) — the
    // budget below flips it into a merged native ticket on the sideband.
    {
      name: 'allow-glass-probe',
      match: { tool: 'glass_*' },
      action: 'allow' as const,
    },
    // 4: Spend-limited payment (amount >= 1000 — must be before evidence-gated payment)
    {
      name: 'spend-limit-payment',
      match: { tool: 'create_payment', input: { '$.amount': { gte: 1000 } } },
      action: 'spend_limit' as const,
      limits: {
        max_spend: { field: 'amount', limit: 5000, currency: 'USD', window: '1h' },
      },
    },
    // 5: Evidence-gated payment (smaller amounts)
    {
      name: 'payment-needs-evidence',
      match: { tool: 'create_payment' },
      action: 'allow' as const,
      evidence: { requires: ['orders.lookup'] },
    },
    // 6: Approval-gated transfer
    {
      name: 'approve-transfer',
      match: { tool: 'transfer_funds' },
      action: 'require_approval' as const,
      approval: { channel: 'dashboard', timeout: '1s' },
    },
    // 7: Dry-run delete (specific input match — other IDs fall through to default deny)
    {
      name: 'dry-run-delete',
      match: { tool: 'delete_record', input: { '$.id': { eq: 'dry-run-test' } } },
      action: 'dry_run' as const,
    },
  ],
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // 1. Start mock upstream MCP server (6 tools)
  upstream = await startHttpMcpServer()
  const upstreamUrl = `http://127.0.0.1:${String(upstream.port)}/mcp`

  // 2. Event bus — collect events for SSE assertions
  eventBus = new DashboardEventBus()
  unsubscribeEvents = eventBus.onAny((type, data) => {
    collectedEvents.push({ type, data })
  })

  // 3. Audit store + writer
  auditStore = new AuditStore({
    path: ':memory:',
    retention: '90d',
    includeResponses: true,
    cleanupIntervalMs: 0,
  })
  auditWriter = new AuditWriter({
    store: auditStore,
    flushIntervalMs: 0,
    onPersist: (record, id) => {
      eventBus.emit('action', {
        id,
        tool_name: record.tool_name,
        policy_decision: record.policy_decision,
        block_reason: record.block_reason,
        approval_status: record.approval_status,
        session_id: record.session_id,
        agent_id: record.agent_id,
        environment: record.environment,
        timestamp: record.timestamp,
        total_duration_ms: record.total_duration_ms,
        approval_wait_ms: record.approval_wait_ms,
        proxy_compute_ms: record.proxy_compute_ms,
        flagged_destructive: record.flagged_destructive,
        dry_run: record.dry_run,
        matched_rule: record.matched_rule,
        matched_rule_index: record.matched_rule_index,
        record_kind: record.record_kind,
        origin: record.origin,
      })
    },
  })

  // 4. Evidence store
  evidenceStore = new EvidenceStore({ cleanupIntervalMs: 0 })

  // 5. Approval queue + router
  approvalQueue = new ApprovalQueue({ cleanupIntervalMs: 0 })
  const channels = createChannels([])
  approvalRouter = new ApprovalRouter({
    defaultTimeoutMs: parseDuration('1s'),
    defaultOnTimeout: 'deny',
    channels,
    queue: approvalQueue,
    onSubmit: (ticket) => {
      eventBus.emit('approval_requested', {
        ticket_id: ticket.id,
        tool_name: ticket.tool_name,
        channel: ticket.channel_name,
        requested_at: ticket.requested_at,
      })
    },
    onResolve: (ticket) => {
      eventBus.emit('approval_resolved', {
        ticket_id: ticket.id,
        status: ticket.status,
        resolved_by: ticket.resolved_by,
        resolved_at: ticket.resolved_at ?? new Date().toISOString(),
      })
    },
  })

  // 6. Rate + spend limiters
  rateLimiter = new RateLimiter({
    cleanupIntervalMs: 0,
    onWarning: (state) => {
      eventBus.emit('limit_warning', {
        key: state.key,
        type: 'rate',
        current: state.current,
        limit: state.limit,
        utilization: state.current / state.limit,
      })
    },
  })
  spendLimiter = new SpendLimiter({
    cleanupIntervalMs: 0,
    onWarning: (state) => {
      eventBus.emit('limit_warning', {
        key: state.key,
        type: 'spend',
        current: state.current_spend,
        limit: state.limit,
        utilization: state.current_spend / state.limit,
      })
    },
  })

  // 7. Compile policies + create governed forwarder (budgets: issue #14)
  const { policy } = compilePolicies(policiesConfig)
  budgetEngine = new BudgetEngine({
    budgets: compileBudgets([
      {
        name: 'e2e-cap',
        limit: 100,
        currency: 'USD',
        window: '24h',
        key: 'global',
        on_exceed: 'deny',
        contributors: [{ match: { tool: 'budgeted_*' }, field: '$.amount' }],
      },
      {
        name: 'e2e-glass',
        limit: 10,
        currency: 'USD',
        window: '24h',
        key: 'global',
        on_exceed: 'require_approval',
        contributors: [{ match: { tool: 'glass_*' }, field: '$.amount' }],
      },
    ]),
    cleanupIntervalMs: 0,
  })
  const rawForwarder = new StreamableHttpForwarder({ url: upstreamUrl })
  const governed = new GovernedForwarder(rawForwarder, policy, {
    auditWriter,
    evidenceStore,
    approvalRouter,
    rateLimiter,
    spendLimiter,
    budgetEngine,
  })

  // 8. Build config for createApp
  const config = makeConfig({
    upstream: { url: upstreamUrl, transport: 'streamable-http' },
    policies: policiesConfig,
    approval: { timeout: '1s', default_on_timeout: 'deny' },
    audit: { path: ':memory:' },
    sdk: { enabled: true },
  })

  // 9. Create and start proxy server
  const app = createApp(config, governed)
  proxyManaged = startOnDynamicPort(app)
  proxyUrl = `http://127.0.0.1:${String(proxyManaged.port)}/mcp`

  // 10. Start sideband server (evidence API + governance endpoints)
  governanceService = new GovernanceService({
    policy,
    evidenceStore,
    approvalRouter,
    rateLimiter,
    spendLimiter,
    budgetEngine,
    auditWriter,
    sweepIntervalMs: 0,
  })
  const sidebandApp = createSidebandApp(evidenceStore, { governance: governanceService })
  sidebandManaged = startOnDynamicPort(sidebandApp)
  sidebandUrl = `http://127.0.0.1:${String(sidebandManaged.port)}`

  // 11. Start dashboard API server
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
    { staticDir: undefined },
  )
  dashboardManaged = startOnDynamicPort(dashboardApp)
  dashboardUrl = `http://127.0.0.1:${String(dashboardManaged.port)}`
})

afterAll(async () => {
  unsubscribeEvents()
  eventBus.close()
  approvalRouter.close()
  approvalQueue.close()
  rateLimiter.close()
  spendLimiter.close()
  governanceService.close()
  budgetEngine.close()
  evidenceStore.close()
  auditWriter.close() // also closes auditStore internally
  await dashboardManaged.close()
  await sidebandManaged.close()
  await proxyManaged.close()
  await upstream.close()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the structured feedback `data` payload from a JSON-RPC error response. */
function getErrorData(body: Record<string, unknown>): Record<string, unknown> {
  const err = body['error'] as Record<string, unknown>
  return err['data'] as Record<string, unknown>
}

/** Extract the first text content from a successful JSON-RPC tool call response. */
function getResultText(body: Record<string, unknown>): string {
  const result = body['result'] as Record<string, unknown>
  const content = result['content'] as { type: string; text: string }[]
  return content[0]?.text ?? ''
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('E2E: full MVP integration', () => {
  // Tests share mutable state (audit store, rate/spend limiters, evidence store,
  // approval queue, event collector) and MUST run in sequential order.

  // --- Priming ---

  it('tools/list returns all 6 tools and primes annotation cache', async () => {
    const { status, body } = await sendMcpRequest(proxyUrl, 'tools/list')
    expect(status).toBe(200)

    const result = body['result'] as { tools: { name: string }[] }
    const names = result.tools.map((t) => t.name).sort()
    expect(names).toEqual([
      'create_payment',
      'delete_record',
      'get_weather',
      'lookup_order',
      'send_email',
      'transfer_funds',
    ])
  })

  // --- 3a: Allowed read-only call ---

  it('allowed read-only call passes through and produces audit record', async () => {
    const { status, body } = await sendMcpRequest(
      proxyUrl,
      'tools/call',
      { name: 'get_weather', arguments: { city: 'London' } },
      1,
      { sessionId: 'e2e-session-1' },
    )
    expect(status).toBe(200)
    expect(getResultText(body)).toBe('Sunny, 22°C in London')

    auditWriter.flush()
    const { records } = auditStore.list({ tool_name: 'get_weather' })
    const rec = records.find((r) => r.matched_rule === 'allow-weather')
    expect(rec).toBeDefined()
    expect(rec?.policy_decision).toBe('allow')
    expect(rec?.flagged_destructive).toBe(false)
    expect(rec?.upstream_response).not.toBeNull()
    expect(rec?.upstream_latency_ms).toBeGreaterThan(0)
    expect(rec?.session_id).toBe('e2e-session-1')
  })

  // --- 3b: Denied call ---

  it('denied call returns structured feedback and audit record', async () => {
    const { status, body } = await sendMcpRequest(proxyUrl, 'tools/call', {
      name: 'send_email',
      arguments: { to: 'a@b.com', body: 'hi' },
    })
    expect(status).toBe(200)

    const err = body['error'] as Record<string, unknown>
    expect(err['code']).toBe(-32001)

    const data = getErrorData(body)
    expect(data['blocked']).toBe(true)
    expect(data['reason']).toBe('policy_denied')
    expect(data['retry_allowed']).toBe(false)

    auditWriter.flush()
    const { records } = auditStore.list({ policy_decision: 'deny' })
    const rec = records.find((r) => r.matched_rule === 'deny-email')
    expect(rec).toBeDefined()
    expect(rec?.tool_name).toBe('send_email')
    expect(rec?.upstream_response).toBeNull()
  })

  // --- 3c: Dry-run call ---

  it('dry-run returns synthetic response without contacting upstream', async () => {
    const { status, body } = await sendMcpRequest(proxyUrl, 'tools/call', {
      name: 'delete_record',
      arguments: { id: 'dry-run-test' },
    })
    expect(status).toBe(200)
    expect(body['error']).toBeUndefined()

    const text = getResultText(body)
    const payload = JSON.parse(text) as Record<string, unknown>
    expect(payload['dry_run']).toBe(true)
    expect(payload['would_forward']).toBe(false)
    expect(payload['matched_rule']).toBe('dry-run-delete')

    auditWriter.flush()
    const { records } = auditStore.list({ dry_run: true })
    const rec = records.find((r) => r.matched_rule === 'dry-run-delete')
    expect(rec).toBeDefined()
    expect(rec?.policy_decision).toBe('dry_run')
    expect(rec?.upstream_response).toBeNull()
    expect(rec?.flagged_destructive).toBe(false)
  })

  // --- 3d: Destructive tool flagging ---

  it('unmatched destructive tool is flagged in audit', async () => {
    const { status, body } = await sendMcpRequest(proxyUrl, 'tools/call', {
      name: 'delete_record',
      arguments: { id: 'real-delete' },
    })
    expect(status).toBe(200)

    const err = body['error'] as Record<string, unknown>
    expect(err['code']).toBe(-32001)

    auditWriter.flush()
    const { records } = auditStore.list({ flagged_destructive: true })
    expect(records.length).toBeGreaterThanOrEqual(1)
    const rec = records.find((r) => r.tool_name === 'delete_record' && r.matched_rule === null)
    expect(rec).toBeDefined()
    expect(rec?.policy_decision).toBe('deny')
    expect(rec?.flagged_destructive).toBe(true)
  })

  // --- 4a: Evidence missing ---

  it('evidence-gated call without evidence returns self-repair feedback', async () => {
    const { body } = await sendMcpRequest(
      proxyUrl,
      'tools/call',
      { name: 'create_payment', arguments: { amount: 50, currency: 'EUR' } },
      1,
      { sessionId: 'e2e-session-1' },
    )

    const data = getErrorData(body)
    expect(data['reason']).toBe('evidence_missing')
    expect(data['missing_evidence']).toEqual(['orders.lookup'])
    expect(data['retry_allowed']).toBe(true)
    expect(String(data['suggestion'])).toContain('orders.lookup')
  })

  // --- 4b: Mark evidence via sideband + retry ---

  it('marks evidence via sideband then evidence-gated call succeeds', async () => {
    // Mark evidence via sideband HTTP API
    const evidenceRes = await fetch(`${sidebandUrl}/evidence`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        session_id: 'e2e-session-1',
        tool_name: 'lookup_order',
        evidence_key: 'orders.lookup',
        evidence_data: { orderId: 'ORD-42', total: 99.99 },
      }),
    })
    expect(evidenceRes.status).toBe(201)

    // Retry the same call — should succeed now
    const { status, body } = await sendMcpRequest(
      proxyUrl,
      'tools/call',
      { name: 'create_payment', arguments: { amount: 50, currency: 'EUR' } },
      1,
      { sessionId: 'e2e-session-1' },
    )
    expect(status).toBe(200)
    expect(getResultText(body)).toBe('Payment of 50 EUR created')

    auditWriter.flush()
    const { records } = auditStore.list({ tool_name: 'create_payment' })
    const allowed = records.find((r) => r.policy_decision === 'allow')
    expect(allowed).toBeDefined()
    expect(allowed?.evidence_chain).not.toBeNull()
  })

  // --- 5a: Approval — approve ---

  it('approval-gated call holds until approved via REST API', async () => {
    const callPromise = sendMcpRequest(proxyUrl, 'tools/call', {
      name: 'transfer_funds',
      arguments: { amount: 100, currency: 'USD', to_account: 'acct-1' },
    })

    // Wait for the HTTP request to reach the proxy and create the ticket.
    // The ticket is created synchronously inside ApprovalRouter.submit(),
    // so 100ms is sufficient for the HTTP round-trip. A polling loop would
    // be more robust but adds complexity for minimal gain in a sequential test.
    await new Promise((r) => setTimeout(r, 100))
    const pending = approvalQueue.listPending()
    expect(pending.length).toBeGreaterThanOrEqual(1)
    const ticketId = pending[0]?.id ?? ''

    // Approve via REST API on the dashboard sideband (/approvals is no
    // longer mounted on the main proxy port)
    const approveRes = await fetch(`${dashboardUrl}/api/approvals/${ticketId}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approved_by: 'admin' }),
    })
    expect(approveRes.status).toBe(200)

    // Original call should resolve with success
    const { status, body } = await callPromise
    expect(status).toBe(200)
    expect(getResultText(body)).toBe('Transfer of 100 USD to acct-1 completed')

    auditWriter.flush()
    const { records } = auditStore.list({ tool_name: 'transfer_funds' })
    const rec = records.find((r) => r.approval_status === 'approved')
    expect(rec).toBeDefined()
    expect(rec?.policy_decision).toBe('require_approval')
    expect(rec?.approved_by).toBe('admin')
    expect(rec?.upstream_response).not.toBeNull()
  })

  // --- trust boundary — main MCP port does not serve /approvals ---

  it('POST /approvals/:id/approve on the main MCP port returns 404', async () => {
    const proxyBaseUrl = proxyUrl.replace(/\/mcp$/, '')
    const res = await fetch(`${proxyBaseUrl}/approvals/any-ticket/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approved_by: 'attacker' }),
    })
    expect(res.status).toBe(404)
  })

  // --- 5b: Approval — deny ---

  it('approval-gated call denied returns feedback', async () => {
    const callPromise = sendMcpRequest(proxyUrl, 'tools/call', {
      name: 'transfer_funds',
      arguments: { amount: 200, currency: 'USD', to_account: 'acct-2' },
    })

    await new Promise((r) => setTimeout(r, 100))
    const pending = approvalQueue.listPending()
    expect(pending.length).toBeGreaterThanOrEqual(1)
    const ticketId = pending[0]?.id ?? ''

    const denyRes = await fetch(`${dashboardUrl}/api/approvals/${ticketId}/deny`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ denied_by: 'reviewer', reason: 'Not authorized' }),
    })
    expect(denyRes.status).toBe(200)

    const { body } = await callPromise
    const data = getErrorData(body)
    expect(data['reason']).toBe('approval_denied')
    expect(data['denied_by']).toBe('reviewer')

    auditWriter.flush()
    const { records } = auditStore.list({ tool_name: 'transfer_funds' })
    const rec = records.find((r) => r.approval_status === 'denied')
    expect(rec).toBeDefined()
  })

  // --- 5c: Approval — timeout ---

  it('approval-gated call times out and is denied by default', { timeout: 5000 }, async () => {
    const { body } = await sendMcpRequest(proxyUrl, 'tools/call', {
      name: 'transfer_funds',
      arguments: { amount: 300, currency: 'USD', to_account: 'acct-3' },
    })

    const data = getErrorData(body)
    expect(data['reason']).toBe('approval_timeout')
    expect(data['timeout_seconds']).toBe(1)

    auditWriter.flush()
    const { records } = auditStore.list({ tool_name: 'transfer_funds' })
    const rec = records.find((r) => r.approval_status === 'timeout')
    expect(rec).toBeDefined()
  })

  // --- 6a: Rate limit exceeded ---

  it('rate-limited call blocks after threshold with reset time', async () => {
    // First two calls succeed (limit is 2)
    for (let i = 0; i < 2; i++) {
      const { body } = await sendMcpRequest(proxyUrl, 'tools/call', {
        name: 'get_weather',
        arguments: { city: 'RateLimitCity' },
      })
      expect(body['error']).toBeUndefined()
    }

    // Third call is blocked
    const { body } = await sendMcpRequest(proxyUrl, 'tools/call', {
      name: 'get_weather',
      arguments: { city: 'RateLimitCity' },
    })

    const data = getErrorData(body)
    expect(data['reason']).toBe('rate_limited')
    expect(data['current_calls']).toBe(2)
    expect(data['max_calls']).toBe(2)
    expect(data['reset_at']).toBeDefined()

    auditWriter.flush()
    const { records } = auditStore.list({ policy_decision: 'rate_limit' })
    expect(records.length).toBeGreaterThanOrEqual(1)
  })

  // --- 6b: Spend limit exceeded ---

  it('spend-limited call blocks when cumulative spend exceeds limit', async () => {
    // First call succeeds (3000 < 5000 limit)
    const { body: first } = await sendMcpRequest(proxyUrl, 'tools/call', {
      name: 'create_payment',
      arguments: { amount: 3000, currency: 'USD' },
    })
    expect(first['error']).toBeUndefined()

    // Second call is blocked (cumulative 6000 > 5000)
    const { body: second } = await sendMcpRequest(proxyUrl, 'tools/call', {
      name: 'create_payment',
      arguments: { amount: 3000, currency: 'USD' },
    })

    const data = getErrorData(second)
    expect(data['reason']).toBe('spend_limited')
    expect(data['current_spend']).toBe(3000)
    expect(data['max_spend']).toBe(5000)

    auditWriter.flush()
    const { records } = auditStore.list({ policy_decision: 'spend_limit' })
    expect(records.length).toBeGreaterThanOrEqual(1)
  })

  // --- 7: Dashboard API verification ---

  it('dashboard health API returns status', async () => {
    const res = await fetch(`${dashboardUrl}/api/health`)
    expect(res.status).toBe(200)
    const json = (await res.json()) as Record<string, unknown>
    expect(json['status']).toBe('ok')
  })

  it('dashboard feed API returns records', async () => {
    const res = await fetch(`${dashboardUrl}/api/feed`)
    expect(res.status).toBe(200)
    const json = (await res.json()) as { data: unknown[]; total: number }
    expect(json.total).toBeGreaterThan(0)
    expect(json.data.length).toBeGreaterThan(0)
  })

  it('dashboard audit API filters work', async () => {
    // Filter by tool name
    const weatherRes = await fetch(`${dashboardUrl}/api/audit?tool=get_weather`)
    const weather = (await weatherRes.json()) as { data: { tool_name: string }[] }
    expect(weather.data.length).toBeGreaterThan(0)
    expect(weather.data.every((r) => r.tool_name.includes('get_weather'))).toBe(true)

    // Filter by decision
    const denyRes = await fetch(`${dashboardUrl}/api/audit?decision=deny`)
    const deny = (await denyRes.json()) as { data: { policy_decision: string }[] }
    expect(deny.data.length).toBeGreaterThan(0)
    expect(deny.data.every((r) => r.policy_decision === 'deny')).toBe(true)
  })

  it('dashboard approvals API returns resolved tickets', async () => {
    const res = await fetch(`${dashboardUrl}/api/approvals`)
    expect(res.status).toBe(200)
    const json = (await res.json()) as { data: { status: string }[] }
    // We had 3 approval scenarios: approved, denied, timeout
    expect(json.data.length).toBeGreaterThanOrEqual(3)
    const statuses = json.data.map((t) => t.status)
    expect(statuses).toContain('approved')
    expect(statuses).toContain('denied')
    expect(statuses).toContain('timeout')
  })

  it('dashboard limits API shows rate and spend state', async () => {
    const res = await fetch(`${dashboardUrl}/api/limits`)
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      rate_limits: unknown[]
      spend_limits: unknown[]
    }
    expect(json.rate_limits.length).toBeGreaterThan(0)
    expect(json.spend_limits.length).toBeGreaterThan(0)
  })

  it('dashboard analytics API returns aggregate stats', async () => {
    const res = await fetch(`${dashboardUrl}/api/analytics`)
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      total: number
      by_decision: { decision: string }[]
    }
    expect(json.total).toBeGreaterThan(0)
    const decisions = json.by_decision.map((d) => d.decision)
    expect(decisions).toContain('allow')
    expect(decisions).toContain('deny')
  })

  it('dashboard evidence API returns session state', async () => {
    const res = await fetch(`${dashboardUrl}/api/evidence/e2e-session-1`)
    expect(res.status).toBe(200)
    const json = (await res.json()) as { data: { evidence: Record<string, unknown> } }
    expect(json.data.evidence).toHaveProperty('orders.lookup')
  })

  // --- SSE events verification ---

  it('SSE events were emitted for all actions', () => {
    const actionEvents = collectedEvents.filter((e) => e.type === 'action')
    const approvalRequested = collectedEvents.filter((e) => e.type === 'approval_requested')
    const approvalResolved = collectedEvents.filter((e) => e.type === 'approval_resolved')

    // 14 tool calls: allow(1) + deny(1) + dry-run(1) + destructive(1) +
    // evidence-miss(1) + evidence-hit(1) + approve(1) + deny(1) + timeout(1) +
    // rate-limit(3) + spend-limit(2)
    expect(actionEvents.length).toBe(14)

    // 3 approval scenarios submitted: approve + deny + timeout all emit
    // approval_resolved for dashboard parity.
    expect(approvalRequested.length).toBe(3)
    expect(approvalResolved.length).toBe(3)

    // Verify sample action event shape
    const sample = actionEvents[0]
    expect(sample).toBeDefined()
    const data = sample?.data as unknown as Record<string, unknown>
    expect(data).toHaveProperty('id')
    expect(data).toHaveProperty('tool_name')
    expect(data).toHaveProperty('policy_decision')
    expect(data).toHaveProperty('timestamp')
  })

  it('dashboard SSE endpoint returns event-stream content type', async () => {
    const controller = new AbortController()
    const res = await fetch(`${dashboardUrl}/api/events`, {
      signal: controller.signal,
    })
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    controller.abort()
  })

  // --- 8: Shutdown-cancelled approval attribution ---

  it('shutdown with pending approval returns shutdown_cancelled and writes distinct audit fields', async () => {
    const sessionId = 'e2e-shutdown-cancelled'
    const callPromise = sendMcpRequest(
      proxyUrl,
      'tools/call',
      {
        name: 'transfer_funds',
        arguments: { amount: 333, currency: 'USD', to_account: 'acct-shutdown' },
      },
      8099,
      { sessionId },
    )

    await new Promise((r) => setTimeout(r, 100))
    const pending = approvalQueue.listPending()
    expect(pending.length).toBeGreaterThanOrEqual(1)

    approvalRouter.close()

    const { body } = await callPromise
    const data = getErrorData(body)
    expect(data['reason']).toBe('shutdown_cancelled')

    auditWriter.flush()
    const { records } = auditStore.list({ session_id: sessionId, tool_name: 'transfer_funds' })
    expect(records.length).toBeGreaterThanOrEqual(1)
    const rec = records[0]
    expect(rec).toBeDefined()
    expect(rec?.approval_status).toBe('shutdown_cancelled')
    expect(rec?.block_reason).toBe('shutdown_cancelled')
  })

  // --- Audit record completeness ---

  it('all audit records have correct required fields', () => {
    auditWriter.flush()
    const { records, total } = auditStore.list({}, { limit: 100 })
    // We made at least 15 tool calls across all scenarios
    expect(total).toBeGreaterThanOrEqual(13)

    for (const rec of records) {
      expect(rec.id).toBeDefined()
      expect(rec.timestamp).toBeDefined()
      expect(rec.tool_name).toBeDefined()
      expect(rec.policy_decision).toBeDefined()
      expect(rec.total_duration_ms).toBeGreaterThanOrEqual(0)
      expect(rec.approval_wait_ms).toBeGreaterThanOrEqual(0)
      expect(rec.proxy_compute_ms).toBeGreaterThanOrEqual(0)
      expect(rec.created_at).toBeDefined()
    }
  })

  // --- Named budgets (issue #14) ---

  it('depletes the cross-tool budget over HTTP and then denies with feedback', async () => {
    // First call consumes 60 of the 100 pot.
    const first = await sendMcpRequest(
      proxyUrl,
      'tools/call',
      { name: 'budgeted_probe', arguments: { amount: 60 } },
      70,
    )
    expect((first.body as { error?: unknown }).error).toBeUndefined()

    // Second call would exceed: denied with budget feedback, nothing recorded.
    const denied = await sendMcpRequest(
      proxyUrl,
      'tools/call',
      { name: 'budgeted_probe', arguments: { amount: 50 } },
      71,
    )
    const data = getErrorData(denied.body)
    expect(data['reason']).toBe('budget_exceeded')
    const budgets = data['budgets'] as Array<Record<string, unknown>>
    expect(budgets[0]?.['name']).toBe('e2e-cap')
    expect(budgets[0]?.['remaining']).toBe(40)

    // A call within the remainder still forwards.
    const third = await sendMcpRequest(
      proxyUrl,
      'tools/call',
      { name: 'budgeted_probe', arguments: { amount: 40 } },
      72,
    )
    expect((third.body as { error?: unknown }).error).toBeUndefined()

    // The denial is on the audit trail with the budget chain.
    auditWriter.flush()
    const rec = auditStore
      .list({ tool_name: 'budgeted_probe' })
      .records.find((r) => r.block_reason === 'budget_exceeded')
    expect(rec).toBeDefined()
    const chain = rec?.evidence_chain as Record<string, unknown>
    expect((chain['budgets'] as Array<Record<string, unknown>>)[0]?.['name']).toBe('e2e-cap')
  })

  // --- Break-glass over the sideband (issue #14, PR 3) ---

  it('break-glass roundtrip: evaluate → single ticket → resolve → audit commits an overage', async () => {
    // A 0.1.0-shaped adapter flow over real HTTP: the breach flips the
    // allowed call into ONE native ticket in the standard approval block.
    const evalRes = await fetch(`${sidebandUrl}/evaluate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        origin: 'openclaw',
        tool: { name: 'glass_pay' },
        arguments: { amount: 50 },
      }),
    })
    expect(evalRes.status).toBe(200)
    const evalBody = (await evalRes.json()) as {
      decision: string
      evaluation_id: string
      approval?: { id: string; resolve_path: string; timeout_ms: number }
      limits?: { budgets?: Array<Record<string, unknown>> }
    }
    expect(evalBody.decision).toBe('require_approval')
    expect(evalBody.approval?.id).toBeTruthy()
    // Regression pin (re-review amendment): never a second approval block.
    expect(JSON.stringify(evalBody)).not.toContain('budget_approval')
    expect(evalBody.limits?.budgets?.[0]?.['allowed']).toBe(false)

    const resolveRes = await fetch(`${sidebandUrl}${evalBody.approval?.resolve_path ?? ''}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resolution: 'approved', resolved_by: 'operator' }),
    })
    expect(resolveRes.status).toBe(200)

    const auditRes = await fetch(`${sidebandUrl}/audit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ evaluation_id: evalBody.evaluation_id, status: 'success' }),
    })
    expect(auditRes.status).toBe(201)

    auditWriter.flush()
    const rec = auditStore.list({ tool_name: 'glass_pay' }).records[0]
    expect(rec?.approval_status).toBe('approved')
    const chain = rec?.evidence_chain as Record<string, unknown>
    const budgets = chain['budgets'] as Array<Record<string, unknown>>
    expect(budgets[0]?.['name']).toBe('e2e-glass')
    expect(budgets[0]?.['kind']).toBe('approved_overage')
    // The overage is live in the shared pot.
    const state = budgetEngine.listStates().find((s) => s.name === 'e2e-glass')
    expect(state?.buckets[0]?.spent).toBe(50)
  })
})
