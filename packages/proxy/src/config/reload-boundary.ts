import { isDeepStrictEqual } from 'node:util'
import type { HelioConfig } from './schema.js'
import type { CompiledPolicy } from '../policy/types.js'
import type { CompiledBudget } from '../budget/types.js'

// ---------------------------------------------------------------------------
// Reload boundary diffing
// ---------------------------------------------------------------------------

/** Result of comparing two validated configs across the hot-reload boundary. */
export interface ReloadBoundaryDiff {
  /** Config paths that changed but require process restart to take effect. */
  readonly restartRequiredPaths: readonly string[]
}

/**
 * Compare two validated configs and report changed paths that do not hot-reload.
 *
 * Hot-reload applies `policies.default`, `policies.flag_destructive`,
 * `policies.dry_run`, and `policies.rules` by swapping the compiled policy,
 * and `budgets` by reconciling the budget engine on name identity.
 * Everything else is startup-bound (listeners, upstream, dashboard, etc.) and
 * requires process restart.
 */
export function diffReloadBoundary(previous: HelioConfig, next: HelioConfig): ReloadBoundaryDiff {
  const restartRequiredPaths: string[] = []

  if (!isDeepStrictEqual(previous.upstream, next.upstream)) {
    restartRequiredPaths.push('upstream')
  }
  if (!isDeepStrictEqual(previous.listen, next.listen)) {
    restartRequiredPaths.push('listen')
  }
  if (!isDeepStrictEqual(previous.dashboard, next.dashboard)) {
    restartRequiredPaths.push('dashboard')
  }
  if (!isDeepStrictEqual(previous.environment, next.environment)) {
    restartRequiredPaths.push('environment')
  }
  if (!isDeepStrictEqual(previous.approval, next.approval)) {
    restartRequiredPaths.push('approval')
  }
  if (!isDeepStrictEqual(previous.audit, next.audit)) {
    restartRequiredPaths.push('audit')
  }
  if (!isDeepStrictEqual(previous.sdk, next.sdk)) {
    restartRequiredPaths.push('sdk')
  }

  // `budgets` is deliberately NOT in this list: budgets hot-reload (the
  // watcher recompiles them and the engine reconciles by name, issue #14).
  // Do not cargo-cult it in when adding the next top-level field.

  // `policies.hot_reload` only affects whether the watcher exists at startup.
  const previousHotReload = previous.policies.hot_reload ?? true
  const nextHotReload = next.policies.hot_reload ?? true
  if (previousHotReload !== nextHotReload) {
    restartRequiredPaths.push('policies.hot_reload')
  }

  return { restartRequiredPaths }
}

// ---------------------------------------------------------------------------
// Hot-reload approval routing guard (issue #14 break-glass)
// ---------------------------------------------------------------------------

/** The RUNNING process's approval surface — startup-bound, never reloaded. */
export interface RuntimeApprovalSurface {
  /** Runtime channel registry: key (name ?? type, plus built-in dashboard) → channel type. */
  readonly channelTypes: ReadonlyMap<string, string>
  /** Whether the dashboard server is running (startup value). */
  readonly dashboardEnabled: boolean
  /** The router's default ticket timeout (startup `approval.timeout`), ms. */
  readonly defaultApprovalTimeoutMs: number
}

/**
 * Check a reloaded policy + budgets against the RUNNING approval surface.
 *
 * Schema validation checks the new FILE for self-consistency, but approval
 * channels and the dashboard server are startup-bound: a reload that adds a
 * channel and immediately references it validates on paper while the running
 * router still holds the startup registry — the ticket would never notify
 * (or, dashboard-routed, never be resolvable). The reload must be rejected
 * atomically instead; the caller throws on a non-empty return.
 *
 * Semantics mirror the runtime exactly:
 * - Rules carrying `match.metadata` are skipped entirely — they never match
 *   on the MCP path, and their sideband tickets are native (adapter-resolved,
 *   no channel ever notified).
 * - Dashboard-routed approvals (explicit dashboard-type channel, the bare
 *   require_approval default, and the flag_destructive / on_tool_drift
 *   escalations, which always use the dashboard default) need the running
 *   dashboard — its approvals API is their only resolution surface.
 * - Delegates matter only when the escalation timer can actually fire:
 *   `0 < escalation_after < effective timeout` (the router's own guard).
 */
