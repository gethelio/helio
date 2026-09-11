import { access, constants } from 'node:fs/promises'
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

/** How often, while the watch is lost, the watcher checks whether it can read the file again (issue #352). */
export const DEFAULT_REARM_INTERVAL_MS = 1000

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
  /** When set, a reload whose file bytes hash differently is refused before parsing (issue #341). */
  readonly pinnedSha256?: string
  /** While the watch is lost, how often to check whether the file can be read again; default DEFAULT_REARM_INTERVAL_MS. */
  readonly rearmIntervalMs?: number
  /**
   * Test seam only: how the chokidar watcher is created. Production never
   * sets it; the default is chokidar's `watch`. The suite uses it to make a
   * fresh arm fail after the readability check passed (issue #352).
   */
  readonly watchFactory?: typeof watch
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
 * `onError` and retains the current policy. When the watch itself is lost,
 * it records the loss once, keeps the current policy, and retries until the
 * file can be read again, then arms a fresh watch and reloads the file.
 */
export class ConfigWatcher {
  private readonly configPath: string
  private readonly onReload: ConfigWatcherOptions['onReload']
  private readonly onError: ConfigWatcherOptions['onError']
  private readonly onReady: ConfigWatcherOptions['onReady']
  private readonly initial: ConfigBaseline
  private readonly env: Record<string, string | undefined> | undefined
  private readonly debounceMs: number
  /** When set, a reload whose bytes hash differently is refused before parsing (issue #341). */
  private readonly pinnedSha256: string | undefined
  private readonly rearmIntervalMs: number
  private readonly watchFactory: typeof watch

  /** The last configuration that applied: the "before" side of the next attempt. */
  private lastGood: ConfigBaseline
  private watcher: FSWatcher | null = null
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private rearmTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * Set while the watch is lost: later change events and in-flight reloads
   * from the dying watch are ignored (issue #351). Cleared right before a
   * fresh watch is armed, so a fresh arm that fails is a new loss (issue #352).
   */
  private watchFailed = false
  /** Bumped by every arm and by close(); a listener whose generation is stale returns at once. */
  private generation = 0
  /** Set by close() and never cleared: no retry runs after it, and start() is a no-op. */
  private closed = false

  constructor(options: ConfigWatcherOptions) {
    this.configPath = options.configPath
    this.onReload = options.onReload
    this.onError = options.onError
    this.onReady = options.onReady
    this.initial = options.initial
    this.lastGood = options.initial
    this.env = options.env
    this.debounceMs = options.debounceMs ?? 200
    this.pinnedSha256 = options.pinnedSha256
    this.rearmIntervalMs = options.rearmIntervalMs ?? DEFAULT_REARM_INTERVAL_MS
    this.watchFactory = options.watchFactory ?? watch
  }

  /** Start watching the config file for changes. A no-op after close(). */
  start(): void {
    if (this.closed || this.watcher) return // Closed for good, or already watching
    this.arm()
  }

  /** Stop watching and clean up resources. The watcher cannot be started again. */
  close(): void {
    this.closed = true
    this.generation += 1 // Every listener of every past watcher goes inert
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    // Hygiene rather than the thing that stops the loop: a timer that
    // outlived close() would fire a tryRearm that returns on `closed`.
    if (this.rearmTimer !== null) {
      clearTimeout(this.rearmTimer)
      this.rearmTimer = null
    }
    if (this.watcher) {
      void this.watcher.close()
      this.watcher = null
    }
  }

  /** Create the chokidar watcher for this generation and attach its listeners. */
  private arm(): void {
    const gen = ++this.generation
    const watcher = this.watchFactory(this.configPath, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 10 },
    })
    this.watcher = watcher
    // A listener of a watcher this instance has moved past (a later arm, or
    // close()) must do nothing, whatever chokidar still emits from it.
    const stale = (): boolean => gen !== this.generation || this.closed

    watcher.on('change', () => {
      if (stale() || this.watchFailed) return
      this.scheduleReload()
    })

    watcher.on('ready', () => {
      // A fresh watcher whose arming failed emits error and THEN ready
      // (chokidar calls ready() whether or not fs.watch succeeded). The
      // error listener below closes it first, which strips this event; if
      // that order ever changes, a ready with the watch failed is not a
      // resume and must not report the watch as armed.
      if (stale() || this.watchFailed) return
      if (this.onReady) this.onReady()
      // A resume (every arm after the first): the file on disk is whatever
      // the operator put there while the watch was lost, so reload it now
      // rather than serve a policy the file may no longer hold.
      if (gen > 1) void this.reload()
    })

    watcher.on('error', (err: unknown) => {
      if (stale()) return
      // The watch itself failed (the file replaced by one this process
      // cannot read is the live case): chokidar fails the re-watch of the
      // new inode and then emits the deferred change for the replaced path,
      // so one replacement reaches this watcher twice. Report it ONCE: mark
      // the watch failed, drop any pending reload, and ignore later change
      // events from the dying watch. Nothing was read and the running
      // policy stays. Then retry: close the dead instance and check once
      // per interval whether the file can be read again; when it can, a
      // fresh watch is armed, onReady fires again, and the file is reloaded
      // at once (issue #352).
      const error = err instanceof Error ? err : new Error(String(err))
      if (this.watchFailed) return
      this.watchFailed = true
      if (this.debounceTimer !== null) {
        clearTimeout(this.debounceTimer)
        this.debounceTimer = null
      }
      const before = beforeFacts(this.lastGood)
      this.onError(error, {
        configPath: this.configPath,
        outcome: 'watch_failed',
        ...before,
        sha256After: null,
        ruleCountAfter: null,
        defaultActionAfter: null,
        budgetCountAfter: null,
        rulesRemoved: [],
        restartRequiredPaths: [],
        error: error.message,
      })
      // Resource cleanup for the dead instance (its descriptor); the stale
      // check above is what keeps its deferred change from reloading.
      void watcher.close()
      this.watcher = null
      this.scheduleRearm()
    })
  }

