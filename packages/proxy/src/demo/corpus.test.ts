import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import {
  DEMO_BUDGET_LIMIT,
  DEMO_BUDGET_NAME,
  DEMO_BUDGET_WINDOW_MS,
  DEMO_CONFIG_FILE,
  DEMO_SESSIONS,
  DEMO_TOOLS,
  DEMO_UPSTREAMS,
  buildDemoCorpus,
} from './corpus.js'
import type { DemoAuditRow } from './corpus.js'
import { budgetBucketKey } from '../budget/engine.js'

// ---------------------------------------------------------------------------
// One corpus, built once: every assertion below reads it. The coverage
// items are the ticket's list (issue #397): a valid record_kind on every
// row, realistic tool_input, upstream, session_id, config_sha256 and
// flagged_destructive, sample data that says so, deterministic output.
// The shape of the current epoch is pinned here; that its columns are what
// the written config decides is proved by corpus-replay.test.ts.
// ---------------------------------------------------------------------------

const BASE = new Date('2026-09-24T12:00:00.000Z')
const HASH_C = createHash('sha256').update('the written helio-demo.yaml bytes').digest('hex')
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/

const corpus = buildDemoCorpus({ base: BASE, configSha256: HASH_C })
const rows = corpus.records
const calls = rows.filter((row) => row.record.record_kind === 'tool_call')
const under = (hash: string): readonly DemoAuditRow[] =>
  rows.filter((row) => row.record.config_sha256 === hash)
const inC = under(HASH_C)
const callsInC = inC.filter((row) => row.record.record_kind === 'tool_call')
const contributorsInC = callsInC.filter(
  (row) =>
    row.record.upstream === DEMO_UPSTREAMS.billing &&
    (row.record.tool_name === 'create_charge' || row.record.tool_name === 'refund_charge'),
)
const amountOf = (row: DemoAuditRow): number => (row.record.tool_input as { amount: number }).amount
const byTool = (name: string, set: readonly DemoAuditRow[] = rows): readonly DemoAuditRow[] =>
  set.filter((row) => row.record.tool_name === name)
const withinLast = (ms: number): readonly DemoAuditRow[] =>
  calls.filter((row) => new Date(row.created_at).getTime() >= BASE.getTime() - ms)

describe('buildDemoCorpus: the tool table', () => {
  it('names ten tools, five per door, with the two never-called ones', () => {
    expect(DEMO_TOOLS).toHaveLength(10)
    const crm = DEMO_TOOLS.filter((tool) => tool.upstream === DEMO_UPSTREAMS.crm).map((t) => t.name)
    const billing = DEMO_TOOLS.filter((tool) => tool.upstream === DEMO_UPSTREAMS.billing).map(
      (t) => t.name,
    )
    expect(crm).toEqual([
      'get_customer',
      'update_customer',
      'delete_customer',
      'export_customers',
      'merge_customers',
    ])
    expect(billing).toEqual([
      'get_invoice',
      'list_invoices',
      'send_invoice',
      'create_charge',
      'refund_charge',
    ])
  })

  it('gives export_customers no annotations, so MCP defaults it to destructive', () => {
    const tool = DEMO_TOOLS.find((t) => t.name === 'export_customers')
    expect(tool).toBeDefined()
    expect(tool?.annotations).toBeUndefined()
  })

  it('never calls merge_customers or list_invoices, which the upstream still lists', () => {
    expect(byTool('merge_customers')).toHaveLength(0)
    expect(byTool('list_invoices')).toHaveLength(0)
    expect(DEMO_TOOLS.map((t) => t.name)).toEqual(
      expect.arrayContaining(['merge_customers', 'list_invoices']),
    )
  })
})

