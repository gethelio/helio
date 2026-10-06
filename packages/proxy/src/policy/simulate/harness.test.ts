import { describe, it, expect } from 'vitest'
import { AuditStore } from '../../audit/store.js'
import type { AuditRecord } from '../../audit/types.js'
import { BudgetEngine, isBudgetPersistence } from '../../budget/engine.js'
import type { BudgetLedgerSink, BudgetMetaRow } from '../../budget/engine.js'
import { BudgetLedger } from '../../budget/ledger.js'
import { compileBudgets } from '../../budget/parser.js'
import { ToolBaselineStore } from '../../baseline/store.js'
import {
  at,
  candidateWith,
  expiredRow,
  mcpRow,
  sidebandRow,
} from '../../__tests__/helpers/simulation-rows.js'
import { ReplayLedger, createVirtualClock, simulatePolicy } from './harness.js'
import { trailAnnotationSource } from './context.js'
import type {
  AnnotationSource,
  PolicySimulationCandidate,
  PolicySimulationOptions,
  PolicySimulationResult,
  SimulatedOutcome,
} from './types.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const UNKNOWN: AnnotationSource = { resolve: () => ({ kind: 'unknown' }) }
const HOUR = 3_600_000
const T0_MS = Date.parse(at(0))

function openStore(): AuditStore {
  return new AuditStore({
    path: ':memory:',
    retention: '90d',
    includeResponses: true,
    cleanupIntervalMs: 0,
  })
}

function seed(store: AuditStore, rows: readonly AuditRecord[]): void {
  for (const row of rows) store.insert(row, row.created_at, row.id)
}

function simulate(
  store: AuditStore,
  candidate: PolicySimulationCandidate,
  extra: Partial<PolicySimulationOptions> = {},
): PolicySimulationResult {
  return simulatePolicy({ store, candidate, annotations: UNKNOWN, ...extra })
}

function outcome(
  policy_decision: string,
  block_reason: string | null,
  dry_run = false,
  ticket: SimulatedOutcome['ticket'] = 'none',
): SimulatedOutcome {
  return { policy_decision, block_reason, dry_run, ticket }
}

/** An executed MCP call that consumed a slot of a live rate rule. */
function rateRow(
  tool: string,
  minutes: number,
  live: { rule: string | null; index: number | null; current: number; limit?: number },
  overrides: Partial<AuditRecord> = {},
): AuditRecord {
  return mcpRow({
    tool_name: tool,
    timestamp: at(minutes),
    policy_decision: 'rate_limit',
    matched_rule: live.rule,
    matched_rule_index: live.index,
    evidence_chain: {
      rate_limit: {
        allowed: true,
        current: live.current,
        limit: live.limit ?? 2,
        window_ms: HOUR,
        reset_at_ms: 0,
      },
    },
    ...overrides,
  })
}

/** A refused MCP call under a live rate rule. */
function refusedRateRow(tool: string, minutes: number, rule: string, index: number): AuditRecord {
  return mcpRow({
    tool_name: tool,
    timestamp: at(minutes),
    policy_decision: 'rate_limit',
    block_reason: 'rate_limited',
    matched_rule: rule,
    matched_rule_index: index,
    upstream_response: null,
    upstream_http_status: null,
    upstream_latency_ms: null,
  })
}

/** A row the policy allowed and the pot refused live. */
function potRefusedRow(tool: string, minutes: number, amount: number): AuditRecord {
  return mcpRow({
    tool_name: tool,
    timestamp: at(minutes),
    tool_input: { amount },
    block_reason: 'budget_exceeded',
    upstream_response: null,
    upstream_http_status: null,
    upstream_latency_ms: null,
  })
}

const meta = (overrides: Partial<BudgetMetaRow> = {}): BudgetMetaRow => ({
  budget_name: 'pot',
  limit_amount: 100,
  currency: 'USD',
  window: '24h',
  key: 'global',
  epoch: 1,
  ...overrides,
})

const potYaml = (name: string, limit: number, onExceed: 'deny' | 'require_approval', tool = '*') =>
  `  - name: ${name}\n    limit: ${String(limit)}\n    currency: USD\n    window: 24h\n    key: global\n    on_exceed: ${onExceed}\n    contributors:\n      - match: { tool: '${tool}' }\n        field: '$.amount'`

const sessionRateRule = (name: string, tool: string, maxCalls: number) =>
  `    - name: ${name}\n      match: { tool: '${tool}' }\n      action: rate_limit\n      limits: { max_calls: ${String(maxCalls)}, window: 1h, key: session }`

const denyRule = (tool: string) =>
  `    - name: deny-${tool}\n      match: { tool: '${tool}' }\n      action: deny`

// ---------------------------------------------------------------------------
// T3.1 The write-noop ledger wrapper
// ---------------------------------------------------------------------------

