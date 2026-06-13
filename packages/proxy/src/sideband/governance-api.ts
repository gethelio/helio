import { Hono } from 'hono'
import type { Context } from 'hono'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import type { GovernanceService } from './governance-service.js'
import { canonicalize } from '../util/canonical-json.js'
import { formatZodErrors } from '../util/format-zod-errors.js'

// ---------------------------------------------------------------------------
// Request schemas (issue #12). snake_case crosses the wire; the contract is
// framework-neutral (D13) — no adapter-specific field names or enums.
// ---------------------------------------------------------------------------

const originSchema = z
  .string()
  .regex(/^[a-z0-9_-]{1,64}$/, 'origin must match ^[a-z0-9_-]{1,64}$')
  .default('sideband')

const metadataSchema = z.record(z.string(), z.unknown()).nullish()

const toolDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  input_schema: z.unknown().optional(),
  output_schema: z.unknown().optional(),
  title: z.string().optional(),
  annotations: z.record(z.string(), z.unknown()).optional(),
})

const evaluateBody = z.object({
  origin: originSchema,
  adapter_version: z.string().max(64).optional(),
  agent_id: z.string().nullish(),
  session_id: z.string().nullish(),
  tool: toolDefinitionSchema,
  arguments: z.record(z.string(), z.unknown()).optional(),
  metadata: metadataSchema,
})

const installScanBody = z.object({
  origin: originSchema,
  agent_id: z.string().nullish(),
  session_id: z.string().nullish(),
  package: z.object({
    name: z.string().min(1),
    version: z.string().optional(),
    source: z.string().max(64).optional(),
    spec: z.string().optional(),
    url: z.string().optional(),
  }),
  metadata: metadataSchema,
})

const auditBody = z.object({
  evaluation_id: z.string().min(1),
  status: z.enum(['success', 'error', 'not_executed']),
  error: z.string().optional(),
  duration_ms: z.number().optional(),
  result: z.unknown().optional(),
  actual_amount: z.number().optional(),
})

const resolveBody = z.object({
  resolution: z.enum(['approved', 'denied', 'timeout', 'cancelled']),
  resolved_by: z.string().optional(),
  reason: z.string().optional(),
  scope: z.enum(['once', 'always']).optional(),
})

/** Max serialized size of the `metadata` object (D11/D15). */
const MAX_METADATA_BYTES = 4 * 1_024

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

/**
 * Build the Hono sub-app for the four sideband governance endpoints
 * (issue #12). Mounted at the sideband root by `createSidebandApp`; the
 * adapter-token bearer guard and Origin/body-size middleware are applied
 * there. When `service` is undefined, every route returns 503 so the routes
 * exist (and document themselves) even in evidence-only deployments.
 */
export function createGovernanceApp(service: GovernanceService | undefined): Hono {
  const app = new Hono()

  const unavailable = () => ({ error: 'governance_unavailable' }) as const

  app.post('/evaluate', async (c) => {
    if (!service) return c.json(unavailable(), 503)
    const parsed = await parseJson(c)
    if ('error' in parsed) return c.json(parsed.error, 400)
    const result = evaluateBody.safeParse(parsed.body)
    if (!result.success) {
      return c.json({ error: 'Validation error', details: formatZodErrors(result.error) }, 400)
    }
    if (metadataTooLarge(result.data.metadata)) {
      return c.json({ error: 'metadata_too_large' }, 413)
    }
    const r = service.evaluate({
      origin: result.data.origin,
      adapter_version: result.data.adapter_version,
      agent_id: result.data.agent_id ?? null,
      session_id: result.data.session_id ?? null,
      tool: result.data.tool,
      arguments: result.data.arguments,
      metadata: result.data.metadata ?? null,
    })
    return c.json(r.body, asStatus(r.status))
  })

  app.post('/audit', async (c) => {
    if (!service) return c.json(unavailable(), 503)
    const parsed = await parseJson(c)
    if ('error' in parsed) return c.json(parsed.error, 400)
    const result = auditBody.safeParse(parsed.body)
    if (!result.success) {
      return c.json({ error: 'Validation error', details: formatZodErrors(result.error) }, 400)
    }
    const hash = auditPayloadHash(result.data)
    const r = service.audit(result.data, hash)
    return c.json(r.body, asStatus(r.status))
  })

  app.post('/install-scan', async (c) => {
    if (!service) return c.json(unavailable(), 503)
    const parsed = await parseJson(c)
    if ('error' in parsed) return c.json(parsed.error, 400)
    const result = installScanBody.safeParse(parsed.body)
    if (!result.success) {
      return c.json({ error: 'Validation error', details: formatZodErrors(result.error) }, 400)
    }
    if (metadataTooLarge(result.data.metadata)) {
      return c.json({ error: 'metadata_too_large' }, 413)
    }
    const r = service.installScan({
      origin: result.data.origin,
      agent_id: result.data.agent_id ?? null,
      session_id: result.data.session_id ?? null,
      package: result.data.package,
      metadata: result.data.metadata ?? null,
    })
    return c.json(r.body, asStatus(r.status))
  })

  app.post('/approval/:id/resolve', async (c) => {
    if (!service) return c.json(unavailable(), 503)
    const parsed = await parseJson(c)
    if ('error' in parsed) return c.json(parsed.error, 400)
    const result = resolveBody.safeParse(parsed.body)
    if (!result.success) {
      return c.json({ error: 'Validation error', details: formatZodErrors(result.error) }, 400)
    }
    if (
      (result.data.resolution === 'approved' || result.data.resolution === 'denied') &&
      !result.data.resolved_by
    ) {
      return c.json({ error: 'resolved_by is required for approved/denied' }, 400)
    }
    const r = service.resolveApproval(c.req.param('id'), result.data)
    return c.json(r.body, asStatus(r.status))
  })

  return app
}

/** Path prefixes that the adapter-token guard (not the SDK token) protects. */
export function isGovernancePath(path: string): boolean {
  return (
    path === '/evaluate' ||
    path === '/audit' ||
    path === '/install-scan' ||
    path.startsWith('/approval/')
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function parseJson(c: Context): Promise<{ body: unknown } | { error: { error: string } }> {
  try {
    return { body: await c.req.json() }
  } catch {
    return { error: { error: 'Invalid JSON' } }
  }
}

function metadataTooLarge(metadata: Record<string, unknown> | null | undefined): boolean {
  if (metadata == null) return false
  return Buffer.byteLength(canonicalize(metadata), 'utf8') > MAX_METADATA_BYTES
}

/**
 * SHA-256 over the canonical JSON of the semantic /audit fields (D5). Key
 * order, whitespace, and omitted-vs-default fields cannot produce spurious
 * idempotency conflicts; a retry that recomputes duration_ms is an adapter bug
 * and correctly surfaces as a conflict.
 */
function auditPayloadHash(data: z.infer<typeof auditBody>): string {
  const semantic = {
    status: data.status,
    error: data.error ?? null,
    duration_ms: data.duration_ms ?? null,
    result: data.result ?? null,
    actual_amount: data.actual_amount ?? null,
  }
  return createHash('sha256').update(canonicalize(semantic)).digest('hex')
}

/** Narrow a numeric status to Hono's accepted status type. */
function asStatus(status: number): 200 | 201 | 400 | 404 | 409 | 413 | 503 {
  return status as 200 | 201 | 400 | 404 | 409 | 413 | 503
}
