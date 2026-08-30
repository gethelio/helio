import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import { verifyBearer } from '../auth/bearer.js'
import { cors } from 'hono/cors'
import { serveStatic } from '@hono/node-server/serve-static'
import { streamSSE } from 'hono/streaming'
import { VERSION } from '../version.js'
import type { AuditStore } from '../audit/store.js'
import { EXPORT_MAX_RECORDS, LIST_MAX_PAGE_SIZE } from '../audit/store.js'
import { recordsToCsv } from '../audit/csv.js'
import type { ApprovalRouter } from '../approval/router.js'
import type { ApprovalQueue } from '../approval/queue.js'
import { createApprovalApp } from '../approval/api.js'
import type { RateLimiter } from '../policy/rate-limiter.js'
import type { SpendLimiter } from '../policy/spend-limiter.js'
import type { EvidenceStore } from '../evidence/store.js'
import { clampInt } from '../util/clamp.js'
import { formatZodErrors } from '../util/format-zod-errors.js'
import type { DashboardEventBus } from './event-bus.js'
import { DashboardSessionStore } from './session.js'
import type { AdapterLivenessEntry } from '../sideband/governance-service.js'
import type { BudgetState } from '../budget/engine.js'
import type { BudgetEventsPage } from '../budget/ledger.js'
import { budgetEventsToCsv } from '../budget/csv.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Dependencies for the dashboard API. */
export interface DashboardAppDeps {
  readonly auditStore: AuditStore
  readonly approvalRouter: ApprovalRouter
  readonly approvalQueue: ApprovalQueue
  readonly rateLimiter: RateLimiter
  readonly spendLimiter: SpendLimiter
  readonly evidenceStore: EvidenceStore
  readonly eventBus: DashboardEventBus
  /**
   * Adapter liveness source for `GET /api/adapters` (issue #126) — a narrow
   * view of the SDK sideband's GovernanceService. Absent when the SDK
   * sideband is disabled; the endpoint then serves an empty list.
   */
  readonly adapterLiveness?: { listAdapters(): AdapterLivenessEntry[] }
  /**
   * Budget read surface for `GET /api/budgets`,
   * `GET /api/budgets/:name/events`, and
   * `GET /api/budgets/:name/events/export` (issues #14, #155) — narrow
   * views of the BudgetEngine (live pot states) and BudgetLedger (spend
   * history). Optional on the adapterLiveness pattern: absent (direct
   * embedders), the listings serve empty lists and the export serves an
   * empty artifact, all with 200.
   */
  readonly budgets?: {
    listStates(): BudgetState[]
    listEvents(name: string, page: { limit: number; offset: number }): BudgetEventsPage
    listEventsForExport(name: string, limit: number): BudgetEventsPage
  }
}

/** Options for the dashboard API. */
export interface DashboardAppOptions {
  /** Bearer token for authenticating POST (mutating) endpoints. */
  readonly apiSecret?: string
  /** Absolute path to the dashboard's built static assets directory. */
  readonly staticDir?: string
  /** SSE heartbeat interval in milliseconds. Defaults to 30 000 (30s). */
  readonly sseHeartbeatMs?: number
  /**
   * @internal Test seam for the concurrent-connection cap (issue #285), so
   * tests need not mint 256 real streams. Not wired to config — the cap is
   * a hardcoded invariant (see MAX_SSE_CONNECTIONS).
   */
  readonly maxSseConnections?: number
}

/** Lifecycle handle for dashboard app startup and shutdown. */
export interface DashboardAppLifecycle {
  readonly app: Hono
  close: () => void
}

interface DashboardAuthState {
  mode: 'bearer' | 'session'
  csrfToken?: string
}

const optionalQueryString = z.preprocess(
  (value) => (typeof value === 'string' && value.length > 0 ? value : undefined),
  z.string().optional(),
)

const optionalQueryInt = z.preprocess((value) => {
  if (typeof value !== 'string' || value.length === 0) return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}, z.number().int().optional())

