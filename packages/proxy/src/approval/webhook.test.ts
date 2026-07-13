import { createHmac } from 'node:crypto'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { WebhookChannel } from './webhook.js'
import { ApprovalRouter } from './router.js'
import { ApprovalQueue } from './queue.js'
import { QueueChannel } from './channels.js'
import type { ApprovalChannel, ApprovalTicket } from './types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTicket(overrides?: Partial<ApprovalTicket>): ApprovalTicket {
  return {
    id: 'ticket-001',
    tool_name: 'create_payment',
    tool_input: { amount: 5000 },
    matched_rule: 'approve-payments',
    rule_index: 0,
    channel_name: 'webhook',
    session_id: 's1',
    requested_at: '2026-04-01T10:00:00.000Z',
    timeout_at: '2026-04-01T10:05:00.000Z',
    timeout_ms: 300_000,
    status: 'pending',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WebhookChannel', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('has type "webhook"', () => {
    const channel = new WebhookChannel({ url: 'https://example.com/hook' })
    expect(channel.type).toBe('webhook')
  })

  it('POSTs ticket payload to configured URL with event field', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', mockFetch)

    const channel = new WebhookChannel({ url: 'https://example.com/hook' })
    const ticket = makeTicket()
    await channel.notify(ticket)

    expect(mockFetch).toHaveBeenCalledOnce()

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://example.com/hook')
    expect(init.method).toBe('POST')
    expect(init.headers).toHaveProperty('content-type', 'application/json')

    const body = JSON.parse(init.body as string) as { event: string; ticket: ApprovalTicket }
    expect(body.event).toBe('approval_requested')
    expect(body.ticket.id).toBe('ticket-001')
    expect(body.ticket.tool_name).toBe('create_payment')
  })

  it('serializes breached_budgets verbatim on break-glass tickets (issue #14)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', mockFetch)

    const breached = [
      {
        name: 'daily-cap',
        limit: 50,
        spent: 49.1,
        attempted_amount: 5,
        currency: 'USD',
        window: '24h',
      },
    ]
    const channel = new WebhookChannel({ url: 'https://example.com/hook' })
    await channel.notify(makeTicket({ breached_budgets: breached }))

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string) as { ticket: ApprovalTicket }
    expect(body.ticket.breached_budgets).toEqual(breached)
  })

  it('includes x-helio-signature header when secret is configured', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', mockFetch)

    const secret = 'my-webhook-secret'
    const channel = new WebhookChannel({ url: 'https://example.com/hook', secret })
    const ticket = makeTicket()
    await channel.notify(ticket)

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Record<string, string>

    expect(headers['x-helio-signature']).toBeDefined()

    // Verify the HMAC matches
    const expectedPayload = JSON.stringify({ event: 'approval_requested', ticket })
    const expectedHmac = createHmac('sha256', secret).update(expectedPayload).digest('hex')
    expect(headers['x-helio-signature']).toBe(`sha256=${expectedHmac}`)
  })

  it('does not include signature header when no secret', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', mockFetch)

    const channel = new WebhookChannel({ url: 'https://example.com/hook' })
    await channel.notify(makeTicket())

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Record<string, string>

    expect(headers['x-helio-signature']).toBeUndefined()
  })

  it('does not throw on fetch network error', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    vi.stubGlobal('fetch', mockFetch)
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const channel = new WebhookChannel({ url: 'https://example.com/hook' })

    // Should resolve without throwing
    await expect(channel.notify(makeTicket())).resolves.toBeUndefined()
    // eslint-disable-next-line no-console -- asserting that error was logged
    expect(console.error).toHaveBeenCalledOnce()
  })

  it('does not throw on non-2xx response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    })
    vi.stubGlobal('fetch', mockFetch)
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const channel = new WebhookChannel({ url: 'https://example.com/hook' })

    // Should resolve without throwing
    await expect(channel.notify(makeTicket())).resolves.toBeUndefined()
    // eslint-disable-next-line no-console -- asserting that error was logged
    expect(console.error).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// Integration: WebhookChannel + ApprovalRouter
// ---------------------------------------------------------------------------

describe('WebhookChannel integration with ApprovalRouter', () => {
  let router: ApprovalRouter | null = null

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    if (router) {
      router.close()
      router = null
    }
  })

  function setupRouter() {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', mockFetch)

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

    // Track for cleanup in afterEach
    router = r

    return { router: r, queue, mockFetch, webhook }
  }

  it('webhook fires when router submits a ticket to webhook channel', async () => {
    const { router: r, mockFetch } = setupRouter()

    // Submit without awaiting — it blocks until approved/denied/timeout
    const outcomePromise = r.submit({
      tool_name: 'create_payment',
      tool_input: { amount: 5000 },
      matched_rule: { approval: { channel: 'webhook' } } as never,
      session_id: 's1',
    })

    // Give the notify() call time to fire
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(mockFetch).toHaveBeenCalledOnce()

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string) as { event: string; ticket: ApprovalTicket }
    expect(body.event).toBe('approval_requested')
    expect(body.ticket.tool_name).toBe('create_payment')

    // Clean up: approve so the promise resolves
    r.approve(body.ticket.id, 'test')
    await outcomePromise
  })

  it('callback approve resolves the held promise', async () => {
    const { router: r, queue, mockFetch } = setupRouter()

    const outcomePromise = r.submit({
      tool_name: 'create_payment',
      tool_input: { amount: 5000 },
      matched_rule: { approval: { channel: 'webhook' } } as never,
      session_id: 's1',
    })

    await new Promise((resolve) => setTimeout(resolve, 10))

    // Extract ticket ID from the webhook payload
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string) as { ticket: ApprovalTicket }
    const ticketId = body.ticket.id

    // Simulate external system callback
    r.approve(ticketId, 'webhook-bot')

    const outcome = await outcomePromise
    expect(outcome.status).toBe('approved')
    expect(outcome.ticketId).toBe(ticketId)

    // Queue should also reflect the resolution
    const ticket = queue.get(ticketId)
    expect(ticket?.status).toBe('approved')
    expect(ticket?.resolved_by).toBe('webhook-bot')
  })

  it('callback deny resolves the held promise', async () => {
    const { router: r, mockFetch } = setupRouter()

    const outcomePromise = r.submit({
      tool_name: 'create_payment',
      tool_input: { amount: 5000 },
      matched_rule: { approval: { channel: 'webhook' } } as never,
      session_id: 's1',
    })

    await new Promise((resolve) => setTimeout(resolve, 10))

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string) as { ticket: ApprovalTicket }
    const ticketId = body.ticket.id

    r.deny(ticketId, 'webhook-bot', 'Budget exceeded')

    const outcome = await outcomePromise
    expect(outcome.status).toBe('denied')
    if (outcome.status === 'denied') {
      expect(outcome.reason).toBe('Budget exceeded')
    }
  })
})
