import { describe, it, expect } from 'vitest'
import { AuditStore } from '../../audit/store.js'
import { buildHeaderMismatchAuditRecord } from '../../audit/header-mismatch.js'
import { buildBaselineAcceptedRecord } from '../../baseline/record.js'
import { ToolBaselineStore } from '../../baseline/store.js'
import { EvidenceStore } from '../../evidence/store.js'
import { checkEvidence } from '../../evidence/grounding.js'
import {
  at,
  candidateWith,
  expiredRow,
  mcpRow,
  sidebandRow,
} from '../../__tests__/helpers/simulation-rows.js'
import {
  buildDecideInput,
  compileCandidate,
  dependencyFactOf,
  executionStateOf,
  recordedAnswers,
  resolveRowAnnotations,
  seedEvidence,
  skipReasonOf,
  storedOutcome,
  storedTicketKind,
  trailAnnotationSource,
} from './context.js'
import type { AnnotationSource } from './types.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const READ_ONLY = { readOnlyHint: true, destructiveHint: false }
const MUTATION = { readOnlyHint: false, destructiveHint: false }

/** A source that knows one tool with the given hints and nothing else. */
function sourceKnowing(tool: string, hints: Record<string, boolean> | undefined): AnnotationSource {
  return {
    resolve: (query) =>
      query.tool === tool ? { kind: 'known', hints, source: 'test' } : { kind: 'unknown' },
  }
}

const UNKNOWN_SOURCE: AnnotationSource = { resolve: () => ({ kind: 'unknown' }) }

function memoryStore(): AuditStore {
  return new AuditStore({
    path: ':memory:',
    retention: '90d',
    includeResponses: true,
    cleanupIntervalMs: 0,
  })
}

const candidate = compileCandidate(
  candidateWith({
    rules: "    - name: reads\n      match: { tool: 'get_*' }\n      action: allow",
    session: '  on_unresolved: anonymous',
  }),
)

// ---------------------------------------------------------------------------
// The matrix: every DecideInput field from a row
// ---------------------------------------------------------------------------

describe('buildDecideInput', () => {
  it('rebuilds every matrix field from an MCP row, null columns to undefined', () => {
    const evidenceStore = new EvidenceStore({ cleanupIntervalMs: 0 })
    const warn = (): void => {}
    const row = mcpRow({
      session_id: null,
      session_source: null,
      environment: 'prod',
      tool_input: {},
    })
    const input = buildDecideInput(
      row,
      candidate,
      evidenceStore,
      resolveRowAnnotations(row, sourceKnowing('send_email', READ_ONLY)),
      warn,
    )
    expect(input.toolName).toBe('send_email')
    expect(input.toolArguments).toBe(row.tool_input)
    expect(input.sessionId).toBeUndefined()
    expect(input.sessionStrategySummary).toBe(candidate.session.strategySummary)
    expect(input.policy).toBe(candidate.policy)
    expect(input.environment).toBe('prod')
    expect(input.evidenceStore).toBe(evidenceStore)
    expect(input.baselineAnnotations).toEqual(READ_ONLY)
    expect(input.currentAnnotations).toEqual(READ_ONLY)
    expect(input.driftEvent).toBeUndefined()
    expect(input.metadata).toBeUndefined()
    expect(input.agentId).toBeUndefined()
    expect(input.upstream).toBeUndefined()
    expect(input.warn).toBe(warn)
    evidenceStore.close()
  })

  it('passes a sideband row its metadata, agent id and session, and the row environment, never the candidate label', () => {
    const labeled = compileCandidate(candidateWith({ environment: 'staging' }))
    const evidenceStore = new EvidenceStore({ cleanupIntervalMs: 0 })
    const row = sidebandRow({
      session_id: 'adapter-session',
      metadata: { sender_id: 'u1', channel_id: 'C1' },
      agent_id: 'agent-9',
      environment: null,
      upstream: null,
    })
    const input = buildDecideInput(
      row,
      labeled,
      evidenceStore,
      resolveRowAnnotations(row, UNKNOWN_SOURCE),
      () => {},
    )
    expect(input.sessionId).toBe('adapter-session')
    expect(input.metadata).toEqual({ sender_id: 'u1', channel_id: 'C1' })
    expect(input.agentId).toBe('agent-9')
    expect(input.environment).toBeUndefined()
    expect(input.upstream).toBeUndefined()
    expect(input.baselineAnnotations).toBeUndefined()
    expect(input.currentAnnotations).toBeUndefined()
    expect(input.driftEvent).toBeUndefined()
    evidenceStore.close()
  })

  it('passes a named door through as upstream', () => {
    const evidenceStore = new EvidenceStore({ cleanupIntervalMs: 0 })
    const row = mcpRow({ upstream: 'crm' })
    const input = buildDecideInput(
      row,
      candidate,
      evidenceStore,
      resolveRowAnnotations(row, UNKNOWN_SOURCE),
      () => {},
    )
    expect(input.upstream).toBe('crm')
    evidenceStore.close()
  })
})

