import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'
import type { BudgetCharge, BudgetChargeFailure } from '../budget/engine.js'
import { BudgetEngine } from '../budget/engine.js'
import { compileBudgets } from '../budget/parser.js'
import type { CompiledBudget } from '../budget/types.js'
import type { GatedCharges } from './session-gate.js'
import {
  gateSession,
  gateBudgetCharges,
  sessionLimitKey,
  freezeGatedPlans,
  remintDeferredCharges,
  sessionUnresolvedControlMessage,
  sessionRequiredForGroundingMessage,
  warnSessionUnresolvedEngagementOnce,
  warnAnonymousPoolingOnce,
  resetSessionGateWarningsForTests,
} from './session-gate.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function budget(key: CompiledBudget['key'], name = `${key}-pot`): CompiledBudget {
  return {
    name,
    limit: 50,
    currency: 'USD',
    window: { kind: 'duration', windowMs: 3_600_000 },
    windowRaw: '1h',
    key,
    onExceed: 'deny',
    contributors: [],
  }
}

function charge(b: CompiledBudget, bucketKey: string, amount = 5): BudgetCharge {
  return { budget: b, bucketKey, amount, generation: 0 }
}

function failure(b: CompiledBudget, bucketKey: string): BudgetChargeFailure {
  return {
    budget: b,
    bucketKey,
    reason: 'invalid_amount',
    spent: 0,
    remaining: b.limit,
    resetAtMs: null,
  }
}

