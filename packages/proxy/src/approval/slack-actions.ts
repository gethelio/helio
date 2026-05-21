import { createHmac, timingSafeEqual } from 'node:crypto'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { z } from 'zod'
import type { KnownBlock } from '@slack/web-api'
import type { ApprovalRouter } from './router.js'
import type { ApprovalChannel } from './types.js'
import { SlackChannel } from './slack.js'

// ---------------------------------------------------------------------------
// Slack action handler — receives interactive button callbacks from Slack.
//
// When a user clicks Approve or Deny on a Slack message, Slack POSTs an
// action payload to this handler. The handler verifies the Slack signature,
// resolves the approval ticket, and updates the original Slack message.
//
// Mounted on the main proxy server at /slack/actions.
// ---------------------------------------------------------------------------

/** Options for the Slack action handler. */
export interface SlackActionAppOptions {
  /** The approval router for resolving tickets. */
  readonly router: ApprovalRouter
  /** The channel map — used to find SlackChannel instances for signature
   *  verification and message updates. */
  readonly channels: Map<string, ApprovalChannel>
}

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

const MAX_TIMESTAMP_AGE_S = 300 // 5 minutes
const REJECTION_LOG_WINDOW_MS = 60_000
const REJECTION_LOG_SAMPLE_EVERY = 25
const MAX_REJECTION_LOG_BUCKETS = 512
const MAX_SOURCE_HINT_LENGTH = 128

type SlackRejectionReason =
  | 'missing_headers'
  | 'invalid_timestamp'
  | 'stale_timestamp'
  | 'invalid_signature'

interface RejectionLogBucket {
  windowStartMs: number
  count: number
  suppressed: number
}

interface SlackRejectionEvent {
  readonly reason: SlackRejectionReason
  readonly sourceHint: string
  readonly hasTimestamp: boolean
  readonly hasSignature: boolean
  readonly ageS?: number
}

function sanitizeSourceHint(value: string): string {
  const collapsed = value.replace(/[\r\n\t]/g, ' ').trim()
  if (!collapsed) return 'unknown'
  if (collapsed.length <= MAX_SOURCE_HINT_LENGTH) return collapsed
  return `${collapsed.slice(0, MAX_SOURCE_HINT_LENGTH)}...`
}

function extractSourceHint(
  forwardedForHeader: string | undefined,
  realIpHeader: string | undefined,
): string {
  const forwardedFor = forwardedForHeader?.split(',')[0]?.trim()
  if (forwardedFor) return sanitizeSourceHint(forwardedFor)
  if (realIpHeader) return sanitizeSourceHint(realIpHeader)
  return 'unknown'
}

function consumeRejectionLogCounter(
  buckets: Map<string, RejectionLogBucket>,
  key: string,
  nowMs: number,
): { readonly shouldLog: boolean; readonly suppressed: number } {
  const existing = buckets.get(key)
  if (!existing) {
    if (buckets.size >= MAX_REJECTION_LOG_BUCKETS) {
      const oldest = buckets.keys().next().value
      if (oldest) buckets.delete(oldest)
    }
    buckets.set(key, { windowStartMs: nowMs, count: 1, suppressed: 0 })
    return { shouldLog: true, suppressed: 0 }
  }

  if (nowMs - existing.windowStartMs >= REJECTION_LOG_WINDOW_MS) {
    const suppressed = existing.suppressed
    existing.windowStartMs = nowMs
    existing.count = 1
    existing.suppressed = 0
    return { shouldLog: true, suppressed }
  }

  existing.count += 1
  if (existing.count % REJECTION_LOG_SAMPLE_EVERY === 0) {
    const suppressed = existing.suppressed
    existing.suppressed = 0
    return { shouldLog: true, suppressed }
  }

  existing.suppressed += 1
  return { shouldLog: false, suppressed: 0 }
}

