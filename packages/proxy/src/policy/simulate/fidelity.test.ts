import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { AuditStore } from '../../audit/store.js'
import type { AuditRecord } from '../../audit/types.js'
import type { ConfigSource } from '../../config/loader.js'
import { RateLimiter } from '../rate-limiter.js'
import { SpendLimiter } from '../spend-limiter.js'
import {
  ROW_HASH,
  at,
  candidateWith,
  mcpRow,
  sidebandRow,
} from '../../__tests__/helpers/simulation-rows.js'
import {
  FIDELITY_DIMENSIONS,
  FIDELITY_SENTENCES,
  HistoricalTracker,
  createLimitPin,
  formatBudgetCheckLine,
  formatConfigEpochNotice,
  renderFidelityLines,
  ruleLabel,
  subjectOf,
} from './fidelity.js'
import { simulatePolicy } from './harness.js'
import type { AnnotationSource, PolicySimulationCandidate } from './types.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PAGE = readFileSync(
  new URL('../../../../../docs/policy-fidelity.md', import.meta.url),
  'utf-8',
)
const UNKNOWN: AnnotationSource = { resolve: () => ({ kind: 'unknown' }) }
const HOUR = 3_600_000

function source(raw: string): ConfigSource {
  return { raw, sha256: createHash('sha256').update(raw, 'utf-8').digest('hex') }
}

/** The live config the consumed rows were decided under, hashed to ROW_HASH by fiat. */
const LIVE_RULES = [
  'policies:',
  '  rules:',
  '    - name: paced',
  '      action: rate_limit',
  '      limits: { max_calls: 5, window: 1h, key: session }',
  '    - name: capped',
  '      action: spend_limit',
  "      limits: { max_spend: { field: '$.amount', limit: 100, currency: USD, window: 1h } }",
  '    - name: hidden',
  '      action: spend_limit',
  "      limits: { max_spend: { field: '${AMOUNT_FIELD}', limit: 100, currency: USD, window: 1h } }",
  '    - name: odd',
  '      action: spend_limit',
  '      limits: { max_spend: { field: 5, limit: 100, currency: USD, window: 1h } }',
  '    - name: plain',
  '      action: allow',
  '    - name: by-sender',
  '      action: spend_limit',
  "      limits: { max_spend: { field: '$.cost', limit: 1, currency: USD, window: 1h, key: sender_id } }",
].join('\n')
const LIVE: ConfigSource = { raw: LIVE_RULES, sha256: ROW_HASH }

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

function rateBlock(current: number, limit = 5) {
  return { rate_limit: { allowed: true, current, limit, window_ms: HOUR, reset_at_ms: 0 } }
}

function spendBlock(currentSpend: number, limit = 100) {
  return {
    spend_limit: {
      allowed: true,
      current_spend: currentSpend,
      limit,
      window_ms: HOUR,
      reset_at_ms: 0,
    },
  }
}

// ---------------------------------------------------------------------------
// T4.1 The three sentences and the six dimensions
// ---------------------------------------------------------------------------

describe('the frozen sentences', () => {
  it('are byte-equal to the fidelity page', () => {
    for (const template of Object.values(FIDELITY_SENTENCES)) expect(PAGE).toContain(template)
  })

  it('name exactly the six dimensions the page lists', () => {
    expect(FIDELITY_DIMENSIONS).toHaveLength(6)
    for (const dimension of FIDELITY_DIMENSIONS) expect(PAGE).toContain(`| \`${dimension}\` `)
    expect(new Set(FIDELITY_DIMENSIONS).size).toBe(6)
  })

  it('render one line per warning, then the skip class, then the unreported class', () => {
    const lines = renderFidelityLines({
      warnings: [
        {
          rule: 'reads',
          dimension: 'tool annotations',
          subject: 'tool "get" on door "crm"',
          calls: 2,
          instants: [at(0), at(1)],
        },
        {
          rule: 'default',
          dimension: 'tool definition drift',
          subject: 'tool "sb_flip" on origin "lab-adapter"',
          calls: 1,
          instants: [at(2)],
        },
      ],
      skipped: { rejected: 2, kill_switch: 1 },
      unreported: 3,
    })
    expect(lines).toEqual([
      'Could not fully evaluate rule "reads" on 2 call(s): tool annotations was not recorded for tool "get" on door "crm". These calls count as unverified, never as passed.',
      'Could not fully evaluate rule "default" on 1 call(s): tool definition drift was not recorded for tool "sb_flip" on origin "lab-adapter". These calls count as unverified, never as passed.',
      'Skipped 3 row(s) that never entered policy evaluation: 2 rejected, 1 refused by the kill switch.',
      '3 sideband evaluation(s) were decided but never reported (evaluation_expired); their outcome is unknown.',
    ])
    expect(
      renderFidelityLines({
        warnings: [],
        skipped: { rejected: 0, kill_switch: 0 },
        unreported: 0,
      }),
    ).toEqual([
      'Skipped 0 row(s) that never entered policy evaluation: 0 rejected, 0 refused by the kill switch.',
      '0 sideband evaluation(s) were decided but never reported (evaluation_expired); their outcome is unknown.',
    ])
  })

  it('labels an unnamed rule by index, no rule as default, and subjects by door or origin', () => {
    expect(ruleLabel({ index: 3, match: {}, action: 'allow' })).toBe('rule[3]')
    expect(ruleLabel({ index: 3, name: 'reads', match: {}, action: 'allow' })).toBe('reads')
    expect(ruleLabel(undefined)).toBe('default')
    expect(subjectOf('get', 'crm', 'mcp')).toBe('tool "get" on door "crm"')
    expect(subjectOf('get', null, 'mcp')).toBe('tool "get"')
    expect(subjectOf('sb_flip', null, 'lab-adapter')).toBe('tool "sb_flip" on origin "lab-adapter"')
  })
})

