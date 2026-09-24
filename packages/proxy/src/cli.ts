/* eslint-disable no-console -- CLI entry point, console is the intended output */
import { Command } from 'commander'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { accessSync, constants, existsSync, statSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { VERSION } from './version.js'
import {
  loadConfig,
  loadConfigWithMeta,
  parseConfigSource,
  readConfigSource,
  ConfigError,
  ConfigWatcher,
  PolicyReloadRejectedError,
  readConfigPin,
  isNamedConfig,
} from './config/index.js'
import type { HelioConfig, SingularHelioConfig } from './config/index.js'
import { DEFAULT_REARM_INTERVAL_MS } from './config/watcher.js'
import { findUnroutableApprovalReferences } from './config/reload-boundary.js'
import { secretDigest } from './auth/bearer.js'
import {
  SANDBOX_DEFAULT_DIR,
  SANDBOX_FILES,
  renderSandboxCompose,
  renderSandboxConfig,
  renderSandboxReadme,
  sandboxImageTag,
} from './sandbox-scaffold.js'
import {
  BACKUP_SUFFIX,
  MANIFEST_FILE,
  PROJECT_CLIENT_FILES,
  TEMP_SUFFIX,
  adoptServers,
  backupFile,
  classifyClientPath,
  detectClientConfigs,
  readManifest,
  restoreBackups,
  writeFileAtomic,
  writeManifest,
} from './client-adopt.js'
import type { ClientFormat, ClientSource, Manifest } from './client-adopt.js'
import type { Hono } from 'hono'
import { createApp, createMultiApp, startServer, startSidebandServer } from './server.js'
import { applyReloadedPolicy } from './reload-fanout.js'
import { createForwarderFromConfig } from './cli-forwarder.js'
import type { BuiltForwarder } from './cli-forwarder.js'
import type { McpForwarder } from './mcp/types.js'
import { compilePolicies, PolicyParseError } from './policy/index.js'
import type { CompiledPolicy, CompilePoliciesResult } from './policy/index.js'
import { GovernedForwarder } from './policy/governed-forwarder.js'
import type { GovernedForwarderOptions } from './policy/governed-forwarder.js'
import { compileSessionIdentity } from './mcp/session-resolver.js'
import { startAnnotationPrimeLoop } from './policy/annotation-prime-loop.js'
import type { AnnotationPrimeController } from './policy/annotation-prime-loop.js'
import { classifySurface, formatCoverageLine, formatSurfaceLine } from './policy/surface.js'
import type { SurfaceDoor } from './policy/surface.js'
import {
  buildPolicyStatus,
  DEFAULT_STATUS_WINDOW,
  evaluateReadiness,
  formatReadinessLine,
  parseStatusWindow,
  renderPolicyStatusText,
} from './policy/status.js'
import type { PolicyStatusReport } from './policy/status.js'
import { fetchPolicyStatus } from './policy/status-fetch.js'
import { buildActivationReport, renderActivationText, windowSince } from './report/activation.js'
import type { ConfigFileVsLastPolicyWrite, SnapshotAbsentReason } from './report/activation.js'
import type { ActivationTimeline, ActivationWindow, PersistedSummary } from './audit/types.js'
import {
  AuditStore,
  AuditWriter,
  EXPORT_MAX_RECORDS,
  buildHeaderMismatchAuditRecord,
  buildPolicyReloadRecord,
} from './audit/index.js'
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
import {
  BudgetEngine,
  BudgetLedger,
  BudgetParseError,
  budgetEventsToCsv,
  compileBudgets,
} from './budget/index.js'
import type { CompiledBudget } from './budget/index.js'
import { parseDuration } from './config/schema.js'
import {
  createDashboardAppWithLifecycle,
  DashboardEventBus,
  dashboardEventCallbacks,
} from './dashboard/index.js'
import type { AuditRecord } from './audit/index.js'
import { CSV_HEADERS, csvEscape } from './audit/csv.js'
import type { ServerHandle } from './server.js'
import {
  warnIfWebhookChannelUnreachable,
  warnIfSdkSidebandExposed,
  warnIfDashboardOpenMode,
  warnIfNoEnforcement,
  enforcesNothing,
  warnIfBudgetWindowExceedsRetention,
  warnIfManyUpstreams,
  warnIfStdioUrlIgnored,
  warnIfDashboardSecretLiteral,
  warnIfConfigWritableByProxyUser,
} from './startup-warnings.js'
import { closeResources } from './shutdown.js'
import { drainForCrash, registerCrashDrainHook } from './crash-drain.js'
import { StartupError } from './startup-error.js'

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

function renderConfigTemplate(apiSecretDigest: string): string {
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

# Multiple named upstreams (multi-upstream mode) replace \`upstream:\` —
# set exactly one of the two. See docs/configuration.md.
# upstreams:
#   - name: files
#     url: "http://localhost:8081/mcp"

# listen:
#   port: 3000
#   host: 127.0.0.1

# environment: production

# session:
#   identity: # ordered; first match wins
#     - source: header
#       name: x-helio-session-id
#     - source: legacy_header # verbatim Mcp-Session-Id (deprecation window)
#   on_unresolved: deny # deny | anonymous

# policies:
#   default: allow
#   dry_run: false
#   rules: []

# budgets:
#   # One depleting pot shared by every tool that spends.
#   - name: agent-payments
#     limit: 50
#     currency: USD
#     window: session
#     key: session
#     on_exceed: deny # or require_approval for a break-glass ticket
#     contributors:
#       - match:
#           tool: 'stripe_*'
#         field: '$.amount'
#       - match:
#           tool: 'paypal_*'
#         field: '$.total'

# approval:
#   timeout: 300s
#   default_on_timeout: deny
#   channels: []

# audit:
#   storage: sqlite
#   path: ./helio-audit.db
#   retention: 90d
#   include_responses: true

# Operator dashboard + approval REST API. Bound to 127.0.0.1 by default. Do
# not change to 0.0.0.0 without putting an authenticating reverse proxy in
# front. dashboard.api_secret holds the SHA-256 digest of the dashboard
# secret, never the secret itself: log in to the dashboard and authenticate
# sideband API clients with the secret that \`helio init\` printed once. To
# rotate, run \`helio secret\`, paste the new digest here, and restart the
# proxy; active dashboard sessions are invalidated. A plaintext value is
# still accepted.
dashboard:
  enabled: true
  port: 3100
  host: 127.0.0.1
  api_secret: "${apiSecretDigest}"

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

/**
 * The one line for a config that loaded but did not compile: a policy
 * rule or a budget whose glob or regex was rejected. Both `validate`
 * and `start` print it, so the two surfaces cannot drift (issue #195).
 * Returns undefined for anything that is not a compile failure.
 */
function compileFailureLine(err: unknown): string | undefined {
  if (err instanceof PolicyParseError) return `Invalid policy: ${err.message}`
  if (err instanceof BudgetParseError) return `Invalid budget: ${err.message}`
  return undefined
}

/**
 * The one diagnosis for an audit.path the store could not open because of
 * where it points: its directory must exist, be a directory, and be
 * searchable, the path itself must not be a directory, and when the
 * file does not exist yet the directory must be writable so it can be
 * created (issue #388). Returned without a prefix: start and export
 * throw it as an `Invalid config:` StartupError, because they run where
 * the directory has to be; validate prints it as a `Warning:` and still
 * accepts the file, because it is run on hosts that will not run start
 * (a config for a container, or for a service account's directory). One
 * body, so the surfaces cannot drift. The directory is named resolved,
 * because a relative path resolves against the working directory, not
 * the config file. Nothing else is checked: a read-only file still
 * exports, and an existing database only needs directory write for
 * sidecars that are not already there, so SQLite keeps the last word on
 * an existing file. `:memory:` has no directory.
 */
function auditPathProblem(auditPath: string): string | undefined {
  if (auditPath === ':memory:') return undefined
  const file = resolve(auditPath)
  const dir = dirname(file)
  const prefix = 'audit.path:'
  const errnoCode = (err: unknown): string => (err as NodeJS.ErrnoException).code ?? 'unknown error'
  let dirStat: Stats
  try {
    dirStat = statSync(dir)
  } catch (err) {
    const code = errnoCode(err)
    if (code === 'ENOENT') return `${prefix} directory ${dir} does not exist`
    if (code === 'ENOTDIR') return `${prefix} ${dir} is not a directory`
    return `${prefix} directory ${dir} cannot be accessed (${code})`
  }
  if (!dirStat.isDirectory()) return `${prefix} ${dir} is not a directory`
  let fileStat: Stats | undefined
  try {
    fileStat = statSync(file, { throwIfNoEntry: false })
  } catch (err) {
    // throwIfNoEntry suppresses ENOENT only; a directory this process
    // cannot search throws EACCES here after the checks above passed.
    return `${prefix} ${file} cannot be accessed (${errnoCode(err)})`
  }
  if (fileStat?.isDirectory()) return `${prefix} ${file} is a directory, not a file`
  if (fileStat === undefined) {
    try {
      accessSync(dir, constants.W_OK)
    } catch {
      return `${prefix} directory ${dir} is not writable by this user`
    }
  }
  return undefined
}

/**
 * Phase 1 of per-upstream stack assembly: build and connect the transport
 * forwarder for one upstream section. Kept separate from governUpstream so
 * every upstream connects before any shared service is constructed — a bad
 * upstream fails boot without side effects (no audit DB is created).
 */
async function connectUpstream(
  upstream: SingularHelioConfig['upstream'],
  upstreamName?: string,
): Promise<BuiltForwarder> {
  try {
    return await createForwarderFromConfig({ upstream }, upstreamName)
  } catch (err) {
    // A connect failure is a diagnosed boot failure, not a crash (#233). A
    // named entry's failure names the entry; singular mode prints the
    // underlying message ALONE — no name is ever minted for it.
    const message = err instanceof Error ? err.message : String(err)
    throw new StartupError(
      upstreamName === undefined ? message : `upstream "${upstreamName}": ${message}`,
    )
  }
}

/**
 * Close every connected door while aborting startup. Best effort: a close
 * failure is logged and never thrown, so the abort's own diagnosis stays
 * the last word.
 */
async function closeDoorsBestEffort(
  doors: ReadonlyArray<{ close?: () => Promise<void> }>,
): Promise<void> {
  for (const door of doors) {
    try {
      await door.close?.()
    } catch (closeErr) {
      console.error(
        `[helio] Ignoring a forwarder close failure while aborting startup: ${String(closeErr)}`,
      )
    }
  }
}

/** The config paths of the three ports `helio start` binds. */
type PortSetting = 'listen.port' | 'sdk.port' | 'dashboard.port'

/**
 * The operator line for a port that could not be bound (#375). Names the
 * setting the port came from, the configured host, the port, and the code,
 * and says which file to change: `configPath` is the file this boot loaded,
 * printed as given. A held port gets its own sentence; every other bind
 * error quotes Node's message.
 */
function listenFailureMessage(
  setting: PortSetting,
  host: string,
  port: number,
  configPath: string,
  err: unknown,
): string {
  const bindError =
    err instanceof Error
      ? (err as Error & { code?: string; address?: string; port?: number })
      : undefined
  if (bindError?.code === 'EADDRINUSE') {
    // A named host resolves to an address Node reports; say so when it is
    // not the configured host verbatim (`localhost` resolved to `::1`).
    const resolved =
      bindError.address !== undefined && bindError.address !== host
        ? ` at ${bindError.address}:${String(bindError.port ?? port)}`
        : ''
    return (
      `${setting} ${String(port)} is already in use on ${host} (EADDRINUSE${resolved}). ` +
      `Stop the process holding it, or set ${setting} in ${configPath} to a free port.`
    )
  }
  const hostSetting = setting.replace(/\.port$/, '.host')
  const detail = bindError ? bindError.message : String(err)
  return (
    `${setting} ${String(port)} on ${host} cannot be bound: ${detail}. ` +
    `Check ${hostSetting} and ${setting} in ${configPath}.`
  )
}

/** One governed upstream stack: the forwarder wrapped in governance plus
 *  its running annotation prime loop. */
interface UpstreamStack {
  readonly governedForwarder: GovernedForwarder
  readonly annotationPrime: AnnotationPrimeController
}

/**
 * Phase 2 of per-upstream stack assembly: wrap a connected forwarder with
 * governance and start its annotation prime loop. Runs after the shared
 * services exist; `governance` carries the services every stack shares.
 */
async function governUpstream(options: {
  forwarder: McpForwarder
  policy: CompiledPolicy
  governance: GovernedForwarderOptions
  upstreamName?: string
}): Promise<UpstreamStack> {
  const governedForwarder = new GovernedForwarder(options.forwarder, options.policy, {
    ...options.governance,
    upstreamName: options.upstreamName,
  })
  const annotationPrime = await startAnnotationPrimeLoop(
    governedForwarder,
    options.policy.toolRevalidation,
    options.upstreamName,
  )
  return { governedForwarder, annotationPrime }
}

interface StartOptions {
  config: string
  /** When true, do not start the config file watcher. Overrides the YAML. */
  noHotReload?: boolean
}

async function startCommand(configPath: string, options: StartOptions): Promise<void> {
  let config
  let interpolatedPaths: readonly string[] = []
  let configSha256 = ''
  try {
    const loaded = await loadConfigWithMeta(configPath)
    config = loaded.config
    interpolatedPaths = loaded.interpolatedPaths
    configSha256 = loaded.sha256
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`Error: ${err.message}`)
      printConfigErrorDetails(err)
      process.exit(1)
    }
    throw err
  }

  const configPin = readConfigPin()
  if (configPin.status === 'invalid') {
    console.error(
      `Error: HELIO_CONFIG_SHA256 is set but is not a SHA-256 hex digest ` +
        `(64 hex characters, with or without a sha256: prefix): "${configPin.raw.slice(0, 80)}"`,
    )
    process.exit(1)
  }
  if (configPin.status === 'set' && configPin.sha256 !== configSha256) {
    console.error(
      `Error: HELIO_CONFIG_SHA256 does not match ${configPath}: pinned sha256:${configPin.sha256}, ` +
        `file sha256:${configSha256}. Review the change and re-pin it with helio config hash.`,
    )
    process.exit(1)
  }
  const pinnedSha256 = configPin.status === 'set' ? configPin.sha256 : undefined

  // Compile BEFORE any environment check or side effect (issue #195): a
  // file that does not compile is refused the way validate refuses it,
  // with no upstream connected, no stdio child spawned, no audit DB.
  // The line is the complete diagnosis; StartupError prints it verbatim.
  let compiled: CompilePoliciesResult & { readonly budgets: CompiledBudget[] }
  try {
    const { policy, warnings } = compilePolicies(config.policies)
    compiled = { policy, warnings, budgets: compileBudgets(config.budgets) }
  } catch (err) {
    const line = compileFailureLine(err)
    if (line === undefined) throw err
    throw new StartupError(line)
  }
  const { policy, warnings, budgets } = compiled
  for (const w of warnings) {
    const label = w.ruleName ? `rule "${w.ruleName}"` : `rule ${String(w.ruleIndex)}`
    console.error(`Warning: policy ${label}: ${w.message}`)
  }

  // The audit directory is checked BEFORE the connect loop (issue #388):
  // a path the store cannot open is refused with no upstream connected,
  // no stdio child spawned, and no directory created.
  const auditProblem = auditPathProblem(config.audit.path)
  if (auditProblem !== undefined) throw new StartupError(`Invalid config: ${auditProblem}`)

  const bundledDashboardDistPath = config.dashboard.enabled ? getBundledDashboardDistPath() : null
  if (config.dashboard.enabled && !bundledDashboardDistPath) {
    console.error(
      'Error: dashboard.enabled is true but bundled dashboard assets are missing. ' +
        DASHBOARD_ASSETS_RECOVERY_MESSAGE_FOR_START,
    )
    process.exit(1)
  }

  // The capacity guardrail prints BEFORE the connect loop, so the operator
  // hears it even when an early entry fails to connect.
  if (isNamedConfig(config)) {
    warnIfManyUpstreams(config)
  }
  warnIfStdioUrlIgnored(config)

  // Phase 1 of per-upstream assembly: connect EVERY upstream before any
  // shared service is constructed — a bad upstream fails boot with no side
  // effects (no audit DB is created). Sequential, in config order, and
  // all-or-nothing: the first failure closes whatever already connected
  // (best-effort) and aborts the boot naming the entry. Singular mode is
  // the same loop over one nameless entry.
  const upstreamSections: Array<{
    name: string | undefined
    upstream: SingularHelioConfig['upstream']
  }> = isNamedConfig(config)
    ? config.upstreams.map((entry) => ({ name: entry.name, upstream: entry }))
    : [{ name: undefined, upstream: config.upstream }]

  const doors: Array<{
    name: string | undefined
    forwarder: McpForwarder
    close?: () => Promise<void>
  }> = []
  for (const { name, upstream } of upstreamSections) {
    try {
      const built = await connectUpstream(upstream, name)
      doors.push({ name, forwarder: built.forwarder, close: built.close })
    } catch (err) {
      await closeDoorsBestEffort(doors)
      throw err
    }
  }

  // Create dashboard event bus (used by all components for real-time events)
  // and the shared record/ticket/limiter-state projections onto it. The
  // source-guard test pins this exact binding + assignment form.
  const eventBus = new DashboardEventBus()
  const cbs = dashboardEventCallbacks(eventBus)

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
    onPersist: cbs.onPersist,
    // Seed the config hash at construction so no record is written unstamped
    // between here and the first reload; the reload path replaces it.
    configSha256,
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
    onSubmit: cbs.onApprovalSubmit,
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
    onWarning: cbs.onRateWarning,
  })
  const spendLimiter = new SpendLimiter({
    onWarning: cbs.onSpendWarning,
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

  // Compiled once at startup, shared by both doors — session is
  // restart-required at the reload boundary (issue #218).
  const session = compileSessionIdentity(config.session)

  // Phase 2 of per-upstream assembly: wrap every connected forwarder with
  // governance and start its annotation prime loop. Sequential in config
  // order; each door waits its prime loop's startup window, so a slow
  // upstream costs up to 1.5s per entry at boot (accepted v1). The shared
  // services are constructed once and every stack composes them.
  const governance: GovernedForwarderOptions = {
    environment: config.environment,
    auditWriter,
    evidenceStore,
    approvalRouter,
    rateLimiter,
    spendLimiter,
    budgetEngine,
    session,
  }
  const stacks: Array<{ name: string | undefined } & UpstreamStack> = []
  for (const door of doors) {
    stacks.push({
      name: door.name,
      ...(await governUpstream({
        forwarder: door.forwarder,
        policy,
        governance,
        upstreamName: door.name,
      })),
    })
  }

  // Conditionally create Slack action handler if any Slack channels exist
  const hasSlackChannels = [...channels.values()].some((ch) => ch.type === 'slack')
  const slackActionApp = hasSlackChannels
    ? createSlackActionApp({ router: approvalRouter, channels })
    : undefined

  // The apps serve the GOVERNED forwarders — mounting a raw transport
  // forwarder would silently bypass policy, approval, and audit.
  let app: Hono
  if (isNamedConfig(config)) {
    const forwarders: Record<string, McpForwarder> = {}
    for (const stack of stacks) {
      if (stack.name !== undefined) forwarders[stack.name] = stack.governedForwarder
    }
    app = createMultiApp(config, forwarders, {
      slackActionApp,
      onHeaderMismatch: (rejection, upstreamName) => {
        auditWriter.pushImmediate(
          buildHeaderMismatchAuditRecord(rejection, config.environment, upstreamName),
        )
      },
    })
  } else {
    const stack = stacks[0]
    if (stack === undefined) {
      throw new Error('unreachable: singular mode connects exactly one upstream')
    }
    app = createApp(config, stack.governedForwarder, {
      slackActionApp,
      onHeaderMismatch: (rejection) => {
        auditWriter.pushImmediate(buildHeaderMismatchAuditRecord(rejection, config.environment))
      },
    })
  }
  // Bind the servers in config order, first failure aborts (the connect
  // loop's shape). A bind failure is a diagnosed boot failure, not a crash
  // (#375): stop what the boot started (the prime loops, the servers bound
  // so far in reverse, then the doors, a stdio child included), then throw
  // the operator line. Every close is best effort; the diagnosis is the
  // last word. The `StartupError` catch prints it and exits 1.
  const boundHandles: ServerHandle[] = []
  const listenOrAbort = async (
    setting: PortSetting,
    host: string,
    port: number,
    start: () => Promise<ServerHandle>,
  ): Promise<ServerHandle> => {
    try {
      const bound = await start()
      boundHandles.push(bound)
      return bound
    } catch (err) {
      for (const stack of stacks) stack.annotationPrime.stop()
      for (const bound of [...boundHandles].reverse()) {
        try {
          await bound.close()
        } catch (closeErr) {
          console.error(
            `[helio] Ignoring a server close failure while aborting startup: ${String(closeErr)}`,
          )
        }
      }
      await closeDoorsBestEffort(doors)
      throw new StartupError(listenFailureMessage(setting, host, port, configPath, err))
    }
  }
  const handle = await listenOrAbort('listen.port', config.listen.host, config.listen.port, () =>
    startServer(app, config),
  )

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
      session,
      auditWriter,
      approvalTimeoutMs: parseDuration(config.approval.timeout),
      ttlMs: parseDuration(config.sdk.evaluation_ttl),
    })

    const sidebandApp = createSidebandApp(evidenceStore, {
      token: sidebandToken,
      adapterToken,
      governance: governanceService,
    })
    sidebandHandle = await listenOrAbort('sdk.port', config.sdk.host, config.sdk.port, () =>
      startSidebandServer(sidebandApp, config.sdk.port, config.sdk.host),
    )
  }

  // The authority surface (issue #396) is assembled AT PRINT TIME from the
  // prime controllers' state and the caches' snapshots: an initial prime
  // that lost the 1.5 s race and succeeded before the posture block prints
  // has set `primed` by then, and the surface line agrees with the primed
  // line above it. The policy read here follows every applied reload.
  const singularUpstreamLabel = isNamedConfig(config)
    ? undefined
    : (config.upstream.url ?? config.upstream.command)
  const surfaceDoors = (): SurfaceDoor[] => {
    const surface: SurfaceDoor[] = []
    for (const stack of stacks) {
      const label = stack.name ?? singularUpstreamLabel
      // Both getters are read once, together: a success sets `primed` and
      // clears `lastFailure` in one synchronous step, and nothing runs
      // between these two reads, so a door that is not primed always
      // carries its reason here; the fallback is for the type, not a state.
      const { primed, lastFailure } = stack.annotationPrime
      if (primed) {
        const { upstream, tools } = stack.governedForwarder.snapshotSurface()
        surface.push({ kind: 'upstream', name: upstream, label, tools })
      } else {
        surface.push({
          kind: 'upstream',
          name: stack.name,
          label,
          unavailable: lastFailure ?? 'priming has not completed',
        })
      }
    }
    for (const adapter of governanceService?.snapshotSurfaces() ?? []) {
      surface.push({ kind: 'adapter', origin: adapter.origin, tools: adapter.tools })
    }
    return surface
  }
  let currentPolicy: CompiledPolicy = policy
  const classifyCurrentSurface = (activePolicy: CompiledPolicy) =>
    classifySurface({
      doors: surfaceDoors(),
      policy: activePolicy,
      environment: config.environment,
    })
  const policyStatusReport = (window: string): PolicyStatusReport => {
    const parsed = parseStatusWindow(window)
    if (!parsed.ok) throw new Error(parsed.error)
    return buildPolicyStatus({
      surface: classifyCurrentSurface(currentPolicy),
      policy: currentPolicy,
      persisted: auditStore.persistedSummary(new Date(Date.now() - parsed.ms).toISOString()),
      window,
      now: new Date(),
    })
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
          listEventsForExport: (name, limit) => budgetLedger.listEventsForExport(name, limit),
        },
        // The authority report for GET /api/policy/status (issue #396): the
        // primed surface lives only in this process, so the CLI reads it here.
        policyStatus: { report: policyStatusReport },
      },
      {
        apiSecret: config.dashboard.api_secret,
        staticDir: bundledDashboardDistPath ?? undefined,
        sseHeartbeatMs: parseDuration(config.dashboard.sse_heartbeat_interval),
      },
    )
    closeDashboardApp = dashboardApp.close
    dashboardHandle = await listenOrAbort(
      'dashboard.port',
      config.dashboard.host,
      config.dashboard.port,
      () => startSidebandServer(dashboardApp.app, config.dashboard.port, config.dashboard.host),
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
  // The authority surface and the policy's coverage of it (issue #396),
  // computed now (after priming, after the bind), like the Policies: line
  // beside them. A door not primed at this moment gets its own line.
  const bootSurface = classifyCurrentSurface(policy)
  console.error(formatSurfaceLine(bootSurface))
  const bootCoverage = formatCoverageLine(bootSurface)
  if (bootCoverage !== undefined) console.error(bootCoverage)
  // The readiness nudge, once per boot: recent activity in the default
  // window (one range search on the composite index; no retention-wide
  // COUNT), only when the policy enforces nothing.
  if (enforcesNothing(policy)) {
    const windowMs = parseDuration(DEFAULT_STATUS_WINDOW)
    const readiness = evaluateReadiness(
      auditStore.persistedSummary(new Date(Date.now() - windowMs).toISOString()),
      policy,
    )
    if (readiness.ready) console.error(formatReadinessLine(readiness, DEFAULT_STATUS_WINDOW))
  }
  if (isNamedConfig(config)) {
    for (const entry of config.upstreams) {
      if (entry.transport === 'stdio') {
        console.error(`Upstream[${entry.name}]: ${entry.command ?? ''} (stdio)`)
      } else {
        console.error(`Upstream[${entry.name}]: ${entry.url ?? ''} (${entry.transport})`)
      }
    }
  } else if (config.upstream.transport === 'stdio') {
    console.error(`Upstream: ${config.upstream.command ?? ''} (stdio)`)
  } else {
    console.error(`Upstream: ${config.upstream.url ?? ''} (${config.upstream.transport})`)
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
  warnIfDashboardSecretLiteral(config, { configPath, interpolatedPaths })
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
  if (pinnedSha256 !== undefined) {
    console.error(
      `[helio] Config pinned to sha256:${pinnedSha256.slice(0, 12)}: reloads with a different hash will be refused`,
    )
  }

  // Hot-reload is enabled by default. The CLI flag takes precedence over
  // the config file so operators can pin the policy for a single start
  // without editing YAML. When disabled, config edits require a restart.
  const hotReloadEnabled =
    options.noHotReload === true ? false : (config.policies.hot_reload ?? true)

  let configWatcher: ConfigWatcher | undefined
  if (hotReloadEnabled) {
    configWatcher = new ConfigWatcher({
      configPath,
      initial: { config, sha256: configSha256 },
      pinnedSha256,
      onReady: () => {
        console.error(`Watching ${configPath} for policy changes`)
      },
      onReload: (newPolicy, reloadWarnings, restartRequiredPaths, newBudgets, facts) => {
        // The RUNNING approval surface is startup-bound: a reload whose
        // policy or budgets reference channels (or a dashboard) that only
        // exist in the NEW file would validate on paper and then route
        // tickets into the void. Refuse the whole reload instead; the
        // throw lands in the watcher's catch, which records it once.
        const unroutable = findUnroutableApprovalReferences(newPolicy, newBudgets, {
          channelTypes: runtimeChannelTypes,
          dashboardEnabled: config.dashboard.enabled,
          defaultApprovalTimeoutMs: parseDuration(config.approval.timeout),
        })
        if (unroutable.length > 0) {
          throw new PolicyReloadRejectedError(
            'rejected_unroutable',
            `approval routing is not available in the running process (restart required ` +
              `to apply approval.channels/dashboard changes): ${unroutable.join('; ')}`,
          )
        }
        // Budgets reconcile FIRST: it persists the reload's epoch mints and
        // throws when the flush fails, which refuses the whole reload
        // before any policy swap; the reload applies all-or-nothing.
        try {
          budgetEngine.reconcile(newBudgets)
        } catch (err) {
          throw new PolicyReloadRejectedError(
            'rejected_budget_flush',
            `budget epoch flush failed: ${err instanceof Error ? err.message : String(err)}`,
            { cause: err },
          )
        }
        // The reconcile above was the last throw. From here to the record
        // push everything is synchronous in one tick, so no record can be
        // written between the stamp and the swap: the reload record and
        // every call the new policy serves carry the new hash.
        auditWriter.setConfigSha256(facts.sha256After)
        applyReloadedPolicy(stacks, newPolicy)
        governanceService?.updatePolicy(newPolicy)
        currentPolicy = newPolicy
        // The one success-path persist site: the swap is done, the record
        // says so, and it precedes the first call the new policy serves.
        auditWriter.pushImmediate(buildPolicyReloadRecord(facts, config.environment ?? null))
        const budgetTotal = newBudgets.length
        console.error(
          `[helio] Budgets reloaded: ${String(budgetTotal)} budget${budgetTotal !== 1 ? 's' : ''}`,
        )
        const count = newPolicy.rules.length
        console.error(
          `[helio] Policy reloaded: ${String(count)} rule${count !== 1 ? 's' : ''} (default: ${newPolicy.defaultAction})`,
        )
        // Coverage gets the same treatment as the rule count: the saved
        // rule visibly changes the count, or not. The surface did not
        // change on a reload, so its line is not reprinted.
        const reloadedCoverage = formatCoverageLine(classifyCurrentSurface(newPolicy))
        if (reloadedCoverage !== undefined) console.error(`[helio] ${reloadedCoverage}`)
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
      onError: (error, facts) => {
        if (facts.outcome === 'watch_failed') {
          console.error(
            `[helio] Config watch failed (keeping current configuration; retrying every ` +
              `${String(DEFAULT_REARM_INTERVAL_MS / 1000)}s until the file can be read again): ` +
              error.message,
          )
        } else {
          console.error(
            `[helio] Config reload failed (keeping current configuration): ${error.message}`,
          )
          if (error instanceof ConfigError) {
            printConfigErrorDetails(error, '[helio] ')
          }
        }
        auditWriter.pushImmediate(buildPolicyReloadRecord(facts, config.environment ?? null))
      },
    })
    configWatcher.start()
  } else {
    console.error(
      `[helio] Hot-reload disabled — config changes to ${configPath} will require a restart`,
    )
  }

  // The posture line prints on both branches, after the pin is known: when
  // the file is writable by this user, say what a same-user process can
  // still do and the two ways up a tier. Silent under a dedicated user or a
  // read-only mount.
  warnIfConfigWritableByProxyUser({
    configPath,
    hotReload: hotReloadEnabled,
    pinned: pinnedSha256 !== undefined,
  })

  registerShutdown(
    handle,
    stacks.map((stack) => stack.annotationPrime),
    doors.flatMap((door) => (door.close ? [door.close] : [])),
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

  const secret = randomBytes(32).toString('hex')
  await writeFile(outputPath, renderConfigTemplate(secretDigest(secret)), 'utf-8')

  console.error(`Created ${outputPath}`)
  console.error('')
  console.error('Dashboard secret (shown once; the file stores only its SHA-256 digest):')
  console.error(`  ${secret}`)
  console.error('')
  console.error('Store it in your password manager. Use it to log in to the dashboard and')
  console.error('as the Bearer credential for sideband API clients (127.0.0.1:3100 by')
  console.error('default). If you lose it, run `helio secret`, paste the new digest into')
  console.error('dashboard.api_secret, and restart the proxy.')
}

async function sandboxCommand(dir: string, force: boolean): Promise<void> {
  const root = resolve(dir)
  const targets = SANDBOX_FILES.map((rel) => join(root, rel))
  const existing = targets.find((path) => existsSync(path))
  if (existing !== undefined && !force) {
    console.error(`Error: ${existing} already exists. Use --force to overwrite.`)
    process.exit(1)
  }

  await mkdir(join(root, 'helio'), { recursive: true })
  const contents: Record<(typeof SANDBOX_FILES)[number], string> = {
    'compose.yaml': renderSandboxCompose({ imageTag: sandboxImageTag(VERSION) }),
    'helio/helio.yaml': renderSandboxConfig(),
    'helio/README.md': renderSandboxReadme(),
  }
  for (const rel of SANDBOX_FILES) await writeFile(join(root, rel), contents[rel], 'utf-8')

  for (const path of targets) console.error(`Created ${path}`)
  console.error('')
  console.error('Next steps:')
  console.error('  1. In compose.yaml, set the agent image (or build:) and the mcp-server image.')
  console.error(
    '  2. Run `helio secret` and put HELIO_DASHBOARD_SECRET=<digest> in ./.env next to compose.yaml.',
  )
  console.error(`  3. cd ${dir} && docker compose up -d`)
  console.error('  4. docker compose exec agent sh, then run the checks in helio/README.md.')
  console.error(
    'Never mount this directory, ./helio, .env, or the Docker socket into the agent service.',
  )
}

// ---------------------------------------------------------------------------
// `helio init --client` (issue #398)
// ---------------------------------------------------------------------------

/** What the adopted branch of the template needs beyond the digest. */
interface AdoptedTemplateInput {
  /** The `upstreams:` block from `renderUpstreamBlock`. */
  readonly block: string
  /** The client files, as displayed. */
  readonly sources: readonly string[]
  /** The undo invocation for the header. */
  readonly undo: string
  readonly port: number
  readonly host: string
}

const ADOPT_LISTEN_PORT = 3000
const ADOPT_LISTEN_HOST = '127.0.0.1'
const ACCEPTED_CLIENT_PATHS = '.mcp.json, .cursor/mcp.json, .vscode/mcp.json, .claude.json'

/** "a, b and c" for the printed lines. */
function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1] ?? ''}`
}

/**
 * The scaffold with the live `upstream:` block replaced by the adopted
 * `upstreams:` list, the pointer stub flipped, and `listen:` made live.
 * Built by replacing segments of the default text so that the
 * default branch stays the untouched template literal.
 */
function renderAdoptedConfigTemplate(
  apiSecretDigest: string,
  adopted: AdoptedTemplateInput,
): string {
  const base = renderConfigTemplate(apiSecretDigest)
  const replaceOnce = (text: string, pattern: RegExp, replacement: string): string => {
    const matches = text.match(pattern)
    if (matches === null || matches.length !== 1) {
      throw new Error(
        `init --client: the scaffold no longer has the segment ${pattern.source.slice(0, 40)}`,
      )
    }
    return text.replace(pattern, () => replacement)
  }
  const header = replaceOnce(
    base,
    /^# Docs: https:\/\/github\.com\/gethelio\/helio\n/m,
    `# Written by helio init --client from ${joinNames(adopted.sources)}\n# Undo: from this directory, ${adopted.undo}\n# Docs: https://github.com/gethelio/helio\n`,
  )
  const upstreams = replaceOnce(
    header,
    /^upstream:\n(?:(?: {2}|#)[^\n]*\n)+\n# Multiple named upstreams[^\n]*\n# set exactly one of the two\. See docs\/configuration\.md\.\n# upstreams:\n# {3}- name: files\n# {5}url: "http:\/\/localhost:8081\/mcp"\n/m,
    `${adopted.block.trimEnd()}\n\n# A single upstream (singular mode) replaces \`upstreams:\`; set exactly one\n# of the two. See docs/configuration.md.\n# upstream:\n#   url: "http://localhost:8080/mcp"\n#   transport: streamable-http\n`,
  )
  return replaceOnce(
    upstreams,
    /^# listen:\n# {3}port: 3000\n# {3}host: 127\.0\.0\.1\n/m,
    `listen:\n  port: ${String(adopted.port)}\n  host: ${adopted.host}\n`,
  )
}

function errnoCode(err: unknown): string {
  const code = (err as NodeJS.ErrnoException).code
  return typeof code === 'string' ? code : err instanceof Error ? err.message : String(err)
}

/** A path shown relative to the working directory when it is under it. */
function displayUnder(cwd: string, path: string): string {
  const rel = relative(cwd, path)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) ? rel : path
}

