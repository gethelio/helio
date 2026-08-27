import { z } from 'zod'

// ---------------------------------------------------------------------------
// Duration strings — e.g. "300s", "5m", "1h", "90d"
// ---------------------------------------------------------------------------

const DURATION_REGEX = /^\d+[smhd]$/

/** Zod schema for duration strings (e.g. "300s", "5m", "1h", "90d"). */
export const durationSchema = z.string().regex(DURATION_REGEX, {
  message: 'Duration must be a number followed by s, m, h, or d (e.g. "300s", "1h", "90d")',
})

const DURATION_MULTIPLIERS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
}

/** Convert a validated duration string to milliseconds. */
export function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)([smhd])$/)
  if (!match) {
    throw new Error(`Invalid duration string: "${duration}"`)
  }
  const value = Number(match[1])
  const unit = match[2]
  const multiplier = unit ? DURATION_MULTIPLIERS[unit] : undefined
  if (multiplier === undefined) {
    throw new Error(`Invalid duration unit in: "${duration}"`)
  }
  return value * multiplier
}

// ---------------------------------------------------------------------------
// Upstream
// ---------------------------------------------------------------------------

/**
 * Transport/protocol headers the forwarders own on the wire. Operators can
 * neither override them upstream (upstream.headers) nor read them as a
 * session identity source (session.identity header names).
 */
const RESERVED_TRANSPORT_HEADERS = new Set([
  'mcp-session-id',
  'mcp-protocol-version',
  'content-type',
  'content-length',
  'host',
  // The Accept is Helio-owned per HTTP upstream leg: where Helio
  // advertises at all it advertises its own response parsing (the SSE
  // message POSTs assert none), so an operator value could only
  // misadvertise it, never extend it (issue #304).
  'accept',
  // Modern (2026-07-28) transport headers Helio owns on the wire for every
  // Streamable HTTP POST it sends upstream — relayed client traffic and
  // proxy-initiated requests (era probe, revalidation) alike — see
  // upstream-session-manager.ts and streamable-http-forwarder.ts.
  'mcp-method',
  'mcp-name',
])

const transportSchema = z.enum(['streamable-http', 'sse', 'stdio'])

/**
 * Upstream MCP protocol version pin (issue #219). `auto` probes the upstream
 * era via `server/discover` and caches the classification; a dated pin skips
 * the probe entirely, in both directions — it exists for deployments the
 * probe cannot classify (e.g. per-client Authorization pass-through, where
 * the probe 401s forever while relays succeed).
 */
const protocolVersionSchema = z.enum(['auto', '2025-06-18', '2026-07-28'])

const upstreamObjectSchema = z
  .object({
    url: z.string(),
    transport: transportSchema.default('streamable-http'),
    protocol_version: protocolVersionSchema.default('auto'),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    connect_timeout: durationSchema.default('10s'),
    request_timeout: durationSchema.default('30s'),
    forward_headers: z.array(z.string().min(1)).default([]),
    headers: z.record(z.string(), z.string()).default({}),
  })
  .strict()

// Shared by the singular `upstream:` schema and every named `upstreams:` entry
// (issue #293). Messages, paths, and check order are pinned by tests —
// singular configs must keep erroring byte-identically.
function upstreamEntryChecks(
  data: z.output<typeof upstreamObjectSchema>,
  ctx: z.core.$RefinementCtx,
): void {
  if (data.transport === 'stdio' && data.command === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['command'],
      message: '"command" is required when transport is "stdio"',
    })
  }

  // The modern pin only makes sense on Streamable HTTP: the SSE upstream
  // transport is the deprecated legacy transport and will never be modern,
  // and stdio modern-era support is tracked separately (#256).
  if (data.protocol_version === '2026-07-28' && data.transport !== 'streamable-http') {
    ctx.addIssue({
      code: 'custom',
      path: ['protocol_version'],
      message:
        data.transport === 'stdio'
          ? 'protocol_version "2026-07-28" requires transport "streamable-http" — ' +
            'stdio modern-era support is tracked in #256.'
          : 'protocol_version "2026-07-28" requires transport "streamable-http" — ' +
            'the SSE upstream transport is the deprecated legacy transport.',
    })
  }
  for (const [index, header] of data.forward_headers.entries()) {
    if (!header.toLowerCase().startsWith('x-')) {
      ctx.addIssue({
        code: 'custom',
        path: ['forward_headers', index],
        message: 'Forwarded caller headers must start with "x-"',
      })
    }
  }

  // Reserved transport/protocol headers must not be operator-overridden via
  // upstream.headers — the forwarders own these.
  for (const name of Object.keys(data.headers)) {
    if (RESERVED_TRANSPORT_HEADERS.has(name.toLowerCase())) {
      ctx.addIssue({
        code: 'custom',
        path: ['headers', name],
        message: `upstream.headers must not set reserved header "${name}"`,
      })
    }
  }
}

const upstreamSchema = upstreamObjectSchema.superRefine(upstreamEntryChecks)

/**
 * Upstream entry names embed in mount paths, limiter keys
 * (`upstream:<name>:…`), and audit records — the budget-name charset keeps
 * them delimiter-free so those keys stay parseable (issue #293).
 */
export const upstreamNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9_-]+$/, {
    message: 'Upstream names may only contain letters, digits, "_" and "-"',
  })

/**
 * One entry of the named `upstreams:` list: every singular `upstream:` field
 * plus a required unique `name`. The name is declared first so parsed entries
 * render name-first; the per-entry refinements are the singular schema's,
 * shared verbatim (issue #293).
 */
export const namedUpstreamEntrySchema = z
  .object({ name: upstreamNameSchema, ...upstreamObjectSchema.shape })
  .strict()
  .superRefine(upstreamEntryChecks)

/** The named `upstreams:` list — non-empty, with unique entry names (issue #293). */
export const upstreamsListSchema = z
  .array(namedUpstreamEntrySchema)
  .min(1, {
    message:
      'upstreams: must declare at least one upstream — an empty list would serve nothing. ' +
      'For a single upstream you can keep the "upstream:" form.',
  })
  .superRefine((entries, ctx) => {
    const seen = new Set<string>()
    for (const [index, entry] of entries.entries()) {
      if (seen.has(entry.name)) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'name'],
          message:
            `Duplicate upstream name "${entry.name}". Upstream names embed in mount paths, ` +
            'limiter keys, and audit records — each upstream needs its own.',
        })
      }
      seen.add(entry.name)
    }
  })

// ---------------------------------------------------------------------------
// Listen
// ---------------------------------------------------------------------------