const queryBoolean = z.preprocess(
  (value) => (value === 'true' ? true : value === 'false' ? false : undefined),
  z.boolean().optional(),
)

const clampedQueryInt = (fallback: number, min: number, max: number) =>
  z.preprocess(
    (value) => clampInt(typeof value === 'string' ? value : undefined, fallback, min, max),
    z.number().int(),
  )

const feedQuerySchema = z.object({
  limit: clampedQueryInt(50, 1, 200),
  offset: clampedQueryInt(0, 0, Number.MAX_SAFE_INTEGER),
  // The feed's first (and so far only) filter (issue #292): attribution is
  // the one dimension a live view needs server-side once upstreams multiply.
  upstream: optionalQueryString,
})

const auditExportQuerySchema = z.object({
  format: z.preprocess((value) => (value === 'csv' ? 'csv' : 'json'), z.enum(['json', 'csv'])),
  limit: clampedQueryInt(EXPORT_MAX_RECORDS, 1, EXPORT_MAX_RECORDS),
  tool: optionalQueryString,
  decision: optionalQueryString,
  reason: optionalQueryString,
  blocked: queryBoolean,
  dry_run: queryBoolean,
  session: optionalQueryString,
  agent: optionalQueryString,
  from: optionalQueryString,
  to: optionalQueryString,
  upstream_status_min: optionalQueryInt,
  upstream_status_max: optionalQueryInt,
  origin: optionalQueryString,
  record_kind: optionalQueryString,
  channel_id: optionalQueryString,
  sender_id: optionalQueryString,
  upstream: optionalQueryString,
  session_source: optionalQueryString,
})

const auditQuerySchema = z.object({
  limit: clampedQueryInt(50, 1, LIST_MAX_PAGE_SIZE),
  offset: clampedQueryInt(0, 0, Number.MAX_SAFE_INTEGER),
  tool: optionalQueryString,
  decision: optionalQueryString,
  reason: optionalQueryString,
  blocked: queryBoolean,
  session: optionalQueryString,
  agent: optionalQueryString,
  from: optionalQueryString,
  to: optionalQueryString,
  destructive: queryBoolean,
  dry_run: queryBoolean,
  upstream_status_min: optionalQueryInt,
  upstream_status_max: optionalQueryInt,
  origin: optionalQueryString,
  record_kind: optionalQueryString,
  channel_id: optionalQueryString,
  sender_id: optionalQueryString,
  upstream: optionalQueryString,
  session_source: optionalQueryString,
})

const budgetEventsQuerySchema = z.object({
  limit: clampedQueryInt(50, 1, LIST_MAX_PAGE_SIZE),
  offset: clampedQueryInt(0, 0, Number.MAX_SAFE_INTEGER),
})

const budgetEventsExportQuerySchema = z.object({
  format: z.preprocess((value) => (value === 'csv' ? 'csv' : 'json'), z.enum(['json', 'csv'])),
  limit: clampedQueryInt(EXPORT_MAX_RECORDS, 1, EXPORT_MAX_RECORDS),
})

const analyticsQuerySchema = z.object({
  from: optionalQueryString,
  to: optionalQueryString,
  upstream: optionalQueryString,
})

const authSessionBodySchema = z.object({
  secret: z.string(),
})

const SESSION_COOKIE = 'helio_session'
const SESSION_TTL_MS = 8 * 60 * 60 * 1_000

function parseCookieValue(cookieHeader: string | undefined, key: string): string | undefined {
  if (!cookieHeader) return undefined
  const pairs = cookieHeader.split(';')
  for (const pair of pairs) {
    const [rawName, ...rest] = pair.trim().split('=')
    if (rawName !== key) continue
    try {
      return decodeURIComponent(rest.join('='))
    } catch {
      return undefined
    }
  }
  return undefined
}

