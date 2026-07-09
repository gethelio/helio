import { describe, it, expect, vi } from 'vitest'
import { BudgetEngine } from './engine.js'
import type { BudgetCommitEvent, BudgetLedgerSink } from './engine.js'
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