const listenSchema = z
  .object({
    port: z.number().int().min(1).max(65535).default(3000),
    host: z.string().default('127.0.0.1'),
    /**
     * Origin allowlist for the MCP transports (issue #213). Requests to /mcp
     * or /sse carrying an Origin header not in this list are refused with 403.
     * Empty (the default) means every Origin is refused — MCP clients are
     * non-browser processes and never send one. This is NOT CORS support: the
     * proxy emits no CORS response headers, so a browser still cannot read
     * responses. The list exists for deployments where a fronting proxy or
     * embedding host injects an Origin the operator needs to name.
     */
    allowed_origins: z.array(z.string().min(1)).default([]),
  })
  .strict()
  .superRefine((data, ctx) => {
    for (const [index, entry] of data.allowed_origins.entries()) {
      if (entry === '*') {
        ctx.addIssue({
          code: 'custom',
          path: ['allowed_origins', index],
          message: 'listen.allowed_origins does not support wildcards — list each origin exactly.',
        })
        continue
      }
      if (entry === 'null') {
        ctx.addIssue({
          code: 'custom',
          path: ['allowed_origins', index],
          message:
            'The literal "null" cannot be allowlisted: it is the opaque origin sent by ' +
            'sandboxed frames, data: documents, and file:// pages, so allowing it would ' +
            'admit all of them.',
        })
        continue
      }
      let parsed: URL
      try {
        parsed = new URL(entry)
      } catch {
        ctx.addIssue({
          code: 'custom',
          path: ['allowed_origins', index],
          message: `"${entry}" is not a serialized origin. Use scheme://host[:port], e.g. "http://localhost:5173".`,
        })
        continue
      }
      // Only http(s) origins can ever appear in a browser-sent Origin header
      // on these transports. Opaque schemes (file:, chrome-extension:) serialize
      // their origin as the string "null", and other special schemes (ws:, wss:,
      // ftp:) get a tuple origin that compares equal to the entry — so without
      // this check both classes would validate and then never match.
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        ctx.addIssue({
          code: 'custom',
          path: ['allowed_origins', index],
          message: `"${entry}" is not an http(s) origin. Allowlist entries must be serialized http(s) origins, e.g. "http://localhost:5173".`,
        })
        continue
      }
      if (parsed.origin !== entry) {
        ctx.addIssue({
          code: 'custom',
          path: ['allowed_origins', index],
          message: `"${entry}" is not in serialized origin form and would never match a browser-sent Origin — did you mean "${parsed.origin}"?`,
        })
      }
    }
  })

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

function hasDashboardApiSecret(secret: string | undefined): boolean {
  return typeof secret === 'string' && secret.length > 0
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

const dashboardSchema = z
  .object({
    enabled: z.boolean().default(true),
    port: z.number().int().min(1).max(65535).default(3100),
    host: z.string().default('127.0.0.1'),
    api_secret: z.string().optional(),
    allow_open_mode: z.boolean().default(false),
    sse_heartbeat_interval: durationSchema.default('30s'),
  })
  .strict()

// ---------------------------------------------------------------------------
// Session identity (issue #218)
// ---------------------------------------------------------------------------

const sessionHeaderSourceSchema = z
  .object({
    source: z.literal('header'),
    /** Lowercased on parse — HTTP header names are case-insensitive. */
    name: z
      .string()
      .min(1)
      .default('x-helio-session-id')
      .transform((name) => name.toLowerCase()),
  })
  .strict()

// Fixed to _meta["io.modelcontextprotocol/clientInfo"] — no path parameter.
// A configurable _meta path would let identity point at model-influenced
// fields, the exact trust inversion proxy-owned identity exists to prevent.
const sessionMetaSourceSchema = z
  .object({
    source: z.literal('meta'),
  })
  .strict()

/** The verbatim Mcp-Session-Id transport header (spec deprecation window). */
const sessionLegacyHeaderSourceSchema = z
  .object({
    source: z.literal('legacy_header'),
  })
  .strict()

const sessionIdentitySourceSchema = z.discriminatedUnion('source', [
  sessionHeaderSourceSchema,
  sessionMetaSourceSchema,
  sessionLegacyHeaderSourceSchema,
])

const sessionSchema = z
  .object({
    /** Ordered identity sources; the first source that yields a value wins. */
    identity: z
      .array(sessionIdentitySourceSchema)
      .min(1, {
        message:
          'session.identity cannot be empty — an empty chain would leave every request ' +
          'unresolved. Omit the section to use the defaults, or list at least one source.',
      })
      .default([{ source: 'header', name: 'x-helio-session-id' }, { source: 'legacy_header' }]),
    on_unresolved: z.enum(['deny', 'anonymous']).default('deny'),
  })
  .strict()
  .superRefine((session, ctx) => {
    const seen = new Set<string>()
    for (const [index, entry] of session.identity.entries()) {
      if (entry.source !== 'header') continue
      if (!entry.name.startsWith('x-')) {
        ctx.addIssue({
          code: 'custom',
          path: ['identity', index, 'name'],
          message:
            'Session identity header names must start with "x-" ' +
            '(for example "x-helio-session-id")',
        })
      }
      if (RESERVED_TRANSPORT_HEADERS.has(entry.name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['identity', index, 'name'],
          message:
            `session.identity must not read reserved transport header "${entry.name}" — the ` +
            'proxy owns it on the wire. Use source: legacy_header for Mcp-Session-Id, or a ' +
            'custom x- header.',
        })
      }
      if (seen.has(entry.name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['identity', index, 'name'],
          message:
            `Duplicate session identity header "${entry.name}" — the first entry always wins, ` +
            'so the duplicate is dead config. Remove it.',
        })
      }
      seen.add(entry.name)
    }
  })

// ---------------------------------------------------------------------------
// Policy rule — match conditions
// ---------------------------------------------------------------------------

const inputConditionSchema = z
  .object({
    eq: z.unknown().optional(),
    neq: z.unknown().optional(),
    gt: z.number().optional(),
    gte: z.number().optional(),
    lt: z.number().optional(),
    lte: z.number().optional(),
    contains: z.string().optional(),
    regex: z.string().optional(),
  })
  .strict()
  .refine((obj) => Object.values(obj).some((v) => v !== undefined), {
    message: 'At least one condition operator is required',
  })

const annotationsMatchSchema = z
  .object({
    readOnlyHint: z.boolean().optional(),
    destructiveHint: z.boolean().optional(),
    idempotentHint: z.boolean().optional(),
    openWorldHint: z.boolean().optional(),
  })
  .strict()

// A metadata condition is either a bare string (eq shorthand) or an operator
// object restricted to the string-friendly subset (issue #13). Numeric
// comparators are deliberately excluded — metadata values (channel_id, …) are
// strings.
const metadataConditionSchema = z.union([
  z.string(),
  z
    .object({
      eq: z.string().optional(),
      neq: z.string().optional(),
      contains: z.string().optional(),
      regex: z.string().optional(),
    })
    .strict()
    .refine((obj) => Object.keys(obj).length > 0, {
      message: 'At least one metadata condition operator is required',
    }),
])