describe('ReplayLedger', () => {
  it('carries the persistence contract, swallows every write, and bounds every read', () => {
    const store = openStore()
    try {
      const inner = new BudgetLedger({ database: store.database, now: () => T0_MS })
      inner.writeMeta(meta())
      store.insert(mcpRow({ timestamp: at(-60) }), at(-60), 'early')
      store.insert(mcpRow({ timestamp: at(5) }), at(5), 'late')
      inner.commitAll([
        {
          budget_name: 'pot',
          bucket_key: 'budget:pot:global',
          kind: 'spend',
          amount: 10,
          currency: 'USD',
          tool_name: 't',
          origin: 'mcp',
          audit_record_id: 'early',
          timestamp: at(-60),
          timestamp_ms: T0_MS + 1,
          generation: 1,
        },
        {
          budget_name: 'pot',
          bucket_key: 'budget:pot:global',
          kind: 'spend',
          amount: 20,
          currency: 'USD',
          tool_name: 't',
          origin: 'mcp',
          audit_record_id: 'late',
          timestamp: at(5),
          timestamp_ms: T0_MS + 5 * 60_000,
          generation: 1,
        },
      ])
      const clock = createVirtualClock(T0_MS)
      const wrapper = new ReplayLedger(inner, clock, { iso: at(0) })
      expect(isBudgetPersistence(wrapper)).toBe(true)
      expect(wrapper.readMeta('pot')).toEqual(meta())
      expect(wrapper.readAllMeta()).toEqual([meta()])
      expect(wrapper.maxEventEpoch('pot')).toBe(1)
      expect(wrapper.replayDurationEvents('pot', 1, 0).map((event) => event.amount)).toEqual([10])
      expect(wrapper.replaySessionBuckets('pot', 1)).toEqual([
        { bucket_key: 'budget:pot:global', total: 10, last_activity_ms: T0_MS + 1 },
      ])

      wrapper.writeMeta(meta({ epoch: 9 }))
      clock.set(T0_MS + 7)
      wrapper.writeMetaBatch([meta({ epoch: 9 })])
      wrapper.recordBucketGc('pot', 'budget:pot:global', 1)
      wrapper.commitAll([])
      expect(wrapper.writes).toEqual([
        { method: 'writeMeta', at: T0_MS },
        { method: 'writeMetaBatch', at: T0_MS + 7 },
        { method: 'recordBucketGc', at: T0_MS + 7 },
        { method: 'commitAll', at: T0_MS + 7 },
      ])
      expect(inner.readMeta('pot')).toEqual(meta())
      expect(store.database.prepare('SELECT COUNT(*) AS n FROM budget_events').get()).toEqual({
        n: 2,
      })
    } finally {
      store.close()
    }
  })

  it('a sink without the write methods is not persistence, and hydrate is a no-op on it', () => {
    const stub: BudgetLedgerSink = { commitAll: () => {} }
    expect(isBudgetPersistence(stub)).toBe(false)
    const engine = new BudgetEngine({
      budgets: compileBudgets([
        {
          name: 'pot',
          limit: 100,
          currency: 'USD',
          window: '24h',
          key: 'global',
          on_exceed: 'deny',
          contributors: [{ match: { tool: '*' }, field: '$.amount' }],
        },
      ]),
      now: () => T0_MS,
      cleanupIntervalMs: 0,
      ledger: stub,
    })
    engine.hydrate()
    expect(engine.listStates()).toEqual([expect.objectContaining({ name: 'pot', buckets: [] })])
    engine.close()
  })
})

// ---------------------------------------------------------------------------
// T3.2 Clock parking
// ---------------------------------------------------------------------------

describe('clock parking before hydrate', () => {
  function potHistory(store: AuditStore): void {
    const ledger = new BudgetLedger({ database: store.database, now: () => T0_MS })
    ledger.writeMeta(meta({ limit_amount: 200 }))
    const earlier = mcpRow({
      tool_name: 'pay',
      timestamp: at(-60),
      tool_input: { amount: 100 },
      config_sha256: 'b'.repeat(64),
    })
    const straddle = mcpRow({
      tool_name: 'pay',
      timestamp: at(-30),
      tool_input: { amount: 50 },
      config_sha256: 'b'.repeat(64),
    })
    const inEpoch = mcpRow({ tool_name: 'pay', timestamp: at(10), tool_input: { amount: 30 } })
    const refused = potRefusedRow('pay', 20, 25)
    seed(store, [earlier, straddle, inEpoch, refused])
    const row = (record: AuditRecord, amount: number, commitMs: number) => ({
      budget_name: 'pot',
      bucket_key: 'budget:pot:global',
      kind: 'spend' as const,
      amount,
      currency: 'USD',
      tool_name: 'pay',
      origin: 'mcp',
      audit_record_id: record.id,
      timestamp: record.timestamp,
      timestamp_ms: commitMs,
      generation: 1,
    })
    ledger.commitAll([
      row(earlier, 100, Date.parse(at(-60))),
      // The straddle: started before the epoch, committed after its first row.
      row(straddle, 50, T0_MS + 60_000),
      row(inEpoch, 30, Date.parse(at(10))),
    ])
  }
  const candidate = candidateWith({ budgets: potYaml('pot', 200, 'deny', 'pay') })

  it('loads the earlier calls and the straddling commit once, and never the epoch its replay charges', () => {
    const store = openStore()
    try {
      potHistory(store)
      const result = simulate(store, candidate)
      expect(result.replayed).toBe(2)
      expect(result.rows.map((row) => row.simulated)).toEqual([
        outcome('allow', null),
        outcome('allow', 'budget_exceeded'),
      ])
      expect(result.deltas).toEqual([])
    } finally {
      store.close()
    }
  })

  it('parked on the wall clock, the lookback misses the epoch and the pot starts empty', () => {
    const store = openStore()
    try {
      potHistory(store)
      const parked = createVirtualClock(T0_MS)
      const walled = createVirtualClock(Date.now())
      const budgets = compileBudgets(candidate.config.budgets)
      const inner = new BudgetLedger({ database: store.database })
      const atT0 = new BudgetEngine({
        budgets,
        now: () => parked.now(),
        cleanupIntervalMs: 0,
        ledger: new ReplayLedger(inner, parked, { iso: at(0) }),
      })
      const atWall = new BudgetEngine({
        budgets,
        now: () => walled.now(),
        cleanupIntervalMs: 0,
        ledger: new ReplayLedger(inner, walled, { iso: at(0) }),
      })
      atT0.hydrate()
      atWall.hydrate()
      expect(atT0.listStates()[0]?.buckets.map((bucket) => bucket.spent)).toEqual([150])
      expect(atWall.listStates()[0]?.buckets).toEqual([])
      atT0.close()
      atWall.close()
    } finally {
      store.close()
    }
  })
})

