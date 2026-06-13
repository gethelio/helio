import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import type { EvidenceStore } from './store.js'
import { verifyBearer } from '../auth/bearer.js'
import { formatZodErrors } from '../util/format-zod-errors.js'
import type { GovernanceService } from '../sideband/governance-service.js'
import { createGovernanceApp, isGovernancePath } from '../sideband/governance-api.js'

/** Max request body accepted on the sideband (issue #12, D1/F7). */
const SIDEBAND_BODY_LIMIT_BYTES = 1 * 1_024 * 1_024

// ---------------------------------------------------------------------------
// Request body schemas
// ---------------------------------------------------------------------------

const postEvidenceBody = z.object({
  session_id: z.string().min(1),
  tool_name: z.string().min(1),
  evidence_key: z.string().min(1),
  evidence_data: z.unknown().refine((v) => v !== undefined, { message: 'Required' }),
  ttl_seconds: z.number().int().positive().optional(),
})

const postContextBody = z.object({
  session_id: z.string().min(1),
  key: z.string().min(1),
  value: z.unknown().refine((v) => v !== undefined, { message: 'Required' }),
})

// ---------------------------------------------------------------------------
// Sideband API app
// ---------------------------------------------------------------------------

/** Options for constructing the SDK sideband Hono app. */
export interface SidebandAppOptions {
  /**
   * Bearer token for the evidence/context/session routes (the SDK scope).
   * When omitted or empty, those routes run open — useful for local
   * development when the operator has disabled the per-boot token via env.
   */
  readonly token?: string
  /**
   * Bearer token for the governance routes (the adapter scope, issue #12/F6).
   * Distinct from `token` so an SDK client cannot drive policy decisions and
   * an adapter cannot write evidence it was not granted. When omitted, the
   * governance routes run open (and only mount if `governance` is provided).
   */
  readonly adapterToken?: string
  /**
   * The governance service backing `/evaluate`, `/audit`, `/install-scan`, and
   * `/approval/:id/resolve`. When omitted, those routes return 503
   * `governance_unavailable` (evidence-only deployments, and existing tests).
   */
  readonly governance?: GovernanceService
}

/**
 * Create a Hono app for the SDK sideband API.
 *
 * The sideband API allows the Python/TypeScript SDK to report evidence
 * and context to the proxy's in-memory evidence store. It runs on a
 * separate port (default 3200) bound to 127.0.0.1 only.
 *
 * Two orthogonal defenses apply to every request:
 *
 * 1. **CORS guard.** Any request carrying an `Origin` header is rejected
 *    with 403 (including `Origin: null`), and any `OPTIONS` preflight is
 *    rejected with 403.
 *    The SDK itself never sets an `Origin` header; only browsers do. This
 *    defends against a malicious local HTML file POSTing to
 *    127.0.0.1:3200 through the user's browser.
 * 2. **Bearer auth.** When `options.token` is set, every request except
 *    `GET /healthz` must carry `Authorization: Bearer <token>`. The proxy
 *    generates a fresh token per boot and prints it to stderr so the SDK
 *    can pick it up via the `HELIO_SDK_TOKEN` env var. Health is left
 *    unauthenticated so container probes keep working.
 */
export function createSidebandApp(store: EvidenceStore, options: SidebandAppOptions = {}): Hono {
  const app = new Hono()
  const sdkToken = options.token && options.token.length > 0 ? options.token : undefined
  const adapterToken =
    options.adapterToken && options.adapterToken.length > 0 ? options.adapterToken : undefined

  // CORS guard — applied globally, fires before auth. The SDK never sends
  // an Origin header; any request that does is browser-originated traffic
  // (or a forgery) and is refused outright, including Origin: null.
  app.use('*', async (c, next) => {
    const origin = c.req.header('origin')
    if (origin) {
      return c.json({ error: 'Cross-origin requests are not allowed' }, 403)
    }
    if (c.req.method === 'OPTIONS') {
      return c.json({ error: 'CORS preflight requests are not allowed' }, 403)
    }
    await next()
  })

  // Body-size limit — bounds memory before any handler parses a body
  // (issue #12, F7). 1 MiB is generous for evidence payloads and tool inputs;
  // per-field caps (4 KiB metadata, 64 KiB tool_input) are enforced downstream.
  app.use(
    '*',
    bodyLimit({
      maxSize: SIDEBAND_BODY_LIMIT_BYTES,
      onError: (c) => c.json({ error: 'request_body_too_large' }, 413),
    }),
  )

  // Scoped bearer auth — `/healthz` stays open for probes. Governance routes
  // require the adapter-scope token; everything else requires the SDK-scope
  // token. A scope whose token is unset runs open (local dev / disabled-token
  // posture), matching the prior single-token behavior.
  app.use('*', async (c, next) => {
    if (c.req.path === '/healthz') {
      await next()
      return
    }
    const expected = isGovernancePath(c.req.path) ? adapterToken : sdkToken
    if (expected && !verifyBearer(c.req.header('authorization'), expected)) {
      return c.json({ error: 'Unauthorized' }, 401)
    }
    await next()
  })

  // Health check
  app.get('/healthz', (c) => c.json({ status: 'ok' }))

  // Governance routes (issue #12) — /evaluate, /audit, /install-scan,
  // /approval/:id/resolve. Mounted at root; return 503 when no service.
  app.route('/', createGovernanceApp(options.governance))

  // POST /evidence — SDK reports evidence from a tool output
  app.post('/evidence', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400)
    }

    const result = postEvidenceBody.safeParse(body)
    if (!result.success) {
      return c.json({ error: 'Validation error', details: formatZodErrors(result.error) }, 400)
    }

    const { session_id, tool_name, evidence_key, evidence_data, ttl_seconds } = result.data

    const writeResult = store.putEvidence(session_id, {
      evidence_key,
      data: evidence_data,
      tool_name,
      ttl_seconds,
    })

    if (!writeResult.stored) {
      if (writeResult.reason === 'closed') {
        return c.json({ error: 'sideband_shutting_down' }, 503)
      }

      return c.json(
        {
          error: 'Evidence key is not in policy allowlist',
          code: 'evidence_key_not_in_policy_allowlist',
          key: writeResult.rejectedKey,
          allowed_keys: writeResult.allowlist.allowedKeys,
          allowed_key_count: writeResult.allowlist.allowedKeyCount,
          truncated: writeResult.allowlist.truncated,
        },
        400,
      )
    }

    return c.json({ ok: true }, 201)
  })

  // POST /context — SDK sets arbitrary session context
  app.post('/context', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400)
    }

    const result = postContextBody.safeParse(body)
    if (!result.success) {
      return c.json({ error: 'Validation error', details: formatZodErrors(result.error) }, 400)
    }

    const { session_id, key, value } = result.data

    const writeResult = store.putContext(session_id, key, value)
    if (!writeResult.stored) {
      return c.json({ error: 'sideband_shutting_down' }, 503)
    }

    return c.json({ ok: true }, 201)
  })

  // GET /session/:session_id/state — combined evidence + context
  app.get('/session/:session_id/state', (c) => {
    const sessionId = c.req.param('session_id')
    const state = store.getSessionState(sessionId)
    return c.json(state)
  })

  return app
}
