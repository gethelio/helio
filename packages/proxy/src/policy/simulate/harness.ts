// ---------------------------------------------------------------------------
// The ordered replay (issue #488): the audit trail's tool calls walked in
// `timestamp` order against a candidate policy on one virtual clock, through
// the same `decide()` the doors run and the same limiter, budget and
// evidence classes, with every piece of cumulative state rebuilt in the
// order the doors applied it. Read-only over the database and the ledger:
// the ledger the budget engine sees swallows its writes, no store is ever
// constructed on a database that lacks its table, and nothing here reaches
// an upstream. The outcome compared per row is the quadruple
// (policy_decision, block_reason, dry_run, ticket).
// ---------------------------------------------------------------------------

import type { AuditStore } from '../../audit/store.js'
import type {
  AuditRecord,
  ConfigEpochRun,
  ReplayFilters,
  ReplayRowFilters,
} from '../../audit/types.js'
import { BudgetEngine } from '../../budget/engine.js'
import type {
  BudgetLedgerRow,
  BudgetMetaRow,
  BudgetPeekEntry,
  BudgetPersistence,
  BudgetReplayBucket,
  BudgetReplayEvent,
  BudgetReplayUntil,
} from '../../budget/engine.js'
import { BudgetLedger } from '../../budget/ledger.js'
import { EvidenceStore } from '../../evidence/store.js'
import { ruleBucketKey, toolLimitKey } from '../bucket-key.js'
import { buildMetadataView, decide } from '../decision-pipeline.js'
import type { DecideInput, PipelineDecision } from '../decision-pipeline.js'
import { matchRule, resolvePath } from '../matchers.js'
import { RateLimiter } from '../rate-limiter.js'
import {
  gateBudgetCharges,
  gateSession,
  mintLedgerCharges,
  repriceGatedCharges,
  sessionLimitKey,
} from '../session-gate.js'
import { SpendLimiter } from '../spend-limiter.js'
import type { CompiledPolicyRule, MatchContext } from '../types.js'
import {
  buildDecideInput,
  budgetBlocksOf,
  compileCandidate,
  dependencyFactOf,
  executionStateOf,
  recordedAnswers,
  resolveRowAnnotations,
  seedEvidence,
  skipReasonOf,
  storedOutcome,
} from './context.js'
import type { CandidateContext, RecordedAnswers, ResolvedAnnotations } from './context.js'
import {
  HistoricalTracker,
  aggregateWarnings,
  createLimitPin,
  renderFidelityLines,
  ruleLabel,
  subjectOf,
} from './fidelity.js'
import type { MarkedInstant } from './fidelity.js'
import type {
  BudgetCheck,
  ConfigEpoch,
  FidelityMark,
  PolicySimulationEpochSelector,
  PolicySimulationOptions,
  PolicySimulationResult,
  SimulatedOutcome,
  SimulatedRow,
  SkippedRows,
  TicketKind,
  VirtualClock,
} from './types.js'

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------

/** A clock every store of a run reads, moved by the replay to each row's instant. */
export function createVirtualClock(startMs: number): VirtualClock {
  let nowMs = startMs
  return {
    now: () => nowMs,
    set: (ms) => {
      nowMs = ms
    },
  }
}

// ---------------------------------------------------------------------------
// The write-noop ledger
// ---------------------------------------------------------------------------

/** One write the wrapper swallowed, with the virtual instant it arrived at. */
export interface ReplayLedgerWrite {
  readonly method: 'writeMeta' | 'writeMetaBatch' | 'recordBucketGc' | 'commitAll'
  readonly at: number
}

/**
 * The ledger a simulation's budget engine sees: every read delegates to the
 * real ledger with the epoch's bound, so the hydrate loads only the calls
 * earlier than the first row it will replay; every write is recorded and
 * dropped, so a first-boot pot, a tuple change or an idle sweep touches
 * nothing on disk. It carries all eight persistence members, so the engine
 * treats it as persistence and hydrates through it.
 */
export class ReplayLedger implements BudgetPersistence {
  private readonly recorded: ReplayLedgerWrite[] = []

  constructor(
    private readonly inner: BudgetLedger,
    private readonly clock: VirtualClock,
    private readonly until: BudgetReplayUntil,
  ) {}

  /** The writes swallowed so far, in order. */
  get writes(): readonly ReplayLedgerWrite[] {
    return this.recorded
  }

