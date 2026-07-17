/* eslint-disable no-console -- CLI entry point, console is the intended output */
import { Command } from 'commander'
import { writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { VERSION } from './version.js'
import { loadConfig, ConfigError, ConfigWatcher } from './config/index.js'
import { findUnroutableApprovalReferences } from './config/reload-boundary.js'
import { createApp, startServer, startSidebandServer } from './server.js'
import { createForwarderFromConfig } from './cli-forwarder.js'
import { compilePolicies, PolicyParseError } from './policy/index.js'
import { GovernedForwarder } from './policy/governed-forwarder.js'
import type { AnnotationCachePrimeResult } from './policy/governed-forwarder.js'
import { AuditStore, AuditWriter, EXPORT_MAX_RECORDS } from './audit/index.js'
import { EvidenceStore, createSidebandApp } from './evidence/index.js'
import { GovernanceService } from './sideband/governance-service.js'
import {
  ApprovalQueue,
  ApprovalRouter,
  createChannels,
  createSlackActionApp,
} from './approval/index.js'
import { RateLimiter } from './policy/index.js'
import { SpendLimiter } from './policy/index.js'
import { BudgetEngine, BudgetLedger, compileBudgets } from './budget/index.js'
import { parseDuration } from './config/schema.js'
import { createDashboardAppWithLifecycle, DashboardEventBus } from './dashboard/index.js'
import type { AuditRecord } from './audit/index.js'
import { CSV_HEADERS, csvEscape } from './audit/csv.js'
import type { ServerHandle } from './server.js'
import {
  warnIfWebhookChannelUnreachable,
  warnIfSdkSidebandExposed,
  warnIfDashboardOpenMode,
  warnIfNoEnforcement,
  warnIfBudgetWindowExceedsRetention,
} from './startup-warnings.js'
import { closeResources } from './shutdown.js'
import { drainForCrash, registerCrashDrainHook } from './crash-drain.js'

// ---------------------------------------------------------------------------
// Process-level error handlers — ensure crashes are logged, and let every
// registered crash-drain hook (audit writer, etc.) flush before exit so the
// enforcement trail survives an unhandled rejection or an uncaught exception.
// ---------------------------------------------------------------------------

/** Upper bound on how long the crash drain can run before we give up and
 *  exit anyway. Bounds the worst case if a future hook hangs. */
const CRASH_DRAIN_TIMEOUT_MS = 2_000

function exitAfterDrain(): void {
  const watchdog = new Promise<void>((resolve) => {
    setTimeout(resolve, CRASH_DRAIN_TIMEOUT_MS).unref()
  })
  void Promise.race([drainForCrash(), watchdog]).finally(() => {
    process.exit(1)
  })
}

process.on('unhandledRejection', (reason) => {
  console.error('[helio] Unhandled promise rejection:', reason)
  exitAfterDrain()
})

process.on('uncaughtException', (err) => {
  console.error('[helio] Uncaught exception:', err)
  exitAfterDrain()
})

const DEFAULT_CONFIG_PATH = 'helio.yaml'
const SHUTDOWN_TIMEOUT_MS = 5_000
const BUNDLED_DASHBOARD_ASSETS_DIR = 'dashboard-assets'
// Test hook to simulate missing bundled assets without mutating dist/ on disk.
const DASHBOARD_ASSETS_TEST_OVERRIDE_ENV = 'HELIO_DASHBOARD_ASSETS_DIR_TEST_OVERRIDE'
const DASHBOARD_ASSETS_RECOVERY_MESSAGE_FOR_START =
  'Run "pnpm --filter @gethelio/proxy build" before starting Helio. ' +
  'If you installed @gethelio/proxy from npm and see this, please file a bug - bundled assets should always be present.'
const DASHBOARD_ASSETS_RECOVERY_MESSAGE_FOR_VALIDATE =
  'Run "pnpm --filter @gethelio/proxy build" before validating. ' +
  'If you installed @gethelio/proxy from npm and see this, please file a bug - bundled assets should always be present.'

function resolveDashboardAssetsDir(): string {
  const isVitestRuntime =
    process.env['VITEST'] === 'true' || typeof process.env['VITEST_WORKER_ID'] === 'string'
  const override = process.env[DASHBOARD_ASSETS_TEST_OVERRIDE_ENV]
  if (isVitestRuntime && override && override.trim().length > 0) {
    return override
  }
  const distDir = dirname(fileURLToPath(import.meta.url))
  return resolve(distDir, BUNDLED_DASHBOARD_ASSETS_DIR)
}

function getBundledDashboardDistPath(): string | null {
  const assetsDir = resolveDashboardAssetsDir()
  const indexPath = resolve(assetsDir, 'index.html')
  const assetsSubdirPath = resolve(assetsDir, 'assets')
  return existsSync(indexPath) && existsSync(assetsSubdirPath) ? assetsDir : null
}

// ---------------------------------------------------------------------------
// Config template for `helio init`
// ---------------------------------------------------------------------------

function renderConfigTemplate(apiSecret: string): string {
  return `# Helio MCP Governance Proxy configuration
# Docs: https://github.com/gethelio/helio

version: "1"

upstream:
  # URL of the upstream MCP server
  url: "http://localhost:8080/mcp"
  # Transport: streamable-http (default), sse, or stdio
  transport: streamable-http
#   headers:
#     Authorization: "Bearer \${UPSTREAM_TOKEN}"

# listen:
#   port: 3000
#   host: 127.0.0.1

# policies:
#   default: allow
#   dry_run: false
#   rules: []

# approval:
#   timeout: 300s
#   default_on_timeout: deny
#   channels: []

# audit:
#   storage: sqlite
#   path: ./helio-audit.db
#   retention: 90d
#   include_responses: true

# Operator dashboard + approval REST API. Bound to 127.0.0.1 by default — do
# not change to 0.0.0.0 without putting an authenticating reverse proxy in
# front. dashboard.api_secret is the manual dashboard login secret and also
# supports machine Bearer auth for sideband API clients. Store it safely; it
# stays valid until you rotate it. Rotate by editing this file and restarting
# (or hot-reloading) the proxy. Rotation invalidates active dashboard sessions.
dashboard:
  enabled: true
  port: 3100
  host: 127.0.0.1
  api_secret: "${apiSecret}"

# sdk:
#   enabled: false
#   port: 3200
#   host: 127.0.0.1
# When enabled, the proxy generates a per-boot Bearer token and prints it
# to stderr. Pass HELIO_SDK_TOKEN to your SDK clients, or pre-set it in
# the proxy's environment for a stable cross-restart value.
`
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * Print a ConfigError's per-field detail lines. Every surface that reports a
 * config failure (start, validate, export, hot reload) goes through this so
 * the offending path is always named, in one format.
 */
function printConfigErrorDetails(error: ConfigError, prefix = ''): void {
  if (!error.details) return
  for (const detail of error.details) {
    console.error(`${prefix}  ${detail.path}: ${detail.message}`)
  }
}

interface StartOptions {
  config: string
  /** When true, do not start the config file watcher. Overrides the YAML. */
  noHotReload?: boolean
}

/** Upper bound to wait for startup cache priming before serving requests. */
const ANNOTATION_PRIME_INITIAL_WAIT_MS = 1_500
/** Base delay for background retry/backoff when startup priming fails. */
const ANNOTATION_PRIME_RETRY_BASE_MS = 1_000
/** Maximum backoff delay for annotation cache prime retries. */
const ANNOTATION_PRIME_RETRY_MAX_MS = 30_000
/** Random jitter added to retry delay to avoid synchronized retries. */
const ANNOTATION_PRIME_RETRY_JITTER_MS = 250

interface AnnotationPrimeController {
  stop(): void
}

function computePrimeRetryDelayMs(attempt: number): number {
  const exponent = Math.max(0, attempt - 1)
  const baseDelay = Math.min(
    ANNOTATION_PRIME_RETRY_MAX_MS,
    ANNOTATION_PRIME_RETRY_BASE_MS * 2 ** exponent,
  )
  const jitter = Math.floor(Math.random() * ANNOTATION_PRIME_RETRY_JITTER_MS)
  return Math.min(ANNOTATION_PRIME_RETRY_MAX_MS, baseDelay + jitter)
}

/**
 * Prime the annotation cache during startup, then keep retrying in the
 * background until success. Failures remain fail-closed by policy defaults.
 */
async function startAnnotationPrimeLoop(
  governedForwarder: GovernedForwarder,
): Promise<AnnotationPrimeController> {
  let stopped = false
  let primed = false
  let retryAttempt = 0
  let retryTimer: ReturnType<typeof setTimeout> | undefined

  const clearRetryTimer = () => {
    if (!retryTimer) return
    clearTimeout(retryTimer)
    retryTimer = undefined
  }

  const stop = () => {
    stopped = true
    clearRetryTimer()
  }

  const scheduleRetry = () => {
    if (stopped || primed || retryTimer) return
    retryAttempt += 1
    const delayMs = computePrimeRetryDelayMs(retryAttempt)
    console.error(
      `[helio] Annotation cache prime retry ${String(retryAttempt)} scheduled in ${String(delayMs)}ms`,
    )
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      void runPrimeAttempt('retry')
    }, delayMs)
    retryTimer.unref()
  }

  const handlePrimeResult = (phase: 'initial' | 'retry', result: AnnotationCachePrimeResult) => {
    if (stopped || primed) return

    if (result.success) {
      primed = true
      clearRetryTimer()
      const prefix =
        phase === 'initial'
          ? '[helio] Annotation cache primed'
          : `[helio] Annotation cache primed after retry ${String(retryAttempt)}`
      console.error(
        `${prefix}: ${String(result.toolsCached)} tool definitions baselined for drift detection (baselines are per-process; a restart re-baselines — review tool_drift audit records before restarting)`,
      )
      return
    }

    const reason = result.reason ?? 'unknown reason'
    if (phase === 'initial') {
      console.error(
        `[helio] Annotation cache priming failed: ${reason} — undocumented tools will be denied (fail-closed) until priming succeeds`,
      )
    } else {
      console.error(
        `[helio] Annotation cache prime retry ${String(retryAttempt)} failed: ${reason} — still fail-closed`,
      )
    }
    scheduleRetry()
  }

  const runPrimeAttempt = async (phase: 'initial' | 'retry') => {
    const result = await governedForwarder.primeAnnotationCache()
    handlePrimeResult(phase, result)
  }

  const initialAttempt = runPrimeAttempt('initial')
  const initialOutcome = await Promise.race([
    initialAttempt.then(() => 'completed' as const),
    new Promise<'timeout'>((resolve) => {
      setTimeout(() => {
        resolve('timeout')
      }, ANNOTATION_PRIME_INITIAL_WAIT_MS).unref()
    }),
  ])

  if (initialOutcome === 'timeout') {
    console.error(
      `[helio] Annotation cache priming did not complete within ${String(ANNOTATION_PRIME_INITIAL_WAIT_MS)}ms; continuing startup fail-closed and retrying in background`,
    )
    scheduleRetry()
  }

  return { stop }
}

