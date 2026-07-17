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

const transportSchema = z.enum(['streamable-http', 'sse', 'stdio'])

const upstreamSchema = z
  .object({
    url: z.string(),
    transport: transportSchema.default('streamable-http'),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    connect_timeout: durationSchema.default('10s'),
    request_timeout: durationSchema.default('30s'),
    forward_headers: z.array(z.string().min(1)).default([]),
    headers: z.record(z.string(), z.string()).default({}),
  })
  .refine((data) => data.transport !== 'stdio' || data.command !== undefined, {
    message: '"command" is required when transport is "stdio"',
    path: ['command'],
  })
  .superRefine((data, ctx) => {
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
    const reserved = new Set([
      'mcp-session-id',
      'mcp-protocol-version',
      'content-type',
      'content-length',
      'host',
    ])
    for (const name of Object.keys(data.headers)) {
      if (reserved.has(name.toLowerCase())) {
        ctx.addIssue({
          code: 'custom',
          path: ['headers', name],
          message: `upstream.headers must not set reserved header "${name}"`,
        })
      }
    }
  })

// ---------------------------------------------------------------------------
// Listen
// ---------------------------------------------------------------------------

const listenSchema = z.object({
  port: z.number().int().min(1).max(65535).default(3000),
  host: z.string().default('127.0.0.1'),
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

const dashboardSchema = z.object({
  enabled: z.boolean().default(true),
  port: z.number().int().min(1).max(65535).default(3100),
  host: z.string().default('127.0.0.1'),
  api_secret: z.string().optional(),
  allow_open_mode: z.boolean().default(false),
  sse_heartbeat_interval: durationSchema.default('30s'),
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

const budgetContributorSchema = z
  .object({
    tool: z.string().min(1), // picomatch glob, same engine as match.tool
    field: z.string().min(1), // dot-path into tool arguments, e.g. "$.amount"
  })
  .strict()

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

const slackChannelSchema = z.object({
  type: z.literal('slack'),
  name: z.string().min(1).optional(),
  bot_token: z.string(),
  signing_secret: z.string(),
  channel: z.string(),
})

const webhookChannelSchema = z.object({
  type: z.literal('webhook'),
  name: z.string().min(1).optional(),
  url: z.string(),
  secret: z.string().optional(),
})

const dashboardChannelSchema = z.object({
  type: z.literal('dashboard'),
  name: z.string().min(1).optional(),
})

const approvalChannelSchema = z.discriminatedUnion('type', [
  slackChannelSchema,
  webhookChannelSchema,
  dashboardChannelSchema,
])

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

const approvalSchema = z.object({
  timeout: durationSchema.default('300s'),
  default_on_timeout: z.enum(['deny', 'allow']).default('deny'),
  channels: z.array(approvalChannelSchema).default([]),
})

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

const auditSchema = z.object({
  storage: z.enum(['sqlite']).default('sqlite'),
  path: z.string().default('./helio-audit.db'),
  retention: durationSchema.default('90d'),
  include_responses: z.boolean().default(true),
})

// ---------------------------------------------------------------------------
// SDK
// ---------------------------------------------------------------------------

const sdkSchema = z.object({
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

// ---------------------------------------------------------------------------
// Root config
// ---------------------------------------------------------------------------

const helioConfigBaseSchema = z
  .object({
    version: z.literal('1'),
    upstream: upstreamSchema,
    listen: listenSchema.prefault({}),
    dashboard: dashboardSchema.prefault({}),
    environment: z.string().optional(),
    policies: policiesSchema.prefault({}),
    // Budgets sit beside policies deliberately: they are the second half of the
    // governance declaration (policy decision → budget gate), not plumbing.
    budgets: z.array(budgetSchema).default([]),
    approval: approvalSchema.prefault({}),
    audit: auditSchema.prefault({}),
    sdk: sdkSchema.prefault({}),
  })
  .strict()

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

const helioConfigRefinedSchema = helioConfigBaseSchema.superRefine((cfg, ctx) => {
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
})

/** Zod schema for the complete `helio.yaml` configuration file. */
export const helioConfigSchema = z.preprocess(stripRootExtensionKeys, helioConfigRefinedSchema)

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

/** Fully validated and defaulted Helio configuration. */
export type HelioConfig = z.infer<typeof helioConfigSchema>

/** A single policy rule from the `policies.rules` array. */
export type PolicyRule = z.infer<typeof policyRuleSchema>

/** An approval channel configuration (slack, webhook, or dashboard). */
export type ApprovalChannel = z.infer<typeof approvalChannelSchema>

/** The policies section of the config. */
export type PoliciesConfig = z.infer<typeof policiesSchema>

/** The audit section of the config. */
export type AuditConfig = z.infer<typeof auditSchema>

/** A single named budget from the `budgets` array (issue #14). */
export type BudgetConfig = z.infer<typeof budgetSchema>

/** The `budgets` section of the config. */
export type BudgetsConfig = readonly BudgetConfig[]