// ---------------------------------------------------------------------------
// T3.3 The gate order and every simulated quadruple
// ---------------------------------------------------------------------------

describe('the simulated quadruple', () => {
  function one(
    row: AuditRecord,
    candidate: PolicySimulationCandidate,
    extra: Partial<PolicySimulationOptions> = {},
  ) {
    const store = openStore()
    try {
      seed(store, [row])
      const result = simulate(store, candidate, extra)
      const simulated = result.rows[0]
      if (!simulated) throw new Error('no replayed row')
      return { result, row: simulated }
    } finally {
      store.close()
    }
  }

  it('dry run: the action with no block, peeked only', () => {
    const global = candidateWith({ policies: '  dry_run: true', rules: denyRule('send_email') })
    const stored = mcpRow({ policy_decision: 'deny', dry_run: true, upstream_response: null })
    expect(one(stored, global).row.simulated).toEqual(outcome('deny', null, true))
    const perRule = candidateWith({
      rules: "    - match: { tool: 'send_email' }\n      action: dry_run",
    })
    expect(one(mcpRow(), perRule).row.simulated).toEqual(outcome('dry_run', null, true))
  })

  it('session block, evidence blocks and the drift block, with the sideband vocabulary', () => {
    const evidence = candidateWith({
      rules:
        "    - name: grounded\n      match: { tool: 'send_email' }\n      action: allow\n      evidence: { requires: ['k'] }",
    })
    expect(one(mcpRow({ session_id: null }), evidence).row.simulated).toEqual(
      outcome('deny', 'policy_denied'),
    )
    expect(one(mcpRow(), evidence).row.simulated).toEqual(outcome('deny', 'evidence_missing'))
    const expired = mcpRow({
      evidence_chain: {
        blocked: true,
        evidence: { required: ['k'], found: [], missing: [], expired: ['k'] },
      },
    })
    expect(one(expired, evidence).row.simulated).toEqual(outcome('deny', 'evidence_expired'))
    const dependency = candidateWith({
      rules:
        "    - name: chained\n      match: { tool: 'send_email' }\n      action: allow\n      requires: ['lookup']",
    })
    expect(one(mcpRow(), dependency).row.simulated).toEqual(outcome('deny', 'dependency_missing'))
    expect(one(sidebandRow(), dependency).row.simulated).toEqual(outcome('deny', 'policy_denied'))
    expect(one(sidebandRow(), evidence).row.simulated).toEqual(outcome('deny', 'policy_denied'))
    const drifted = mcpRow({
      evidence_chain: {
        tool_drift: {
          mode: 'block',
          changes: [{ aspect: 'inputSchema', baseline: 1, current: 2 }],
        },
      },
    })
    expect(one(drifted, candidateWith({})).row.simulated).toEqual(
      outcome('deny', 'tool_definition_drift'),
    )
    expect(one(mcpRow(), candidateWith({ rules: denyRule('send_email') })).row.simulated).toEqual(
      outcome('deny', 'policy_denied'),
    )
  })

  const approvalRule =
    "    - name: gated\n      match: { tool: 'send_email' }\n      action: require_approval\n      approval: { channel: dashboard }"
  const approvalCandidate = candidateWith({ rules: approvalRule })

  it('replays a rule ticket from the recorded answer on the MCP door', () => {
    const held = (status: string, blockReason: string | null) =>
      mcpRow({
        policy_decision: 'require_approval',
        approval_status: status,
        block_reason: blockReason,
        matched_rule: 'gated',
        matched_rule_index: 0,
        upstream_response: blockReason ? null : { jsonrpc: '2.0', id: 1, result: {} },
      })
    for (const [status, reason] of [
      ['approved', null],
      ['break_glass', null],
    ] as const) {
      const { row } = one(held(status, reason), approvalCandidate)
      expect(row.simulated).toEqual(outcome('require_approval', null, false, 'rule'))
      expect(row.ticket_answer).toBe('recorded')
    }
    for (const [status, reason] of [
      ['denied', 'approval_denied'],
      ['timeout', 'approval_timeout'],
      ['client_disconnected', 'client_disconnected'],
      ['shutdown_cancelled', 'shutdown_cancelled'],
    ] as const) {
      const { row } = one(held(status, reason), approvalCandidate)
      expect(row.simulated).toEqual(outcome('require_approval', reason, false, 'rule'))
      expect(row.ticket_answer).toBe('recorded')
    }
  })

  it('replays a rule ticket on the sideband, cancelled included', () => {
    const held = (status: string, blockReason: string | null) =>
      sidebandRow({
        policy_decision: 'require_approval',
        approval_status: status,
        block_reason: blockReason,
        matched_rule: 'gated',
        matched_rule_index: 0,
        upstream_response: null,
        ...(blockReason ? {} : { upstream_error: null }),
      })
    expect(one(held('approved', null), approvalCandidate).row.simulated).toEqual(
      outcome('require_approval', null, false, 'rule'),
    )
    for (const [status, reason] of [
      ['denied', 'approval_denied'],
      ['timeout', 'approval_timeout'],
      ['cancelled', 'cancelled'],
    ] as const) {
      expect(one(held(status, reason), approvalCandidate).row.simulated).toEqual(
        outcome('require_approval', reason, false, 'rule'),
      )
    }
  })

  it('raises an unanswered rule ticket on a row nobody was asked about', () => {
    const { row } = one(mcpRow(), approvalCandidate)
    expect(row.simulated).toEqual(outcome('require_approval', null, false, 'rule'))
    expect(row.ticket_answer).toBe('unanswered')
    expect(row.stored).toEqual(outcome('allow', null))
  })

  it('rate and spend: allowed, refused, invalid amount and session unresolved', () => {
    const rate = candidateWith({
      rules:
        "    - name: paced\n      match: { tool: 'send_email' }\n      action: rate_limit\n      limits: { max_calls: 2, window: 1h }",
    })
    const store = openStore()
    try {
      seed(store, [
        mcpRow({ timestamp: at(0) }),
        mcpRow({ timestamp: at(1) }),
        mcpRow({ timestamp: at(2) }),
      ])
      expect(simulate(store, rate).rows.map((row) => row.simulated)).toEqual([
        outcome('rate_limit', null),
        outcome('rate_limit', null),
        outcome('rate_limit', 'rate_limited'),
      ])
    } finally {
      store.close()
    }
    const sessionRate = candidateWith({ rules: sessionRateRule('paced', 'send_email', 2) })
    expect(one(mcpRow({ session_id: null }), sessionRate).row.simulated).toEqual(
      outcome('rate_limit', 'session_unresolved'),
    )
    const spend = candidateWith({
      rules:
        "    - name: capped\n      match: { tool: 'send_email' }\n      action: spend_limit\n      limits: { max_spend: { field: '$.amount', limit: 50, currency: USD, window: 1h } }",
    })
    expect(one(mcpRow({ tool_input: { amount: 20 } }), spend).row.simulated).toEqual(
      outcome('spend_limit', null),
    )
    expect(one(mcpRow({ tool_input: { amount: 60 } }), spend).row.simulated).toEqual(
      outcome('spend_limit', 'spend_limited'),
    )
    expect(one(mcpRow({ tool_input: { amount: 'x' } }), spend).row.simulated).toEqual(
      outcome('spend_limit', 'spend_limited'),
    )
    expect(one(mcpRow({ tool_input: { amount: -1 } }), spend).row.simulated).toEqual(
      outcome('spend_limit', 'spend_limited'),
    )
    const sessionSpend = candidateWith({
      rules:
        "    - name: capped\n      match: { tool: 'send_email' }\n      action: spend_limit\n      limits: { max_spend: { field: '$.amount', limit: 50, currency: USD, window: 1h, key: session } }",
    })
    expect(
      one(mcpRow({ session_id: null, tool_input: { amount: 1 } }), sessionSpend).row.simulated,
    ).toEqual(outcome('spend_limit', 'session_unresolved'))
  })

  it('budget deny, and session unresolved on a session-keyed pot', () => {
    const deny = candidateWith({ budgets: potYaml('pot', 10, 'deny') })
    expect(one(mcpRow({ tool_input: { amount: 20 } }), deny).row.simulated).toEqual(
      outcome('allow', 'budget_exceeded'),
    )
    expect(one(mcpRow({ tool_input: { amount: 'x' } }), deny).row.simulated).toEqual(
      outcome('allow', 'budget_exceeded'),
    )
    const sessionPot = candidateWith({
      budgets: potYaml('pot', 10, 'deny').replace('key: global', 'key: session'),
    })
    expect(
      one(mcpRow({ session_id: null, tool_input: { amount: 1 } }), sessionPot).row.simulated,
    ).toEqual(outcome('allow', 'session_unresolved'))
  })

  const breaching = candidateWith({ budgets: potYaml('pot', 10, 'require_approval') })

  it('replays a budget ticket from budget_approval on the MCP door and from approval_status on a sideband budget-only row', () => {
    const granted = mcpRow({
      tool_input: { amount: 20 },
      approval_status: 'approved',
      approved_by: 'ops',
      evidence_chain: {
        budget_approval: { ticket_id: 't', status: 'approved' },
        budgets: [{ name: 'pot', kind: 'approved_overage', allowed: false }],
      },
    })
    const mcp = one(granted, breaching)
    expect(mcp.row.simulated).toEqual(outcome('allow', null, false, 'budget'))
    expect(mcp.row.ticket_answer).toBe('recorded')
    expect(mcp.result.deltas).toEqual([])
    const refused = mcpRow({
      tool_input: { amount: 20 },
      approval_status: 'denied',
      block_reason: 'budget_exceeded',
      upstream_response: null,
      evidence_chain: {
        budget_approval: { ticket_id: 't', status: 'denied', denial_reason: 'no' },
      },
    })
    expect(one(refused, breaching).row.simulated).toEqual(
      outcome('allow', 'budget_exceeded', false, 'budget'),
    )
    const sideband = sidebandRow({
      tool_input: { amount: 20 },
      approval_status: 'approved',
      evidence_chain: { budgets: [{ name: 'pot', kind: 'approved_overage', allowed: false }] },
    })
    const sb = one(sideband, breaching)
    expect(sb.row.simulated).toEqual(outcome('allow', null, false, 'budget'))
    expect(sb.result.deltas).toEqual([])
    const sidebandDenied = sidebandRow({
      tool_input: { amount: 20 },
      approval_status: 'denied',
      block_reason: 'budget_exceeded',
      upstream_response: null,
      evidence_chain: { budgets: [{ name: 'pot', allowed: false }] },
    })
    expect(one(sidebandDenied, breaching).row.simulated).toEqual(
      outcome('allow', 'budget_exceeded', false, 'budget'),
    )
  })

  const mergedCandidate = candidateWith({
    rules: approvalRule,
    budgets: potYaml('pot', 10, 'require_approval'),
  })

  it('a merged sideband ticket answers both gates through its committed breach, and is never both', () => {
    for (const [status, kind] of [
      ['approved', 'approved_overage'],
      ['break_glass', 'spend'],
    ] as const) {
      const merged = sidebandRow({
        tool_input: { amount: 20 },
        policy_decision: 'require_approval',
        approval_status: status,
        matched_rule: 'gated',
        matched_rule_index: 0,
        evidence_chain: { budgets: [{ name: 'pot', kind, allowed: false }] },
      })
      const { row, result } = one(merged, mergedCandidate)
      expect(row.simulated).toEqual(outcome('require_approval', null, false, 'rule'))
      expect(row.ticket_answer).toBe('recorded')
      expect(result.deltas).toEqual([])
    }
  })

  it('a clean MCP approval is equal under an identical candidate and asks an unanswered budget ticket under a breaching pot', () => {
    const clean = mcpRow({
      tool_input: { amount: 20 },
      policy_decision: 'require_approval',
      approval_status: 'approved',
      approved_by: 'ops',
      matched_rule: 'gated',
      matched_rule_index: 0,
    })
    const same = one(clean, approvalCandidate)
    expect(same.row.simulated).toEqual(outcome('require_approval', null, false, 'rule'))
    expect(same.result.deltas).toEqual([])
    const widened = one(clean, mergedCandidate)
    expect(widened.row.simulated).toEqual(outcome('require_approval', null, false, 'both'))
    expect(widened.row.ticket_answer).toBe('unanswered')
    expect(widened.result.deltas).toHaveLength(1)
  })

  it('a sideband budget denial is not copied onto a rule gate the candidate newly holds', () => {
    const denied = sidebandRow({
      tool_input: { amount: 20 },
      approval_status: 'denied',
      block_reason: 'budget_exceeded',
      upstream_response: null,
      evidence_chain: { budgets: [{ name: 'pot', allowed: false }] },
    })
    const { row } = one(denied, mergedCandidate)
    expect(row.simulated).toEqual(outcome('require_approval', null, false, 'rule'))
    expect(row.ticket_answer).toBe('unanswered')
  })

  it('an unanswered budget ticket is held, never budget_exceeded', () => {
    const { row } = one(mcpRow({ tool_input: { amount: 20 } }), breaching)
    expect(row.simulated).toEqual(outcome('allow', null, false, 'budget'))
    expect(row.ticket_answer).toBe('unanswered')
  })
})

