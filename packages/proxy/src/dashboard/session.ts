import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/** Options for dashboard session storage. */
export interface DashboardSessionStoreOptions {
  /** Shared secret used to sign session tokens. */
  readonly secret: string
  /** Session TTL in milliseconds. Defaults to 8 hours. */
  readonly ttlMs?: number
  /** Injectable clock for deterministic tests. Defaults to `Date.now`. */
  readonly now?: () => number
  /** Cleanup interval in milliseconds. Defaults to 60 seconds; 0 disables timer. */
  readonly cleanupIntervalMs?: number
}

/** Validated dashboard session material. */
export interface DashboardSession {
  readonly token: string
  readonly csrfToken: string
  readonly expiresAtMs: number
}

interface SessionRecord {
  csrfToken: string
  expiresAtMs: number
}

/**
 * In-memory session store for dashboard cookie auth.
 *
 * Session tokens are opaque IDs signed with HMAC-SHA256:
 * `<sessionId>.<signature>`.
 */
export class DashboardSessionStore {
  private readonly secret: string
  private readonly ttlMs: number
  private readonly now: () => number
  private readonly records = new Map<string, SessionRecord>()
  private timer: ReturnType<typeof setInterval> | null = null
  private closed = false

  constructor(options: DashboardSessionStoreOptions) {
    this.secret = options.secret
    this.ttlMs = options.ttlMs ?? 8 * 60 * 60 * 1_000
    this.now = options.now ?? Date.now

    const cleanupIntervalMs = options.cleanupIntervalMs ?? 60_000
    if (cleanupIntervalMs > 0) {
      this.timer = setInterval(() => {
        this.cleanupExpired()
      }, cleanupIntervalMs)
      this.timer.unref()
    }
  }

  /** Create and persist a new dashboard session. */
  create(): DashboardSession {
    const id = randomBytes(24).toString('base64url')
    const csrfToken = randomBytes(24).toString('base64url')
    const expiresAtMs = this.now() + this.ttlMs
    this.records.set(id, { csrfToken, expiresAtMs })
    const token = this.encodeToken(id)
    return { token, csrfToken, expiresAtMs }
  }

  /** Validate a signed session token and return the associated session. */
  validate(token: string | undefined): DashboardSession | undefined {
    if (!token) return undefined
    const id = this.decodeToken(token)
    if (!id) return undefined

    const record = this.records.get(id)
    if (!record) return undefined
    if (record.expiresAtMs <= this.now()) {
      this.records.delete(id)
      return undefined
    }

    return {
      token,
      csrfToken: record.csrfToken,
      expiresAtMs: record.expiresAtMs,
    }
  }

  /** Revoke a session token if it is valid. */
  revoke(token: string | undefined): void {
    if (!token) return
    const id = this.decodeToken(token)
    if (!id) return
    this.records.delete(id)
  }

  /** Remove all expired sessions from memory. */
  cleanupExpired(): void {
    const now = this.now()
    for (const [id, record] of this.records) {
      if (record.expiresAtMs <= now) {
        this.records.delete(id)
      }
    }
  }

  /** Stop cleanup timer and clear all session state. */
  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.records.clear()
  }

  private encodeToken(id: string): string {
    return `${id}.${this.sign(id)}`
  }

  private decodeToken(token: string): string | undefined {
    const dot = token.indexOf('.')
    if (dot <= 0 || dot >= token.length - 1) return undefined
    const id = token.slice(0, dot)
    const signature = token.slice(dot + 1)
    const expected = this.sign(id)

    // Compare digests of both signatures to avoid fast-fail on differing lengths.
    const actualDigest = createHash('sha256').update(signature).digest()
    const expectedDigest = createHash('sha256').update(expected).digest()
    if (!timingSafeEqual(actualDigest, expectedDigest)) return undefined
    return id
  }

  private sign(id: string): string {
    return createHmac('sha256', this.secret).update(id).digest('base64url')
  }
}
