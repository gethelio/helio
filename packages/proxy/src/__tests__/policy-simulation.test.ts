import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ApprovalQueue } from '../approval/queue.js'
import { ApprovalRouter } from '../approval/router.js'
import { QueueChannel } from '../approval/channels.js'
import type { ApprovalChannel } from '../approval/types.js'
import { AuditStore } from '../audit/store.js'
import { AuditWriter } from '../audit/writer.js'
import type { AuditRecord } from '../audit/types.js'
import { ToolBaselineStore } from '../baseline/store.js'
import { BudgetEngine } from '../budget/engine.js'
import { BudgetLedger } from '../budget/ledger.js'
import { compileBudgets } from '../budget/parser.js'
import { DEMO_DEFAULT_PORTS, renderDemoConfig } from '../demo/config.js'
import { DEMO_TOOLS, DEMO_UPSTREAMS, buildDemoCorpus } from '../demo/corpus.js'
import { wireTool } from '../demo/upstream.js'
import { EvidenceStore } from '../evidence/store.js'
import type { ForwardResult, McpForwarder, McpRequest } from '../mcp/types.js'
import { compileSessionIdentity } from '../mcp/session-resolver.js'
import { GovernedForwarder } from '../policy/governed-forwarder.js'
import { compilePolicies } from '../policy/parser.js'
import { RateLimiter } from '../policy/rate-limiter.js'
import { SpendLimiter } from '../policy/spend-limiter.js'
import { simulatePolicy } from '../policy/simulate/index.js'
import type { AnnotationSource, PolicySimulationCandidate } from '../policy/simulate/index.js'
import { extractAnnotations } from '../policy/tool-definitions.js'
import { canonicalize } from '../util/canonical-json.js'
import { candidateFromYaml, mcpRow } from './helpers/simulation-rows.js'

// ---------------------------------------------------------------------------
// The policy simulation harness against a trail the real MCP door wrote
// (issue #488): the same config replays with zero deltas, a changed one
// moves exactly the rows it should, the demo corpus replays clean, and the
// run writes nothing and reaches no upstream.
// ---------------------------------------------------------------------------

const UNKNOWN: AnnotationSource = { resolve: () => ({ kind: 'unknown' }) }

const LIVE_YAML = `version: '1'
upstream:
  url: 'http://127.0.0.1:8080/mcp'
policies:
  default: allow
  rules:
    - name: reads
      match: { tool: 'get_*' }
      action: allow
    - name: paced
      match: { tool: 'poll' }
      action: rate_limit
      limits: { max_calls: 2, window: 1m }
    - name: capped
      match: { tool: 'pay' }
      action: spend_limit
      limits: { max_spend: { field: '$.amount', limit: 100, currency: USD, window: 1h } }
    - name: gated
      match: { tool: 'deploy' }
      action: require_approval
      approval: { channel: dashboard }
    - name: grounded
      match: { tool: 'export' }
      action: allow
      evidence: { requires: ['consent'] }
    - name: chained
      match: { tool: 'refund' }
      action: allow
      requires: ['get_order']
    - name: shadow
      match: { tool: 'wipe' }
      action: dry_run
budgets:
  - name: pot
    limit: 50
    currency: USD
    window: 24h
    key: global
    on_exceed: deny
    contributors:
      - match: { tool: 'charge' }
        field: '$.amount'
dashboard:
  api_secret: 'test-secret'
`

/** A plain stub upstream: every forwarded call answers one text block. */
const stubForwarder: McpForwarder = {
  forward: (request: McpRequest): Promise<ForwardResult> =>
    Promise.resolve({
      response: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: {
          jsonrpc: '2.0',
          id: request.id ?? null,
          result: { content: [{ type: 'text', text: 'ok' }] },
        },
      },
      durationMs: 1,
    }),
}

function call(
  name: string | undefined,
  sessionId: string,
  args: Record<string, unknown> = {},
): McpRequest {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: name === undefined ? {} : { name, arguments: args },
    session: { id: sessionId, source: 'header' },
  }
}

interface LiveTrail {
  readonly dir: string
  readonly store: AuditStore
  readonly candidate: PolicySimulationCandidate
  readonly rows: readonly AuditRecord[]
  close(): void
}

/**
 * Drive the real door through two sessions and two doors on one clock:
 * `Date` itself is faked for the duration, so the door's row stamps, the
 * ledger's two time columns, the store's `created_at` and every limiter and
 * pot read the same instants, and the trail is the one a proxy on that
 * clock would have written. Timers stay real: the approval router waits on
 * them.
 */