// ---------------------------------------------------------------------------
// T3.4 Virtual time
// ---------------------------------------------------------------------------

describe('virtual time', () => {
  it('slides a 24-hour window across rows 25 hours apart with no wall-clock wait', () => {
    const candidate = candidateWith({
      rules:
        "    - name: daily\n      match: { tool: 'send_email' }\n      action: rate_limit\n      limits: { max_calls: 1, window: 24h }",
    })
    const store = openStore()
    try {
      seed(store, [
        mcpRow({ timestamp: at(0) }),
        mcpRow({ timestamp: at(30) }),
        mcpRow({ timestamp: at(25 * 60) }),
      ])
      const clock = createVirtualClock(0)
      const started = Date.now()
      const result = simulate(store, candidate, { clock })
      expect(Date.now() - started).toBeLessThan(5_000)
      expect(result.rows.map((row) => row.simulated.block_reason)).toEqual([
        null,
        'rate_limited',
        null,
      ])
      expect(clock.now()).toBe(Date.parse(at(25 * 60)))
    } finally {
      store.close()
    }
  })
})

// ---------------------------------------------------------------------------
// T3.5 Cumulative state follows the recorded calls
// ---------------------------------------------------------------------------

describe('cumulative state', () => {
  /** Two consumed send_email slots under the live rule, then the probe rows. */
  function consumedHistory(
    liveRule: string | null,
    liveIndex: number | null,
    probes: readonly AuditRecord[],
    input: Record<string, unknown> = {},
  ): AuditStore {
    const store = openStore()
    seed(store, [
      rateRow(
        'send_email',
        0,
        { rule: liveRule, index: liveIndex, current: 1 },
        { tool_input: input },
      ),
      rateRow(
        'send_email',
        1,
        { rule: liveRule, index: liveIndex, current: 2 },
        { tool_input: input },
      ),
      ...probes,
    ])
    return store
  }

  it('a deny placed before a kept limit rule keeps the window the call consumed and moves the pot', () => {
    const store = consumedHistory(
      'limited',
      0,
      [refusedRateRow('read_email', 2, 'limited', 0), potRefusedRow('list_mail', 3, 30)],
      { amount: 40 },
    )
    try {
      const ledger = new BudgetLedger({ database: store.database, now: () => T0_MS })
      ledger.writeMeta(meta())
      const sends = [...store.iterateReplayRows({})].filter((row) => row.tool_name === 'send_email')
      ledger.commitAll(
        [...sends].map((row) => ({
          budget_name: 'pot',
          bucket_key: 'budget:pot:global',
          kind: 'spend' as const,
          amount: 40,
          currency: 'USD',
          tool_name: 'send_email',
          origin: 'mcp',
          audit_record_id: row.id,
          timestamp: row.timestamp,
          timestamp_ms: Date.parse(row.timestamp),
          generation: 1,
        })),
      )
      const candidate = candidateWith({
        rules: `${denyRule('send_email')}\n${sessionRateRule('limited', '*_email', 2)}`,
        budgets: potYaml('pot', 100, 'deny', '*'),
      })
      const result = simulate(store, candidate)
      expect(result.rows.map((row) => [row.tool_name, row.simulated.block_reason])).toEqual([
        ['send_email', 'policy_denied'],
        ['send_email', 'policy_denied'],
        ['read_email', 'rate_limited'],
        ['list_mail', 'budget_exceeded'],
      ])
    } finally {
      store.close()
    }
  })

  it('a deny, then a new rate rule, then the kept rule fills the kept window and not the new one', () => {
    const store = consumedHistory('limited', 0, [
      mcpRow({ tool_name: 'read_email', timestamp: at(2) }),
      refusedRateRow('list_email', 3, 'limited', 0),
    ])
    try {
      const candidate = candidateWith({
        rules: `${denyRule('send_email')}\n${sessionRateRule('fresh', 'read_email', 1)}\n${sessionRateRule('limited', '*_email', 2)}`,
      })
      const result = simulate(store, candidate)
      expect(
        result.rows.map((row) => [
          row.tool_name,
          row.simulated.policy_decision,
          row.simulated.block_reason,
        ]),
      ).toEqual([
        ['send_email', 'deny', 'policy_denied'],
        ['send_email', 'deny', 'policy_denied'],
        ['read_email', 'rate_limit', null],
        ['list_email', 'rate_limit', 'rate_limited'],
      ])
    } finally {
      store.close()
    }
  })

  it('fills nothing on the deny branch when the live row consumed no slot, named no rule, or the rule was renamed or narrowed', () => {
    const probe = mcpRow({ tool_name: 'read_email', timestamp: at(2) })
    const cases: ReadonlyArray<{
      readonly name: string
      readonly store: AuditStore
      readonly rules: string
    }> = [
      {
        name: 'a new limit rule the live rows never consumed',
        store: (() => {
          const s = openStore()
          seed(s, [
            mcpRow({ tool_name: 'send_email', timestamp: at(0) }),
            mcpRow({ tool_name: 'send_email', timestamp: at(1) }),
            probe,
          ])
          return s
        })(),
        rules: `${denyRule('send_email')}\n${sessionRateRule('fresh', '*_email', 2)}`,
      },
      {
        name: 'a null matched_rule',
        store: consumedHistory(null, null, [probe]),
        rules: `${denyRule('send_email')}\n${sessionRateRule('limited', '*_email', 2)}`,
      },
      {
        name: 'a renamed rule',
        store: consumedHistory('limited', 0, [probe]),
        rules: `${denyRule('send_email')}\n${sessionRateRule('limited-v2', '*_email', 2)}`,
      },
      {
        name: 'a narrowed match',
        store: consumedHistory('limited', 0, [probe]),
        rules: `${denyRule('send_email')}\n${sessionRateRule('limited', 'read_*', 2)}`,
      },
      {
        name: 'a live allow rule of the same name',
        store: (() => {
          const s = openStore()
          seed(s, [
            mcpRow({
              tool_name: 'send_email',
              timestamp: at(0),
              matched_rule: 'limited',
              matched_rule_index: 0,
            }),
            mcpRow({
              tool_name: 'send_email',
              timestamp: at(1),
              matched_rule: 'limited',
              matched_rule_index: 0,
            }),
            probe,
          ])
          return s
        })(),
        rules: `${denyRule('send_email')}\n${sessionRateRule('limited', '*_email', 2)}`,
      },
    ]
    for (const { name, store, rules } of cases) {
      try {
        const result = simulate(store, candidateWith({ rules }))
        const read = result.rows.find((row) => row.tool_name === 'read_email')
        expect(read?.simulated, name).toEqual(outcome('rate_limit', null))
      } finally {
        store.close()
      }
    }
  })

  it('a committed expired evaluation carrying a limiter block fills the candidate window', () => {
    const candidate = candidateWith({ rules: sessionRateRule('limited', 'send_email', 2) })
    const commit = (current: number) => ({
      rate_limit: { allowed: true, current, limit: 2, window_ms: HOUR, reset_at_ms: 0 },
    })
    const store = openStore()
    try {
      seed(store, [
        sidebandRow({
          tool_name: 'send_email',
          timestamp: at(0),
          policy_decision: 'rate_limit',
          matched_rule: 'limited',
          matched_rule_index: 0,
          evidence_chain: commit(1),
        }),
        expiredRow(true, {
          tool_name: 'send_email',
          timestamp: at(1),
          policy_decision: 'rate_limit',
          matched_rule: 'limited',
          matched_rule_index: 0,
          evidence_chain: { ...commit(2), sideband: { unreported: true, committed: true } },
        }),
        sidebandRow({
          tool_name: 'send_email',
          timestamp: at(2),
          policy_decision: 'rate_limit',
          block_reason: 'rate_limited',
          matched_rule: 'limited',
          matched_rule_index: 0,
          upstream_response: null,
        }),
      ])
      const result = simulate(store, candidate)
      expect(result.unreported).toBe(1)
      expect(result.replayed).toBe(2)
      expect(result.rows.map((row) => row.simulated.block_reason)).toEqual([null, 'rate_limited'])
      expect(result.deltas).toEqual([])
    } finally {
      store.close()
    }
  })

  it('a candidate allow on blocked rows moves nothing, and a new rate rule refuses the sixth executed call', () => {
    const blockedStore = openStore()
    try {
      seed(
        blockedStore,
        [0, 1, 2].map((minute) =>
          mcpRow({
            timestamp: at(minute),
            policy_decision: 'deny',
            block_reason: 'policy_denied',
            upstream_response: null,
          }),
        ),
      )
      const result = simulate(
        blockedStore,
        candidateWith({ rules: sessionRateRule('paced', 'send_email', 2) }),
      )
      expect(result.rows.map((row) => row.simulated)).toEqual([
        outcome('rate_limit', null),
        outcome('rate_limit', null),
        outcome('rate_limit', null),
      ])
    } finally {
      blockedStore.close()
    }
    const store = openStore()
    try {
      seed(
        store,
        [0, 1, 2, 3, 4, 5].map((minute) => mcpRow({ timestamp: at(minute) })),
      )
      const result = simulate(
        store,
        candidateWith({ rules: sessionRateRule('paced', 'send_email', 5) }),
      )
      expect(result.rows.map((row) => row.simulated.block_reason)).toEqual([
        null,
        null,
        null,
        null,
        null,
        'rate_limited',
      ])
      // Every decision moved from allow to rate_limit; one row is refused.
      expect(result.deltas).toHaveLength(6)
      expect(
        result.deltas.filter((delta) => delta.simulated.block_reason === 'rate_limited'),
      ).toHaveLength(1)
    } finally {
      store.close()
    }
  })

  it('a new pot breaches on the executed history, the ledger amount wins where a row exists, and the resolved amount applies elsewhere', () => {
    const store = openStore()
    try {
      seed(
        store,
        [0, 1, 2].map((minute) =>
          mcpRow({ tool_name: 'pay', timestamp: at(minute), tool_input: { amount: 40 } }),
        ),
      )
      const result = simulate(store, candidateWith({ budgets: potYaml('pot', 100, 'deny', 'pay') }))
      expect(result.rows.map((row) => row.simulated.block_reason)).toEqual([
        null,
        null,
        'budget_exceeded',
      ])
    } finally {
      store.close()
    }
    const priced = openStore()
    try {
      const first = mcpRow({ tool_name: 'pay', timestamp: at(0), tool_input: { amount: 10 } })
      const second = potRefusedRow('pay', 1, 20)
      seed(priced, [first, second])
      const ledger = new BudgetLedger({ database: priced.database, now: () => T0_MS })
      ledger.writeMeta(meta())
      // The live door charged 90 for the first call (a sideband actual_amount
      // override would store exactly this), and nothing for the second.
      ledger.commitAll([
        {
          budget_name: 'pot',
          bucket_key: 'budget:pot:global',
          kind: 'spend',
          amount: 90,
          currency: 'USD',
          tool_name: 'pay',
          origin: 'mcp',
          audit_record_id: first.id,
          timestamp: first.timestamp,
          timestamp_ms: T0_MS,
          generation: 1,
        },
      ])
      const candidate = candidateWith({
        budgets: `${potYaml('pot', 100, 'deny', 'pay')}\n${potYaml('new-pot', 25, 'deny', 'pay')}`,
      })
      const result = simulate(priced, candidate)
      // pot: 90 (ledger) + 20 = 110 > 100; new-pot: 10 (resolved) + 20 = 30 > 25.
      expect(result.rows.map((row) => row.simulated.block_reason)).toEqual([
        null,
        'budget_exceeded',
      ])
      expect(result.deltas).toEqual([])
      const narrower = simulate(
        priced,
        candidateWith({ budgets: potYaml('pot', 100, 'deny', 'pay') }),
      )
      expect(narrower.rows[1]?.simulated.block_reason).toBe('budget_exceeded')
    } finally {
      priced.close()
    }
  })
})