async function startCommand(configPath: string, options: StartOptions): Promise<void> {
  let config
  try {
    config = await loadConfig(configPath)
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`Error: ${err.message}`)
      printConfigErrorDetails(err)
      process.exit(1)
    }
    throw err
  }

  const bundledDashboardDistPath = config.dashboard.enabled ? getBundledDashboardDistPath() : null
  if (config.dashboard.enabled && !bundledDashboardDistPath) {
    console.error(
      'Error: dashboard.enabled is true but bundled dashboard assets are missing. ' +
        DASHBOARD_ASSETS_RECOVERY_MESSAGE_FOR_START,
    )
    process.exit(1)
  }

  // Create the right forwarder based on upstream transport
  const { forwarder, close: closeForwarder } = await createForwarderFromConfig(config)

  // Compile policies and wrap the forwarder with governance
  const { policy, warnings } = compilePolicies(config.policies)
  for (const w of warnings) {
    const label = w.ruleName ? `rule "${w.ruleName}"` : `rule ${String(w.ruleIndex)}`
    console.error(`Warning: policy ${label}: ${w.message}`)
  }
  const budgets = compileBudgets(config.budgets)

  // Create dashboard event bus (used by all components for real-time events)
  const eventBus = new DashboardEventBus()

  // Create audit writer
  const auditStore = new AuditStore({
    path: config.audit.path,
    retention: config.audit.retention,
    includeResponses: config.audit.include_responses,
  })

  // Budget ledger: co-located in the audit database (one connection, one WAL
  // domain, one hardening pass) and joined to the store's single retention
  // sweep. The store's constructor purge ran before this hook could exist,
  // so one full sweep runs now — budget rows that aged out while the proxy
  // was down must not wait a day for the timer.
  const budgetLedger = new BudgetLedger({ database: auditStore.database })
  auditStore.onRetentionSweep((cutoff) => {
    budgetLedger.purgeExpired(cutoff.ms)
  })
  auditStore.runRetentionSweep()

  const auditWriter = new AuditWriter({
    store: auditStore,
    onPersist: (record, id) => {
      eventBus.emit('action', {
        id,
        tool_name: record.tool_name,
        policy_decision: record.policy_decision,
        block_reason: record.block_reason,
        approval_status: record.approval_status,
        session_id: record.session_id,
        agent_id: record.agent_id,
        environment: record.environment,
        timestamp: record.timestamp,
        total_duration_ms: record.total_duration_ms,
        approval_wait_ms: record.approval_wait_ms,
        proxy_compute_ms: record.proxy_compute_ms,
        flagged_destructive: record.flagged_destructive,
        dry_run: record.dry_run,
        matched_rule: record.matched_rule,
        matched_rule_index: record.matched_rule_index,
        record_kind: record.record_kind,
        origin: record.origin,
      })
    },
  })
  registerCrashDrainHook(() => {
    try {
      auditWriter.flush()
    } catch (err) {
      console.error('[helio] crash-drain audit flush failed:', err)
    }
  })

  // Create evidence store (zero-cost Map when SDK is not enabled)
  const evidenceStore = new EvidenceStore()

  // Create approval router
  const approvalQueue = new ApprovalQueue()
  const channels = createChannels(config.approval.channels)
  // Snapshot of the runtime registry the hot-reload guard validates against.
  const runtimeChannelTypes = new Map([...channels].map(([key, ch]) => [key, ch.type]))
  const approvalRouter = new ApprovalRouter({
    defaultTimeoutMs: parseDuration(config.approval.timeout),
    defaultOnTimeout: config.approval.default_on_timeout,
    channels,
    queue: approvalQueue,
    onSubmit: (ticket) => {
      eventBus.emit('approval_requested', {
        ticket_id: ticket.id,
        tool_name: ticket.tool_name,
        channel: ticket.channel_name,
        requested_at: ticket.requested_at,
      })
    },
    onResolve: (ticket) => {
      eventBus.emit('approval_resolved', {
        ticket_id: ticket.id,
        status: ticket.status,
        resolved_by: ticket.resolved_by,
        resolved_at: ticket.resolved_at ?? new Date().toISOString(),
      })
    },
    onNotifyFailure: (event) => {
      eventBus.emit('approval_notification_failed', event)
    },
  })

  // Create rate and spend limiters
  const rateLimiter = new RateLimiter({
    onWarning: (state) => {
      eventBus.emit('limit_warning', {
        key: state.key,
        type: 'rate',
        current: state.current,
        limit: state.limit,
        utilization: state.current / state.limit,
      })
    },
  })
  const spendLimiter = new SpendLimiter({
    onWarning: (state) => {
      eventBus.emit('limit_warning', {
        key: state.key,
        type: 'spend',
        current: state.current_spend,
        limit: state.limit,
        utilization: state.current_spend / state.limit,
      })
    },
  })

  // One budget engine shared by both doors — one pot, MCP and sideband alike.
  // Constructed even with zero budgets configured so a hot-reload can
  // introduce budgets without a restart; the gate short-circuits when empty.
  // Hydration replays persisted spend BEFORE any server starts listening, so
  // the first governed call already sees the rebuilt pots.
  const budgetEngine = new BudgetEngine({
    budgets,
    ledger: budgetLedger,
    onCommit: (event) => {
      eventBus.emit('budget_update', event)
    },
    onBreach: (event) => {
      eventBus.emit('budget_breached', event)
    },
  })
  budgetEngine.hydrate()

  const governedForwarder = new GovernedForwarder(forwarder, policy, {
    environment: config.environment,
    auditWriter,
    evidenceStore,
    approvalRouter,
    rateLimiter,
    spendLimiter,
    budgetEngine,
  })

  const annotationPrime = await startAnnotationPrimeLoop(governedForwarder)

  // Conditionally create Slack action handler if any Slack channels exist
  const hasSlackChannels = [...channels.values()].some((ch) => ch.type === 'slack')
  const slackActionApp = hasSlackChannels
    ? createSlackActionApp({ router: approvalRouter, channels })
    : undefined

  const app = createApp(config, governedForwarder, {
    slackActionApp,
  })
  const handle = startServer(app, config)

  // Conditionally start the sideband server for SDK communication.
  //
  // Authentication: the sideband speaks to the Python SDK and must not
  // accept requests from arbitrary local processes or browser pages. We
  // generate a fresh 32-byte hex token on every start and export it via
  // the `HELIO_SDK_TOKEN` env var for the SDK to pick up. If the operator
  // sets `HELIO_SDK_TOKEN` explicitly (e.g. for stable cross-restart
  // tokens or in test environments), we respect that instead — rotating a
  // pre-set secret is the operator's responsibility.
  let sidebandHandle: ServerHandle | undefined
  let sidebandToken: string | undefined
  let sidebandTokenSource: 'generated' | 'env' | undefined
  let adapterToken: string | undefined
  let adapterTokenSource: 'generated' | 'env' | undefined
  let governanceService: GovernanceService | undefined
  if (config.sdk.enabled) {
    sidebandToken = process.env['HELIO_SDK_TOKEN']
    if (!sidebandToken || sidebandToken.length === 0) {
      sidebandToken = randomBytes(32).toString('hex')
      process.env['HELIO_SDK_TOKEN'] = sidebandToken
      sidebandTokenSource = 'generated'
    } else {
      sidebandTokenSource = 'env'
    }

    // Governance routes carry a SEPARATE adapter-scope token (issue #12, D1):
    // an SDK client must not be able to drive policy decisions, nor an adapter
    // write evidence it was not granted. Same per-boot/env provisioning as the
    // SDK token.
    adapterToken = process.env['HELIO_ADAPTER_TOKEN']
    if (!adapterToken || adapterToken.length === 0) {
      adapterToken = randomBytes(32).toString('hex')
      process.env['HELIO_ADAPTER_TOKEN'] = adapterToken
      adapterTokenSource = 'generated'
    } else {
      adapterTokenSource = 'env'
    }

    // The service reuses the SAME limiter/queue/router/writer instances as the
    // MCP path — one budget, both doors. A counter consumed via /audit is
    // visible to a subsequent MCP tools/call and vice versa.
    governanceService = new GovernanceService({
      policy,
      environment: config.environment,
      evidenceStore,
      approvalRouter,
      rateLimiter,
      spendLimiter,
      budgetEngine,
      auditWriter,
      approvalTimeoutMs: parseDuration(config.approval.timeout),
      ttlMs: parseDuration(config.sdk.evaluation_ttl),
    })

    const sidebandApp = createSidebandApp(evidenceStore, {
      token: sidebandToken,
      adapterToken,
      governance: governanceService,
    })
    sidebandHandle = startSidebandServer(sidebandApp, config.sdk.port, config.sdk.host)
  }

  // Conditionally start the dashboard API server
  let dashboardHandle: ServerHandle | undefined
  let closeDashboardApp: (() => void) | undefined
  if (config.dashboard.enabled) {
    const dashboardApp = createDashboardAppWithLifecycle(
      {
        auditStore,
        approvalRouter,
        approvalQueue,
        rateLimiter,
        spendLimiter,
        evidenceStore,
        eventBus,
        // Adapter liveness for GET /api/adapters (issue #126); undefined
        // unless the SDK sideband is enabled → endpoint serves an empty list.
        adapterLiveness: governanceService,
        // Budget read surface (issue #14): live pot states from the engine,
        // spend history from the ledger.
        budgets: {
          listStates: () => budgetEngine.listStates(),
          listEvents: (name, page) => budgetLedger.listEvents(name, page),
        },
      },
      {
        apiSecret: config.dashboard.api_secret,
        staticDir: bundledDashboardDistPath ?? undefined,
        sseHeartbeatMs: parseDuration(config.dashboard.sse_heartbeat_interval),
      },
    )
    closeDashboardApp = dashboardApp.close
    dashboardHandle = startSidebandServer(
      dashboardApp.app,
      config.dashboard.port,
      config.dashboard.host,
    )
  }

  const ruleCount = policy.rules.length
  console.error(
    `Helio proxy listening on http://${config.listen.host}:${String(config.listen.port)}`,
  )
  console.error(
    `Policies: ${String(ruleCount)} rule${ruleCount !== 1 ? 's' : ''} loaded (default: ${policy.defaultAction})`,
  )
  warnIfNoEnforcement(policy)
  if (config.upstream.transport === 'stdio') {
    console.error(`Upstream: ${config.upstream.command ?? ''} (stdio)`)
  } else {
    console.error(`Upstream: ${config.upstream.url} (${config.upstream.transport})`)
  }
  console.error(`Audit: ${config.audit.path} (retention: ${config.audit.retention})`)
  if (sidebandHandle) {
    console.error(`SDK sideband listening on http://${config.sdk.host}:${String(config.sdk.port)}`)
    // A generated token must be printed — stderr is its only handoff. An
    // operator-provided one must NOT be: echoing it would copy a long-lived
    // secret into process logs the operator's secret management never sees.
    if (sidebandToken) {
      console.error(
        sidebandTokenSource === 'env'
          ? 'SDK token: reusing HELIO_SDK_TOKEN from environment (value not shown)'
          : `SDK token (generated per-boot HELIO_SDK_TOKEN; pass as HELIO_SDK_TOKEN env var to your SDK clients):\n  ${sidebandToken}`,
      )
    }
    if (adapterToken) {
      console.error(
        adapterTokenSource === 'env'
          ? 'Adapter token: reusing HELIO_ADAPTER_TOKEN from environment (value not shown)'
          : `Adapter token (generated per-boot HELIO_ADAPTER_TOKEN; governance routes; pass as HELIO_ADAPTER_TOKEN to your adapter):\n  ${adapterToken}`,
      )
    }
  }
  if (dashboardHandle) {
    console.error(
      `Dashboard API listening on http://${config.dashboard.host}:${String(config.dashboard.port)}`,
    )
  }
  warnIfWebhookChannelUnreachable(config)
  warnIfSdkSidebandExposed(config)
  warnIfDashboardOpenMode(config)
  warnIfBudgetWindowExceedsRetention(config)
  const channelCount = config.approval.channels.length
  console.error(
    `Approvals: timeout ${config.approval.timeout}, default on timeout: ${config.approval.default_on_timeout}, ${String(channelCount)} channel${channelCount !== 1 ? 's' : ''} configured`,
  )
  console.error(`Rate limits: enabled`)
  console.error(`Spend limits: enabled`)
  const budgetCount = budgets.length
  console.error(
    `Budgets: ${String(budgetCount)} configured${budgetCount > 0 ? ` (${budgets.map((b) => b.name).join(', ')})` : ''}`,
  )
  if (policy.dryRun) {
    console.error(`Dry-run: ENABLED (no requests will be forwarded to upstream)`)
  }
  console.error(`Config: ${configPath}`)

  // Hot-reload is enabled by default. The CLI flag takes precedence over
  // the config file so operators can pin the policy for a single start
  // without editing YAML. When disabled, config edits require a restart.
  const hotReloadEnabled =
    options.noHotReload === true ? false : (config.policies.hot_reload ?? true)

  let configWatcher: ConfigWatcher | undefined
  if (hotReloadEnabled) {
    configWatcher = new ConfigWatcher({
      configPath,
      initialConfig: config,
      onReload: (newPolicy, reloadWarnings, restartRequiredPaths, newBudgets) => {
        // The RUNNING approval surface is startup-bound: a reload whose
        // policy or budgets reference channels (or a dashboard) that only
        // exist in the NEW file would validate on paper and then route
        // tickets into the void. Reject the whole reload instead — the
        // throw lands in onError, keeping the current configuration.
        const unroutable = findUnroutableApprovalReferences(newPolicy, newBudgets, {
          channelTypes: runtimeChannelTypes,
          dashboardEnabled: config.dashboard.enabled,
          defaultApprovalTimeoutMs: parseDuration(config.approval.timeout),
        })
        if (unroutable.length > 0) {
          throw new Error(
            `approval routing is not available in the running process (restart required ` +
              `to apply approval.channels/dashboard changes): ${unroutable.join('; ')}`,
          )
        }
        // Budgets reconcile FIRST: it persists the reload's epoch mints and
        // throws when the flush fails, which rejects the whole reload (the
        // watcher's onError keeps the current config) before any policy
        // swap — the reload applies all-or-nothing across the file.
        budgetEngine.reconcile(newBudgets)
        governedForwarder.updatePolicy(newPolicy)
        governanceService?.updatePolicy(newPolicy)
        const budgetTotal = newBudgets.length
        console.error(
          `[helio] Budgets reloaded: ${String(budgetTotal)} budget${budgetTotal !== 1 ? 's' : ''}`,
        )
        const count = newPolicy.rules.length
        console.error(
          `[helio] Policy reloaded: ${String(count)} rule${count !== 1 ? 's' : ''} (default: ${newPolicy.defaultAction})`,
        )
        for (const w of reloadWarnings) {
          const label = w.ruleName ? `rule "${w.ruleName}"` : `rule ${String(w.ruleIndex)}`
          console.error(`[helio] Warning: policy ${label}: ${w.message}`)
        }
        if (newPolicy.dryRun) {
          console.error(`[helio] Dry-run mode is ENABLED`)
        }
        if (restartRequiredPaths.length > 0) {
          const changed = restartRequiredPaths.join(', ')
          console.error(
            `[helio] Restart required: non-reloadable fields changed (${changed}). ` +
              'The running process still uses startup values for these fields.',
          )
        }
      },
      onError: (error) => {
        console.error(
          `[helio] Config reload failed (keeping current configuration): ${error.message}`,
        )
        if (error instanceof ConfigError) {
          printConfigErrorDetails(error, '[helio] ')
        }
      },
    })
    configWatcher.start()
    console.error(`Watching ${configPath} for policy changes`)
  } else {
    console.error(
      `[helio] Hot-reload disabled — config changes to ${configPath} will require a restart`,
    )
  }

  registerShutdown(
    handle,
    annotationPrime,
    closeForwarder,
    auditWriter,
    configWatcher,
    sidebandHandle,
    evidenceStore,
    approvalRouter,
    approvalQueue,
    rateLimiter,
    spendLimiter,
    budgetEngine,
    closeDashboardApp,
    dashboardHandle,
    eventBus,
    governanceService,
  )
}

