import { WebClient } from '@slack/web-api'
import type { KnownBlock } from '@slack/web-api'
import type { ApprovalChannel, ApprovalTicket } from './types.js'

// ---------------------------------------------------------------------------
// SlackChannel — sends Block Kit interactive messages for approvals.
//
// When a new approval ticket is created, the channel posts a message to
// the configured Slack channel with Approve/Deny buttons. The ticket ID
// is embedded in each button's action_id so the action handler can
// resolve the correct ticket when a user clicks.
//
// The action handler (slack-actions.ts) is a separate Hono sub-app that
// receives Slack's interactive action callbacks and resolves tickets.
// ---------------------------------------------------------------------------

/** Configuration for a Slack approval channel. */
export interface SlackChannelOptions {
  /** Slack bot token (xoxb-...). */
  readonly botToken: string
  /** Slack app signing secret for verifying action callbacks. */
  readonly signingSecret: string
  /** Slack channel ID or name to post messages to. */
  readonly channel: string
}

// ---------------------------------------------------------------------------
// Block Kit helpers
// ---------------------------------------------------------------------------

/** Slack rejects section text over 3,000 chars; leave margin for the header line. */
const MAX_SECTION_TEXT = 2_900
/**
 * Cap on the JSON-serialized tool input shown in the card's fenced block.
 * An approver reading a command line of one to two kilobytes must see it
 * whole, so the cap is 2,000; the labels around the fence measure at most
 * 389 characters at their own caps, so plain input never reaches
 * {@link MAX_SECTION_TEXT}. Fence neutralization can nearly double a
 * backtick payload AFTER this cap, and Slack rejects a section over 3,000
 * characters while {@link SlackChannel.notify} logs that error without
 * rethrowing, so an oversized card would never post: the detail section is
 * measured after neutralization and clamped under the margin.
 */
export const MAX_INPUT_LENGTH = 2_000
const MAX_INLINE_FIELD_LENGTH = 64
/**
 * Per-side cap on a drift value (issue #60). Seven aspects at two values of
 * this length, with the header, the aspect line and the closing line, fit
 * one section under {@link MAX_SECTION_TEXT}; at 200 they do not.
 */
const MAX_DRIFT_VALUE_LENGTH = 160

/** Truncate a string to `max` characters, adding an ellipsis if truncated. */
function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max - 1) + '\u2026' : str
}

/**
 * Sanitize a short identifier that will be wrapped in a mrkdwn backtick
 * code span (e.g. `*Tool:* \`${value}\``). Strips backticks — the only
 * character that can close the code span early and let attacker-controlled
 * text escape into raw mrkdwn — plus newlines which would break the line
 * structure. Other metacharacters (`*`, `_`, `~`, `<`, `>`) are left
 * alone because they are literal text inside a code span, and stripping
 * them would corrupt legitimate `snake_case.tool_name` identifiers.
 */
function sanitizeCodeSpanContent(value: string): string {
  const stripped = value.replace(/`/g, '').replace(/[\r\n]+/g, ' ')
  return truncate(stripped, MAX_INLINE_FIELD_LENGTH)
}

/**
 * Sanitize a short field that is rendered as raw mrkdwn (not wrapped in
 * a code span), e.g. `*Rule:* ${value}` or the notification fallback
 * text. Strips every mrkdwn metacharacter that could inject formatting
 * or a channel ping: backticks, `*`, `~`, `<`, `>`, `|`, and `!`.
 *
 * Underscores are deliberately preserved so legitimate `snake_case`
 * tool names and rule names render correctly — Slack's mrkdwn italic
 * parser only triggers on `_text_` at word boundaries, so underscores
 * inside identifiers never get interpreted as formatting.
 */
function sanitizeMrkdwnText(value: string): string {
  const stripped = value.replace(/[`*~<>|!]/g, '').replace(/[\r\n]+/g, ' ')
  return truncate(stripped, MAX_INLINE_FIELD_LENGTH)
}

