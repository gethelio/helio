// ---------------------------------------------------------------------------
// Typed fetch wrapper for the dashboard REST API.
//
// All paths are relative (/api/...) so they work both in production
// (same origin as the proxy sideband) and in development (Vite proxies
// /api to the sideband port via vite.config.ts).
// ---------------------------------------------------------------------------

import type {
  AuthSessionResponse,
  HealthResponse,
  FeedResponse,
  AuditListResponse,
  AuditRecord,
  AuditRecordResponse,
  ApprovalsResponse,
  ApprovalStatus,
  LimitsResponse,
  AnalyticsResponse,
  EvidenceResponse,
} from './types'

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

let activeCsrfToken: string | undefined
let unauthorizedHandler: (() => void) | undefined

export function setCsrfToken(token: string | undefined): void {
  activeCsrfToken = token
}

export function setUnauthorizedHandler(handler: (() => void) | undefined): void {
  unauthorizedHandler = handler
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const requestInit: RequestInit = { credentials: 'same-origin', ...(init ?? {}) }
  const res = await fetch(path, requestInit)
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    if (res.status === 401) {
      unauthorizedHandler?.()
    }
    throw new ApiError(text, res.status)
  }
  return res.json() as Promise<T>
}

export function qs(params: Record<string, string | number | boolean | undefined>): string {
  const entries = Object.entries(params).filter(
    (entry): entry is [string, string | number | boolean] => entry[1] !== undefined,
  )
  if (entries.length === 0) return ''
  return '?' + new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString()
}

export function authHeaders(token?: string): HeadersInit {
  if (!token) return { 'content-type': 'application/json' }
  return { 'content-type': 'application/json', 'x-helio-csrf': token }
}

// ---------------------------------------------------------------------------
// Read-only endpoints
// ---------------------------------------------------------------------------

/** Build a GET init; credentials are injected by apiFetch(). */
function getInit(): RequestInit {
  return {}
}

export function fetchHealth(): Promise<HealthResponse> {
  // Intentionally unauthenticated — /api/health is open for containers.
  return apiFetch('/api/health')
}

export function fetchAuthSession(): Promise<AuthSessionResponse> {
  return apiFetch('/api/auth/session')
}

export function loginDashboard(secret: string): Promise<AuthSessionResponse> {
  return apiFetch('/api/auth/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret }),
  })
}

export function logoutDashboard(): Promise<{ ok: true }> {
  return apiFetch('/api/auth/logout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
}

export interface FeedParams {
  limit?: number
  offset?: number
}

export function fetchFeed(params?: FeedParams): Promise<FeedResponse> {
  return apiFetch('/api/feed' + qs({ limit: params?.limit, offset: params?.offset }), getInit())
}

export interface AuditParams {
  tool?: string
  decision?: string
  reason?: string
  blocked?: boolean
  session?: string
  agent?: string
  from?: string
  to?: string
  destructive?: boolean
  dry_run?: boolean
  upstream_status_min?: number
  upstream_status_max?: number
  offset?: number
  limit?: number
}

export function fetchAudit(params?: AuditParams): Promise<AuditListResponse> {
  return apiFetch(
    '/api/audit' +
      qs({
        tool: params?.tool,
        decision: params?.decision,
        reason: params?.reason,
        blocked: params?.blocked,
        session: params?.session,
        agent: params?.agent,
        from: params?.from,
        to: params?.to,
        destructive: params?.destructive,
        dry_run: params?.dry_run,
        upstream_status_min: params?.upstream_status_min,
        upstream_status_max: params?.upstream_status_max,
        offset: params?.offset,
        limit: params?.limit,
      }),
    getInit(),
  )
}

export function fetchAuditRecord(id: string): Promise<AuditRecord> {
  return apiFetch<AuditRecordResponse>('/api/audit/' + encodeURIComponent(id), getInit()).then(
    (r) => r.data,
  )
}

export function fetchApprovals(
  status?: ApprovalStatus,
  pagination?: { limit?: number; offset?: number },
): Promise<ApprovalsResponse> {
  return apiFetch(
    '/api/approvals' +
      qs({
        status,
        limit: pagination?.limit ?? 1000,
        offset: pagination?.offset ?? 0,
      }),
    getInit(),
  )
}

export function fetchLimits(): Promise<LimitsResponse> {
  return apiFetch('/api/limits', getInit())
}

export function fetchAnalytics(from?: string, to?: string): Promise<AnalyticsResponse> {
  return apiFetch('/api/analytics' + qs({ from, to }), getInit())
}

export function fetchEvidence(sessionId: string): Promise<EvidenceResponse> {
  return apiFetch('/api/evidence/' + encodeURIComponent(sessionId), getInit())
}

// ---------------------------------------------------------------------------
// Mutating endpoints (require API secret)
// ---------------------------------------------------------------------------

export function approveTicket(id: string, approvedBy: string): Promise<void> {
  return apiFetch('/api/approvals/' + encodeURIComponent(id) + '/approve', {
    method: 'POST',
    headers: authHeaders(activeCsrfToken),
    body: JSON.stringify({ approved_by: approvedBy }),
  }).then(() => undefined)
}

export function denyTicket(id: string, deniedBy: string, reason?: string): Promise<void> {
  return apiFetch('/api/approvals/' + encodeURIComponent(id) + '/deny', {
    method: 'POST',
    headers: authHeaders(activeCsrfToken),
    body: JSON.stringify({ denied_by: deniedBy, reason }),
  }).then(() => undefined)
}

export function breakGlassTicket(id: string, approvedBy: string, reason: string): Promise<void> {
  return apiFetch('/api/approvals/' + encodeURIComponent(id) + '/break-glass', {
    method: 'POST',
    headers: authHeaders(activeCsrfToken),
    body: JSON.stringify({ approved_by: approvedBy, reason }),
  }).then(() => undefined)
}
