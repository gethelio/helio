import type { ApprovalChannel as ChannelConfig } from '../config/schema.js'
import type { ApprovalChannel } from './types.js'
import { SlackChannel } from './slack.js'
import { WebhookChannel } from './webhook.js'

// ---------------------------------------------------------------------------
// QueueChannel — passive notification channel.
//
// The ticket is already in the ApprovalQueue when notify() is called.
// The dashboard or REST API polls/streams tickets from the queue.
// This channel is a no-op — it exists so every approval has a channel.
// ---------------------------------------------------------------------------

/** @internal Exported for testing only. */
export class QueueChannel implements ApprovalChannel {
  readonly type = 'dashboard'

  notify(): Promise<void> {
    // No-op: ticket is already in the queue. The dashboard or REST API
    // will discover it via polling or SSE events.
    return Promise.resolve()
  }
}

// ---------------------------------------------------------------------------
// Channel factory
// ---------------------------------------------------------------------------

/**
 * Build a map of channel key → ApprovalChannel from the approval config.
 *
 * Each channel is keyed by its `name` field if present, otherwise by its
 * `type`. This allows multiple channels of the same type (e.g. two webhook
 * channels with different names) to coexist.
 *
 * Policy rules reference channels by this key via `approval.channel`.
 */
export function createChannels(
  channels: ReadonlyArray<ChannelConfig>,
): Map<string, ApprovalChannel> {
  const map = new Map<string, ApprovalChannel>()

  // Always register the dashboard (queue) channel as the default fallback
  map.set('dashboard', new QueueChannel())

  for (const ch of channels) {
    const key = ch.name ?? ch.type

    switch (ch.type) {
      case 'dashboard':
        // Re-register under the explicit name if provided
        if (ch.name) {
          map.set(ch.name, new QueueChannel())
        }
        break
      case 'webhook':
        map.set(key, new WebhookChannel({ url: ch.url, secret: ch.secret }))
        break
      case 'slack':
        map.set(
          key,
          new SlackChannel({
            botToken: ch.bot_token,
            signingSecret: ch.signing_secret,
            channel: ch.channel,
          }),
        )
        break
      default:
        // Unknown channel types are silently ignored — they'll be
        // validated at config load time by Zod schema.
        break
    }
  }

  return map
}