function serializeCookie(
  name: string,
  value: string,
  options: { maxAgeMs: number; secure: boolean },
): string {
  const maxAgeSeconds = Math.max(0, Math.floor(options.maxAgeMs / 1_000))
  const expiresAt = new Date(Date.now() + Math.max(0, options.maxAgeMs)).toUTCString()
  const attrs = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${String(maxAgeSeconds)}`,
    `Expires=${expiresAt}`,
  ]
  if (options.secure) attrs.push('Secure')
  return attrs.join('; ')
}

function clearCookie(name: string, options: { secure: boolean }): string {
  const attrs = [
    `${name}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ]
  if (options.secure) attrs.push('Secure')
  return attrs.join('; ')
}

function shouldSetSecureCookie(url: string, xForwardedProto: string | undefined): boolean {
  if (xForwardedProto?.toLowerCase() === 'https') return true
  return new URL(url).protocol === 'https:'
}

/**
 * Whether `host` is a private-network IPv4 literal (RFC 1918).
 *
 * Validates a real dotted-quad with in-range octets, NOT a string prefix. A
 * prefix check would admit attacker-controlled DNS names such as
 * `192.168.attacker.com` or `10.evil.io`, which resolve anywhere but are
 * treated as private for CORS. Hostnames (any non-numeric label) fail the
 * dotted-quad match and are rejected.
 */
function isPrivateIpv4(host: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!match) return false
  const a = Number(match[1])
  const b = Number(match[2])
  const c = Number(match[3])
  const d = Number(match[4])
  if (a > 255 || b > 255 || c > 255 || d > 255) return false
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

// ---------------------------------------------------------------------------
// SSE connection cap (issue #285)
// ---------------------------------------------------------------------------

// Hard cap on concurrent GET /api/events streams. Generous relative to
// realistic operator-dashboard tab counts: one browser profile holds at
// most ~6 concurrent streams over HTTP/1.1, so 256 covers 40+ simultaneous
// browser profiles plus scripted consumers. Hardcoded on purpose (no
// config knob), mirroring the transport /sse session cap: a knob that
// raises or disables the cap silently disables a resource bound.
//
// Unlike /sse — where lastActivity refreshes only on successful writes, so
// a held-open unproven session goes idle and is swept — this endpoint
// heartbeats its connections and refreshes lastWrite on every RESOLVED
// write, so held-open authorized tabs pin the cap BY DESIGN: anyone who
// can pin it already holds the operator credential (or local access in
// explicitly-enabled open mode) on an auth-gated loopback port, and
// keeping live operator views alive is the heartbeat's entire purpose.
// The operator remedy is closing tabs or a restart.
const MAX_SSE_CONNECTIONS = 256

// Cap-refusal log window: time-based, one summary line per window, so log
// volume does not scale with a refused client's retry rate (mirroring the
// transport /sse cap's throttle).
const REFUSAL_LOG_WINDOW_MS = 10_000

// ---------------------------------------------------------------------------
// Dashboard API factory
// ---------------------------------------------------------------------------

/**
 * Create a Hono app for the dashboard REST + SSE API.
 *
 * Served on a separate port (default 3100) via `startSidebandServer()`.
 * Provides read access to audit, approval, limit, and evidence data,
 * plus write access to approval actions (approve/deny/break-glass).
 */
