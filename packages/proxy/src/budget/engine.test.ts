import { describe, it, expect, vi } from 'vitest'
import Database from 'better-sqlite3'
import { BudgetEngine } from './engine.js'
import type { BudgetCommitEvent, BudgetLedgerSink, BudgetPersistence } from './engine.js'
import { BudgetLedger } from './ledger.js'
import { compileBudgets } from './parser.js'
import type { BudgetConfig } from '../config/schema.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function budgetConfig(overrides: Partial<BudgetConfig> = {}): BudgetConfig {
  return {
    name: 'daily-cap',
    limit: 100,
    currency: 'USD',
    window: '24h',
    key: 'global',
    on_exceed: 'deny',
    contributors: [{ tool: 'stripe_*', field: '$.amount' }],
    ...overrides,
  }
}

function createEngine(
  configs: BudgetConfig[],
  options: {
    ledger?: BudgetLedgerSink
    onCommit?: (event: BudgetCommitEvent) => void
  } = {},
) {
  let time = 1_000_000
  const advance = (ms: number) => {
    time += ms
  }
  const engine = new BudgetEngine({
    budgets: compileBudgets(configs),
    now: () => time,
    cleanupIntervalMs: 0,
    ...options,
  })
  return { engine, advance }
}

const COMMIT_META = {
  kind: 'spend' as const,
  auditRecordId: 'audit-1',
  origin: 'mcp',
  toolName: 'stripe_charge',
  timestampIso: '2026-07-09T12:00:00.000Z',
}

function chargeCtx(toolName: string, args: Record<string, unknown>, sessionId?: string) {
  return {
    toolName,
    toolArguments: args,
    sessionId: sessionId ?? null,
    senderId: null,
  }
}

// ---------------------------------------------------------------------------
// resolveCharges
// ---------------------------------------------------------------------------

describe('BudgetEngine.resolveCharges', () => {
  it('resolves a matching contributor into a charge with the extracted amount', () => {
    const { engine } = createEngine([budgetConfig()])
    const { charges, failures } = engine.resolveCharges(chargeCtx('stripe_charge', { amount: 25 }))

    expect(failures).toEqual([])
    expect(charges).toHaveLength(1)
    expect(charges[0]?.amount).toBe(25)
    expect(charges[0]?.bucketKey).toBe('budget:daily-cap:global')
  })

  it('returns no charges for tools no contributor matches', () => {
    const { engine } = createEngine([budgetConfig()])
    const { charges, failures } = engine.resolveCharges(chargeCtx('send_email', { amount: 25 }))

    expect(charges).toEqual([])
    expect(failures).toEqual([])
  })

  it('resolves every matching budget for one call', () => {
    const { engine } = createEngine([
      budgetConfig({ name: 'cap-a' }),
      budgetConfig({ name: 'cap-b', contributors: [{ tool: 'stripe_*', field: '$.amount' }] }),
    ])
    const { charges } = engine.resolveCharges(chargeCtx('stripe_charge', { amount: 10 }))
    expect(charges.map((c) => c.budget.name)).toEqual(['cap-a', 'cap-b'])
  })

  it('uses the first matching contributor when globs overlap', () => {
    const { engine } = createEngine([
      budgetConfig({
        contributors: [
          { tool: 'stripe_*', field: '$.amount' },
          { tool: 'stripe_charge', field: '$.total' },
        ],
      }),
    ])
    const { charges } = engine.resolveCharges(chargeCtx('stripe_charge', { amount: 5, total: 999 }))
    expect(charges[0]?.amount).toBe(5)
  })

  it('fails closed when the amount field is missing', () => {
    const { engine } = createEngine([budgetConfig()])
    const { charges, failures } = engine.resolveCharges(chargeCtx('stripe_charge', { other: 1 }))

    expect(charges).toEqual([])
    expect(failures).toHaveLength(1)
    expect(failures[0]?.reason).toBe('invalid_amount')
  })

  it.each([
    ['NaN', NaN],
    ['negative', -5],
    ['Infinity', Infinity],
    ['string', '5' as unknown],
  ])('fails closed on a %s amount', (_label, amount) => {
    const { engine } = createEngine([budgetConfig()])
    const { charges, failures } = engine.resolveCharges(chargeCtx('stripe_charge', { amount }))
    expect(charges).toEqual([])
    expect(failures).toHaveLength(1)
  })

  it('builds session bucket keys with the session id and pools unknowns', () => {
    const { engine } = createEngine([
      budgetConfig({ name: 'sc', window: 'session', key: 'session' }),
    ])
    const withSession = engine.resolveCharges(chargeCtx('stripe_charge', { amount: 1 }, 's1'))
    const withoutSession = engine.resolveCharges(chargeCtx('stripe_charge', { amount: 1 }))

    expect(withSession.charges[0]?.bucketKey).toBe('budget:sc:session:s1')
    expect(withoutSession.charges[0]?.bucketKey).toBe('budget:sc:session:unknown')
  })

  it('builds sender bucket keys from senderId', () => {
    const { engine } = createEngine([budgetConfig({ name: 'sb', key: 'sender_id' })])
    const { charges } = engine.resolveCharges({
      toolName: 'stripe_charge',
      toolArguments: { amount: 1 },
      sessionId: null,
      senderId: 'U7',
    })
    expect(charges[0]?.bucketKey).toBe('budget:sb:sender:U7')
  })
})

// ---------------------------------------------------------------------------
// peekAll / recordAll
// ---------------------------------------------------------------------------