/**
 * Render a drift value (issue #60) for a mrkdwn code span: its JSON form
 * with every backtick and newline stripped (the code-span rule of
 * {@link sanitizeCodeSpanContent}, whose 64-character cap is too short
 * for a value), truncated to `cap`. An absent side never reaches this
 * helper: the caller prints the word `absent` outside a span.
 */
function sanitizeCodeSpanValue(value: unknown, cap: number): string {
  // Every value came off a JSON body (a tools/list or a sideband request),
  // so stringify yields a string here; the absent side is guarded above.
  const json = JSON.stringify(value)
  return truncate(json.replace(/`/g, '').replace(/[\r\n]+/g, ' '), cap)
}

/**
 * Neutralize any triple-backtick sequence in `value` so a user-controlled
 * payload cannot close a preformatted code block early. We insert a
 * zero-width space between backticks in every run of three or more, which
 * is invisible in the Slack client but breaks the fence tokenizer. Single
 * and double backticks are preserved so JSON and code snippets still
 * render legibly inside the block.
 */
function sanitizeForCodeBlock(value: string): string {
  return value.replace(/`{3,}/g, (run) => run.split('').join('\u200b'))
}

/** Build the Block Kit blocks for an approval message. */
/**
 * The approval message's blocks (the summary, any budget context, the two
 * buttons). The action handler re-renders them under a kill-switch notice
 * without dropping the buttons (issue #402).
 */
function buildApprovalBlocks(ticket: ApprovalTicket): KnownBlock[] {
  const safeName = sanitizeCodeSpanContent(ticket.tool_name)
  const rawInput = truncate(JSON.stringify(ticket.tool_input), MAX_INPUT_LENGTH)

  const renderDetail = (safeInput: string): string => {
    const lines = [`*Tool:* \`${safeName}\``]
    if (ticket.upstream) {
      lines.push(`*Upstream:* \`${sanitizeCodeSpanContent(ticket.upstream)}\``)
    }
    lines.push(`*Input:*\n\`\`\`\n${safeInput}\n\`\`\``)
    if (ticket.matched_rule) {
      lines.push(`*Rule:* ${sanitizeMrkdwnText(ticket.matched_rule)}`)
    }
    if (ticket.session_id) {
      const sessionLine = `*Session:* \`${sanitizeCodeSpanContent(ticket.session_id)}\``
      lines.push(
        ticket.session_source
          ? `${sessionLine} (${sanitizeMrkdwnText(ticket.session_source)})`
          : sessionLine,
      )
    }
    return lines.join('\n')
  }

  // Neutralization runs after the cap and can grow the body, so the joined
  // section is measured afterwards. Past the margin, the fenced body loses
  // the overage plus one character, takes the ellipsis, and goes through
  // the neutralizer once more: the cut lands between already-separated
  // backticks, so no new fence can form, and the second pass pins that
  // rather than trusting it. The labels are bounded, so plain input never
  // clamps.
  const neutralized = sanitizeForCodeBlock(rawInput)
  let detailText = renderDetail(neutralized)
  if (detailText.length > MAX_SECTION_TEXT) {
    const keep = Math.max(0, neutralized.length - (detailText.length - MAX_SECTION_TEXT) - 1)
    detailText = renderDetail(sanitizeForCodeBlock(neutralized.slice(0, keep) + '\u2026'))
  }

  // Break-glass context (issue #14): the approver is deciding a budget
  // overage, so every breached budget renders with its numbers. Budget names
  // are config-charset-constrained, but currency and window are still passed
  // through the sanitizers — this text renders as raw mrkdwn. Slack caps a
  // section's text at 3,000 chars and a message at 50 blocks, so the lines
  // are packed into a bounded number of sections; anything past the cap is
  // disclosed as a count, never silently dropped (the approval ticket itself
  // always carries the full list).
  const budgetBlocks: KnownBlock[] = buildBudgetBlocks(ticket)
  // Drift context (issue #60): what changed in the tool's definition, after
  // the budget section because on the MCP door a budget ticket's hold is the
  // budget and the drift is context.
  const driftBlocks: KnownBlock[] = buildDriftBlocks(ticket)

  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'Approval Required', emoji: true },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: detailText },
    },
    ...budgetBlocks,
    ...driftBlocks,
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Ticket \`${ticket.id}\` \u2022 Timeout: ${String(Math.round(ticket.timeout_ms / 1000))}s`,
        },
      ],
    },
    {
      type: 'actions',
      block_id: 'helio_approval_actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Approve', emoji: true },
          style: 'primary',
          action_id: `helio_approve:${ticket.id}`,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Deny', emoji: true },
          style: 'danger',
          action_id: `helio_deny:${ticket.id}`,
        },
      ],
    },
  ]
}