function refuseInit(line: string): never {
  console.error(line)
  process.exit(1)
}

/**
 * Resolve the client files an invocation targets: the three project files
 * under the working directory, or the one named path.
 */
function resolveClientTargets(
  clientArg: string | true,
  cwd: string,
): {
  readonly targets: ReadonlyArray<{ path: string; display: string; format: ClientFormat }>
  readonly undo: string
} {
  if (clientArg === true) {
    const found = detectClientConfigs(cwd)
    if (found.length === 0) {
      refuseInit(
        `Error: no MCP client config found in ${cwd} (looked for ${PROJECT_CLIENT_FILES.map((f) => f.display).join(', ')}). Pass a path: helio init --client <path>`,
      )
    }
    return { targets: found, undo: 'helio init --client --undo' }
  }
  const shown = clientArg === '' ? '""' : clientArg
  const kind = classifyClientPath(clientArg)
  if (!kind.ok) {
    if (kind.kind === 'desktop') {
      refuseInit(
        'Error: claude_desktop_config.json: Claude Desktop reaches HTTP servers through Settings > Connectors, not this file, so Helio cannot repoint it. Nothing changed.',
      )
    }
    refuseInit(
      `Error: ${shown} is not a client config Helio adopts (accepted: ${ACCEPTED_CLIENT_PATHS}). Nothing changed.`,
    )
  }
  return {
    targets: [{ path: resolve(cwd, clientArg), display: clientArg, format: kind.format }],
    undo: `helio init --client ${clientArg} --undo`,
  }
}