async function writeLiveTrail(): Promise<LiveTrail> {
  const candidate = candidateFromYaml(LIVE_YAML)
  const { config } = candidate
  const dir = mkdtempSync(join(tmpdir(), 'helio-simulation-'))
  const store = new AuditStore({
    path: join(dir, 'audit.db'),
    retention: '90d',
    includeResponses: true,
    cleanupIntervalMs: 0,
  })
  let nowMs = Date.parse('2026-07-10T12:00:00.000Z')
  vi.useFakeTimers({ toFake: ['Date'], now: nowMs })
  const now = (): number => Date.now()
  const advance = (ms: number): void => {
    nowMs += ms
    vi.setSystemTime(nowMs)
  }
  const writer = new AuditWriter({
    store,
    flushIntervalMs: 0,
    configSha256: candidate.source.sha256,
  })
  const ledger = new BudgetLedger({ database: store.database, now })
  const budgetEngine = new BudgetEngine({
    budgets: compileBudgets(config.budgets),
    now,
    cleanupIntervalMs: 0,
    ledger,
  })
  budgetEngine.hydrate()
  const rateLimiter = new RateLimiter({ now, cleanupIntervalMs: 0 })
  const spendLimiter = new SpendLimiter({ now, cleanupIntervalMs: 0 })
  const evidenceStore = new EvidenceStore({ now, cleanupIntervalMs: 0 })
  const queue = new ApprovalQueue({ cleanupIntervalMs: 0 })
  const channels = new Map<string, ApprovalChannel>([['dashboard', new QueueChannel()]])
  const approvalRouter = new ApprovalRouter({
    defaultTimeoutMs: 300_000,
    defaultOnTimeout: 'deny',
    channels,
    queue,
    now,
  })
  const killSwitch = { killed: false }
  const policy = compilePolicies(config.policies).policy
  const shared = {
    auditWriter: writer,
    evidenceStore,
    approvalRouter,
    rateLimiter,
    spendLimiter,
    budgetEngine,
    session: compileSessionIdentity(config.session),
    killSwitch,
  }
  const crm = new GovernedForwarder(stubForwarder, policy, { ...shared, upstreamName: 'crm' })
  const billing = new GovernedForwarder(stubForwarder, policy, {
    ...shared,
    upstreamName: 'billing',
  })

  const step = async (door: GovernedForwarder, request: McpRequest, advanceMs = 1_000) => {
    advance(advanceMs)
    return door.forward(request)
  }
  const approve = async (request: McpRequest, decide: (ticketId: string) => void) => {
    advance(1_000)
    const pending = crm.forward(request)
    const ticket = queue.listPending()[0]
    if (!ticket) throw new Error('no ticket raised')
    decide(ticket.id)
    return pending
  }

  try {
    await step(crm, call('get_user', 's1', { id: 'u1' }))
    await step(crm, call('poll', 's1'))
    await step(crm, call('poll', 's1'))
    await step(crm, call('poll', 's1')) // refused: the third inside the minute
    await step(crm, call('poll', 's1'), 61_000) // the window slid
    await step(billing, call('pay', 's1', { amount: 60 }))
    await step(billing, call('pay', 's1', { amount: 60 })) // spend_limited
    await step(billing, call('charge', 's2', { amount: 30 }))
    await step(billing, call('charge', 's2', { amount: 30 })) // budget_exceeded
    await approve(call('deploy', 's1'), (id) => approvalRouter.approve(id, 'ops'))
    await approve(call('deploy', 's1'), (id) => approvalRouter.deny(id, 'ops', 'not now'))
    evidenceStore.putEvidence('s1', {
      evidence_key: 'consent',
      data: {},
      tool_name: 'consent_form',
      ttl_seconds: 60,
    })
    await step(crm, call('export', 's1'))
    await step(crm, call('export', 's1'), 61_000) // evidence_expired
    await step(crm, call('refund', 's1')) // dependency_missing
    await step(crm, call('get_order', 's1', { id: 'o1' }))
    await step(crm, call('refund', 's1'))
    await step(crm, call('wipe', 's1')) // dry run
    await step(crm, call(undefined, 's1')) // nameless
    killSwitch.killed = true
    await step(crm, call('get_user', 's1'))
    killSwitch.killed = false
    writer.flush()
  } finally {
    vi.useRealTimers()
    approvalRouter.close()
    budgetEngine.close()
    rateLimiter.close()
    spendLimiter.close()
    evidenceStore.close()
  }
  const rows = [...store.iterateReplayRows({})]
  return {
    dir,
    store,
    candidate,
    rows,
    close: () => {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

const liveTrail = await writeLiveTrail()
const live = liveTrail.rows

describe('the live trail the door wrote', () => {
  it('holds the outcomes the scenario asked for', () => {
    expect(live.map((row) => [row.tool_name, row.policy_decision, row.block_reason])).toEqual([
      ['get_user', 'allow', null],
      ['poll', 'rate_limit', null],
      ['poll', 'rate_limit', null],
      ['poll', 'rate_limit', 'rate_limited'],
      ['poll', 'rate_limit', null],
      ['pay', 'spend_limit', null],
      ['pay', 'spend_limit', 'spend_limited'],
      ['charge', 'allow', null],
      ['charge', 'allow', 'budget_exceeded'],
      ['deploy', 'require_approval', null],
      ['deploy', 'require_approval', 'approval_denied'],
      ['export', 'allow', null],
      ['export', 'deny', 'evidence_expired'],
      ['refund', 'deny', 'dependency_missing'],
      ['get_order', 'allow', null],
      ['refund', 'allow', null],
      ['wipe', 'dry_run', null],
      ['<nameless>', 'rejected', 'missing_tool_name'],
      ['get_user', 'deny', 'kill_switch'],
    ])
  })
})

describe('simulatePolicy over the live trail', () => {
  it('replays the same config with zero deltas, the skips counted and nothing unverified', () => {
    const result = simulatePolicy({
      store: liveTrail.store,
      candidate: liveTrail.candidate,
      annotations: UNKNOWN,
    })
    expect(result.replayed).toBe(17)
    expect(result.skipped).toEqual({ rejected: 1, kill_switch: 1 })
    expect(result.unreported).toBe(0)
    expect(result.deltas.map((delta) => [delta.tool_name, delta.stored, delta.simulated])).toEqual(
      [],
    )
    expect(result.budget_checks).toEqual([])
    expect(result.fidelity.warnings).toEqual([])
    expect(result.fidelity.lines).toEqual([
      'Skipped 2 row(s) that never entered policy evaluation: 1 rejected, 1 refused by the kill switch.',
      '0 sideband evaluation(s) were decided but never reported (evaluation_expired); their outcome is unknown.',
    ])
    expect(result.rows.map((row) => row.upstream)).toEqual([
      'crm',
      'crm',
      'crm',
      'crm',
      'crm',
      'billing',
      'billing',
      'billing',
      'billing',
      'crm',
      'crm',
      'crm',
      'crm',
      'crm',
      'crm',
      'crm',
      'crm',
    ])
    expect(result.rows.map((row) => row.ticket_answer)).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      'recorded',
      'recorded',
      null,
      null,
      null,
      null,
      null,
      null,
    ])
  })

  it('moves exactly the rows a deny, an approval rule and a tighter pot touch', () => {
    const changed = candidateFromYaml(
      LIVE_YAML.replace(
        "    - name: reads\n      match: { tool: 'get_*' }\n      action: allow\n",
        "    - name: no-users\n      match: { tool: 'get_user' }\n      action: deny\n    - name: reads\n      match: { tool: 'get_*' }\n      action: allow\n    - name: pay-gate\n      match: { tool: 'pay' }\n      action: require_approval\n      approval: { channel: dashboard }\n",
      ).replace('limit: 50', 'limit: 20'),
    )
    const result = simulatePolicy({
      store: liveTrail.store,
      candidate: changed,
      annotations: UNKNOWN,
    })
    expect(
      result.deltas.map((delta) => [
        delta.tool_name,
        delta.simulated.policy_decision,
        delta.simulated.block_reason,
        delta.ticket_answer,
      ]),
    ).toEqual([
      ['get_user', 'deny', 'policy_denied', null],
      ['pay', 'require_approval', null, 'unanswered'],
      ['pay', 'require_approval', null, 'unanswered'],
      ['charge', 'allow', 'budget_exceeded', null],
    ])
    expect(result.replayed).toBe(17)
    expect(result.budget_checks).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The demo corpus in memory
// ---------------------------------------------------------------------------

const DEMO_BASE = new Date('2026-09-24T12:00:00.000Z')

/** The sample server's listed definitions, the source `--demo` must hand the harness. */
const demoSource: AnnotationSource = (() => {
  const listed = new Map(
    DEMO_TOOLS.map((tool) => [`${tool.upstream}/${tool.name}`, extractAnnotations(wireTool(tool))]),
  )
  return {
    resolve: (query) => {
      const key = `${query.upstream ?? ''}/${query.tool}`
      if (query.origin !== 'mcp' || !listed.has(key)) return { kind: 'unknown' }
      return { kind: 'known', hints: listed.get(key), source: 'demo' }
    },
  }
})()

function demoStore(extraRows: readonly AuditRecord[] = []): {
  readonly store: AuditStore
  readonly candidate: PolicySimulationCandidate
  readonly rows: number
} {
  const candidate = candidateFromYaml(renderDemoConfig(DEMO_DEFAULT_PORTS))
  const corpus = buildDemoCorpus({ base: DEMO_BASE, configSha256: candidate.source.sha256 })
  const store = new AuditStore({
    path: ':memory:',
    retention: '90d',
    includeResponses: true,
    cleanupIntervalMs: 0,
  })
  store.database.transaction(() => {
    for (const row of corpus.records) store.insert(row.record, row.created_at, row.id)
    for (const row of extraRows) store.insert(row, row.created_at, row.id)
  })()
  const ledger = new BudgetLedger({ database: store.database, now: () => DEMO_BASE.getTime() })
  ledger.writeMeta(corpus.ledgerMeta)
  ledger.commitAll(corpus.ledgerRows)
  const baselines = new ToolBaselineStore({ database: store.database })
  for (const door of Object.values(DEMO_UPSTREAMS)) {
    baselines.insertNew(
      door,
      DEMO_TOOLS.filter((tool) => tool.upstream === door).map((tool) => {
        const definition = wireTool(tool)
        return { tool: tool.name, definition, fingerprint: canonicalize(definition) }
      }),
      DEMO_BASE.toISOString(),
    )
  }
  const rows = corpus.records.filter(
    (row) =>
      row.record.record_kind === 'tool_call' &&
      row.record.config_sha256 === candidate.source.sha256,
  ).length
  return { store, candidate, rows }
}

describe('simulatePolicy over the demo corpus', () => {
  it('replays the current epoch with zero deltas, one skipped row and nothing unverified', () => {
    const { store, candidate, rows } = demoStore()
    try {
      const result = simulatePolicy({ store, candidate, annotations: demoSource })
      expect(result.skipped).toEqual({ rejected: 1, kill_switch: 0 })
      expect(result.replayed).toBe(rows - 1)
      expect(
        result.deltas.map((delta) => [
          delta.tool_name,
          delta.timestamp,
          delta.stored,
          delta.simulated,
        ]),
      ).toEqual([])
      expect(result.fidelity.warnings).toEqual([])
      expect(result.budget_checks).toEqual([])
      expect(result.epochs.filter((epoch) => epoch.selected)).toHaveLength(1)
      expect(result.epochs).toHaveLength(3)
    } finally {
      store.close()
    }
  })

  it('leaves the pot at 498 of 500 at the base: a charge of 2 fits and the next of 1 does not', () => {
    const probe = (amount: number, offsetMs: number, candidateHash: string): AuditRecord =>
      mcpRow({
        timestamp: new Date(DEMO_BASE.getTime() + offsetMs).toISOString(),
        created_at: new Date(DEMO_BASE.getTime() + offsetMs).toISOString(),
        tool_name: 'create_charge',
        upstream: 'demo-billing',
        session_id: 'demo-s01',
        environment: 'demo',
        tool_input: { amount, currency: 'USD', customer: 'cus_1077' },
        config_sha256: candidateHash,
      })
    const { candidate } = demoStore()
    const { store } = demoStore([
      probe(2, 0, candidate.source.sha256),
      probe(1, 1_000, candidate.source.sha256),
    ])
    try {
      const result = simulatePolicy({ store, candidate, annotations: demoSource })
      const probes = result.rows.slice(-2)
      expect(probes.map((row) => [row.tool_name, row.simulated.block_reason])).toEqual([
        ['create_charge', null],
        ['create_charge', 'budget_exceeded'],
      ])
      expect(result.deltas).toHaveLength(1)
    } finally {
      store.close()
    }
  })

  it('names every undrifted call unknown for annotations under the trail source, as the page says', () => {
    const { store, candidate, rows } = demoStore()
    try {
      const result = simulatePolicy({ store, candidate, annotations: UNKNOWN })
      const annotations = result.fidelity.warnings.filter(
        (warning) => warning.dimension === 'tool annotations',
      )
      expect(annotations.reduce((sum, warning) => sum + warning.calls, 0)).toBe(rows - 1)
      expect(result.deltas.length).toBeGreaterThan(0)
    } finally {
      store.close()
    }
  })
})

// ---------------------------------------------------------------------------
// Zero writes, zero upstream
// ---------------------------------------------------------------------------

describe('a simulation writes nothing and reaches no upstream', () => {
  function changesOf(store: AuditStore): { readonly changes: number; readonly schema: number } {
    const { changes } = store.database.prepare('SELECT total_changes() AS changes').get() as {
      changes: number
    }
    const schema = store.database.pragma('schema_version', { simple: true }) as number
    return { changes, schema }
  }

  it('leaves total_changes and schema_version where they were, on the live trail and under a first-boot pot', () => {
    const before = changesOf(liveTrail.store)
    const metaBefore = liveTrail.store.database
      .prepare('SELECT * FROM budget_meta ORDER BY budget_name')
      .all()
    simulatePolicy({ store: liveTrail.store, candidate: liveTrail.candidate, annotations: UNKNOWN })
    const firstBoot = candidateFromYaml(LIVE_YAML.replace('name: pot', 'name: fresh-pot'))
    const result = simulatePolicy({
      store: liveTrail.store,
      candidate: firstBoot,
      annotations: UNKNOWN,
    })
    expect(result.replayed).toBe(17)
    expect(changesOf(liveTrail.store)).toEqual(before)
    expect(
      liveTrail.store.database.prepare('SELECT * FROM budget_meta ORDER BY budget_name').all(),
    ).toEqual(metaBefore)
  })

  it('never constructs the budget or baseline tables on a database that lacks them', () => {
    const store = new AuditStore({
      path: ':memory:',
      retention: '90d',
      includeResponses: true,
      cleanupIntervalMs: 0,
    })
    try {
      store.insert(mcpRow({ tool_input: { amount: 5 } }))
      const before = changesOf(store)
      simulatePolicy({ store, candidate: liveTrail.candidate, annotations: UNKNOWN })
      expect(changesOf(store)).toEqual(before)
      const tables = store.database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('budget_events', 'budget_meta', 'tool_baselines')",
        )
        .all()
      expect(tables).toEqual([])
    } finally {
      store.close()
    }
  })

  it('imports nothing that reaches a transport, an upstream or a barrel that loads one', () => {
    const dir = fileURLToPath(new URL('../policy/simulate/', import.meta.url))
    const forbidden = [
      /\/upstream\//,
      /\/transport\//,
      /\/mcp\/(?!session-resolver\.js)/,
      /^\.\.\/index\.js$/,
      /^\.\.\/governed-forwarder\.js$/,
      /\/budget\/index\.js$/,
      /\/evidence\/index\.js$/,
      /^node:https?$/,
      /^node:net$/,
      /^undici$/,
      /^@modelcontextprotocol/,
    ]
    const files = readdirSync(dir).filter(
      (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
    )
    expect(files.sort()).toEqual([
      'context.ts',
      'fidelity.ts',
      'harness.ts',
      'index.ts',
      'types.ts',
    ])
    for (const file of files) {
      const text = readFileSync(join(dir, file), 'utf-8')
      const specifiers = [...text.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1] ?? '')
      for (const specifier of specifiers) {
        for (const pattern of forbidden) {
          expect(specifier, `${file} imports ${specifier}`).not.toMatch(pattern)
        }
      }
    }
  })

  it('trips no fetch during the demo run', () => {
    const original = globalThis.fetch
    const calls: string[] = []
    globalThis.fetch = ((input: unknown) => {
      calls.push(String(input))
      throw new Error('a simulation must not fetch')
    }) as typeof fetch
    const { store, candidate } = demoStore()
    try {
      const result = simulatePolicy({ store, candidate, annotations: demoSource })
      expect(result.deltas).toEqual([])
      expect(calls).toEqual([])
    } finally {
      globalThis.fetch = original
      store.close()
    }
  })
})

describe('teardown', () => {
  it('removes the live trail', () => {
    liveTrail.close()
  })
})