function logRejectedSlackCallback(
  buckets: Map<string, RejectionLogBucket>,
  event: SlackRejectionEvent,
): void {
  const bucketKey = `${event.reason}|${event.sourceHint}`
  const { shouldLog, suppressed } = consumeRejectionLogCounter(buckets, bucketKey, Date.now())
  if (!shouldLog) return

  const agePart = event.ageS === undefined ? '' : ` age_s=${String(event.ageS)}`
  const suppressedPart = suppressed > 0 ? ` suppressed=${String(suppressed)}` : ''
  // eslint-disable-next-line no-console -- Intentional operational warning
  console.error(
    `[helio] Warning: Slack callback rejected reason=${event.reason} source_hint=${event.sourceHint} has_timestamp=${String(event.hasTimestamp)} has_signature=${String(event.hasSignature)} max_age_s=${String(MAX_TIMESTAMP_AGE_S)}${agePart}${suppressedPart}`,
  )
}

/**
 * Verify a Slack request signature.
 *
 * Slack signs requests with HMAC-SHA256 using the app's signing secret.
 * The signature base string is `v0:<timestamp>:<rawBody>`.
 *
 * @returns `true` if the signature is valid for any of the provided secrets.
 */
function verifySlackSignature(
  secrets: ReadonlyArray<string>,
  timestamp: string,
  rawBody: string,
  signature: string,
): boolean {
  const sigBaseString = `v0:${timestamp}:${rawBody}`

  for (const secret of secrets) {
    const expected = `v0=${createHmac('sha256', secret).update(sigBaseString).digest('hex')}`
    const a = Buffer.from(expected)
    const b = Buffer.from(signature)
    if (a.length === b.length && timingSafeEqual(a, b)) {
      return true
    }
  }

  return false
}

// ---------------------------------------------------------------------------
// Action payload parsing
// ---------------------------------------------------------------------------

const slackActionPayloadSchema = z.object({
  type: z.string(),
  user: z.object({ id: z.string(), username: z.string() }),
  actions: z.array(z.object({ action_id: z.string() })),
  channel: z.object({ id: z.string() }),
  message: z.object({ ts: z.string() }),
})

type SlackActionPayload = z.infer<typeof slackActionPayloadSchema>

/**
 * Parse a Slack interactive action payload from a URL-encoded POST body.
 *
 * Slack sends `application/x-www-form-urlencoded` with a `payload` field
 * containing JSON.
 */
function parseActionPayload(rawBody: string): SlackActionPayload | null {
  try {
    const params = new URLSearchParams(rawBody)
    const payloadStr = params.get('payload')
    if (!payloadStr) return null
    const parsed: unknown = JSON.parse(payloadStr)
    const result = slackActionPayloadSchema.safeParse(parsed)
    return result.success ? result.data : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Message update blocks
// ---------------------------------------------------------------------------

function buildResolvedBlocks(action: string, username: string, ticketId: string): KnownBlock[] {
  const emoji = action === 'helio_approve' ? '\u2705' : '\u274c'
  const verb = action === 'helio_approve' ? 'Approved' : 'Denied'

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${emoji} *${verb}* by <@${username}>\nTicket \`${ticketId}\``,
      },
    },
  ]
}

// ---------------------------------------------------------------------------
// Hono sub-app factory
// ---------------------------------------------------------------------------

/**
 * Create a Hono app for handling Slack interactive action callbacks.
 *
 * Mounted on the main proxy server at `/slack/actions`. Verifies Slack
 * request signatures, resolves approval tickets, and updates the original
 * Slack message to show the decision.
 */
