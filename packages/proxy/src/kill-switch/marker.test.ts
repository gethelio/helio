import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import type { Stats } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { KillSwitch } from './state.js'
import { MarkerPoller, markerNote, markerPathFor, removeMarker, writeMarker } from './marker.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const dirs: string[] = []

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'helio-kill-marker-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  vi.useRealTimers()
  for (const dir of dirs.splice(0)) {
    chmodSync(dir, 0o755)
    rmSync(dir, { recursive: true, force: true })
  }
})

/** A stat face the poller reads: `undefined` is absent, `throw` is an error, else a Stats-like. */
type Face =
  | { kind: 'file' }
  | { kind: 'absent' }
  | { kind: 'directory' }
  | { kind: 'dangling' }
  | { kind: 'throw'; code: string }

function fakeFs(initial: Face) {
  let face = initial
  const statsFor = (isFile: boolean, isSymlink = false): Stats =>
    ({ isFile: () => isFile, isSymbolicLink: () => isSymlink }) as unknown as Stats
  const err = (code: string) => Object.assign(new Error(code), { code })
  return {
    set: (next: Face) => {
      face = next
    },
    stat: (): Stats | undefined => {
      switch (face.kind) {
        case 'file':
          return statsFor(true)
        case 'directory':
          return statsFor(false)
        case 'absent':
        case 'dangling':
          return undefined
        case 'throw':
          throw err(face.code)
      }
    },
    lstat: (): Stats | undefined => {
      switch (face.kind) {
        case 'file':
          return statsFor(true)
        case 'directory':
          return statsFor(false)
        case 'absent':
          throw err('ENOENT')
        case 'dangling':
          return statsFor(false, true)
        case 'throw':
          throw err(face.code)
      }
    },
  }
}

function poller(initial: Face) {
  const fs = fakeFs(initial)
  const state = new KillSwitch()
  const warnings: string[] = []
  const edges: boolean[] = []
  state.onChange((change) => edges.push(change.killed))
  const p = new MarkerPoller('/etc/helio/helio.yaml.kill', state, {
    intervalMs: 1_000,
    stat: fs.stat,
    lstat: fs.lstat,
    warn: (message) => warnings.push(message),
  })
  return { fs, state, warnings, edges, poller: p }
}

// ---------------------------------------------------------------------------
// The path and the write
// ---------------------------------------------------------------------------

describe('markerPathFor', () => {
  it('is the config path, resolved absolute, plus .kill', () => {
    expect(markerPathFor('/etc/helio/helio.yaml')).toBe('/etc/helio/helio.yaml.kill')
    expect(markerPathFor('helio.yaml')).toBe(resolve('helio.yaml') + '.kill')
    expect(markerPathFor('./demo/helio-demo.yaml')).toBe(resolve('demo/helio-demo.yaml') + '.kill')
  })
})

describe('markerNote', () => {
  it('is one line naming the instant and the user', () => {
    expect(markerNote('oli', new Date('2026-09-26T12:27:03.000Z'))).toBe(
      'killed at 2026-09-26T12:27:03.000Z by oli\n',
    )
  })
})

describe('writeMarker', () => {
  it('writes the note through a temp file and a rename, leaving no temp file behind', () => {
    const dir = scratch()
    const path = join(dir, 'helio.yaml.kill')
    const result = writeMarker(path, 'killed at 2026-09-26T12:27:03.000Z by oli\n')
    expect(result).toEqual({ ok: true })
    expect(statSync(path).isFile()).toBe(true)
    expect(readFileSync(path, 'utf-8')).toBe('killed at 2026-09-26T12:27:03.000Z by oli\n')
    expect(readdirSync(dir)).toEqual(['helio.yaml.kill'])
  })

  it('replaces an existing marker atomically', () => {
    const dir = scratch()
    const path = join(dir, 'helio.yaml.kill')
    writeFileSync(path, 'old\n')
    expect(writeMarker(path, 'new\n')).toEqual({ ok: true })
    expect(readFileSync(path, 'utf-8')).toBe('new\n')
    expect(readdirSync(dir)).toEqual(['helio.yaml.kill'])
  })

  it('answers EACCES without a throw when the directory is not writable', () => {
    const dir = scratch()
    chmodSync(dir, 0o555)
    const result = writeMarker(join(dir, 'helio.yaml.kill'), 'x\n')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('EACCES')
      expect(result.message).toContain('EACCES')
    }
    expect(readdirSync(dir)).toEqual([])
  })

  it('answers ENOENT when the parent directory is missing', () => {
    const dir = scratch()
    const result = writeMarker(join(dir, 'missing', 'helio.yaml.kill'), 'x\n')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('ENOENT')
  })
})

describe('removeMarker', () => {
  it('removes a present marker and reports it', () => {
    const dir = scratch()
    const path = join(dir, 'helio.yaml.kill')
    writeFileSync(path, 'x\n')
    expect(removeMarker(path)).toEqual({ ok: true, removed: true })
    expect(readdirSync(dir)).toEqual([])
  })

  it('treats an absent marker as removed: false, not a failure', () => {
    const dir = scratch()
    expect(removeMarker(join(dir, 'helio.yaml.kill'))).toEqual({ ok: true, removed: false })
  })

  it('answers EACCES without a throw when the directory forbids the unlink', () => {
    const dir = scratch()
    const path = join(dir, 'helio.yaml.kill')
    writeFileSync(path, 'x\n')
    chmodSync(dir, 0o555)
    const result = removeMarker(path)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('EACCES')
    chmodSync(dir, 0o755)
    expect(readdirSync(dir)).toEqual(['helio.yaml.kill'])
  })
})

// ---------------------------------------------------------------------------
// The poller
// ---------------------------------------------------------------------------