// ---------------------------------------------------------------------------
// Annotations: the three steps
// ---------------------------------------------------------------------------

describe('resolveRowAnnotations', () => {
  const source = sourceKnowing('send_email', MUTATION)

  it('step 1: an annotations change carries the baseline and the current side', () => {
    const changes = [{ aspect: 'annotations', baseline: READ_ONLY, current: MUTATION }]
    const row = mcpRow({ evidence_chain: { tool_drift: { mode: 'log', changes } } })
    const resolved = resolveRowAnnotations(row, source)
    expect(resolved).toEqual({
      baseline: READ_ONLY,
      current: MUTATION,
      driftEvent: { toolName: 'send_email', changes },
      step: 'drift',
      source: null,
    })
  })

  it('step 1: an other change carries whole definitions, read for their annotations', () => {
    const changes = [
      {
        aspect: 'other',
        baseline: { name: 'send_email', annotations: READ_ONLY },
        current: { name: 'send_email', annotations: MUTATION, extra: true },
      },
    ]
    const row = mcpRow({ evidence_chain: { tool_drift: { mode: 'block', changes } } })
    const resolved = resolveRowAnnotations(row, source)
    expect(resolved.baseline).toEqual(READ_ONLY)
    expect(resolved.current).toEqual(MUTATION)
    expect(resolved.step).toBe('drift')
  })

  it('step 1: a duplicate change has no current side, and no baseline side when the tool had none', () => {
    const withBaseline = mcpRow({
      evidence_chain: {
        tool_drift: {
          mode: 'block',
          changes: [{ aspect: 'duplicate', baseline: { annotations: READ_ONLY }, current: 2 }],
        },
      },
    })
    expect(resolveRowAnnotations(withBaseline, source).baseline).toEqual(READ_ONLY)
    expect(resolveRowAnnotations(withBaseline, source).current).toBeUndefined()
    const withoutBaseline = mcpRow({
      evidence_chain: {
        tool_drift: { mode: 'block', changes: [{ aspect: 'duplicate', current: 2 }] },
      },
    })
    expect(resolveRowAnnotations(withoutBaseline, source).baseline).toBeUndefined()
    expect(resolveRowAnnotations(withoutBaseline, source).step).toBe('drift')
  })

  it('step 1: a drift naming other aspects only keeps the drift event and takes the step 2 hints', () => {
    const changes = [{ aspect: 'inputSchema', baseline: { a: 1 }, current: { a: 2 } }]
    const row = mcpRow({ evidence_chain: { tool_drift: { mode: 'log', changes } } })
    const resolved = resolveRowAnnotations(row, source)
    expect(resolved.driftEvent).toEqual({ toolName: 'send_email', changes })
    expect(resolved.baseline).toEqual(MUTATION)
    expect(resolved.current).toEqual(MUTATION)
    expect(resolved.step).toBe('source')
    const unknown = resolveRowAnnotations(row, UNKNOWN_SOURCE)
    expect(unknown.driftEvent).toEqual({ toolName: 'send_email', changes })
    expect(unknown.baseline).toBeUndefined()
    expect(unknown.step).toBe('unknown')
  })

  it('step 2 and step 3: the source answers an undrifted row, unknown when it cannot', () => {
    expect(resolveRowAnnotations(mcpRow(), source)).toEqual({
      baseline: MUTATION,
      current: MUTATION,
      driftEvent: undefined,
      step: 'source',
      source: 'test',
    })
    const hintless = resolveRowAnnotations(mcpRow(), sourceKnowing('send_email', undefined))
    expect(hintless.step).toBe('source')
    expect(hintless.baseline).toBeUndefined()
    expect(resolveRowAnnotations(mcpRow(), UNKNOWN_SOURCE)).toEqual({
      baseline: undefined,
      current: undefined,
      driftEvent: undefined,
      step: 'unknown',
      source: null,
    })
  })
})