describe('buildDemoCorpus: the coverage of the current epoch', () => {
  it('decides a read-only tool by allow-reads', () => {
    const reads = byTool('get_customer', inC)
    expect(reads.length).toBeGreaterThan(0)
    for (const row of reads) {
      expect(row.record.policy_decision).toBe('allow')
      expect(row.record.matched_rule).toBe('allow-reads')
      expect(row.record.matched_rule_index).toBe(0)
      expect(row.record.flagged_destructive).toBe(false)
    }
  })

  it('allows a mutation tool by the default with no rule', () => {
    const allowed = byTool('update_customer', inC).filter(
      (row) => row.record.policy_decision === 'allow',
    )
    expect(allowed.length).toBeGreaterThan(0)
    for (const row of allowed) expect(row.record.matched_rule).toBeNull()
  })

  it('denies delete_customer by block-destructive without flagging it (the file sets no flag_destructive)', () => {
    const denied = byTool('delete_customer', inC)
    expect(denied.length).toBeGreaterThan(0)
    for (const row of denied) {
      expect(row.record.policy_decision).toBe('deny')
      expect(row.record.block_reason).toBe('policy_denied')
      expect(row.record.matched_rule).toBe('block-destructive')
      expect(row.record.matched_rule_index).toBe(1)
      expect(row.record.flagged_destructive).toBe(false)
      expect(row.record.upstream_response).toBeNull()
    }
  })

  it('denies the annotation-free export_customers by block-destructive, unflagged', () => {
    const denied = byTool('export_customers', inC)
    expect(denied.length).toBeGreaterThan(0)
    for (const row of denied) {
      expect(row.record.flagged_destructive).toBe(false)
      expect(row.record.policy_decision).toBe('deny')
      expect(row.record.matched_rule).toBe('block-destructive')
    }
  })

  it('stores flagged_destructive false on every row of the current epoch', () => {
    for (const row of inC) expect(row.record.flagged_destructive, row.id).toBe(false)
  })

  it('carries no dry-run row (the file cannot emit one) and a few upstream 503 rows', () => {
    for (const row of inC) expect(row.record.dry_run, row.id).toBe(false)
    const errors = inC.filter((row) => row.record.upstream_http_status === 503)
    expect(errors.length).toBeGreaterThanOrEqual(2)
    for (const row of errors) {
      expect(row.record.upstream_error).toBeTruthy()
      expect(row.record.upstream_response).toBeNull()
      expect(row.record.policy_decision).toBe('allow')
    }
  })

  it('writes the budget refusals the way the store writes them: allow plus budget_exceeded', () => {
    const refused = calls.filter((row) => row.record.block_reason === 'budget_exceeded')
    expect(refused).toHaveLength(19)
    for (const row of refused) {
      expect(row.record.policy_decision).toBe('allow')
      expect(row.record.config_sha256).toBe(HASH_C)
      expect(['create_charge', 'refund_charge']).toContain(row.record.tool_name)
      expect(row.record.upstream).toBe(DEMO_UPSTREAMS.billing)
      expect(row.record.upstream_response).toBeNull()
      expect(row.record.upstream_http_status).toBeNull()
      expect(row.record.upstream_latency_ms).toBeNull()
      expect(row.record.upstream_error).toBeNull()
    }
    const labeled = refused.find(
      (row) => row.created_at === new Date(BASE.getTime() - 30 * MINUTE).toISOString(),
    )
    expect(labeled?.record.tool_name).toBe('create_charge')
    expect(labeled?.record.tool_input).toEqual({
      amount: 60,
      currency: 'USD',
      customer: 'cus_1077',
    })
  })

  it('fills the pot 172 minutes before the base on a refund of 21 against 487 committed', () => {
    const firstRefusal = contributorsInC.find(
      (row) => row.record.block_reason === 'budget_exceeded',
    )
    expect(firstRefusal?.record.tool_name).toBe('refund_charge')
    expect(amountOf(firstRefusal as DemoAuditRow)).toBe(21)
    expect(firstRefusal?.created_at).toBe(new Date(BASE.getTime() - 172 * MINUTE).toISOString())
    const fillMs = new Date(firstRefusal?.created_at ?? 0).getTime()
    const committedBefore = contributorsInC
      .filter(
        (row) =>
          row.record.block_reason === null &&
          new Date(row.created_at).getTime() < fillMs &&
          new Date(row.created_at).getTime() > fillMs - DEMO_BUDGET_WINDOW_MS,
      )
      .reduce((sum, row) => sum + amountOf(row), 0)
    expect(committedBefore).toBe(487)
    const after = contributorsInC.filter((row) => new Date(row.created_at).getTime() > fillMs)
    expect(after).toHaveLength(19)
    const fit = after.filter((row) => row.record.block_reason === null)
    expect(fit).toHaveLength(1)
    expect(fit[0]?.record.tool_name).toBe('refund_charge')
    expect(amountOf(fit[0] as DemoAuditRow)).toBe(11)
  })

  it('tallies the current epoch as the written config decides it', () => {
    expect(calls.filter((row) => row.record.config_sha256 === HASH_C)).toHaveLength(253)
    const tally = (predicate: (row: DemoAuditRow) => boolean): number =>
      callsInC.filter(predicate).length
    expect(
      tally((row) => row.record.policy_decision === 'allow' && row.record.block_reason === null),
    ).toBe(183)
    expect(tally((row) => row.record.block_reason === 'policy_denied')).toBe(50)
    expect(tally((row) => row.record.block_reason === 'budget_exceeded')).toBe(19)
    expect(tally((row) => row.record.policy_decision === 'rejected')).toBe(1)
    expect(tally((row) => row.record.dry_run)).toBe(0)
    expect(contributorsInC).toHaveLength(51)
    expect(rows).toHaveLength(357)
  })

  it('places over 100 tool calls across at least three pairs in the last four hours', () => {
    const recent = withinLast(4 * HOUR)
    expect(recent.length).toBeGreaterThan(100)
    const pairs = new Set(
      recent.map((row) => `${row.record.tool_name}@${row.record.upstream ?? ''}`),
    )
    expect(pairs.size).toBeGreaterThanOrEqual(3)
  })
})

