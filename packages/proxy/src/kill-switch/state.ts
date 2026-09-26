// ---------------------------------------------------------------------------
// The kill switch (issue #402): one state object, two holds.
//
// `killed = fileHold || memoryHold`. The file hold mirrors the marker file
// beside the config (`<config>.kill`): the poller sets it, and an endpoint
// kill whose marker write succeeded sets it too, so `helio resume`, a hand
// deletion and `DELETE /api/kill-switch` are one and the same resume. The
// memory hold is what `HELIO_KILL_SWITCH=1` and an endpoint kill that could
// not write the marker take: a halt with no file, which no file deletion can
// lift. Every setter recomputes the snapshot; listeners fire once per change
// of `killed`. The doors read `killed` per call: a boolean field, never a
// stat.
// ---------------------------------------------------------------------------

/** The boot input that starts a process killed with no marker. */
export const KILL_SWITCH_ENV = 'HELIO_KILL_SWITCH'

/** Where a kill or a resume came from. */
export type KillSurface = 'file' | 'env' | 'api'

/** The surfaces a memory hold can carry. */
export type MemorySurface = 'env' | 'api'

/** What flipped the switch, as the audit record and the wire line name it. */
export interface KillTrigger {
  readonly surface: KillSurface
  /** The credential or body actor behind an api trigger; null for the file and the variable. */
  readonly actor: string | null
  /** True when the edge fired from the boot read or the boot variable. */
  readonly at_boot: boolean
}

/** One change of `killed`, delivered to every listener. */
export interface KillSwitchChange {
  readonly killed: boolean
  /**
   * Whether a marker backs the halt: for a kill, the new state; for a
   * resume, the state of the halt that was lifted.
   */
  readonly durable: boolean
  readonly trigger: KillTrigger
}

/** The state the status report and the endpoint read. */
export interface KillSwitchSnapshot {
  readonly killed: boolean
  /** True when the marker file backs the halt. */
  readonly durable: boolean
  /** `file` when the file hold is set, else the memory hold's surface; null when not killed. */
  readonly surface: KillSurface | null
  /** The instant `killed` last became true, ISO 8601; null when not killed. */
  readonly since: string | null
}

export interface KillSwitchOptions {
  /** Clock for testable time. Defaults to Date.now. */
  readonly now?: () => number
}

/** What a setter records about the edge it may fire. */
interface SetterTrigger {
  readonly actor: string | null
  readonly atBoot: boolean
}

export type KillSwitchListener = (change: KillSwitchChange) => void

export class KillSwitch {
  private fileHeld = false
  private memoryHeld = false
  private memorySurfaceValue: MemorySurface | null = null
  private sinceValue: string | null = null
  private readonly listeners = new Set<KillSwitchListener>()
  private readonly now: () => number

  constructor(options?: KillSwitchOptions) {
    this.now = options?.now ?? Date.now
  }

  /** The per-call read: true while either hold is set. */
  get killed(): boolean {
    return this.fileHeld || this.memoryHeld
  }

  get fileHold(): boolean {
    return this.fileHeld
  }

  get memoryHold(): boolean {
    return this.memoryHeld
  }

  /** The memory hold's own surface, kept so a lifted file hold restores it. */
  get memorySurface(): MemorySurface | null {
    return this.memorySurfaceValue
  }

  snapshot(): KillSwitchSnapshot {
    if (!this.killed) return { killed: false, durable: false, surface: null, since: null }
    return {
      killed: true,
      durable: this.fileHeld,
      surface: this.fileHeld ? 'file' : this.memorySurfaceValue,
      since: this.sinceValue,
    }
  }

  /**
   * Set or clear the file hold. The poller passes surface `file`; an
   * endpoint kill whose marker write succeeded passes `api`.
   * @returns whether `killed` changed.
   */
  setFileHold(present: boolean, trigger: SetterTrigger & { surface: 'file' | 'api' }): boolean {
    return this.apply(
      () => {
        this.fileHeld = present
      },
      { surface: trigger.surface, actor: trigger.actor, at_boot: trigger.atBoot },
    )
  }

  /**
   * Set or clear the memory hold under its surface (`env` at boot, `api`
   * for an endpoint kill that could not write the marker).
   * @returns whether `killed` changed.
   */
  setMemoryHold(on: boolean, surface: MemorySurface, trigger: SetterTrigger): boolean {
    return this.apply(
      () => {
        this.memoryHeld = on
        this.memorySurfaceValue = on ? surface : null
      },
      { surface, actor: trigger.actor, at_boot: trigger.atBoot },
    )
  }

  /** Subscribe to changes of `killed`; returns the unsubscribe function. */
  onChange(listener: KillSwitchListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private apply(mutate: () => void, trigger: KillTrigger): boolean {
    const before = this.killed
    const durableBefore = this.fileHeld
    mutate()
    const after = this.killed
    if (before === after) return false
    if (after) {
      this.sinceValue = new Date(this.now()).toISOString()
    } else {
      this.sinceValue = null
    }
    const change: KillSwitchChange = {
      killed: after,
      durable: after ? this.fileHeld : durableBefore,
      trigger,
    }
    for (const listener of [...this.listeners]) {
      try {
        listener(change)
      } catch (err) {
        // eslint-disable-next-line no-console -- a listener failure must not stop the switch
        console.error('[helio] Kill switch listener failed:', err)
      }
    }
    return true
  }
}

// ---------------------------------------------------------------------------
// The environment variable
// ---------------------------------------------------------------------------

export type KillSwitchEnv =
  | { readonly status: 'unset' }
  | { readonly status: 'set' }
  | { readonly status: 'invalid'; readonly raw: string }

/**
 * Read `HELIO_KILL_SWITCH`: unset, exactly `1` (set), or anything else
 * (the empty string included) is invalid and refused before boot, on the
 * `HELIO_CONFIG_SHA256` precedent. Two spellings of off would invite a third.
 */
export function readKillSwitchEnv(
  env: Record<string, string | undefined> = process.env,
): KillSwitchEnv {
  const raw = env[KILL_SWITCH_ENV]
  if (raw === undefined) return { status: 'unset' }
  return raw === '1' ? { status: 'set' } : { status: 'invalid', raw }
}