describe('trailAnnotationSource', () => {
  const T0 = at(0)
  const definition = (hints: Record<string, boolean> | undefined): Record<string, unknown> => ({
    name: 'send_email',
    inputSchema: { type: 'object' },
    ...(hints ? { annotations: hints } : {}),
  })
  const acceptance = (
    timestamp: string,
    upstream: string | null,
    changes: ReadonlyArray<{ aspect: string; baseline?: unknown; current?: unknown }>,
  ) => ({
    ...buildBaselineAcceptedRecord({
      tool: 'send_email',
      upstream,
      environment: null,
      changes: changes as never,
      accepted: {
        by: 'ops',
        previous_fingerprint: 'p',
        fingerprint: 'f',
        first_seen: T0,
        persisted: true,
      },
    }),
    timestamp,
  })
  const query = (timestamp: string, upstream: string | null = 'crm', origin = 'mcp') => ({
    upstream,
    tool: 'send_email',
    origin,
    timestamp,
  })

  it('reads the table row for a call it predates, and nothing for a call before first_seen', () => {
    const store = memoryStore()
    try {
      const baselines = new ToolBaselineStore({ database: store.database })
      baselines.insertNew(
        'crm',
        [{ tool: 'send_email', definition: definition(READ_ONLY), fingerprint: 'f' }],
        T0,
      )
      const source = trailAnnotationSource(store)
      expect(source.resolve(query(at(60)))).toEqual({
        kind: 'known',
        hints: READ_ONLY,
        source: 'tool_baselines',
      })
      expect(source.resolve(query(T0))).toEqual({
        kind: 'known',
        hints: READ_ONLY,
        source: 'tool_baselines',
      })
      expect(source.resolve(query(at(-1)))).toEqual({ kind: 'unknown' })
      expect(source.resolve(query(at(60), 'billing'))).toEqual({ kind: 'unknown' })
      expect(source.resolve({ ...query(at(60)), tool: 'other' })).toEqual({ kind: 'unknown' })
    } finally {
      store.close()
    }
  })

  it('unwinds later acceptances in timestamp order, hints as hints and other through the definition', () => {
    const store = memoryStore()
    try {
      const baselines = new ToolBaselineStore({ database: store.database })
      baselines.insertNew(
        'crm',
        [
          {
            tool: 'send_email',
            definition: definition({ destructiveHint: true }),
            fingerprint: 'f',
          },
        ],
        T0,
      )
      // Inserted newest first so the read's own order is what sorts them.
      store.insert(
        acceptance(at(180), 'crm', [
          {
            aspect: 'other',
            baseline: definition(MUTATION),
            current: definition({ destructiveHint: true }),
          },
        ]),
      )
      store.insert(
        acceptance(at(120), 'crm', [
          { aspect: 'annotations', baseline: READ_ONLY, current: MUTATION },
        ]),
      )
      store.insert(
        acceptance(at(90), 'crm', [
          { aspect: 'inputSchema', baseline: { a: 1 }, current: { a: 2 } },
        ]),
      )
      const source = trailAnnotationSource(store)
      // Before every acceptance: the inputSchema-only one supplies nothing, the annotations one answers.
      expect(source.resolve(query(at(30)))).toEqual({
        kind: 'known',
        hints: READ_ONLY,
        source: 'baseline_accepted',
      })
      // Between the annotations acceptance and the other one: the other's baseline definition.
      expect(source.resolve(query(at(150)))).toEqual({
        kind: 'known',
        hints: MUTATION,
        source: 'baseline_accepted',
      })
      // After every acceptance: the table row of now.
      expect(source.resolve(query(at(200)))).toEqual({
        kind: 'known',
        hints: { destructiveHint: true },
        source: 'tool_baselines',
      })
      // An acceptance at the call's own instant is not later than it.
      expect(source.resolve(query(at(120)))).toEqual({
        kind: 'known',
        hints: MUTATION,
        source: 'baseline_accepted',
      })
    } finally {
      store.close()
    }
  })

  it('maps the singular door through the empty-string sentinel and keeps doors apart', () => {
    const store = memoryStore()
    try {
      const baselines = new ToolBaselineStore({ database: store.database })
      baselines.insertNew(
        undefined,
        [{ tool: 'send_email', definition: definition(READ_ONLY), fingerprint: 'f' }],
        T0,
      )
      baselines.insertNew(
        'crm',
        [{ tool: 'send_email', definition: definition(MUTATION), fingerprint: 'g' }],
        T0,
      )
      store.insert(
        acceptance(at(120), null, [
          { aspect: 'annotations', baseline: { destructiveHint: true }, current: READ_ONLY },
        ]),
      )
      const source = trailAnnotationSource(store)
      expect(source.resolve(query(at(60), null))).toEqual({
        kind: 'known',
        hints: { destructiveHint: true },
        source: 'baseline_accepted',
      })
      expect(source.resolve(query(at(60), 'crm'))).toEqual({
        kind: 'known',
        hints: MUTATION,
        source: 'tool_baselines',
      })
    } finally {
      store.close()
    }
  })

  it('names a listed definition without annotations known and hintless', () => {
    const store = memoryStore()
    try {
      new ToolBaselineStore({ database: store.database }).insertNew(
        'crm',
        [{ tool: 'send_email', definition: definition(undefined), fingerprint: 'f' }],
        T0,
      )
      expect(trailAnnotationSource(store).resolve(query(at(60)))).toEqual({
        kind: 'known',
        hints: undefined,
        source: 'tool_baselines',
      })
    } finally {
      store.close()
    }
  })

  it('answers unknown for every sideband row and for a database with no tool_baselines table', () => {
    const store = memoryStore()
    try {
      const bare = trailAnnotationSource(store)
      expect(bare.resolve(query(at(60)))).toEqual({ kind: 'unknown' })
      const tables = store.database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tool_baselines'")
        .all()
      expect(tables).toEqual([])
      new ToolBaselineStore({ database: store.database }).insertNew(
        'crm',
        [{ tool: 'send_email', definition: definition(READ_ONLY), fingerprint: 'f' }],
        T0,
      )
      const source = trailAnnotationSource(store)
      expect(source.resolve(query(at(60), null, 'lab-adapter'))).toEqual({ kind: 'unknown' })
      expect(source.resolve(query(at(60), 'crm', 'lab-adapter'))).toEqual({ kind: 'unknown' })
    } finally {
      store.close()
    }
  })
})

