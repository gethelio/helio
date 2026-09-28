// ---------------------------------------------------------------------------
// The CLI's requests to the RUNNING proxy for `helio baseline accept` and
// `helio baseline list` (issue #60): one `POST /api/baselines/accept` or one
// `GET /api/baselines` on the configured dashboard host and port with the
// resolved dashboard secret as a bearer, on the shape of the policy status
// read. Every refusal is a CODE plus a `detail` for the operator's stderr
// line; a route refusal passes through with its body.
// ---------------------------------------------------------------------------

import { z } from 'zod'
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

// ---------------------------------------------------------------------------
// helio baseline list
// ---------------------------------------------------------------------------

const baselineListEntrySchema = z.object({
  tool: z.string(),
  upstream: z.string().nullable(),
  fingerprint_sha256: z.string(),
  first_seen: z.string().nullable(),
  last_confirmed: z.string().nullable(),
  accepted_at: z.string().nullable(),
  accepted_by: z.string().nullable(),
  restored: z.boolean(),
  present: z.boolean(),
  drifted: z.boolean(),
})

/** The route's 200 body: every door asked for, with the process-wide persistence flag. */
const baselineListBodySchema = z.object({
  persist_baselines: z.boolean(),
  doors: z.array(
    z.object({
      upstream: z.string().nullable(),
      primed: z.boolean(),
      baselines: z.array(baselineListEntrySchema),
    }),
  ),
})

export type BaselineListBody = z.infer<typeof baselineListBodySchema>
export type BaselineListDoorBody = BaselineListBody['doors'][number]
export type BaselineListEntryBody = BaselineListDoorBody['baselines'][number]

export type BaselineListFetchResult =
  | { readonly ok: true; readonly body: BaselineListBody }
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
      readonly code: 'unknown_upstream'
      readonly status: number
      readonly suggestion: string
      readonly detail: PolicyStatusFetchDetail
    }

/**
 * Read the running proxy's baselines: at most one loopback `GET`, with the
 * `upstream` query only when a door is named, and the same no-socket
 * refusals as the accept request. A 200 body that fails the schema is an
 * `api_error`, never a crash in the renderer.
 */
export async function fetchBaselines(
  config: DashboardTarget,
  configPath: string,
  upstream?: string,
): Promise<BaselineListFetchResult> {
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

  const query = upstream === undefined ? '' : `?upstream=${encodeURIComponent(upstream)}`
  let response: Response
  try {
    response = await fetch(`${base}/api/baselines${query}`, {
      method: 'GET',
      headers: secret !== undefined ? { authorization: `Bearer ${secret}` } : {},
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
    if (error === 'unknown_upstream') {
      return {
        ok: false,
        code: error,
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
  const body = baselineListBodySchema.safeParse(parsed)
  if (!body.success) {
    return {
      ok: false,
      code: 'api_error',
      detail: { ...detail, message: 'unexpected response body from GET /api/baselines' },
    }
  }
  return { ok: true, body: body.data }
}