const matchSchema = z
  .object({
    tool: z.string().optional(),
    annotations: annotationsMatchSchema.optional(),
    input: z.record(z.string(), inputConditionSchema).optional(),
    environment: z.string().optional(),
    metadata: z.record(z.string(), metadataConditionSchema).optional(),
    /** Configured upstream names the rule is scoped to (issue #293). */
    upstreams: z
      .array(z.string().min(1))
      .min(1, {
        message: 'match.upstreams must name at least one upstream — an empty list matches nothing.',
      })
      .optional(),
  })
  .strict()

// ---------------------------------------------------------------------------
// Policy rule — action + sub-schemas
// ---------------------------------------------------------------------------

const policyActionSchema = z.enum([
  'allow',
  'deny',
  'require_approval',
  'rate_limit',
  'spend_limit',
  'dry_run',
])

const ruleApprovalSchema = z
  .object({
    channel: z.string().min(1),
    timeout: durationSchema.optional(),
    delegates: z.array(z.string().min(1)).optional(),
    escalation_after: durationSchema.optional(),
  })
  .strict()

const evidenceSchema = z
  .object({
    requires: z.array(z.string()),
  })
  .strict()

const spendLimitSchema = z
  .object({
    field: z.string(),
    limit: z.number(),
    currency: z.string(),
    window: durationSchema,
    key: z.enum(['tool', 'agent', 'session', 'sender_id']).optional(),
  })
  .strict()

const limitsSchema = z
  .object({
    max_calls: z.number().int().positive().optional(),
    window: durationSchema.optional(),
    key: z.enum(['tool', 'agent', 'session', 'sender_id']).optional(),
    max_spend: spendLimitSchema.optional(),
  })
  .strict()

const feedbackSchema = z
  .object({
    message: z.string(),
    suggestion: z.string().optional(),
  })
  .strict()

const policyRuleSchema = z
  .object({
    name: z.string().optional(),
    match: matchSchema,
    action: policyActionSchema,
    approval: ruleApprovalSchema.optional(),
    evidence: evidenceSchema.optional(),
    requires: z.array(z.string()).optional(),
    requires_success: z.boolean().optional(),
    limits: limitsSchema.optional(),
    feedback: feedbackSchema.optional(),
  })
  .strict()

// ---------------------------------------------------------------------------
// Install-time policy (issue #13 — deny_install). A separate rule list because a
// package has no tool/annotations/input to match on (issue #13).
// ---------------------------------------------------------------------------

const installMatchSchema = z
  .object({
    name: z.string().optional(), // glob, picomatch (same engine as match.tool)
    source: z.string().optional(), // exact ecosystem match (npm | pip | …)
    metadata: z.record(z.string(), metadataConditionSchema).optional(),
  })
  .strict()

const installRuleSchema = z
  .object({
    name: z.string().optional(),
    match: installMatchSchema,
    action: z.enum(['deny_install', 'allow']),
    feedback: feedbackSchema.optional(),
  })
  .strict()

const installSchema = z
  .object({
    default: z.enum(['allow', 'deny']).default('allow'),
    rules: z.array(installRuleSchema).default([]),
  })
  .strict()

// ---------------------------------------------------------------------------
// Tool revalidation (issue #221)
// ---------------------------------------------------------------------------

/**
 * Proxy-scheduled tool definition revalidation: a periodic `tools/list`
 * after the first successful annotation-cache prime, plus a downward-only
 * clamp on the `ttlMs` a modern upstream advertises on `tools/list`
 * responses forwarded downstream. Stops drift detection (`on_tool_drift`)
 * from depending on pass-through client traffic to ever re-list tools.
 */
const toolRevalidationSchema = z
  .object({
    enabled: z.boolean().default(true),
    interval: durationSchema.default('5m'),
    // Default: `interval`, applied at compile time (undefined here means
    // "same as interval" — see PoliciesConfig compilation).
    max_advertised_ttl: durationSchema.optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (parseDuration(data.interval) < 10_000) {
      ctx.addIssue({
        code: 'custom',
        path: ['interval'],
        message: 'tool_revalidation.interval must be at least 10s',
      })
    }
  })

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

const policiesSchema = z
  .object({
    default: z.enum(['allow', 'deny']).default('allow'),
    flag_destructive: z.enum(['log', 'require_approval']).optional(),
    dry_run: z.boolean().default(false),
    rules: z.array(policyRuleSchema).default([]),
    /** Install-time policy (issue #13 — deny_install). Optional; absent ⇒ observational. */
    install: installSchema.optional(),
    /**
     * How to treat calls to a tool whose definition (annotations, schemas,
     * description) has drifted from the baseline Helio captured on first
     * sight.
     * - "block": deny the call until the proxy is restarted (re-baselines)
     *   or the upstream reverts. Conservative default when omitted.
     * - "require_approval": escalate the call through the approval channel.
     * - "log": audit the drift; rules evaluate against both baseline and
     *   current annotations and the stricter decision wins.
     * Kept optional (like hot_reload) so PoliciesConfig literal fixtures
     * don't need the field; undefined is treated as "block".
     */
    on_tool_drift: z.enum(['block', 'require_approval', 'log']).optional(),
    /**
     * Proxy-scheduled `tools/list` revalidation and `ttlMs` clamping (issue
     * #221). Optional; absent ⇒ compiled defaults (enabled: true, interval:
     * "5m") in `CompiledPolicy`, except in literal `CompiledPolicy` fixtures,
     * which treat an absent field as disabled — see `compilePolicies`.
     */
    tool_revalidation: toolRevalidationSchema.optional(),
    /**
     * Whether `helio start` should watch the config file for changes and
     * reconcile policy state on every save. Defaults to `true` when omitted.
     * Set to `false` (or pass `--no-hot-reload` on the CLI) to pin the policy
     * for the process lifetime — useful for production deployments where
     * config churn should cause zero live-state movement. Kept optional in
     * the schema so existing fixtures that build PoliciesConfig literals
     * don't need to be touched; the CLI treats `undefined` as `true`.
     */
    hot_reload: z.boolean().optional(),
  })
  .strict()

// ---------------------------------------------------------------------------
// Budgets (issue #14) — named cross-tool spend budgets, independent of rules
// ---------------------------------------------------------------------------

const budgetContributorMatchSchema = z
  .object({
    tool: z.string().min(1), // picomatch glob, same engine as match.tool
    // Same operators and AND-combination as rule `match.input`. Other rule
    // matchers (annotations, environment, metadata) stay strict-rejected
    // until the budget charge context can actually evaluate them.
    input: z.record(z.string(), inputConditionSchema).optional(),
    /** Configured upstream names the contributor is scoped to (issue #293). */
    upstreams: z
      .array(z.string().min(1))
      .min(1, {
        message: 'match.upstreams must name at least one upstream — an empty list matches nothing.',
      })
      .optional(),
  })
  .strict()

const modernBudgetContributorSchema = z
  .object({
    match: budgetContributorMatchSchema,
    field: z.string().min(1), // dot-path into tool arguments, e.g. "$.amount"
  })
  .strict()