/**
 * Bound the breach sections inside Slack's 50-block message cap (4 base
 * blocks + up to 40 sections + 1 omission context line = 45). At ~16
 * max-length lines per section this renders 600+ budgets — every realistic
 * config fits entirely; the omission line is a pathological-config backstop,
 * never the expected path.
 */
const MAX_BUDGET_SECTIONS = 40

/** Render the breached-budgets sections for a break-glass ticket, bounded. */
function buildBudgetBlocks(ticket: ApprovalTicket): KnownBlock[] {
  const breached = ticket.breached_budgets
  if (!breached?.length) return []

  const lines = breached.map(
    (b) =>
      `• \`${sanitizeCodeSpanContent(b.name)}\` — ${String(b.spent)}/${String(b.limit)} ` +
      `${sanitizeMrkdwnText(b.currency)} spent, attempting +${String(b.attempted_amount)} ` +
      `(${sanitizeMrkdwnText(b.window)} window)`,
  )

  const sections: string[] = []
  let current = '*Breached budgets (approval spends past the limit):*'
  let pendingLines = 0
  let rendered = 0
  let capped = false
  for (const line of lines) {
    if (current.length + 1 + line.length > MAX_SECTION_TEXT) {
      sections.push(current)
      if (sections.length >= MAX_BUDGET_SECTIONS) {
        capped = true
        break
      }
      current = line
      pendingLines = 1
    } else {
      current = `${current}\n${line}`
      pendingLines += 1
    }
    rendered += 1
  }
  if (!capped && pendingLines > 0) sections.push(current)

  const blocks: KnownBlock[] = sections.map((text) => ({
    type: 'section',
    text: { type: 'mrkdwn', text },
  }))
  const omitted = lines.length - rendered
  if (omitted > 0) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `…and ${String(omitted)} more breached budget${omitted === 1 ? '' : 's'} — the approval ticket carries the full list (approvals REST API / dashboard).`,
        },
      ],
    })
  }
  return blocks
}

/**
 * Which hold the drift section's header names (issue #60), read from the
 * ticket's own fields. `mode` is the CALL's drift mode, identical on every
 * ticket the call raises, so it cannot name this ticket's hold alone. On
 * the MCP door every ticket is one sequential decision, read budget-first:
 * a budget ticket's rule or gate ticket already resolved. On a native
 * ticket one approval covers every gate present, so the header lists what
 * the fields prove; a rule name beside a budget is only the rule that
 * matched (it may be an allow rule the budget overrode), never a covered
 * gate. A `flag_destructive` escalation is stored nowhere on the ticket,
 * so it is what remains when no field claims the hold.
 */
function driftHoldHeader(ticket: ApprovalTicket, mode: 'require_approval' | 'log'): string {
  const budget = Boolean(ticket.breached_budgets?.length)
  const native = ticket.channel_name.startsWith('native:')
  if (native && budget && ticket.matched_rule) {
    return 'this approval covers the overage; the matched rule is the rule that matched; the drift is context'
  }
  if (native && budget && mode === 'require_approval') {
    return 'this approval covers the drift and the overage'
  }
  if (budget) return 'this hold is the budget'
  if (ticket.matched_rule) return 'this hold is the rule'
  if (mode === 'require_approval') return 'this hold is the drift'
  return 'this hold is flag_destructive'
}