// ---------------------------------------------------------------------------
// T4.2 The pin
// ---------------------------------------------------------------------------

describe('the pin', () => {
  const pin = createLimitPin([LIVE, source('a: [unclosed')])
  const row = (index: number | null, hash: string | null = ROW_HASH) =>
    mcpRow({ matched_rule_index: index, config_sha256: hash })

  it('reads the key type and the literal spend field from the config that hashes to the row', () => {
    expect(pin.resolve(row(0), 'rate')).toEqual({ keyType: 'session' })
    expect(pin.resolve(row(1), 'spend')).toEqual({ keyType: 'tool', field: '$.amount' })
    expect(pin.resolve(row(5), 'spend')).toEqual({ keyType: 'sender_id', field: '$.cost' })
    expect(pin.resolve(row(1), 'rate')).toEqual({ keyType: 'tool' })
  })

  it('fails on a ${VAR} field, a non-string field, a missing rule or limits, an unknown hash, a null hash and a file that does not load', () => {
    expect(pin.resolve(row(2), 'spend')).toBeNull()
    expect(pin.resolve(row(3), 'spend')).toBeNull()
    expect(pin.resolve(row(4), 'spend')).toBeNull()
    expect(pin.resolve(row(4), 'rate')).toBeNull()
    expect(pin.resolve(row(9), 'rate')).toBeNull()
    expect(pin.resolve(row(null), 'rate')).toBeNull()
    expect(pin.resolve(row(0, 'd'.repeat(64)), 'rate')).toBeNull()
    expect(pin.resolve(row(0, null), 'rate')).toBeNull()
    expect(pin.resolve(row(0, source('a: [unclosed').sha256), 'rate')).toBeNull()
  })

  it('a run given only a candidate whose hash differs names every consumed rate and spend row', () => {
    const store = openStore()
    try {
      seed(store, [
        mcpRow({
          timestamp: at(0),
          policy_decision: 'rate_limit',
          matched_rule: 'paced',
          matched_rule_index: 0,
          evidence_chain: rateBlock(1),
        }),
        mcpRow({
          timestamp: at(1),
          tool_name: 'pay',
          tool_input: { amount: 10 },
          policy_decision: 'spend_limit',
          matched_rule: 'capped',
          matched_rule_index: 1,
          evidence_chain: spendBlock(10),
        }),
      ])
      const candidate = candidateWith({})
      const unpinned = simulatePolicy({ store, candidate, annotations: UNKNOWN })
      expect(
        unpinned.fidelity.warnings.map((warning) => [warning.dimension, warning.subject]),
      ).toEqual([
        ['rate window', 'tool "send_email"'],
        ['spend amount', 'tool "pay"'],
      ])
      const pinned = simulatePolicy({ store, candidate, annotations: UNKNOWN, sources: [LIVE] })
      expect(pinned.fidelity.warnings).toEqual([])
    } finally {
      store.close()
    }
  })
})

// ---------------------------------------------------------------------------
// T4.3 The historical cross-check
// ---------------------------------------------------------------------------