// The 0.10.0 shape was { tool, field }. A strict-parse failure alone would
// surface as unrecognized-key noise, so detect the legacy shape BEFORE the
// strict schema runs and emit a migration pointer instead. ANY top-level
// `tool` triggers it — including a half-migrated { tool, match, field } —
// because no valid new-shape contributor has one.
const budgetContributorSchema = z
  .unknown()
  .superRefine((raw, ctx) => {
    if (raw !== null && typeof raw === 'object' && 'tool' in raw) {
      ctx.addIssue({
        code: 'custom',
        message:
          'contributor "tool" moved under "match" in v0.11.0 — write ' +
          '{ match: { tool: "<glob>" }, field: "<path>" }',
      })
    }
  })
  .pipe(modernBudgetContributorSchema)

const budgetSchema = z
  .object({
    // The name is embedded in bucket keys (`budget:<name>:<scope>`) and, later,
    // ledger rows — constrain it so keys stay parseable and scope classification
    // (e.g. the sender-key cardinality guard) cannot be confused by delimiters.
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-zA-Z0-9_-]+$/, {
        message: 'Budget names may only contain letters, digits, "_" and "-"',
      }),
    limit: z.number().positive(),
    currency: z.string().min(1),
    /** A sliding duration ("1h", "7d") or "session" (a depleting pot per session key). */
    window: z.union([durationSchema, z.literal('session')]),
    key: z.enum(['global', 'session', 'sender_id']).default('global'),
    /**
     * What a breach does: `deny` blocks the call outright; `require_approval`
     * raises one composite break-glass ticket per call listing every breached
     * budget, and the call proceeds only on an explicit approval.
     */
    on_exceed: z.enum(['deny', 'require_approval']).default('deny'),
    /**
     * Break-glass ticket routing (same shape as rule-level `approval`). Only
     * valid with `on_exceed: require_approval`; when omitted, tickets fall
     * back to the dashboard channel and the global `approval.timeout`. Note
     * that `default_on_timeout` never applies to budget tickets — they fail
     * closed on timeout regardless (money gates do not fail open).
     */
    approval: ruleApprovalSchema.optional(),
    /** Session windows only: idle time before a session pot is collected. Default 24h. */
    idle_ttl: durationSchema.optional(),
    contributors: z.array(budgetContributorSchema).min(1),
  })
  .strict()
  .superRefine((budget, ctx) => {
    if (budget.approval !== undefined && budget.on_exceed !== 'require_approval') {
      ctx.addIssue({
        code: 'custom',
        path: ['approval'],
        message:
          'budget approval config only applies with on_exceed: "require_approval" — with ' +
          'on_exceed: "deny" it is dead config. Remove it or switch on_exceed.',
      })
    }
    if (budget.window === 'session' && budget.key === 'global') {
      ctx.addIssue({
        code: 'custom',
        path: ['key'],
        message:
          'window: "session" requires key: "session" or "sender_id" — a global bucket with ' +
          'session lifetime never replenishes and never ends. Pick a per-session or ' +
          'per-sender scope, or use a duration window.',
      })
    }
    if (budget.window !== 'session' && budget.idle_ttl !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['idle_ttl'],
        message:
          'idle_ttl only applies to window: "session" budgets. Duration windows expire ' +
          'entries on their own; remove idle_ttl.',
      })
    }
  })

// ---------------------------------------------------------------------------
// Approval channels (discriminated union)
// ---------------------------------------------------------------------------

const slackChannelSchema = z
  .object({
    type: z.literal('slack'),
    name: z.string().min(1).optional(),
    bot_token: z.string(),
    signing_secret: z.string(),
    channel: z.string(),
  })
  .strict()

const webhookChannelSchema = z
  .object({
    type: z.literal('webhook'),
    name: z.string().min(1).optional(),
    url: z.string(),
    secret: z.string().optional(),
  })
  .strict()

const dashboardChannelSchema = z
  .object({
    type: z.literal('dashboard'),
    name: z.string().min(1).optional(),
  })
  .strict()

const approvalChannelSchema = z.discriminatedUnion('type', [
  slackChannelSchema,
  webhookChannelSchema,
  dashboardChannelSchema,
])

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

const approvalSchema = z
  .object({
    timeout: durationSchema.default('300s'),
    default_on_timeout: z.enum(['deny', 'allow']).default('deny'),
    channels: z.array(approvalChannelSchema).default([]),
  })
  .strict()

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

const auditSchema = z
  .object({
    storage: z.enum(['sqlite']).default('sqlite'),
    path: z.string().default('./helio-audit.db'),
    retention: durationSchema.default('90d'),
    include_responses: z.boolean().default(true),
  })
  .strict()

// ---------------------------------------------------------------------------
// SDK
// ---------------------------------------------------------------------------

const sdkSchema = z
  .object({
    enabled: z.boolean().default(false),
    port: z.number().int().min(1).max(65535).default(3200),
    host: z.string().default('127.0.0.1'),
    /**
     * How long a sideband `/evaluate` decision waits for its `/audit` before the
     * proxy finalizes it as `evaluation_expired` (issue #12, D4). Bounds the
     * pending-evaluation registry; an adapter crash cannot silently drop a
     * decided-allowed call from the trail.
     */
    evaluation_ttl: durationSchema.default('10m'),
  })
  .strict()

// ---------------------------------------------------------------------------
// Root config
// ---------------------------------------------------------------------------

// Every root section except the upstream slot, shared by both mode arms
// below. Declaration order is the canonical section order — zod emits output
// keys in declaration order and the key-order pins depend on it.
const rootSectionSchemas = {
  listen: listenSchema.prefault({}),
  environment: z.string().optional(),
  // Session precedes policies deliberately: upstream/listen/environment say
  // where and as-what Helio runs, session says who is calling, and
  // policies/budgets then govern those calls (issue #218).
  session: sessionSchema.prefault({}),
  policies: policiesSchema.prefault({}),
  // Budgets sit beside policies deliberately: they are the second half of the
  // governance declaration (policy decision → budget gate), not plumbing.
  budgets: z.array(budgetSchema).default([]),
  approval: approvalSchema.prefault({}),
  audit: auditSchema.prefault({}),
  // Dashboard follows audit deliberately: an operator surface, not part of
  // the request path (canonical section order, #89/#163).
  dashboard: dashboardSchema.prefault({}),
  sdk: sdkSchema.prefault({}),
}

// The two mode arms of the config (issue #293): identical except for slot 2,
// `upstream:` (singular) vs `upstreams:` (named list). dispatchByMode below
// routes every parse to exactly one arm.
const singularConfigBase = z
  .object({
    version: z.literal('1'),
    upstream: upstreamSchema,
    ...rootSectionSchemas,
  })
  .strict()