// ---------------------------------------------------------------------------
// T3.6 Epochs
// ---------------------------------------------------------------------------

describe('config epochs', () => {
  const A = 'a'.repeat(64)
  const B = 'b'.repeat(64)
  function threeHashes(): AuditStore {
    const store = openStore()
    seed(store, [
      mcpRow({ timestamp: at(0), config_sha256: A }),
      mcpRow({ timestamp: at(1), config_sha256: A }),
      mcpRow({ timestamp: at(2), config_sha256: B }),
      mcpRow({ timestamp: at(3), config_sha256: A }),
      mcpRow({ timestamp: at(4), config_sha256: null }),
      mcpRow({ timestamp: at(5), config_sha256: null }),
    ])
    return store
  }
  const candidate = candidateWith({})

  it('simulates the last run by default and names every run', () => {
    const store = threeHashes()
    try {
      const result = simulate(store, candidate)
      expect(result.replayed).toBe(2)
      expect(result.epochs).toEqual([
        {
          config_sha256: A,
          rows: 2,
          first_timestamp: at(0),
          last_timestamp: at(1),
          selected: false,
        },
        {
          config_sha256: B,
          rows: 1,
          first_timestamp: at(2),
          last_timestamp: at(2),
          selected: false,
        },
        {
          config_sha256: A,
          rows: 1,
          first_timestamp: at(3),
          last_timestamp: at(3),
          selected: false,
        },
        {
          config_sha256: null,
          rows: 2,
          first_timestamp: at(4),
          last_timestamp: at(5),
          selected: true,
        },
      ])
    } finally {
      store.close()
    }
  })

  it('selects the last run of a hash, the null bucket by null, and everything with all', () => {
    const store = threeHashes()
    try {
      const lastA = simulate(store, candidate, { epoch: { configSha256: A } })
      expect(lastA.replayed).toBe(1)
      expect(lastA.rows.map((row) => row.timestamp)).toEqual([at(3)])
      expect(lastA.epochs.map((epoch) => epoch.selected)).toEqual([false, false, true, false])
      const nulls = simulate(store, candidate, { epoch: { configSha256: null } })
      expect(nulls.rows.map((row) => row.timestamp)).toEqual([at(4), at(5)])
      const all = simulate(store, candidate, { epoch: 'all' })
      expect(all.replayed).toBe(6)
      expect(all.epochs.every((epoch) => epoch.selected)).toBe(true)
      const windowed = simulate(store, candidate, { window: { from: at(1), to: at(2) } })
      expect(windowed.rows.map((row) => row.timestamp)).toEqual([at(2)])
      expect(windowed.epochs).toHaveLength(2)
    } finally {
      store.close()
    }
  })

  it('answers an empty window with an empty result', () => {
    const store = openStore()
    try {
      const result = simulate(store, candidate)
      expect(result.replayed).toBe(0)
      expect(result.epochs).toEqual([])
      expect(result.rows).toEqual([])
      expect(result.skipped).toEqual({ rejected: 0, kill_switch: 0 })
    } finally {
      store.close()
    }
  })
})

