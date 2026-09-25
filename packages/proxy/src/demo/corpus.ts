// ---------------------------------------------------------------------------
// The sample corpus `helio init --demo` writes (issue #397): ten tools on two
// doors, six sessions plus one sideband channel, 45 days of governed calls
// in three config epochs, and the budget ledger of one pot past its limit.
// Everything derives from one base instant and one seeded generator, so two
// builds from one base are deep-equal; every audit id is a hash. The rows
// are typed against the store's own input shape and the ledger's row shape,
// so a column added as required later fails to typecheck here instead of
// silently writing a stale corpus. Nothing here touches a file or a socket:
// `seed.ts` writes what this module builds.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto'
import type { AuditRecordInput } from '../audit/types.js'
import type { BudgetLedgerRow, BudgetMetaRow } from '../budget/engine.js'
import { budgetBucketKey } from '../budget/engine.js'
import {
  HELIO_MCP_LEGACY_PROTOCOL_VERSION,
  HELIO_MCP_MODERN_PROTOCOL_VERSION,
} from '../mcp/protocol-version.js'

// ---------------------------------------------------------------------------
// Names: the directory, the four files, the marks every consumer prints
// ---------------------------------------------------------------------------

/** The directory `helio init --demo` writes when none is given. */
export const DEMO_DEFAULT_DIR = 'helio-demo'
/** The config file; the reload records are titled by this basename, so it is not `helio.yaml`. */
export const DEMO_CONFIG_FILE = 'helio-demo.yaml'
/** The audit database the corpus is written into. */
export const DEMO_AUDIT_FILE = 'helio-demo-audit.db'
/** The dependency-free sample upstream serving the ten tools. */
export const DEMO_UPSTREAM_FILE = 'mcp-demo-server.mjs'
/** What is sample, what to run, what each surface shows. */
export const DEMO_README_FILE = 'README.md'
/** The four files, in the order they are written and printed. */
export const DEMO_FILES = [
  DEMO_CONFIG_FILE,
  DEMO_AUDIT_FILE,
  DEMO_UPSTREAM_FILE,
  DEMO_README_FILE,
] as const

/** The environment label on every row. */
export const DEMO_ENVIRONMENT = 'demo'
/** The two named doors. */
export const DEMO_UPSTREAMS = { crm: 'demo-crm', billing: 'demo-billing' } as const
/** The one pot, and the limit the rendered config gives it. */
export const DEMO_BUDGET_NAME = 'demo-payments'
export const DEMO_BUDGET_LIMIT = 500
/** The header-resolved sessions; eight characters or fewer so the dashboard shows them whole. */
export const DEMO_SESSIONS = [
  'demo-s01',
  'demo-s02',
  'demo-s03',
  'demo-s04',
  'demo-s05',
  'demo-s06',
] as const
/** The sideband row's session, resolved by an adapter rather than a header. */
export const DEMO_CHANNEL_SESSION = 'demo-ch'
/** The origin string of the one sideband row. */
export const DEMO_AGENT_ORIGIN = 'demo-agent'

type DemoUpstream = (typeof DEMO_UPSTREAMS)[keyof typeof DEMO_UPSTREAMS]

// ---------------------------------------------------------------------------
// The tool table: what the sample upstream lists, with its annotations
// ---------------------------------------------------------------------------

/** One tool as the sample upstream lists it. `annotations` absent means MCP's defaults apply (destructive). */
export interface DemoTool {
  readonly name: string
  readonly upstream: DemoUpstream
  readonly description: string
  readonly inputSchema: {
    readonly type: 'object'
    readonly properties: Readonly<Record<string, { readonly type: string }>>
  }
  readonly annotations?: Readonly<Record<string, boolean>>
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false } as const
const MUTATION = { readOnlyHint: false, destructiveHint: false } as const
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true } as const

/**
 * Ten tools, five per door. `export_customers` carries no annotations, so
 * the proxy flags it destructive by MCP's default; `merge_customers` and
 * `list_invoices` are listed by the upstream and never called, so the
 * status command's "reachable, never called" and unobserved-pair faces are
 * both nonzero.
 */