const namedConfigBase = z
  .object({
    version: z.literal('1'),
    upstreams: upstreamsListSchema,
    ...rootSectionSchemas,
  })
  .strict()

/** The root sections every mode arm shares — what {@link rootConfigChecks} reads. */
type RootConfigSections = Omit<z.output<typeof singularConfigBase>, 'upstream'>

/**
 * Top-level keys matching `^x-` are extension keys: schema-ignored holders
 * for YAML anchors (docker-compose precedent). js-yaml has already resolved
 * the anchors by the time zod sees the document, so the holders' job is done
 * and they are dropped before the strict parse. Root level only — the strip
 * never descends into sections, whose own schemas decide how unknown keys
 * are handled.
 */
function stripRootExtensionKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(([key]) => !key.startsWith('x-')),
  )
}

// The cross-section validations both mode arms run (issue #293 moved the
// body out of a single root schema's superRefine; the checks themselves are
// unchanged). One function, called by each arm, so a check can never be
// attached to one mode and silently skipped in the other.
function rootConfigChecks(cfg: RootConfigSections, ctx: z.core.$RefinementCtx): void {
  const hasConfiguredEnvironment =
    typeof cfg.environment === 'string' && cfg.environment.trim().length > 0

  const requiresSecret =
    cfg.policies.flag_destructive === 'require_approval' ||
    cfg.policies.on_tool_drift === 'require_approval' ||
    cfg.policies.rules.some((rule) => rule.action === 'require_approval') ||
    cfg.budgets.some((budget) => budget.on_exceed === 'require_approval')
  const hasSecret = hasDashboardApiSecret(cfg.dashboard.api_secret)

  if (requiresSecret) {
    if (!hasSecret) {
      ctx.addIssue({
        code: 'custom',
        path: ['dashboard', 'api_secret'],
        message:
          'dashboard.api_secret is required when any rule uses require_approval, any budget ' +
          'uses on_exceed: require_approval, or policies.flag_destructive or ' +
          'policies.on_tool_drift is "require_approval". ' +
          'Generate one with: `openssl rand -hex 32` and set it under ' +
          '`dashboard.api_secret` in your helio.yaml. (See docs/approvals.md.)',
      })
    }
  }

  if (!requiresSecret && cfg.dashboard.enabled && !hasSecret && !cfg.dashboard.allow_open_mode) {
    ctx.addIssue({
      code: 'custom',
      path: ['dashboard', 'api_secret'],
      message:
        'dashboard.api_secret is required when dashboard.enabled is true unless ' +
        'dashboard.allow_open_mode is explicitly set to true. Generate one with ' +
        '`openssl rand -hex 32` and set it under dashboard.api_secret in helio.yaml.',
    })
  }

  if (
    !requiresSecret &&
    cfg.dashboard.enabled &&
    !hasSecret &&
    cfg.dashboard.allow_open_mode &&
    !isLoopbackHost(cfg.dashboard.host)
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['dashboard', 'host'],
      message:
        'dashboard.host must be a loopback address (127.0.0.1, localhost, or ::1) ' +
        'when dashboard.allow_open_mode is true and dashboard.api_secret is unset.',
    })
  }

  // Channel references (rules AND budgets) resolve against the RUNTIME
  // registry keys, mirroring createChannels exactly: the built-in dashboard
  // key plus each configured channel under `name ?? type`. A NAMED
  // slack/webhook channel is NOT registered under its bare type at runtime,
  // so accepting the type here would validate a reference that never gets a
  // notification. The key → type map also lets refinements know which keys
  // resolve to the dashboard surface.
  const channelTypeByKey = new Map<string, string>([['dashboard', 'dashboard']])
  for (const [channelIndex, channel] of cfg.approval.channels.entries()) {
    const key = channel.name ?? channel.type
    // The registry key "dashboard" is reserved for the built-in fallback: a
    // slack/webhook channel under that key would silently REPLACE it, and
    // every dashboard-routed ticket would go to the impostor.
    if (key === 'dashboard' && channel.type !== 'dashboard') {
      ctx.addIssue({
        code: 'custom',
        path: ['approval', 'channels', channelIndex, channel.name ? 'name' : 'type'],
        message:
          'The channel key "dashboard" is reserved for the built-in dashboard channel. ' +
          'Pick a different name.',
      })
      continue
    }
    // Duplicate effective keys are last-write-wins at runtime — silent
    // misrouting. (A dashboard-type channel re-registering the built-in
    // "dashboard" key is the one harmless case.)
    if (channelTypeByKey.has(key) && !(key === 'dashboard' && channel.type === 'dashboard')) {
      ctx.addIssue({
        code: 'custom',
        path: ['approval', 'channels', channelIndex, channel.name ? 'name' : 'type'],
        message:
          `Duplicate approval channel key "${key}". Channels register under name ?? type — ` +
          'give each channel a unique name.',
      })
      continue
    }
    channelTypeByKey.set(key, channel.type)
  }
  const knownChannelKeys = new Set<string>(channelTypeByKey.keys())
  const resolvesToDashboard = (key: string): boolean => channelTypeByKey.get(key) === 'dashboard'

  // Budgets (issue #14): names are the identity for hot-reload state
  // preservation and persistence, so they must be unique; sender_id scoping
  // mirrors the rule-limits sideband guard above; break-glass approval
  // references get the same channel checks as rules.
  const seenBudgetNames = new Set<string>()
  for (const [budgetIndex, budget] of cfg.budgets.entries()) {
    if (seenBudgetNames.has(budget.name)) {
      ctx.addIssue({
        code: 'custom',
        path: ['budgets', budgetIndex, 'name'],
        message:
          `Duplicate budget name "${budget.name}". Budget names are the identity that ` +
          'preserves accrued spend across config edits — each budget needs its own.',
      })
    }
    seenBudgetNames.add(budget.name)

    if (!cfg.sdk.enabled && budget.key === 'sender_id') {
      ctx.addIssue({
        code: 'custom',
        path: ['budgets', budgetIndex, 'key'],
        message:
          'budget key "sender_id" requires the SDK sideband (sdk.enabled: true) — ' +
          'sender_id is supplied by hook adapters and is absent on the MCP path.',
      })
    }

    const budgetChannel = budget.approval?.channel
    if (budgetChannel && !knownChannelKeys.has(budgetChannel)) {
      ctx.addIssue({
        code: 'custom',
        path: ['budgets', budgetIndex, 'approval', 'channel'],
        message:
          `Unknown approval channel "${budgetChannel}". ` +
          'Add it to approval.channels (type or name), or use "dashboard".',
      })
    }
    for (const [delegateIndex, delegate] of (budget.approval?.delegates ?? []).entries()) {
      if (!knownChannelKeys.has(delegate)) {
        ctx.addIssue({
          code: 'custom',
          path: ['budgets', budgetIndex, 'approval', 'delegates', delegateIndex],
          message:
            `Unknown delegate channel "${delegate}". ` +
            'Delegates must reference configured approval channel names.',
        })
      }
    }

    // A dashboard-routed break-glass ticket resolves ONLY through the
    // dashboard approvals API — with the dashboard server disabled the
    // ticket has no resolution surface and always times out (fail closed).
    // Dead config; reject it. Slack-routed tickets are fine: their action
    // callbacks live on the main proxy server.
    if (budget.on_exceed === 'require_approval' && !cfg.dashboard.enabled) {
      const effectiveChannel = budget.approval?.channel ?? 'dashboard'
      if (resolvesToDashboard(effectiveChannel)) {
        ctx.addIssue({
          code: 'custom',
          path:
            budget.approval?.channel !== undefined
              ? ['budgets', budgetIndex, 'approval', 'channel']
              : ['budgets', budgetIndex, 'on_exceed'],
          message:
            'This budget routes break-glass tickets to the dashboard channel, but ' +
            'dashboard.enabled is false — the ticket could never be resolved and would ' +
            'always time out. Enable the dashboard or route approval.channel to a ' +
            'Slack channel.',
        })
      }
      // Delegates only matter when the escalation timer can actually fire:
      // the router escalates only when 0 < escalation_after < the effective
      // timeout (budget timeout, else the global approval.timeout). An inert
      // timer's delegates are config the router never consults, so the
      // dashboard-availability guard must not reject them.
      const escalationAfterMs =
        budget.approval?.escalation_after !== undefined
          ? parseDuration(budget.approval.escalation_after)
          : undefined
      const effectiveTimeoutMs = parseDuration(budget.approval?.timeout ?? cfg.approval.timeout)
      const escalationCanFire =
        escalationAfterMs !== undefined &&
        escalationAfterMs > 0 &&
        escalationAfterMs < effectiveTimeoutMs
      for (const [delegateIndex, delegate] of (budget.approval?.delegates ?? []).entries()) {
        if (escalationCanFire && knownChannelKeys.has(delegate) && resolvesToDashboard(delegate)) {
          ctx.addIssue({
            code: 'custom',
            path: ['budgets', budgetIndex, 'approval', 'delegates', delegateIndex],
            message:
              'This budget escalates break-glass tickets to a dashboard channel, but ' +
              'dashboard.enabled is false — the delegate could never resolve the ticket. ' +
              'Enable the dashboard or delegate to a Slack channel.',
          })
        }
      }
    }
  }

  const hasWebhookChannel = cfg.approval.channels.some((channel) => channel.type === 'webhook')
  if (hasWebhookChannel && !cfg.dashboard.enabled) {
    ctx.addIssue({
      code: 'custom',
      path: ['dashboard', 'enabled'],
      message:
        'dashboard.enabled must be true when approval.channels includes a webhook channel. ' +
        'Webhook notifications require the dashboard sideband approval API.',
    })
  }

  // The destructive / drift escalations submit with no matched rule, which
  // always routes to the dashboard default channel (issue #152).
  if (!cfg.dashboard.enabled) {
    if (cfg.policies.flag_destructive === 'require_approval') {
      ctx.addIssue({
        code: 'custom',
        path: ['policies', 'flag_destructive'],
        message:
          'policies.flag_destructive: require_approval routes its escalation ' +
          'tickets to the dashboard channel, but dashboard.enabled is false — ' +
          'the tickets could never be resolved and would always time out. ' +
          'Enable the dashboard or use "log".',
      })
    }
    if (cfg.policies.on_tool_drift === 'require_approval') {
      ctx.addIssue({
        code: 'custom',
        path: ['policies', 'on_tool_drift'],
        message:
          'policies.on_tool_drift: require_approval routes its escalation ' +
          'tickets to the dashboard channel, but dashboard.enabled is false — ' +
          'the tickets could never be resolved and would always time out. ' +
          'Enable the dashboard or use "block" or "log".',
      })
    }
  }

  for (const [ruleIndex, rule] of cfg.policies.rules.entries()) {
    if (rule.match.environment !== undefined && !hasConfiguredEnvironment) {
      ctx.addIssue({
        code: 'custom',
        path: ['policies', 'rules', ruleIndex, 'match', 'environment'],
        message:
          `Rule sets match.environment="${rule.match.environment}" but top-level ` +
          '`environment` is not configured. Set top-level environment to enable env-scoped rules.',
      })
    }

    // sender_id is an adapter (host-enforced) context field that only exists on
    // the sideband. Without the sideband a sender-keyed limit is dead config that
    // would silently collapse to tool scope on the MCP path — reject it up front
    // (issue #13). Mirrors the match.environment / top-level-environment guard.
    if (!cfg.sdk.enabled) {
      if (rule.limits?.key === 'sender_id') {
        ctx.addIssue({
          code: 'custom',
          path: ['policies', 'rules', ruleIndex, 'limits', 'key'],
          message:
            'limits.key "sender_id" requires the SDK sideband (sdk.enabled: true) — ' +
            'sender_id is supplied by hook adapters and is absent on the MCP path.',
        })
      }
      if (rule.limits?.max_spend?.key === 'sender_id') {
        ctx.addIssue({
          code: 'custom',
          path: ['policies', 'rules', ruleIndex, 'limits', 'max_spend', 'key'],
          message:
            'limits.max_spend.key "sender_id" requires the SDK sideband (sdk.enabled: true) — ' +
            'sender_id is supplied by hook adapters and is absent on the MCP path.',
        })
      }
    }

    if (rule.action === 'rate_limit') {
      if (rule.limits?.max_calls === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['policies', 'rules', ruleIndex, 'limits', 'max_calls'],
          message: 'rate_limit rules require limits.max_calls. Add a positive integer call limit.',
        })
      }
      if (rule.limits?.window === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['policies', 'rules', ruleIndex, 'limits', 'window'],
          message: 'rate_limit rules require limits.window (for example "1m" or "1h").',
        })
      }
    }

    if (rule.action === 'spend_limit' && rule.limits?.max_spend === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['policies', 'rules', ruleIndex, 'limits', 'max_spend'],
        message: 'spend_limit rules require limits.max_spend (field, limit, currency, window).',
      })
    }

    const channel = rule.approval?.channel
    if (channel && !knownChannelKeys.has(channel)) {
      ctx.addIssue({
        code: 'custom',
        path: ['policies', 'rules', ruleIndex, 'approval', 'channel'],
        message:
          `Unknown approval channel "${channel}". ` +
          'Add it to approval.channels (type or name), or use "dashboard".',
      })
    }

    // Dashboard-routed rule tickets resolve ONLY through the dashboard
    // approvals API — same dead-config shape the budget check above rejects
    // (issue #152). Metadata-gated rules are exempt: they can only match on
    // the sideband, whose tickets are native (adapter-resolved, no channel
    // notified). findUnroutableApprovalReferences applies the same semantics
    // at the hot-reload boundary; the agreement test keeps the two in step.
    if (
      rule.action === 'require_approval' &&
      !cfg.dashboard.enabled &&
      rule.match.metadata === undefined
    ) {
      const effectiveChannel = rule.approval?.channel ?? 'dashboard'
      if (resolvesToDashboard(effectiveChannel)) {
        ctx.addIssue({
          code: 'custom',
          path:
            rule.approval?.channel !== undefined
              ? ['policies', 'rules', ruleIndex, 'approval', 'channel']
              : ['policies', 'rules', ruleIndex, 'action'],
          message:
            'This rule routes approvals to the dashboard channel, but ' +
            'dashboard.enabled is false — the ticket could never be resolved and ' +
            'would always time out. Enable the dashboard or route ' +
            'approval.channel to a Slack channel.',
        })
      }
      // Delegates only matter when the escalation timer can actually fire:
      // the router escalates only when 0 < escalation_after < the effective
      // timeout (rule timeout, else the global approval.timeout). An inert
      // timer's delegates are config the router never consults, so the
      // dashboard-availability guard must not reject them.
      const escalationAfterMs =
        rule.approval?.escalation_after !== undefined
          ? parseDuration(rule.approval.escalation_after)
          : undefined
      const effectiveTimeoutMs = parseDuration(rule.approval?.timeout ?? cfg.approval.timeout)
      const escalationCanFire =
        escalationAfterMs !== undefined &&
        escalationAfterMs > 0 &&
        escalationAfterMs < effectiveTimeoutMs
      for (const [delegateIndex, delegate] of (rule.approval?.delegates ?? []).entries()) {
        if (escalationCanFire && knownChannelKeys.has(delegate) && resolvesToDashboard(delegate)) {
          ctx.addIssue({
            code: 'custom',
            path: ['policies', 'rules', ruleIndex, 'approval', 'delegates', delegateIndex],
            message:
              'This rule escalates approvals to a dashboard channel, but ' +
              'dashboard.enabled is false — the delegate could never resolve the ' +
              'ticket. Enable the dashboard or delegate to a Slack channel.',
          })
        }
      }
    }

    const delegates = rule.approval?.delegates
    if (!delegates) continue
    for (const [delegateIndex, delegate] of delegates.entries()) {
      if (!knownChannelKeys.has(delegate)) {
        ctx.addIssue({
          code: 'custom',
          path: ['policies', 'rules', ruleIndex, 'approval', 'delegates', delegateIndex],
          message:
            `Unknown delegate channel "${delegate}". ` +
            'Delegates must reference configured approval channel names.',
        })
      }
    }
  }
}