export function createDashboardAppWithLifecycle(
  deps: DashboardAppDeps,
  options?: DashboardAppOptions,
): DashboardAppLifecycle {
  const {
    auditStore,
    approvalRouter,
    approvalQueue,
    rateLimiter,
    spendLimiter,
    evidenceStore,
    eventBus,
    adapterLiveness,
    budgets,
  } = deps
  const apiSecret = options?.apiSecret
  const sessionStore = apiSecret
    ? new DashboardSessionStore({ secret: apiSecret, ttlMs: SESSION_TTL_MS })
    : undefined

  const app = new Hono<{ Variables: { auth?: DashboardAuthState } }>()

  // Unhandled Error exceptions are normalized to JSON 500 with an `error`
  // field (without this they fall through to Hono's default text/plain 500);
  // the error details are logged server-side only and never reach the client.
  // HTTPExceptions keep their intended response.
  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse()
    // eslint-disable-next-line no-console -- Intentional operational error log
    console.error('[helio] Unhandled dashboard API error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  })

  // CORS — needed during development when React dev server (e.g. port 5173)
  // calls the dashboard API (port 3100). In production/Docker the SPA is served
  // same-origin so CORS isn't triggered. Admits localhost plus validated
  // private-network IPv4 literals (Docker bridge, LAN); every other origin,
  // including hostnames, gets no CORS headers.
  app.use(
    '*',
    cors({
      origin: (origin) => {
        if (!origin) return origin
        try {
          const url = new URL(origin)
          const h = url.hostname
          if (h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0') return origin
          if (isPrivateIpv4(h)) return origin
        } catch {
          // Invalid origin URL — reject
        }
        return null
      },
    }),
  )

  // API auth middleware — when apiSecret is configured, every /api/* route
  // except health and auth session endpoints requires either:
  // - Authorization: Bearer <apiSecret>, or
  // - a valid dashboard session cookie.
  if (apiSecret) {
    app.use('/api/*', async (c, next) => {
      if (
        c.req.path === '/api/health' ||
        c.req.path === '/api/auth/session' ||
        c.req.path === '/api/auth/logout'
      ) {
        return next()
      }

      const headerAuth = c.req.header('authorization')
      if (verifyBearer(headerAuth, apiSecret)) {
        c.set('auth', { mode: 'bearer' })
        return next()
      }

      const sessionToken = parseCookieValue(c.req.header('cookie'), SESSION_COOKIE)
      const session = sessionToken ? sessionStore?.validate(sessionToken) : undefined
      if (!session) {
        return c.json({ error: 'Unauthorized' }, 401)
      }

      c.set('auth', { mode: 'session', csrfToken: session.csrfToken })
      return next()
    })

    // CSRF guard for mutating requests that authenticate via cookie session.
    app.use('/api/*', async (c, next) => {
      if (
        c.req.path === '/api/health' ||
        c.req.path === '/api/auth/session' ||
        c.req.path === '/api/auth/logout'
      ) {
        return next()
      }
      if (c.req.method === 'GET' || c.req.method === 'HEAD' || c.req.method === 'OPTIONS') {
        return next()
      }

      const auth = c.get('auth')
      if (auth?.mode !== 'session') return next()
      const csrfHeader = c.req.header('x-helio-csrf')
      if (!csrfHeader || csrfHeader !== auth.csrfToken) {
        return c.json({ error: 'Invalid CSRF token' }, 403)
      }
      return next()
    })
  }

  // -------------------------------------------------------------------------
  // Health
  // -------------------------------------------------------------------------

  app.get('/api/health', (c) => {
    return c.json({ status: 'ok', version: VERSION, uptime: process.uptime() })
  })

  // -------------------------------------------------------------------------
  // Auth session
  // -------------------------------------------------------------------------

  app.get('/api/auth/session', (c) => {
    if (!apiSecret) {
      return c.json({ auth_required: false, authenticated: true })
    }

    const bearerAuth = c.req.header('authorization')
    if (verifyBearer(bearerAuth, apiSecret)) {
      return c.json({ auth_required: true, authenticated: true })
    }

    const token = parseCookieValue(c.req.header('cookie'), SESSION_COOKIE)
    const session = token ? sessionStore?.validate(token) : undefined
    if (!session) {
      return c.json({ auth_required: true, authenticated: false })
    }

    return c.json({
      auth_required: true,
      authenticated: true,
      expires_at: new Date(session.expiresAtMs).toISOString(),
      csrf_token: session.csrfToken,
    })
  })

  app.post('/api/auth/session', async (c) => {
    if (!apiSecret) {
      return c.json({ auth_required: false, authenticated: true })
    }

    let rawBody: unknown
    try {
      rawBody = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400)
    }

    const bodyResult = authSessionBodySchema.safeParse(rawBody)
    if (!bodyResult.success) {
      return c.json({ error: 'Validation error', details: formatZodErrors(bodyResult.error) }, 400)
    }
    const body = bodyResult.data
    if (!verifyBearer(`Bearer ${body.secret}`, apiSecret)) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    const session = sessionStore?.create()
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const secure = shouldSetSecureCookie(c.req.url, c.req.header('x-forwarded-proto'))
    c.header(
      'set-cookie',
      serializeCookie(SESSION_COOKIE, session.token, { maxAgeMs: SESSION_TTL_MS, secure }),
    )
    return c.json({
      auth_required: true,
      authenticated: true,
      expires_at: new Date(session.expiresAtMs).toISOString(),
      csrf_token: session.csrfToken,
    })
  })

  app.post('/api/auth/logout', (c) => {
    const token = parseCookieValue(c.req.header('cookie'), SESSION_COOKIE)
    if (token) sessionStore?.revoke(token)
    const secure = shouldSetSecureCookie(c.req.url, c.req.header('x-forwarded-proto'))
    c.header('set-cookie', clearCookie(SESSION_COOKIE, { secure }))
    return c.json({ ok: true })
  })

  // -------------------------------------------------------------------------
  // Feed — recent actions (newest first, simple pagination)
  // -------------------------------------------------------------------------

  app.get('/api/feed', (c) => {
    const query = feedQuerySchema.parse(c.req.query())
    const limit = query.limit
    const offset = query.offset

    const result = auditStore.list({ upstream: query.upstream }, { limit, offset, order: 'desc' })
    return c.json({
      data: result.records,
      total: result.total,
      limit: result.limit,
      offset: result.offset,
    })
  })

  // -------------------------------------------------------------------------
  // Audit — searchable log with filters + pagination
  // -------------------------------------------------------------------------

  // Export MUST be registered before /:id to avoid matching "export" as an id
  app.get('/api/audit/export', (c) => {
    const query = auditExportQuerySchema.parse(c.req.query())
    const format = query.format
    const limit = query.limit

    const filters = {
      tool_name: query.tool,
      policy_decision: query.decision,
      block_reason: query.reason,
      blocked: query.blocked,
      dry_run: query.dry_run,
      session_id: query.session,
      agent_id: query.agent,
      from: query.from,
      to: query.to,
      upstream_status_min: query.upstream_status_min,
      upstream_status_max: query.upstream_status_max,
      origin: query.origin,
      record_kind: query.record_kind,
      channel_id: query.channel_id,
      sender_id: query.sender_id,
      upstream: query.upstream,
      session_source: query.session_source,
    }

    const result = auditStore.listForExport(filters, limit)

    if (format === 'csv') {
      const csv = recordsToCsv(result.records)
      return new Response(csv, {
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': 'attachment; filename="helio-audit-export.csv"',
        },
      })
    }

    return new Response(JSON.stringify(result.records, null, 2), {
      headers: {
        'content-type': 'application/json',
        'content-disposition': 'attachment; filename="helio-audit-export.json"',
      },
    })
  })

  app.get('/api/audit/:id', (c) => {
    const record = auditStore.get(c.req.param('id'))
    if (!record) {
      return c.json({ error: 'Record not found' }, 404)
    }
    return c.json({ data: record })
  })

  app.get('/api/audit', (c) => {
    const query = auditQuerySchema.parse(c.req.query())
    const limit = query.limit
    const offset = query.offset

    const filters = {
      tool_name: query.tool,
      policy_decision: query.decision,
      block_reason: query.reason,
      blocked: query.blocked,
      session_id: query.session,
      agent_id: query.agent,
      from: query.from,
      to: query.to,
      flagged_destructive: query.destructive,
      dry_run: query.dry_run,
      upstream_status_min: query.upstream_status_min,
      upstream_status_max: query.upstream_status_max,
      origin: query.origin,
      record_kind: query.record_kind,
      channel_id: query.channel_id,
      sender_id: query.sender_id,
      upstream: query.upstream,
      session_source: query.session_source,
    }

    const result = auditStore.list(filters, { limit, offset, order: 'desc' })
    return c.json({
      data: result.records,
      total: result.total,
      limit: result.limit,
      offset: result.offset,
    })
  })

  // -------------------------------------------------------------------------
  // Approvals — mount the canonical approval REST API under /api/approvals.
  //
  // The approval REST API is served exclusively by this sideband. The
  // factory is intentionally created with `apiSecret: undefined` so it does
  // NOT register its own auth middleware — the dashboard's own /api/* auth
  // middleware above already covers /api/approvals/* with the same secret.
  // Double-registering the check would be redundant at best and create
  // suppression drift at worst if the two middlewares ever diverged.
  // -------------------------------------------------------------------------

  const approvalApp = createApprovalApp(approvalRouter, approvalQueue, {
    apiSecret: undefined,
  })
  app.route('/api/approvals', approvalApp)

  // -------------------------------------------------------------------------
  // Limits — combined rate + spend limit status
  // -------------------------------------------------------------------------

  app.get('/api/limits', (c) => {
    return c.json({
      rate_limits: rateLimiter.listKeyStates(),
      spend_limits: spendLimiter.listKeyStates(),
    })
  })

  // Adapter liveness (issue #126) — same raw envelope as /api/limits. Empty
  // (not 404/503) without the SDK sideband, so dashboards need no probe.
  app.get('/api/adapters', (c) => {
    return c.json({ adapters: adapterLiveness?.listAdapters() ?? [] })
  })

  // -------------------------------------------------------------------------
  // Budgets (issue #14) — named cross-tool spend pots
  // -------------------------------------------------------------------------

  // Raw envelope like /api/limits, but configured budgets appear even with
  // zero live buckets — the dashboard shows every pot at full headroom.
  app.get('/api/budgets', (c) => {
    return c.json({ budgets: budgets?.listStates() ?? [] })
  })

  // One budget's spend history (ledger rows), newest first. An unknown name
  // lists nothing with 200: names are config, not secrets, and 404 semantics
  // would race hot-reloads.
  app.get('/api/budgets/:name/events', (c) => {
    const query = budgetEventsQuerySchema.parse(c.req.query())
    const page = budgets?.listEvents(c.req.param('name'), {
      limit: query.limit,
      offset: query.offset,
    }) ?? { events: [], total: 0 }
    return c.json({
      data: page.events,
      total: page.total,
      limit: query.limit,
      offset: query.offset,
    })
  })

  // Bulk ledger export (issue #155) — the audit export's contract
  // (attachment download, bare body, EXPORT_MAX_RECORDS cap) with the
  // listing's own semantics: newest first, history across config resets,
  // unknown names and an absent dep export empty. Newest-first is the
  // deliberate opposite of the audit export: with no time filters, a capped
  // export must keep the most recent spend reachable. The filename embeds
  // the budget name stripped to the config-name charset so the arbitrary
  // route param can never reach the header raw.
  app.get('/api/budgets/:name/events/export', (c) => {
    const query = budgetEventsExportQuerySchema.parse(c.req.query())
    const name = c.req.param('name')
    const page = budgets?.listEventsForExport(name, query.limit) ?? { events: [], total: 0 }

    const safeName = name.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64)
    const filename = safeName ? `helio-budget-${safeName}-events` : 'helio-budget-events'

    if (query.format === 'csv') {
      return new Response(budgetEventsToCsv(page.events), {
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="${filename}.csv"`,
        },
      })
    }

    return new Response(JSON.stringify(page.events, null, 2), {
      headers: {
        'content-type': 'application/json',
        'content-disposition': `attachment; filename="${filename}.json"`,
      },
    })
  })

  // -------------------------------------------------------------------------
  // Analytics — aggregated stats for dashboard charts
  // -------------------------------------------------------------------------

  app.get('/api/analytics', (c) => {
    const query = analyticsQuerySchema.parse(c.req.query())
    const now = new Date()
    const defaultFrom = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()
    const from = query.from ?? defaultFrom
    const to = query.to ?? now.toISOString()

    const stats = auditStore.aggregate(from, to, { upstream: query.upstream })
    return c.json(stats)
  })

  // -------------------------------------------------------------------------
  // Evidence — session evidence state
  // -------------------------------------------------------------------------

  app.get('/api/evidence/:session_id', (c) => {
    const sessionId = c.req.param('session_id')
    const session = evidenceStore.getSessionState(sessionId)
    return c.json({ data: session })
  })

  // -------------------------------------------------------------------------
  // Events — SSE stream for real-time updates
  //
  // Connections are tracked in a map for stale connection sweeping. A
  // background interval periodically removes connections that have not
  // had a successful write in over 90 seconds (3 missed heartbeats).
  // -------------------------------------------------------------------------

  const activeConnections = new Map<string, { readonly cleanup: () => void; lastWrite: number }>()
  let closed = false

  const heartbeatMs = Math.max(options?.sseHeartbeatMs ?? 30_000, 1_000)
  const staleThresholdMs = heartbeatMs * 3
  const sweepIntervalMs = Math.max(heartbeatMs * 2, 10_000)
  const maxSseConnections = options?.maxSseConnections ?? MAX_SSE_CONNECTIONS

  const sweepInterval = setInterval(() => {
    const now = Date.now()
    for (const [id, conn] of activeConnections) {
      if (now - conn.lastWrite > staleThresholdMs) {
        conn.cleanup()
        activeConnections.delete(id)
      }
    }
  }, sweepIntervalMs)
  sweepInterval.unref()

  const close = () => {
    if (closed) return
    closed = true
    clearInterval(sweepInterval)
    for (const conn of [...activeConnections.values()]) {
      conn.cleanup()
    }
    activeConnections.clear()
  }

  // Time-based cap-refusal throttle (mirroring the transport /sse cap's):
  // the first refusal logs immediately, then at most one summary per
  // window carrying the cumulative count.
  let refusalCount = 0
  let lastRefusalLogAt: number | null = null

  const logRefusal = (): void => {
    refusalCount += 1
    const now = Date.now()
    if (lastRefusalLogAt !== null && now - lastRefusalLogAt < REFUSAL_LOG_WINDOW_MS) return
    lastRefusalLogAt = now
    // eslint-disable-next-line no-console -- operational error logging
    console.error(
      `[helio] /api/events at connection cap (${String(maxSseConnections)}); refusing new streams (${String(refusalCount)} refusals so far).`,
    )
  }

  app.get('/api/events', (c) => {
    // Refuse-new at the cap, never evict: an established stream is a live
    // operator view, and evicting one would silently kill it, while
    // refuse-new fails the newcomer loudly. The refusal is an HTTP-level
    // capacity condition and mints nothing — no connId, no map entry, no
    // stream, no SSE headers.
    if (activeConnections.size >= maxSseConnections) {
      logRefusal()
      return c.json({ error: 'connection capacity reached' }, 503)
    }

    return streamSSE(c, async (stream) => {
      if (closed) return

      const connId = randomUUID()
      let streamClosed = false
      let stopHeartbeat = () => {}
      let unsubscribeFromEvents = () => {}
      let releaseStream!: () => void
      const holdOpen = new Promise<void>((resolve) => {
        releaseStream = resolve
      })

      const cleanup = () => {
        if (streamClosed) return
        streamClosed = true
        unsubscribeFromEvents()
        stopHeartbeat()
        activeConnections.delete(connId)
        releaseStream()
      }

      // Belt for the cap check above: unreachable under hono@4.12.34,
      // where streamSSE runs this callback synchronously up to its first
      // await (helper/streaming/sse.js:29-31, :62) — the initial heartbeat
      // write below, AFTER this set — so no interleaved request can be
      // admitted between the outer check and this registration. It guards
      // a future Hono that defers the callback, where two requests could
      // pass the outer check before either registers. The loser already
      // carries SSE headers (set before the callback runs, sse.js:58-62),
      // so it cannot become a 503 — close it immediately by returning; do
      // NOT hold the stream open, which would occupy the very resource
      // being refused and invite a reconnect storm. Degrade chain: one
      // immediately-closed empty 200 stream → one EventSource retry → the
      // outer check's terminal 503.
      if (activeConnections.size >= maxSseConnections) return

      activeConnections.set(connId, { cleanup, lastWrite: Date.now() })

      // Send initial heartbeat
      try {
        await stream.writeSSE({ data: '', event: 'heartbeat' })
      } catch {
        cleanup()
        return
      }

      // Subscribe to all dashboard events
      const unsubscribe = eventBus.onAny((eventType, data) => {
        void stream
          .writeSSE({
            event: eventType,
            data: JSON.stringify(data),
            id: randomUUID(),
          })
          .then(() => {
            const conn = activeConnections.get(connId)
            if (conn) conn.lastWrite = Date.now()
          })
          .catch(() => {
            // Expected on client disconnect — stream already closed
            cleanup()
          })
      })
      unsubscribeFromEvents = unsubscribe

      // Periodic heartbeat to keep connection alive
      const heartbeat = setInterval(() => {
        void stream
          .writeSSE({ data: '', event: 'heartbeat' })
          .then(() => {
            const conn = activeConnections.get(connId)
            if (conn) conn.lastWrite = Date.now()
          })
          .catch(() => {
            // Expected on client disconnect — stream already closed
            cleanup()
          })
      }, heartbeatMs)
      stopHeartbeat = () => {
        clearInterval(heartbeat)
      }

      // Clean up on client disconnect
      stream.onAbort(cleanup)

      // Hold the stream open indefinitely
      await holdOpen
    })
  })

  // -------------------------------------------------------------------------
  // /api/* 404 guard — any /api/* path that did not match an explicit route
  // above returns a JSON 404. Without this, an unknown /api/* GET would fall
  // through to the SPA catch-all below and be served the dashboard HTML with
  // status 200 — an API client probing the sideband would then try to parse
  // an HTML body as JSON and get a confusing error. The guard sits after
  // every /api/* route (so legitimate endpoints still win) and before the
  // static file mount (so unknowns never reach the SPA fallback).
  // -------------------------------------------------------------------------

  app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404))

  // -------------------------------------------------------------------------
  // Static file serving — serves the dashboard React SPA.
  //
  // Mounted AFTER all /api/* routes so API endpoints always take precedence.
  // The SPA fallback serves index.html for all non-API GET requests, so
  // React Router can handle client-side routing.
  // -------------------------------------------------------------------------

  const staticDir = options?.staticDir
  if (staticDir) {
    // Cache index.html at startup for root and SPA fallback responses.
    const indexHtml = readFileSync(join(staticDir, 'index.html'), 'utf-8')

    // Serve index.html explicitly for root and /index.html before serveStatic.
    app.get('/', (c) => c.html(indexHtml))
    app.get('/index.html', (c) => c.html(indexHtml))

    // Serve static assets (JS, CSS, images, etc.)
    app.use('/*', serveStatic({ root: staticDir }))

    // SPA fallback — any non-API GET that didn't match a static file (e.g.
    // React Router routes like /audit/abc123 that have no file on disk)
    app.get('*', (c) => c.html(indexHtml))
  }

  return {
    app: app as unknown as Hono,
    close,
  }
}

/**
 * Create a Hono app for the dashboard REST + SSE API.
 *
 * This wrapper preserves the original API for call sites that do not need
 * an explicit lifecycle close hook.
 */
export function createDashboardApp(deps: DashboardAppDeps, options?: DashboardAppOptions): Hono {
  return createDashboardAppWithLifecycle(deps, options).app
}
