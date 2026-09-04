import { watch } from 'chokidar'
import type { FSWatcher } from 'chokidar'
import { readConfigSource, parseConfigSource } from './loader.js'
import type { HelioConfig } from './schema.js'
import { diffReloadBoundary } from './reload-boundary.js'
import { compilePolicies } from '../policy/parser.js'
import type { CompiledPolicy, PolicyParseWarning } from '../policy/types.js'
import { compileBudgets } from '../budget/parser.js'
import type { CompiledBudget } from '../budget/types.js'
import type { PolicyReloadOutcome } from './reload-outcomes.js'

// ---------------------------------------------------------------------------
// ConfigWatcher — hot-reload policy rules on helio.yaml changes.
// ---------------------------------------------------------------------------

/** What a reload attempt saw and did. The "before" side is the last configuration that applied. */
export interface PolicyReloadFacts {
  readonly configPath: string
  readonly outcome: PolicyReloadOutcome
  readonly sha256Before: string
  /** Hash of the bytes read this attempt; null only when the file could not be read. */
  readonly sha256After: string | null
  readonly ruleCountBefore: number
  /** Null when the file did not parse or was refused before parsing. */
  readonly ruleCountAfter: number | null
  readonly defaultActionBefore: 'allow' | 'deny'
  readonly defaultActionAfter: 'allow' | 'deny' | null
  readonly budgetCountBefore: number
  readonly budgetCountAfter: number | null
  /** Names of named rules present before and absent after; empty when the file did not parse. */
  readonly rulesRemoved: readonly string[]
  /** The reload-boundary diff against the STARTUP config; empty when the file did not parse. */
  readonly restartRequiredPaths: readonly string[]
  readonly error: string | null
}

/** The facts an applied reload carries: every "after" field is known. */
export interface AppliedPolicyReloadFacts extends PolicyReloadFacts {
  readonly outcome: 'applied'
  readonly sha256After: string
  readonly ruleCountAfter: number
  readonly defaultActionAfter: 'allow' | 'deny'
  readonly budgetCountAfter: number
  readonly error: null
}

/** A reload refused for a reason the thrower can name; the watcher maps it to the record's outcome. */
export class PolicyReloadRejectedError extends Error {
  readonly outcome: Exclude<PolicyReloadOutcome, 'applied'>

  constructor(
    outcome: Exclude<PolicyReloadOutcome, 'applied'>,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'PolicyReloadRejectedError'
    this.outcome = outcome
  }
}

/** A config and the hash of the file bytes it was parsed from. */
export interface ConfigBaseline {
  readonly config: HelioConfig
  readonly sha256: string
}

export interface ConfigWatcherOptions {
  readonly configPath: string
  /** The config in force at startup with its file hash: the restart-required baseline and the first "before". */
  readonly initial: ConfigBaseline
  readonly onReload: (
    policy: CompiledPolicy,
    warnings: readonly PolicyParseWarning[],
    restartRequiredPaths: readonly string[],
    budgets: readonly CompiledBudget[],
    facts: AppliedPolicyReloadFacts,
  ) => void
  /** Called once per refused attempt with the classified facts. */
  readonly onError: (error: Error, facts: PolicyReloadFacts) => void
  readonly onReady?: () => void
  readonly env?: Record<string, string | undefined>
  readonly debounceMs?: number
}

type BeforeFacts = Pick<
  PolicyReloadFacts,
  'sha256Before' | 'ruleCountBefore' | 'defaultActionBefore' | 'budgetCountBefore'
>

function beforeFacts(baseline: ConfigBaseline): BeforeFacts {
  return {
    sha256Before: baseline.sha256,
    ruleCountBefore: baseline.config.policies.rules.length,
    defaultActionBefore: baseline.config.policies.default,
    budgetCountBefore: baseline.config.budgets.length,
  }
}

/** Names of named rules in `previous` that `next` no longer carries. Unnamed rules are not tracked. */
function rulesRemovedBetween(previous: HelioConfig, next: HelioConfig): string[] {
  const kept = new Set(
    next.policies.rules.flatMap((rule) => (rule.name === undefined ? [] : [rule.name])),
  )
  return previous.policies.rules.flatMap((rule) =>
    rule.name === undefined || kept.has(rule.name) ? [] : [rule.name],
  )
}