// ---------------------------------------------------------------------------
// T3.7 Multi-upstream attribution
// ---------------------------------------------------------------------------

describe('multi-upstream attribution', () => {
  it('keys tool limits per door and reads per-door baselines', () => {
    const store = openStore()
    try {
      const baselines = new ToolBaselineStore({ database: store.database })
      baselines.insertNew(
        'crm',
        [
          {
            tool: 'get',
            definition: { name: 'get', annotations: { readOnlyHint: true } },
            fingerprint: 'a',
          },
        ],
        at(-60),
      )
      baselines.insertNew(
        'billing',
        [
          {
            tool: 'get',
            definition: { name: 'get', annotations: { readOnlyHint: false } },
            fingerprint: 'b',
          },
        ],
        at(-60),
      )
      seed(store, [
        mcpRow({ tool_name: 'get', upstream: 'crm', timestamp: at(0) }),
        mcpRow({ tool_name: 'get', upstream: 'billing', timestamp: at(1) }),
        mcpRow({ tool_name: 'get', upstream: 'crm', timestamp: at(2) }),
      ])
      const paced = candidateWith({
        rules:
          "    - name: paced\n      match: { tool: 'get' }\n      action: rate_limit\n      limits: { max_calls: 1, window: 1h }",
      })
      const result = simulate(store, paced)
      expect(result.rows.map((row) => [row.upstream, row.simulated.block_reason])).toEqual([
        ['crm', null],
        ['billing', null],
        ['crm', 'rate_limited'],
      ])
      const reads = candidateWith({
        rules:
          '    - name: reads\n      match: { annotations: { readOnlyHint: true } }\n      action: allow',
      })
      const byDoor = simulate(
        store,
        {
          ...reads,
          config: { ...reads.config, policies: { ...reads.config.policies, default: 'deny' } },
        },
        { annotations: trailAnnotationSource(store) },
      )
      expect(byDoor.rows.map((row) => [row.upstream, row.simulated.policy_decision])).toEqual([
        ['crm', 'allow'],
        ['billing', 'deny'],
        ['crm', 'allow'],
      ])
    } finally {
      store.close()
    }
  })
})

