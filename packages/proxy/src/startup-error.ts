/**
 * Marker for startup failures that are already diagnosed for the operator.
 *
 * The CLI start and export actions print the message VERBATIM and exit 1, with no stack,
 * no `Error:` prefix, no unhandled-rejection wrapper — so a boot refused for
 * a stated reason reads as a diagnosis, not a crash dump. Anything else
 * thrown during startup keeps the crash path (stack plus crash drain).
 *
 * Deliberately not exported from the package root: the clean-exit contract
 * is the CLI's, not library surface.
 */
export class StartupError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StartupError'
  }
}