describe('buildDemoCorpus: the history under the two earlier configs', () => {
  it('has three distinct config hashes, the newest equal to the given one', () => {
    const hashes = new Set(rows.map((row) => row.record.config_sha256))
    expect(hashes.size).toBe(3)
    expect(corpus.epochHashes.c).toBe(HASH_C)
    expect(corpus.configSha256).toBe(HASH_C)
    const newest = [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at))[0]
    expect(newest?.record.config_sha256).toBe(HASH_C)
  })

  it('runs the destructive tool unopposed under the first config', () => {
    const a = under(corpus.epochHashes.a)
    expect(a.length).toBeGreaterThan(0)
    const deletes = byTool('delete_customer', a)
    expect(deletes.length).toBeGreaterThan(0)
    for (const row of deletes) {
      expect(row.record.policy_decision).toBe('allow')
      expect(row.record.matched_rule).toBeNull()
      expect(row.record.flagged_destructive).toBe(true)
    }
    for (const row of a) expect(row.record.matched_rule).toBeNull()
  })

  it('holds four approved big-charge-approval rows under the second config', () => {
    const approved = under(corpus.epochHashes.b).filter(
      (row) => row.record.matched_rule === 'big-charge-approval',
    )
    expect(approved).toHaveLength(4)
    for (const row of approved) {
      expect(row.record.tool_name).toBe('create_charge')
      expect(row.record.policy_decision).toBe('require_approval')
      expect(row.record.approval_status).toBe('approved')
      expect(row.record.approved_by).toBe('demo-approver')
      expect(row.record.approval_wait_ms).toBeGreaterThan(0)
      expect((row.record.tool_input as { amount: number }).amount).toBe(750)
    }
  })

  it('records two applied reloads and one refused one, each titled by the config file', () => {
    const reloads = rows.filter((row) => row.record.record_kind === 'policy_reload')
    expect(reloads).toHaveLength(3)
    for (const row of reloads) {
      expect(row.record.tool_name).toBe(DEMO_CONFIG_FILE)
      expect(row.record.policy_decision).toBe('policy_reload')
      expect(row.record.origin).toBe('config')
      expect(row.record.upstream).toBeNull()
      expect(row.record.session_id).toBeNull()
      expect(row.record.environment).toBe('demo')
    }
    const applied = reloads.filter((row) => row.record.block_reason === null)
    expect(applied).toHaveLength(2)
    const [aToB, bToC] = applied
    const chain = (row: DemoAuditRow | undefined) =>
      (row?.record.evidence_chain as { policy_reload: Record<string, unknown> }).policy_reload
    expect(chain(aToB)).toMatchObject({
      outcome: 'applied',
      sha256_before: corpus.epochHashes.a,
      sha256_after: corpus.epochHashes.b,
      rules_added: ['big-charge-approval'],
      rules_removed: [],
    })
    expect(aToB?.record.config_sha256).toBe(corpus.epochHashes.b)
    expect(chain(bToC)).toMatchObject({
      outcome: 'applied',
      sha256_before: corpus.epochHashes.b,
      sha256_after: HASH_C,
      rules_added: ['allow-reads', 'block-destructive'],
      rules_removed: ['big-charge-approval'],
    })
    expect(bToC?.record.config_sha256).toBe(HASH_C)
    const refused = reloads.find((row) => row.record.block_reason === 'rejected_invalid')
    expect(refused).toBeDefined()
    expect(chain(refused)).toMatchObject({
      outcome: 'rejected_invalid',
      sha256_before: HASH_C,
      restart_required_paths: [],
    })
    expect(typeof chain(refused)['error']).toBe('string')
    expect(refused?.record.config_sha256).toBe(HASH_C)
  })
})

