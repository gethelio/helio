import { describe, it, expect } from 'vitest'
import { AuditStore } from '../audit/store.js'
import { BudgetEngine, BudgetLedger, compileBudgets } from '../budget/index.js'
import { parseConfigSource } from '../config/loader.js'
import { decide } from '../policy/decision-pipeline.js'
import { compilePolicies } from '../policy/parser.js'
import { gateBudgetCharges, gateSession } from '../policy/session-gate.js'
import { extractAnnotations } from '../policy/tool-definitions.js'
import { DEMO_DEFAULT_PORTS, renderDemoConfig } from './config.js'
import { DEMO_CONFIG_FILE, DEMO_TOOLS, buildDemoCorpus } from './corpus.js'
import { wireTool } from './upstream.js'

// ---------------------------------------------------------------------------
// The current epoch of the demo corpus, replayed row by row through the
// real decision pipeline and the real budget engine under the config the
// seed writes. Every stored decision column must equal what the proxy
// would have decided; the ledger the corpus writes must equal the one the
// engine would have written; and the pot at the base must read what the
// docs say it reads. The clock is virtual: each row is decided at its own
// instant, so the pot's sliding window moves as it does live.
// ---------------------------------------------------------------------------

const BASE = new Date('2026-09-24T12:00:00.000Z')
const HASH_C = 'c'.repeat(64)

const config = parseConfigSource(
  { raw: renderDemoConfig(DEMO_DEFAULT_PORTS), sha256: '' },
  DEMO_CONFIG_FILE,
).config
const policy = compilePolicies(config.policies).policy
const budgets = compileBudgets(config.budgets)

const corpus = buildDemoCorpus({ base: BASE, configSha256: HASH_C })
const epoch = corpus.records.filter(
  (row) => row.record.config_sha256 === HASH_C && row.record.record_kind === 'tool_call',
)

/** The definition the sample server lists for each (door, tool) pair. */
const listed = new Map(DEMO_TOOLS.map((tool) => [`${tool.upstream}/${tool.name}`, wireTool(tool)]))

interface DecisionColumns {
  readonly policy_decision: string
  readonly block_reason: string | null
  readonly dry_run: boolean
  readonly matched_rule: string | null
  readonly matched_rule_index: number | null
  readonly flagged_destructive: boolean
}

interface ReplayedRow {
  readonly id: string
  readonly created_at: string
  readonly stored: DecisionColumns
  readonly replayed: DecisionColumns
}

interface LedgerRowFace {
  readonly bucket_key: string
  readonly kind: string
  readonly amount: number
  readonly currency: string
  readonly tool_name: string
  readonly origin: string
  readonly audit_record_id: string
  readonly timestamp: string
  readonly timestamp_ms: number
}

const LEDGER_SQL =
  'SELECT bucket_key, kind, amount, currency, tool_name, origin, audit_record_id, ' +
  'timestamp, timestamp_ms FROM budget_events WHERE epoch = 2 ORDER BY timestamp_ms, rowid'

function ago(createdAt: string): string {
  return `${((BASE.getTime() - Date.parse(createdAt)) / 3_600_000).toFixed(2)} h before the base`
}