// ---------------------------------------------------------------------------
// Evidence seeding by classification
// ---------------------------------------------------------------------------

describe('seedEvidence', () => {
  const HOUR = 3_600_000
  const snapshot = (found: string[], expired: string[], missing: string[]) => ({
    blocked: false,
    evidence: { required: [...found, ...missing, ...expired], found, missing, expired },
  })

  it('pins found keys, evicts expired ones as seen, leaves missing ones untouched', () => {
    let nowMs = Date.parse(at(0))
    const store = new EvidenceStore({ now: () => nowMs, cleanupIntervalMs: 0 })
    seedEvidence(store, mcpRow({ session_id: 's', evidence_chain: snapshot(['a'], ['b'], ['c']) }))
    expect(checkEvidence(store, 's', ['a', 'b', 'c'])).toEqual({
      satisfied: false,
      missing: ['c'],
      expired: ['b'],
      found: ['a'],
    })
    nowMs += 25 * HOUR
    expect(checkEvidence(store, 's', ['a']).found).toEqual(['a'])
    store.close()
  })

  it('downgrades a pinned key on a later expired and promotes an expired one on a later found', () => {
    let nowMs = Date.parse(at(0))
    const store = new EvidenceStore({ now: () => nowMs, cleanupIntervalMs: 0 })
    seedEvidence(store, mcpRow({ session_id: 's', evidence_chain: snapshot(['a'], ['b'], []) }))
    nowMs += HOUR
    seedEvidence(store, mcpRow({ session_id: 's', evidence_chain: snapshot(['b'], ['a'], []) }))
    expect(checkEvidence(store, 's', ['a', 'b'])).toEqual({
      satisfied: false,
      missing: [],
      expired: ['a'],
      found: ['b'],
    })
    // A later missing never deletes a key an earlier snapshot classified.
    seedEvidence(store, mcpRow({ session_id: 's', evidence_chain: snapshot([], [], ['a', 'b']) }))
    expect(checkEvidence(store, 's', ['a', 'b']).found).toEqual(['b'])
    store.close()
  })

  it('seeds nothing from a sideband row, a sessionless row or a row with no snapshot', () => {
    const store = new EvidenceStore({ cleanupIntervalMs: 0 })
    seedEvidence(store, sidebandRow({ session_id: 's', evidence_chain: snapshot(['a'], [], []) }))
    seedEvidence(store, mcpRow({ session_id: null, evidence_chain: snapshot(['a'], [], []) }))
    seedEvidence(store, mcpRow({ session_id: 's', evidence_chain: { blocked: false } }))
    expect(store.sessionCount).toBe(0)
    store.close()
  })
})

