/* eslint-disable no-console -- surfaces operator-visible startup warnings */

import { parseDuration } from './config/schema.js'
import { isSecretDigest } from './auth/bearer.js'

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

/**
 * Emit a startup warning for every budget whose replay horizon exceeds
 * `audit.retention`. The budget ledger is purged on the audit retention
 * sweep, so a duration window (or a session pot's `idle_ttl`) longer than
 * the retention loses its oldest rows while they still matter: a restart
 * then under-counts the pot and silently re-opens spend the window should
 * still be holding. Surfaced at boot because the misconfiguration is
 * otherwise invisible until a restart.
 */
export function warnIfBudgetWindowExceedsRetention(
  config: {
    budgets: ReadonlyArray<{ name: string; window: string; idle_ttl?: string }>
    audit: { retention: string }
  },
  log: (message: string) => void = console.error,
): boolean {
  const retentionMs = parseDuration(config.audit.retention)
  let warned = false
  for (const budget of config.budgets) {
    const horizonMs =
      budget.window === 'session'
        ? parseDuration(budget.idle_ttl ?? '24h')
        : parseDuration(budget.window)
    const horizonLabel =
      budget.window === 'session'
        ? `idle_ttl ${budget.idle_ttl ?? '24h'}`
        : `window ${budget.window}`
    if (horizonMs <= retentionMs) continue
    log(
      `[helio] Warning: budget "${budget.name}" has ${horizonLabel}, longer than ` +
        `audit.retention ${config.audit.retention}. The spend ledger is purged on the ` +
        'retention sweep, so a restart can forget in-window spend and re-open the pot. ' +
        'Raise audit.retention or shorten the budget window.',
    )
    warned = true
  }
  return warned
}

/**
 * Emit a warning when a named config declares more than 16 upstreams. Each
 * upstream runs its own connection or child process plus an annotation prime
 * loop, so a very wide proxy multiplies that cost — the guardrail nudges the
 * operator to consider splitting the deployment. Warning-only: nothing
 * refuses to run (issue #293).
 */
export function warnIfManyUpstreams(
  config: { upstreams: ReadonlyArray<unknown> },
  log: (message: string) => void = console.error,
): boolean {
  const count = config.upstreams.length
  if (count <= 16) return false
  log(
    `[helio] Warning: ${String(count)} upstreams configured. Each upstream runs its own ` +
      'upstream connection or child process plus an annotation prime loop; consider ' +
      'whether one proxy should govern this many.',
  )
  return true
}

/**
 * Emit a warning for every stdio upstream entry that carries a `url`. The
 * stdio forwarder spawns `command` and never reads a URL, so a present value
 * (tolerated since issue #313 for legacy placeholder configs) is a silent
 * dead field that can mislead a reader into thinking the proxy talks to that
 * address. Warning-only: the config stays valid and nothing refuses to run.
 */
export function warnIfStdioUrlIgnored(
  config: {
    upstream?: { transport: string; url?: string }
    upstreams?: ReadonlyArray<{ transport: string; url?: string }>
  },
  log: (message: string) => void = console.error,
): boolean {
  let warned = false
  const warn = (path: string): void => {
    log(
      `[helio] Warning: ${path} is ignored when transport is "stdio" (the stdio ` +
        'forwarder spawns "command"). Remove the field to silence this warning.',
    )
    warned = true
  }
  if (config.upstream?.transport === 'stdio' && config.upstream.url !== undefined) {
    warn('upstream.url')
  }
  config.upstreams?.forEach((entry, index) => {
    if (entry.transport === 'stdio' && entry.url !== undefined) {
      warn(`upstreams.${String(index)}.url`)
    }
  })
  return warned
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

/**
 * Emit a startup warning when the dashboard secret is a plaintext literal in
 * the config file. The digest form (`sha256:<hex>`) and a value supplied
 * through `${VAR}` interpolation draw no warning: the digest yields nothing
 * to a reader of the file, and the environment path is the documented
 * container posture.
 */
export function warnIfDashboardSecretLiteral(
  config: { dashboard: { enabled: boolean; api_secret?: string } },
  source: { configPath: string; interpolatedPaths: readonly string[] },
  log: (message: string) => void = console.error,
): boolean {
  const secret = config.dashboard.api_secret
  if (!config.dashboard.enabled) return false
  if (typeof secret !== 'string' || secret.length === 0) return false
  if (isSecretDigest(secret)) return false
  if (source.interpolatedPaths.includes('dashboard.api_secret')) return false

  log(
    `[helio] Warning: dashboard.api_secret is stored as plaintext in ${source.configPath}. ` +
      'Anyone who can read this file holds the operator credential and can approve ' +
      'tickets. Run `helio secret`, store the printed digest as dashboard.api_secret, ' +
      'and restart.',
  )
  return true
}

/**
 * Emit a startup warning when the loaded policy enforces nothing — zero rules
 * with `default: allow`. In that state Helio records a full audit trail but
 * blocks no tool calls, which is easy to miss in the "Policies: 0 rules loaded
 * (default: allow)" line. Dry-run is excluded: it forwards nothing upstream, so
 * "not blocking" would be misleading.
 */
export function warnIfNoEnforcement(
  policy: {
    rules: ReadonlyArray<unknown>
    defaultAction: 'allow' | 'deny'
    dryRun?: boolean
  },
  log: (message: string) => void = console.error,
): boolean {
  if (policy.rules.length > 0 || policy.defaultAction !== 'allow' || policy.dryRun) return false

  log(
    '[helio] No policy rules are loaded and the default action is "allow" - ' +
      'Helio is recording an audit trail but NOT blocking anything. Add rules ' +
      'under `policies:` in helio.yaml to start enforcing (see docs/policies.md).',
  )
  return true
}