describe('buildDemoCorpus: every kind and every mark', () => {
  it('carries tool_call, drift_event and policy_reload rows and no sideband kind', () => {
    const kinds = new Set(rows.map((row) => row.record.record_kind))
    expect([...kinds].sort()).toEqual(['drift_event', 'policy_reload', 'tool_call'])
  })

  it('holds one drift event, one rejected row, no sideband row and one anonymous allow', () => {
    const drift = rows.filter((row) => row.record.record_kind === 'drift_event')
    expect(drift).toHaveLength(1)
    expect(drift[0]?.record.policy_decision).toBe('tool_drift')
    expect(drift[0]?.record.upstream).toBe(DEMO_UPSTREAMS.crm)
    expect(drift[0]?.record.config_sha256).toBe(HASH_C)

    const rejected = rows.filter((row) => row.record.policy_decision === 'rejected')
    expect(rejected).toHaveLength(1)
    expect(rejected[0]?.record.tool_name).toBe('<nameless>')
    expect(rejected[0]?.record.block_reason).toBe('missing_tool_name')

    const ids = (set: readonly DemoAuditRow[]): string[] => set.map((row) => row.id)
    expect(ids(rows.filter((row) => row.record.session_source === 'sideband'))).toEqual([])
    expect(ids(rows.filter((row) => row.record.origin === 'demo-agent'))).toEqual([])
    expect(ids(byTool('send_message'))).toEqual([])
    for (const row of calls) expect(row.record.upstream, row.id).not.toBeNull()

    const anonymous = callsInC.filter(
      (row) => row.record.session_id === null && row.record.policy_decision === 'allow',
    )
    expect(anonymous.map((row) => row.id)).toHaveLength(1)
    expect(anonymous[0]?.record.dry_run, anonymous[0]?.id).toBe(false)
    expect(anonymous[0]?.record.tool_name, anonymous[0]?.id).toBe('send_invoice')
  })

  it('marks every row with the demo environment and every name with demo-', () => {
    for (const row of rows) expect(row.record.environment).toBe('demo')
    for (const row of calls) {
      if (row.record.origin === 'mcp') {
        expect(row.record.upstream ?? '', row.id).toMatch(/^demo-/)
      }
      if (row.record.session_id !== null) {
        expect(row.record.session_id).toMatch(/^demo-/)
        expect(row.record.session_id.length).toBeLessThanOrEqual(8)
      }
    }
    const upstreams = new Set(calls.map((row) => row.record.upstream).filter((u) => u !== null))
    expect([...upstreams].sort()).toEqual([DEMO_UPSTREAMS.billing, DEMO_UPSTREAMS.crm])
    const sessions = new Set(rows.map((row) => row.record.session_id).filter((s) => s !== null))
    expect([...sessions].sort()).toEqual([...DEMO_SESSIONS].sort())
  })

  it('seeds the three protocol_version faces', () => {
    const versions = new Set(rows.map((row) => row.record.protocol_version))
    expect(versions).toEqual(new Set(['2025-06-18', '2026-07-28', null]))
  })

  it('gives every tool call a realistic input and every latency a number', () => {
    for (const row of calls) {
      if (row.record.tool_name === '<nameless>') continue
      expect(Object.keys(row.record.tool_input).length).toBeGreaterThan(0)
      expect(typeof row.record.total_duration_ms).toBe('number')
      expect(typeof row.record.proxy_compute_ms).toBe('number')
    }
  })
})