export const DEMO_TOOLS: readonly DemoTool[] = [
  {
    name: 'get_customer',
    upstream: DEMO_UPSTREAMS.crm,
    description: 'Fetch a customer by id',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
    annotations: READ_ONLY,
  },
  {
    name: 'update_customer',
    upstream: DEMO_UPSTREAMS.crm,
    description: 'Update customer fields',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, email: { type: 'string' } },
    },
    annotations: MUTATION,
  },
  {
    name: 'delete_customer',
    upstream: DEMO_UPSTREAMS.crm,
    description: 'Delete a customer',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
    annotations: DESTRUCTIVE,
  },
  {
    name: 'export_customers',
    upstream: DEMO_UPSTREAMS.crm,
    description: 'Export every customer record',
    inputSchema: { type: 'object', properties: { format: { type: 'string' } } },
  },
  {
    name: 'merge_customers',
    upstream: DEMO_UPSTREAMS.crm,
    description: 'Merge two customer records',
    inputSchema: {
      type: 'object',
      properties: { into: { type: 'string' }, from: { type: 'string' } },
    },
    annotations: DESTRUCTIVE,
  },
  {
    name: 'get_invoice',
    upstream: DEMO_UPSTREAMS.billing,
    description: 'Fetch an invoice',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
    annotations: READ_ONLY,
  },
  {
    name: 'list_invoices',
    upstream: DEMO_UPSTREAMS.billing,
    description: 'List invoices for a customer',
    inputSchema: { type: 'object', properties: { customer: { type: 'string' } } },
    annotations: READ_ONLY,
  },
  {
    name: 'send_invoice',
    upstream: DEMO_UPSTREAMS.billing,
    description: 'Email an invoice',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, to: { type: 'string' } } },
    annotations: MUTATION,
  },
  {
    name: 'create_charge',
    upstream: DEMO_UPSTREAMS.billing,
    description: 'Charge a customer',
    inputSchema: {
      type: 'object',
      properties: {
        amount: { type: 'number' },
        currency: { type: 'string' },
        customer: { type: 'string' },
      },
    },
    annotations: MUTATION,
  },
  {
    name: 'refund_charge',
    upstream: DEMO_UPSTREAMS.billing,
    description: 'Refund a charge',
    inputSchema: {
      type: 'object',
      properties: { amount: { type: 'number' }, charge: { type: 'string' } },
    },
    annotations: MUTATION,
  },
]

// ---------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------

/** One audit row as the seed inserts it: the id and `created_at` the store is given, and the record. */
export interface DemoAuditRow {
  readonly id: string
  readonly created_at: string
  readonly record: AuditRecordInput
}

/** Everything the seed writes, built from one base instant. */
export interface DemoCorpus {
  readonly base: Date
  /** The hash of the current epoch: the sha256 of the written config's bytes. */
  readonly configSha256: string
  /** The three config epochs, oldest first; `c` is `configSha256`. */
  readonly epochHashes: { readonly a: string; readonly b: string; readonly c: string }
  /** The audit rows, oldest first. */
  readonly records: readonly DemoAuditRow[]
  readonly ledgerMeta: BudgetMetaRow
  /** The ledger rows: an epoch-1 history and the epoch-2 spend inside the last 24 hours. */
  readonly ledgerRows: readonly BudgetLedgerRow[]
}

