// ---------------------------------------------------------------------------
// Evidence store types — per-session evidence cache and context.
// ---------------------------------------------------------------------------

/**
 * A single evidence entry recorded by the SDK.
 *
 * DTO: snake_case because it's emitted directly over `/api/evidence/:session_id`
 * and the SDK sideband's `/session/:id/state`. `JSON.stringify(entry)` produces
 * the wire shape without a mapping layer.
 */
export interface EvidenceEntry {
  readonly evidence_key: string
  readonly data: unknown
  readonly tool_name: string
  readonly timestamp: string
  readonly expires_at: number
}

/**
 * A record that a tool was invoked in a session.
 *
 * DTO: snake_case because it appears inside `SessionState.completed_tools`.
 */
export interface CompletedTool {
  readonly tool_name: string
  readonly timestamp: string
  readonly succeeded: boolean
}

/**
 * Combined read-only state for a single session.
 *
 * DTO: snake_case because this is the response body of
 * `/api/evidence/:session_id` and `/session/:session_id/state`.
 */
export interface SessionState {
  readonly session_id: string
  readonly evidence: Record<string, EvidenceEntry>
  readonly context: Record<string, unknown>
  readonly completed_tools: readonly CompletedTool[]
}

/**
 * Diagnostics preview of the current evidence-key allowlist.
 *
 * Internal helper type used when sideband writes are rejected because an
 * evidence key is not configured in policy.
 */
export interface EvidenceKeyAllowlistPreview {
  readonly allowedKeys: readonly string[]
  readonly allowedKeyCount: number
  readonly truncated: boolean
}

/** Result of attempting to store evidence via putEvidence(). */
export type PutEvidenceResult =
  | { readonly stored: true }
  | { readonly stored: false; readonly reason: 'closed' }
  | {
      readonly stored: false
      readonly reason: 'key_not_in_policy_allowlist'
      readonly rejectedKey: string
      readonly allowlist: EvidenceKeyAllowlistPreview
    }

/** Result of attempting to write context via putContext(). */
export type PutContextResult =
  | { readonly stored: true }
  | { readonly stored: false; readonly reason: 'closed' }

/** Options for constructing an EvidenceStore. */
export interface EvidenceStoreOptions {
  /** Default TTL in seconds when not specified per-entry (default: 300). */
  readonly defaultTtlSeconds?: number
  /** Cleanup sweep interval in milliseconds (default: 60_000). Set to 0 to disable. */
  readonly cleanupIntervalMs?: number
  /**
   * Inactivity TTL for sessions that have no live evidence entries but still
   * contain context and/or completed tool history (default: 1 hour).
   */
  readonly sessionInactivityMs?: number
  /**
   * Optional allowlist of evidence keys accepted by putEvidence().
   *
   * When omitted, all keys are accepted. When provided, unknown keys are
   * rejected to prevent high-cardinality session growth from dynamic keys.
   */
  readonly allowedEvidenceKeys?: readonly string[]
  /** Injectable clock for testing (default: Date.now). */
  readonly now?: () => number
}
