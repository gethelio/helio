// ---------------------------------------------------------------------------
// The CLI's request to the RUNNING proxy for `helio baseline accept` (issue
// #60): one `POST /api/baselines/accept` on the configured dashboard host and
// port with the resolved dashboard secret as a bearer, on the shape of the
// policy status read. Every refusal is a CODE plus a `detail` for the
// operator's stderr line; a route refusal passes through with its body.
// ---------------------------------------------------------------------------

import { isSecretDigest } from '../auth/bearer.js'
import type { DashboardTarget, PolicyStatusFetchDetail } from '../policy/status-fetch.js'
import { resolveDashboardSecret } from '../policy/status-fetch.js'

/** What the CLI sends: the tool, the door on a named config, and who accepts. */
export interface BaselineAcceptRequest {
  readonly tool: string
  readonly upstream?: string
  readonly actor: string
}

/** The route's 200 body, minus the `accepted` flag. */
export interface BaselineAccepted {
  readonly tool: string
  readonly upstream: string | null
  readonly previous_fingerprint: string
  readonly fingerprint: string
  readonly persisted: boolean
  readonly audit_record_id: string | null
}

/** The route's own refusal codes, each answered with a one-sentence suggestion. */
export type BaselineAcceptRefusalCode =
  | 'baseline_accept_requires_secret'
  | 'unknown_upstream'
  | 'unknown_tool'
  | 'door_not_primed'
  | 'not_drifted'
  | 'ambiguous_definition'

const REFUSAL_CODES: ReadonlySet<string> = new Set<BaselineAcceptRefusalCode>([
  'baseline_accept_requires_secret',
  'unknown_upstream',
  'unknown_tool',
  'door_not_primed',
  'not_drifted',
  'ambiguous_definition',
])

export type BaselineAcceptFetchResult =
  | { readonly ok: true; readonly accepted: BaselineAccepted }
  | {
      readonly ok: false
      readonly code:
        | 'dashboard_disabled'
        | 'secret_is_digest'
        | 'no_proxy_answered'
        | 'secret_refused'
        | 'api_error'
      readonly detail: PolicyStatusFetchDetail
    }
  | {
      readonly ok: false
      readonly code: BaselineAcceptRefusalCode
      readonly status: number
      readonly suggestion: string
      readonly detail: PolicyStatusFetchDetail
    }

/**
 * Ask the running proxy to accept a drifted tool's current definition: at
 * most one loopback `POST`, and none when the dashboard is disabled or the
 * resolved secret is a `sha256:` digest (a digest sent as a bearer would be
 * a 401 naming the wrong cause).
 */
export async function postBaselineAccept(
  config: DashboardTarget,
  configPath: string,
  request: BaselineAcceptRequest,
): Promise<BaselineAcceptFetchResult> {
  const host = config.dashboard.host.includes(':')
    ? `[${config.dashboard.host}]`
    : config.dashboard.host
  const base = `http://${host}:${String(config.dashboard.port)}`
  const { secret, source } = resolveDashboardSecret(config, configPath)
  const detail: PolicyStatusFetchDetail = { base, source, configPath }
  if (!config.dashboard.enabled) return { ok: false, code: 'dashboard_disabled', detail }
  if (secret !== undefined && isSecretDigest(secret)) {
    return { ok: false, code: 'secret_is_digest', detail }
  }

  const body = {
    tool: request.tool,
    ...(request.upstream === undefined ? {} : { upstream: request.upstream }),
    actor: request.actor,
  }
  let response: Response
  try {
    response = await fetch(`${base}/api/baselines/accept`, {
      method: 'POST',
      headers: {
        ...(secret !== undefined ? { authorization: `Bearer ${secret}` } : {}),
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })
  } catch {
    return { ok: false, code: 'no_proxy_answered', detail }
  }
  if (response.status === 401) return { ok: false, code: 'secret_refused', detail }
  const parsed: unknown = await response.json().catch(() => undefined)
  const record =
    typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  if (!response.ok) {
    const error = typeof record['error'] === 'string' ? record['error'] : undefined
    if (error !== undefined && REFUSAL_CODES.has(error)) {
      return {
        ok: false,
        code: error as BaselineAcceptRefusalCode,
        status: response.status,
        suggestion: typeof record['suggestion'] === 'string' ? record['suggestion'] : '',
        detail,
      }
    }
    return {
      ok: false,
      code: 'api_error',
      detail: { ...detail, message: error ?? `HTTP ${String(response.status)}` },
    }
  }
  return {
    ok: true,
    accepted: {
      tool: String(record['tool']),
      upstream: typeof record['upstream'] === 'string' ? record['upstream'] : null,
      previous_fingerprint: String(record['previous_fingerprint']),
      fingerprint: String(record['fingerprint']),
      persisted: record['persisted'] === true,
      audit_record_id:
        typeof record['audit_record_id'] === 'string' ? record['audit_record_id'] : null,
    },
  }
}
