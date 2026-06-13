/* eslint-disable no-console -- audit writer reports errors to stderr */
import { randomUUID } from 'node:crypto'
import type { AuditRecord } from './types.js'
import type { AuditStore } from './store.js'

// ---------------------------------------------------------------------------
// AuditWriter — async buffered writer for audit records.
//
// Accepts records via push() and flushes them to the underlying AuditStore
// in batches. Flushing is triggered by a buffer size threshold or a periodic
// timer, whichever fires first. This ensures audit writes never block the
// request path while keeping write latency bounded.
// ---------------------------------------------------------------------------

/** Options for constructing an AuditWriter. */
export interface AuditWriterOptions {
  /** The underlying synchronous store to flush records into. */
  readonly store: AuditStore
  /** Max records before a flush is triggered (default: 50). */
  readonly bufferSize?: number
  /** Max milliseconds between flushes (default: 100). */
  readonly flushIntervalMs?: number
  /** Optional callback invoked when a record enters the in-memory buffer. */
  readonly onPush?: (record: Omit<AuditRecord, 'id' | 'created_at'>, id: string) => void
  /** Optional callback invoked after a record is successfully persisted. */
  readonly onPersist?: (record: Omit<AuditRecord, 'id' | 'created_at'>, id: string) => void
}

/** A buffered entry: the pre-generated ID paired with the record. */
interface BufferEntry {
  readonly id: string
  readonly record: Omit<AuditRecord, 'id' | 'created_at'>
}

/**
 * Async buffered audit record writer.
 *
 * Records are pushed into an in-memory buffer and flushed to the AuditStore
 * in batches — either when the buffer reaches `bufferSize` or every
 * `flushIntervalMs`, whichever comes first.
 */
export class AuditWriter {
  private readonly store: AuditStore
  private readonly bufferSize: number
  private readonly onPush:
    | ((record: Omit<AuditRecord, 'id' | 'created_at'>, id: string) => void)
    | undefined
  private readonly onPersist:
    | ((record: Omit<AuditRecord, 'id' | 'created_at'>, id: string) => void)
    | undefined
  private buffer: BufferEntry[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private flushSoonTimer: ReturnType<typeof setTimeout> | null = null
  private closed = false

  constructor(options: AuditWriterOptions) {
    this.store = options.store
    this.bufferSize = options.bufferSize ?? 50
    this.onPush = options.onPush
    this.onPersist = options.onPersist

    const intervalMs = options.flushIntervalMs ?? 100
    if (intervalMs > 0) {
      this.timer = setInterval(() => {
        if (this.buffer.length > 0) {
          this.flush()
        }
      }, intervalMs)
      this.timer.unref()
    }
  }

  /**
   * Push an audit record into the buffer. Returns immediately.
   *
   * A UUID is pre-generated so it can be shared with the SSE event bus
   * (via the onPush callback) and later reused at insert time.
   *
   * If the buffer reaches the configured threshold, a near-term async flush
   * is scheduled. This keeps request-path latency bounded even under bursty
   * write load.
   */
  push(record: Omit<AuditRecord, 'id' | 'created_at'>, id: string = randomUUID()): void {
    if (this.closed) return
    this.buffer.push({ id, record })
    this.onPush?.(record, id)
    if (this.buffer.length >= this.bufferSize) {
      this.scheduleFlushSoon()
    }
  }

  /**
   * Push a record and schedule a high-priority async flush.
   *
   * Security-critical records (deny, break-glass, rate/spend blocks) use this
   * path so they are persisted on the next tick without blocking the request.
   * A fatal-process crash still invokes the crash-drain hook, which calls
   * `flush()` synchronously before exit.
   */
  pushImmediate(record: Omit<AuditRecord, 'id' | 'created_at'>, id: string = randomUUID()): void {
    if (this.closed) return
    this.buffer.push({ id, record })
    this.onPush?.(record, id)
    this.scheduleFlushSoon()
  }

  /**
   * Schedule a flush on the next tick, coalescing multiple calls into one.
   */
  private scheduleFlushSoon(): void {
    if (this.closed || this.flushSoonTimer !== null) return
    this.flushSoonTimer = setTimeout(() => {
      this.flushSoonTimer = null
      if (this.buffer.length > 0) {
        this.flush()
      }
    }, 0)
    this.flushSoonTimer.unref()
  }

  /** Flush all buffered records to the store in a single transaction. */
  flush(): void {
    if (this.buffer.length === 0) return

    const entries = this.buffer
    this.buffer = []

    try {
      this.store.insertBatch(
        entries.map((e) => e.record),
        (_record, err) => {
          console.error('[helio] AuditWriter: failed to insert record:', err)
        },
        entries.map((e) => e.id),
        (record, id) => {
          this.onPersist?.(record, id)
        },
      )
    } catch (err) {
      // Transaction-level failure — log and continue
      console.error('[helio] AuditWriter: batch flush failed:', err)
    }
  }

  /** Flush remaining records, stop the timer, and close the underlying store. */
  close(): void {
    if (this.closed) return
    this.closed = true

    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.flushSoonTimer !== null) {
      clearTimeout(this.flushSoonTimer)
      this.flushSoonTimer = null
    }

    this.flush()
    this.store.close()
  }
}