// ---------------------------------------------------------------------------
// The dependency predicate and the execution state
// ---------------------------------------------------------------------------

describe('dependencyFactOf', () => {
  it('reads an MCP envelope by its error member, the summary by its two bits, and the rest as unsettled', () => {
    expect(dependencyFactOf(mcpRow())).toBe('succeeded')
    expect(
      dependencyFactOf(
        mcpRow({ upstream_response: { jsonrpc: '2.0', id: 1, error: { code: -1, message: 'x' } } }),
      ),
    ).toBe('failed')
    expect(
      dependencyFactOf(
        mcpRow({ upstream_response: { jsonrpc: '2.0', id: 1, result: { isError: true } } }),
      ),
    ).toBe('succeeded')
    const summary = (success: boolean, hasError: boolean) => ({
      success,
      has_error: hasError,
      error_code: null,
      content_types: [],
      content_count: 0,
    })
    expect(dependencyFactOf(mcpRow({ upstream_response: summary(true, false) }))).toBe('succeeded')
    expect(dependencyFactOf(mcpRow({ upstream_response: summary(false, true) }))).toBe('failed')
    expect(dependencyFactOf(mcpRow({ upstream_response: summary(false, false) }))).toBe('unsettled')
    expect(dependencyFactOf(mcpRow({ upstream_response: { content: [] } }))).toBe('unsettled')
    expect(
      dependencyFactOf(mcpRow({ upstream_response: null, upstream_error: 'connect ECONNREFUSED' })),
    ).toBe('failed')
  })

  it('names nothing for an MCP row that was not forwarded or had no session', () => {
    expect(dependencyFactOf(mcpRow({ dry_run: true }))).toBe('none')
    expect(
      dependencyFactOf(
        mcpRow({ policy_decision: 'deny', block_reason: 'policy_denied', upstream_response: null }),
      ),
    ).toBe('none')
    expect(dependencyFactOf(mcpRow({ session_id: null }))).toBe('none')
    expect(dependencyFactOf(mcpRow({ session_id: '   ' }))).toBe('none')
  })

  it('settles a sideband row only through upstream_error', () => {
    expect(dependencyFactOf(sidebandRow({ upstream_error: 'tool call failed' }))).toBe('failed')
    expect(dependencyFactOf(sidebandRow({ upstream_response: null }))).toBe('unsettled')
    expect(dependencyFactOf(sidebandRow())).toBe('unsettled')
    const summary = {
      success: true,
      has_error: false,
      error_code: null,
      content_types: [],
      content_count: 0,
    }
    expect(dependencyFactOf(sidebandRow({ upstream_response: summary }))).toBe('unsettled')
    expect(
      dependencyFactOf(
        sidebandRow({
          policy_decision: 'deny',
          block_reason: 'policy_denied',
          upstream_response: null,
        }),
      ),
    ).toBe('none')
    expect(dependencyFactOf(expiredRow(true))).toBe('unsettled')
  })
})