  readMeta(budgetName: string): BudgetMetaRow | undefined {
    return this.inner.readMeta(budgetName)
  }

  readAllMeta(): readonly BudgetMetaRow[] {
    return this.inner.readAllMeta()
  }

  maxEventEpoch(budgetName: string): number {
    return this.inner.maxEventEpoch(budgetName)
  }

  replayDurationEvents(
    budgetName: string,
    epoch: number,
    sinceMs: number,
  ): readonly BudgetReplayEvent[] {
    return this.inner.replayDurationEvents(budgetName, epoch, sinceMs, this.until)
  }

  replaySessionBuckets(budgetName: string, epoch: number): readonly BudgetReplayBucket[] {
    return this.inner.replaySessionBuckets(budgetName, epoch, this.until)
  }

  writeMeta(_meta: BudgetMetaRow): void {
    this.swallow('writeMeta')
  }

  writeMetaBatch(_metas: readonly BudgetMetaRow[]): void {
    this.swallow('writeMetaBatch')
  }

  recordBucketGc(_budgetName: string, _bucketKey: string, _gcAfterMs: number): void {
    this.swallow('recordBucketGc')
  }

  commitAll(_rows: readonly BudgetLedgerRow[]): void {
    this.swallow('commitAll')
  }

  private swallow(method: ReplayLedgerWrite['method']): void {
    this.recorded.push({ method, at: this.clock.now() })
  }
}

// ---------------------------------------------------------------------------
// Epoch selection
// ---------------------------------------------------------------------------

interface EpochSelection {
  readonly epochs: readonly ConfigEpoch[]
  /** Absent when nothing is selected (a hash the window does not hold). */
  readonly rowFilters?: ReplayRowFilters
  /** The selected epoch's first `timestamp`. */
  readonly t0: string
  /** The epoch's end in epoch milliseconds, the bound on dangling ledger rows; absent on the latest epoch. */
  readonly endMs?: number
}

