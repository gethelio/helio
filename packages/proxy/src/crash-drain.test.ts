import { describe, it, expect, beforeEach, vi } from 'vitest'
import { registerCrashDrainHook, drainForCrash, resetCrashDrainHooks } from './crash-drain.js'

describe('crash-drain', () => {
  beforeEach(() => {
    resetCrashDrainHooks()
  })

  it('runs all registered hooks in registration order', async () => {
    const calls: string[] = []
    registerCrashDrainHook(() => {
      calls.push('a')
    })
    registerCrashDrainHook(() => {
      calls.push('b')
    })

    await drainForCrash()

    expect(calls).toEqual(['a', 'b'])
  })

  it('catches synchronous errors thrown by a hook and still runs the rest', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const calls: string[] = []
    registerCrashDrainHook(() => {
      calls.push('a')
    })
    registerCrashDrainHook(() => {
      throw new Error('boom')
    })
    registerCrashDrainHook(() => {
      calls.push('c')
    })

    await drainForCrash()

    expect(calls).toEqual(['a', 'c'])
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('awaits async hooks and catches their rejections', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const calls: string[] = []
    registerCrashDrainHook(async () => {
      await Promise.resolve()
      calls.push('async-ok')
    })
    registerCrashDrainHook(async () => {
      await Promise.resolve()
      throw new Error('async-bad')
    })
    registerCrashDrainHook(() => {
      calls.push('sync-after')
    })

    await drainForCrash()

    expect(calls).toEqual(['async-ok', 'sync-after'])
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('resolves immediately when no hooks are registered', async () => {
    // Should not throw, should not hang
    await expect(drainForCrash()).resolves.toBeUndefined()
  })

  it('guards against re-entry — hooks only run once if drainForCrash is called twice', async () => {
    const calls: string[] = []
    registerCrashDrainHook(() => {
      calls.push('a')
    })
    registerCrashDrainHook(() => {
      calls.push('b')
    })

    await drainForCrash()
    await drainForCrash()

    expect(calls).toEqual(['a', 'b'])
  })
})