describe('executionStateOf', () => {
  it('reads an MCP row from dry_run and block_reason', () => {
    expect(executionStateOf(mcpRow())).toBe('executed')
    expect(
      executionStateOf(
        mcpRow({ policy_decision: 'require_approval', approval_status: 'approved' }),
      ),
    ).toBe('executed')
    expect(executionStateOf(mcpRow({ dry_run: true }))).toBe('not_executed')
    expect(
      executionStateOf(mcpRow({ block_reason: 'rate_limited', policy_decision: 'rate_limit' })),
    ).toBe('not_executed')
  })

  it('reads a sideband limit row from its commit block and the rest from the outcome columns', () => {
    const commit = {
      rate_limit: { allowed: true, current: 1, limit: 5, window_ms: 3_600_000, reset_at_ms: 0 },
    }
    expect(
      executionStateOf(sidebandRow({ policy_decision: 'rate_limit', evidence_chain: commit })),
    ).toBe('executed')
    expect(
      executionStateOf(
        sidebandRow({ policy_decision: 'rate_limit', evidence_chain: { rate: { current: 1 } } }),
      ),
    ).toBe('unsettled')
    expect(
      executionStateOf(
        sidebandRow({
          policy_decision: 'spend_limit',
          evidence_chain: { spend_limit: { current_spend: 1 } },
        }),
      ),
    ).toBe('executed')
    expect(executionStateOf(sidebandRow({ upstream_error: 'boom' }))).toBe('executed')
    expect(
      executionStateOf(
        sidebandRow({ evidence_chain: { budgets: [{ name: 'p', kind: 'spend', allowed: true }] } }),
      ),
    ).toBe('executed')
    expect(
      executionStateOf(
        sidebandRow({ evidence_chain: { budgets: [{ name: 'p', allowed: false }] } }),
      ),
    ).toBe('unsettled')
    expect(executionStateOf(sidebandRow())).toBe('unsettled')
    expect(executionStateOf(sidebandRow({ dry_run: true }))).toBe('not_executed')
    expect(
      executionStateOf(sidebandRow({ policy_decision: 'deny', block_reason: 'policy_denied' })),
    ).toBe('not_executed')
    expect(executionStateOf(expiredRow(true))).toBe('executed')
    expect(executionStateOf(expiredRow(false))).toBe('unsettled')
  })
})

// ---------------------------------------------------------------------------
// The skip predicate
// ---------------------------------------------------------------------------

