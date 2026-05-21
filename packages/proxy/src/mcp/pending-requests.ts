import type { JsonRpcResponse } from './types.js'

const DEFAULT_TIMEOUT_MS = 30_000

interface PendingEntry {
  resolve: (response: JsonRpcResponse) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * Manages request/response correlation for JSON-RPC over async transports.
 *
 * Used by StdioForwarder and SseUpstreamForwarder to match responses
 * to pending requests by their JSON-RPC `id`.
 */
export class PendingRequests {
  private readonly timeoutMs: number
  private readonly pending = new Map<string, PendingEntry>()

  constructor(timeoutMs: number = DEFAULT_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs
  }

  /**
   * Register a pending request. Returns a Promise that resolves when
   * `resolve()` is called with a matching id, or rejects on timeout.
   */
  add(id: string | number | null): Promise<JsonRpcResponse> {
    const key = String(id)
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key)
        reject(new Error(`request ${key} timed out after ${String(this.timeoutMs)}ms`))
      }, this.timeoutMs)

      this.pending.set(key, { resolve, reject, timer })
    })
  }

  /**
   * Resolve a pending request with the given response.
   * Returns `true` if the id was found and resolved, `false` otherwise.
   */
  resolve(id: string | number | null, response: JsonRpcResponse): boolean {
    const key = String(id)
    const entry = this.pending.get(key)
    if (!entry) return false
    clearTimeout(entry.timer)
    this.pending.delete(key)
    entry.resolve(response)
    return true
  }

  /**
   * Reject a single pending request by id.
   * Returns `true` if the id was found and rejected, `false` otherwise.
   */
  reject(id: string | number | null, error: Error): boolean {
    const key = String(id)
    const entry = this.pending.get(key)
    if (!entry) return false
    clearTimeout(entry.timer)
    this.pending.delete(key)
    entry.reject(error)
    return true
  }

  /** Reject all pending requests (e.g. on shutdown or crash). */
  rejectAll(error: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
  }

  /** Number of currently pending requests. */
  get size(): number {
    return this.pending.size
  }
}
