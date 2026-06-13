import { Hono } from 'hono'
import { z } from 'zod'
import type { ApprovalRouter } from './router.js'
import { NATIVE_CHANNEL_PREFIX } from './router.js'
import type { ApprovalQueue } from './queue.js'
import type { ApprovalStatus } from './types.js'
import { verifyBearer } from '../auth/bearer.js'
import { clampInt } from '../util/clamp.js'
import { formatZodErrors } from '../util/format-zod-errors.js'

// ---------------------------------------------------------------------------
// Request body schemas
// ---------------------------------------------------------------------------

const approveBody = z.object({
  approved_by: z.string().min(1),
})

const denyBody = z.object({
  denied_by: z.string().min(1),
  reason: z.string().optional(),
})

const breakGlassBody = z.object({
  approved_by: z.string().min(1),
  reason: z.string().min(1),
})

const APPROVAL_STATUSES = [
  'pending',
  'approved',
  'denied',
  'timeout',
  'break_glass',
  'client_disconnected',
  'shutdown_cancelled',
  'cancelled',
] as const
const approvalStatusSet = new Set<ApprovalStatus>(APPROVAL_STATUSES)

const listApprovalsQuery = z.object({
  status: z.preprocess(
    (value) =>
      typeof value === 'string' && approvalStatusSet.has(value as ApprovalStatus)
        ? value
        : undefined,
    z.enum(APPROVAL_STATUSES).optional(),
  ),
  limit: z.preprocess(
    (value) => clampInt(typeof value === 'string' ? value : undefined, 50, 1, 1000),
    z.number().int(),
  ),
  offset: z.preprocess(
    (value) =>
      clampInt(typeof value === 'string' ? value : undefined, 0, 0, Number.MAX_SAFE_INTEGER),
    z.number().int(),
  ),
})

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

/** Options for the approval REST API. */
export interface ApprovalAppOptions {
  /** Bearer token for authenticating POST requests. When set, POST endpoints
   *  require an `Authorization: Bearer <token>` header. GET endpoints remain
   *  unprotected for dashboard / monitoring read access. */
  readonly apiSecret?: string
}

// ---------------------------------------------------------------------------
// Approval REST API
// ---------------------------------------------------------------------------

/**
 * Create a Hono app for the approval REST API.
 *
 * Mounted exclusively on the dashboard sideband under `/api/approvals`.
 * The dashboard sideband's own bearer middleware covers every `/api/*`
 * path, so callers pass `apiSecret: undefined` here to avoid double
 * authentication. Provides endpoints for listing, inspecting,
 * approving, and denying approval tickets.
 *
 * Used by:
 * - Webhook callbacks
 * - Dashboard UI
 * - Programmatic/CLI access (through the dashboard sideband port)
 */
