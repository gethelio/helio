import { describe, it, expect } from 'vitest'
import { DashboardSessionStore } from './session.js'

describe('DashboardSessionStore', () => {
  it('creates and validates a session token', () => {
    const store = new DashboardSessionStore({
      secret: 'test-secret',
      cleanupIntervalMs: 0,
    })

    const session = store.create()
    expect(session.token).toBeTruthy()
    expect(session.csrfToken).toBeTruthy()

    const validated = store.validate(session.token)
    expect(validated).toBeDefined()
    expect(validated?.csrfToken).toBe(session.csrfToken)
  })

  it('rejects tampered session tokens', () => {
    const store = new DashboardSessionStore({
      secret: 'test-secret',
      cleanupIntervalMs: 0,
    })

    const session = store.create()
    const tampered = `${session.token}tampered`
    expect(store.validate(tampered)).toBeUndefined()
  })

  it('expires sessions based on ttl', () => {
    let now = 1_000
    const store = new DashboardSessionStore({
      secret: 'test-secret',
      ttlMs: 1_000,
      now: () => now,
      cleanupIntervalMs: 0,
    })

    const session = store.create()
    expect(store.validate(session.token)).toBeDefined()

    now += 1_001
    expect(store.validate(session.token)).toBeUndefined()
  })

  it('revokes sessions explicitly', () => {
    const store = new DashboardSessionStore({
      secret: 'test-secret',
      cleanupIntervalMs: 0,
    })

    const session = store.create()
    expect(store.validate(session.token)).toBeDefined()

    store.revoke(session.token)
    expect(store.validate(session.token)).toBeUndefined()
  })
})
