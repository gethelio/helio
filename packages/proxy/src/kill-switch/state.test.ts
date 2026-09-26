import { describe, it, expect } from 'vitest'
import { KillSwitch, readKillSwitchEnv, KILL_SWITCH_ENV } from './state.js'
import type { KillSwitchChange } from './state.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSwitch(startMs = 1_700_000_000_000) {
  let time = startMs
  const state = new KillSwitch({ now: () => time })
  const changes: KillSwitchChange[] = []
  state.onChange((change) => changes.push(change))
  return { state, changes, advance: (ms: number) => (time += ms) }
}

// ---------------------------------------------------------------------------
// The two holds
// ---------------------------------------------------------------------------

describe('KillSwitch', () => {
  it('starts not killed with the cleared snapshot', () => {
    const { state } = makeSwitch()
    expect(state.killed).toBe(false)
    expect(state.fileHold).toBe(false)
    expect(state.memoryHold).toBe(false)
    expect(state.snapshot()).toEqual({ killed: false, durable: false, surface: null, since: null })
  })

  it('a file hold kills durably and fires one change with the trigger', () => {
    const { state, changes } = makeSwitch()
    const changed = state.setFileHold(true, { surface: 'file', actor: null, atBoot: true })
    expect(changed).toBe(true)
    expect(state.killed).toBe(true)
    expect(state.snapshot()).toEqual({
      killed: true,
      durable: true,
      surface: 'file',
      since: '2023-11-14T22:13:20.000Z',
    })
    expect(changes).toEqual([
      { killed: true, durable: true, trigger: { surface: 'file', actor: null, at_boot: true } },
    ])
  })

  it('a memory hold kills memory-only under its own surface', () => {
    const { state, changes } = makeSwitch()
    state.setMemoryHold(true, 'env', { actor: null, atBoot: true })
    expect(state.snapshot()).toEqual({
      killed: true,
      durable: false,
      surface: 'env',
      since: '2023-11-14T22:13:20.000Z',
    })
    expect(changes).toEqual([
      { killed: true, durable: false, trigger: { surface: 'env', actor: null, at_boot: true } },
    ])
  })

  it('fires once per killed edge, not once per setter', () => {
    const { state, changes } = makeSwitch()
    state.setFileHold(true, { surface: 'file', actor: null, atBoot: false })
    state.setFileHold(true, { surface: 'file', actor: null, atBoot: false })
    state.setMemoryHold(true, 'env', { actor: null, atBoot: false })
    expect(changes).toHaveLength(1)
    state.setFileHold(false, { surface: 'file', actor: null, atBoot: false })
    expect(state.killed).toBe(true)
    expect(changes).toHaveLength(1)
    state.setMemoryHold(false, 'env', { actor: null, atBoot: false })
    expect(state.killed).toBe(false)
    expect(changes).toHaveLength(2)
    // The halt lifted here was memory-only by then: the file hold had gone.
    expect(changes[1]).toEqual({
      killed: false,
      durable: false,
      trigger: { surface: 'env', actor: null, at_boot: false },
    })
  })

  it('recomputes the snapshot on every setter: env plus file, then the file lifts, reads env and memory-only', () => {
    const { state, advance } = makeSwitch()
    state.setMemoryHold(true, 'env', { actor: null, atBoot: true })
    advance(60_000)
    state.setFileHold(true, { surface: 'file', actor: null, atBoot: false })
    expect(state.snapshot()).toEqual({
      killed: true,
      durable: true,
      surface: 'file',
      since: '2023-11-14T22:13:20.000Z',
    })
    state.setFileHold(false, { surface: 'file', actor: null, atBoot: false })
    expect(state.killed).toBe(true)
    expect(state.snapshot()).toEqual({
      killed: true,
      durable: false,
      surface: 'env',
      since: '2023-11-14T22:13:20.000Z',
    })
  })

  it('an api memory hold survives a marker that a poll later sets and lifts', () => {
    const { state } = makeSwitch()
    state.setMemoryHold(true, 'api', { actor: 'alice', atBoot: false })
    state.setFileHold(true, { surface: 'file', actor: null, atBoot: false })
    expect(state.snapshot().surface).toBe('file')
    expect(state.snapshot().durable).toBe(true)
    state.setFileHold(false, { surface: 'file', actor: null, atBoot: false })
    expect(state.snapshot()).toMatchObject({ killed: true, surface: 'api', durable: false })
  })

  it('clears surface, durable and since when both holds clear, and takes a fresh since on the next kill', () => {
    const { state, advance } = makeSwitch()
    state.setFileHold(true, { surface: 'api', actor: 'bearer', atBoot: false })
    state.setFileHold(false, { surface: 'api', actor: 'bearer', atBoot: false })
    expect(state.snapshot()).toEqual({ killed: false, durable: false, surface: null, since: null })
    advance(5_000)
    state.setFileHold(true, { surface: 'file', actor: null, atBoot: false })
    expect(state.snapshot().since).toBe('2023-11-14T22:13:25.000Z')
  })

  it('carries the trigger actor and surface of the setter that flipped the edge', () => {
    const { state, changes } = makeSwitch()
    state.setFileHold(true, { surface: 'api', actor: 'alice', atBoot: false })
    expect(changes[0]).toEqual({
      killed: true,
      durable: true,
      trigger: { surface: 'api', actor: 'alice', at_boot: false },
    })
    expect(state.snapshot().surface).toBe('file')
    state.setFileHold(false, { surface: 'file', actor: null, atBoot: false })
    // A resume edge reports whether the halt it lifted was file-backed.
    expect(changes[1]).toEqual({
      killed: false,
      durable: true,
      trigger: { surface: 'file', actor: null, at_boot: false },
    })
  })

  it('unsubscribes a listener', () => {
    const { state, changes } = makeSwitch()
    const seen: boolean[] = []
    const off = state.onChange((change) => seen.push(change.killed))
    off()
    state.setFileHold(true, { surface: 'file', actor: null, atBoot: false })
    expect(seen).toEqual([])
    expect(changes).toHaveLength(1)
  })

  it('a listener that throws does not stop the others or the state', () => {
    const { state, changes } = makeSwitch()
    state.onChange(() => {
      throw new Error('boom')
    })
    const after: boolean[] = []
    state.onChange((change) => after.push(change.killed))
    expect(() =>
      state.setFileHold(true, { surface: 'file', actor: null, atBoot: false }),
    ).not.toThrow()
    expect(state.killed).toBe(true)
    expect(after).toEqual([true])
    expect(changes).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// The environment variable
// ---------------------------------------------------------------------------

describe('readKillSwitchEnv', () => {
  it('names the variable', () => {
    expect(KILL_SWITCH_ENV).toBe('HELIO_KILL_SWITCH')
  })

  it('is unset when the variable is absent', () => {
    expect(readKillSwitchEnv({})).toEqual({ status: 'unset' })
  })

  it('is set only for exactly 1', () => {
    expect(readKillSwitchEnv({ HELIO_KILL_SWITCH: '1' })).toEqual({ status: 'set' })
  })

  it('is invalid for anything else, the empty string included', () => {
    for (const raw of ['', '0', 'true', 'false', ' 1', '1 ', 'yes', 'abc']) {
      expect(readKillSwitchEnv({ HELIO_KILL_SWITCH: raw }), JSON.stringify(raw)).toEqual({
        status: 'invalid',
        raw,
      })
    }
  })
})