/**
 * The upstream-vocabulary validations (issue #293). One function, run by BOTH
 * mode arms — `configuredNames` is null in singular mode and the declared
 * name set in named mode — so a mode-dependent rule can never be attached to
 * one arm and silently skipped in the other.
 */
function upstreamVocabularyChecks(
  cfg: RootConfigSections,
  ctx: z.core.$RefinementCtx,
  configuredNames: ReadonlySet<string> | null,
): void {
  for (const [ruleIndex, rule] of cfg.policies.rules.entries()) {
    const upstreams = rule.match.upstreams
    if (upstreams === undefined) continue

    if (configuredNames === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['policies', 'rules', ruleIndex, 'match', 'upstreams'],
        message:
          'Rule sets match.upstreams but the config declares a single "upstream:", which ' +
          'has no name on purpose. Upstream-scoped rules require the named "upstreams:" list.',
      })
    } else {
      for (const [entryIndex, name] of upstreams.entries()) {
        if (!configuredNames.has(name)) {
          ctx.addIssue({
            code: 'custom',
            path: ['policies', 'rules', ruleIndex, 'match', 'upstreams', entryIndex],
            message:
              `Rule names upstream "${name}" in match.upstreams but no configured upstream ` +
              'has that name. Every entry must name an upstream from the upstreams: list.',
          })
        }
      }
    }

    // Metadata only exists on the sideband and upstream scoping only on the
    // MCP path — the combination is a rule that can never match.
    if (rule.match.metadata !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['policies', 'rules', ruleIndex, 'match', 'upstreams'],
        message:
          'match.upstreams cannot be combined with match.metadata — metadata rules only ' +
          'match on the sideband (host) path and upstream-scoped rules only on the MCP ' +
          'path, so the combination can never match. Split it into two rules.',
      })
    }

    // sender_id is sideband-only for the same reason — an upstream-scoped
    // sender key could only ever collapse to tool scope.
    if (rule.limits?.key === 'sender_id') {
      ctx.addIssue({
        code: 'custom',
        path: ['policies', 'rules', ruleIndex, 'limits', 'key'],
        message:
          'limits.key "sender_id" cannot be combined with match.upstreams — an ' +
          'upstream-scoped rule only matches on the MCP path, where sender_id is absent ' +
          'and the key would silently collapse to tool scope.',
      })
    }
    if (rule.limits?.max_spend?.key === 'sender_id') {
      ctx.addIssue({
        code: 'custom',
        path: ['policies', 'rules', ruleIndex, 'limits', 'max_spend', 'key'],
        message:
          'limits.max_spend.key "sender_id" cannot be combined with match.upstreams — an ' +
          'upstream-scoped rule only matches on the MCP path, where sender_id is absent ' +
          'and the key would silently collapse to tool scope.',
      })
    }
  }

  for (const [budgetIndex, budget] of cfg.budgets.entries()) {
    let hasUnscopedContributor = false
    for (const [contributorIndex, contributor] of budget.contributors.entries()) {
      // The legacy flat contributor shape ({ tool, field }) reaches these
      // checks unparsed: its migration rejection sits behind a
      // z.unknown() pipe, and z.unknown() lets the raw object through the
      // field parse. Treat it as unscoped — the migration message is the
      // real issue and the config is already rejected.
      const upstreams = (contributor as { match?: { upstreams?: readonly string[] } }).match
        ?.upstreams
      if (upstreams === undefined) {
        hasUnscopedContributor = true
        continue
      }

      if (configuredNames === null) {
        ctx.addIssue({
          code: 'custom',
          path: ['budgets', budgetIndex, 'contributors', contributorIndex, 'match', 'upstreams'],
          message:
            'Contributor sets match.upstreams but the config declares a single "upstream:", ' +
            'which has no name on purpose. Upstream-scoped contributors require the named ' +
            '"upstreams:" list.',
        })
      } else {
        for (const [entryIndex, name] of upstreams.entries()) {
          if (!configuredNames.has(name)) {
            ctx.addIssue({
              code: 'custom',
              path: [
                'budgets',
                budgetIndex,
                'contributors',
                contributorIndex,
                'match',
                'upstreams',
                entryIndex,
              ],
              message:
                `Contributor names upstream "${name}" in match.upstreams but no configured ` +
                'upstream has that name. Every entry must name an upstream from the ' +
                'upstreams: list.',
            })
          }
        }
      }
    }

    // A sender-keyed pot fed only by upstream-scoped contributors is dead
    // config: MCP calls never carry a sender and sideband calls never carry
    // an upstream, so the two scopes can never meet.
    if (budget.key === 'sender_id' && !hasUnscopedContributor) {
      ctx.addIssue({
        code: 'custom',
        path: ['budgets', budgetIndex, 'key'],
        message:
          'budget key "sender_id" requires at least one contributor without an ' +
          '"upstreams" scope — upstream-scoped contributors only match MCP calls, which ' +
          'never carry a sender, so every charge would land in the shared "unknown" pot ' +
          'while sideband calls (the only ones with real senders) never feed this budget.',
      })
    }
  }

  // Named mode + evidence gating + legacy_header identity is fail-closed:
  // the guard fires under the DEFAULT identity chain too, so the message
  // must spell the exact remedy. The gating predicate mirrors the decision
  // pipeline's runtime gate verbatim — only a NON-EMPTY requires list (in
  // either spelling) gates a session; requires_success alone is inert.
  if (configuredNames !== null) {
    const hasEvidenceGatedRule = cfg.policies.rules.some(
      (rule) => (rule.evidence?.requires.length ?? 0) > 0 || (rule.requires?.length ?? 0) > 0,
    )
    if (hasEvidenceGatedRule) {
      const legacyIndex = cfg.session.identity.findIndex(
        (source) => source.source === 'legacy_header',
      )
      if (legacyIndex !== -1) {
        ctx.addIssue({
          code: 'custom',
          path: ['session', 'identity', legacyIndex],
          message:
            'session.identity includes "legacy_header" while named upstreams and ' +
            'evidence-gated rules ("evidence"/"requires") are configured. On the legacy ' +
            'relay flow the Mcp-Session-Id a client echoes was minted by the upstream ' +
            'itself, so with multiple upstreams a hostile server could collide session ' +
            "identities across doors and pollute another door's evidence gates. Remove " +
            'legacy_header from session.identity and use a caller-owned source such as ' +
            'the default "x-helio-session-id" header.',
        })
      }
    }
  }
}