/** `helio init --client [path]`: nine steps, "nothing changed" true on every refusal. */
async function initClientCommand(
  clientArg: string | true,
  outputPath: string,
  force: boolean,
): Promise<void> {
  const cwd = process.cwd()
  const { targets, undo } = resolveClientTargets(clientArg, cwd)
  const outputAbs = resolve(cwd, outputPath)
  const manifestPath = join(cwd, MANIFEST_FILE)

  // 1. Read every target file.
  const sources: ClientSource[] = []
  for (const target of targets) {
    if (!existsSync(target.path))
      refuseInit(`Error: ${target.display} does not exist. Nothing changed.`)
    let text: string
    try {
      text = await readFile(target.path, 'utf-8')
    } catch (err) {
      refuseInit(`Error: could not read ${target.display} (${errnoCode(err)}). Nothing changed.`)
    }
    sources.push({ path: target.path, display: target.display, format: target.format, text })
  }

  // 2. Compute the adoption.
  const plan = adoptServers(sources, {
    port: ADOPT_LISTEN_PORT,
    host: ADOPT_LISTEN_HOST,
    env: process.env,
    cwd,
    home: homedir(),
    pathSeparator: sep,
    force,
    outputName: outputPath,
  })
  if (!plan.ok) {
    // Every refusal is one line; the one that says "see above" needs the skip lines first.
    if (plan.error.includes('see above')) for (const line of plan.lines) console.error(line)
    refuseInit(plan.error)
  }

  // 3. Validate the config text in-process, every referenced variable given a dummy value.
  const secret = randomBytes(32).toString('hex')
  // The files the run changes: a source none of whose entries were adopted stays as it is.
  const changed = plan.files
  const displays = changed.map((f) => f.display)
  const text = renderAdoptedConfigTemplate(secretDigest(secret), {
    block: plan.upstreamBlock,
    sources: displays,
    undo,
    port: ADOPT_LISTEN_PORT,
    host: ADOPT_LISTEN_HOST,
  })
  const dummies = Object.fromEntries(
    plan.variables.map((name) => [name, 'helio-init-client-dummy']),
  )
  try {
    parseConfigSource({ raw: text, sha256: '' }, outputPath, { ...dummies, ...process.env })
  } catch (err) {
    if (err instanceof ConfigError) {
      const detail = err.details?.[0]
      const why = detail === undefined ? err.message : `${detail.path}: ${detail.message}`
      refuseInit(
        `Error: the ${outputPath} built from ${joinNames(displays)} does not validate: ${why}. Nothing changed.`,
      )
    }
    throw err
  }

  // 4. The markers, the output path, and every target directory's writability.
  if (existsSync(manifestPath)) {
    refuseInit(
      `Error: ${MANIFEST_FILE} exists; this project was already adopted. Run ${undo} first. Nothing changed.`,
    )
  }
  for (const file of changed) {
    if (existsSync(file.path + BACKUP_SUFFIX)) {
      refuseInit(
        `Error: ${file.display}${BACKUP_SUFFIX} already exists; this file was already adopted. Run ${undo} first. Nothing changed.`,
      )
    }
  }
  if (existsSync(outputAbs) && !force) {
    refuseInit(`Error: ${outputPath} already exists. Use --force to overwrite.`)
  }
  const outputBackupPath = force && existsSync(outputAbs) ? outputAbs + BACKUP_SUFFIX : null
  if (outputBackupPath !== null && existsSync(outputBackupPath)) {
    refuseInit(
      `Error: ${outputPath}${BACKUP_SUFFIX} already exists; this file was already adopted. Run ${undo} first. Nothing changed.`,
    )
  }
  for (const dir of new Set([...changed.map((f) => dirname(f.path)), dirname(outputAbs), cwd])) {
    try {
      accessSync(dir, constants.W_OK)
    } catch (err) {
      refuseInit(`Error: ${dir} is not writable (${errnoCode(err)}). Nothing changed.`)
    }
  }

  // Nothing refuses past this point without a way back, so the plan is printed now.
  for (const line of plan.lines) console.error(line)

  // 5. Backups first: the client files, then the output under --force.
  const backupsWritten: string[] = []
  const removeBackups = async (): Promise<string[]> => {
    const left: string[] = []
    for (const backup of backupsWritten) {
      try {
        await unlink(backup)
      } catch {
        left.push(backup)
      }
    }
    return left
  }
  // A copy that failed part way can leave a partial destination: it is removed
  // with the backups already written, and any survivor is named.
  const refuseBackup = async (display: string, err: unknown, partial: string): Promise<never> => {
    const code = errnoCode(err)
    if (existsSync(partial)) backupsWritten.push(partial)
    const left = await removeBackups()
    if (left.length === 0)
      refuseInit(`Error: could not back up ${display} (${code}). Nothing changed.`)
    refuseInit(
      `Error: could not back up ${display} (${code}). Left behind: ${left.map((b) => displayUnder(cwd, b)).join(', ')} (delete ${left.length === 1 ? 'it' : 'them'}; nothing was adopted).`,
    )
  }
  const backupLines: string[] = []
  for (const file of changed) {
    try {
      await backupFile(file.path)
    } catch (err) {
      await refuseBackup(file.display, err, file.path + BACKUP_SUFFIX)
    }
    backupsWritten.push(file.path + BACKUP_SUFFIX)
    backupLines.push(`Backed up ${file.display} to ${file.display}${BACKUP_SUFFIX}`)
  }
  if (outputBackupPath !== null) {
    try {
      await backupFile(outputAbs)
    } catch (err) {
      await refuseBackup(outputPath, err, outputBackupPath)
    }
    backupsWritten.push(outputBackupPath)
    backupLines.push(`Backed up ${outputPath} to ${outputPath}${BACKUP_SUFFIX}`)
  }
  for (const line of backupLines) console.error(line)

  // 6. The manifest; a failure removes the backups or names every survivor.
  try {
    await writeManifest(manifestPath, {
      version: 1,
      output: outputAbs,
      output_backup: outputBackupPath,
      clients: changed.map((f) => ({ path: f.path, backup: f.path + BACKUP_SUFFIX })),
      created_at: new Date().toISOString(),
    })
  } catch (err) {
    const code = errnoCode(err)
    const left = await removeBackups()
    if (left.length === 0) {
      refuseInit(
        `Error: could not write ${MANIFEST_FILE} (${code}). The backups were removed; nothing changed.`,
      )
    }
    const clientLeft = left.filter((b) => b !== outputBackupPath).map((b) => displayUnder(cwd, b))
    const parts: string[] = []
    if (clientLeft.length > 0) {
      parts.push(`${clientLeft.join(', ')} (run ${undo} from this directory to restore them)`)
    }
    if (outputBackupPath !== null && left.includes(outputBackupPath)) {
      parts.push(`${outputPath}${BACKUP_SUFFIX} (delete it: ${outputPath} was not modified)`)
    }
    refuseInit(
      `Error: could not write ${MANIFEST_FILE} (${code}). Left behind: ${parts.join('; ')}.`,
    )
  }
  console.error(`Wrote ${MANIFEST_FILE} (undo reads it; tied to this directory)`)
  console.error(
    `${MANIFEST_FILE} and the ${BACKUP_SUFFIX} files are local to this machine; do not commit them.`,
  )

  // 7. The config, then 8. every client file; each through a temp sibling and rename.
  const written: string[] = []
  const writeOrFail = async (path: string, display: string, data: string): Promise<void> => {
    try {
      await writeFileAtomic(path, data)
    } catch (err) {
      const code = errnoCode(err)
      const tempLeft = existsSync(path + TEMP_SUFFIX)
      if (written.length === 0) {
        console.error(
          `Error: writing ${display} failed (${code}) before any client file was rewritten. Run ${undo} to clear the backups and the manifest.`,
        )
      } else {
        console.error(
          `Error: writing ${display} failed (${code}) after ${joinNames(written)} ${written.length === 1 ? 'was' : 'were'} written. Run ${undo} to restore everything.`,
        )
      }
      if (tempLeft) console.error(`Could not remove ${display}${TEMP_SUFFIX}; delete it.`)
      process.exit(1)
    }
    written.push(display)
  }
  await writeOrFail(outputAbs, outputPath, text)
  const doorPattern = `http://${ADOPT_LISTEN_HOST}:${String(ADOPT_LISTEN_PORT)}/mcp/<name>`
  console.error(
    `Created ${outputPath} (${String(plan.entries.length)} upstream${plan.entries.length === 1 ? '' : 's'}; doors at ${doorPattern})`,
  )
  for (const line of plan.outputLines) console.error(line)
  for (const file of plan.files) {
    await writeOrFail(file.path, file.display, file.text)
    console.error(
      `Rewrote ${file.display}: ${file.adopted.join(', ')} now point${file.adopted.length === 1 ? 's' : ''} at Helio`,
    )
    for (const line of file.notes) console.error(line)
  }

  // 9. The variables, the secret, the next actions, and the undo line.
  if (plan.variables.length > 0) {
    console.error(
      `Environment variables ${outputPath} needs (helio start and helio policy status): ${plan.variables.join(', ')}`,
    )
  }
  console.error('')
  console.error('Dashboard secret (shown once; the file stores only its SHA-256 digest):')
  console.error(`  ${secret}`)
  console.error('')
  console.error('Store it in your password manager. Use it to log in to the dashboard and')
  console.error('as the Bearer credential for sideband API clients (127.0.0.1:3100 by')
  console.error('default). If you lose it, run `helio secret`, paste the new digest into')
  console.error('dashboard.api_secret, and restart the proxy.')
  console.error('helio policy status needs this secret in HELIO_DASHBOARD_SECRET.')
  console.error('')
  const clientStep = plan.claudeUserFile
    ? 'Claude Code connects user-scope servers on its next start; no approval step.'
    : plan.claudeProjectFile
      ? 'In Claude Code, run `claude` and approve the project servers (`claude mcp list` stays at pending approval until you do).'
      : null
  console.error(
    `Next: run \`helio start\`. Restart your MCP client.${clientStep === null ? '' : ` ${clientStep}`}`,
  )
  console.error(`Undo: from this directory, ${undo}`)
}

