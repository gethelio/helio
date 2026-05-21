import type {
  CompletedTool,
  EvidenceEntry,
  EvidenceKeyAllowlistPreview,
  EvidenceStoreOptions,
  PutContextResult,
  PutEvidenceResult,
  SessionState,
} from './types.js'

// ---------------------------------------------------------------------------
// EvidenceStore — in-memory per-session evidence cache with TTL expiry.
//
// Evidence entries are written by the SDK via the sideband API and read by
// the policy engine to enforce evidence requirements. Context entries are
// arbitrary key-value pairs set by the SDK for session-level metadata.
//
// TTL is enforced in two places:
// 1. On read (lazy eviction) — expired entries are deleted and never returned.
// 2. On sweep (active eviction) — a periodic timer removes expired entries
//    and empty sessions to prevent memory leaks from abandoned sessions.
// ---------------------------------------------------------------------------

/** Internal per-session storage. */
interface SessionData {
  evidence: Map<string, EvidenceEntry>
  seenEvidenceKeys: Set<string>
  context: Map<string, unknown>
  completedTools: Map<string, CompletedTool>
  lastTouchedAtMs: number
}

/** Input for putEvidence (omits computed fields). */
export interface PutEvidenceInput {
  readonly evidence_key: string
  readonly data: unknown
  readonly tool_name: string
  readonly ttl_seconds?: number
}

export class EvidenceStore {
  private static readonly EVIDENCE_ALLOWLIST_PREVIEW_LIMIT = 20
  private static readonly MAX_UNIQUE_REJECTION_WARNINGS = 20
  private static readonly REJECTION_WARNING_SUMMARY_INTERVAL = 50

  private readonly sessions = new Map<string, SessionData>()
  private readonly defaultTtlSeconds: number
  private readonly sessionInactivityMs: number
  private readonly now: () => number
  private readonly warnedRejectedEvidenceKeys = new Set<string>()
  private allowedEvidenceKeys: Set<string> | null
  private suppressedRejectionWarningCount = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private closed = false

  constructor(options: EvidenceStoreOptions = {}) {
    this.defaultTtlSeconds = options.defaultTtlSeconds ?? 300
    this.sessionInactivityMs = options.sessionInactivityMs ?? 3_600_000
    this.now = options.now ?? Date.now
    this.allowedEvidenceKeys = options.allowedEvidenceKeys
      ? new Set(options.allowedEvidenceKeys)
      : null

    const intervalMs = options.cleanupIntervalMs ?? 60_000
    if (intervalMs > 0) {
      this.timer = setInterval(() => {
        this.cleanup()
      }, intervalMs)
      this.timer.unref()
    }
  }

  // -------------------------------------------------------------------------
  // Write operations
  // -------------------------------------------------------------------------

  /** Insert or update an evidence entry for a session. */
  putEvidence(sessionId: string, input: PutEvidenceInput): PutEvidenceResult {
    if (this.closed) return { stored: false, reason: 'closed' }
    if (!this.isEvidenceKeyAllowed(input.evidence_key)) {
      const allowlist = this.buildAllowlistPreview(EvidenceStore.EVIDENCE_ALLOWLIST_PREVIEW_LIMIT)
      this.warnRejectedEvidenceKey(input.evidence_key, allowlist)
      return {
        stored: false,
        reason: 'key_not_in_policy_allowlist',
        rejectedKey: input.evidence_key,
        allowlist,
      }
    }

    const session = this.ensureSession(sessionId)
    this.touchSession(session)
    const ttl = input.ttl_seconds ?? this.defaultTtlSeconds

    const entry: EvidenceEntry = {
      evidence_key: input.evidence_key,
      data: input.data,
      tool_name: input.tool_name,
      timestamp: new Date(this.now()).toISOString(),
      expires_at: this.now() + ttl * 1_000,
    }

    session.seenEvidenceKeys.add(input.evidence_key)
    session.evidence.set(input.evidence_key, entry)
    return { stored: true }
  }

  /** Set an arbitrary context value for a session. */
  putContext(sessionId: string, key: string, value: unknown): PutContextResult {
    if (this.closed) return { stored: false, reason: 'closed' }

    const session = this.ensureSession(sessionId)
    this.touchSession(session)
    session.context.set(key, value)
    return { stored: true }
  }

  // -------------------------------------------------------------------------
  // Read operations
  // -------------------------------------------------------------------------