/** Walk the epoch once; every case below reads the result. */
function replay(): {
  readonly rows: readonly ReplayedRow[]
  readonly skipped: readonly string[]
  readonly unlisted: readonly string[]
  readonly ledgerRows: readonly LedgerRowFace[]
  readonly potAtBase: { readonly spent: number; readonly remaining: number } | undefined
  readonly bucketsAtBase: number
  readonly chargeOf60AllowedAtBase: boolean
} {
  const first = epoch[0]
  if (!first) throw new Error('the current epoch has no tool_call row')
  let nowMs = Date.parse(first.created_at)
  const now = (): number => nowMs

  const store = new AuditStore({
    path: ':memory:',
    retention: '90d',
    includeResponses: true,
    cleanupIntervalMs: 0,
  })
  try {
    const ledger = new BudgetLedger({ database: store.database, now })
    ledger.writeMeta(corpus.ledgerMeta)
    ledger.commitAll(corpus.ledgerRows.filter((row) => row.generation === 1))
    const engine = new BudgetEngine({ budgets, now, cleanupIntervalMs: 0, ledger })
    engine.hydrate()

    const rows: ReplayedRow[] = []
    const skipped: string[] = []
    const unlisted: string[] = []
    for (const row of epoch) {
      const { record } = row
      if (record.policy_decision === 'rejected' || record.block_reason === 'kill_switch') {
        skipped.push(record.tool_name)
        continue
      }
      const definition = listed.get(`${record.upstream ?? ''}/${record.tool_name}`)
      if (definition === undefined) {
        unlisted.push(`${record.tool_name} on ${record.upstream ?? 'no door'} (${row.id})`)
        continue
      }
      nowMs = Date.parse(row.created_at)
      const annotations = extractAnnotations(definition)
      const pipeline = decide({
        toolName: record.tool_name,
        toolArguments: record.tool_input,
        sessionId: record.session_id ?? undefined,
        policy,
        environment: config.environment,
        evidenceStore: undefined,
        baselineAnnotations: annotations,
        currentAnnotations: annotations,
        driftEvent: undefined,
        upstream: record.upstream ?? undefined,
      })
      const { action, matchedRule } = pipeline.decision
      let blockReason: string | null = action === 'deny' ? 'policy_denied' : null
      if (action === 'allow' && !pipeline.isDryRun) {
        const gate = gateSession(record.session_id, config.session.on_unresolved)
        const resolved = engine.resolveCharges({
          toolName: record.tool_name,
          toolArguments: record.tool_input,
          sessionId: gate.ok ? gate.session : null,
          senderId: null,
          upstream: record.upstream,
        })
        if (resolved.failures.length > 0) {
          throw new Error(`budget resolution failed on ${row.id}: ${JSON.stringify(resolved)}`)
        }
        const gated = gateBudgetCharges(resolved, gate)
        if (!gated.ok) throw new Error(`the session gate refused ${row.id}`)
        if (gated.charges.length > 0) {
          if (engine.peekAll(gated.charges).allowed) {
            engine.recordAll(gated.charges, {
              kind: 'spend',
              auditRecordId: row.id,
              origin: 'mcp',
              toolName: record.tool_name,
              timestampIso: row.created_at,
            })
          } else {
            blockReason = 'budget_exceeded'
          }
        }
      }
      rows.push({
        id: row.id,
        created_at: row.created_at,
        stored: {
          policy_decision: record.policy_decision,
          block_reason: record.block_reason,
          dry_run: record.dry_run,
          matched_rule: record.matched_rule,
          matched_rule_index: record.matched_rule_index,
          flagged_destructive: record.flagged_destructive,
        },
        replayed: {
          policy_decision: action,
          block_reason: blockReason,
          dry_run: pipeline.isDryRun,
          matched_rule: matchedRule?.name ?? null,
          matched_rule_index: matchedRule?.index ?? null,
          flagged_destructive: pipeline.flaggedDestructive,
        },
      })
    }

    const ledgerRows = store.database.prepare(LEDGER_SQL).all() as LedgerRowFace[]
    nowMs = BASE.getTime()
    const states = engine.listStates()
    const buckets = states[0]?.buckets ?? []
    const bucket = buckets[0]
    const gate = gateSession('live-1', config.session.on_unresolved)
    const probe = engine.resolveCharges({
      toolName: 'create_charge',
      toolArguments: { amount: 60, currency: 'USD', customer: 'cus_1077' },
      sessionId: gate.ok ? gate.session : null,
      senderId: null,
      upstream: 'demo-billing',
    })
    const gatedProbe = gateBudgetCharges(probe, gate)
    if (!gatedProbe.ok) throw new Error('the session gate refused the probe')
    const chargeOf60AllowedAtBase = engine.peekAll(gatedProbe.charges).allowed
    engine.close()
    return {
      rows,
      skipped,
      unlisted,
      ledgerRows,
      potAtBase: bucket ? { spent: bucket.spent, remaining: bucket.remaining } : undefined,
      bucketsAtBase: states.length === 1 ? buckets.length : -1,
      chargeOf60AllowedAtBase,
    }
  } finally {
    store.close()
  }
}

const walk = replay()

describe('the demo corpus replayed through decide and the budget engine', () => {
  it('lists every replayed row on the sample server', () => {
    expect(walk.unlisted).toEqual([])
  })

  it('skips exactly the one nameless rejection', () => {
    expect(walk.skipped).toEqual(['<nameless>'])
    expect(walk.rows.length + walk.skipped.length).toBe(epoch.length)
  })

  it('stores on every row the decision columns the proxy would have written', () => {
    for (const row of walk.rows) {
      expect(row.replayed, `row ${row.id} at ${row.created_at} (${ago(row.created_at)})`).toEqual(
        row.stored,
      )
    }
  })

  it('writes the generation-2 ledger rows the engine would have written, in order', () => {
    const expected: LedgerRowFace[] = corpus.ledgerRows
      .filter((row) => row.generation === 2)
      .map((row) => ({
        bucket_key: row.bucket_key,
        kind: row.kind,
        amount: row.amount,
        currency: row.currency,
        tool_name: row.tool_name,
        origin: row.origin,
        audit_record_id: row.audit_record_id,
        timestamp: row.timestamp,
        timestamp_ms: row.timestamp_ms,
      }))
    expect(walk.ledgerRows).toEqual(expected)
  })

  it('leaves the pot at 498 of 500 at the base, refusing the documented charge of 60', () => {
    expect(walk.bucketsAtBase).toBe(1)
    expect(walk.potAtBase).toEqual({ spent: 498, remaining: 2 })
    expect(walk.chargeOf60AllowedAtBase).toBe(false)
  })
})
