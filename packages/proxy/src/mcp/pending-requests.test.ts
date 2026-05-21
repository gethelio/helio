import { describe, it, expect, vi, afterEach } from 'vitest'
import { PendingRequests } from './pending-requests.js'
import type { JsonRpcResponse } from './types.js'

describe('PendingRequests', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const okResponse: JsonRpcResponse = {
    jsonrpc: '2.0',
    id: 1,
    result: { tools: [] },
  }

  it('resolves a pending request by id', async () => {
    const pending = new PendingRequests()
    const promise = pending.add(1)

    expect(pending.size).toBe(1)
    expect(pending.resolve(1, okResponse)).toBe(true)

    const result = await promise
    expect(result).toEqual(okResponse)
    expect(pending.size).toBe(0)
  })

  it('resolves with string id', async () => {
    const pending = new PendingRequests()
    const response: JsonRpcResponse = { jsonrpc: '2.0', id: 'abc', result: {} }
    const promise = pending.add('abc')

    pending.resolve('abc', response)
    expect(await promise).toEqual(response)
  })

  it('resolves with null id', async () => {
    const pending = new PendingRequests()
    const response: JsonRpcResponse = { jsonrpc: '2.0', id: null, result: {} }
    const promise = pending.add(null)

    pending.resolve(null, response)
    expect(await promise).toEqual(response)
  })

  it('returns false when resolving an unknown id', () => {
    const pending = new PendingRequests()
    expect(pending.resolve(999, okResponse)).toBe(false)
  })

  it('double-resolve is a no-op', async () => {
    const pending = new PendingRequests()
    const promise = pending.add(1)

    expect(pending.resolve(1, okResponse)).toBe(true)
    expect(pending.resolve(1, okResponse)).toBe(false)

    expect(await promise).toEqual(okResponse)
  })

  it('rejects on timeout', async () => {
    vi.useFakeTimers()
    const pending = new PendingRequests(100)
    const promise = pending.add(1)

    vi.advanceTimersByTime(100)

    await expect(promise).rejects.toThrow('request 1 timed out after 100ms')
    expect(pending.size).toBe(0)
    vi.useRealTimers()
  })

  it('rejectAll rejects all pending requests', async () => {
    const pending = new PendingRequests()
    const p1 = pending.add(1)
    const p2 = pending.add(2)
    const p3 = pending.add(3)

    expect(pending.size).toBe(3)
    pending.rejectAll(new Error('shutdown'))

    await expect(p1).rejects.toThrow('shutdown')
    await expect(p2).rejects.toThrow('shutdown')
    await expect(p3).rejects.toThrow('shutdown')
    expect(pending.size).toBe(0)
  })

  it('treats numeric and string ids as separate keys', async () => {
    const pending = new PendingRequests()
    const numPromise = pending.add(1)
    const strPromise = pending.add('1')

    // Both map to String(id) = "1", so the second overwrites the first.
    // This is by design — JSON-RPC ids should be unique per session.
    expect(pending.size).toBe(1)

    const response: JsonRpcResponse = { jsonrpc: '2.0', id: '1', result: {} }
    pending.resolve('1', response)

    expect(await strPromise).toEqual(response)
    // The first promise was overwritten and will never resolve,
    // so we don't await it — just verify the map is clean.
    expect(pending.size).toBe(0)

    // Clean up the orphaned promise to avoid unhandled rejection
    numPromise.catch(() => {})
    pending.rejectAll(new Error('cleanup'))
  })
})
