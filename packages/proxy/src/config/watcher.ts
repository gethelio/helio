import { watch } from 'chokidar'
import type { FSWatcher } from 'chokidar'
import { loadConfig } from './loader.js'
import type { HelioConfig } from './schema.js'
import { diffReloadBoundary } from './reload-boundary.js'
import { compilePolicies } from '../policy/parser.js'
import type { CompiledPolicy, PolicyParseWarning } from '../policy/types.js'

// ---------------------------------------------------------------------------
// ConfigWatcher — hot-reload policy rules on helio.yaml changes.
// ---------------------------------------------------------------------------

/** Options for constructing a ConfigWatcher. */
export interface ConfigWatcherOptions {
  /** Absolute or relative path to helio.yaml. */
  readonly configPath: string
  /** Called with the new compiled policy on successful reload. */
  readonly onPolicyReload: (
    policy: CompiledPolicy,
    warnings: readonly PolicyParseWarning[],
    restartRequiredPaths: readonly string[],
  ) => void
  /** Called when a reload attempt fails (parse, validation, or compile error). */
  readonly onError: (error: Error) => void
  /** Baseline config loaded at startup, used for restart-required diffing. */
  readonly initialConfig?: HelioConfig
  /** Environment variables for config interpolation. */
  readonly env?: Record<string, string | undefined>
  /** Debounce interval in milliseconds (default: 200). */
  readonly debounceMs?: number
}

/**
 * Watches a helio.yaml config file for changes and recompiles the policy
 * rule set when the file is modified. On successful reload, calls
 * `onPolicyReload` with the new compiled policy. On failure, calls
 * `onError` and retains the current policy.
 */
export class ConfigWatcher {
  private readonly configPath: string
  private readonly onPolicyReload: ConfigWatcherOptions['onPolicyReload']
  private readonly onError: ConfigWatcherOptions['onError']
  private readonly initialConfig: HelioConfig | undefined
  private readonly env: Record<string, string | undefined> | undefined
  private readonly debounceMs: number

  private watcher: FSWatcher | null = null
  private debounceTimer: ReturnType<typeof setTimeout> | null = null

  constructor(options: ConfigWatcherOptions) {
    this.configPath = options.configPath
    this.onPolicyReload = options.onPolicyReload
    this.onError = options.onError
    this.initialConfig = options.initialConfig
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
    try {
      const config = await loadConfig(this.configPath, this.env)
      const { policy, warnings } = compilePolicies(config.policies)
      const restartRequiredPaths =
        this.initialConfig !== undefined
          ? diffReloadBoundary(this.initialConfig, config).restartRequiredPaths
          : []
      this.onPolicyReload(policy, warnings, restartRequiredPaths)
    } catch (err) {
      if (err instanceof Error) {
        this.onError(err)
      } else {
        this.onError(new Error(String(err)))
      }
    }
  }
}
