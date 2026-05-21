import { describe, it, expect, vi } from 'vitest'
import { createChannels, QueueChannel } from './channels.js'
import { WebhookChannel } from './webhook.js'
import { SlackChannel } from './slack.js'

vi.mock('@slack/web-api', () => ({
  WebClient: vi.fn().mockImplementation(() => ({
    chat: { postMessage: vi.fn(), update: vi.fn() },
  })),
}))

describe('createChannels', () => {
  it('always registers a dashboard channel by default', () => {
    const channels = createChannels([])
    expect(channels.has('dashboard')).toBe(true)
    expect(channels.get('dashboard')).toBeInstanceOf(QueueChannel)
  })

  it('keys a dashboard channel by name when name is provided', () => {
    const channels = createChannels([{ type: 'dashboard', name: 'my-dashboard' }])

    // Both the default 'dashboard' key and the explicit name should exist
    expect(channels.has('dashboard')).toBe(true)
    expect(channels.has('my-dashboard')).toBe(true)
  })

  it('keys by type when no name is given', () => {
    const channels = createChannels([{ type: 'dashboard' }])

    // Only the default 'dashboard' key
    expect(channels.has('dashboard')).toBe(true)
    expect(channels.size).toBe(1)
  })

  // -------------------------------------------------------------------------
  // Webhook channels
  // -------------------------------------------------------------------------

  it('creates a WebhookChannel for type webhook', () => {
    const channels = createChannels([{ type: 'webhook', url: 'https://example.com/hook' }])

    expect(channels.has('webhook')).toBe(true)
    expect(channels.get('webhook')).toBeInstanceOf(WebhookChannel)
  })

  it('keys webhook channel by name when name is provided', () => {
    const channels = createChannels([
      { type: 'webhook', name: 'finance-hook', url: 'https://example.com/hook', secret: 's3c' },
    ])

    expect(channels.has('finance-hook')).toBe(true)
    expect(channels.get('finance-hook')).toBeInstanceOf(WebhookChannel)
  })

  it('creates multiple webhook channels with different names', () => {
    const channels = createChannels([
      { type: 'webhook', name: 'hook-a', url: 'https://a.example.com/hook' },
      { type: 'webhook', name: 'hook-b', url: 'https://b.example.com/hook' },
    ])

    expect(channels.has('hook-a')).toBe(true)
    expect(channels.has('hook-b')).toBe(true)
    expect(channels.get('hook-a')).toBeInstanceOf(WebhookChannel)
    expect(channels.get('hook-b')).toBeInstanceOf(WebhookChannel)
  })

  // -------------------------------------------------------------------------
  // Slack channels
  // -------------------------------------------------------------------------

  it('creates a SlackChannel for type slack', () => {
    const channels = createChannels([
      { type: 'slack', bot_token: 'xoxb-test', signing_secret: 'sec', channel: '#approvals' },
    ])

    expect(channels.has('slack')).toBe(true)
    expect(channels.get('slack')).toBeInstanceOf(SlackChannel)
  })

  it('keys slack channel by name when name is provided', () => {
    const channels = createChannels([
      {
        type: 'slack',
        name: 'finance-approvals',
        bot_token: 'xoxb-test',
        signing_secret: 'sec',
        channel: '#finance',
      },
    ])

    expect(channels.has('finance-approvals')).toBe(true)
    expect(channels.get('finance-approvals')).toBeInstanceOf(SlackChannel)
  })
})
