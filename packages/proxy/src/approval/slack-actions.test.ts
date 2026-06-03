import { createHmac } from 'node:crypto'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createSlackActionApp } from './slack-actions.js'
import { ApprovalRouter } from './router.js'
import { ApprovalQueue } from './queue.js'
import { QueueChannel } from './channels.js'
import { SlackChannel } from './slack.js'
import type { ApprovalChannel } from './types.js'

// ---------------------------------------------------------------------------
// Mock @slack/web-api
// ---------------------------------------------------------------------------

const { mockPostMessage, mockUpdate } = vi.hoisted(() => ({
  mockPostMessage: vi.fn().mockResolvedValue({ ok: true, ts: '1234.5678' }),
  mockUpdate: vi.fn().mockResolvedValue({ ok: true }),
}))

vi.mock('@slack/web-api', () => ({
  WebClient: vi.fn(function MockWebClient() {
    return {
      chat: { postMessage: mockPostMessage, update: mockUpdate },
    }
  }),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SIGNING_SECRET = 'test-slack-signing-secret'

/** Compute a Slack v0 signature for testing. */
function signSlackPayload(secret: string, timestamp: number, body: string): string {
  const sigBaseString = `v0:${String(timestamp)}:${body}`
  return `v0=${createHmac('sha256', secret).update(sigBaseString).digest('hex')}`
}

/** Build a URL-encoded Slack action payload body. */
function buildActionBody(
  actionId: string,
  options?: { username?: string; userId?: string; channelId?: string; messageTs?: string },
): string {
  const payload = {
    type: 'block_actions',
    user: { id: options?.userId ?? 'U123', username: options?.username ?? 'alice' },
    actions: [{ action_id: actionId }],
    channel: { id: options?.channelId ?? 'C123' },
    message: { ts: options?.messageTs ?? '1234567890.123456' },
  }
  return `payload=${encodeURIComponent(JSON.stringify(payload))}`
}

function setup() {
  const queue = new ApprovalQueue({ cleanupIntervalMs: 0 })
  const slackChannel = new SlackChannel({
    botToken: 'xoxb-test',
    signingSecret: SIGNING_SECRET,
    channel: '#approvals',
  })
  const channels = new Map<string, ApprovalChannel>([
    ['dashboard', new QueueChannel()],
    ['slack', slackChannel],
  ])
  const router = new ApprovalRouter({
    defaultTimeoutMs: 300_000,
    defaultOnTimeout: 'deny',
    channels,
    queue,
  })

  const app = createSlackActionApp({ router, channels })

  /** Submit a ticket routed to the slack channel and return its ID. */
  const submitTicket = (tool_name = 'create_payment') => {
    void router.submit({
      tool_name,
      tool_input: { amount: 5000 },
      matched_rule: { approval: { channel: 'slack' } } as never,
      session_id: 's1',
    })
    const pending = queue.listPending()
    const ticket = pending.find((t) => t.tool_name === tool_name)
    if (!ticket) throw new Error('Ticket not created')
    return ticket.id
  }

  /** POST a signed Slack action payload. */
  const postAction = (body: string, timestamp?: number) => {
    const ts = timestamp ?? Math.floor(Date.now() / 1000)
    const signature = signSlackPayload(SIGNING_SECRET, ts, body)
    return app.request('/', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-slack-request-timestamp': String(ts),
        'x-slack-signature': signature,
      },
      body,
    })
  }

  return { app, router, queue, slackChannel, submitTicket, postAction }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Slack action handler', () => {
  let router: ApprovalRouter | null = null

  afterEach(() => {
    vi.clearAllMocks()
    if (router) {
      router.close()
      router = null
    }
  })

  // -----------------------------------------------------------------------
  // Signature verification
  // -----------------------------------------------------------------------

  it('returns opaque 401 when Slack headers are missing', async () => {
    const ctx = setup()
    router = ctx.router
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await ctx.app.request('/', { method: 'POST', body: 'payload={}' })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Unauthorized' })
    expect(errorSpy).toHaveBeenCalledOnce()
    expect(errorSpy.mock.calls[0]?.[0]).toContain('reason=missing_headers')
    errorSpy.mockRestore()
  })

  it('returns opaque 401 for invalid signature', async () => {
    const ctx = setup()
    router = ctx.router
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    ctx.submitTicket()

    const body = buildActionBody('helio_approve:ticket-001')
    const ts = Math.floor(Date.now() / 1000)

    const res = await ctx.app.request('/', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-slack-request-timestamp': String(ts),
        'x-slack-signature': 'v0=invalid',
      },
      body,
    })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Unauthorized' })
    expect(errorSpy).toHaveBeenCalledOnce()
    expect(errorSpy.mock.calls[0]?.[0]).toContain('reason=invalid_signature')
    errorSpy.mockRestore()
  })

  it('returns opaque 401 for stale timestamp (>5 min)', async () => {
    const ctx = setup()
    router = ctx.router
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const body = buildActionBody('helio_approve:ticket-001')
    const staleTs = Math.floor(Date.now() / 1000) - 400 // 6+ minutes ago
    const signature = signSlackPayload(SIGNING_SECRET, staleTs, body)

    const res = await ctx.app.request('/', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-slack-request-timestamp': String(staleTs),
        'x-slack-signature': signature,
      },
      body,
    })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Unauthorized' })
    expect(errorSpy).toHaveBeenCalledOnce()
    expect(errorSpy.mock.calls[0]?.[0]).toContain('reason=stale_timestamp')
    errorSpy.mockRestore()
  })

  it('returns opaque 401 for malformed timestamp header', async () => {
    const ctx = setup()
    router = ctx.router
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const body = buildActionBody('helio_approve:ticket-001')
    const res = await ctx.app.request('/', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-slack-request-timestamp': 'not-a-number',
        'x-slack-signature': 'v0=deadbeef',
      },
      body,
    })

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Unauthorized' })
    expect(errorSpy).toHaveBeenCalledOnce()
    expect(errorSpy.mock.calls[0]?.[0]).toContain('reason=invalid_timestamp')
    errorSpy.mockRestore()
  })

  it('suppresses repeated rejection logs for same reason/source bucket', async () => {
    const ctx = setup()
    router = ctx.router
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const body = buildActionBody('helio_approve:ticket-001')
    const ts = Math.floor(Date.now() / 1000)

    for (let i = 0; i < 2; i += 1) {
      const res = await ctx.app.request('/', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-slack-request-timestamp': String(ts),
          'x-slack-signature': 'v0=invalid',
        },
        body,
      })
      expect(res.status).toBe(401)
    }

    expect(errorSpy).toHaveBeenCalledOnce()
    errorSpy.mockRestore()
  })

  // -----------------------------------------------------------------------
  // Approve / Deny actions
  // -----------------------------------------------------------------------

  it('approves a ticket on valid approve action', async () => {
    const ctx = setup()
    router = ctx.router
    const ticketId = ctx.submitTicket()

    const body = buildActionBody(`helio_approve:${ticketId}`)
    const res = await ctx.postAction(body)
    expect(res.status).toBe(200)

    const ticket = ctx.queue.get(ticketId)
    expect(ticket?.status).toBe('approved')
    expect(ticket?.resolved_by).toBe('alice')
  })

  it('denies a ticket on valid deny action', async () => {
    const ctx = setup()
    router = ctx.router
    const ticketId = ctx.submitTicket()

    const body = buildActionBody(`helio_deny:${ticketId}`)
    const res = await ctx.postAction(body)
    expect(res.status).toBe(200)

    const ticket = ctx.queue.get(ticketId)
    expect(ticket?.status).toBe('denied')
    expect(ticket?.resolved_by).toBe('alice')
  })

  it('returns 200 for already-resolved ticket (graceful)', async () => {
    const ctx = setup()
    router = ctx.router
    const ticketId = ctx.submitTicket()

    // Resolve via router directly first
    ctx.router.approve(ticketId, 'bob')

    // Then simulate a Slack button click — should not error
    const body = buildActionBody(`helio_approve:${ticketId}`)
    const res = await ctx.postAction(body)
    expect(res.status).toBe(200)
  })

  it('returns 200 for unknown action_id prefix (ignore gracefully)', async () => {
    const ctx = setup()
    router = ctx.router

    const body = buildActionBody('unknown_action:ticket-001')
    const res = await ctx.postAction(body)
    expect(res.status).toBe(200)
  })

  it('returns 400 for malformed payload', async () => {
    const ctx = setup()
    router = ctx.router

    const body = 'not-url-encoded-payload'
    const res = await ctx.postAction(body)
    expect(res.status).toBe(400)
  })

  // -----------------------------------------------------------------------
  // Message update
  // -----------------------------------------------------------------------

  it('calls updateMessage after resolution', async () => {
    const ctx = setup()
    router = ctx.router
    const ticketId = ctx.submitTicket()

    const updateSpy = vi.spyOn(ctx.slackChannel, 'updateMessage')

    const body = buildActionBody(`helio_approve:${ticketId}`, {
      channelId: 'C456',
      messageTs: '9999.1234',
    })
    await ctx.postAction(body)

    expect(updateSpy).toHaveBeenCalledOnce()
    expect(updateSpy).toHaveBeenCalledWith(
      'C456',
      '9999.1234',
      expect.stringContaining('Approved'),
      expect.arrayContaining([expect.objectContaining({ type: 'section' })]),
    )
  })

  // -----------------------------------------------------------------------
  // Full flow integration
  // -----------------------------------------------------------------------

  it('full flow: submit ticket → notify Slack → button click → ticket resolved → message updated', async () => {
    const ctx = setup()
    router = ctx.router

    // 1. Submit ticket (held promise)
    const outcomePromise = ctx.router.submit({
      tool_name: 'transfer_funds',
      tool_input: { amount: 10_000 },
      matched_rule: { approval: { channel: 'slack' } } as never,
      session_id: 's2',
    })

    // Give notify() time to fire
    await new Promise((resolve) => setTimeout(resolve, 10))

    // 2. Verify Slack message was sent
    expect(mockPostMessage).toHaveBeenCalledOnce()

    // 3. Find the ticket ID from the queue
    const pending = ctx.queue.listPending()
    expect(pending).toHaveLength(1)
    const ticketId = pending[0]?.id as string

    // 4. Simulate Slack button click (approve)
    const updateSpy = vi.spyOn(ctx.slackChannel, 'updateMessage')
    const body = buildActionBody(`helio_approve:${ticketId}`, { username: 'bob' })
    const res = await ctx.postAction(body)
    expect(res.status).toBe(200)

    // 5. Verify the held promise resolved
    const outcome = await outcomePromise
    expect(outcome.status).toBe('approved')
    expect(outcome.ticketId).toBe(ticketId)

    // 6. Verify ticket state in queue
    const ticket = ctx.queue.get(ticketId)
    expect(ticket?.status).toBe('approved')
    expect(ticket?.resolved_by).toBe('bob')

    // 7. Verify original message was updated
    expect(updateSpy).toHaveBeenCalledOnce()
  })
})