describe('MarkerPoller', () => {
  it('reads once at construction: a present file is the boot kill', () => {
    vi.useFakeTimers()
    const { state, edges, poller: p } = poller({ kind: 'file' })
    expect(state.killed).toBe(true)
    expect(state.snapshot()).toMatchObject({ durable: true, surface: 'file' })
    expect(edges).toEqual([true])
    p.close()
  })

  it('marks the boot read at_boot and later reads not', () => {
    vi.useFakeTimers()
    const fs = fakeFs({ kind: 'file' })
    const state = new KillSwitch()
    const triggers: Array<{ killed: boolean; at_boot: boolean }> = []
    state.onChange((c) => triggers.push({ killed: c.killed, at_boot: c.trigger.at_boot }))
    const p = new MarkerPoller('/x/helio.yaml.kill', state, {
      intervalMs: 1_000,
      stat: fs.stat,
      lstat: fs.lstat,
      warn: () => {},
    })
    fs.set({ kind: 'absent' })
    vi.advanceTimersByTime(1_000)
    fs.set({ kind: 'file' })
    vi.advanceTimersByTime(1_000)
    expect(triggers).toEqual([
      { killed: true, at_boot: true },
      { killed: false, at_boot: false },
      { killed: true, at_boot: false },
    ])
    p.close()
  })

  it('sets and lifts the file hold as the file appears and disappears, about once a second', () => {
    vi.useFakeTimers()
    const { fs, state, edges, poller: p } = poller({ kind: 'absent' })
    expect(state.killed).toBe(false)
    fs.set({ kind: 'file' })
    vi.advanceTimersByTime(999)
    expect(state.killed).toBe(false)
    vi.advanceTimersByTime(1)
    expect(state.killed).toBe(true)
    fs.set({ kind: 'absent' })
    vi.advanceTimersByTime(1_000)
    expect(state.killed).toBe(false)
    expect(edges).toEqual([true, false])
    p.close()
  })

  it('never lifts a memory hold: a deleted marker leaves an env hold killed', () => {
    vi.useFakeTimers()
    const { fs, state, poller: p } = poller({ kind: 'file' })
    state.setMemoryHold(true, 'env', { actor: null, atBoot: true })
    fs.set({ kind: 'absent' })
    vi.advanceTimersByTime(1_000)
    expect(state.killed).toBe(true)
    expect(state.snapshot()).toMatchObject({ surface: 'env', durable: false })
    p.close()
  })

  it('keeps the last state on a dangling symlink and warns once until the face changes', () => {
    vi.useFakeTimers()
    const { fs, state, warnings, poller: p } = poller({ kind: 'file' })
    fs.set({ kind: 'dangling' })
    vi.advanceTimersByTime(3_000)
    expect(state.killed).toBe(true)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('/etc/helio/helio.yaml.kill')
    expect(warnings[0]).toContain('dangling symlink')
    fs.set({ kind: 'absent' })
    vi.advanceTimersByTime(1_000)
    expect(state.killed).toBe(false)
    fs.set({ kind: 'dangling' })
    vi.advanceTimersByTime(1_000)
    expect(state.killed).toBe(false)
    expect(warnings).toHaveLength(2)
    p.close()
  })

  it('keeps the last state on a directory at the path and warns once', () => {
    vi.useFakeTimers()
    const { fs, state, warnings, poller: p } = poller({ kind: 'absent' })
    fs.set({ kind: 'directory' })
    vi.advanceTimersByTime(5_000)
    expect(state.killed).toBe(false)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('directory')
    p.close()
  })

  it('keeps the last state when the stat throws and names the code once', () => {
    vi.useFakeTimers()
    const { fs, state, warnings, poller: p } = poller({ kind: 'file' })
    fs.set({ kind: 'throw', code: 'EACCES' })
    vi.advanceTimersByTime(4_000)
    expect(state.killed).toBe(true)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('EACCES')
    fs.set({ kind: 'throw', code: 'EIO' })
    vi.advanceTimersByTime(1_000)
    expect(warnings).toHaveLength(2)
    expect(warnings[1]).toContain('EIO')
    p.close()
  })

  it('a throw on the boot read keeps the not-killed initial state', () => {
    vi.useFakeTimers()
    const { state, warnings, poller: p } = poller({ kind: 'throw', code: 'EACCES' })
    expect(state.killed).toBe(false)
    expect(warnings).toHaveLength(1)
    p.close()
  })

  it('stops reading after close', () => {
    vi.useFakeTimers()
    const { fs, state, poller: p } = poller({ kind: 'absent' })
    p.close()
    fs.set({ kind: 'file' })
    vi.advanceTimersByTime(5_000)
    expect(state.killed).toBe(false)
  })

  it('does not hold the event loop open (the interval is unref-ed)', () => {
    const { poller: p } = poller({ kind: 'absent' })
    expect(p.hasRef()).toBe(false)
    p.close()
  })

  it('reads the real filesystem when no seams are injected', () => {
    vi.useFakeTimers()
    const dir = scratch()
    const path = join(dir, 'helio.yaml.kill')
    mkdirSync(join(dir, 'unused'))
    const state = new KillSwitch()
    const p = new MarkerPoller(path, state, { intervalMs: 1_000, warn: () => {} })
    expect(state.killed).toBe(false)
    writeFileSync(path, 'x\n')
    vi.advanceTimersByTime(1_000)
    expect(state.killed).toBe(true)
    rmSync(path)
    symlinkSync(join(dir, 'gone'), path)
    vi.advanceTimersByTime(1_000)
    expect(state.killed).toBe(true)
    rmSync(path)
    vi.advanceTimersByTime(1_000)
    expect(state.killed).toBe(false)
    p.close()
  })
})