/** `helio init --client [path] --undo`: restore the set the manifest names, else the backups the invocation can see. */
async function initClientUndoCommand(clientArg: string | true): Promise<void> {
  const cwd = process.cwd()
  const manifestPath = join(cwd, MANIFEST_FILE)
  let manifest: Manifest | null
  try {
    manifest = await readManifest(manifestPath)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (typeof code === 'string') {
      refuseInit(`Error: could not read ${MANIFEST_FILE} (${code}). Nothing changed.`)
    }
    refuseInit(`Error: ${MANIFEST_FILE} is not a manifest this version reads. Nothing changed.`)
  }
  const replacedLine = (display: string, bytes: number): string =>
    `Replaced ${display} with the backup (${String(bytes)} bytes). Edits since the adoption, if there were any, are discarded.`
  const restoreOrFail = async (
    items: ReadonlyArray<{ path: string; backup: string }>,
  ): Promise<Array<{ path: string; backup: string; bytes: number }>> => {
    try {
      return await restoreBackups(items)
    } catch (err) {
      refuseInit(
        `Error: could not restore a backup (${errnoCode(err)}). The remaining backups are still in place.`,
      )
    }
  }

  if (manifest !== null) {
    const restored = await restoreOrFail(manifest.clients)
    for (const item of restored)
      console.error(replacedLine(displayUnder(cwd, item.path), item.bytes))
    for (const client of manifest.clients) {
      if (!restored.some((r) => r.path === client.path)) {
        console.error(
          `No backup found for ${displayUnder(cwd, client.path)} (${displayUnder(cwd, client.backup)}); it was left as is.`,
        )
      }
    }
    const outputDisplay = displayUnder(cwd, manifest.output)
    if (manifest.output_backup !== null) {
      const [output] = await restoreOrFail([
        { path: manifest.output, backup: manifest.output_backup },
      ])
      if (output !== undefined) console.error(replacedLine(outputDisplay, output.bytes))
      else
        console.error(
          `No backup found for ${outputDisplay} (${displayUnder(cwd, manifest.output_backup)}); it was left in place.`,
        )
    } else if (existsSync(manifest.output)) {
      console.error(
        `${outputDisplay} was left in place (from ${MANIFEST_FILE}); delete it if you no longer want it.`,
      )
    } else {
      console.error(`${outputDisplay} was not written (from ${MANIFEST_FILE}); nothing to remove.`)
    }
    try {
      await unlink(manifestPath)
    } catch (err) {
      refuseInit(`Error: could not remove ${MANIFEST_FILE} (${errnoCode(err)}); delete it by hand.`)
    }
  } else {
    let candidates: ReadonlyArray<{ path: string; display: string }>
    if (clientArg === true) {
      candidates = PROJECT_CLIENT_FILES.map((f) => ({
        path: join(cwd, ...f.display.split('/')),
        display: f.display,
      }))
    } else {
      const kind = classifyClientPath(clientArg)
      if (!kind.ok) {
        refuseInit(
          `Error: ${clientArg === '' ? '""' : clientArg} is not a client config Helio adopts (accepted: ${ACCEPTED_CLIENT_PATHS}). Nothing changed.`,
        )
      }
      candidates = [{ path: resolve(cwd, clientArg), display: clientArg }]
    }
    const items = candidates.map((c) => ({
      path: c.path,
      backup: c.path + BACKUP_SUFFIX,
      display: c.display,
    }))
    if (!items.some((i) => existsSync(i.backup))) {
      refuseInit(
        `Error: no backup found for ${items.map((i) => `${i.display} (${i.display}${BACKUP_SUFFIX})`).join(', ')} and no manifest. Nothing to undo.`,
      )
    }
    const restored = await restoreOrFail(items)
    for (const item of restored) {
      const display = items.find((i) => i.path === item.path)?.display ?? item.path
      console.error(replacedLine(display, item.bytes))
    }
    console.error(
      'No manifest found; the helio.yaml this adoption wrote was not recorded and is left in place.',
    )
  }
  console.error('Restart your MCP client to pick the restored files up.')
}

