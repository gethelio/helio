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

const MAX_INPUT_LENGTH = 200
const MAX_INLINE_FIELD_LENGTH = 64

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
function buildApprovalBlocks(ticket: ApprovalTicket): KnownBlock[] {
  const safeName = sanitizeCodeSpanContent(ticket.tool_name)
  const rawInput = truncate(JSON.stringify(ticket.tool_input), MAX_INPUT_LENGTH)
  const safeInput = sanitizeForCodeBlock(rawInput)

  const detailLines = [`*Tool:* \`${safeName}\``, `*Input:*\n\`\`\`\n${safeInput}\n\`\`\``]

  if (ticket.matched_rule) {
    detailLines.push(`*Rule:* ${sanitizeMrkdwnText(ticket.matched_rule)}`)
  }
  if (ticket.session_id) {
    detailLines.push(`*Session:* \`${sanitizeCodeSpanContent(ticket.session_id)}\``)
  }

  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'Approval Required', emoji: true },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: detailLines.join('\n') },
    },
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