export function createApprovalApp(
  router: ApprovalRouter,
  queue: ApprovalQueue,
  options?: ApprovalAppOptions,
): Hono {
  const app = new Hono()
  const apiSecret = options?.apiSecret

  // Bearer token auth — protects POST (mutating) endpoints only.
  // GET endpoints remain open for dashboard / monitoring read access.
  if (apiSecret) {
    app.use('*', async (c, next) => {
      if (c.req.method !== 'POST') return next()

      // verifyBearer hashes both sides before timingSafeEqual so the
      // comparison runs in constant time regardless of header length — no
      // length-based fast-exit leak.
      if (!verifyBearer(c.req.header('authorization'), apiSecret)) {
        return c.json({ error: 'Unauthorized' }, 401)
      }
      return next()
    })
  }

  // GET / — list approval tickets with offset-based pagination.
  //
  // `queue.list()` returns tickets in Map-insertion order (oldest first),
  // which is the wrong end for a human reviewing pending approvals. Sort
  // newest-first by `requestedAt` before slicing so that `?offset=0`
  // returns the most recent page regardless of how big the queue gets.
  // `limit` defaults to 50 with a ceiling of 1000 — the same range as
  // `/api/audit` on the dashboard sideband.
  app.get('/', (c) => {
    const query = listApprovalsQuery.parse(c.req.query())
    const filter = query.status ? { status: query.status } : undefined
    const limit = query.limit
    const offset = query.offset

    const all = queue.list(filter)
    const sorted = [...all].sort(
      (a, b) => new Date(b.requested_at).getTime() - new Date(a.requested_at).getTime(),
    )
    const tickets = sorted.slice(offset, offset + limit)

    return c.json({ data: tickets, total: all.length, limit, offset })
  })

  // GET /:id — get a single ticket
  app.get('/:id', (c) => {
    const ticket = queue.get(c.req.param('id'))
    if (!ticket) {
      return c.json({ error: 'Ticket not found' }, 404)
    }
    return c.json({ data: ticket })
  })

  // POST /:id/approve — approve a pending ticket
  app.post('/:id/approve', async (c) => {
    const ticketId = c.req.param('id')

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400)
    }

    const result = approveBody.safeParse(body)
    if (!result.success) {
      return c.json({ error: 'Validation error', details: formatZodErrors(result.error) }, 400)
    }

    // Check if ticket exists first (for proper 404 vs 409)
    const ticket = queue.get(ticketId)
    if (!ticket) {
      return c.json({ error: 'Ticket not found' }, 404)
    }
    if (ticket.channel_name.startsWith(NATIVE_CHANNEL_PREFIX)) {
      // Adapter-owned approval (issue #12, D10): a dashboard decision cannot
      // reach the adapter's native UI, so resolving here would record control
      // that never propagated. Direct the operator to the owning surface.
      return c.json(
        {
          error: 'native_ticket',
          resolve_in: ticket.channel_name.slice(NATIVE_CHANNEL_PREFIX.length),
        },
        409,
      )
    }
    if (ticket.status !== 'pending') {
      return c.json({ error: 'Ticket already resolved', status: ticket.status }, 409)
    }

    const approved = router.approve(ticketId, result.data.approved_by)
    if (!approved) {
      return c.json({ error: 'Failed to approve ticket' }, 409)
    }

    return c.json({ ok: true }, 200)
  })

  // POST /:id/deny — deny a pending ticket
  app.post('/:id/deny', async (c) => {
    const ticketId = c.req.param('id')

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400)
    }

    const result = denyBody.safeParse(body)
    if (!result.success) {
      return c.json({ error: 'Validation error', details: formatZodErrors(result.error) }, 400)
    }

    // Check if ticket exists first (for proper 404 vs 409)
    const ticket = queue.get(ticketId)
    if (!ticket) {
      return c.json({ error: 'Ticket not found' }, 404)
    }
    if (ticket.channel_name.startsWith(NATIVE_CHANNEL_PREFIX)) {
      // Adapter-owned approval (issue #12, D10): a dashboard decision cannot
      // reach the adapter's native UI, so resolving here would record control
      // that never propagated. Direct the operator to the owning surface.
      return c.json(
        {
          error: 'native_ticket',
          resolve_in: ticket.channel_name.slice(NATIVE_CHANNEL_PREFIX.length),
        },
        409,
      )
    }
    if (ticket.status !== 'pending') {
      return c.json({ error: 'Ticket already resolved', status: ticket.status }, 409)
    }

    const denied = router.deny(ticketId, result.data.denied_by, result.data.reason)
    if (!denied) {
      return c.json({ error: 'Failed to deny ticket' }, 409)
    }

    return c.json({ ok: true }, 200)
  })

  // POST /:id/break-glass — force-approve a pending ticket (emergency override)
  app.post('/:id/break-glass', async (c) => {
    const ticketId = c.req.param('id')

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400)
    }

    const result = breakGlassBody.safeParse(body)
    if (!result.success) {
      return c.json({ error: 'Validation error', details: formatZodErrors(result.error) }, 400)
    }

    // Check if ticket exists first (for proper 404 vs 409)
    const ticket = queue.get(ticketId)
    if (!ticket) {
      return c.json({ error: 'Ticket not found' }, 404)
    }
    if (ticket.channel_name.startsWith(NATIVE_CHANNEL_PREFIX)) {
      // Adapter-owned approval (issue #12, D10): a dashboard decision cannot
      // reach the adapter's native UI, so resolving here would record control
      // that never propagated. Direct the operator to the owning surface.
      return c.json(
        {
          error: 'native_ticket',
          resolve_in: ticket.channel_name.slice(NATIVE_CHANNEL_PREFIX.length),
        },
        409,
      )
    }
    if (ticket.status !== 'pending') {
      return c.json({ error: 'Ticket already resolved', status: ticket.status }, 409)
    }

    const resolved = router.breakGlass(ticketId, result.data.approved_by, result.data.reason)
    if (!resolved) {
      return c.json({ error: 'Failed to break-glass override ticket' }, 409)
    }

    return c.json({ ok: true }, 200)
  })

  return app
}