const singularConfigSchema = singularConfigBase.superRefine((cfg, ctx) => {
  rootConfigChecks(cfg, ctx)
  upstreamVocabularyChecks(cfg, ctx, null)
})
const namedConfigSchema = namedConfigBase.superRefine((cfg, ctx) => {
  rootConfigChecks(cfg, ctx)
  upstreamVocabularyChecks(cfg, ctx, new Set(cfg.upstreams.map((entry) => entry.name)))
})

/** A fully validated and defaulted singular-mode (`upstream:`) configuration. */
export type SingularHelioConfig = z.output<typeof singularConfigSchema>

/** A fully validated and defaulted named-mode (`upstreams:`) configuration. */
export type NamedHelioConfig = z.output<typeof namedConfigSchema>

/**
 * Route a raw config document to exactly one mode arm (issue #293). A plain
 * z.union cannot do this job: zod's arm selection is heuristic, and a common
 * mistake like a named entry missing `url` surfaces as a buried
 * "(top level): Invalid input" instead of its real issue. The dispatch owns
 * the exactly-one-of contract and forwards the chosen arm's issues verbatim,
 * so every error keeps its real path and message.
 */
// Produces zod's canonical invalid_type issue for a non-object root — the
// same message the pre-dispatch root schema generated, kept so a garbage
// document is diagnosed as a type error, never as a mode error.
const objectRootSchema = z.object({})

