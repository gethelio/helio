import { createHmac } from 'node:crypto'
import type { ApprovalChannel, ApprovalTicket } from './types.js'

// ---------------------------------------------------------------------------
// WebhookChannel — notifies an external system via HTTP POST.
//
// When a new approval ticket is created, the channel POSTs the ticket
// payload to the configured URL. The external system is expected to call
// back to the proxy's REST API on the dashboard sideband port at
// POST /api/approvals/:id/approve or POST /api/approvals/:id/deny, with
// the configured dashboard.api_secret as an Authorization Bearer header.
//
// Outbound payloads are optionally signed with HMAC-SHA256 via the
// X-Helio-Signature header (standard webhook pattern).
// ---------------------------------------------------------------------------

/** Configuration for a webhook approval channel. */
export interface WebhookChannelOptions {
  /** The URL to POST approval notifications to. */
  readonly url: string
  /** Optional HMAC-SHA256 secret for signing outbound payloads. */
  readonly secret?: string
}

/**
 * Webhook approval channel.
 *
 * Sends an HTTP POST to a configured URL when a new approval ticket is
 * created. The payload includes an `event` field for future extensibility
 * and the full ticket data. When a `secret` is configured, the payload is
 * signed with HMAC-SHA256 and the signature is sent in the
 * `x-helio-signature` header.
 *
 * Errors are logged but never thrown — the ticket remains resolvable via
 * the REST API regardless of whether the webhook notification succeeds.
 */
export class WebhookChannel implements ApprovalChannel {
  readonly type = 'webhook'
  private readonly url: string
  private readonly secret: string | undefined

  constructor(options: WebhookChannelOptions) {
    this.url = options.url
    this.secret = options.secret
  }

  async notify(ticket: ApprovalTicket): Promise<void> {
    const payload = JSON.stringify({
      event: 'approval_requested',
      ticket,
    })

    const headers: Record<string, string> = {
      'content-type': 'application/json',
    }

    if (this.secret) {
      const signature = createHmac('sha256', this.secret).update(payload).digest('hex')
      headers['x-helio-signature'] = `sha256=${signature}`
    }

    try {
      const response = await fetch(this.url, {
        method: 'POST',
        headers,
        body: payload,
      })

      if (!response.ok) {
        // eslint-disable-next-line no-console -- Intentional operational warning
        console.error(
          `[helio] Webhook notification failed: ${String(response.status)} ${response.statusText} (${this.url})`,
        )
      }
    } catch (error: unknown) {
      // eslint-disable-next-line no-console -- Intentional operational warning
      console.error(
        `[helio] Webhook notification error: ${error instanceof Error ? error.message : String(error)} (${this.url})`,
      )
    }
  }
}