/**
 * Watches a helio.yaml config file for changes and recompiles the policy
 * rule set when the file is modified. On successful reload, calls
 * `onReload` with the new compiled policy and budgets. On failure, calls
 * `onError` and retains the current policy.
 */
export class ConfigWatcher {
  private readonly configPath: string
  private readonly onReload: ConfigWatcherOptions['onReload']
  private readonly onError: ConfigWatcherOptions['onError']
  private readonly onReady: ConfigWatcherOptions['onReady']
  private readonly initial: ConfigBaseline
  private readonly env: Record<string, string | undefined> | undefined
  private readonly debounceMs: number

  /** The last configuration that applied: the "before" side of the next attempt. */
  private lastGood: ConfigBaseline
  private watcher: FSWatcher | null = null
  private debounceTimer: ReturnType<typeof setTimeout> | null = null

  constructor(options: ConfigWatcherOptions) {
    this.configPath = options.configPath
    this.onReload = options.onReload
    this.onError = options.onError
    this.onReady = options.onReady
    this.initial = options.initial
    this.lastGood = options.initial
    this.env = options.env
    this.debounceMs = options.debounceMs ?? 200
  }

  /** Start watching the config file for changes. */
  start(): void {
    if (this.watcher) return // Already watching

    this.watcher = watch(this.configPath, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 10 },
    })

    this.watcher.on('change', () => {
      this.scheduleReload()
    })

    this.watcher.on('ready', () => {
      // close() nulls the watcher synchronously; chokidar also suppresses
      // ready after close — this guard is our own invariant on top.
      if (this.watcher && this.onReady) this.onReady()
    })
  }

  /** Stop watching and clean up resources. */
  close(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    if (this.watcher) {
      void this.watcher.close()
      this.watcher = null
    }
  }

  private scheduleReload(): void {
    // Debounce: cancel any pending reload, schedule a new one
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer)
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      void this.reload()
    }, this.debounceMs)
  }

  private async reload(): Promise<void> {
    const before = beforeFacts(this.lastGood)
    let sha256After: string | null = null
    let parsed: HelioConfig | null = null
    let restartRequiredPaths: readonly string[] = []
    try {
      const source = await readConfigSource(this.configPath)
      sha256After = source.sha256
      const { config } = parseConfigSource(source, this.configPath, this.env)
      parsed = config
      const { policy, warnings } = compilePolicies(config.policies)
      const budgets = compileBudgets(config.budgets)
      restartRequiredPaths = diffReloadBoundary(this.initial.config, config).restartRequiredPaths
      const facts: AppliedPolicyReloadFacts = {
        configPath: this.configPath,
        outcome: 'applied',
        ...before,
        sha256After: source.sha256,
        ruleCountAfter: config.policies.rules.length,
        defaultActionAfter: config.policies.default,
        budgetCountAfter: config.budgets.length,
        rulesRemoved: rulesRemovedBetween(this.lastGood.config, config),
        restartRequiredPaths,
        error: null,
      }
      this.onReload(policy, warnings, restartRequiredPaths, budgets, facts)
      this.lastGood = { config, sha256: source.sha256 }
      // C4b inserts `if (this.watchFailed) return` before the onReload call above.
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      const outcome: PolicyReloadOutcome =
        error instanceof PolicyReloadRejectedError ? error.outcome : 'rejected_invalid'
      this.onError(error, {
        configPath: this.configPath,
        outcome,
        ...before,
        sha256After,
        ruleCountAfter: parsed === null ? null : parsed.policies.rules.length,
        defaultActionAfter: parsed === null ? null : parsed.policies.default,
        budgetCountAfter: parsed === null ? null : parsed.budgets.length,
        rulesRemoved: parsed === null ? [] : rulesRemovedBetween(this.lastGood.config, parsed),
        restartRequiredPaths,
        error: error.message,
      })
    }
  }
}