async function initCommand(outputPath: string, force: boolean): Promise<void> {
  if (existsSync(outputPath) && !force) {
    console.error(`Error: ${outputPath} already exists. Use --force to overwrite.`)
    process.exit(1)
  }

  const apiSecret = randomBytes(32).toString('hex')
  await writeFile(outputPath, renderConfigTemplate(apiSecret), 'utf-8')

  console.error(`Created ${outputPath}`)
  console.error('')
  console.error('Generated dashboard.api_secret (also stored in the file above):')
  console.error(`  ${apiSecret}`)
  console.error('')
  console.error('Use this as the dashboard login secret (and optional Bearer credential')
  console.error('for sideband API clients at default 127.0.0.1:3100). Rotate in-file.')
}

async function validateCommand(configPath: string): Promise<void> {
  try {
    const config = await loadConfig(configPath)

    // Also compile policies and budgets to catch invalid globs, regex
    // patterns, etc.
    const { warnings } = compilePolicies(config.policies)
    for (const w of warnings) {
      const label = w.ruleName ? `rule "${w.ruleName}"` : `rule ${String(w.ruleIndex)}`
      console.error(`Warning: policy ${label}: ${w.message}`)
    }
    compileBudgets(config.budgets)

    if (config.dashboard.enabled && !getBundledDashboardDistPath()) {
      console.error(
        'Invalid config: dashboard.enabled is true but bundled dashboard assets are missing. ' +
          DASHBOARD_ASSETS_RECOVERY_MESSAGE_FOR_VALIDATE,
      )
      process.exit(1)
    }

    const ruleCount = config.policies.rules.length
    const budgetCount = config.budgets.length
    console.error(
      `Config is valid: ${configPath} (${String(ruleCount)} policy rule${ruleCount !== 1 ? 's' : ''}, ` +
        `${String(budgetCount)} budget${budgetCount !== 1 ? 's' : ''})`,
    )
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`Invalid config: ${err.message}`)
      printConfigErrorDetails(err)
      process.exit(1)
    }
    if (err instanceof PolicyParseError) {
      console.error(`Invalid policy: ${err.message}`)
      process.exit(1)
    }
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