describe('BudgetEngine peek and record', () => {
  it('peek allows under the limit and never mutates', () => {
    const { engine } = createEngine([budgetConfig()])
    const { charges } = engine.resolveCharges(chargeCtx('stripe_charge', { amount: 60 }))

    const first = engine.peekAll(charges)
    const second = engine.peekAll(charges)

    expect(first.allowed).toBe(true)
    expect(first.entries[0]?.spent).toBe(0)
    expect(first.entries[0]?.remaining).toBe(100)
    expect(second.entries[0]?.spent).toBe(0)
  })

  it('record accumulates and a later peek that would exceed is denied', () => {
    const { engine } = createEngine([budgetConfig()])
    const spend = engine.resolveCharges(chargeCtx('stripe_charge', { amount: 60 }))
    engine.recordAll(spend.charges, COMMIT_META)

    const next = engine.resolveCharges(chargeCtx('stripe_charge', { amount: 50 }))
    const peek = engine.peekAll(next.charges)

    expect(peek.allowed).toBe(false)
    expect(peek.entries[0]?.spent).toBe(60)
    expect(peek.entries[0]?.remaining).toBe(40)
  })

  it('peekAll is all-or-nothing: one denying budget flips allowed', () => {
    const { engine } = createEngine([
      budgetConfig({ name: 'big', limit: 1000 }),
      budgetConfig({ name: 'small', limit: 10 }),
    ])
    const { charges } = engine.resolveCharges(chargeCtx('stripe_charge', { amount: 50 }))
    const peek = engine.peekAll(charges)

    expect(peek.allowed).toBe(false)
    expect(peek.entries.find((e) => e.budget.name === 'big')?.allowed).toBe(true)
    expect(peek.entries.find((e) => e.budget.name === 'small')?.allowed).toBe(false)
  })

  it('recordAll records on every matched budget together', () => {
    const { engine } = createEngine([budgetConfig({ name: 'a' }), budgetConfig({ name: 'b' })])
    const { charges } = engine.resolveCharges(chargeCtx('stripe_charge', { amount: 30 }))
    engine.recordAll(charges, COMMIT_META)

    const next = engine.resolveCharges(chargeCtx('stripe_charge', { amount: 1 }))
    const peek = engine.peekAll(next.charges)
    expect(peek.entries.map((e) => e.spent)).toEqual([30, 30])
  })

  it('recordAll can push past the limit (approved overage semantics)', () => {
    const { engine } = createEngine([budgetConfig({ limit: 50 })])
    const { charges } = engine.resolveCharges(chargeCtx('stripe_charge', { amount: 80 }))
    const snapshots = engine.recordAll(charges, COMMIT_META)

    expect(snapshots[0]?.spent).toBe(80)
    expect(snapshots[0]?.remaining).toBe(0)
  })

  it('duration windows replenish after the window slides', () => {
    const { engine, advance } = createEngine([budgetConfig({ window: '1h' })])
    const spend = engine.resolveCharges(chargeCtx('stripe_charge', { amount: 100 }))
    engine.recordAll(spend.charges, COMMIT_META)

    advance(3_600_001)

    const next = engine.resolveCharges(chargeCtx('stripe_charge', { amount: 100 }))
    expect(engine.peekAll(next.charges).allowed).toBe(true)
  })

  it('session pots never replenish on a timer', () => {
    const { engine, advance } = createEngine([
      budgetConfig({ name: 'sc', window: 'session', key: 'session' }),
    ])
    const spend = engine.resolveCharges(chargeCtx('stripe_charge', { amount: 100 }, 's1'))
    engine.recordAll(spend.charges, { ...COMMIT_META })

    advance(3_600_000 * 20) // well past any duration window, within idle TTL

    const next = engine.resolveCharges(chargeCtx('stripe_charge', { amount: 1 }, 's1'))
    expect(engine.peekAll(next.charges).allowed).toBe(false)
  })

  it('reports reset_at_ms for duration windows and null for session pots', () => {
    const { engine } = createEngine([
      budgetConfig({ name: 'd', window: '1h' }),
      budgetConfig({ name: 's', window: 'session', key: 'session' }),
    ])
    const spend = engine.resolveCharges(chargeCtx('stripe_charge', { amount: 10 }, 's1'))
    const snapshots = engine.recordAll(spend.charges, COMMIT_META)

    expect(snapshots.find((e) => e.budget.name === 'd')?.resetAtMs).toBe(1_000_000 + 3_600_000)
    expect(snapshots.find((e) => e.budget.name === 's')?.resetAtMs).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Ledger sink atomicity
// ---------------------------------------------------------------------------

describe('BudgetEngine ledger sink', () => {
  it('applies no in-memory state when the sink throws', () => {
    const throwingSink: BudgetLedgerSink = {
      commitAll: () => {
        throw new Error('disk full')
      },
    }
    const { engine } = createEngine([budgetConfig()], { ledger: throwingSink })
    const { charges } = engine.resolveCharges(chargeCtx('stripe_charge', { amount: 60 }))

    expect(() => engine.recordAll(charges, COMMIT_META)).toThrow('disk full')

    const peek = engine.peekAll(charges)
    expect(peek.entries[0]?.spent).toBe(0)
  })

  it('hands the sink one row per charge with the call metadata', () => {
    const rows: unknown[] = []
    const sink: BudgetLedgerSink = {
      commitAll: (batch) => {
        rows.push(...batch)
      },
    }
    const { engine } = createEngine([budgetConfig({ name: 'a' }), budgetConfig({ name: 'b' })], {
      ledger: sink,
    })
    const { charges } = engine.resolveCharges(chargeCtx('stripe_charge', { amount: 30 }))
    engine.recordAll(charges, COMMIT_META)

    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      budget_name: 'a',
      bucket_key: 'budget:a:global',
      kind: 'spend',
      amount: 30,
      currency: 'USD',
      tool_name: 'stripe_charge',
      origin: 'mcp',
      audit_record_id: 'audit-1',
      timestamp: '2026-07-09T12:00:00.000Z',
    })
  })

  it('applies per-budget kinds from the kinds map in one batch (break-glass)', () => {
    const rows: Array<Record<string, unknown>> = []
    const sink: BudgetLedgerSink = {
      commitAll: (batch) => {
        rows.push(...(batch as unknown as Array<Record<string, unknown>>))
      },
    }
    const events: BudgetCommitEvent[] = []
    const { engine } = createEngine(
      [budgetConfig({ name: 'small', limit: 10 }), budgetConfig({ name: 'big', limit: 1000 })],
      { ledger: sink, onCommit: (event) => events.push(event) },
    )
    const { charges } = engine.resolveCharges(chargeCtx('stripe_charge', { amount: 50 }))

    engine.recordAll(charges, {
      ...COMMIT_META,
      kinds: new Map([['small', 'approved_overage' as const]]),
    })

    // One transaction, mixed kinds: the breached budget's row is marked as an
    // approved overage while the unbreached one stays plain spend.
    expect(rows.map((row) => [row['budget_name'], row['kind']])).toEqual([
      ['small', 'approved_overage'],
      ['big', 'spend'],
    ])
    expect(events.map((event) => [event.name, event.kind])).toEqual([
      ['small', 'approved_overage'],
      ['big', 'spend'],
    ])
  })
})

// ---------------------------------------------------------------------------
// Commit events
// ---------------------------------------------------------------------------

describe('BudgetEngine commit events', () => {
  it('fires onCommit per charge with post-record numbers', () => {
    const onCommit = vi.fn()
    const { engine } = createEngine([budgetConfig()], { onCommit })
    const { charges } = engine.resolveCharges(chargeCtx('stripe_charge', { amount: 40 }))
    engine.recordAll(charges, COMMIT_META)

    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit.mock.calls[0]?.[0]).toMatchObject({
      name: 'daily-cap',
      bucket_key: 'budget:daily-cap:global',
      kind: 'spend',
      amount: 40,
      spent: 40,
      remaining: 60,
      limit: 100,
      currency: 'USD',
      utilization: 0.4,
    })
  })
})

describe('BudgetEngine commit robustness (review round)', () => {
  it('mutates every bucket before emitting callbacks, and isolates callback throws', () => {
    const seen: string[] = []
    const onCommit = (event: BudgetCommitEvent) => {
      seen.push(event.name)
      if (event.name === 'a') throw new Error('subscriber bug')
    }
    const { engine } = createEngine([budgetConfig({ name: 'a' }), budgetConfig({ name: 'b' })], {
      onCommit,
    })
    const { charges } = engine.resolveCharges(chargeCtx('stripe_charge', { amount: 30 }))

    // A throwing subscriber must not abort the commit nor leave memory
    // partially updated relative to the (already-written) ledger.
    expect(() => engine.recordAll(charges, COMMIT_META)).not.toThrow()
    expect(seen).toEqual(['a', 'b'])
    expect(engine.listStates().map((s2) => s2.buckets[0]?.spent)).toEqual([30, 30])
  })

  it('ledgers a stale-generation charge without repopulating the reset pot', () => {
    const rows: Array<Record<string, unknown>> = []
    const { engine } = createEngine([budgetConfig({ limit: 100 })], {
      ledger: { commitAll: (batch) => rows.push(...(batch as never[])) },
    })
    const { charges } = engine.resolveCharges(chargeCtx('stripe_charge', { amount: 30 }))

    // Tuple change between peek and commit (sideband /evaluate → reload →
    // /audit, or an MCP approval wait): the call EXECUTED, so the money must
    // stay on the ledger/audit trail — under the evaluate-time generation —
    // but the frozen charge must not repopulate the reset pot.
    engine.reconcile(compileBudgets([budgetConfig({ limit: 500 })]))

    const snapshots = engine.recordAll(charges, COMMIT_META)
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]?.stale).toBe(true)
    expect(snapshots[0]?.amount).toBe(30)
    // Honest numbers: the CURRENT pot (untouched by the stale charge), and a
    // duration reset is never null — that is reserved for session pots.
    expect(snapshots[0]?.spent).toBe(0)
    expect(snapshots[0]?.remaining).toBe(500)
    expect(snapshots[0]?.resetAtMs).not.toBeNull()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.['generation']).toBe(1)
    expect(rows[0]?.['amount']).toBe(30)
    // The reset pot itself stays untouched.
    expect(engine.listStates().flatMap((s2) => s2.buckets)).toEqual([])
  })

  it('bumps the generation when a budget is removed (no hidden state revival)', () => {
    const rows: Array<Record<string, unknown>> = []
    const { engine } = createEngine([budgetConfig()], {
      ledger: { commitAll: (batch) => rows.push(...(batch as never[])) },
    })
    const { charges } = engine.resolveCharges(chargeCtx('stripe_charge', { amount: 30 }))

    // evaluate → budget removed → audit: the executed spend still ledgers,
    // but no bucket state may be recreated for a budget that no longer exists.
    engine.reconcile([])

    const snapshots = engine.recordAll(charges, COMMIT_META)
    expect(snapshots[0]?.stale).toBe(true)
    expect(rows).toHaveLength(1)
    expect(engine.listStates()).toEqual([])
    expect(engine.hasBucket('budget:daily-cap:global')).toBe(false)
  })

  it('commits charges whose generation is still current after a benign reconcile', () => {
    const { engine } = createEngine([budgetConfig()])
    const { charges } = engine.resolveCharges(chargeCtx('stripe_charge', { amount: 30 }))

    // Contributor-only edit: same tuple, same generation — the in-flight
    // charge stays valid.
    engine.reconcile(
      compileBudgets([
        budgetConfig({
          contributors: [
            { tool: 'stripe_*', field: '$.amount' },
            { tool: 'paypal_*', field: '$.total' },
          ],
        }),
      ]),
    )

    const snapshots = engine.recordAll(charges, COMMIT_META)
    expect(snapshots).toHaveLength(1)
    expect(engine.listStates()[0]?.buckets[0]?.spent).toBe(30)
  })
})