  private scheduleRearm(): void {
    if (this.closed) return
    if (this.rearmTimer !== null) {
      clearTimeout(this.rearmTimer)
    }
    this.rearmTimer = setTimeout(() => {
      this.rearmTimer = null
      if (this.closed) return // The timer outlived close()
      void this.tryRearm()
    }, this.rearmIntervalMs)
  }

  /** One retry: if the file can be read again, arm a fresh watch; otherwise wait another interval. */
  private async tryRearm(): Promise<void> {
    try {
      await access(this.configPath, constants.R_OK)
    } catch {
      this.scheduleRearm()
      return
    }
    // close() while the check was pending. Belt-and-suspenders: access on an
    // unreadable file rejects in well under a millisecond, so no test reaches
    // this line; it is kept so a repair landing inside that await can never
    // arm a watcher on a closed instance.
    if (this.closed) return
    // Cleared BEFORE the fresh arm: should that arm fail (the file unreadable
    // again between the check and chokidar's own watch), its error is a new
    // loss with its own record and its own retry, not a suppressed repeat.
    this.watchFailed = false
    this.arm()
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
      if (this.pinnedSha256 !== undefined && source.sha256 !== this.pinnedSha256) {
        throw new PolicyReloadRejectedError(
          'rejected_pinned',
          `config hash sha256:${source.sha256} does not match the pinned sha256:${this.pinnedSha256}`,
        )
      }
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
      // The watch failed while this reload was in flight: the replacement is
      // the watch_failed record's, whatever these bytes were; nothing applies
      // and the baseline stays.
      if (this.watchFailed) return
      this.onReload(policy, warnings, restartRequiredPaths, budgets, facts)
      this.lastGood = { config, sha256: source.sha256 }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      const outcome: PolicyReloadOutcome =
        error instanceof PolicyReloadRejectedError ? error.outcome : 'rejected_invalid'
      // A reload already in flight when the watch failed read the same
      // replacement; the watch_failed record covers it.
      if (this.watchFailed) return
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