function secretCommand(): void {
  const secret = randomBytes(32).toString('hex')
  console.log(`secret: ${secret}`)
  console.log(`digest: ${secretDigest(secret)}`)
}

async function configHashCommand(configPath: string): Promise<void> {
  try {
    const source = await readConfigSource(configPath)
    console.log(source.sha256)
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`Error: ${err.message}`)
      process.exit(1)
    }
    throw err
  }
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

    // Start warns too (before its connect loop); validate is the cheap
    // preflight an operator runs first, so it warns as well.
    if (isNamedConfig(config)) {
      warnIfManyUpstreams(config)
    }
    warnIfStdioUrlIgnored(config)

    // The audit directory is a fact about the host that will run start,
    // which need not be this one (issue #388): warn, do not refuse.
    const auditProblem = auditPathProblem(config.audit.path)
    if (auditProblem !== undefined) {
      console.error(`Warning: ${auditProblem} (helio start will refuse this path)`)
    }

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
    const line = compileFailureLine(err)
    if (line !== undefined) {
      console.error(line)
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
  budgets?: string
  tool?: string
  decision?: string
  reason?: string
  session?: string
  upstream?: string
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

  // The audit filter flags have no meaning against the budget ledger; a
  // silently ignored filter would make a truncated-looking export lie.
  if (opts.budgets !== undefined) {
    const conflicting = (
      [
        ['--tool', opts.tool],
        ['--decision', opts.decision],
        ['--reason', opts.reason],
        ['--session', opts.session],
        ['--upstream', opts.upstream],
        ['--from', opts.from],
        ['--to', opts.to],
      ] as const
    ).filter(([, value]) => value !== undefined)
    if (conflicting.length > 0) {
      console.error(
        'Error: --budgets cannot be combined with audit filters ' +
          `(${conflicting.map(([flag]) => flag).join(', ')})`,
      )
      process.exit(1)
    }
  }

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

  const auditProblem = auditPathProblem(config.audit.path)
  if (auditProblem !== undefined) throw new StartupError(`Invalid config: ${auditProblem}`)

  const store = new AuditStore({
    path: config.audit.path,
    retention: config.audit.retention,
    includeResponses: config.audit.include_responses,
    cleanupIntervalMs: 0, // No cleanup timer for one-shot CLI
  })

  try {
    // Budget ledger export (issue #155): same database file, the ledger's
    // own tables. Newest first — the ledger export's order everywhere.
    if (opts.budgets !== undefined) {
      const ledger = new BudgetLedger({ database: store.database })
      const page = ledger.listEventsForExport(opts.budgets, limit)

      if (opts.format === 'csv') {
        console.log(budgetEventsToCsv(page.events))
      } else {
        console.log(JSON.stringify(page.events, null, 2))
      }

      console.error(`Exported ${String(page.events.length)} of ${String(page.total)} records`)
      return
    }

    const result = store.listForExport(
      {
        tool_name: opts.tool,
        policy_decision: opts.decision,
        block_reason: opts.reason,
        session_id: opts.session,
        upstream: opts.upstream,
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
  annotationPrimes?: ReadonlyArray<AnnotationPrimeController>,
  closeForwarders?: ReadonlyArray<() => Promise<void>>,
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
      annotationPrimes,
      closeForwarders,
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

interface PolicyStatusOptions {
  config: string
  format: string
  window: string
}

/**
 * `helio policy status` (issue #396): the authority report of the RUNNING
 * proxy, read through its dashboard API, because the primed surface lives
 * only in that process. Every refusal is one StartupError line; the read
 * itself is the shared `fetchPolicyStatus` (#400), whose codes map onto
 * the lines below.
 */
async function policyStatusCommand(opts: PolicyStatusOptions): Promise<void> {
  if (opts.format !== 'text' && opts.format !== 'json') {
    throw new StartupError(`Error: --format must be text or json (got "${opts.format}")`)
  }
  const window = parseStatusWindow(opts.window)
  if (!window.ok) throw new StartupError(`Error: --${window.error}`)

  let config: HelioConfig
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

  const result = await fetchPolicyStatus(config, opts.config, opts.window)
  if (!result.ok) {
    const { base, source, message } = result.detail
    switch (result.code) {
      case 'dashboard_disabled':
        throw new StartupError(
          `Error: helio policy status reads the running proxy through the dashboard API, and ` +
            `dashboard.enabled is false in ${opts.config}. Enable the dashboard and restart helio start.`,
        )
      case 'secret_is_digest':
        throw new StartupError(
          `Error: the dashboard secret from ${source ?? 'the config'} is a sha256: digest; present the ` +
            `secret itself (the value helio init printed) in HELIO_DASHBOARD_SECRET and rerun`,
        )
      case 'no_proxy_answered':
        throw new StartupError(
          `Error: cannot reach the Helio dashboard API at ${base} (is helio start running with dashboard.enabled: true?)`,
        )
      case 'secret_refused':
        throw new StartupError(
          `Error: the Helio dashboard API at ${base} refused the secret from ${source ?? 'no source (none was found)'}; ` +
            `set HELIO_DASHBOARD_SECRET to the secret helio init printed and rerun`,
        )
      case 'status_unavailable':
      case 'api_error':
        throw new StartupError(
          `Error: the Helio dashboard API at ${base} answered: ${message ?? 'HTTP error'}`,
        )
    }
  }
  if (opts.format === 'json') {
    console.log(JSON.stringify(result.report, null, 2))
    return
  }
  console.log(renderPolicyStatusText(result.report))
}

// ---------------------------------------------------------------------------
// report activation (issue #400)
// ---------------------------------------------------------------------------

interface ReportActivationOptions {
  config: string
  window: string
  format: string
  out?: string
  force: boolean
  includeNames: boolean
}

/** The persisted window `helio report activation` reads when none is asked for. */
const DEFAULT_REPORT_WINDOW = '7d'

/** The fixed sentence the operator's stderr line opens with, per absent-snapshot code. */
const SNAPSHOT_ABSENT_STDERR: Readonly<Record<SnapshotAbsentReason, string>> = {
  no_proxy_answered: 'No proxy answered on the configured dashboard port',
  dashboard_disabled: 'The dashboard is disabled in the config file',
  secret_is_digest: 'The dashboard secret found is a sha256: digest, not the secret',
  secret_refused: 'The proxy refused the dashboard secret',
  status_unavailable:
    'A process answered but serves no policy status (a library embedding, not helio start)',
  api_error: 'The proxy answered with an error',
}

/** The three store reads of the report, with the store closed whatever happens. */
function readActivationFacts(
  store: AuditStore,
  since: string,
): {
  persisted: PersistedSummary
  activationWindow: ActivationWindow
  timeline: ActivationTimeline
} {
  try {
    return {
      persisted: store.persistedSummary(since),
      activationWindow: store.activationWindow(since),
      timeline: store.activationTimeline(),
    }
  } finally {
    store.close()
  }
}

/**
 * `helio report activation` (issue #400): one redacted artifact from two
 * sources. The audit database on disk is opened the way `helio export`
 * opens it (migration, index build and retention purge included) and is
 * always read; a missing file is refused, never created. The running proxy
 * is asked through `fetchPolicyStatus` and its absence is one stated reason.
 * Every refusal that leaves nothing to print is one StartupError line
 * before any open or socket; nothing in the artifact carries a path, a
 * host, a hash or a secret's source.
 */
async function reportActivationCommand(opts: ReportActivationOptions): Promise<void> {
  if (opts.format !== 'text' && opts.format !== 'json') {
    throw new StartupError(`Error: --format must be text or json (got "${opts.format}")`)
  }
  const window = parseStatusWindow(opts.window)
  if (!window.ok) throw new StartupError(`Error: --${window.error}`)
  if (opts.force && opts.out === undefined) {
    throw new StartupError('Error: --force applies only with --out')
  }
  if (opts.out !== undefined && !opts.force && existsSync(opts.out)) {
    throw new StartupError(`Error: ${opts.out} already exists. Pass --force to overwrite it.`)
  }

  let config: HelioConfig
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
  const source = await readConfigSource(opts.config)

  const auditProblem = auditPathProblem(config.audit.path)
  if (auditProblem !== undefined) throw new StartupError(`Invalid config: ${auditProblem}`)
  if (config.audit.path === ':memory:' || !existsSync(config.audit.path)) {
    throw new StartupError(
      `Error: no audit database at ${config.audit.path}. helio start writes it on the first ` +
        'governed call; nothing has been recorded on this machine.',
    )
  }

  // The one open, wrapped: a SQLite code becomes one line; the store's own
  // clean-break StartupError and anything else pass through unchanged.
  let store: AuditStore
  try {
    store = new AuditStore({
      path: config.audit.path,
      retention: config.audit.retention,
      includeResponses: config.audit.include_responses,
      cleanupIntervalMs: 0,
    })
  } catch (err) {
    const code = (err as { code?: unknown }).code
    if (typeof code === 'string' && code.startsWith('SQLITE_')) {
      const message = err instanceof Error ? err.message : String(err)
      throw new StartupError(
        `Error: audit.path: cannot open ${config.audit.path} (${code}: ${message})`,
      )
    }
    throw err
  }

  const now = new Date()
  const since = windowSince(now, window.ms)
  const facts = readActivationFacts(store, since)
  const { persisted, activationWindow, timeline } = facts
  const newest = timeline.newest_record_hash
  const sameFile: ConfigFileVsLastPolicyWrite =
    newest === null
      ? 'no_record'
      : newest.hash === null
        ? 'no_hash'
        : newest.hash === source.sha256
          ? 'match'
          : 'mismatch'

  const snapshot = await fetchPolicyStatus(config, opts.config, opts.window)
  if (!snapshot.ok) {
    console.error(
      `Snapshot: ${SNAPSHOT_ABSENT_STDERR[snapshot.code]} (dashboard ${snapshot.detail.base}, config ${opts.config})`,
    )
  }

  const report = buildActivationReport({
    now,
    helioVersion: VERSION,
    window: opts.window,
    windowMs: window.ms,
    retention: config.audit.retention,
    includeNames: opts.includeNames,
    configFileVsLastPolicyWrite: sameFile,
    persisted,
    activationWindow,
    timeline,
    snapshot: snapshot.ok
      ? { ok: true, report: snapshot.report }
      : { ok: false, code: snapshot.code },
  })
  const rendered =
    opts.format === 'json' ? JSON.stringify(report, null, 2) : renderActivationText(report)
  if (opts.out === undefined) {
    console.log(rendered)
    return
  }
  const bytes = Buffer.from(`${rendered}\n`, 'utf-8')
  await writeFile(opts.out, bytes)
  console.error(`Wrote ${opts.out} (${opts.format}, ${String(bytes.length)} bytes)`)
}

/**
 * A StartupError message is the complete operator diagnosis: print it
 * verbatim and exit 1, no stack, no rejection wrapper (#233, #388).
 * Anything else rethrows into the unhandledRejection crash path.
 */
function exitOnStartupError(err: unknown): never {
  if (err instanceof StartupError) {
    console.error(err.message)
    process.exit(1)
  }
  throw err
}

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
    startCommand(opts.config, { config: opts.config, noHotReload: opts.hotReload === false }).catch(
      exitOnStartupError,
    ),
  )

program
  .command('init')
  .description('Scaffold a helio.yaml config file with commented defaults')
  .option('-o, --output <path>', 'Output file path', DEFAULT_CONFIG_PATH)
  .option('-f, --force', 'Overwrite existing file', false)
  .option(
    '--sandbox [dir]',
    `Write the sidecar layout (compose.yaml, helio/helio.yaml, helio/README.md) into <dir> (default: ${SANDBOX_DEFAULT_DIR}) instead of a helio.yaml`,
  )
  .option(
    '--client [path]',
    'Adopt an existing MCP client configuration: the project .mcp.json, .cursor/mcp.json and .vscode/mcp.json under the current directory, or the one file at <path>; backs each file up, writes a helio.yaml with every server as an upstream, and repoints the client at Helio',
  )
  .option('--undo', 'With --client: restore the backups the adoption wrote and remove them', false)
  .action(
    (
      opts: {
        output: string
        force: boolean
        sandbox?: string | true
        client?: string | true
        undo: boolean
      },
      command: Command,
    ) => {
      if (opts.client !== undefined && opts.sandbox !== undefined) {
        refuseInit('Error: --client does not combine with --sandbox.')
      }
      if (opts.undo && opts.client === undefined) refuseInit('Error: --undo requires --client.')
      if (opts.undo && opts.client !== undefined) {
        if (command.getOptionValueSource('output') === 'cli') {
          refuseInit('Error: --output does not apply to --undo.')
        }
        if (opts.force) refuseInit('Error: --force does not apply to --undo.')
        return initClientUndoCommand(opts.client)
      }
      if (opts.client !== undefined) return initClientCommand(opts.client, opts.output, opts.force)
      if (opts.sandbox === undefined) return initCommand(opts.output, opts.force)
      if (command.getOptionValueSource('output') === 'cli') {
        console.error(
          'Error: --output does not apply to --sandbox; pass the directory as --sandbox <dir>.',
        )
        process.exit(1)
      }
      return sandboxCommand(opts.sandbox === true ? SANDBOX_DEFAULT_DIR : opts.sandbox, opts.force)
    },
  )

program
  .command('validate')
  .description('Validate a helio.yaml config file')
  .option('-c, --config <path>', 'Path to helio.yaml', DEFAULT_CONFIG_PATH)
  .action((opts: { config: string }) => validateCommand(opts.config))

program
  .command('secret')
  .description('Generate a dashboard secret and the digest to store as dashboard.api_secret')
  .action(() => {
    secretCommand()
  })

program
  .command('export')
  .description('Export audit records or a budget ledger to JSON or CSV')
  .option('-c, --config <path>', 'Path to helio.yaml', DEFAULT_CONFIG_PATH)
  .option('-f, --format <format>', 'Output format: json or csv', 'json')
  .option('--budgets <name>', 'Export the named budget ledger instead of the audit trail')
  .option('--tool <name>', 'Filter by tool name')
  .option('--decision <decision>', 'Filter by policy decision')
  .option('--reason <reason>', 'Filter by block reason')
  .option('--session <id>', 'Filter by session ID')
  .option('--upstream <name>', 'Filter by upstream name')
  .option('--from <iso>', 'Start time (ISO 8601)')
  .option('--to <iso>', 'End time (ISO 8601)')
  .option('--limit <n>', 'Max records to export (up to 10000)', '1000')
  .action((opts: ExportOptions) => exportCommand(opts).catch(exitOnStartupError))

const configCommand = program.command('config').description('Inspect a helio.yaml config file')
configCommand
  .command('hash')
  .description('Print the SHA-256 of the config file bytes, the value HELIO_CONFIG_SHA256 pins')
  .option('-c, --config <path>', 'Path to helio.yaml', DEFAULT_CONFIG_PATH)
  .action((opts: { config: string }) => configHashCommand(opts.config))

const policyCommand = program
  .command('policy')
  .description('Inspect the loaded policy against the running proxy')
policyCommand
  .command('status')
  .description(
    'Report the authority surface, policy coverage and persisted calls of the running proxy',
  )
  .option('-c, --config <path>', 'Path to helio.yaml', DEFAULT_CONFIG_PATH)
  .option('--format <format>', 'Output format: text or json', 'text')
  .option('--window <duration>', 'Persisted window, 1m to 30d', DEFAULT_STATUS_WINDOW)
  .action((opts: PolicyStatusOptions) => policyStatusCommand(opts).catch(exitOnStartupError))

const reportCommand = program
  .command('report')
  .description('Write a report from the audit database and the running proxy')
reportCommand
  .command('activation')
  .description(
    'Write a redacted activation report: the timeline, the windowed counts and the running proxy snapshot',
  )
  .option('-c, --config <path>', 'Path to helio.yaml', DEFAULT_CONFIG_PATH)
  .option('--window <duration>', 'Window for the counts, 1m to 30d', DEFAULT_REPORT_WINDOW)
  .option('--format <format>', 'Output format: text or json', 'text')
  .option('--out <file>', 'Write the report to a file instead of stdout')
  .option('--force', 'Overwrite an existing --out file', false)
  .option('--include-names', 'Include tool, door and rule names (the default excludes them)', false)
  .action((opts: ReportActivationOptions) =>
    reportActivationCommand(opts).catch(exitOnStartupError),
  )

program.parse()
