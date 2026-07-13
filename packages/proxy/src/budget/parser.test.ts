import { describe, it, expect } from 'vitest'
import { compileBudgets, BudgetParseError } from './parser.js'
import type { BudgetConfig } from '../config/schema.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function budgetConfig(overrides: Partial<BudgetConfig> = {}): BudgetConfig {
  return {
    name: 'daily-cap',
    limit: 50,
    currency: 'USD',
    window: '24h',
    key: 'global',
    on_exceed: 'deny',
    contributors: [{ tool: 'stripe_*', field: '$.amount' }],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// compileBudgets
// ---------------------------------------------------------------------------

describe('compileBudgets', () => {
  it('compiles a duration window to milliseconds', () => {
    const [budget] = compileBudgets([budgetConfig({ window: '1h' })])
    expect(budget?.window).toEqual({ kind: 'duration', windowMs: 3_600_000 })
    expect(budget?.windowRaw).toBe('1h')
  })

  it('compiles a session window with the default 24h idle TTL', () => {
    const [budget] = compileBudgets([budgetConfig({ window: 'session', key: 'session' })])
    expect(budget?.window).toEqual({ kind: 'session', idleTtlMs: 86_400_000 })
  })

  it('honors an explicit idle_ttl on session windows', () => {
    const [budget] = compileBudgets([
      budgetConfig({ window: 'session', key: 'session', idle_ttl: '12h' }),
    ])
    expect(budget?.window).toEqual({ kind: 'session', idleTtlMs: 43_200_000 })
  })

  it('carries name, limit, currency, key, and on_exceed through', () => {
    const [budget] = compileBudgets([budgetConfig()])
    expect(budget?.name).toBe('daily-cap')
    expect(budget?.limit).toBe(50)
    expect(budget?.currency).toBe('USD')
    expect(budget?.key).toBe('global')
    expect(budget?.onExceed).toBe('deny')
  })

  it('compiles contributor globs with the policy matcher semantics', () => {
    const [budget] = compileBudgets([
      budgetConfig({
        contributors: [
          { tool: 'stripe_*', field: '$.amount' },
          { tool: 'paypal_*', field: '$.total' },
        ],
      }),
    ])
    expect(budget?.contributors).toHaveLength(2)
    expect(budget?.contributors[0]?.tool.test('stripe_charge')).toBe(true)
    expect(budget?.contributors[0]?.tool.test('paypal_send')).toBe(false)
    expect(budget?.contributors[0]?.field).toBe('$.amount')
    expect(budget?.contributors[1]?.tool.pattern).toBe('paypal_*')
  })

  it('compiles exotic patterns to matchers rather than throwing (picomatch is total)', () => {
    const [budget] = compileBudgets([budgetConfig({ contributors: [{ tool: '[', field: '$.x' }] })])
    expect(budget?.contributors[0]?.tool.test('anything')).toBe(false)
  })

  it('BudgetParseError names the offending budget', () => {
    const err = new BudgetParseError('invalid contributor glob "x": boom', 'daily-cap')
    expect(err.message).toContain('daily-cap')
    expect(err.budgetName).toBe('daily-cap')
  })

  it('compiles an empty list to an empty list', () => {
    expect(compileBudgets([])).toEqual([])
  })

  describe('break-glass approval (on_exceed: require_approval)', () => {
    it('carries on_exceed: require_approval through', () => {
      const [budget] = compileBudgets([budgetConfig({ on_exceed: 'require_approval' })])
      expect(budget?.onExceed).toBe('require_approval')
    })

    it('compiles the approval block with durations as milliseconds', () => {
      const [budget] = compileBudgets([
        budgetConfig({
          on_exceed: 'require_approval',
          approval: {
            channel: 'oncall',
            timeout: '120s',
            delegates: ['dashboard'],
            escalation_after: '60s',
          },
        }),
      ])
      expect(budget?.approval).toEqual({
        channel: 'oncall',
        timeoutMs: 120_000,
        delegates: ['dashboard'],
        escalationAfterMs: 60_000,
      })
    })

    it('leaves approval undefined when the config omits it', () => {
      const [budget] = compileBudgets([budgetConfig({ on_exceed: 'require_approval' })])
      expect(budget?.approval).toBeUndefined()
    })
  })
})