describe('skipReasonOf', () => {
  it("skips the four writers' rows and neither neighbor", () => {
    const nameless = mcpRow({
      tool_name: '<nameless>',
      policy_decision: 'rejected',
      block_reason: 'missing_tool_name',
      tool_input: { raw_params: null },
    })
    const mismatch = {
      ...mcpRow(),
      ...buildHeaderMismatchAuditRecord({
        reason: 'name differs',
        method: 'tools/list',
        headers: {},
        durationMs: 1,
      }),
    }
    const killedMcp = mcpRow({ policy_decision: 'deny', block_reason: 'kill_switch' })
    const killedSideband = sidebandRow({ policy_decision: 'deny', block_reason: 'kill_switch' })
    expect(skipReasonOf(nameless)).toBe('rejected')
    expect(skipReasonOf(mismatch)).toBe('rejected')
    expect(skipReasonOf(killedMcp)).toBe('kill_switch')
    expect(skipReasonOf(killedSideband)).toBe('kill_switch')
    expect(skipReasonOf(expiredRow(false))).toBeNull()
    expect(
      skipReasonOf(
        mcpRow({
          policy_decision: 'require_approval',
          approval_status: 'client_disconnected',
          block_reason: 'client_disconnected',
        }),
      ),
    ).toBeNull()
    expect(skipReasonOf(mcpRow({ dry_run: true }))).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The stored ticket kind, the two recorded answers and the stored quadruple
// ---------------------------------------------------------------------------

describe('storedTicketKind and recordedAnswers', () => {
  it('derives the MCP kinds from policy_decision and budget_approval, never from the approval block', () => {
    const clean = mcpRow({
      policy_decision: 'require_approval',
      approval_status: 'approved',
      approved_by: 'ops',
    })
    expect(storedTicketKind(clean)).toBe('rule')
    expect(recordedAnswers(clean)).toEqual({ rule: 'approved', money: null })
    const denied = mcpRow({
      policy_decision: 'require_approval',
      approval_status: 'denied',
      block_reason: 'approval_denied',
      evidence_chain: { approval: { ticket_id: 't', denial_reason: 'no' } },
    })
    expect(storedTicketKind(denied)).toBe('rule')
    expect(recordedAnswers(denied)).toEqual({ rule: 'denied', money: null })
    const budgetOnly = mcpRow({
      policy_decision: 'allow',
      approval_status: 'approved',
      evidence_chain: {
        budget_approval: { ticket_id: 't', status: 'approved' },
        budgets: [{ name: 'p', kind: 'approved_overage' }],
      },
    })
    expect(storedTicketKind(budgetOnly)).toBe('budget')
    expect(recordedAnswers(budgetOnly)).toEqual({ rule: null, money: 'approved' })
    const merged = mcpRow({
      policy_decision: 'require_approval',
      approval_status: 'approved',
      block_reason: 'budget_exceeded',
      evidence_chain: { budget_approval: { ticket_id: 't', status: 'denied' } },
    })
    expect(storedTicketKind(merged)).toBe('both')
    expect(recordedAnswers(merged)).toEqual({ rule: 'approved', money: 'denied' })
    expect(storedTicketKind(mcpRow())).toBe('none')
    expect(recordedAnswers(mcpRow())).toEqual({ rule: null, money: null })
  })

  it('derives the sideband kinds from policy_decision and approval_status, never both', () => {
    const rule = sidebandRow({
      policy_decision: 'require_approval',
      approval_status: 'denied',
      block_reason: 'approval_denied',
    })
    expect(storedTicketKind(rule)).toBe('rule')
    expect(recordedAnswers(rule)).toEqual({ rule: 'denied', money: null })
    const budgetOnly = sidebandRow({
      policy_decision: 'allow',
      approval_status: 'denied',
      block_reason: 'budget_exceeded',
    })
    expect(storedTicketKind(budgetOnly)).toBe('budget')
    expect(recordedAnswers(budgetOnly)).toEqual({ rule: null, money: 'denied' })
    const mergedApproved = sidebandRow({
      policy_decision: 'require_approval',
      approval_status: 'approved',
      evidence_chain: { budgets: [{ name: 'p', kind: 'approved_overage', allowed: false }] },
    })
    expect(storedTicketKind(mergedApproved)).toBe('rule')
    expect(recordedAnswers(mergedApproved)).toEqual({ rule: 'approved', money: 'approved' })
    const mergedBreakGlass = sidebandRow({
      policy_decision: 'require_approval',
      approval_status: 'break_glass',
      evidence_chain: { budgets: [{ name: 'p', kind: 'spend', allowed: false }] },
    })
    expect(recordedAnswers(mergedBreakGlass)).toEqual({ rule: 'break_glass', money: 'break_glass' })
    const mergedDeniedNotExecuted = sidebandRow({
      policy_decision: 'require_approval',
      approval_status: 'denied',
      block_reason: 'approval_denied',
      evidence_chain: { budgets: [{ name: 'p', allowed: false }] },
    })
    expect(recordedAnswers(mergedDeniedNotExecuted)).toEqual({ rule: 'denied', money: null })
    const cancelled = sidebandRow({
      policy_decision: 'require_approval',
      approval_status: 'cancelled',
      block_reason: 'cancelled',
    })
    expect(recordedAnswers(cancelled)).toEqual({ rule: 'cancelled', money: null })
  })

  it('reads the stored quadruple from the row', () => {
    expect(
      storedOutcome(mcpRow({ policy_decision: 'deny', block_reason: 'policy_denied' })),
    ).toEqual({
      policy_decision: 'deny',
      block_reason: 'policy_denied',
      dry_run: false,
      ticket: 'none',
    })
    expect(
      storedOutcome(
        sidebandRow({ policy_decision: 'allow', approval_status: 'approved', dry_run: false }),
      ),
    ).toEqual({ policy_decision: 'allow', block_reason: null, dry_run: false, ticket: 'budget' })
  })
})
