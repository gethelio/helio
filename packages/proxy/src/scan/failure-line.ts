import { extractErrorCode } from '../upstream/connection-error.js'

// ---------------------------------------------------------------------------
// The failure line of helio scan (issue #299). A config target's line never
// repeats the transport's message: that sentence carries the resolved URL
// or command, where a `${VAR}` placeholder has already been replaced by its
// value. The line names the target as written in the file plus one token.
// ---------------------------------------------------------------------------

/**
 * Phrases Helio writes in full, with digits it took from the response
 * status or its own timer: the token is a capture from one of these, never
 * a first match anywhere in the message. The head is cut before any server
 * text (`JSON-RPC error:` or `modern MCP error <code>:`), so a server saying
 * `HTTP 500` or `timed out after 1000ms` yields nothing.
 */
const SERVER_TEXT = /JSON-RPC error:|modern MCP error -?\d+:/
const HTTP_STATUS_PHRASES: readonly RegExp[] = [
  /\bfailed: HTTP (\d{3})\b/,
  /\bupstream returned HTTP (\d{3}) to tools\/list\b/,
]
const TIMEOUT_PHRASE = /\btimed out after \d+ms\b/

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : ''
}

function tokenOf(message: string): string | undefined {
  const head = message.split(SERVER_TEXT)[0] ?? ''
  for (const phrase of HTTP_STATUS_PHRASES) {
    const match = phrase.exec(head)
    if (match?.[1] !== undefined) return `HTTP ${match[1]}`
  }
  if (TIMEOUT_PHRASE.test(head)) return 'timeout'
  return undefined
}

/**
 * The line for a target that came from a config file: the raw label, plus
 * the error's `code` (walking its `cause` chain) or, failing that, one token
 * from a closed vocabulary (`HTTP <status>`, `timeout`). No code and no
 * token leaves the line bare. Pure: no I/O.
 */
export function configTargetFailureLine(label: string, error: unknown): string {
  const token = extractErrorCode(error) ?? tokenOf(messageOf(error))
  const base = `Error: cannot list tools on ${label}`
  return token === undefined ? base : `${base} (${token})`
}

/**
 * The line for a bare `--upstream <url>` target, which carries no
 * placeholder: the normalized label and the transport's own message.
 */
export function bareTargetFailureLine(label: string, error: unknown): string {
  return `Error: cannot list tools on ${label}: ${messageOf(error)}`
}