export interface BuildDemoCorpusOptions {
  /** The instant the newest row sits just before; every offset counts back from it. */
  readonly base: Date
  /** The hash stamped on the current epoch's rows: the sha256 of the config file the caller writes. */
  readonly configSha256: string
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const CONFIG_EPOCH_A_HASH = sha256('helio-demo-config-epoch-a')
const CONFIG_EPOCH_B_HASH = sha256('helio-demo-config-epoch-b')
const REFUSED_EDIT_HASH = sha256('helio-demo-config-refused')

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** A hash shaped as a version-4 UUID, so the ids read like the store's own. */
function uuidFromHash(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** A small seeded generator (mulberry32): the same sequence on every build. */
function seededRandom(seed: number): () => number {
  let state = seed | 0
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type ToolInput = Record<string, unknown>

function toolByName(name: string): DemoTool {
  const tool = DEMO_TOOLS.find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`demo corpus names an unknown tool: ${name}`)
  return tool
}

/** MCP's default: a tool with no `destructiveHint: false` is destructive. */
function isDestructive(tool: DemoTool): boolean {
  return tool.annotations?.['destructiveHint'] !== false
}

function isReadOnly(tool: DemoTool): boolean {
  return tool.annotations?.['readOnlyHint'] === true
}

/**
 * Build the corpus. Pure: the same base and hash give the same rows, and
 * nothing is read from the clock, the environment or the disk.
 */
export function buildDemoCorpus(options: BuildDemoCorpusOptions): DemoCorpus {
  const { base, configSha256 } = options
  const rnd = seededRandom(0x9e3779b9)
  let idCounter = 0
  const nextId = (): string => uuidFromHash(sha256(`helio-demo:${String(idCounter++)}`))
  const at = (offsetMs: number): string => new Date(base.getTime() - offsetMs).toISOString()
  const pick = <T>(values: readonly T[]): T => values[Math.floor(rnd() * values.length)] as T
  const between = (low: number, span: number): number => low + Math.floor(rnd() * span)

  const customerId = (): string => `cus_${String(between(1000, 900))}`
  const invoiceId = (): string => `inv_${String(between(5000, 900))}`
  const inputFor: Readonly<Record<string, () => ToolInput>> = {
    get_customer: () => ({ id: customerId() }),
    update_customer: () => ({
      id: customerId(),
      email: `person${String(between(0, 90))}@example.com`,
    }),
    delete_customer: () => ({ id: customerId() }),
    export_customers: () => ({ format: 'csv' }),
    get_invoice: () => ({ id: invoiceId() }),
    send_invoice: () => ({ id: invoiceId(), to: `ap${String(between(0, 20))}@example.com` }),
    create_charge: () => ({ amount: between(20, 80), currency: 'USD', customer: customerId() }),
    refund_charge: () => ({ amount: between(10, 40), charge: `ch_${String(between(7000, 900))}` }),
  }

  /** A tool call as the proxy persists an allowed one, before the overrides of a face. */
  function call(
    tool: DemoTool,
    hash: string,
    overrides: Partial<AuditRecordInput> = {},
  ): AuditRecordInput {
    const latency = between(2, 40)
    const input = inputFor[tool.name]
    return {
      timestamp: '',
      session_id: pick(DEMO_SESSIONS),
      session_source: 'header',
      protocol_version:
        rnd() < 0.8 ? HELIO_MCP_LEGACY_PROTOCOL_VERSION : HELIO_MCP_MODERN_PROTOCOL_VERSION,
      upstream: tool.upstream,
      agent_id: null,
      environment: DEMO_ENVIRONMENT,
      tool_name: tool.name,
      tool_input: input ? input() : {},
      policy_decision: 'allow',
      block_reason: null,
      matched_rule: null,
      matched_rule_index: null,
      evidence_chain: null,
      approval_status: null,
      approved_by: null,
      upstream_response: { content: [{ type: 'text', text: `${tool.name}: ok (sample)` }] },
      upstream_error: null,
      upstream_http_status: 200,
      upstream_latency_ms: latency,
      total_duration_ms: latency + 1,
      approval_wait_ms: 0,
      proxy_compute_ms: 1,
      flagged_destructive: isDestructive(tool),
      dry_run: false,
      record_kind: 'tool_call',
      origin: 'mcp',
      metadata: null,
      config_sha256: hash,
      ...overrides,
    }
  }

  /** The columns a blocked call never fills: nothing went upstream. */
  const blocked = (overrides: Partial<AuditRecordInput>): Partial<AuditRecordInput> => ({
    upstream_response: null,
    upstream_http_status: null,
    upstream_latency_ms: null,
    ...overrides,
  })

  function reload(
    before: string,
    after: string,
    outcome: 'applied' | 'rejected_invalid',
    rulesAdded: readonly string[],
    rulesRemoved: readonly string[],
    error?: string,
  ): AuditRecordInput {
    return {
      timestamp: '',
      session_id: null,
      session_source: null,
      protocol_version: null,
      upstream: null,
      agent_id: null,
      environment: DEMO_ENVIRONMENT,
      tool_name: DEMO_CONFIG_FILE,
      tool_input: {},
      policy_decision: 'policy_reload',
      block_reason: outcome === 'applied' ? null : outcome,
      matched_rule: null,
      matched_rule_index: null,
      evidence_chain: {
        policy_reload: {
          outcome,
          config_path: `/home/demo/${DEMO_DEFAULT_DIR}/${DEMO_CONFIG_FILE}`,
          sha256_before: before,
          sha256_after: after,
          rules_added: [...rulesAdded],
          rules_removed: [...rulesRemoved],
          ...(error === undefined ? {} : { error, restart_required_paths: [] }),
        },
      },
      approval_status: null,
      approved_by: null,
      upstream_response: null,
      upstream_error: null,
      upstream_http_status: null,
      upstream_latency_ms: null,
      total_duration_ms: 0,
      approval_wait_ms: 0,
      proxy_compute_ms: 0,
      flagged_destructive: false,
      dry_run: false,
      record_kind: 'policy_reload',
      origin: 'config',
      metadata: null,
      config_sha256: outcome === 'applied' ? after : before,
    }
  }

  const rows: Array<{ created_at: string; record: AuditRecordInput }> = []
  const push = (createdAt: string, record: AuditRecordInput): void => {
    rows.push({ created_at: createdAt, record: { ...record, timestamp: createdAt } })
  }

  // Epoch A, 45 to 40 days back: no rule, so the destructive tools run
  // unopposed. Every ninth call carries no session id.
  const earlyTools = [
    'get_customer',
    'update_customer',
    'delete_customer',
    'export_customers',
    'get_invoice',
    'send_invoice',
    'create_charge',
  ].map(toolByName)
  for (let i = 0; i < 40; i++) {
    const tool = earlyTools[i % earlyTools.length] as DemoTool
    push(
      at(45 * DAY - i * 3 * HOUR),
      call(
        tool,
        CONFIG_EPOCH_A_HASH,
        i % 9 === 8 ? { session_id: null, session_source: null } : {},
      ),
    )
  }

  // The first reload, 20 days back: the approval rule arrives.
  push(
    at(20 * DAY),
    reload(CONFIG_EPOCH_A_HASH, CONFIG_EPOCH_B_HASH, 'applied', ['big-charge-approval'], []),
  )

  // Epoch B, 20 to 8 days back: four big charges held for approval and
  // approved; everything else still allowed by the default.
  for (let i = 0; i < 60; i++) {
    const tool = earlyTools[i % earlyTools.length] as DemoTool
    const when = at(20 * DAY - 2 * HOUR - i * 4 * HOUR)
    if (tool.name === 'create_charge' && i % 14 === 6) {
      push(
        when,
        call(tool, CONFIG_EPOCH_B_HASH, {
          tool_input: { amount: 750, currency: 'USD', customer: 'cus_1042' },
          policy_decision: 'require_approval',
          matched_rule: 'big-charge-approval',
          matched_rule_index: 0,
          approval_status: 'approved',
          approved_by: 'demo-approver',
          approval_wait_ms: 42_000,
          total_duration_ms: 42_031,
        }),
      )
    } else {
      push(when, call(tool, CONFIG_EPOCH_B_HASH))
    }
  }

  // The second reload, 6 days back: the written file's two rules replace the
  // approval rule. A refused edit follows a day later.
  push(
    at(6 * DAY),
    reload(
      CONFIG_EPOCH_B_HASH,
      configSha256,
      'applied',
      ['allow-reads', 'block-destructive'],
      ['big-charge-approval'],
    ),
  )
  push(
    at(5 * DAY),
    reload(
      configSha256,
      REFUSED_EDIT_HASH,
      'rejected_invalid',
      [],
      [],
      'policies.rules[1].match.tool: glob must not be empty',
    ),
  )

  // Epoch C, 6 days back to 5 minutes back: the written rules decide.
  const currentTools = [
    'get_customer',
    'get_invoice',
    'update_customer',
    'send_invoice',
    'create_charge',
    'delete_customer',
    'refund_charge',
    'export_customers',
    'get_customer',
    'get_invoice',
  ].map(toolByName)
  function currentCall(tool: DemoTool, when: string, i: number): void {
    if (isDestructive(tool)) {
      push(
        when,
        call(
          tool,
          configSha256,
          blocked({
            policy_decision: 'deny',
            block_reason: 'policy_denied',
            matched_rule: 'block-destructive',
            matched_rule_index: 1,
          }),
        ),
      )
      return
    }
    if (isReadOnly(tool)) {
      push(when, call(tool, configSha256, { matched_rule: 'allow-reads', matched_rule_index: 0 }))
      return
    }
    if (i % 23 === 11) {
      push(
        when,
        call(
          tool,
          configSha256,
          blocked({
            dry_run: true,
            policy_decision: 'deny',
            block_reason: 'policy_denied',
            matched_rule: 'block-destructive',
            matched_rule_index: 1,
          }),
        ),
      )
      return
    }
    if (i % 31 === 17) {
      push(
        when,
        call(tool, configSha256, {
          upstream_error: 'upstream returned 503',
          upstream_response: null,
          upstream_http_status: 503,
        }),
      )
      return
    }
    push(when, call(tool, configSha256))
  }
  for (let i = 0; i < 120; i++) {
    currentCall(
      currentTools[i % currentTools.length] as DemoTool,
      at(6 * DAY - HOUR - i * 70 * MINUTE),
      i,
    )
  }
  // The last four hours, dense: 130 calls across both doors.
  for (let i = 0; i < 130; i++) {
    currentCall(
      currentTools[i % currentTools.length] as DemoTool,
      at(4 * HOUR - 5 * MINUTE - i * 105_000),
      i + 200,
    )
  }

  // One sideband row: an adapter-governed message with no MCP door.
  push(
    at(3 * HOUR),
    call(toolByName('send_invoice'), configSha256, {
      tool_name: 'send_message',
      tool_input: { channel: 'C-demo', text: 'invoice inv_5031 sent' },
      upstream: null,
      origin: DEMO_AGENT_ORIGIN,
      session_id: DEMO_CHANNEL_SESSION,
      session_source: 'sideband',
      protocol_version: null,
      flagged_destructive: false,
      metadata: { channel_id: 'C-demo', sender_id: 'U-demo' },
    }),
  )
  // One drift event: update_customer's annotations changed under the proxy.
  push(
    at(2 * HOUR),
    call(toolByName('update_customer'), configSha256, {
      record_kind: 'drift_event',
      policy_decision: 'tool_drift',
      session_id: null,
      session_source: null,
      protocol_version: null,
      tool_input: {},
      evidence_chain: {
        tool_drift: {
          changes: [{ aspect: 'annotations', baseline: MUTATION, current: DESTRUCTIVE }],
        },
      },
      upstream_response: null,
      upstream_http_status: null,
      upstream_latency_ms: null,
      total_duration_ms: 0,
      proxy_compute_ms: 0,
      flagged_destructive: false,
    }),
  )
  // One rejected row: a tools/call with no tool name.
  push(
    at(110 * MINUTE),
    call(toolByName('get_customer'), configSha256, {
      tool_name: '<nameless>',
      tool_input: { raw_params: { arguments: { id: 'cus_1042' } } },
      session_id: null,
      session_source: null,
      ...blocked({ policy_decision: 'rejected', block_reason: 'missing_tool_name' }),
      flagged_destructive: false,
    }),
  )
  // One anonymous dry-run allow.
  push(
    at(100 * MINUTE),
    call(toolByName('send_invoice'), configSha256, {
      dry_run: true,
      session_id: null,
      session_source: null,
    }),
  )
  // The budget refusal, 30 minutes back, as the store writes it: the policy
  // allowed the call and the pot refused it.
  push(
    at(30 * MINUTE),
    call(toolByName('create_charge'), configSha256, {
      tool_input: { amount: 60, currency: 'USD', customer: 'cus_1077' },
      ...blocked({ block_reason: 'budget_exceeded' }),
    }),
  )

  // Oldest first; insertion order breaks a tie so the sort is total.
  const ordered = rows
    .map((row, index) => ({ ...row, index }))
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.index - b.index)
  const records: DemoAuditRow[] = ordered.map((row) => ({
    id: nextId(),
    created_at: row.created_at,
    record: row.record,
  }))

  // The ledger: epoch 1 under config B (eight spends and the one approved
  // overage), epoch 2 under the written file (ten spends inside 24 hours,
  // 540 against a limit of 500), keyed the way the engine charges.
  const bucketKey = budgetBucketKey(DEMO_BUDGET_NAME, 'global', { sessionId: null, senderId: null })
  const ledgerRow = (
    generation: number,
    kind: BudgetLedgerRow['kind'],
    amount: number,
    toolName: string,
    offsetMs: number,
  ): BudgetLedgerRow => {
    const timestamp = at(offsetMs)
    return {
      budget_name: DEMO_BUDGET_NAME,
      bucket_key: bucketKey,
      kind,
      amount,
      currency: 'USD',
      tool_name: toolName,
      origin: 'mcp',
      audit_record_id: nextId(),
      timestamp,
      timestamp_ms: new Date(timestamp).getTime(),
      generation,
    }
  }
  const ledgerRows: BudgetLedgerRow[] = []
  for (let i = 0; i < 8; i++) {
    ledgerRows.push(ledgerRow(1, 'spend', 40 + i * 5, 'create_charge', 19 * DAY - i * DAY))
  }
  ledgerRows.push(ledgerRow(1, 'approved_overage', 750, 'create_charge', 12 * DAY - 2 * HOUR))
  for (let i = 0; i < 10; i++) {
    const refund = i % 3 === 2
    ledgerRows.push(
      ledgerRow(
        2,
        'spend',
        refund ? 40 : 60,
        refund ? 'refund_charge' : 'create_charge',
        20 * HOUR - i * 2 * HOUR,
      ),
    )
  }
  const ledgerMeta: BudgetMetaRow = {
    budget_name: DEMO_BUDGET_NAME,
    limit_amount: DEMO_BUDGET_LIMIT,
    currency: 'USD',
    window: '24h',
    key: 'global',
    epoch: 2,
  }

  return {
    base,
    configSha256,
    epochHashes: { a: CONFIG_EPOCH_A_HASH, b: CONFIG_EPOCH_B_HASH, c: configSha256 },
    records,
    ledgerMeta,
    ledgerRows,
  }
}