  /** Get a single evidence entry, or undefined if missing/expired. */
  getEvidence(sessionId: string, evidenceKey: string): EvidenceEntry | undefined {
    const session = this.sessions.get(sessionId)
    if (!session) return undefined

    const entry = session.evidence.get(evidenceKey)
    if (!entry) return undefined

    this.touchSession(session)

    // Lazy eviction
    if (entry.expires_at <= this.now()) {
      session.evidence.delete(evidenceKey)
      return undefined
    }

    return entry
  }

  /** Check whether valid (non-expired) evidence exists. */
  hasEvidence(sessionId: string, evidenceKey: string): boolean {
    return this.getEvidence(sessionId, evidenceKey) !== undefined
  }

  /**
   * Check whether evidence with this key has ever been seen in the session.
   *
   * Distinct from hasEvidence(): a key may be "seen" but currently expired.
   */
  hasSeenEvidence(sessionId: string, evidenceKey: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    this.touchSession(session)
    return session.seenEvidenceKeys.has(evidenceKey)
  }

  /** Get a single context value, or undefined if missing. */
  getContext(sessionId: string, key: string): unknown {
    const session = this.sessions.get(sessionId)
    if (!session) return undefined
    this.touchSession(session)
    return session.context.get(key)
  }

  /**
   * Record that a tool was invoked in a session (for dependency chains).
   *
   * Dependency-chain success is *sticky*: once a tool has successfully
   * completed in a session, a later failed retry of the same tool must not
   * revoke the dependency. Otherwise an agent could legitimately satisfy a
   * dependency, get mid-session credentials, then lose access by accidentally
   * re-calling the same tool with a bad argument. The stored entry therefore
   * keeps `succeeded: true` once set; the timestamp refreshes on every call
   * so operators still see the most recent invocation time.
   */
  recordToolCall(sessionId: string, toolName: string, succeeded: boolean): void {
    if (this.closed) return

    const session = this.ensureSession(sessionId)
    this.touchSession(session)
    const existing = session.completedTools.get(toolName)
    const stickySuccess = existing?.succeeded === true || succeeded
    const entry: CompletedTool = {
      tool_name: toolName,
      timestamp: new Date(this.now()).toISOString(),
      succeeded: stickySuccess,
    }
    session.completedTools.set(toolName, entry)
  }

  /** Check whether a tool was called in a session (regardless of outcome). */
  hasCompletedTool(sessionId: string, toolName: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    this.touchSession(session)
    return session.completedTools.has(toolName)
  }

  /** Check whether a tool was called AND succeeded in a session. */
  hasSuccessfulTool(sessionId: string, toolName: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    this.touchSession(session)
    const entry = session.completedTools.get(toolName)
    return entry !== undefined && entry.succeeded
  }

  /**
   * Get a raw evidence entry WITHOUT lazy eviction.
   * Used by the grounding layer to distinguish "never stored" from "stored but expired".
   */
  peekEvidence(sessionId: string, evidenceKey: string): EvidenceEntry | undefined {
    const session = this.sessions.get(sessionId)
    if (!session) return undefined
    this.touchSession(session)
    return session.evidence.get(evidenceKey)
  }

  /** Get the full combined state for a session (evidence + context + completed tools). */
  getSessionState(sessionId: string): SessionState {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return { session_id: sessionId, evidence: {}, context: {}, completed_tools: [] }
    }
    this.touchSession(session)

    const now = this.now()
    const evidence: Record<string, EvidenceEntry> = {}

    for (const [key, entry] of session.evidence) {
      if (entry.expires_at > now) {
        evidence[key] = entry
      }
    }

    const context: Record<string, unknown> = {}
    for (const [key, value] of session.context) {
      context[key] = value
    }