interface ExportOptions {
  config: string
  format: string
  tool?: string
  decision?: string
  reason?: string
  session?: string
  from?: string
  to?: string
  limit: string
}

async function exportCommand(opts: ExportOptions): Promise<void> {
  // Strict validation: an audit-export tool must never silently truncate.
  // parseInt-style leniency would turn "--limit 1e3" into 1 record.
  const parsedLimit = Number(opts.limit)
  if (!Number.isInteger(parsedLimit) || parsedLimit < 1) {
    console.error(
      `Error: --limit must be an integer between 1 and ${String(EXPORT_MAX_RECORDS)} (got "${opts.limit}")`,
    )
    process.exit(1)
  }
  const limit = Math.min(parsedLimit, EXPORT_MAX_RECORDS)

  let config
  try {
    config = await loadConfig(opts.config)
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`Error: ${err.message}`)
      printConfigErrorDetails(err)
      process.exit(1)
    }
    throw err
  }

  const store = new AuditStore({
    path: config.audit.path,
    retention: config.audit.retention,
    includeResponses: config.audit.include_responses,
    cleanupIntervalMs: 0, // No cleanup timer for one-shot CLI
  })

  try {
    const result = store.listForExport(
      {
        tool_name: opts.tool,
        policy_decision: opts.decision,
        block_reason: opts.reason,
        session_id: opts.session,
        from: opts.from,
        to: opts.to,
      },
      limit,
    )

    if (opts.format === 'csv') {
      writeCsv(result.records)
    } else {
      console.log(JSON.stringify(result.records, null, 2))
    }

    console.error(`Exported ${String(result.records.length)} of ${String(result.total)} records`)
  } finally {
    store.close()
  }
}

