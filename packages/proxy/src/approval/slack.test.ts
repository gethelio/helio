import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SlackChannel, buildApprovalBlocks, truncate } from './slack.js'
import { ApprovalRouter } from './router.js'
import { ApprovalQueue } from './queue.js'
import { QueueChannel } from './channels.js'
import type { ApprovalChannel, ApprovalTicket } from './types.js'

// ---------------------------------------------------------------------------
// Mock @slack/web-api
// ---------------------------------------------------------------------------

const { mockPostMessage, mockUpdate } = vi.hoisted(() => ({
  mockPostMessage: vi.fn(),
  mockUpdate: vi.fn(),
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

function makeTicket(overrides?: Partial<ApprovalTicket>): ApprovalTicket {
  return {
    id: 'ticket-001',
    tool_name: 'create_payment',
    tool_input: { amount: 5000, currency: 'GBP' },
    matched_rule: 'approve-payments',
    rule_index: 0,
    channel_name: 'slack',
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

describe('SlackChannel', () => {
  beforeEach(() => {
    mockPostMessage.mockResolvedValue({ ok: true, ts: '1234567890.123456' })
    mockUpdate.mockResolvedValue({ ok: true })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('has type "slack"', () => {
    const channel = new SlackChannel({
      botToken: 'xoxb-test',
      signingSecret: 'secret',
      channel: '#approvals',
    })
    expect(channel.type).toBe('slack')
  })

  it('exposes signingSecret for the action handler', () => {
    const channel = new SlackChannel({
      botToken: 'xoxb-test',
      signingSecret: 'my-secret',
      channel: '#approvals',
    })
    expect(channel.signingSecret).toBe('my-secret')
  })

  it('calls chat.postMessage with correct channel and fallback text', async () => {
    const channel = new SlackChannel({
      botToken: 'xoxb-test',
      signingSecret: 'secret',
      channel: '#approvals',
    })
    const ticket = makeTicket()
    await channel.notify(ticket)

    expect(mockPostMessage).toHaveBeenCalledOnce()
    const args = mockPostMessage.mock.calls[0] as unknown[]
    const call = args[0] as { channel: string; text: string; blocks: unknown[] }
    expect(call.channel).toBe('#approvals')
    expect(call.text).toBe('Approval required: create_payment')
    expect(call.blocks).toBeDefined()
    expect(Array.isArray(call.blocks)).toBe(true)
  })

  it('embeds ticket ID in action_id for Approve and Deny buttons', async () => {
    const channel = new SlackChannel({
      botToken: 'xoxb-test',
      signingSecret: 'secret',
      channel: '#approvals',
    })
    await channel.notify(makeTicket({ id: 'abc-123' }))

    expect(mockPostMessage).toHaveBeenCalledOnce()

    // Use buildApprovalBlocks directly to verify the action_ids
    const blocks = buildApprovalBlocks(makeTicket({ id: 'abc-123' }))
    const actionsBlock = blocks.find((b) => b.type === 'actions')
    expect(actionsBlock).toBeDefined()

    // Verify action_ids are embedded in the blocks that get sent
    const blockJson = JSON.stringify(blocks)
    expect(blockJson).toContain('helio_approve:abc-123')
    expect(blockJson).toContain('helio_deny:abc-123')
  })

  it('does not throw on Slack API error', async () => {
    mockPostMessage.mockRejectedValue(new Error('channel_not_found'))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const channel = new SlackChannel({
      botToken: 'xoxb-test',
      signingSecret: 'secret',
      channel: '#nonexistent',
    })

    await expect(channel.notify(makeTicket())).resolves.toBeUndefined()
    // eslint-disable-next-line no-console -- asserting that error was logged
    expect(console.error).toHaveBeenCalledOnce()
  })

  it('does not throw on network error', async () => {
    mockPostMessage.mockRejectedValue(new Error('ECONNREFUSED'))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const channel = new SlackChannel({
      botToken: 'xoxb-test',
      signingSecret: 'secret',
      channel: '#approvals',
    })

    await expect(channel.notify(makeTicket())).resolves.toBeUndefined()
    // eslint-disable-next-line no-console -- asserting that error was logged
    expect(console.error).toHaveBeenCalledOnce()
  })

  it('sanitizes the fallback text field so notifications cannot inject channel pings or links', async () => {
    const channel = new SlackChannel({
      botToken: 'xoxb-test',
      signingSecret: 'secret',
      channel: '#approvals',
    })
    await channel.notify(makeTicket({ tool_name: '<!channel> urgent <https://evil/|click>' }))

    const args = mockPostMessage.mock.calls[0] as unknown[]
    const call = args[0] as { text: string }
    // The block render is already sanitized; the fallback text field is
    // rendered as mrkdwn in push and mobile previews, so the same
    // metacharacters must not survive here either.
    expect(call.text).not.toContain('<!channel>')
    expect(call.text).not.toContain('<https://evil/|click>')
    expect(call.text).not.toContain('|')
  })

  it('preserves snake_case identifiers in the fallback text field', async () => {
    const channel = new SlackChannel({
      botToken: 'xoxb-test',
      signingSecret: 'secret',
      channel: '#approvals',
    })
    await channel.notify(makeTicket({ tool_name: 'create_payment' }))

    const args = mockPostMessage.mock.calls[0] as unknown[]
    const call = args[0] as { text: string }
    expect(call.text).toBe('Approval required: create_payment')
  })
})

// ---------------------------------------------------------------------------
// Block Kit helpers
// ---------------------------------------------------------------------------

describe('buildApprovalBlocks', () => {
  it('includes header, section, context, and actions blocks', () => {
    const blocks = buildApprovalBlocks(makeTicket())
    const types = blocks.map((b) => b.type)

    expect(types).toEqual(['header', 'section', 'context', 'actions'])
  })

  it('includes tool name and input in the section', () => {
    const blocks = buildApprovalBlocks(makeTicket())
    const section = blocks.find((b) => b.type === 'section') as { text: { text: string } }

    expect(section.text.text).toContain('create_payment')
    expect(section.text.text).toContain('5000')
  })

  it('includes matched rule when present', () => {
    const blocks = buildApprovalBlocks(makeTicket({ matched_rule: 'my-rule' }))
    const section = blocks.find((b) => b.type === 'section') as { text: { text: string } }

    expect(section.text.text).toContain('my-rule')
  })

  it('omits matched rule line when null', () => {
    const blocks = buildApprovalBlocks(makeTicket({ matched_rule: null }))
    const section = blocks.find((b) => b.type === 'section') as { text: { text: string } }

    expect(section.text.text).not.toContain('Rule')
  })
})

describe('truncate', () => {
  it('returns short strings unchanged', () => {
    expect(truncate('hello', 200)).toBe('hello')
  })

  it('truncates long strings with ellipsis', () => {
    const long = 'a'.repeat(300)
    const result = truncate(long, 200)
    expect(result.length).toBe(200)
    expect(result.endsWith('\u2026')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// mrkdwn sanitization for Slack approval messages
//
// An attacker-controlled tool name or tool input must not be able to inject
// Slack mrkdwn formatting (bold, links, channel pings, fake buttons) into
// the approval message seen by the human approver. Backtick injection was
// the original foot-gun — a literal backtick inside the tool name closed
// the code span early and let the rest render as arbitrary mrkdwn.
// ---------------------------------------------------------------------------

describe('buildApprovalBlocks — mrkdwn sanitization', () => {
  function sectionText(blocks: ReturnType<typeof buildApprovalBlocks>): string {
    const section = blocks.find((b) => b.type === 'section') as { text: { text: string } }
    return section.text.text
  }

  it('keeps the tool-name code span balanced when the name contains backticks', () => {
    const blocks = buildApprovalBlocks(makeTicket({ tool_name: 'foo`evil `bar' }))
    const text = sectionText(blocks)

    // The tool line should match exactly one balanced backtick pair —
    // attacker backticks must not escape the code span.
    const toolLine = text.split('\n').find((l) => l.startsWith('*Tool:*'))
    expect(toolLine).toBeDefined()
    expect(toolLine).toMatch(/^\*Tool:\* `[^`]*`$/)
    expect(toolLine).not.toContain('`evil')
  })

  it('keeps the tool-name code span balanced when the name contains newlines', () => {
    const blocks = buildApprovalBlocks(makeTicket({ tool_name: 'foo\n*injected*' }))
    const text = sectionText(blocks)

    // No stray `*injected*` on its own line outside the tool code span.
    const toolLine = text.split('\n').find((l) => l.startsWith('*Tool:*'))
    expect(toolLine).toBeDefined()
    expect(toolLine).toMatch(/^\*Tool:\* `[^`]*`$/)
    // The "injected" fragment is either stripped or still inside the code span;
    // it must not appear on a separate line as unquoted mrkdwn.
    const injectedLines = text.split('\n').filter((l) => l === '*injected*')
    expect(injectedLines).toHaveLength(0)
  })

  it('truncates overly long tool names', () => {
    const blocks = buildApprovalBlocks(makeTicket({ tool_name: 'a'.repeat(500) }))
    const text = sectionText(blocks)
    const toolLine = text.split('\n').find((l) => l.startsWith('*Tool:*')) ?? ''
    // Bounded well under 128 chars regardless of input length
    expect(toolLine.length).toBeLessThanOrEqual(128)
  })

  it('wraps a plain tool input in a triple-backtick preformatted block', () => {
    const blocks = buildApprovalBlocks(
      makeTicket({ tool_input: { amount: 5000, currency: 'GBP' } }),
    )
    const text = sectionText(blocks)

    // Plain input should contain exactly two triple-backtick fences (open + close)
    // and no stray single-backtick code spans on the input line.
    const tripleRuns = text.match(/```/g) ?? []
    expect(tripleRuns.length).toBe(2)
    expect(text).toContain('*Input:*')
    expect(text).toContain('"amount":5000')
  })

  it('neutralizes triple-backtick sequences in tool input so the wrapper cannot close early', () => {
    const blocks = buildApprovalBlocks(
      makeTicket({
        tool_input: { payload: 'legit ``` evil *bold* <!channel>' },
      }),
    )
    const text = sectionText(blocks)

    // Exactly two unbroken triple-backtick sequences: the open and close
    // fences. Any attacker ``` runs in the payload must be broken up so
    // they do not read as a fence delimiter to Slack's mrkdwn renderer.
    const tripleRuns = text.match(/```/g) ?? []
    expect(tripleRuns.length).toBe(2)
    // The attacker content is still visible (just neutered), so operators
    // can see what an attacker tried to smuggle.
    expect(text).toContain('legit')
    expect(text).toContain('evil')
  })

  it('preserves a normal ASCII tool name unchanged', () => {
    const blocks = buildApprovalBlocks(makeTicket({ tool_name: 'create_payment' }))
    const text = sectionText(blocks)
    expect(text).toContain('*Tool:* `create_payment`')
  })

  it('keeps the session-id code span balanced when it contains backticks', () => {
    const blocks = buildApprovalBlocks(makeTicket({ session_id: 'sess`evil *bold*' }))
    const text = sectionText(blocks)
    const sessionLine = text.split('\n').find((l) => l.startsWith('*Session:*'))
    expect(sessionLine).toBeDefined()
    expect(sessionLine).toMatch(/^\*Session:\* `[^`]*`$/)
    expect(sessionLine).not.toContain('`evil')
  })

  it('strips mrkdwn metacharacters from the rule name (rendered as raw mrkdwn text)', () => {
    const blocks = buildApprovalBlocks(
      makeTicket({ matched_rule: 'rule `code` *bold* <!channel>' }),
    )
    const text = sectionText(blocks)
    const ruleLine = text.split('\n').find((l) => l.startsWith('*Rule:*')) ?? ''
    // The rule name is not wrapped in a code span, so every metacharacter
    // must be stripped — the only raw mrkdwn on this line is the `*Rule:*`
    // label we control.
    expect(ruleLine).not.toContain('`code`')
    expect(ruleLine).not.toContain('*bold*')
    expect(ruleLine).not.toContain('<!channel>')
  })
})

// ---------------------------------------------------------------------------
// Integration: SlackChannel + ApprovalRouter
// ---------------------------------------------------------------------------

describe('SlackChannel integration with ApprovalRouter', () => {
  let router: ApprovalRouter | null = null

  beforeEach(() => {
    mockPostMessage.mockResolvedValue({ ok: true, ts: '1234567890.123456' })
  })

  afterEach(() => {
    vi.clearAllMocks()
    if (router) {
      router.close()
      router = null
    }
  })

  function setupRouter() {
    const queue = new ApprovalQueue({ cleanupIntervalMs: 0 })
    const slackChannel = new SlackChannel({
      botToken: 'xoxb-test',
      signingSecret: 'secret',
      channel: '#approvals',
    })
    const channels = new Map<string, ApprovalChannel>([
      ['dashboard', new QueueChannel()],
      ['slack', slackChannel],
    ])
    const r = new ApprovalRouter({
      defaultTimeoutMs: 300_000,
      defaultOnTimeout: 'deny',
      channels,
      queue,
    })
    router = r
    return { router: r, queue }
  }

  it('Slack message fires when router submits a ticket to slack channel', async () => {
    const { router: r, queue } = setupRouter()

    const outcomePromise = r.submit({
      tool_name: 'create_payment',
      tool_input: { amount: 5000 },
      matched_rule: { approval: { channel: 'slack' } } as never,
      session_id: 's1',
    })

    // Give the notify() call time to fire
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(mockPostMessage).toHaveBeenCalledOnce()

    // Clean up: approve so the promise resolves
    const pending = queue.listPending()
    if (pending[0]) r.approve(pending[0].id, 'cleanup')
    await outcomePromise
  })

  it('callback approve resolves the held promise', async () => {
    const { router: r, queue } = setupRouter()

    const outcomePromise = r.submit({
      tool_name: 'create_payment',
      tool_input: { amount: 5000 },
      matched_rule: { approval: { channel: 'slack' } } as never,
      session_id: 's1',
    })

    await new Promise((resolve) => setTimeout(resolve, 10))

    // Find the ticket ID from the queue
    const pending = queue.listPending()
    const ticketId = pending[0]?.id
    expect(ticketId).toBeDefined()

    r.approve(ticketId as string, 'alice')

    const outcome = await outcomePromise
    expect(outcome.status).toBe('approved')
    expect(outcome.ticketId).toBe(ticketId)
  })
})
