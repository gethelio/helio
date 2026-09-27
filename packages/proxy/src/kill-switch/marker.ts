import {
  closeSync,
  lstatSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import type { Stats } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { KillSwitch } from './state.js'

// ---------------------------------------------------------------------------
// The marker file (issue #402): `<config>.kill` beside the config, written
// through a temp file and a rename (a truncating write is read torn), read
// with `statSync(...).isFile()` (never `existsSync`, true for a directory),
// and polled about once a second off the request path. A dangling symlink,
// a directory at the path or a stat that throws keeps the last state, with
// one warning per face. No chokidar: the marker is created and removed by
// design, and the watcher mishandles exactly that.
// ---------------------------------------------------------------------------

/** The marker path: the config path as given, resolved absolute, plus `.kill`. */
export function markerPathFor(configPath: string): string {
  return `${resolve(configPath)}.kill`
}

/** The marker's one informational line; the proxy never reads it. */
export function markerNote(user: string, at: Date): string {
  return `killed at ${at.toISOString()} by ${user}\n`
}

type FsFailure = { readonly ok: false; readonly code: string; readonly message: string }

export type MarkerWriteResult = { readonly ok: true } | FsFailure

export type MarkerRemoveResult = { readonly ok: true; readonly removed: boolean } | FsFailure

function failure(err: unknown): FsFailure {
  const code = (err as NodeJS.ErrnoException).code ?? 'EUNKNOWN'
  const message = err instanceof Error ? err.message : String(err)
  return { ok: false, code, message }
}

/**
 * Write the marker atomically: `<dir>/.<base>.<pid>.tmp` opened `wx`, the
 * note written, then renamed into place. The write itself is the test of
 * whether this process can write the config directory.
 */
export function writeMarker(path: string, note: string): MarkerWriteResult {
  const temp = join(dirname(path), `.${basename(path)}.${String(process.pid)}.tmp`)
  const attempt = (): void => {
    const fd = openSync(temp, 'wx')
    try {
      writeSync(fd, note)
    } finally {
      closeSync(fd)
    }
    renameSync(temp, path)
  }
  try {
    try {
      attempt()
    } catch (err) {
      // A temp file left by a crashed writer with this pid: clear it once.
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      unlinkSync(temp)
      attempt()
    }
    return { ok: true }
  } catch (err) {
    try {
      unlinkSync(temp)
    } catch {
      // Nothing to clean up, or the directory refused that too.
    }
    return failure(err)
  }
}

/** Unlink the marker; an absent marker is `removed: false`, not a failure. */
export function removeMarker(path: string): MarkerRemoveResult {
  try {
    unlinkSync(path)
    return { ok: true, removed: true }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, removed: false }
    return failure(err)
  }
}

// ---------------------------------------------------------------------------
// The poller
// ---------------------------------------------------------------------------

export interface MarkerPollerOptions {
  /** Read interval in ms. Default 1000: the marker is seen within about a second. */
  readonly intervalMs?: number
  /** `statSync(path, { throwIfNoEntry: false })`, injectable for tests. */
  readonly stat?: (path: string) => Stats | undefined
  /** `lstatSync(path, { throwIfNoEntry: false })`, injectable for tests. */
  readonly lstat?: (path: string) => Stats | undefined
  /** Where the one-per-face warning goes. Defaults to stderr. */
  readonly warn?: (message: string) => void
}

const DEFAULT_INTERVAL_MS = 1_000

/**
 * Poll the marker and drive the switch's file hold. The constructor performs
 * the boot read, so a marker present at start kills before any door binds.
 */
export class MarkerPoller {
  readonly path: string
  private readonly state: KillSwitch
  private readonly stat: (path: string) => Stats | undefined
  private readonly lstat: (path: string) => Stats | undefined
  private readonly warn: (message: string) => void
  private readonly timer: ReturnType<typeof setInterval>
  private lastOddFace: string | undefined
  private closed = false

  constructor(path: string, state: KillSwitch, options: MarkerPollerOptions = {}) {
    this.path = path
    this.state = state
    this.stat = options.stat ?? ((p) => statSync(p, { throwIfNoEntry: false }))
    this.lstat = options.lstat ?? ((p) => lstatSync(p, { throwIfNoEntry: false }))
    this.warn =
      options.warn ??
      ((message) => {
        // eslint-disable-next-line no-console -- the operator's only channel for a marker the proxy cannot read
        console.error(message)
      })
    this.read(true)
    this.timer = setInterval(() => {
      this.read(false)
    }, options.intervalMs ?? DEFAULT_INTERVAL_MS)
    this.timer.unref()
  }

  /** True while the interval keeps the event loop alive (it never does). */
  hasRef(): boolean {
    return this.timer.hasRef()
  }

  close(): void {
    this.closed = true
    clearInterval(this.timer)
  }

  private read(atBoot: boolean): void {
    if (this.closed) return
    const face = this.classify()
    if (typeof face === 'object') {
      if (this.lastOddFace !== face.odd) {
        this.lastOddFace = face.odd
        this.warn(`[helio] Kill marker ${this.path} is ${face.odd}; keeping the last state`)
      }
      return
    }
    this.lastOddFace = undefined
    this.state.setFileHold(face === 'present', { surface: 'file', actor: null, atBoot })
  }

  private classify(): 'present' | 'absent' | { readonly odd: string } {
    try {
      const stats = this.stat(this.path)
      if (stats !== undefined)
        return stats.isFile() ? 'present' : { odd: 'a directory, not a file' }
      // Absent to stat: a dangling symlink stats the same way, told apart by lstat.
      let link: Stats | undefined
      try {
        link = this.lstat(this.path)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
        link = undefined
      }
      if (link === undefined) return 'absent'
      return link.isSymbolicLink() ? { odd: 'a dangling symlink' } : 'absent'
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? 'EUNKNOWN'
      return { odd: `unreadable (${code})` }
    }
  }
}