describe('the historical cross-check', () => {
  function tracker() {
    return new HistoricalTracker(
      new RateLimiter({ now: () => Date.parse(at(0)), cleanupIntervalMs: 0 }),
      new SpendLimiter({ now: () => Date.parse(at(0)), cleanupIntervalMs: 0 }),
      createLimitPin([LIVE]),
    )
  }

  it('names a shared bucket whose other caller the trail does not hold under rate window', () => {
    const live = source(LIVE_RULES.replace('key: session', 'key: tool'))
    const shared = new HistoricalTracker(
      new RateLimiter({ now: () => Date.parse(at(0)), cleanupIntervalMs: 0 }),
      new SpendLimiter({ now: () => Date.parse(at(0)), cleanupIntervalMs: 0 }),
      createLimitPin([live]),
    )
    const first = sidebandRow({
      origin: 'a',
      tool_name: 't',
      config_sha256: live.sha256,
      policy_decision: 'rate_limit',
      matched_rule: 'paced',
      matched_rule_index: 0,
      evidence_chain: rateBlock(1),
    })
    const second = sidebandRow({
      origin: 'b',
      tool_name: 't',
      config_sha256: live.sha256,
      policy_decision: 'rate_limit',
      matched_rule: 'paced',
      matched_rule_index: 0,
      evidence_chain: rateBlock(3),
    })
    expect(shared.record(first, 'rate', 'paced')).toBeNull()
    expect(shared.record(second, 'rate', 'paced')).toEqual({
      rule: 'paced',
      dimension: 'rate window',
      subject: 'tool "t" on origin "b"',
    })
  })

  it('names an actual_amount override under spend amount, and a pinned row that meets its snapshot not at all', () => {
    const t = tracker()
    const met = mcpRow({
      tool_name: 'pay',
      tool_input: { amount: 10 },
      policy_decision: 'spend_limit',
      matched_rule: 'capped',
      matched_rule_index: 1,
      evidence_chain: spendBlock(10),
    })
    expect(t.record(met, 'spend', 'capped')).toBeNull()
    const overridden = sidebandRow({
      tool_name: 'pay',
      tool_input: { amount: 10 },
      policy_decision: 'spend_limit',
      matched_rule: 'capped',
      matched_rule_index: 1,
      evidence_chain: spendBlock(100),
    })
    expect(t.record(overridden, 'spend', 'capped')).toEqual({
      rule: 'capped',
      dimension: 'spend amount',
      subject: 'tool "pay" on origin "lab-adapter"',
    })
    const unresolvable = mcpRow({
      tool_name: 'pay',
      tool_input: {},
      policy_decision: 'spend_limit',
      matched_rule: 'capped',
      matched_rule_index: 1,
      evidence_chain: spendBlock(10),
    })
    expect(t.record(unresolvable, 'spend', 'capped')?.dimension).toBe('spend amount')
    const noBlock = mcpRow({
      policy_decision: 'rate_limit',
      matched_rule: 'paced',
      matched_rule_index: 0,
    })
    expect(t.record(noBlock, 'rate', 'paced')?.dimension).toBe('rate window')
  })
})

// ---------------------------------------------------------------------------
// T4.4 Privacy
// ---------------------------------------------------------------------------

describe('privacy', () => {
  it('renders no argument value, session id, record id or hash', () => {
    const store = openStore()
    try {
      const secretSession = 'SESSION-7f3a-SECRET'
      const rows = [
        sidebandRow({
          timestamp: at(0),
          session_id: secretSession,
          tool_input: { token: 'ARGUMENT-VALUE-9x' },
          origin: 'lab-adapter',
        }),
        mcpRow({
          timestamp: at(1),
          session_id: secretSession,
          tool_name: 'send_email',
          tool_input: { token: 'ARGUMENT-VALUE-9x' },
          policy_decision: 'rate_limit',
          matched_rule: 'paced',
          matched_rule_index: 0,
          evidence_chain: rateBlock(1),
        }),
        mcpRow({
          timestamp: at(2),
          tool_name: '<nameless>',
          policy_decision: 'rejected',
          block_reason: 'missing_tool_name',
        }),
      ]
      seed(store, rows)
      const candidate: PolicySimulationCandidate = candidateWith({
        policies: '  flag_destructive: log',
      })
      const result = simulatePolicy({ store, candidate, annotations: UNKNOWN })
      const rendered = [
        ...renderFidelityLines(result.fidelity),
        formatConfigEpochNotice(result.epochs),
        formatBudgetCheckLine(result.budget_checks),
      ].join('\n')
      expect(result.fidelity.warnings.length).toBeGreaterThan(0)
      for (const forbidden of [
        secretSession,
        'ARGUMENT-VALUE-9x',
        ROW_HASH,
        candidate.source.sha256,
        ...rows.map((row) => row.id),
      ]) {
        expect(rendered).not.toContain(forbidden)
      }
      expect(rendered).toContain('tool "send_email"')
      expect(rendered).toContain('1 rejected')
    } finally {
      store.close()
    }
  })
})

