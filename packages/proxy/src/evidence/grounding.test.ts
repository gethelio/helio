import { describe, it, expect } from 'vitest'
import { EvidenceStore } from './store.js'
import { checkEvidence, checkDependencies } from './grounding.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createStore(options?: { ttl?: number }) {
  let time = 1_000_000
  const store = new EvidenceStore({
    defaultTtlSeconds: options?.ttl ?? 300,
    cleanupIntervalMs: 0,
    now: () => time,
  })
  const advance = (ms: number) => {
    time += ms
  }
  return { store, advance }
}

// ---------------------------------------------------------------------------
// checkEvidence
// ---------------------------------------------------------------------------

describe('checkEvidence', () => {
  it('returns satisfied when all evidence is present', () => {
    const { store } = createStore()
    store.putEvidence('s1', { evidence_key: 'orders.lookup', data: {}, tool_name: 't' })
    store.putEvidence('s1', { evidence_key: 'customer.verify', data: {}, tool_name: 't' })

    const result = checkEvidence(store, 's1', ['orders.lookup', 'customer.verify'])

    expect(result.satisfied).toBe(true)
    expect(result.found).toEqual(['orders.lookup', 'customer.verify'])
    expect(result.missing).toEqual([])
    expect(result.expired).toEqual([])
  })

  it('reports missing evidence', () => {
    const { store } = createStore()
    store.putEvidence('s1', { evidence_key: 'orders.lookup', data: {}, tool_name: 't' })

    const result = checkEvidence(store, 's1', ['orders.lookup', 'customer.verify'])

    expect(result.satisfied).toBe(false)
    expect(result.found).toEqual(['orders.lookup'])
    expect(result.missing).toEqual(['customer.verify'])
    expect(result.expired).toEqual([])
  })

  it('reports expired evidence separately from missing', () => {
    const { store, advance } = createStore({ ttl: 1 })
    store.putEvidence('s1', { evidence_key: 'old', data: {}, tool_name: 't' })

    advance(2_000) // past TTL

    const result = checkEvidence(store, 's1', ['old', 'never_stored'])

    expect(result.satisfied).toBe(false)
    expect(result.found).toEqual([])
    expect(result.expired).toEqual(['old'])
    expect(result.missing).toEqual(['never_stored'])
  })

  it('handles mix of found, missing, and expired', () => {
    const { store, advance } = createStore({ ttl: 300 })
    store.putEvidence('s1', { evidence_key: 'valid', data: {}, tool_name: 't', ttl_seconds: 600 })
    store.putEvidence('s1', { evidence_key: 'expired', data: {}, tool_name: 't', ttl_seconds: 1 })

    advance(2_000)

    const result = checkEvidence(store, 's1', ['valid', 'expired', 'absent'])

    expect(result.satisfied).toBe(false)
    expect(result.found).toEqual(['valid'])
    expect(result.expired).toEqual(['expired'])
    expect(result.missing).toEqual(['absent'])
  })

  it('returns satisfied for empty requirements', () => {
    const { store } = createStore()
    const result = checkEvidence(store, 's1', [])

    expect(result.satisfied).toBe(true)
    expect(result.found).toEqual([])
    expect(result.missing).toEqual([])
    expect(result.expired).toEqual([])
  })

  it('treats unknown session as all missing', () => {
    const { store } = createStore()
    const result = checkEvidence(store, 'nonexistent', ['orders.lookup', 'customer.verify'])

    expect(result.satisfied).toBe(false)
    expect(result.missing).toEqual(['orders.lookup', 'customer.verify'])
    expect(result.found).toEqual([])
    expect(result.expired).toEqual([])
  })

  it('single requirement satisfied', () => {
    const { store } = createStore()
    store.putEvidence('s1', { evidence_key: 'key', data: 'val', tool_name: 't' })

    const result = checkEvidence(store, 's1', ['key'])

    expect(result.satisfied).toBe(true)
    expect(result.found).toEqual(['key'])
  })

  it('single requirement expired', () => {
    const { store, advance } = createStore({ ttl: 1 })
    store.putEvidence('s1', { evidence_key: 'key', data: {}, tool_name: 't' })

    advance(2_000)

    const result = checkEvidence(store, 's1', ['key'])

    expect(result.satisfied).toBe(false)
    expect(result.expired).toEqual(['key'])
    expect(result.missing).toEqual([])
  })

  it('keeps expired classification after cleanup evicts live entries', () => {
    const { store, advance } = createStore({ ttl: 1 })
    store.putEvidence('s1', { evidence_key: 'key', data: {}, tool_name: 't' })

    advance(2_000)
    store.cleanup()

    const result = checkEvidence(store, 's1', ['key'])
    expect(result.satisfied).toBe(false)
    expect(result.expired).toEqual(['key'])
    expect(result.missing).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// checkDependencies
// ---------------------------------------------------------------------------

describe('checkDependencies', () => {
  it('returns satisfied when all dependencies are met by successful calls', () => {
    const { store } = createStore()
    store.recordToolCall('s1', 'orders.lookup', true)
    store.recordToolCall('s1', 'customer.verify', true)

    const result = checkDependencies(store, 's1', ['orders.lookup', 'customer.verify'])

    expect(result.satisfied).toBe(true)
    expect(result.missing).toEqual([])
  })

  it('reports missing dependencies', () => {
    const { store } = createStore()
    store.recordToolCall('s1', 'orders.lookup', true)

    const result = checkDependencies(store, 's1', ['orders.lookup', 'customer.verify'])

    expect(result.satisfied).toBe(false)
    expect(result.missing).toEqual(['customer.verify'])
  })

  it('returns satisfied for empty requirements', () => {
    const { store } = createStore()
    const result = checkDependencies(store, 's1', [])

    expect(result.satisfied).toBe(true)
    expect(result.missing).toEqual([])
  })

  it('treats unknown session as all missing', () => {
    const { store } = createStore()
    const result = checkDependencies(store, 'nonexistent', ['tool_a', 'tool_b'])

    expect(result.satisfied).toBe(false)
    expect(result.missing).toEqual(['tool_a', 'tool_b'])
  })

  it('failed tool call does not satisfy dependency by default', () => {
    const { store } = createStore()
    store.recordToolCall('s1', 'orders.lookup', false)

    const result = checkDependencies(store, 's1', ['orders.lookup'])

    expect(result.satisfied).toBe(false)
    expect(result.missing).toEqual(['orders.lookup'])
  })

  it('failed tool call satisfies dependency when requireSuccess is false', () => {
    const { store } = createStore()
    store.recordToolCall('s1', 'orders.lookup', false)

    const result = checkDependencies(store, 's1', ['orders.lookup'], { requireSuccess: false })

    expect(result.satisfied).toBe(true)
    expect(result.missing).toEqual([])
  })

  it('mixed success and failure: only successful calls satisfy the chain by default', () => {
    const { store } = createStore()
    store.recordToolCall('s1', 'orders.lookup', true)
    store.recordToolCall('s1', 'customer.verify', false)

    const result = checkDependencies(store, 's1', ['orders.lookup', 'customer.verify'])

    expect(result.satisfied).toBe(false)
    expect(result.missing).toEqual(['customer.verify'])
  })

  it('single dependency missing', () => {
    const { store } = createStore()

    const result = checkDependencies(store, 's1', ['orders.lookup'])

    expect(result.satisfied).toBe(false)
    expect(result.missing).toEqual(['orders.lookup'])
  })
})
