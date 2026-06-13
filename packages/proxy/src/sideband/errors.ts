/**
 * Error thrown when the GovernanceService is wired in a way that could fail
 * open — for example, an approval-capable policy with no ApprovalRouter to
 * route `require_approval` decisions through (issue #12). Surfaced at
 * construction and on hot-reload so a misconfiguration crashes loudly rather
 * than silently degrading an approval into an unenforced allow.
 *
 * Direct embedders of GovernanceService can catch this distinctly; the bundled
 * CLI always provides a router, so it never fires in the shipped path.
 */
export class GovernanceConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GovernanceConfigError'
  }
}