// ---------------------------------------------------------------------------
// T4.5 The notice and the pot line
// ---------------------------------------------------------------------------

describe('formatConfigEpochNotice', () => {
  const epoch = (
    hash: string | null,
    rows: number,
    first: string,
    last: string,
    selected: boolean,
  ) => ({
    config_sha256: hash,
    rows,
    first_timestamp: first,
    last_timestamp: last,
    first_rowid: 1,
    last_rowid: rows,
    selected,
  })

  it('names the simulated run and every other run, newest first, with the null bucket as unknown config', () => {
    const notice = formatConfigEpochNotice([
      epoch(
        `49f4aeb2${'0'.repeat(56)}`,
        40,
        '2026-08-21T12:00:00.000Z',
        '2026-08-26T09:00:00.000Z',
        false,
      ),
      epoch(null, 60, '2026-09-15T14:00:00.000Z', '2026-09-25T10:00:00.000Z', false),
      epoch(
        `cdf1b846${'0'.repeat(56)}`,
        253,
        '2026-09-29T13:00:00.000Z',
        '2026-10-05T11:50:00.000Z',
        true,
      ),
    ])
    expect(notice).toBe(
      [
        'Simulated the most recent config epoch only: config cdf1b846..., 2026-09-29 13:00 UTC to 2026-10-05 11:50 UTC, 253 calls.',
        'The window spans 2 other config epoch(s), not simulated:',
        '  unknown config: 60 calls, 2026-09-15 14:00 UTC to 2026-09-25 10:00 UTC',
        '  config 49f4aeb2...: 40 calls, 2026-08-21 12:00 UTC to 2026-08-26 09:00 UTC',
      ].join('\n'),
    )
    expect(PAGE).toContain(
      'Simulated the most recent config epoch only: config cdf1b846..., 2026-09-29 13:00 UTC to 2026-10-05 11:50 UTC, 253 calls.',
    )
    expect(PAGE).toContain('The window spans 2 other config epoch(s), not simulated:')
  })

  it('says one config epoch when the simulated run is not the latest, and nothing for one run or all runs', () => {
    const notice = formatConfigEpochNotice([
      epoch(
        `aaaaaaaa${'0'.repeat(56)}`,
        2,
        '2026-08-21T12:00:00.000Z',
        '2026-08-21T12:01:00.000Z',
        true,
      ),
      epoch(
        `bbbbbbbb${'0'.repeat(56)}`,
        1,
        '2026-08-22T12:00:00.000Z',
        '2026-08-22T12:00:00.000Z',
        false,
      ),
    ])
    expect(
      notice.startsWith(
        'Simulated one config epoch only: config aaaaaaaa..., 2026-08-21 12:00 UTC to 2026-08-21 12:01 UTC, 2 calls.',
      ),
    ).toBe(true)
    expect(formatConfigEpochNotice([epoch('a'.repeat(64), 5, at(0), at(1), true)])).toBe('')
    expect(
      formatConfigEpochNotice([
        epoch('a'.repeat(64), 5, at(0), at(1), true),
        epoch('b'.repeat(64), 5, at(2), at(3), true),
      ]),
    ).toBe('')
    expect(formatConfigEpochNotice([])).toBe('')
  })
})

describe('formatBudgetCheckLine', () => {
  it('counts the snapshots and names the pots in first-seen order, and is empty for none', () => {
    const line = formatBudgetCheckLine([
      { budget: 'agent-payments', timestamp: at(0), stored_spent: 10, simulated_spent: 12 },
      { budget: 'ops-spend', timestamp: at(1), stored_spent: 1, simulated_spent: 2 },
      { budget: 'agent-payments', timestamp: at(2), stored_spent: 20, simulated_spent: 22 },
    ])
    expect(line).toBe(
      'The rebuilt budget spend did not meet 3 recorded pot snapshot(s) on "agent-payments", "ops-spend"; those pots are unverified at those calls.',
    )
    expect(PAGE).toContain(line)
    expect(formatBudgetCheckLine([])).toBe('')
  })
})
