import { describe, it, expect, afterEach, vi } from 'vitest'
import { createApprovalApp } from './api.js'
import { ApprovalRouter } from './router.js'
import { ApprovalQueue } from './queue.js'
import { QueueChannel } from './channels.js'
import { WebhookChannel } from './webhook.js'
import type { ApprovalChannel } from './types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setup(options?: { apiSecret?: string }) {
  const queue = new ApprovalQueue({ cleanupIntervalMs: 0 })
  const channels = new Map([['dashboard', new QueueChannel()]])
  const router = new ApprovalRouter({
    defaultTimeoutMs: 300_000,
    defaultOnTimeout: 'deny',
    channels,
    queue,
  })

  const app = createApprovalApp(router, queue, {
    apiSecret: options?.apiSecret,
  })

  const get = (path: string) => app.request(path)

  const post = (path: string, body: unknown, headers?: Record<string, string>) =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })

  /** Submit a ticket and return its ID. */
  const submitTicket = (tool_name = 'create_payment') => {
    // This creates a pending promise in the router — we don't await it
    // because it would block until approved/denied/timeout.
    void router.submit({
      tool_name,
      tool_input: { amount: 5000 },
      matched_rule: undefined,
      session_id: 's1',
    })

    const pending = queue.listPending()
    const ticket = pending.find((t) => t.tool_name === tool_name)
    if (!ticket) throw new Error('Ticket not created')
    return ticket.id
  }

  return { app, router, queue, get, post, submitTicket }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Approval REST API', () => {
  let router: ApprovalRouter | null = null

  afterEach(() => {
    if (router) {
      router.close()
      router = null
    }
  })

  // -----------------------------------------------------------------------
  // Native (adapter-owned) tickets are not operator-resolvable — issue #12
  // -----------------------------------------------------------------------

  describe('native ticket guard', () => {
    it('rejects approve/deny/break-glass on native tickets with 409 native_ticket', async () => {
      const { router: r, post } = setup()
      router = r
      const ticket = r.createNativeTicket({
        tool_name: 'send',
        tool_input: {},
        matched_rule: undefined,
        session_id: null,
        origin: 'openclaw',
      })

      for (const [path, body] of [
        [`/${ticket.id}/approve`, { approved_by: 'op' }],
        [`/${ticket.id}/deny`, { denied_by: 'op' }],
        [`/${ticket.id}/break-glass`, { approved_by: 'op', reason: 'x' }],
      ] as const) {
        const res = await post(path, body)
        expect(res.status).toBe(409)
        const json = (await res.json()) as { error: string; resolve_in: string }
        expect(json.error).toBe('native_ticket')
        expect(json.resolve_in).toBe('openclaw')
      }

      // The ticket stays pending — no operator decision leaked into it.
      expect(r.resolveNativeTicket(ticket.id, 'approved', 'tg')).toBe(true)
    })
  })

  // -----------------------------------------------------------------------
  // GET /
  // -----------------------------------------------------------------------

  describe('GET /', () => {
    it('returns empty list when no tickets', async () => {
      const ctx = setup()
      router = ctx.router

      const res = await ctx.get('/')
      expect(res.status).toBe(200)

      const data = (await res.json()) as { data: unknown[] }
      expect(data.data).toHaveLength(0)
    })

    it('returns all tickets', async () => {
      const ctx = setup()
      router = ctx.router
      ctx.submitTicket('tool_a')
      ctx.submitTicket('tool_b')

      const res = await ctx.get('/')
      const data = (await res.json()) as { data: unknown[] }
      expect(data.data).toHaveLength(2)
    })

    it('filters by status query param', async () => {
      const ctx = setup()
      router = ctx.router
      const ticketId = ctx.submitTicket('tool_a')
      ctx.submitTicket('tool_b')

      // Approve one
      ctx.router.approve(ticketId, 'alice')

      const pendingRes = await ctx.get('/?status=pending')
      const pendingData = (await pendingRes.json()) as { data: unknown[] }
      expect(pendingData.data).toHaveLength(1)

      const approvedRes = await ctx.get('/?status=approved')
      const approvedData = (await approvedRes.json()) as { data: unknown[] }
      expect(approvedData.data).toHaveLength(1)
    })

    it('accepts shutdown_cancelled as a status filter', async () => {
      const ctx = setup()
      router = ctx.router
      ctx.submitTicket('tool_shutdown')
      ctx.router.close()

      const res = await ctx.get('/?status=shutdown_cancelled')
      const data = (await res.json()) as { data: Array<{ status: string }> }
      expect(data.data).toHaveLength(1)
      expect(data.data[0]?.status).toBe('shutdown_cancelled')
    })

    // -- Pagination --------------------------------------------------------

    it('returns pagination envelope with defaults when no query params are set', async () => {
      const ctx = setup()
      router = ctx.router
      ctx.submitTicket('tool_a')
      ctx.submitTicket('tool_b')

      const res = await ctx.get('/')
      const body = (await res.json()) as {
        data: unknown[]
        total: number
        limit: number
        offset: number
      }
      expect(body.data).toHaveLength(2)
      expect(body.total).toBe(2)
      expect(body.limit).toBe(50)
      expect(body.offset).toBe(0)
    })

    it('slices by limit and offset while reporting the full total', async () => {
      const ctx = setup()
      router = ctx.router
      for (const n of [1, 2, 3, 4, 5]) {
        ctx.submitTicket(`tool_${String(n)}`)
      }

      const firstPage = await ctx.get('/?limit=2&offset=0')
      const firstBody = (await firstPage.json()) as {
        data: { id: string }[]
        total: number
        limit: number
        offset: number
      }
      expect(firstBody.data).toHaveLength(2)
      expect(firstBody.total).toBe(5)
      expect(firstBody.limit).toBe(2)
      expect(firstBody.offset).toBe(0)

      const secondPage = await ctx.get('/?limit=2&offset=2')
      const secondBody = (await secondPage.json()) as {
        data: { id: string }[]
        total: number
        limit: number
        offset: number
      }
      expect(secondBody.data).toHaveLength(2)
      expect(secondBody.total).toBe(5)
      expect(secondBody.offset).toBe(2)

      // First and second page should not overlap
      const firstIds = firstBody.data.map((t) => t.id)
      const secondIds = secondBody.data.map((t) => t.id)
      expect(firstIds.some((id) => secondIds.includes(id))).toBe(false)
    })

    it('returns tickets newest-first by requested_at', async () => {
      vi.useFakeTimers()
      try {
        vi.setSystemTime(new Date('2026-04-15T10:00:00.000Z'))
        const ctx = setup()
        router = ctx.router

        vi.setSystemTime(new Date('2026-04-15T10:00:00.000Z'))
        ctx.submitTicket('tool_first')

        vi.setSystemTime(new Date('2026-04-15T10:00:01.000Z'))
        ctx.submitTicket('tool_second')

        vi.setSystemTime(new Date('2026-04-15T10:00:02.000Z'))
        ctx.submitTicket('tool_third')

        const res = await ctx.get('/')
        const body = (await res.json()) as { data: { tool_name: string }[] }
        expect(body.data.map((t) => t.tool_name)).toEqual([
          'tool_third',
          'tool_second',
          'tool_first',
        ])
      } finally {
        vi.useRealTimers()
      }
    })
  })

  // -----------------------------------------------------------------------
  // GET /:id
  // -----------------------------------------------------------------------

  describe('GET /:id', () => {
    it('returns ticket details', async () => {
      const ctx = setup()
      router = ctx.router
      const ticketId = ctx.submitTicket()

      const res = await ctx.get(`/${ticketId}`)
      expect(res.status).toBe(200)

      const body = (await res.json()) as { data: { id: string; status: string } }
      expect(body.data.id).toBe(ticketId)
      expect(body.data.status).toBe('pending')
    })

    it('returns 404 for unknown ID', async () => {
      const ctx = setup()
      router = ctx.router

      const res = await ctx.get('/nonexistent-id')
      expect(res.status).toBe(404)
    })
  })

  // -----------------------------------------------------------------------
  // POST /:id/approve
  // -----------------------------------------------------------------------

  describe('POST /:id/approve', () => {
    it('approves a pending ticket', async () => {
      const ctx = setup()
      router = ctx.router
      const ticketId = ctx.submitTicket()

      const res = await ctx.post(`/${ticketId}/approve`, { approved_by: 'alice' })
      expect(res.status).toBe(200)

      const data = (await res.json()) as { ok: boolean }
      expect(data.ok).toBe(true)

      // Verify ticket status updated
      const ticket = ctx.queue.get(ticketId)
      expect(ticket?.status).toBe('approved')
      expect(ticket?.resolved_by).toBe('alice')
    })

    it('returns 404 for unknown ticket ID', async () => {
      const ctx = setup()
      router = ctx.router

      const res = await ctx.post('/nonexistent/approve', { approved_by: 'alice' })
      expect(res.status).toBe(404)
    })

    it('returns 409 for already-resolved ticket', async () => {
      const ctx = setup()
      router = ctx.router
      const ticketId = ctx.submitTicket()
      ctx.router.approve(ticketId, 'alice')

      const res = await ctx.post(`/${ticketId}/approve`, { approved_by: 'bob' })
      expect(res.status).toBe(409)
    })

    it('returns 400 when approved_by is missing', async () => {
      const ctx = setup()
      router = ctx.router
      const ticketId = ctx.submitTicket()

      const res = await ctx.post(`/${ticketId}/approve`, {})
      expect(res.status).toBe(400)
    })

    it('returns 400 when approved_by is empty string', async () => {
      const ctx = setup()
      router = ctx.router
      const ticketId = ctx.submitTicket()

      const res = await ctx.post(`/${ticketId}/approve`, { approved_by: '' })
      expect(res.status).toBe(400)
    })

    it('returns 400 for invalid JSON', async () => {
      const ctx = setup()
      router = ctx.router
      const ticketId = ctx.submitTicket()

      const res = await ctx.app.request(`/${ticketId}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json',
      })
      expect(res.status).toBe(400)
    })
  })

  // -----------------------------------------------------------------------
  // POST /:id/deny
  // -----------------------------------------------------------------------

  describe('POST /:id/deny', () => {
    it('denies a pending ticket with a reason', async () => {
      const ctx = setup()
      router = ctx.router
      const ticketId = ctx.submitTicket()

      const res = await ctx.post(`/${ticketId}/deny`, {
        denied_by: 'bob',
        reason: 'Budget exceeded',
      })
      expect(res.status).toBe(200)

      const data = (await res.json()) as { ok: boolean }
      expect(data.ok).toBe(true)

      const ticket = ctx.queue.get(ticketId)
      expect(ticket?.status).toBe('denied')
      expect(ticket?.resolved_by).toBe('bob')
      expect(ticket?.denial_reason).toBe('Budget exceeded')
    })

    it('denies a pending ticket without a reason', async () => {
      const ctx = setup()
      router = ctx.router
      const ticketId = ctx.submitTicket()

      const res = await ctx.post(`/${ticketId}/deny`, { denied_by: 'bob' })
      expect(res.status).toBe(200)
    })

    it('returns 404 for unknown ticket ID', async () => {
      const ctx = setup()
      router = ctx.router

      const res = await ctx.post('/nonexistent/deny', { denied_by: 'bob' })
      expect(res.status).toBe(404)
    })

    it('returns 409 for already-resolved ticket', async () => {
      const ctx = setup()
      router = ctx.router
      const ticketId = ctx.submitTicket()
      ctx.router.deny(ticketId, 'alice')

      const res = await ctx.post(`/${ticketId}/deny`, { denied_by: 'bob' })
      expect(res.status).toBe(409)
    })

    it('returns 400 when denied_by is missing', async () => {
      const ctx = setup()
      router = ctx.router
      const ticketId = ctx.submitTicket()

      const res = await ctx.post(`/${ticketId}/deny`, { reason: 'some reason' })
      expect(res.status).toBe(400)
    })
  })

  // -----------------------------------------------------------------------
  // POST /:id/break-glass
  // -----------------------------------------------------------------------

  describe('POST /:id/break-glass', () => {
    it('break-glass overrides a pending ticket', async () => {
      const ctx = setup()
      router = ctx.router
      const ticketId = ctx.submitTicket()

      const res = await ctx.post(`/${ticketId}/break-glass`, {
        approved_by: 'admin',
        reason: 'Emergency production fix',
      })
      expect(res.status).toBe(200)

      const data = (await res.json()) as { ok: boolean }
      expect(data.ok).toBe(true)

      // Verify ticket status updated
      const ticket = ctx.queue.get(ticketId)
      expect(ticket?.status).toBe('break_glass')
      expect(ticket?.resolved_by).toBe('admin')
    })

    it('returns 404 for unknown ticket ID', async () => {
      const ctx = setup()
      router = ctx.router

      const res = await ctx.post('/nonexistent/break-glass', {
        approved_by: 'admin',
        reason: 'emergency',
      })
      expect(res.status).toBe(404)
    })

    it('returns 409 for already-resolved ticket', async () => {
      const ctx = setup()
      router = ctx.router
      const ticketId = ctx.submitTicket()
      ctx.router.approve(ticketId, 'alice')

      const res = await ctx.post(`/${ticketId}/break-glass`, {
        approved_by: 'admin',
        reason: 'emergency',
      })
      expect(res.status).toBe(409)
    })

    it('returns 400 when reason is missing', async () => {
      const ctx = setup()
      router = ctx.router
      const ticketId = ctx.submitTicket()

      const res = await ctx.post(`/${ticketId}/break-glass`, { approved_by: 'admin' })
      expect(res.status).toBe(400)
    })

    it('returns 400 when reason is empty string', async () => {
      const ctx = setup()
      router = ctx.router
      const ticketId = ctx.submitTicket()

      const res = await ctx.post(`/${ticketId}/break-glass`, {
        approved_by: 'admin',
        reason: '',
      })
      expect(res.status).toBe(400)
    })

    it('returns 400 when approved_by is missing', async () => {
      const ctx = setup()
      router = ctx.router
      const ticketId = ctx.submitTicket()

      const res = await ctx.post(`/${ticketId}/break-glass`, { reason: 'emergency' })
      expect(res.status).toBe(400)
    })

    it('returns 400 for invalid JSON', async () => {
      const ctx = setup()
      router = ctx.router
      const ticketId = ctx.submitTicket()

      const res = await ctx.app.request(`/${ticketId}/break-glass`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json',
      })
      expect(res.status).toBe(400)
    })

    it('requires bearer auth when apiSecret is configured', async () => {
      const ctx = setup({ apiSecret: 'secret' })
      router = ctx.router
      const ticketId = ctx.submitTicket()

      // Without auth
      const res = await ctx.post(`/${ticketId}/break-glass`, {
        approved_by: 'admin',
        reason: 'emergency',
      })
      expect(res.status).toBe(401)

      // With correct auth
      const res2 = await ctx.post(
        `/${ticketId}/break-glass`,
        { approved_by: 'admin', reason: 'emergency' },
        { authorization: 'Bearer secret' },
      )
      expect(res2.status).toBe(200)
    })
  })

  // -----------------------------------------------------------------------
  // Bearer token auth
  // -----------------------------------------------------------------------

  describe('Bearer token auth', () => {
    const SECRET = 'test-api-secret-token'

    it('returns 401 on POST when apiSecret is set and no Authorization header', async () => {
      const ctx = setup({ apiSecret: SECRET })
      router = ctx.router
      const ticketId = ctx.submitTicket()

      const res = await ctx.post(`/${ticketId}/approve`, { approved_by: 'alice' })
      expect(res.status).toBe(401)

      const data = (await res.json()) as { error: string }
      expect(data.error).toBe('Unauthorized')
    })

    it('returns 401 on POST when Bearer token is wrong', async () => {
      const ctx = setup({ apiSecret: SECRET })
      router = ctx.router
      const ticketId = ctx.submitTicket()

      const res = await ctx.post(
        `/${ticketId}/approve`,
        { approved_by: 'alice' },
        {
          authorization: 'Bearer wrong-token',
        },
      )
      expect(res.status).toBe(401)
    })

    it('allows POST when Bearer token matches apiSecret', async () => {
      const ctx = setup({ apiSecret: SECRET })
      router = ctx.router
      const ticketId = ctx.submitTicket()

      const res = await ctx.post(
        `/${ticketId}/approve`,
        { approved_by: 'alice' },
        {
          authorization: `Bearer ${SECRET}`,
        },
      )
      expect(res.status).toBe(200)

      const ticket = ctx.queue.get(ticketId)
      expect(ticket?.status).toBe('approved')
    })

    it('allows GET requests without auth even when apiSecret is set', async () => {
      const ctx = setup({ apiSecret: SECRET })
      router = ctx.router
      ctx.submitTicket()

      const res = await ctx.get('/')
      expect(res.status).toBe(200)

      const body = (await res.json()) as { data: unknown[] }
      expect(body.data).toHaveLength(1)
    })

    it('allows POST without auth when apiSecret is not set', async () => {
      const ctx = setup()
      router = ctx.router
      const ticketId = ctx.submitTicket()

      const res = await ctx.post(`/${ticketId}/approve`, { approved_by: 'alice' })
      expect(res.status).toBe(200)
    })
  })

  // -----------------------------------------------------------------------
  // Webhook callback flow with auth
  // -----------------------------------------------------------------------

  describe('Webhook callback flow with auth', () => {
    const SECRET = 'webhook-api-secret'

    function setupWebhookFlow() {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))

      const queue = new ApprovalQueue({ cleanupIntervalMs: 0 })
      const webhook = new WebhookChannel({ url: 'https://example.com/hook' })
      const channels = new Map<string, ApprovalChannel>([
        ['dashboard', new QueueChannel()],
        ['webhook', webhook],
      ])
      const r = new ApprovalRouter({
        defaultTimeoutMs: 300_000,
        defaultOnTimeout: 'deny',
        channels,
        queue,
      })

      const app = createApprovalApp(r, queue, { apiSecret: SECRET })

      const post = (path: string, body: unknown, headers?: Record<string, string>) =>
        app.request(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify(body),
        })

      const submitTicket = () => {
        void r.submit({
          tool_name: 'create_payment',
          tool_input: { amount: 5000 },
          matched_rule: { approval: { channel: 'webhook' } } as never,
          session_id: 's1',
        })
        const pending = queue.listPending()
        const ticket = pending[pending.length - 1]
        if (!ticket) throw new Error('Ticket not created')
        return ticket.id
      }

      return { app, router: r, queue, post, submitTicket }
    }

    afterEach(() => {
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
    })

    it('webhook callback approves via POST with valid Bearer token', async () => {
      const ctx = setupWebhookFlow()
      router = ctx.router
      const ticketId = ctx.submitTicket()

      const res = await ctx.post(
        `/${ticketId}/approve`,
        { approved_by: 'webhook-bot' },
        { authorization: `Bearer ${SECRET}` },
      )
      expect(res.status).toBe(200)

      const ticket = ctx.queue.get(ticketId)
      expect(ticket?.status).toBe('approved')
      expect(ticket?.resolved_by).toBe('webhook-bot')
    })

    it('webhook callback rejected without Bearer token', async () => {
      const ctx = setupWebhookFlow()
      router = ctx.router
      const ticketId = ctx.submitTicket()

      const res = await ctx.post(`/${ticketId}/approve`, { approved_by: 'webhook-bot' })
      expect(res.status).toBe(401)

      // Ticket should still be pending
      const ticket = ctx.queue.get(ticketId)
      expect(ticket?.status).toBe('pending')
    })

    it('webhook callback rejected with wrong Bearer token', async () => {
      const ctx = setupWebhookFlow()
      router = ctx.router
      const ticketId = ctx.submitTicket()

      const res = await ctx.post(
        `/${ticketId}/deny`,
        { denied_by: 'webhook-bot' },
        { authorization: 'Bearer wrong-secret' },
      )
      expect(res.status).toBe(401)

      // Ticket should still be pending
      const ticket = ctx.queue.get(ticketId)
      expect(ticket?.status).toBe('pending')
    })
  })
})