beforeEach(() => {
  resetSessionGateWarningsForTests()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// gateSession
// ---------------------------------------------------------------------------

describe('gateSession', () => {
  it('mints an attributed session for a resolved id under both modes', () => {
    for (const mode of ['deny', 'anonymous'] as const) {
      const gate = gateSession('run-a', mode)
      expect(gate.ok).toBe(true)
      if (!gate.ok) continue
      expect(gate.session).toBe('run-a')
      expect(gate.anonymous).toBe(false)
    }
  })

  it('returns unresolved under deny mode when no id exists', () => {
    expect(gateSession(undefined, 'deny')).toEqual({ ok: false })
    expect(gateSession(null, 'deny')).toEqual({ ok: false })
  })

  it('treats empty and whitespace-only ids as unresolved (sideband bypass regression)', () => {
    // The MCP resolver skips these before the gate; the sideband hands
    // adapter-supplied ids over raw, so the gate itself must apply the same
    // non-empty-after-trim well-formedness or " " counts as identity and
    // pools into a silent shared whitespace bucket.
    expect(gateSession('', 'deny')).toEqual({ ok: false })
    expect(gateSession(' ', 'deny')).toEqual({ ok: false })
    expect(gateSession('\t\n', 'deny')).toEqual({ ok: false })

    const anonymous = gateSession('   ', 'anonymous')
    expect(anonymous.ok).toBe(true)
    if (!anonymous.ok) return
    expect(anonymous.session).toBe('unknown')
    expect(anonymous.anonymous).toBe(true)
  })

  it('mints the literal unknown bucket value under anonymous mode', () => {
    const gate = gateSession(null, 'anonymous')
    expect(gate.ok).toBe(true)
    if (!gate.ok) return
    expect(gate.session).toBe('unknown')
    expect(gate.anonymous).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// sessionLimitKey
// ---------------------------------------------------------------------------

describe('sessionLimitKey', () => {
  it('builds the exact pre-change key format', () => {
    const gate = gateSession('abc', 'deny')
    if (!gate.ok) throw new Error('expected ok')
    expect(sessionLimitKey(gate.session)).toBe('session:abc')
  })

  it('keeps anonymous pooling on the literal unknown bucket', () => {
    const gate = gateSession(undefined, 'anonymous')
    if (!gate.ok) throw new Error('expected ok')
    expect(sessionLimitKey(gate.session)).toBe('session:unknown')
  })
})

// ---------------------------------------------------------------------------
// gateBudgetCharges — the #215-critical engagement check
// ---------------------------------------------------------------------------

describe('gateBudgetCharges', () => {
  const sessionBudget = budget('session')
  const globalBudget = budget('global')

  it('reports unresolvedEngaged when a session-keyed charge meets an unresolved gate', () => {
    const gated = gateBudgetCharges(
      { charges: [charge(sessionBudget, 'budget:session-pot:session:unknown')], failures: [] },
      gateSession(undefined, 'deny'),
    )
    expect(gated.ok).toBe(false)
  })

  it('reports unresolvedEngaged when a session-keyed FAILURE meets an unresolved gate', () => {
    const gated = gateBudgetCharges(
      { charges: [], failures: [failure(sessionBudget, 'budget:session-pot:session:unknown')] },
      gateSession(undefined, 'deny'),
    )
    expect(gated.ok).toBe(false)
  })

  it('passes global-only charges through an unresolved gate', () => {
    const charges = [charge(globalBudget, 'budget:global-pot:global')]
    const gated = gateBudgetCharges({ charges, failures: [] }, gateSession(undefined, 'deny'))
    expect(gated.ok).toBe(true)
    if (!gated.ok) return
    expect([...gated.charges]).toEqual(charges)
  })

  it('passes session-keyed charges through a resolved gate', () => {
    const charges = [charge(sessionBudget, 'budget:session-pot:session:run-a')]
    const gated = gateBudgetCharges({ charges, failures: [] }, gateSession('run-a', 'deny'))
    expect(gated.ok).toBe(true)
  })

  it('warns once when session-keyed charges pool through the anonymous mint', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const resolved = {
      charges: [charge(sessionBudget, 'budget:session-pot:session:unknown')],
      failures: [],
    }
    const anonymousGate = gateSession(undefined, 'anonymous')
    expect(gateBudgetCharges(resolved, anonymousGate).ok).toBe(true)
    expect(gateBudgetCharges(resolved, anonymousGate).ok).toBe(true)
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('unknown'))
  })

  it('does not warn for anonymous mints that engage no session-keyed control', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    gateBudgetCharges(
      { charges: [charge(globalBudget, 'budget:global-pot:global')], failures: [] },
      gateSession(undefined, 'anonymous'),
    )
    expect(errorSpy).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// freezeGatedPlans / remintDeferredCharges — the sideband deferred commit
// ---------------------------------------------------------------------------

describe('freezeGatedPlans', () => {
  const sessionBudget = budget('session')

  function gatedCharges(list: BudgetCharge[]) {
    const gated = gateBudgetCharges({ charges: list, failures: [] }, gateSession('run-a', 'deny'))
    if (!gated.ok) throw new Error('expected ok')
    return gated.charges
  }

  it('freezes charges into plans carrying positional breach markers', () => {
    const charges = gatedCharges([
      charge(sessionBudget, 'budget:session-pot:session:run-a', 5),
      charge(sessionBudget, 'budget:session-pot:session:run-a', 7),
    ])
    const frozen = freezeGatedPlans(charges, [false, true])
    expect(frozen).toHaveLength(2)
    expect(frozen[0]).toMatchObject({ kind: 'budget', amount: 5, breached: false })
    expect(frozen[1]).toMatchObject({ kind: 'budget', amount: 7, breached: true })
  })

  it('rejects breach flags that do not pair positionally with the charges', () => {
    const charges = gatedCharges([charge(sessionBudget, 'k', 5)])
    expect(() => freezeGatedPlans(charges, [false, true])).toThrow(/positional/i)
  })

  it('reminting restores charge shape and applies the actual_amount override', () => {
    const charges = gatedCharges([charge(sessionBudget, 'k1', 5), charge(sessionBudget, 'k2', 7)])
    const frozen = freezeGatedPlans(charges, [false, false])

    const replayed = remintDeferredCharges(frozen)
    expect([...replayed]).toEqual([
      { budget: sessionBudget, bucketKey: 'k1', amount: 5, generation: 0 },
      { budget: sessionBudget, bucketKey: 'k2', amount: 7, generation: 0 },
    ])

    const overridden = remintDeferredCharges(frozen, 9)
    expect([...overridden].map((c) => c.amount)).toEqual([9, 9])
  })

  it('the freeze → remint round-trip drops a charge-level upstream label (issue #295)', () => {
    // Deliberate: the drop IS the sideband-null mechanism — a deferred commit
    // snapshots upstream: null because the reminted charge carries no
    // upstream key. Do not add a door name to frozen plans.
    const labeled = gatedCharges([
      { ...charge(sessionBudget, 'k1', 5), upstream: 'payments' } as BudgetCharge,
    ])
    const frozen = freezeGatedPlans(labeled, [false])
    const reminted = [...remintDeferredCharges(frozen)]
    expect(reminted[0]).toBeDefined()
    expect('upstream' in (reminted[0] as object)).toBe(false)
  })

  it('a deferred commit snapshots upstream: null — freeze/remint drop the label (issue #295)', () => {
    const engine = new BudgetEngine({
      budgets: compileBudgets([
        {
          name: 'cap',
          limit: 100,
          currency: 'USD',
          window: '24h',
          key: 'global',
          on_exceed: 'deny',
          contributors: [{ match: { tool: 'stripe_*' }, field: '$.amount' }],
        },
      ]),
      cleanupIntervalMs: 0,
    })
    const { charges } = engine.resolveCharges({
      toolName: 'stripe_charge',
      toolArguments: { amount: 5 },
      sessionId: null,
      senderId: null,
      upstream: 'payments',
    })
    const gated = gateBudgetCharges({ charges, failures: [] }, gateSession('run-a', 'deny'))
    if (!gated.ok) throw new Error('expected ok')
    const frozen = freezeGatedPlans(gated.charges, [false])
    const reminted = remintDeferredCharges(frozen)

    const snapshots = engine.recordAll(reminted, {
      kind: 'spend',
      auditRecordId: 'audit-1',
      origin: 'sideband',
      toolName: 'stripe_charge',
      timestampIso: '2026-08-25T12:00:00.000Z',
    })
    expect(snapshots[0]?.upstream).toBeNull()
  })

  it('rejects fresh unfrozen plan-shaped objects at the remint (type-level)', () => {
    const launder = [
      {
        kind: 'budget' as const,
        budget: sessionBudget,
        bucketKey: 'k',
        amount: 5,
        generation: 0,
        breached: false,
      },
    ]
    // @ts-expect-error — the round-7 launder: a structural BudgetPlan clone
    // must not satisfy FrozenBudgetPlans without passing the engagement check.
    remintDeferredCharges(launder)
  })
})

// ---------------------------------------------------------------------------
// Deny messages
// ---------------------------------------------------------------------------

describe('deny messages', () => {
  it('names the tried strategies for engaged session-keyed controls', () => {
    const message = sessionUnresolvedControlMessage('header "x-helio-session-id", legacy_header')
    expect(message).toContain('tried: header "x-helio-session-id", legacy_header')
    expect(message).toContain('session.identity')
  })

  it('names the tried strategies for evidence/dependency rules', () => {
    const message = sessionRequiredForGroundingMessage('header "x-helio-session-id"')
    expect(message).toContain('tried: header "x-helio-session-id"')
    expect(message).toContain('evidence.requires')
    expect(message).toContain('session.identity')
  })
})

// ---------------------------------------------------------------------------
// One-shot warnings
// ---------------------------------------------------------------------------

describe('one-shot warnings', () => {
  it('warns once per process on deny-mode unresolved engagement', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    warnSessionUnresolvedEngagementOnce('legacy_header')
    warnSessionUnresolvedEngagementOnce('legacy_header')
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('legacy_header'))
  })

  it('warns once per process on anonymous pooling', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    warnAnonymousPoolingOnce()
    warnAnonymousPoolingOnce()
    expect(errorSpy).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// Structural backstops — the documented map of expected gate consumers
// ---------------------------------------------------------------------------

describe('gate module call-site backstops', () => {
  // The brands make skipping the gate a compile error at the known seams;
  // this list documents the expected consumer modules and catches a refactor
  // that swaps one out for a hand-rolled path without touching the others.
  const EXPECTED_IMPORTERS = [
    'policy/governed-forwarder.ts', // 4 limit-key sites + budget gate + dry-run
    'sideband/governance-service.ts', // 2 limit-key sites + budget gate + freeze/remint
    'policy/decision-pipeline.ts', // grounded-rule deny message
    'budget/engine.ts', // GatedSession/GatedCharges signatures (type-level)
  ]

  it('every documented consumer imports the gate module', async () => {
    const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
    for (const relPath of EXPECTED_IMPORTERS) {
      const source = await readFile(join(srcRoot, relPath), 'utf-8')
      expect(source, `${relPath} must import the session gate`).toMatch(
        /from '\.{1,2}\/(policy\/)?session-gate\.js'/,
      )
    }
  })

  it('no production module forges the brands with an as-cast', async () => {
    const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
    const files: string[] = []
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const abs = join(dir, entry.name)
        if (entry.isDirectory()) await walk(abs)
        else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) files.push(abs)
      }
    }
    await walk(srcRoot)
    // Comments are stripped before matching so a prose mention can neither
    // trip nor mask the scan, and the pattern tolerates newlines,
    // parentheses, and a chained unknown-cast between `as` and the brand.
    const FORGE =
      /\bas[\s(]+(?:unknown[\s)]+as[\s(]+)?(?:GatedSession|GatedCharges|FrozenBudgetPlans?)\b/
    const SANCTIONED = new Set([
      'policy/session-gate.ts', // the production mints
      '__tests__/helpers/session-gate-mints.ts', // the two test mints
    ])
    for (const file of files) {
      const rel = relative(srcRoot, file)
      if (SANCTIONED.has(rel)) continue
      const source = await readFile(file, 'utf-8')
      const stripped = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')
      expect(FORGE.test(stripped), `${rel} must not forge gate brands`).toBe(false)
    }
  })

  it('peekAll rejects ungated charges at the type level', () => {
    const engine = { peekAll: (_: unknown) => undefined } as unknown as {
      peekAll: (charges: GatedCharges) => unknown
    }
    const raw: BudgetCharge[] = [charge(budget('session'), 'k', 1)]
    // @ts-expect-error — raw BudgetCharge[] must not satisfy GatedCharges
    engine.peekAll(raw)
  })
})