function writeCsv(records: readonly AuditRecord[]): void {
  console.log(CSV_HEADERS.join(','))

  for (const r of records) {
    const values = CSV_HEADERS.map((h) => {
      const val: unknown = r[h]
      if (val === null || val === undefined) return ''
      if (typeof val === 'boolean') return val ? 'true' : 'false'
      if (typeof val === 'number') return String(val)
      if (typeof val === 'string') return csvEscape(val)
      return ''
    })
    console.log(values.join(','))
  }
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

function registerShutdown(
  handle: ServerHandle,
  annotationPrime?: AnnotationPrimeController,
  closeForwarder?: () => Promise<void>,
  auditWriter?: AuditWriter,
  configWatcher?: ConfigWatcher,
  sidebandHandle?: ServerHandle,
  evidenceStore?: EvidenceStore,
  approvalRouter?: ApprovalRouter,
  approvalQueue?: ApprovalQueue,
  rateLimiter?: RateLimiter,
  spendLimiter?: SpendLimiter,
  budgetEngine?: BudgetEngine,
  closeDashboardApp?: () => void,
  dashboardHandle?: ServerHandle,
  eventBus?: DashboardEventBus,
  governanceService?: GovernanceService,
): void {
  let isShuttingDown = false
  const shutdown = () => {
    if (isShuttingDown) return
    isShuttingDown = true
    console.error('\n[helio] Shutting down...')
    const forceShutdownTimer = setTimeout(() => {
      console.error('[helio] Forced shutdown after timeout')
      process.exit(1)
    }, SHUTDOWN_TIMEOUT_MS)
    forceShutdownTimer.unref()

    void closeResources({
      handle,
      annotationPrime,
      closeForwarder,
      auditWriter,
      configWatcher,
      sidebandHandle,
      evidenceStore,
      approvalRouter,
      approvalQueue,
      rateLimiter,
      spendLimiter,
      budgetEngine,
      closeDashboardApp,
      dashboardHandle,
      eventBus,
      governanceService,
    })
      .then(() => {
        clearTimeout(forceShutdownTimer)
        process.exit(0)
      })
      .catch((err: unknown) => {
        clearTimeout(forceShutdownTimer)
        console.error('[helio] Error during shutdown:', err)
        process.exit(1)
      })
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

const program = new Command()
  .name('helio')
  .description('Helio MCP governance proxy')
  .version(VERSION)

program
  .command('start')
  .description('Load config and start the proxy server')
  .option('-c, --config <path>', 'Path to helio.yaml', DEFAULT_CONFIG_PATH)
  .option('--no-hot-reload', 'Disable policy hot-reload — config edits will require a restart')
  .action((opts: { config: string; hotReload?: boolean }) =>
    startCommand(opts.config, { config: opts.config, noHotReload: opts.hotReload === false }),
  )

program
  .command('init')
  .description('Scaffold a helio.yaml config file with commented defaults')
  .option('-o, --output <path>', 'Output file path', DEFAULT_CONFIG_PATH)
  .option('-f, --force', 'Overwrite existing file', false)
  .action((opts: { output: string; force: boolean }) => initCommand(opts.output, opts.force))

program
  .command('validate')
  .description('Validate a helio.yaml config file')
  .option('-c, --config <path>', 'Path to helio.yaml', DEFAULT_CONFIG_PATH)
  .action((opts: { config: string }) => validateCommand(opts.config))

program
  .command('export')
  .description('Export audit records to JSON or CSV')
  .option('-c, --config <path>', 'Path to helio.yaml', DEFAULT_CONFIG_PATH)
  .option('-f, --format <format>', 'Output format: json or csv', 'json')
  .option('--tool <name>', 'Filter by tool name')
  .option('--decision <decision>', 'Filter by policy decision')
  .option('--reason <reason>', 'Filter by block reason')
  .option('--session <id>', 'Filter by session ID')
  .option('--from <iso>', 'Start time (ISO 8601)')
  .option('--to <iso>', 'End time (ISO 8601)')
  .option('--limit <n>', 'Max records to export (up to 10000)', '1000')
  .action((opts: ExportOptions) => exportCommand(opts))

program.parse()
