import type { BuiltForwarder } from '../cli-forwarder.js'
import type { CompiledPolicy } from '../policy/types.js'
import type { CompiledBudget } from '../budget/types.js'
import { classifyPrimeFailure, listToolsInternal } from '../upstream/list-tools.js'
import { bareTargetFailureLine, configTargetFailureLine } from './failure-line.js'
import { buildScanReport, emptyAllowPolicy, renderScanText } from './report.js'
import type { ScanReport } from './report.js'
import type { ScanTarget } from './target.js'
import { surfaceToolsFromList } from './tools.js'
import type { SurfaceToolsFromList } from './tools.js'

// ---------------------------------------------------------------------------
// The scan run (issue #299): connect, list, report, close, on every exit path
// ---------------------------------------------------------------------------

/** What scan classifies against when a config was loaded. */
export interface ScanPolicyInput {
  readonly path: string
  readonly policy: CompiledPolicy
  readonly budgets: readonly CompiledBudget[]
  readonly environment: string | undefined
}

/** The process signals the run listens to; `process` in the CLI, a fake in tests. */
export interface ScanSignalSource {
  on(signal: 'SIGINT' | 'SIGTERM', handler: () => void): void
  off(signal: 'SIGINT' | 'SIGTERM', handler: () => void): void
}

export interface RunScanOptions {
  readonly target: ScanTarget
  readonly format: 'text' | 'json'
  readonly config: ScanPolicyInput | undefined
  /** Builds and connects the forwarder; the signal aborts the connect window. */
  readonly connect: (signal: AbortSignal) => Promise<BuiltForwarder>
  /** Called with the assembled report before it is printed (the `--write` hook). */
  readonly onReport?: (report: ScanReport) => Promise<void> | void
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
  /** The process exit used by the signal handler once the forwarder is closed. */
  readonly exit: (code: number) => void
  readonly signals: ScanSignalSource
  readonly now?: () => Date
}

const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 } as const

/**
 * Run one scan: connect to the target, read `tools/list` once, print the
 * report, close the forwarder. Resolves the exit code: 0 for a listed
 * surface, 1 when the list failed (the report still prints, with the
 * failure line), 130 or 143 when a signal interrupted the connect. A signal
 * after the connect closes the forwarder and exits through `exit`. The
 * signal handlers are installed before the connect, because the connect is
 * what spawns a stdio child, and removed when the run ends.
 */
export async function runScan(options: RunScanOptions): Promise<number> {
  const { target, format, config } = options
  const controller = new AbortController()
  let built: BuiltForwarder | undefined
  let interrupted: 130 | 143 | undefined
  // While the report hook runs (the --write file), a signal must not exit
  // from the handler: the awaited run reads the flag after the hook instead.
  let reporting = false
  let closedByHandler = false
  const handlerClosed = (): boolean => closedByHandler
  // The handler assigns `interrupted` from outside the run's control flow; a
  // call, unlike the variable, is re-read after every await.
  const interruptedCode = (): 130 | 143 | undefined => interrupted

  const onSignal = (signal: 'SIGINT' | 'SIGTERM'): void => {
    const code = SIGNAL_EXIT_CODES[signal]
    if (interrupted !== undefined) return
    interrupted = code
    if (built === undefined) {
      controller.abort()
      return
    }
    if (reporting) return
    closedByHandler = true
    void Promise.resolve(built.close?.()).then(
      () => {
        options.exit(code)
      },
      () => {
        options.exit(code)
      },
    )
  }
  const onSigint = (): void => {
    onSignal('SIGINT')
  }
  const onSigterm = (): void => {
    onSignal('SIGTERM')
  }
  options.signals.on('SIGINT', onSigint)
  options.signals.on('SIGTERM', onSigterm)

  const failureLine = (error: unknown): string =>
    target.source === 'config'
      ? configTargetFailureLine(target.label, error)
      : bareTargetFailureLine(target.label, error)

  const report = (
    listed: SurfaceToolsFromList | null,
    unavailable: string | undefined,
  ): ScanReport =>
    buildScanReport({
      target: {
        label: target.label,
        transport: target.transport,
        upstream: target.upstreamName,
        config: config?.path,
      },
      generatedAt: (options.now ?? (() => new Date()))().toISOString(),
      policy: config?.policy ?? emptyAllowPolicy(),
      policyLoaded: config !== undefined,
      budgets: config?.budgets ?? [],
      environment: config?.environment,
      listed,
      unavailable,
    })

  const finish = async (doc: ScanReport): Promise<number> => {
    if (options.onReport !== undefined) {
      reporting = true
      try {
        await options.onReport(doc)
      } finally {
        reporting = false
      }
      const code = interruptedCode()
      if (code !== undefined) return code
    }
    options.stdout(format === 'json' ? JSON.stringify(doc, null, 2) : renderScanText(doc))
    return doc.surface.unavailable.length === 0 ? 0 : 1
  }

  try {
    try {
      built = await options.connect(controller.signal)
    } catch (error) {
      {
        const code = interruptedCode()
        if (code !== undefined) return code
      }
      return await finish(report(null, failureLine(error)))
    }
    {
      const code = interruptedCode()
      if (code !== undefined) return code
    }

    let listed: SurfaceToolsFromList | null = null
    let unavailable: string | undefined
    try {
      const result = await listToolsInternal(built.forwarder)
      if (!result.ok) {
        unavailable = failureLine(result.reason)
      } else {
        listed = surfaceToolsFromList(result.response.body)
        if (listed === null) unavailable = failureLine(classifyPrimeFailure(result.response))
      }
    } catch (error) {
      {
        const code = interruptedCode()
        if (code !== undefined) return code
      }
      unavailable = failureLine(error)
    }
    {
      const code = interruptedCode()
      if (code !== undefined) return code
    }
    return await finish(report(listed, unavailable))
  } finally {
    options.signals.off('SIGINT', onSigint)
    options.signals.off('SIGTERM', onSigterm)
    if (!handlerClosed()) await built?.close?.()
  }
}