function selectEpoch(
  runs: readonly ConfigEpochRun[],
  selector: PolicySimulationEpochSelector,
  filters: ReplayFilters,
): EpochSelection | null {
  const first = runs[0]
  if (first === undefined) return null
  if (selector === 'all') {
    return {
      epochs: runs.map((run) => ({ ...run, selected: true })),
      rowFilters: { ...filters },
      t0: first.first_timestamp,
      ...(filters.to !== undefined ? { endMs: Date.parse(filters.to) } : {}),
    }
  }
  let index = runs.length - 1
  if (selector !== 'latest') {
    index = runs.findLastIndex((run) => run.config_sha256 === selector.configSha256)
  }
  const run = runs[index]
  if (run === undefined) {
    return {
      epochs: runs.map((entry) => ({ ...entry, selected: false })),
      t0: first.first_timestamp,
    }
  }
  const next = runs[index + 1]
  const from =
    filters.from !== undefined && filters.from > run.first_timestamp
      ? filters.from
      : run.first_timestamp
  return {
    epochs: runs.map((entry, position) => ({ ...entry, selected: position === index })),
    rowFilters: {
      ...filters,
      from,
      configSha256: run.config_sha256,
      ...(next !== undefined ? { before: next.first_timestamp } : {}),
    },
    t0: run.first_timestamp,
    ...(next !== undefined ? { endMs: Date.parse(next.first_timestamp) } : {}),
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isLimitAction(action: string): action is 'rate_limit' | 'spend_limit' {
  return action === 'rate_limit' || action === 'spend_limit'
}

function senderIdOf(row: AuditRecord): string | null {
  const sender = row.metadata?.['sender_id']
  return typeof sender === 'string' ? sender : null
}

function isChargeableAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** The limiter block the live door committed on a sideband row or an expired one, if any. */
function consumedKindOf(row: AuditRecord): 'rate' | 'spend' | null {
  if (executionStateOf(row) !== 'executed') return null
  if (row.origin === 'mcp' && row.record_kind === 'tool_call') {
    if (row.policy_decision === 'rate_limit') return 'rate'
    if (row.policy_decision === 'spend_limit') return 'spend'
    return null
  }
  const chain = row.evidence_chain ?? {}
  if (chain['rate_limit'] !== undefined) return 'rate'
  if (chain['spend_limit'] !== undefined) return 'spend'
  return null
}

function outcomeOf(
  policy_decision: string,
  block_reason: string | null,
  dry_run: boolean,
  ticket: TicketKind,
): SimulatedOutcome {
  return { policy_decision, block_reason, dry_run, ticket }
}

function sameOutcome(a: SimulatedOutcome, b: SimulatedOutcome): boolean {
  return (
    a.policy_decision === b.policy_decision &&
    a.block_reason === b.block_reason &&
    a.dry_run === b.dry_run &&
    a.ticket === b.ticket
  )
}

interface SimulatedGate {
  readonly simulated: SimulatedOutcome
  readonly ticketAnswer: SimulatedRow['ticket_answer']
}

/** The windows a candidate rule or pot can ask the limiter warm-up to reach back over. */
function candidateWindowsMs(candidate: CandidateContext): number {
  let span = 0
  for (const rule of candidate.policy.rules) {
    span = Math.max(span, rule.limits?.windowMs ?? 0, rule.limits?.maxSpend?.windowMs ?? 0)
  }
  for (const budget of candidate.budgets) {
    if (budget.window.kind === 'duration') span = Math.max(span, budget.window.windowMs)
  }
  return span
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

class ReplayRun {
  private readonly candidate: CandidateContext
  private readonly clock: VirtualClock
  private readonly warn: (message: string) => void
  private suppressed = 0
  private readonly evidenceStore: EvidenceStore
  private readonly candidateRate: RateLimiter
  private readonly candidateSpend: SpendLimiter
  private readonly historical: HistoricalTracker
  private readonly ledger: ReplayLedger | undefined
  private readonly engine: BudgetEngine
  /** Ledger amounts by `audit_record_id` and budget name, two rows for one key summed. */
  private readonly ledgerAmounts = new Map<string, number>()
  /** Evidence keys every snapshot of a session classified. */
  private readonly classified = new Map<string, Set<string>>()
  /** Prerequisite calls the columns could not settle, by session and tool. */
  private readonly unsettled = new Map<
    string,
    Map<string, { readonly upstream: string | null; readonly origin: string }>
  >()
  private readonly rows: SimulatedRow[] = []
  private readonly deltas: SimulatedRow[] = []
  private readonly marks: MarkedInstant[] = []
  private readonly budgetChecks: BudgetCheck[] = []
  private readonly skipped = { rejected: 0, kill_switch: 0 }
  private unreported = 0

  constructor(
    private readonly store: AuditStore,
    private readonly options: PolicySimulationOptions,
    private readonly selection: EpochSelection,
  ) {
    this.candidate = compileCandidate(options.candidate)
    this.clock = options.clock ?? createVirtualClock(0)
    const now = (): number => this.clock.now()
    this.warn =
      options.warn ??
      ((): void => {
        this.suppressed += 1
      })
    this.evidenceStore = new EvidenceStore({ now, cleanupIntervalMs: 0 })
    this.candidateRate = new RateLimiter({ now, cleanupIntervalMs: 0 })
    this.candidateSpend = new SpendLimiter({ now, cleanupIntervalMs: 0 })
    const sources = [options.candidate.source, ...(options.sources ?? [])]
    this.historical = new HistoricalTracker(
      new RateLimiter({ now, cleanupIntervalMs: 0 }),
      new SpendLimiter({ now, cleanupIntervalMs: 0 }),
      createLimitPin(sources),
    )
    // No ledger without its table: constructing one would create it.
    const hasLedger =
      store.database
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'budget_events'")
        .get() !== undefined
    this.ledger = hasLedger
      ? new ReplayLedger(new BudgetLedger({ database: store.database, now }), this.clock, {
          iso: selection.t0,
          ...(selection.endMs !== undefined ? { endMs: selection.endMs } : {}),
        })
      : undefined
    this.engine = new BudgetEngine({
      budgets: this.candidate.budgets,
      now,
      cleanupIntervalMs: 0,
      ...(this.ledger ? { ledger: this.ledger } : {}),
    })
  }

  /** Warm up, hydrate, replay, and assemble the result. */
  run(): PolicySimulationResult {
    const { rowFilters, t0 } = this.selection
    if (rowFilters !== undefined) {
      const t0Ms = Date.parse(t0)
      this.warmUpLimiters(rowFilters, t0Ms)
      this.warmUpSessions(rowFilters, t0)
      this.clock.set(t0Ms)
      this.engine.hydrate()
      this.loadLedgerAmounts(t0Ms)
      for (const row of this.store.iterateReplayRows(rowFilters)) this.replayRow(row)
    }
    return this.result()
  }

  close(): void {
    this.engine.close()
    this.candidateRate.close()
    this.candidateSpend.close()
    this.evidenceStore.close()
  }

  // -------------------------------------------------------------------------
  // Warm-up and hydrate
  // -------------------------------------------------------------------------

  /** The rows inside the longest window before the epoch feed the two limiter tracks and nothing else. */
  private warmUpLimiters(rowFilters: ReplayRowFilters, t0Ms: number): void {
    const span = Math.max(
      candidateWindowsMs(this.candidate),
      this.store.maxSnapshotWindowMs(rowFilters),
    )
    if (span <= 0) return
    const filters: ReplayRowFilters = {
      ...this.operatorFilters(),
      from: new Date(t0Ms - span).toISOString(),
      before: this.selection.t0,
    }
    for (const row of this.store.iterateReplayRows(filters)) {
      if (skipReasonOf(row) !== null) continue
      this.clock.set(Date.parse(row.timestamp))
      const annotations = resolveRowAnnotations(row, this.options.annotations)
      const input = buildDecideInput(
        row,
        this.candidate,
        this.evidenceStore,
        annotations,
        this.warn,
      )
      const pipeline = decide(input)
      if (executionStateOf(row) === 'executed') this.fillWindows(row, pipeline, input)
      const consumed = consumedKindOf(row)
      if (consumed !== null) {
        this.historical.record(row, consumed, ruleLabel(pipeline.decision.matchedRule))
      }
    }
  }

  /** Every row of each session the epoch names, before the epoch, feeds the evidence store only. */
  private warmUpSessions(rowFilters: ReplayRowFilters, t0: string): void {
    const sessions = new Set<string>()
    for (const row of this.store.iterateReplayRows(rowFilters)) {
      if (row.session_id !== null) sessions.add(row.session_id)
    }
    for (const sessionId of sessions) {
      const filters: ReplayRowFilters = { ...this.operatorFilters(), sessionId, before: t0 }
      for (const row of this.store.iterateReplayRows(filters)) {
        if (skipReasonOf(row) !== null) continue
        this.clock.set(Date.parse(row.timestamp))
        this.seedSession(row)
        this.recordDependency(row)
      }
    }
  }

  private operatorFilters(): ReplayFilters {
    const { upstream, sessionId } = this.options
    return {
      ...(upstream !== undefined ? { upstream } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
    }
  }

  private loadLedgerAmounts(t0Ms: number): void {
    if (this.ledger === undefined) return
    const inner = new BudgetLedger({ database: this.store.database, now: () => this.clock.now() })
    for (const event of inner.listEventsSince(t0Ms)) {
      if (event.audit_record_id === null) continue
      const key = `${event.audit_record_id}\u0000${event.budget_name}`
      this.ledgerAmounts.set(key, (this.ledgerAmounts.get(key) ?? 0) + event.amount)
    }
  }

  // -------------------------------------------------------------------------
  // One row
  // -------------------------------------------------------------------------

  private replayRow(row: AuditRecord): void {
    const skip = skipReasonOf(row)
    if (skip !== null) {
      this.skipped[skip] += 1
      return
    }
    this.clock.set(Date.parse(row.timestamp))
    const compare = row.record_kind !== 'evaluation_expired'
    if (!compare) this.unreported += 1
    this.seedSession(row)
    const annotations = resolveRowAnnotations(row, this.options.annotations)
    const input = buildDecideInput(row, this.candidate, this.evidenceStore, annotations, this.warn)
    const pipeline = decide(input)
    const marks: FidelityMark[] = []
    const gate = compare ? this.simulateGates(row, pipeline) : undefined
    this.applyCumulativeState(row, pipeline, input, marks)
    if (gate === undefined) return
    this.markFidelity(row, pipeline, annotations, marks)
    const matchedRule = pipeline.decision.matchedRule
    const simulated: SimulatedRow = {
      record_id: row.id,
      timestamp: row.timestamp,
      tool_name: row.tool_name,
      upstream: row.upstream,
      origin: row.origin,
      session_id: row.session_id,
      stored: storedOutcome(row),
      simulated: gate.simulated,
      matched_rule: matchedRule?.name ?? null,
      matched_rule_index: matchedRule?.index ?? null,
      ticket_answer: gate.ticketAnswer,
      unverified: marks,
    }
    this.rows.push(simulated)
    if (!sameOutcome(simulated.stored, simulated.simulated)) this.deltas.push(simulated)
    for (const mark of marks) this.marks.push({ mark, instant: row.timestamp })
  }

  private seedSession(row: AuditRecord): void {
    seedEvidence(this.evidenceStore, row)
    if (row.origin !== 'mcp' || row.session_id === null) return
    const evidence = row.evidence_chain?.['evidence']
    if (evidence === null || typeof evidence !== 'object') return
    const keys = this.classified.get(row.session_id) ?? new Set<string>()
    for (const list of Object.values(evidence as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue
      for (const key of list) if (typeof key === 'string') keys.add(key)
    }
    this.classified.set(row.session_id, keys)
  }

  // -------------------------------------------------------------------------
  // The gates, in the door's order, peeking only
  // -------------------------------------------------------------------------

  private simulateGates(row: AuditRecord, pipeline: PipelineDecision): SimulatedGate {
    const sideband = row.origin !== 'mcp'
    const { decision } = pipeline
    const action = decision.action
    const none = (policyDecision: string, blockReason: string | null): SimulatedGate => ({
      simulated: outcomeOf(policyDecision, blockReason, false, 'none'),
      ticketAnswer: null,
    })
    if (pipeline.isDryRun) {
      return { simulated: outcomeOf(action, null, true, 'none'), ticketAnswer: null }
    }
    if (pipeline.sessionBlocked) return none('deny', 'policy_denied')
    if (pipeline.evidenceBlocked) {
      const evidence = pipeline.evidenceResult
      const reason =
        evidence !== undefined && !evidence.satisfied
          ? evidence.expired.length > 0
            ? 'evidence_expired'
            : 'evidence_missing'
          : 'dependency_missing'
      return none('deny', sideband ? 'policy_denied' : reason)
    }
    if (pipeline.driftBlocked) {
      return none('deny', sideband ? 'policy_denied' : 'tool_definition_drift')
    }
    const answers = recordedAnswers(row)
    let ticket: TicketKind = 'none'
    let ticketAnswer: SimulatedRow['ticket_answer'] = null
    switch (action) {
      case 'allow':
        break
      case 'deny':
        return none('deny', 'policy_denied')
      case 'require_approval': {
        ticket = 'rule'
        if (answers.rule === null) {
          return {
            simulated: outcomeOf('require_approval', null, false, 'rule'),
            ticketAnswer: 'unanswered',
          }
        }
        ticketAnswer = 'recorded'
        if (answers.rule !== 'approved' && answers.rule !== 'break_glass') {
          return {
            simulated: outcomeOf('require_approval', row.block_reason, false, 'rule'),
            ticketAnswer,
          }
        }
        break
      }
      case 'rate_limit': {
        const refused = this.peekRate(row, decision.matchedRule)
        if (refused !== null) return none('rate_limit', refused)
        break
      }
      case 'spend_limit': {
        const refused = this.peekSpend(row, decision.matchedRule)
        if (refused !== null) return none('spend_limit', refused)
        break
      }
      default:
        return none('deny', 'policy_denied')
    }
    return this.peekBudgets(row, action, ticket, ticketAnswer, answers, sideband)
  }

  /** The candidate's base key for a limit rule on this row, or null when a session key has no identity. */
  private candidateBaseKey(
    row: AuditRecord,
    keyType: 'tool' | 'agent' | 'session' | 'sender_id' | undefined,
  ): string | null {
    if (keyType === 'session') {
      const gate = gateSession(row.session_id, this.candidate.session.onUnresolved)
      return gate.ok ? sessionLimitKey(gate.session) : null
    }
    if (row.origin === 'mcp') return toolLimitKey(row.tool_name, row.upstream ?? undefined)
    if (keyType === 'sender_id') return `sender:${senderIdOf(row) ?? 'unknown'}`
    return toolLimitKey(row.tool_name)
  }

  private peekRate(row: AuditRecord, rule: CompiledPolicyRule | undefined): string | null {
    const limits = rule?.limits
    if (rule === undefined || !limits?.maxCalls || !limits.windowMs) return 'policy_denied'
    const base = this.candidateBaseKey(row, limits.key)
    if (base === null) return 'session_unresolved'
    const result = this.candidateRate.peek({
      key: ruleBucketKey(base, rule.index),
      maxCalls: limits.maxCalls,
      windowMs: limits.windowMs,
    })
    return result.allowed ? null : 'rate_limited'
  }

  private peekSpend(row: AuditRecord, rule: CompiledPolicyRule | undefined): string | null {
    const maxSpend = rule?.limits?.maxSpend
    if (rule === undefined || maxSpend === undefined) return 'policy_denied'
    const base = this.candidateBaseKey(row, maxSpend.key)
    if (base === null) return 'session_unresolved'
    const amount = resolvePath(maxSpend.field, row.tool_input)
    if (typeof amount !== 'number') return 'spend_limited'
    const result = this.candidateSpend.peek({
      key: ruleBucketKey(base, rule.index),
      amount,
      limit: maxSpend.limit,
      windowMs: maxSpend.windowMs,
    })
    return result.allowed ? null : 'spend_limited'
  }

  private peekBudgets(
    row: AuditRecord,
    action: string,
    ruleTicket: TicketKind,
    ruleAnswer: SimulatedRow['ticket_answer'],
    answers: RecordedAnswers,
    sideband: boolean,
  ): SimulatedGate {
    const proceed: SimulatedGate = {
      simulated: outcomeOf(action, null, false, ruleTicket),
      ticketAnswer: ruleAnswer,
    }
    if (this.candidate.budgets.length === 0) return proceed
    const gate = gateSession(row.session_id, this.candidate.session.onUnresolved)
    const resolved = this.engine.resolveCharges({
      toolName: row.tool_name,
      toolArguments: row.tool_input,
      sessionId: gate.ok ? gate.session : null,
      senderId: senderIdOf(row),
      upstream: row.upstream,
    })
    if (resolved.charges.length === 0 && resolved.failures.length === 0) return proceed
    const gated = gateBudgetCharges(resolved, gate, this.warn)
    if (!gated.ok) {
      return {
        simulated: outcomeOf(action, 'session_unresolved', false, ruleTicket),
        ticketAnswer: ruleAnswer,
      }
    }
    const peek =
      resolved.charges.length > 0
        ? this.engine.peekAll(gated.charges)
        : { allowed: true, entries: [] as BudgetPeekEntry[] }
    const breaches = peek.entries.filter((entry) => !entry.allowed)
    if (
      resolved.failures.length > 0 ||
      breaches.some((entry) => entry.budget.onExceed === 'deny')
    ) {
      return {
        simulated: outcomeOf(action, 'budget_exceeded', false, ruleTicket),
        ticketAnswer: ruleAnswer,
      }
    }
    if (breaches.length === 0) return proceed
    // Every breach asks a human: a budget ticket, merged into the rule's on
    // the MCP door, the one ticket a sideband row has.
    const ticket: TicketKind = ruleTicket === 'rule' ? (sideband ? 'rule' : 'both') : 'budget'
    if (answers.money === null) {
      return { simulated: outcomeOf(action, null, false, ticket), ticketAnswer: 'unanswered' }
    }
    if (answers.money === 'approved' || answers.money === 'break_glass') {
      return { simulated: outcomeOf(action, null, false, ticket), ticketAnswer: 'recorded' }
    }
    return {
      simulated: outcomeOf(action, row.block_reason, false, ticket),
      ticketAnswer: 'recorded',
    }
  }

  // -------------------------------------------------------------------------
  // Cumulative state: what the recorded call did
  // -------------------------------------------------------------------------

  private applyCumulativeState(
    row: AuditRecord,
    pipeline: PipelineDecision,
    input: DecideInput,
    marks: FidelityMark[],
  ): void {
    const state = executionStateOf(row)
    const first = pipeline.decision.matchedRule
    if (state === 'executed') {
      this.fillWindows(row, pipeline, input)
      this.chargePots(row)
    } else if (state === 'unsettled' && isLimitAction(row.policy_decision)) {
      // A sideband limit row with no commit block: a slot the columns cannot
      // settle, named whatever the candidate matches now.
      marks.push({
        rule: ruleLabel(first),
        dimension: 'rate window',
        subject: subjectOf(row.tool_name, row.upstream, row.origin),
      })
    }
    this.recordDependency(row)
    const consumed = consumedKindOf(row)
    if (consumed !== null) {
      const mark = this.historical.record(row, consumed, ruleLabel(first))
      if (mark !== null) marks.push(mark)
    }
  }

  /**
   * The windows an executed call consumes under the candidate: its first
   * matching rule's when that is a limit rule; when that is a deny and the
   * live call consumed a slot, the later candidate rule with the row's
   * action and `matched_rule` name, the first such, and only while the call
   * still matches it. A null name keeps nothing; neither branch needs the pin.
   */
  private fillWindows(row: AuditRecord, pipeline: PipelineDecision, input: DecideInput): void {
    const first = pipeline.decision.matchedRule
    if (first === undefined) return
    if (isLimitAction(first.action)) {
      this.recordCandidateWindow(first, row)
      return
    }
    if (first.action !== 'deny' || row.matched_rule === null || consumedKindOf(row) === null) return
    const later = this.candidate.policy.rules.find(
      (rule) =>
        rule.index > first.index &&
        rule.action === row.policy_decision &&
        rule.name === row.matched_rule,
    )
    if (later === undefined) return
    const ctx: MatchContext = {
      toolName: input.toolName,
      annotations: input.baselineAnnotations,
      toolArguments: input.toolArguments,
      environment: input.environment,
      metadata: buildMetadataView(input.metadata, input.agentId),
      upstream: input.upstream,
    }
    if (matchRule(later, ctx)) this.recordCandidateWindow(later, row)
  }

  private recordCandidateWindow(rule: CompiledPolicyRule, row: AuditRecord): void {
    const limits = rule.limits
    if (rule.action === 'rate_limit') {
      if (!limits?.maxCalls || !limits.windowMs) return
      const base = this.candidateBaseKey(row, limits.key)
      if (base === null) return
      this.candidateRate.record({
        key: ruleBucketKey(base, rule.index),
        maxCalls: limits.maxCalls,
        windowMs: limits.windowMs,
      })
      return
    }
    const maxSpend = limits?.maxSpend
    if (maxSpend === undefined) return
    const amount = resolvePath(maxSpend.field, row.tool_input)
    if (!isChargeableAmount(amount)) return
    const base = this.candidateBaseKey(row, maxSpend.key)
    if (base === null) return
    this.candidateSpend.record({
      key: ruleBucketKey(base, rule.index),
      amount,
      limit: maxSpend.limit,
      windowMs: maxSpend.windowMs,
    })
  }

  /** Charge every candidate pot the executed call feeds, at the ledger's amount when a row exists. */
  private chargePots(row: AuditRecord): void {
    if (this.candidate.budgets.length === 0) return
    const gate = gateSession(row.session_id, this.candidate.session.onUnresolved)
    const resolved = this.engine.resolveCharges({
      toolName: row.tool_name,
      toolArguments: row.tool_input,
      sessionId: gate.ok ? gate.session : null,
      senderId: senderIdOf(row),
      upstream: row.upstream,
    })
    if (resolved.charges.length === 0 && resolved.failures.length === 0) return
    const gated = gateBudgetCharges(resolved, gate, this.warn)
    if (!gated.ok) return
    const ledgerAmount = (name: string): number | undefined =>
      this.ledgerAmounts.get(`${row.id}\u0000${name}`)
    // Every pot the call fed moves: at the ledger's amount when a row exists,
    // which also charges a pot whose candidate field the call's arguments do
    // not resolve, else at the candidate's resolved amount.
    const charges = [
      ...repriceGatedCharges(
        gated.charges,
        (charge) => ledgerAmount(charge.budget.name) ?? charge.amount,
      ),
      ...mintLedgerCharges(gated, resolved.failures, (failure) =>
        ledgerAmount(failure.budget.name),
      ),
    ] as unknown as typeof gated.charges
    if (charges.length === 0) return
    const snapshots = this.engine.recordAll(charges, {
      kind: 'spend',
      auditRecordId: row.id,
      origin: row.origin,
      toolName: row.tool_name,
      timestampIso: row.timestamp,
    })
    if (row.config_sha256 !== this.candidate.sha256) return
    for (const block of budgetBlocksOf(row)) {
      if (typeof block['kind'] !== 'string' || block['stale'] === true) continue
      const stored = block['spent']
      const snapshot = snapshots.find((entry) => entry.budget.name === block['name'])
      if (snapshot === undefined || typeof stored !== 'number') continue
      if (Math.abs(stored - snapshot.spent) < 1e-9) continue
      this.budgetChecks.push({
        budget: snapshot.budget.name,
        timestamp: row.timestamp,
        stored_spent: stored,
        simulated_spent: snapshot.spent,
      })
    }
  }

  private recordDependency(row: AuditRecord): void {
    const fact = dependencyFactOf(row)
    if (fact === 'none' || row.session_id === null) return
    if (fact === 'unsettled') {
      const tools =
        this.unsettled.get(row.session_id) ??
        new Map<string, { readonly upstream: string | null; readonly origin: string }>()
      tools.set(row.tool_name, { upstream: row.upstream, origin: row.origin })
      this.unsettled.set(row.session_id, tools)
      return
    }
    this.evidenceStore.recordToolCall(row.session_id, row.tool_name, fact === 'succeeded')
  }

  // -------------------------------------------------------------------------
  // What the row could not verify
  // -------------------------------------------------------------------------

  private markFidelity(
    row: AuditRecord,
    pipeline: PipelineDecision,
    annotations: ResolvedAnnotations,
    marks: FidelityMark[],
  ): void {
    const rule = pipeline.decision.matchedRule
    const label = ruleLabel(rule)
    const subject = subjectOf(row.tool_name, row.upstream, row.origin)
    if (annotations.step === 'unknown') {
      const matchedIndex = rule?.index ?? Number.POSITIVE_INFINITY
      const evaluated = this.candidate.policy.rules.some(
        (candidate) =>
          candidate.index <= matchedIndex &&
          candidate.match.annotations !== undefined &&
          (candidate.match.tool === undefined || candidate.match.tool.test(row.tool_name)),
      )
      if (evaluated || pipeline.flaggedDestructive) {
        marks.push({ rule: label, dimension: 'tool annotations', subject })
      }
    }
    if (row.origin !== 'mcp')
      marks.push({ rule: label, dimension: 'tool definition drift', subject })
    if (pipeline.evidenceResult !== undefined && rule?.evidence !== undefined) {
      const classified = row.session_id === null ? undefined : this.classified.get(row.session_id)
      if (row.origin !== 'mcp' || rule.evidence.requires.some((key) => !classified?.has(key))) {
        marks.push({ rule: label, dimension: 'evidence', subject })
      }
    }
    if (
      pipeline.dependencyResult !== undefined &&
      rule?.requires !== undefined &&
      row.session_id !== null
    ) {
      const tools = this.unsettled.get(row.session_id)
      for (const tool of rule.requires) {
        const where = tools?.get(tool)
        if (where !== undefined) {
          marks.push({
            rule: label,
            dimension: 'dependency state',
            subject: subjectOf(tool, where.upstream, where.origin),
          })
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // The result
  // -------------------------------------------------------------------------

  private result(): PolicySimulationResult {
    const skipped: SkippedRows = { ...this.skipped }
    const warnings = aggregateWarnings(this.marks)
    const unreported = this.unreported
    return {
      candidate_sha256: this.candidate.sha256,
      epochs: this.selection.epochs,
      replayed: this.rows.length,
      skipped,
      unreported,
      rows: this.rows,
      deltas: this.deltas,
      fidelity: {
        lines: renderFidelityLines({ warnings, skipped, unreported }),
        warnings,
        skipped,
        unreported,
      },
      budget_checks: this.budgetChecks,
      warnings_suppressed: this.suppressed,
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Replay the selected config epoch of the audit trail against the candidate
 * policy and report, per row, the outcome the door stored beside the one
 * the candidate would have produced, with what could not be verified. Reads
 * the database and the ledger, writes neither, calls no upstream.
 */
export function simulatePolicy(options: PolicySimulationOptions): PolicySimulationResult {
  const filters: ReplayFilters = {
    ...(options.window?.from !== undefined ? { from: options.window.from } : {}),
    ...(options.window?.to !== undefined ? { to: options.window.to } : {}),
    ...(options.upstream !== undefined ? { upstream: options.upstream } : {}),
    ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
  }
  const selection = selectEpoch(
    options.store.listConfigEpochs(filters),
    options.epoch ?? 'latest',
    filters,
  )
  if (selection === null) {
    const skipped: SkippedRows = { rejected: 0, kill_switch: 0 }
    return {
      candidate_sha256: options.candidate.source.sha256,
      epochs: [],
      replayed: 0,
      skipped,
      unreported: 0,
      rows: [],
      deltas: [],
      fidelity: {
        lines: renderFidelityLines({ warnings: [], skipped, unreported: 0 }),
        warnings: [],
        skipped,
        unreported: 0,
      },
      budget_checks: [],
      warnings_suppressed: 0,
    }
  }
  const run = new ReplayRun(options.store, options, selection)
  try {
    return run.run()
  } finally {
    run.close()
  }
}