describe('buildDemoCorpus: the ledger', () => {
  it('writes the pot meta at epoch 2 with the shipped tuple', () => {
    expect(corpus.ledgerMeta).toEqual({
      budget_name: DEMO_BUDGET_NAME,
      limit_amount: 500,
      currency: 'USD',
      window: '24h',
      key: 'global',
      epoch: 2,
    })
  })

  it('walks the pot with the window and limit the rendered config names', () => {
    expect(DEMO_BUDGET_WINDOW_MS).toBe(24 * HOUR)
    expect(DEMO_BUDGET_LIMIT).toBe(500)
    expect(corpus.ledgerMeta.window).toBe('24h')
    expect(corpus.ledgerMeta.limit_amount).toBe(DEMO_BUDGET_LIMIT)
  })

  it('writes one generation-2 row per allowed contributor call, carrying its id, amount and instant', () => {
    const key = budgetBucketKey(DEMO_BUDGET_NAME, 'global', { sessionId: null, senderId: null })
    const current = corpus.ledgerRows.filter((row) => row.generation === 2)
    const allowed = contributorsInC.filter((row) => row.record.block_reason === null)
    expect(allowed).toHaveLength(32)
    expect(current).toHaveLength(32)
    expect(current).toEqual(
      allowed.map((row) => ({
        budget_name: DEMO_BUDGET_NAME,
        bucket_key: key,
        kind: 'spend',
        amount: amountOf(row),
        currency: 'USD',
        tool_name: row.record.tool_name,
        origin: 'mcp',
        audit_record_id: row.id,
        timestamp: row.created_at,
        timestamp_ms: new Date(row.created_at).getTime(),
        generation: 2,
      })),
    )
  })

  it('never lets the window pass the limit at any committed call', () => {
    const current = corpus.ledgerRows.filter((row) => row.generation === 2)
    for (const row of current) {
      const inWindow = current.filter(
        (other) =>
          other.timestamp_ms > row.timestamp_ms - DEMO_BUDGET_WINDOW_MS &&
          other.timestamp_ms <= row.timestamp_ms,
      )
      expect(inWindow.reduce((sum, other) => sum + other.amount, 0)).toBeLessThanOrEqual(
        DEMO_BUDGET_LIMIT,
      )
    }
  })

  it('leaves 12 rows inside the window at the base, summing to 498', () => {
    const inWindow = corpus.ledgerRows.filter(
      (row) => row.generation === 2 && row.timestamp_ms > BASE.getTime() - DEMO_BUDGET_WINDOW_MS,
    )
    expect(inWindow).toHaveLength(12)
    expect(inWindow.reduce((sum, row) => sum + row.amount, 0)).toBe(498)
    for (const row of inWindow) expect(row.timestamp_ms).toBeLessThan(BASE.getTime())
  })

  it('keeps an epoch-1 history with one approved overage of 750', () => {
    const history = corpus.ledgerRows.filter((row) => row.generation === 1)
    expect(history).toHaveLength(9)
    const overage = history.filter((row) => row.kind === 'approved_overage')
    expect(overage).toHaveLength(1)
    expect(overage[0]?.amount).toBe(750)
    for (const row of history) expect(row.audit_record_id).toMatch(UUID)
    expect(corpus.ledgerRows).toHaveLength(41)
    for (const row of corpus.ledgerRows) {
      expect(row.budget_name).toBe(DEMO_BUDGET_NAME)
      expect(row.currency).toBe('USD')
      expect(row.origin).toBe('mcp')
    }
  })
})

describe('buildDemoCorpus: determinism', () => {
  it('builds the same rows twice from one base', () => {
    const again = buildDemoCorpus({ base: BASE, configSha256: HASH_C })
    expect(again).toEqual(corpus)
  })

  it('derives every id from a hash, unique and UUID-shaped', () => {
    const ids = rows.map((row) => row.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(UUID)
    const first = createHash('sha256').update('helio-demo:0').digest('hex')
    expect(rows[0]?.id).toBe(
      `${first.slice(0, 8)}-${first.slice(8, 12)}-4${first.slice(13, 16)}-8${first.slice(17, 20)}-${first.slice(20, 32)}`,
    )
  })

  it('dates every row within the last 45 days of the base, newest last', () => {
    const floor = BASE.getTime() - 45 * DAY
    let previous = ''
    for (const row of rows) {
      const ms = new Date(row.created_at).getTime()
      expect(ms).toBeGreaterThanOrEqual(floor)
      expect(ms).toBeLessThanOrEqual(BASE.getTime())
      expect(row.record.timestamp).toBe(row.created_at)
      expect(row.created_at >= previous).toBe(true)
      previous = row.created_at
    }
    expect(rows.length).toBeGreaterThan(300)
  })

  it('moves with the base, not the clock', () => {
    const later = buildDemoCorpus({
      base: new Date(BASE.getTime() + DAY),
      configSha256: HASH_C,
    })
    expect(later.records.map((row) => row.record.tool_name)).toEqual(
      rows.map((row) => row.record.tool_name),
    )
    expect(later.records[0]?.created_at).toBe(
      new Date(new Date(rows[0]?.created_at ?? 0).getTime() + DAY).toISOString(),
    )
  })
})
