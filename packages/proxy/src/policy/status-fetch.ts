// ---------------------------------------------------------------------------
// The one read of the RUNNING proxy that `helio policy status` (#396) and
// `helio report activation` (#400) share: `GET /api/policy/status` on the
// configured dashboard host and port, with the resolved dashboard secret as
// a bearer. Every refusal is a CODE plus a `detail` for the operator's
// stderr line; the report copies the code and never the detail (a base URL
// names a machine, a config path carries a username).
//
// Lives beside `status.ts` rather than in it: `status.ts` is pure and shared
// with the dashboard API, and `cli.ts` parses argv at module load, so a
// helper whose `fetch` the tests stub has to be importable on its own.
// ---------------------------------------------------------------------------

import { isSecretDigest } from '../auth/bearer.js'
import type { SnapshotAbsentReason } from '../report/activation.js'
import type { PolicyStatusReport } from './status.js'

/** The dashboard settings the fetch needs; `HelioConfig` satisfies it structurally. */
export interface DashboardTarget {
  readonly dashboard: {
    readonly enabled: boolean
    readonly host: string
    readonly port: number
    readonly api_secret?: string | undefined
  }
}

/** What the operator's stderr line may name; never copied into an artifact. */
export interface PolicyStatusFetchDetail {
  readonly base: string
  /** Where the presented secret came from, or undefined in open mode. */
  readonly source: string | undefined
  readonly configPath: string
  /** The API's error message on `status_unavailable` and `api_error`. */
  readonly message?: string
}

export type PolicyStatusFetchResult =
  | { readonly ok: true; readonly report: PolicyStatusReport }
  | {
      readonly ok: false
      readonly code: SnapshotAbsentReason
      readonly detail: PolicyStatusFetchDetail
    }

/**
 * The dashboard secret a CLI read presents, in order: the
 * HELIO_DASHBOARD_SECRET environment variable, else a plaintext
 * `dashboard.api_secret` in the loaded config, else none (open mode).
 */
export function resolveDashboardSecret(
  config: DashboardTarget,
  configPath: string,
): { secret: string | undefined; source: string | undefined } {
  const fromEnv = process.env['HELIO_DASHBOARD_SECRET']
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return { secret: fromEnv, source: 'HELIO_DASHBOARD_SECRET' }
  }
  const fromConfig = config.dashboard.api_secret
  if (fromConfig !== undefined && fromConfig.length > 0) {
    return { secret: fromConfig, source: `dashboard.api_secret in ${configPath}` }
  }
  return { secret: undefined, source: undefined }
}

/**
 * Read the running proxy's policy status: at most one loopback `GET` to
 * the configured `dashboard.host:port`, and none when the dashboard is
 * disabled or the resolved secret is a `sha256:` digest (verifyBearer
 * hashes the presented value, so a digest sent as Bearer would be a 401
 * naming the wrong cause).
 */
export async function fetchPolicyStatus(
  config: DashboardTarget,
  configPath: string,
  window: string,
): Promise<PolicyStatusFetchResult> {
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

  let response: Response
  try {
    response = await fetch(`${base}/api/policy/status?window=${encodeURIComponent(window)}`, {
      headers: secret !== undefined ? { authorization: `Bearer ${secret}` } : {},
    })
  } catch {
    return { ok: false, code: 'no_proxy_answered', detail }
  }
  if (response.status === 401) return { ok: false, code: 'secret_refused', detail }
  const body: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const message =
      typeof body === 'object' &&
      body !== null &&
      typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : `HTTP ${String(response.status)}`
    return {
      ok: false,
      code: response.status === 503 ? 'status_unavailable' : 'api_error',
      detail: { ...detail, message },
    }
  }
  return { ok: true, report: body as PolicyStatusReport }
}