    return {
      session_id: sessionId,
      evidence,
      context,
      completed_tools: [...session.completedTools.values()],
    }
  }

  // -------------------------------------------------------------------------
  // Maintenance
  // -------------------------------------------------------------------------

  /** Sweep all sessions, removing expired evidence and empty sessions. */
  cleanup(): void {
    const now = this.now()

    for (const [sessionId, session] of this.sessions) {
      // Remove expired evidence entries
      for (const [key, entry] of session.evidence) {
        if (entry.expires_at <= now) {
          session.evidence.delete(key)
        }
      }

      // Remove sessions with no evidence, no context, and no tool history
      if (
        session.evidence.size === 0 &&
        session.seenEvidenceKeys.size === 0 &&
        session.context.size === 0 &&
        session.completedTools.size === 0
      ) {
        this.sessions.delete(sessionId)
        continue
      }

      if (
        session.evidence.size === 0 &&
        now - session.lastTouchedAtMs >= this.sessionInactivityMs
      ) {
        this.sessions.delete(sessionId)
      }
    }
  }

  /** Stop the cleanup timer and clear all state. Idempotent. */
  close(): void {
    if (this.closed) return
    this.closed = true

    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }

    this.sessions.clear()
  }

  // -------------------------------------------------------------------------
  // Diagnostics
  // -------------------------------------------------------------------------

  /** Number of tracked sessions (for testing/debugging). */
  get sessionCount(): number {
    return this.sessions.size
  }

  /** Number of evidence entries for a session (including expired, pre-eviction). */
  evidenceCount(sessionId: string): number {
    const session = this.sessions.get(sessionId)
    return session ? session.evidence.size : 0
  }

  /** Number of evidence keys ever seen in a session. */
  seenEvidenceCount(sessionId: string): number {
    const session = this.sessions.get(sessionId)
    return session ? session.seenEvidenceKeys.size : 0
  }

  /**
   * Replace the evidence key allowlist.
   *
   * Unknown keys submitted through putEvidence() are ignored once an allowlist
   * is configured.
   */
  setAllowedEvidenceKeys(keys: readonly string[]): void {
    this.allowedEvidenceKeys = new Set(keys)
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private ensureSession(sessionId: string): SessionData {
    let session = this.sessions.get(sessionId)
    if (!session) {
      session = {
        evidence: new Map(),
        seenEvidenceKeys: new Set(),
        context: new Map(),
        completedTools: new Map(),
        lastTouchedAtMs: this.now(),
      }
      this.sessions.set(sessionId, session)
    }
    return session
  }

  private touchSession(session: SessionData): void {
    session.lastTouchedAtMs = this.now()
  }

  private isEvidenceKeyAllowed(evidenceKey: string): boolean {
    if (this.allowedEvidenceKeys === null) return true
    return this.allowedEvidenceKeys.has(evidenceKey)
  }

  private buildAllowlistPreview(limit: number): EvidenceKeyAllowlistPreview {
    if (this.allowedEvidenceKeys === null) {
      return { allowedKeys: [], allowedKeyCount: 0, truncated: false }
    }

    const allKeys = [...this.allowedEvidenceKeys].sort()
    const allowedKeys = allKeys.slice(0, limit)
    return {
      allowedKeys,
      allowedKeyCount: allKeys.length,
      truncated: allKeys.length > allowedKeys.length,
    }
  }

  private warnRejectedEvidenceKey(
    rejectedKey: string,
    allowlist: EvidenceKeyAllowlistPreview,
  ): void {
    if (this.warnedRejectedEvidenceKeys.has(rejectedKey)) return

    if (this.warnedRejectedEvidenceKeys.size < EvidenceStore.MAX_UNIQUE_REJECTION_WARNINGS) {
      this.warnedRejectedEvidenceKeys.add(rejectedKey)
      const displayed = JSON.stringify(allowlist.allowedKeys)
      const scope = allowlist.truncated
        ? `showing ${String(allowlist.allowedKeys.length)} of ${String(allowlist.allowedKeyCount)}`
        : `${String(allowlist.allowedKeyCount)} total`
      // eslint-disable-next-line no-console -- Intentional operational warning
      console.error(
        `[helio] Evidence rejected: key "${rejectedKey}" not in policy allowlist (configured keys: ${displayed}; ${scope}). Add evidence.requires for this key, or update the SDK call site to a configured key.`,
      )
      return
    }

    this.suppressedRejectionWarningCount += 1
    if (
      this.suppressedRejectionWarningCount === 1 ||
      this.suppressedRejectionWarningCount % EvidenceStore.REJECTION_WARNING_SUMMARY_INTERVAL === 0
    ) {
      // eslint-disable-next-line no-console -- Intentional operational warning
      console.error(
        `[helio] Evidence rejection warnings: suppressing additional unique keys after ${String(EvidenceStore.MAX_UNIQUE_REJECTION_WARNINGS)} samples (${String(this.suppressedRejectionWarningCount)} suppressed so far).`,
      )
    }
  }
}