// ---------------------------------------------------------------------------
// T3.8 The delta rule
// ---------------------------------------------------------------------------

describe('the delta rule', () => {
  it('a removed pot makes a granted ticket a delta on the fourth member alone', () => {
    const store = openStore()
    try {
      seed(store, [
        mcpRow({
          tool_input: { amount: 20 },
          approval_status: 'approved',
          evidence_chain: { budget_approval: { ticket_id: 't', status: 'approved' } },
        }),
      ])
      const result = simulate(store, candidateWith({}))
      expect(result.deltas).toHaveLength(1)
      expect(result.deltas[0]?.stored).toEqual(outcome('allow', null, false, 'budget'))
      expect(result.deltas[0]?.simulated).toEqual(outcome('allow', null, false, 'none'))
      expect(result.deltas[0]?.ticket_answer).toBeNull()
    } finally {
      store.close()
    }
  })

  it('a new ticket is a delta with ticket_answer unanswered; a replayed one is none', () => {
    const store = openStore()
    try {
      seed(store, [mcpRow({ tool_input: { amount: 20 } })])
      const added = simulate(
        store,
        candidateWith({ budgets: potYaml('pot', 10, 'require_approval') }),
      )
      expect(added.deltas.map((delta) => delta.ticket_answer)).toEqual(['unanswered'])
      const same = simulate(store, candidateWith({}))
      expect(same.deltas).toEqual([])
    } finally {
      store.close()
    }
  })

  it('counts the lines the default collector swallows and hands them to a given collector', () => {
    const store = openStore()
    try {
      seed(store, [mcpRow({ tool_name: 'drop_table' })])
      const flagged = candidateWith({ policies: '  flag_destructive: log' })
      expect(simulate(store, flagged).warnings_suppressed).toBe(1)
      const lines: string[] = []
      expect(
        simulate(store, flagged, { warn: (line) => lines.push(line) }).warnings_suppressed,
      ).toBe(0)
      expect(lines).toEqual(['[helio] Destructive tool detected: drop_table (no matching rule)'])
    } finally {
      store.close()
    }
  })
})