describe('BudgetEngine invalid-amount snapshots (review round 2)', () => {
  it('reports a future reset for duration budgets even with an empty bucket', () => {
    // The wire contract reserves a null reset for session pots; an empty
    // duration bucket resets one window from now.
    const { engine } = createEngine([budgetConfig({ window: '1h' })])
    const { failures } = engine.resolveCharges(chargeCtx('stripe_charge', { note: 'no amount' }))
    expect(failures[0]?.resetAtMs).toBe(1_000_000 + 3_600_000)
  })

  it('keeps a null reset for session pots on invalid amounts', () => {
    const { engine } = createEngine([
      budgetConfig({ name: 'sc', window: 'session', key: 'session' }),
    ])
    const { failures } = engine.resolveCharges(chargeCtx('stripe_charge', { note: 'x' }, 's1'))
    expect(failures[0]?.resetAtMs).toBeNull()
  })
})

describe('BudgetEngine lazy expiry (review round)', () => {
  it('reports a live reset_at_ms after entries expire, not a past one', () => {
    const { engine, advance } = createEngine([budgetConfig({ window: '1h' })])
    engine.recordAll(
      engine.resolveCharges(chargeCtx('stripe_charge', { amount: 10 })).charges,
      COMMIT_META,
    )
    advance(3_600_001) // the only entry expired; no gc() has run

    const { charges } = engine.resolveCharges(chargeCtx('stripe_charge', { amount: 10 }))
    const peek = engine.peekAll(charges)
    expect(peek.entries[0]?.spent).toBe(0)
    // A stale first-entry timestamp would report a reset in the past.
    expect(peek.entries[0]?.resetAtMs).toBeGreaterThan(1_000_000 + 3_600_001)
  })

  it('drops fully-expired duration buckets from listStates and hasBucket without gc', () => {
    const { engine, advance } = createEngine([budgetConfig({ window: '1h' })])
    engine.recordAll(
      engine.resolveCharges(chargeCtx('stripe_charge', { amount: 10 })).charges,
      COMMIT_META,
    )
    advance(3_600_001)

    expect(engine.listStates().flatMap((s2) => s2.buckets)).toEqual([])
    // Liveness drives sender-capacity slot pruning — an all-expired bucket
    // must not pin a slot until the periodic sweep.
    expect(engine.hasBucket('budget:daily-cap:global')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// reconcile — name identity
// ---------------------------------------------------------------------------

describe('BudgetEngine.reconcile', () => {
  it('preserves accrued spend across a contributor edit', () => {
    const { engine } = createEngine([budgetConfig()])
    const spend = engine.resolveCharges(chargeCtx('stripe_charge', { amount: 60 }))
    engine.recordAll(spend.charges, COMMIT_META)

    engine.reconcile(
      compileBudgets([
        budgetConfig({
          contributors: [
            { tool: 'stripe_*', field: '$.amount' },
            { tool: 'paypal_*', field: '$.total' },
          ],
        }),
      ]),
    )

    const viaNewContributor = engine.resolveCharges(chargeCtx('paypal_send', { total: 50 }))
    expect(engine.peekAll(viaNewContributor.charges).allowed).toBe(false)
  })

  it('resets state when the limit changes', () => {
    const { engine } = createEngine([budgetConfig()])
    const spend = engine.resolveCharges(chargeCtx('stripe_charge', { amount: 60 }))
    engine.recordAll(spend.charges, COMMIT_META)

    engine.reconcile(compileBudgets([budgetConfig({ limit: 200 })]))

    const next = engine.resolveCharges(chargeCtx('stripe_charge', { amount: 1 }))
    expect(engine.peekAll(next.charges).entries[0]?.spent).toBe(0)
  })

  it('resets state when the currency changes', () => {
    const { engine } = createEngine([budgetConfig()])
    engine.recordAll(
      engine.resolveCharges(chargeCtx('stripe_charge', { amount: 60 })).charges,
      COMMIT_META,
    )

    engine.reconcile(compileBudgets([budgetConfig({ currency: 'EUR' })]))

    const next = engine.resolveCharges(chargeCtx('stripe_charge', { amount: 1 }))
    expect(engine.peekAll(next.charges).entries[0]?.spent).toBe(0)
  })

  it('resets state when the key scope changes', () => {
    const { engine } = createEngine([budgetConfig()])
    engine.recordAll(
      engine.resolveCharges(chargeCtx('stripe_charge', { amount: 60 })).charges,
      COMMIT_META,
    )

    // global → session is a different pool structure: the old global bucket
    // must not strand (still displayed, never read) while session pots start
    // at zero — the scope change resets the budget like any tuple change.
    // The window stays identical so ONLY the key differs.
    engine.reconcile(compileBudgets([budgetConfig({ key: 'session' })]))

    expect(engine.listStates().flatMap((s2) => s2.buckets)).toEqual([])
    expect(engine.hasBucket('budget:daily-cap:global')).toBe(false)
  })

  it('marks in-flight charges stale across a key-scope change', () => {
    const rows: Array<Record<string, unknown>> = []
    const { engine } = createEngine([budgetConfig()], {
      ledger: { commitAll: (batch) => rows.push(...(batch as never[])) },
    })
    const { charges } = engine.resolveCharges(chargeCtx('stripe_charge', { amount: 30 }))

    engine.reconcile(compileBudgets([budgetConfig({ key: 'session' })]))

    const snapshots = engine.recordAll(charges, COMMIT_META)
    expect(snapshots[0]?.stale).toBe(true)
    expect(rows).toHaveLength(1)
    expect(engine.listStates().flatMap((s2) => s2.buckets)).toEqual([])
  })

  it('resets state when the window changes', () => {
    const { engine } = createEngine([budgetConfig()])
    engine.recordAll(
      engine.resolveCharges(chargeCtx('stripe_charge', { amount: 60 })).charges,
      COMMIT_META,
    )

    engine.reconcile(compileBudgets([budgetConfig({ window: '1h' })]))

    const next = engine.resolveCharges(chargeCtx('stripe_charge', { amount: 1 }))
    expect(engine.peekAll(next.charges).entries[0]?.spent).toBe(0)
  })

  it('drops state for removed budgets and starts fresh for new names', () => {
    const { engine } = createEngine([budgetConfig({ name: 'old' })])
    engine.recordAll(
      engine.resolveCharges(chargeCtx('stripe_charge', { amount: 60 })).charges,
      COMMIT_META,
    )

    engine.reconcile(compileBudgets([budgetConfig({ name: 'new' })]))

    expect(engine.listStates().map((s) => s.name)).toEqual(['new'])
    const next = engine.resolveCharges(chargeCtx('stripe_charge', { amount: 1 }))
    expect(next.charges[0]?.budget.name).toBe('new')
    expect(engine.peekAll(next.charges).entries[0]?.spent).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Idle-TTL GC (session windows)
// ---------------------------------------------------------------------------

describe('BudgetEngine.gc', () => {
  it('collects session pots idle past their TTL and keeps active ones', () => {
    const { engine, advance } = createEngine([
      budgetConfig({ name: 'sc', window: 'session', key: 'session', idle_ttl: '1h' }),
    ])
    engine.recordAll(
      engine.resolveCharges(chargeCtx('stripe_charge', { amount: 100 }, 'stale')).charges,
      COMMIT_META,
    )
    advance(1_800_000)
    engine.recordAll(
      engine.resolveCharges(chargeCtx('stripe_charge', { amount: 10 }, 'active')).charges,
      COMMIT_META,
    )
    advance(1_800_001) // stale pot now idle > 1h; active pot idle 30min

    engine.gc()

    const keys = engine
      .listStates()
      .flatMap((s) => s.buckets)
      .map((b) => b.bucket_key)
    expect(keys).toEqual(['budget:sc:session:active'])

    // The collected pot starts fresh if the session reappears.
    const revived = engine.resolveCharges(chargeCtx('stripe_charge', { amount: 1 }, 'stale'))
    expect(engine.peekAll(revived.charges).allowed).toBe(true)
  })

  it('evicts expired duration entries on gc', () => {
    const { engine, advance } = createEngine([budgetConfig({ window: '1h' })])
    engine.recordAll(
      engine.resolveCharges(chargeCtx('stripe_charge', { amount: 100 })).charges,
      COMMIT_META,
    )
    advance(3_600_001)

    engine.gc()

    expect(engine.listStates().flatMap((s) => s.buckets)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// listStates / hasBucket / close
// ---------------------------------------------------------------------------

describe('BudgetEngine read surface', () => {
  it('lists configured budgets even with zero live buckets', () => {
    const { engine } = createEngine([budgetConfig()])
    const states = engine.listStates()

    expect(states).toHaveLength(1)
    expect(states[0]).toMatchObject({
      name: 'daily-cap',
      limit: 100,
      currency: 'USD',
      window: '24h',
      key: 'global',
      on_exceed: 'deny',
      buckets: [],
    })
  })

  it('reports live bucket state with wire field names', () => {
    const { engine } = createEngine([budgetConfig({ window: '1h' })])
    engine.recordAll(
      engine.resolveCharges(chargeCtx('stripe_charge', { amount: 30 })).charges,
      COMMIT_META,
    )

    const bucket = engine.listStates()[0]?.buckets[0]
    expect(bucket).toEqual({
      bucket_key: 'budget:daily-cap:global',
      spent: 30,
      remaining: 70,
      reset_at_ms: 1_000_000 + 3_600_000,
      last_activity_ms: 1_000_000,
    })
  })

  it('hasBucket reports live buckets by key', () => {
    const { engine } = createEngine([budgetConfig()])
    expect(engine.hasBucket('budget:daily-cap:global')).toBe(false)
    engine.recordAll(
      engine.resolveCharges(chargeCtx('stripe_charge', { amount: 1 })).charges,
      COMMIT_META,
    )
    expect(engine.hasBucket('budget:daily-cap:global')).toBe(true)
  })

  it('close clears all state', () => {
    const { engine } = createEngine([budgetConfig()])
    engine.recordAll(
      engine.resolveCharges(chargeCtx('stripe_charge', { amount: 1 })).charges,
      COMMIT_META,
    )
    engine.close()
    expect(engine.listStates().flatMap((s) => s.buckets)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Persistence — hydrate / epoch / GC watermarks (PR 2)
// ---------------------------------------------------------------------------

/** A real-ledger delegate with selective overrides (fault injection). */
function delegatingPersistence(
  ledger: BudgetLedger,
  overrides: Partial<BudgetPersistence> = {},
): BudgetPersistence {
  return {
    commitAll: (rows) => {
      ledger.commitAll(rows)
    },
    readMeta: (name) => ledger.readMeta(name),
    readAllMeta: () => ledger.readAllMeta(),
    writeMeta: (meta) => {
      ledger.writeMeta(meta)
    },
    writeMetaBatch: (metas) => {
      ledger.writeMetaBatch(metas)
    },
    maxEventEpoch: (name) => ledger.maxEventEpoch(name),
    replayDurationEvents: (name, epoch, since) => ledger.replayDurationEvents(name, epoch, since),
    replaySessionBuckets: (name, epoch) => ledger.replaySessionBuckets(name, epoch),
    recordBucketGc: (name, key, gcAfter) => {
      ledger.recordBucketGc(name, key, gcAfter)
    },
    ...overrides,
  }
}

/**
 * A restartable harness: one SQLite ledger and one fake clock shared across
 * engine "boots". Each boot() constructs a fresh engine on the same ledger
 * and hydrates it — dropping the previous engine simulates a process death.
 * An optional sink override per boot injects faults around the real ledger.
 */
function persistentHarness(initialTime = 1_000_000) {
  const db = new Database(':memory:')
  const clock = { time: initialTime }
  const now = () => clock.time
  const ledger = new BudgetLedger({ database: db, now })
  const boot = (configs: BudgetConfig[], sink?: BudgetPersistence) => {
    const engine = new BudgetEngine({
      budgets: compileBudgets(configs),
      now,
      cleanupIntervalMs: 0,
      ledger: sink ?? ledger,
    })
    engine.hydrate()
    return engine
  }
  const advance = (ms: number) => {
    clock.time += ms
  }
  return { boot, ledger, db, advance }
}

function spentAfterBoot(engine: BudgetEngine, amount = 1): number {
  const { charges } = engine.resolveCharges(chargeCtx('stripe_charge', { amount }))
  return engine.peekAll(charges).entries[0]?.spent ?? -1
}

describe('BudgetEngine persistence (PR 2)', () => {
  it('writes a first-boot meta row at epoch 1', () => {
    const { boot, ledger } = persistentHarness()
    boot([budgetConfig()])
    expect(ledger.readMeta('daily-cap')).toEqual({
      budget_name: 'daily-cap',
      limit_amount: 100,
      currency: 'USD',
      window: '24h',
      key: 'global',
      epoch: 1,
    })
  })

  it('replays duration-window spend across a restart inside the window', () => {
    const { boot, advance } = persistentHarness()
    const first = boot([budgetConfig({ window: '1h' })])
    first.recordAll(
      first.resolveCharges(chargeCtx('stripe_charge', { amount: 30 })).charges,
      COMMIT_META,
    )

    advance(1_800_000) // half the window
    const second = boot([budgetConfig({ window: '1h' })])
    expect(spentAfterBoot(second)).toBe(30)
    // Sliding-window equivalence: the replayed entry keeps its original
    // timestamp, so it ages out exactly when it would have without a restart.
    advance(1_800_001)
    expect(spentAfterBoot(second)).toBe(0)
  })

  it('persists an approved overage with its kind and replays it after a restart', () => {
    const { boot, db, advance } = persistentHarness()
    const config = budgetConfig({ window: '1h', limit: 50 })
    const first = boot([config])
    const { charges } = first.resolveCharges(chargeCtx('stripe_charge', { amount: 80 }))
    first.recordAll(charges, {
      ...COMMIT_META,
      kinds: new Map([['daily-cap', 'approved_overage' as const]]),
    })

    const row = db.prepare('SELECT kind, amount FROM budget_events').get() as {
      kind: string
      amount: number
    }
    expect(row).toEqual({ kind: 'approved_overage', amount: 80 })

    advance(60_000)
    const second = boot([config])
    // An overage stays spent: the pot comes back over its limit.
    expect(spentAfterBoot(second)).toBe(80)
    const next = second.resolveCharges(chargeCtx('stripe_charge', { amount: 1 }))
    expect(second.peekAll(next.charges).allowed).toBe(false)
  })

  it('replays nothing for a duration window when the whole window elapsed while down', () => {
    const { boot, advance } = persistentHarness()
    const first = boot([budgetConfig({ window: '1h' })])
    first.recordAll(
      first.resolveCharges(chargeCtx('stripe_charge', { amount: 30 })).charges,
      COMMIT_META,
    )

    advance(3_600_001)
    const second = boot([budgetConfig({ window: '1h' })])
    expect(spentAfterBoot(second)).toBe(0)
    expect(second.listStates().flatMap((s) => s.buckets)).toEqual([])
  })

  it('rebuilds separate buckets for a session-keyed duration budget', () => {
    const config = budgetConfig({ window: '1h', key: 'session' as const })
    const { boot, advance } = persistentHarness()
    const first = boot([config])
    first.recordAll(
      first.resolveCharges(chargeCtx('stripe_charge', { amount: 10 }, 's1')).charges,
      COMMIT_META,
    )
    first.recordAll(
      first.resolveCharges(chargeCtx('stripe_charge', { amount: 20 }, 's2')).charges,
      COMMIT_META,
    )

    advance(60_000)
    const second = boot([config])
    const buckets = second.listStates().flatMap((s) => s.buckets)
    expect(buckets.map((b) => [b.bucket_key, b.spent])).toEqual([
      ['budget:daily-cap:session:s1', 10],
      ['budget:daily-cap:session:s2', 20],
    ])
  })

  it('rebuilds a live session pot with its full lifetime sum and last activity', () => {
    const config = budgetConfig({
      name: 'sc',
      window: 'session',
      key: 'session' as const,
      idle_ttl: '1h',
    })
    const { boot, advance } = persistentHarness()
    const first = boot([config])
    first.recordAll(
      first.resolveCharges(chargeCtx('stripe_charge', { amount: 10 }, 's1')).charges,
      COMMIT_META,
    )
    advance(30 * 60_000)
    first.recordAll(
      first.resolveCharges(chargeCtx('stripe_charge', { amount: 20 }, 's1')).charges,
      COMMIT_META,
    )

    advance(30 * 60_000) // 30min idle < 1h TTL: still live
    const second = boot([config])
    const bucket = second.listStates()[0]?.buckets[0]
    expect(bucket).toMatchObject({
      bucket_key: 'budget:sc:session:s1',
      spent: 30,
      reset_at_ms: null,
      last_activity_ms: 1_000_000 + 30 * 60_000,
    })
  })

  it('does not rebuild a session pot idle past its TTL', () => {
    const config = budgetConfig({
      name: 'sc',
      window: 'session',
      key: 'session' as const,
      idle_ttl: '1h',
    })
    const { boot, advance } = persistentHarness()
    const first = boot([config])
    first.recordAll(
      first.resolveCharges(chargeCtx('stripe_charge', { amount: 10 }, 's1')).charges,
      COMMIT_META,
    )

    advance(3_600_001)
    const second = boot([config])
    expect(second.listStates().flatMap((s) => s.buckets)).toEqual([])
  })

  it('gc writes a watermark so a resurrected pot replays only post-GC spend', () => {
    const config = budgetConfig({
      name: 'sc',
      window: 'session',
      key: 'session' as const,
      idle_ttl: '1h',
    })
    const { boot, advance, db } = persistentHarness()
    const first = boot([config])
    first.recordAll(
      first.resolveCharges(chargeCtx('stripe_charge', { amount: 40 }, 's1')).charges,
      COMMIT_META,
    )

    advance(3_600_001)
    first.gc() // evicts the idle pot and records the watermark
    expect(first.listStates().flatMap((s) => s.buckets)).toEqual([])
    const watermarks = db.prepare('SELECT * FROM budget_bucket_gc').all() as Array<
      Record<string, unknown>
    >
    expect(watermarks).toEqual([
      {
        budget_name: 'sc',
        bucket_key: 'budget:sc:session:s1',
        gc_after_ms: 1_000_000 + 3_600_001,
      },
    ])

    // The same session id comes back: a fresh pot in memory...
    first.recordAll(
      first.resolveCharges(chargeCtx('stripe_charge', { amount: 7 }, 's1')).charges,
      COMMIT_META,
    )

    // ...and a restart must NOT re-absorb the pre-GC 40.
    advance(60_000)
    const second = boot([config])
    const bucket = second.listStates()[0]?.buckets[0]
    expect(bucket).toMatchObject({ bucket_key: 'budget:sc:session:s1', spent: 7 })
  })

  it('keeps the bucket when the GC watermark write fails (retry next sweep)', () => {
    const config = budgetConfig({
      name: 'sc',
      window: 'session',
      key: 'session' as const,
      idle_ttl: '1h',
    })
    const db = new Database(':memory:')
    const clock = { time: 1_000_000 }
    const ledger = new BudgetLedger({ database: db, now: () => clock.time })
    const failing = delegatingPersistence(ledger, {
      recordBucketGc: () => {
        throw new Error('disk full')
      },
    })
    const engine = new BudgetEngine({
      budgets: compileBudgets([config]),
      now: () => clock.time,
      cleanupIntervalMs: 0,
      ledger: failing,
    })
    engine.hydrate()
    engine.recordAll(
      engine.resolveCharges(chargeCtx('stripe_charge', { amount: 40 }, 's1')).charges,
      COMMIT_META,
    )

    clock.time += 3_600_001
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      engine.gc()
    } finally {
      errorSpy.mockRestore()
    }

    // Evicting without a durable watermark could resurrect pre-GC spend
    // after a restart — the sweep must keep the bucket and retry later.
    expect(engine.listStates().flatMap((s) => s.buckets)).toHaveLength(1)
  })

  it('bumps the epoch and replays nothing when the tuple changed while down', () => {
    const { boot, advance, ledger } = persistentHarness()
    const first = boot([budgetConfig()])
    first.recordAll(
      first.resolveCharges(chargeCtx('stripe_charge', { amount: 30 })).charges,
      COMMIT_META,
    )

    advance(60_000)
    const second = boot([budgetConfig({ limit: 200 })])
    expect(spentAfterBoot(second)).toBe(0)
    expect(ledger.readMeta('daily-cap')).toMatchObject({ limit_amount: 200, epoch: 2 })
  })

  it('bumps the epoch when only the key scope changed while down', () => {
    const { boot, advance, ledger } = persistentHarness()
    const first = boot([budgetConfig()])
    first.recordAll(
      first.resolveCharges(chargeCtx('stripe_charge', { amount: 30 })).charges,
      COMMIT_META,
    )

    advance(60_000)
    const second = boot([budgetConfig({ key: 'session' })])
    expect(ledger.readMeta('daily-cap')).toMatchObject({ key: 'session', epoch: 2 })
    expect(second.listStates().flatMap((s) => s.buckets)).toEqual([])
  })

  it('replays nothing from either old epoch after an A-to-B-to-A double change', () => {
    const { boot, advance, ledger } = persistentHarness()
    const first = boot([budgetConfig()]) // A, epoch 1
    first.recordAll(
      first.resolveCharges(chargeCtx('stripe_charge', { amount: 30 })).charges,
      COMMIT_META,
    )

    advance(60_000)
    const second = boot([budgetConfig({ limit: 200 })]) // B, epoch 2
    second.recordAll(
      second.resolveCharges(chargeCtx('stripe_charge', { amount: 50 })).charges,
      COMMIT_META,
    )

    advance(60_000)
    const third = boot([budgetConfig()]) // A again — epoch 3, not a return to 1
    expect(spentAfterBoot(third)).toBe(0)
    expect(ledger.readMeta('daily-cap')?.epoch).toBe(3)
  })

  it('writes the bumped epoch synchronously on a hot-reload tuple change', () => {
    const { boot, ledger, advance } = persistentHarness()
    const engine = boot([budgetConfig()])
    engine.recordAll(
      engine.resolveCharges(chargeCtx('stripe_charge', { amount: 30 })).charges,
      COMMIT_META,
    )

    engine.reconcile(compileBudgets([budgetConfig({ limit: 200 })]))
    expect(ledger.readMeta('daily-cap')).toMatchObject({ limit_amount: 200, epoch: 2 })

    // Crash immediately after the reload: the on-disk epoch already moved,
    // so the next boot starts the new pot fresh instead of replaying epoch-1
    // rows into it.
    advance(1_000)
    const second = boot([budgetConfig({ limit: 200 })])
    expect(spentAfterBoot(second)).toBe(0)
  })

  it('flushes the epoch bump when a budget is removed, so a re-add stays fresh across restarts', () => {
    const { boot, ledger, advance } = persistentHarness()
    const engine = boot([budgetConfig()])
    engine.recordAll(
      engine.resolveCharges(chargeCtx('stripe_charge', { amount: 30 })).charges,
      COMMIT_META,
    )

    engine.reconcile([]) // budget removed at runtime
    expect(ledger.readMeta('daily-cap')?.epoch).toBe(2)

    // Restart with the budget back in the config, same tuple: removal reset
    // the pot, so the restart must not resurrect the pre-removal spend.
    advance(1_000)
    const second = boot([budgetConfig()])
    expect(spentAfterBoot(second)).toBe(0)
  })

  it('mints a hot-reload-added budget past the on-disk epoch history', () => {
    const { boot, advance } = persistentHarness()
    const first = boot([budgetConfig()])
    first.recordAll(
      first.resolveCharges(chargeCtx('stripe_charge', { amount: 30 })).charges,
      COMMIT_META,
    )

    // Restart WITHOUT the budget, then hot-reload re-adds it: the fresh
    // process has no memory of the name, but the disk does — the minted
    // epoch must move past the history, not collide back into epoch 1.
    advance(1_000)
    const second = boot([])
    second.reconcile(compileBudgets([budgetConfig()]))
    second.recordAll(
      second.resolveCharges(chargeCtx('stripe_charge', { amount: 10 })).charges,
      COMMIT_META,
    )
    expect(spentAfterBoot(second)).toBe(10)

    advance(1_000)
    const third = boot([budgetConfig()])
    expect(spentAfterBoot(third)).toBe(10) // the re-added pot's own spend only
  })

  it('replays approved_overage rows identically to spend rows', () => {
    const { boot, advance } = persistentHarness()
    const first = boot([budgetConfig({ window: '1h' })])
    first.recordAll(first.resolveCharges(chargeCtx('stripe_charge', { amount: 120 })).charges, {
      ...COMMIT_META,
      kind: 'approved_overage',
    })

    advance(60_000)
    const second = boot([budgetConfig({ window: '1h' })])
    expect(spentAfterBoot(second)).toBe(120) // an overage stays spent
  })

  it('hydrate is a no-op for a plain commit sink (in-memory mode)', () => {
    const rows: unknown[] = []
    const { engine } = createEngine([budgetConfig()], {
      ledger: { commitAll: (batch) => rows.push(...batch) },
    })
    expect(() => {
      engine.hydrate()
    }).not.toThrow()
    expect(engine.listStates().flatMap((s) => s.buckets)).toEqual([])
  })

  it('hydrate is latched: a second call cannot double-count replayed entries', () => {
    const { boot, advance } = persistentHarness()
    const first = boot([budgetConfig({ window: '1h' })])
    first.recordAll(
      first.resolveCharges(chargeCtx('stripe_charge', { amount: 30 })).charges,
      COMMIT_META,
    )

    advance(60_000)
    const second = boot([budgetConfig({ window: '1h' })])
    second.hydrate() // boot() already hydrated once
    expect(spentAfterBoot(second)).toBe(30)
  })

  it('replays nothing at exactly the window bound (memory-eviction parity)', () => {
    const { boot, advance } = persistentHarness()
    const first = boot([budgetConfig({ window: '1h' })])
    first.recordAll(
      first.resolveCharges(chargeCtx('stripe_charge', { amount: 30 })).charges,
      COMMIT_META,
    )

    advance(3_600_000) // exactly one window: expired on both sides
    const second = boot([budgetConfig({ window: '1h' })])
    expect(spentAfterBoot(second)).toBe(0)
  })

  it('rebuilds a session pot at exactly the idle-TTL bound (memory-sweep parity)', () => {
    const config = budgetConfig({
      name: 'sc',
      window: 'session',
      key: 'session' as const,
      idle_ttl: '1h',
    })
    const { boot, advance } = persistentHarness()
    const first = boot([config])
    first.recordAll(
      first.resolveCharges(chargeCtx('stripe_charge', { amount: 10 }, 's1')).charges,
      COMMIT_META,
    )

    advance(3_600_000) // exactly the TTL: the memory sweep would keep it
    const second = boot([config])
    expect(second.listStates()[0]?.buckets[0]).toMatchObject({
      bucket_key: 'budget:sc:session:s1',
      spent: 10,
    })
  })

  it('retires a pot that crossed its idle TTL while down (watermark at hydrate)', () => {
    const config = budgetConfig({
      name: 'sc',
      window: 'session',
      key: 'session' as const,
      idle_ttl: '1h',
    })
    const { boot, advance, db } = persistentHarness()
    const first = boot([config])
    first.recordAll(
      first.resolveCharges(chargeCtx('stripe_charge', { amount: 40 }, 's1')).charges,
      COMMIT_META,
    )

    // The pot dies during downtime — no sweep ever observed it.
    advance(3_600_001)
    const second = boot([config])
    expect(second.listStates().flatMap((s) => s.buckets)).toEqual([])
    // Hydrate durably retired it.
    const readWatermarks = () =>
      db.prepare('SELECT * FROM budget_bucket_gc').all() as Array<Record<string, unknown>>
    const stamped = readWatermarks()
    expect(stamped).toHaveLength(1)

    // Another restart BEFORE any resurrection: the `total > 0` guard makes
    // the retirement idempotent — the watermark is not re-stamped, so its
    // retention lifetime is anchored to the original retirement, not
    // refreshed forever by every boot.
    advance(60_000)
    const secondB = boot([config])
    expect(secondB.listStates().flatMap((s) => s.buckets)).toEqual([])
    expect(readWatermarks()).toEqual(stamped)

    // The same session key resurrects with fresh spend...
    secondB.recordAll(
      secondB.resolveCharges(chargeCtx('stripe_charge', { amount: 7 }, 's1')).charges,
      COMMIT_META,
    )

    // ...and the NEXT restart must not re-absorb the dead pot's 40.
    advance(60_000)
    const third = boot([config])
    expect(third.listStates()[0]?.buckets[0]).toMatchObject({
      bucket_key: 'budget:sc:session:s1',
      spent: 7,
    })
  })

  it('retires a budget removed while down, so a cold re-add starts fresh', () => {
    const { boot, advance, ledger } = persistentHarness()
    const first = boot([budgetConfig()])
    first.recordAll(
      first.resolveCharges(chargeCtx('stripe_charge', { amount: 30 })).charges,
      COMMIT_META,
    )

    // A boot without the budget observes the removal and bumps the epoch.
    advance(1_000)
    boot([])
    expect(ledger.readMeta('daily-cap')?.epoch).toBe(2)

    // Idempotent: further boots without it write nothing more.
    advance(1_000)
    boot([])
    expect(ledger.readMeta('daily-cap')?.epoch).toBe(2)

    // Re-added with the identical tuple: fresh pot, like a live removal.
    advance(1_000)
    const readded = boot([budgetConfig()])
    expect(spentAfterBoot(readded)).toBe(0)
  })

  it('never replays rows whose epoch no meta row records (events-max backstop, no-meta branch)', () => {
    // Divergence from any historical source (an interrupted older build, a
    // hand-poked db): rows exist at epoch 1 with no meta row. Minting must
    // move past them, never re-mint their epoch for a fresh pot.
    const { boot, ledger, db } = persistentHarness()
    db.prepare(
      `INSERT INTO budget_events (id, budget_name, epoch, bucket_key, kind, amount, currency,
         tool_name, origin, audit_record_id, timestamp, timestamp_ms, created_at)
       VALUES ('row-1', 'daily-cap', 1, 'budget:daily-cap:global', 'spend', 90, 'USD',
         'stripe_charge', 'mcp', 'audit-x', '2026-07-10T00:00:00.000Z', 999_000, '2026-07-10T00:00:00.000Z')`,
    ).run()

    const engine = boot([budgetConfig()])
    expect(ledger.readMeta('daily-cap')?.epoch).toBe(2)
    expect(spentAfterBoot(engine)).toBe(0)
  })

  it('mints past orphaned row epochs on a tuple change while down (events-max backstop)', () => {
    const { boot, advance, ledger, db } = persistentHarness()
    const first = boot([budgetConfig()]) // meta {limit 100, epoch 1}
    first.recordAll(
      first.resolveCharges(chargeCtx('stripe_charge', { amount: 30 })).charges,
      COMMIT_META,
    )
    // Divergent rows above the meta epoch (historical corruption).
    db.prepare('UPDATE budget_events SET epoch = 5').run()

    advance(1_000)
    boot([budgetConfig({ limit: 300 })])
    // meta.epoch + 1 would be 2; the backstop mints past the rows instead.
    expect(ledger.readMeta('daily-cap')).toMatchObject({ limit_amount: 300, epoch: 6 })

    advance(1_000)
    const third = boot([budgetConfig({ limit: 300 })])
    expect(spentAfterBoot(third)).toBe(0)
  })

  it('rejects a reload whose epoch flush fails, leaving memory and disk untouched', () => {
    const { boot, advance, ledger } = persistentHarness()
    let failBatch = false
    const flaky = delegatingPersistence(ledger, {
      writeMetaBatch: (metas) => {
        if (failBatch) throw new Error('disk full')
        ledger.writeMetaBatch(metas)
      },
    })
    const engine = boot([budgetConfig()], flaky)
    engine.recordAll(
      engine.resolveCharges(chargeCtx('stripe_charge', { amount: 60 })).charges,
      COMMIT_META,
    )

    failBatch = true
    expect(() => {
      engine.reconcile(compileBudgets([budgetConfig({ limit: 200 })]))
    }).toThrow('disk full')

    // The failed reload never happened: the OLD config still enforces with
    // its accrued state, and later rows still carry the old epoch.
    const { charges } = engine.resolveCharges(chargeCtx('stripe_charge', { amount: 1 }))
    expect(charges[0]?.budget.limit).toBe(100)
    expect(charges[0]?.generation).toBe(1)
    expect(engine.peekAll(charges).entries[0]?.spent).toBe(60)
    expect(ledger.readMeta('daily-cap')).toMatchObject({ limit_amount: 100, epoch: 1 })

    // Restart on the ORIGINAL config: continuity, not resurrection — the pot
    // was never reset, so its spend rightly survives.
    advance(1_000)
    const second = boot([budgetConfig()])
    expect(spentAfterBoot(second)).toBe(60)

    // Restart on the NEW config: a normal tuple change, fresh pot.
    advance(1_000)
    const third = boot([budgetConfig({ limit: 200 })])
    expect(spentAfterBoot(third)).toBe(0)
    expect(ledger.readMeta('daily-cap')).toMatchObject({ limit_amount: 200, epoch: 2 })
  })

  it('rejects a removal whose epoch flush fails, keeping the budget enforced', () => {
    const { boot, ledger } = persistentHarness()
    let failBatch = false
    const flaky = delegatingPersistence(ledger, {
      writeMetaBatch: (metas) => {
        if (failBatch) throw new Error('disk full')
        ledger.writeMetaBatch(metas)
      },
    })
    const engine = boot([budgetConfig()], flaky)
    engine.recordAll(
      engine.resolveCharges(chargeCtx('stripe_charge', { amount: 60 })).charges,
      COMMIT_META,
    )

    failBatch = true
    expect(() => {
      engine.reconcile([])
    }).toThrow('disk full')

    // Still configured, still enforcing, nothing bumped anywhere.
    expect(engine.listStates().map((s) => s.name)).toEqual(['daily-cap'])
    const { charges } = engine.resolveCharges(chargeCtx('stripe_charge', { amount: 50 }))
    expect(engine.peekAll(charges).allowed).toBe(false) // 60 + 50 > 100
    expect(ledger.readMeta('daily-cap')?.epoch).toBe(1)
  })

  it('persists all epoch mints of one reload in a single batch (all-or-nothing)', () => {
    const { boot, ledger } = persistentHarness()
    const engine = boot([budgetConfig({ name: 'a' }), budgetConfig({ name: 'b' })])

    // One reload: 'a' changes tuple, 'b' is removed, 'c' appears.
    engine.reconcile(
      compileBudgets([budgetConfig({ name: 'a', limit: 500 }), budgetConfig({ name: 'c' })]),
    )

    expect(ledger.readMeta('a')).toMatchObject({ limit_amount: 500, epoch: 2 })
    expect(ledger.readMeta('b')?.epoch).toBe(2) // removal tombstone
    expect(ledger.readMeta('c')?.epoch).toBe(1)
  })

  it('hydrate fails the boot when the meta write throws', () => {
    const { ledger } = persistentHarness()
    const broken = delegatingPersistence(ledger, {
      writeMeta: () => {
        throw new Error('disk full')
      },
    })
    const engine = new BudgetEngine({
      budgets: compileBudgets([budgetConfig()]),
      now: () => 1_000_000,
      cleanupIntervalMs: 0,
      ledger: broken,
    })
    expect(() => {
      engine.hydrate()
    }).toThrow('disk full')
  })

  it('rolls back the whole call and leaves memory untouched on a genuine mid-batch fault', () => {
    const { boot, db } = persistentHarness()
    const engine = boot([budgetConfig({ name: 'a' }), budgetConfig({ name: 'b' })])
    const { charges } = engine.resolveCharges(chargeCtx('stripe_charge', { amount: 30 }))
    const [chargeA, chargeB] = charges
    if (!chargeA || !chargeB) throw new Error('expected two charges')

    // NaN binds as NULL and violates the amount NOT NULL constraint on the
    // SECOND insert of the transaction — a genuine mid-batch fault through
    // the full recordAll path.
    expect(() => engine.recordAll([chargeA, { ...chargeB, amount: NaN }], COMMIT_META)).toThrow()

    const countRows = () =>
      (db.prepare('SELECT COUNT(*) AS count FROM budget_events').get() as { count: number }).count
    expect(countRows()).toBe(0)
    expect(engine.listStates().flatMap((s) => s.buckets)).toEqual([])

    // The fault clears; the same call then commits cleanly.
    expect(() => engine.recordAll(charges, COMMIT_META)).not.toThrow()
    expect(countRows()).toBe(2)
    expect(engine.listStates().map((s) => s.buckets[0]?.spent)).toEqual([30, 30])
  })
})