function dispatchByMode(
  raw: unknown,
  ctx: z.core.$RefinementCtx,
): SingularHelioConfig | NamedHelioConfig {
  const isObject = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
  if (!isObject) {
    const typeResult = objectRootSchema.safeParse(raw)
    if (!typeResult.success) {
      for (const issue of typeResult.error.issues) {
        ctx.addIssue(issue as z.core.$ZodRawIssue)
      }
    }
    return z.NEVER
  }
  const hasUpstream = 'upstream' in raw
  const hasUpstreams = 'upstreams' in raw

  if (hasUpstream && hasUpstreams) {
    ctx.addIssue({
      code: 'custom',
      path: ['upstreams'],
      message:
        'Set exactly one of "upstream:" (single upstream) or "upstreams:" (named ' +
        'multi-upstream list) — not both. To migrate, move the upstream: fields into ' +
        'an upstreams: entry and give it a name.',
    })
    return z.NEVER
  }
  if (!hasUpstream && !hasUpstreams) {
    ctx.addIssue({
      code: 'custom',
      message:
        'Missing upstream configuration: set exactly one of "upstream:" (single ' +
        'upstream) or "upstreams:" (named multi-upstream list).',
    })
    return z.NEVER
  }

  const result = hasUpstreams
    ? namedConfigSchema.safeParse(raw)
    : singularConfigSchema.safeParse(raw)
  if (!result.success) {
    for (const issue of result.error.issues) {
      // A finished $ZodIssue is runtime-compatible with addIssue (it
      // normalizes and pushes), but the declared parameter type only admits
      // raw issues — forward verbatim under the raw-issue type.
      ctx.addIssue(issue as z.core.$ZodRawIssue)
    }
    return z.NEVER
  }
  return result.data
}

/** Zod schema for the complete `helio.yaml` configuration file. */
export const helioConfigSchema = z.preprocess(
  stripRootExtensionKeys,
  z.unknown().transform(dispatchByMode),
)

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

/** Fully validated and defaulted Helio configuration — one of the two mode arms. */
export type HelioConfig = SingularHelioConfig | NamedHelioConfig

/** Narrow a parsed config to the singular-mode (`upstream:`) arm. */
export function isSingularConfig(config: HelioConfig): config is SingularHelioConfig {
  return !('upstreams' in config)
}

/** Narrow a parsed config to the named-mode (`upstreams:`) arm. */
export function isNamedConfig(config: HelioConfig): config is NamedHelioConfig {
  return 'upstreams' in config
}

/** A single policy rule from the `policies.rules` array. */
export type PolicyRule = z.infer<typeof policyRuleSchema>

/** An approval channel configuration (slack, webhook, or dashboard). */
export type ApprovalChannel = z.infer<typeof approvalChannelSchema>

/** The policies section of the config. */
export type PoliciesConfig = z.infer<typeof policiesSchema>

/** The session identity section of the config (issue #218). */
export type SessionConfig = z.infer<typeof sessionSchema>

/** A single identity source from `session.identity`. */
export type SessionIdentitySource = z.infer<typeof sessionIdentitySourceSchema>

/** The audit section of the config. */
export type AuditConfig = z.infer<typeof auditSchema>

/** A single named budget from the `budgets` array (issue #14). */
export type BudgetConfig = z.infer<typeof budgetSchema>

/** The `budgets` section of the config. */
export type BudgetsConfig = readonly BudgetConfig[]