/**
 * Render the definition drift section for a drift-escalated ticket (issue
 * #60): the hold header, the changed aspects, one line per aspect with both
 * sides capped at {@link MAX_DRIFT_VALUE_LENGTH}, and the pointer to the
 * ticket's full values. Always one section: the aspect set is closed at
 * seven, and seven lines at the cap measure under {@link MAX_SECTION_TEXT}.
 */
function buildDriftBlocks(ticket: ApprovalTicket): KnownBlock[] {
  const drift = ticket.tool_drift
  if (!drift?.changes.length) return []

  const side = (value: unknown): string =>
    value === undefined ? 'absent' : `\`${sanitizeCodeSpanValue(value, MAX_DRIFT_VALUE_LENGTH)}\``
  const aspects = drift.changes.map((change) => `\`${sanitizeCodeSpanContent(change.aspect)}\``)
  const lines = drift.changes.map(
    (change) =>
      `• \`${sanitizeCodeSpanContent(change.aspect)}\`: ${side(change.baseline)} to ${side(change.current)}`,
  )
  const text = [
    `*Definition drift (${driftHoldHeader(ticket, drift.mode)}):*`,
    `Changed: ${aspects.join(', ')}`,
    ...lines,
    'The approval ticket carries the full values (approvals REST API / dashboard).',
  ].join('\n')

  return [{ type: 'section', text: { type: 'mrkdwn', text } }]
}

// ---------------------------------------------------------------------------
// SlackChannel
// ---------------------------------------------------------------------------

/**
 * Slack approval channel.
 *
 * Posts a Block Kit interactive message to the configured Slack channel
 * when a new approval ticket is created. The message includes Approve
 * and Deny buttons. Button clicks are handled by the separate Slack
 * action handler ({@link createSlackActionApp} in `slack-actions.ts`).
 *
 * Errors are logged but never thrown — the ticket remains resolvable via
 * the REST API regardless of whether the Slack notification succeeds.
 */
export class SlackChannel implements ApprovalChannel {
  readonly type = 'slack'
  /** Exposed for the Slack action handler to verify request signatures. */
  readonly signingSecret: string
  private readonly client: WebClient
  private readonly channel: string

  constructor(options: SlackChannelOptions) {
    this.client = new WebClient(options.botToken)
    this.signingSecret = options.signingSecret
    this.channel = options.channel
  }

  async notify(ticket: ApprovalTicket): Promise<void> {
    const blocks = buildApprovalBlocks(ticket)
    // The fallback `text` field is rendered as mrkdwn in push, mobile,
    // desktop, and email notification previews (clients that don't
    // render Block Kit fall back to this too). Sanitize the tool name
    // before interpolating — otherwise a toolName like `<!channel>` or
    // `<https://evil/|click here>` would ping the channel or render a
    // clickable link in the notification even though the block render
    // is safe.
    const text = `Approval required: ${sanitizeMrkdwnText(ticket.tool_name)}`

    try {
      await this.client.chat.postMessage({
        channel: this.channel,
        text,
        blocks,
      })
    } catch (error: unknown) {
      // eslint-disable-next-line no-console -- Intentional operational warning
      console.error(
        `[helio] Slack notification error: ${error instanceof Error ? error.message : String(error)} (${this.channel})`,
      )
    }
  }

  /**
   * Update an existing Slack message — used by the action handler to
   * replace the approval buttons with a resolution status.
   */
  async updateMessage(
    channel: string,
    ts: string,
    text: string,
    blocks: KnownBlock[],
  ): Promise<void> {
    try {
      await this.client.chat.update({ channel, ts, text, blocks })
    } catch (error: unknown) {
      // eslint-disable-next-line no-console -- Intentional operational warning
      console.error(
        `[helio] Slack message update error: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}

/** Exported for testing. */
export { buildApprovalBlocks, truncate }
