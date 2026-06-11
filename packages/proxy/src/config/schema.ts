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

const matchSchema = z
  .object({
    tool: z.string().optional(),
    annotations: annotationsMatchSchema.optional(),
    input: z.record(z.string(), inputConditionSchema).optional(),
    environment: z.string().optional(),
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
    channel: z.string(),
    timeout: durationSchema.optional(),
    delegates: z.array(z.string()).optional(),
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
    key: z.enum(['tool', 'agent', 'session']).optional(),
  })
  .strict()

const limitsSchema = z
  .object({
    max_calls: z.number().int().positive().optional(),
    window: durationSchema.optional(),
    key: z.enum(['tool', 'agent', 'session']).optional(),
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
// Policies
// ---------------------------------------------------------------------------

const policiesSchema = z
  .object({
    default: z.enum(['allow', 'deny']).default('allow'),
    flag_destructive: z.enum(['log', 'require_approval']).optional(),
    dry_run: z.boolean().default(false),
    rules: z.array(policyRuleSchema).default([]),
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
// Approval channels (discriminated union)
// ---------------------------------------------------------------------------

const slackChannelSchema = z.object({
  type: z.literal('slack'),
  name: z.string().optional(),
  bot_token: z.string(),
  signing_secret: z.string(),
  channel: z.string(),
})

const webhookChannelSchema = z.object({
  type: z.literal('webhook'),
  name: z.string().optional(),
  url: z.string(),
  secret: z.string().optional(),
})

const dashboardChannelSchema = z.object({
  type: z.literal('dashboard'),
  name: z.string().optional(),
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
})

// ---------------------------------------------------------------------------
// Root config
// ---------------------------------------------------------------------------

const helioConfigBaseSchema = z.object({
  version: z.literal('1'),
  upstream: upstreamSchema,
  listen: listenSchema.prefault({}),
  dashboard: dashboardSchema.prefault({}),
  environment: z.string().optional(),
  policies: policiesSchema.prefault({}),
  approval: approvalSchema.prefault({}),
  audit: auditSchema.prefault({}),
  sdk: sdkSchema.prefault({}),
})

/** Zod schema for the complete `helio.yaml` configuration file. */
export const helioConfigSchema = helioConfigBaseSchema.superRefine((cfg, ctx) => {
  const hasConfiguredEnvironment =
    typeof cfg.environment === 'string' && cfg.environment.trim().length > 0

  const requiresSecret =
    cfg.policies.flag_destructive === 'require_approval' ||
    cfg.policies.on_tool_drift === 'require_approval' ||
    cfg.policies.rules.some((rule) => rule.action === 'require_approval')
  const hasSecret = hasDashboardApiSecret(cfg.dashboard.api_secret)

  if (requiresSecret) {
    if (!hasSecret) {
      ctx.addIssue({
        code: 'custom',
        path: ['dashboard', 'api_secret'],
        message:
          'dashboard.api_secret is required when any rule uses require_approval or ' +
          'policies.flag_destructive or policies.on_tool_drift is "require_approval". ' +
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

  const knownChannelKeys = new Set<string>(['dashboard'])
  for (const channel of cfg.approval.channels) {
    knownChannelKeys.add(channel.type)
    if (channel.name) {
      knownChannelKeys.add(channel.name)
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