export function createSlackActionApp(options: SlackActionAppOptions): Hono {
  const { router, channels } = options
  const app = new Hono()
  const rejectionLogBuckets = new Map<string, RejectionLogBucket>()

  const rejectUnauthorized = (
    c: Context,
    reason: SlackRejectionReason,
    context: {
      readonly hasTimestamp: boolean
      readonly hasSignature: boolean
      readonly sourceHint: string
      readonly ageS?: number
    },
  ) => {
    logRejectedSlackCallback(rejectionLogBuckets, {
      reason,
      sourceHint: context.sourceHint,
      hasTimestamp: context.hasTimestamp,
      hasSignature: context.hasSignature,
      ageS: context.ageS,
    })
    return c.json({ error: 'Unauthorized' }, 401)
  }

  // Collect signing secrets from all Slack channels
  const signingSecrets: string[] = []
  const slackChannels: SlackChannel[] = []
  for (const [, ch] of channels) {
    if (ch instanceof SlackChannel) {
      signingSecrets.push(ch.signingSecret)
      slackChannels.push(ch)
    }
  }

  app.post('/', async (c) => {
    // 1. Read raw body (needed for HMAC verification before parsing)
    const rawBody = await c.req.text()

    // 2. Extract and validate Slack headers
    const timestamp = c.req.header('x-slack-request-timestamp')
    const signature = c.req.header('x-slack-signature')
    const sourceHint = extractSourceHint(c.req.header('x-forwarded-for'), c.req.header('x-real-ip'))

    if (!timestamp || !signature) {
      return rejectUnauthorized(c, 'missing_headers', {
        hasTimestamp: Boolean(timestamp),
        hasSignature: Boolean(signature),
        sourceHint,
      })
    }

    const parsedTimestamp = Number(timestamp)
    if (!Number.isFinite(parsedTimestamp)) {
      return rejectUnauthorized(c, 'invalid_timestamp', {
        hasTimestamp: true,
        hasSignature: true,
        sourceHint,
      })
    }

    // 3. Reject stale timestamps (replay protection)
    const age = Math.abs(Math.floor(Date.now() / 1000) - Math.trunc(parsedTimestamp))
    if (age > MAX_TIMESTAMP_AGE_S) {
      return rejectUnauthorized(c, 'stale_timestamp', {
        hasTimestamp: true,
        hasSignature: true,
        sourceHint,
        ageS: age,
      })
    }

    // 4. Verify signature against all known signing secrets
    if (!verifySlackSignature(signingSecrets, timestamp, rawBody, signature)) {
      return rejectUnauthorized(c, 'invalid_signature', {
        hasTimestamp: true,
        hasSignature: true,
        sourceHint,
        ageS: age,
      })
    }

    // 5. Parse the action payload
    const payload = parseActionPayload(rawBody)
    if (!payload || !payload.actions.length) {
      return c.json({ error: 'Invalid payload' }, 400)
    }

    // 6. Extract action details
    const actionId = payload.actions[0]?.action_id ?? ''
    const [action, ticketId] = actionId.split(':')

    if (!action || !ticketId || (action !== 'helio_approve' && action !== 'helio_deny')) {
      // Unknown action — return 200 to avoid Slack retries
      return c.json({ ok: true })
    }

    const username = payload.user.username || payload.user.id

    // 7. Resolve the ticket
    let resolved: boolean
    if (action === 'helio_approve') {
      resolved = router.approve(ticketId, username)
    } else {
      resolved = router.deny(ticketId, username)
    }

    // 8. Update the original Slack message (remove buttons, show status)
    const resolvedBlocks = buildResolvedBlocks(action, username, ticketId)
    const resolvedText = `${action === 'helio_approve' ? 'Approved' : 'Denied'} by ${username}`

    // Use the first SlackChannel for the update. In multi-workspace setups
    // this should match by channel ID — acceptable limitation for MVP.
    const slackCh = slackChannels[0]
    if (slackCh && payload.channel.id && payload.message.ts) {
      if (resolved) {
        void slackCh.updateMessage(
          payload.channel.id,
          payload.message.ts,
          resolvedText,
          resolvedBlocks,
        )
      } else {
        // Ticket was already resolved — still update message to show status
        void slackCh.updateMessage(payload.channel.id, payload.message.ts, 'Already resolved', [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: `This approval has already been resolved.` },
          },
        ])
      }
    }

    // 9. Return 200 immediately (Slack requires <3s response)
    return c.json({ ok: true })
  })

  return app
}
