/* eslint-disable no-console -- surfaces operator-visible startup warnings */

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

/**
 * Emit a startup warning if a webhook approval channel is configured while
 * the dashboard sideband is bound to localhost only. Webhook callbacks
 * originate from outside the host, so they cannot reach
 * `/api/approvals/:id/approve` on a 127.0.0.1-bound sideband. Surfacing this
 * at boot prevents silent mis-configurations where tickets are created but
 * can never be resolved via webhook.
 */
export function warnIfWebhookChannelUnreachable(
  config: {
    approval: { channels: ReadonlyArray<{ type: string }> }
    dashboard: { host: string; enabled: boolean }
  },
  log: (message: string) => void = console.error,
): boolean {
  const hasWebhookChannel = config.approval.channels.some((ch) => ch.type === 'webhook')
  const localOnlyDashboard = config.dashboard.enabled && isLoopbackHost(config.dashboard.host)

  if (!hasWebhookChannel || !localOnlyDashboard) return false

  log(
    '[helio] Warning: a webhook approval channel is configured but ' +
      'dashboard.host is bound to localhost, so external webhook callbacks ' +
      'cannot reach /api/approvals/:id/approve. Set dashboard.host to a ' +
      'public address (and front it with a reverse proxy with TLS) or use ' +
      'a different approval channel (slack, dashboard).',
  )
  return true
}

/**
 * Emit a startup warning when the SDK sideband is bound to a non-loopback
 * address. The sideband accepts evidence/context writes and should normally
 * be local-only.
 */
export function warnIfSdkSidebandExposed(
  config: {
    sdk: { host: string; enabled: boolean }
  },
  log: (message: string) => void = console.error,
): boolean {
  if (!config.sdk.enabled || isLoopbackHost(config.sdk.host)) return false

  log(
    '[helio] Warning: SDK sideband is bound to a non-loopback host. ' +
      'This sideband is intended for local SDK traffic; keep sdk.host on ' +
      '127.0.0.1/localhost (preferred) or ensure strict network controls ' +
      'and a strong HELIO_SDK_TOKEN when exposing it.',
  )
  return true
}

/**
 * Emit a startup warning when dashboard open mode is explicitly enabled.
 * Open mode is intentionally supported for local development but should
 * never be used on shared or non-local deployments.
 */
export function warnIfDashboardOpenMode(
  config: {
    dashboard: { enabled: boolean; allow_open_mode: boolean; api_secret?: string }
  },
  log: (message: string) => void = console.error,
): boolean {
  const hasSecret =
    typeof config.dashboard.api_secret === 'string' && config.dashboard.api_secret.length > 0
  const isOpenMode = config.dashboard.enabled && config.dashboard.allow_open_mode && !hasSecret
  if (!isOpenMode) return false

  log(
    '[helio] Warning: dashboard sideband API is running in OPEN MODE because ' +
      'dashboard.api_secret is unset and dashboard.allow_open_mode=true. ' +
      'Dashboard endpoints accept unauthenticated requests. Use only on trusted ' +
      'localhost and set dashboard.api_secret before any shared or non-local deployment.',
  )
  return true
}