export function findUnroutableApprovalReferences(
  policy: CompiledPolicy,
  budgets: readonly CompiledBudget[],
  surface: RuntimeApprovalSurface,
): string[] {
  const problems: string[] = []
  const known = (key: string): boolean => surface.channelTypes.has(key)
  const isDashboardKey = (key: string): boolean => surface.channelTypes.get(key) === 'dashboard'
  const escalationCanFire = (approval: {
    readonly timeoutMs?: number
    readonly escalationAfterMs?: number
  }): boolean => {
    const timeoutMs = approval.timeoutMs ?? surface.defaultApprovalTimeoutMs
    return (
      approval.escalationAfterMs !== undefined &&
      approval.escalationAfterMs > 0 &&
      approval.escalationAfterMs < timeoutMs
    )
  }
  const needsRunningDashboard = (key: string, label: string, via: string): void => {
    if (isDashboardKey(key) && !surface.dashboardEnabled) {
      problems.push(
        `${label} ${via} the dashboard channel, but the running process has no dashboard server`,
      )
    }
  }

  for (const rule of policy.rules) {
    if (rule.action !== 'require_approval') {
      // Only approval rules raise MCP tickets; a stray approval block on any
      // other action is dead config the runtime never reads.
      continue
    }
    if (rule.match.metadata !== undefined) continue // sideband-only: native tickets
    const label = rule.name ? `rule "${rule.name}"` : `rule[${String(rule.index)}]`
    const approval = rule.approval
    const effectiveChannel = approval?.channel ?? 'dashboard'
    if (!known(effectiveChannel)) {
      problems.push(`${label} references approval channel "${effectiveChannel}"`)
    } else {
      needsRunningDashboard(effectiveChannel, label, 'routes approvals to')
    }
    if (approval && escalationCanFire(approval)) {
      for (const delegate of approval.delegates ?? []) {
        if (!known(delegate)) {
          problems.push(`${label} references delegate channel "${delegate}"`)
        } else {
          needsRunningDashboard(delegate, label, 'escalates approvals to')
        }
      }
    }
  }

  // The destructive / drift escalations submit with no matched rule, which
  // always routes to the dashboard default channel.
  if (policy.flagDestructive === 'require_approval' && !surface.dashboardEnabled) {
    problems.push(
      'policies.flag_destructive: require_approval routes approvals to the dashboard ' +
        'channel, but the running process has no dashboard server',
    )
  }
  if (policy.onToolDrift === 'require_approval' && !surface.dashboardEnabled) {
    problems.push(
      'policies.on_tool_drift: require_approval routes approvals to the dashboard ' +
        'channel, but the running process has no dashboard server',
    )
  }

  for (const budget of budgets) {
    if (budget.onExceed !== 'require_approval') continue
    const label = `budget "${budget.name}"`
    const effectiveChannel = budget.approval?.channel ?? 'dashboard'
    if (!known(effectiveChannel)) {
      problems.push(`${label} references approval channel "${effectiveChannel}"`)
    } else {
      needsRunningDashboard(effectiveChannel, label, 'routes break-glass tickets to')
    }
    if (budget.approval && escalationCanFire(budget.approval)) {
      for (const delegate of budget.approval.delegates ?? []) {
        if (!known(delegate)) {
          problems.push(`${label} references delegate channel "${delegate}"`)
        } else {
          needsRunningDashboard(delegate, label, 'escalates break-glass tickets to')
        }
      }
    }
  }

  return problems
}
