import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ACTIVATION_REPORT_SCHEMA_VERSION,
  buildActivationReport,
  renderActivationText,
  windowSince,
} from './activation.js'
import type {
  ActivationReport,
  ActivationReportInput,
  ConfigFileVsLastPolicyWrite,
  SnapshotAbsentReason,
} from './activation.js'
import type { PolicyStatusReport } from '../policy/status.js'
import type { ActivationTimeline, ActivationWindow, PersistedSummary } from '../audit/types.js'

// ---------------------------------------------------------------------------
// Fixture: the shape of a real GET /api/policy/status over a seeded store,
// with every kind of string the default projection exists to stop PLANTED.
// ---------------------------------------------------------------------------

const NOW = new Date('2026-09-23T12:27:38.535Z')
const WINDOW = '7d'
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000

const PLANTED = {
  upstreamUrl: 'http://127.0.0.1:47001/mcp',
  primeFailure: 'upstream returned HTTP 500 to tools/list (session/initialize may be required)',
  conditionalRule: 'big-transfer',
  decidingRule: 'block-email',
  destructiveRule: 'block-destructive',
  toolName: 'send_email',
  otherTool: 'get_weather',
  adapterOrigin: 'openclaw',
  adapterTool: 'send_message',
  namedDoor: 'crm-door',
  blockedTool: 'delete_record',
  probeReason: 'x-probe-reason',
  firstRule: 'allow-reads',
} as const

function statusFixture(): PolicyStatusReport {
  const singular = { kind: 'upstream', name: null } as const
  const named = { kind: 'upstream', name: PLANTED.namedDoor } as const
  const adapter = { kind: 'adapter', origin: PLANTED.adapterOrigin } as const
  return {
    schema_version: 1,
    generated_at: '2026-09-23T12:27:38.535Z',
    window: WINDOW,
    policy: {
      rule_count: 4,
      default_action: 'allow',
      dry_run: false,
      flag_destructive: null,
      on_tool_drift: 'block',
      enforces_nothing: false,
    },
    surface: {
      pairs: 5,
      upstream_count: 2,
      adapter_origin_count: 1,
      annotated_destructive: 1,
      default_destructive: 1,
      annotation_free_doors: [PLANTED.upstreamUrl],
      doors: [
        {
          kind: 'upstream',
          name: null,
          available: true,
          unavailable_reason: null,
          tool_count: 3,
          annotated_count: 0,
          annotated_destructive: 0,
        },
        {
          kind: 'upstream',
          name: PLANTED.namedDoor,
          available: false,
          unavailable_reason: PLANTED.primeFailure,
          tool_count: 0,
          annotated_count: 0,
          annotated_destructive: 0,
        },
        {
          kind: 'adapter',
          origin: PLANTED.adapterOrigin,
          available: true,
          unavailable_reason: null,
          tool_count: 2,
          annotated_count: 2,
          annotated_destructive: 1,
        },
      ],
      unavailable: [{ name: PLANTED.namedDoor, reason: PLANTED.primeFailure }],
    },
    coverage: {
      matched: 3,
      conditional: 1,
      uncovered: 1,
      default_action: 'allow',
      by_effective_action: {
        allow: 2,
        deny: 2,
        require_approval: 1,
        rate_limit: 0,
        spend_limit: 0,
        dry_run: 0,
      },
      pairs: [
        {
          door: singular,
          tool: PLANTED.otherTool,
          destructive: 'no',
          drifted: false,
          flagged_destructive: false,
          status: 'matched',
          matched_rule: { name: PLANTED.firstRule, index: 0, action: 'allow' },
          conditional_rules: [],
          effective_action: 'allow',
          effective_source: 'rule',
        },
        {
          door: singular,
          tool: PLANTED.toolName,
          destructive: 'no',
          drifted: false,
          flagged_destructive: false,
          status: 'matched',
          matched_rule: { name: PLANTED.decidingRule, index: 1, action: 'deny' },
          conditional_rules: [],
          effective_action: 'deny',
          effective_source: 'rule',
        },
        {
          door: singular,
          tool: 'transfer_funds',
          destructive: 'default',
          drifted: false,
          flagged_destructive: false,
          status: 'conditional',
          matched_rule: null,
          conditional_rules: [
            {
              name: PLANTED.conditionalRule,
              index: 3,
              action: 'require_approval',
              on: 'arguments',
            },
          ],
          effective_action: 'allow',
          effective_source: 'default',
        },
        {
          door: adapter,
          tool: PLANTED.adapterTool,
          destructive: 'no',
          drifted: false,
          flagged_destructive: false,
          status: 'uncovered',
          matched_rule: null,
          conditional_rules: [],
          effective_action: 'require_approval',
          effective_source: 'flag_destructive',
        },
        {
          door: named,
          tool: PLANTED.blockedTool,
          destructive: 'annotated',
          drifted: false,
          flagged_destructive: false,
          status: 'matched',
          matched_rule: { name: PLANTED.destructiveRule, index: 2, action: 'deny' },
          conditional_rules: [],
          effective_action: 'deny',
          effective_source: 'rule',
        },
      ],
    },
    persisted: {
      window: WINDOW,
      since: '2026-09-16T12:27:38.534Z',
      calls_in_window: 123,
      sessions_in_window: 7,
      tool_doors_called_in_window: 5,
      pairs_called_in_window: [
        { door: singular, tool: PLANTED.blockedTool, calls: 20 },
        { door: singular, tool: PLANTED.otherTool, calls: 35 },
        { door: adapter, tool: PLANTED.adapterTool, calls: 1 },
      ],
      reachable_permitted_never_called_in_window: 0,
      called_not_reachable_in_window: 1,
      first_seen: '2026-09-23T09:27:35.880Z',
    },
    readiness: {
      ready: true,
      suppressed: true,
      calls_in_window: 123,
      tool_doors_called_in_window: 5,
      first_seen: '2026-09-23T09:27:35.880Z',
      thresholds: { min_calls: 100, min_tool_doors: 3 },
    },
  }
}

function persistedFixture(since: string): PersistedSummary {
  return {
    since,
    calls: 123,
    sessions: 7,
    first_seen_in_window: '2026-09-23T09:27:35.880Z',
    pairs: [
      { tool_name: PLANTED.otherTool, upstream: null, origin: 'mcp', calls: 35 },
      { tool_name: PLANTED.toolName, upstream: null, origin: 'mcp', calls: 34 },
      { tool_name: PLANTED.blockedTool, upstream: null, origin: 'mcp', calls: 20 },
      { tool_name: 'transfer_funds', upstream: null, origin: 'mcp', calls: 33 },
      { tool_name: PLANTED.adapterTool, upstream: null, origin: PLANTED.adapterOrigin, calls: 1 },
    ],
    first_seen: '2026-09-23T09:27:35.880Z',
  }
}

function windowFixture(since: string): ActivationWindow {
  return {
    since,
    permitted: 82,
    blocked: 41,
    dry_run: 0,
    approvals_requested: 0,
    anonymous_calls: 10,
    config_versions: 3,
    blocked_by_reason: [
      { reason: 'policy_denied', count: 40 },
      { reason: PLANTED.probeReason, count: 1 },
    ],
    reloads_recorded: 2,
    reloads_applied: 1,
  }
}

function timelineFixture(): ActivationTimeline {
  return {
    first_rule_decided_call: {
      created_at: '2026-09-23T10:27:35.880Z',
      matched_rule: PLANTED.decidingRule,
    },
    first_applied_reload: { created_at: '2026-09-23T11:00:00.000Z' },
    any_policy_block: true,
    first_blocked_call: {
      created_at: '2026-09-23T10:27:35.885Z',
      block_reason: PLANTED.probeReason,
      tool_name: PLANTED.toolName,
    },
    newest_record_hash: { hash: 'b'.repeat(64) },
  }
}

function input(overrides: Partial<ActivationReportInput> = {}): ActivationReportInput {
  const since = windowSince(NOW, WINDOW_MS)
  return {
    now: NOW,
    helioVersion: '0.15.0',
    window: WINDOW,
    windowMs: WINDOW_MS,
    retention: '90d',
    includeNames: false,
    configFileVsLastPolicyWrite: 'match',
    persisted: persistedFixture(since),
    activationWindow: windowFixture(since),
    timeline: timelineFixture(),
    snapshot: { ok: true, report: statusFixture() },
    ...overrides,
  }
}

/** Every key and every string value of a JSON value, depth first. */
function stringsOf(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const v of value) stringsOf(v, out)
  else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.push(k)
      stringsOf(v, out)
    }
  }
  return out
}

function json(report: ActivationReport): string {
  return JSON.stringify(report, null, 2)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildActivationReport', () => {
  it('builds the schema version 1 shape with the window beside every count', () => {
    const report = buildActivationReport(input())
    expect(report.schema_version).toBe(ACTIVATION_REPORT_SCHEMA_VERSION)
    expect(report.schema_version).toBe(1)
    expect(report.generated_at).toBe(NOW.toISOString())
    expect(report.helio_version).toBe('0.15.0')
    expect(report.names_included).toBe(false)
    expect(report.window).toBe('7d')
    expect(report.since).toBe('2026-09-16T12:27:38.535Z')
    expect(report.retention).toBe('90d')
    expect(report.sources).toEqual({
      audit_database: 'read',
      config_file_vs_last_policy_write: 'match',
      proxy_snapshot: 'present',
      proxy_snapshot_absent_reason: null,
      proxy_snapshot_verified: false,
    })
    expect(report.persisted.window).toBe('7d')
    expect(report.persisted.since).toBe(report.since)
    expect(report.persisted.calls_in_window).toBe(123)
    expect(report.persisted.sessions_in_window).toBe(7)
    expect(report.persisted.anonymous_calls_in_window).toBe(10)
    expect(report.persisted.tool_doors_called_in_window).toBe(5)
    expect(report.persisted.decisions).toEqual({
      permitted: 82,
      blocked: 41,
      dry_run: 0,
      approvals_requested: 0,
    })
    expect(report.persisted.blocked_by_reason).toEqual({ policy_denied: 40, other: 1 })
    expect(report.persisted.config_versions_in_window).toBe(3)
    expect(report.persisted.policy_reloads_in_window).toEqual({ recorded: 2, applied: 1 })
    expect(report.persisted.first_seen).toBe('2026-09-23T09:27:35.880Z')
    expect(report.persisted.pairs_called_in_window).toBeUndefined()
    expect(report.snapshot).not.toBeNull()
    expect(report.snapshot?.status_schema_version).toBe(1)
    expect(report.snapshot?.window).toBe('7d')
    expect(report.snapshot?.generated_at).toBe('2026-09-23T12:27:38.535Z')
    expect(report.snapshot?.since).toBe('2026-09-16T12:27:38.534Z')
    expect(report.snapshot?.policy).toEqual({
      rule_count: 4,
      default_action: 'allow',
      dry_run: false,
      flag_destructive: null,
      on_tool_drift: 'block',
      enforces_nothing: false,
    })
    expect(report.snapshot?.surface).toEqual({
      pairs: 5,
      upstream_count: 2,
      adapter_origin_count: 1,
      annotated_destructive: 1,
      default_destructive: 1,
      annotation_free_door_count: 1,
      unavailable_door_count: 1,
      doors: [
        {
          kind: 'upstream',
          available: true,
          tool_count: 3,
          annotated_count: 0,
          annotated_destructive: 0,
        },
        {
          kind: 'upstream',
          available: false,
          tool_count: 0,
          annotated_count: 0,
          annotated_destructive: 0,
        },
        {
          kind: 'adapter',
          available: true,
          tool_count: 2,
          annotated_count: 2,
          annotated_destructive: 1,
        },
      ],
    })
    expect(report.snapshot?.coverage).toEqual({
      matched: 3,
      conditional: 1,
      conditional_on: 'arguments',
      uncovered: 1,
      default_action: 'allow',
      by_effective_action: {
        allow: 2,
        deny: 2,
        require_approval: 1,
        rate_limit: 0,
        spend_limit: 0,
        dry_run: 0,
      },
    })
    expect(report.snapshot?.persisted_join).toEqual({
      reachable_permitted_never_called_in_window: 0,
      called_not_reachable_in_window: 1,
    })
    expect(report.snapshot?.readiness).toEqual({
      ready: true,
      suppressed: true,
      calls_in_window: 123,
      tool_doors_called_in_window: 5,
      thresholds: { min_calls: 100, min_tool_doors: 3 },
    })
  })

  it('states the six stages with their sources and maps an unknown block reason to other', () => {
    const { timeline } = buildActivationReport(input())
    expect(timeline.first_call_observed).toEqual({
      at: '2026-09-23T09:27:35.880Z',
      source: 'first_persisted_tool_call',
    })
    expect(timeline.first_rule).toEqual({
      at: '2026-09-23T10:27:35.880Z',
      source: 'first_rule_decided_call',
    })
    expect(timeline.first_generation).toEqual({ available: false, reason: 'not in this version' })
    expect(timeline.first_simulation).toEqual({ available: false, reason: 'not in this version' })
    expect(timeline.first_apply).toEqual({ available: false, reason: 'not in this version' })
    expect(timeline.first_enforcement_decision).toEqual({
      at: '2026-09-23T10:27:35.885Z',
      block_reason: 'other',
    })
  })

  it('takes the earlier of the rule-decided call and the applied reload as the first rule', () => {
    const reloadFirst = buildActivationReport(
      input({
        timeline: {
          ...timelineFixture(),
          first_applied_reload: { created_at: '2026-09-23T09:00:00.000Z' },
        },
      }),
    )
    expect(reloadFirst.timeline.first_rule).toEqual({
      at: '2026-09-23T09:00:00.000Z',
      source: 'first_applied_reload',
    })
    const reloadOnly = buildActivationReport(
      input({
        timeline: {
          ...timelineFixture(),
          first_rule_decided_call: null,
          first_applied_reload: { created_at: '2026-09-23T11:00:00.000Z' },
        },
      }),
    )
    expect(reloadOnly.timeline.first_rule.source).toBe('first_applied_reload')
    const neither = buildActivationReport(
      input({
        timeline: {
          ...timelineFixture(),
          first_rule_decided_call: null,
          first_applied_reload: null,
        },
      }),
    )
    expect(neither.timeline.first_rule).toEqual({ at: null, source: null })
  })

  it('carries every known block reason by name and folds the rest into other', () => {
    const report = buildActivationReport(
      input({
        activationWindow: {
          ...windowFixture(windowSince(NOW, WINDOW_MS)),
          blocked_by_reason: [
            { reason: 'approval_timeout', count: 2 },
            { reason: 'budget_exceeded', count: 1 },
            { reason: 'cancelled', count: 1 },
            { reason: 'evidence_missing', count: 3 },
            { reason: 'session_unresolved', count: 1 },
            { reason: 'shutdown_cancelled', count: 1 },
            { reason: 'x-one', count: 1 },
            { reason: 'x-two', count: 2 },
          ],
        },
      }),
    )
    expect(report.persisted.blocked_by_reason).toEqual({
      approval_timeout: 2,
      budget_exceeded: 1,
      cancelled: 1,
      evidence_missing: 3,
      session_unresolved: 1,
      shutdown_cancelled: 1,
      other: 3,
    })
  })

  it('carries the absent-snapshot code and null snapshot for every reason', () => {
    const codes: readonly SnapshotAbsentReason[] = [
      'dashboard_disabled',
      'secret_is_digest',
      'no_proxy_answered',
      'secret_refused',
      'status_unavailable',
      'api_error',
    ]
    for (const code of codes) {
      const report = buildActivationReport(input({ snapshot: { ok: false, code } }))
      expect(report.snapshot, code).toBeNull()
      expect(report.sources.proxy_snapshot, code).toBe('absent')
      expect(report.sources.proxy_snapshot_absent_reason, code).toBe(code)
      expect(report.sources.proxy_snapshot_verified, code).toBe(false)
      // The timeline and the persisted block print without a proxy.
      expect(report.timeline.first_call_observed.at, code).not.toBeNull()
      expect(report.persisted.calls_in_window, code).toBe(123)
    }
  })

  it('is byte-identical for the same inputs and moves only its own clock fields for a different now', () => {
    const a = json(buildActivationReport(input()))
    const b = json(buildActivationReport(input()))
    expect(a).toBe(b)
    const later = new Date(NOW.getTime() + 60_000)
    const c = buildActivationReport(input({ now: later }))
    const base = buildActivationReport(input())
    expect(c.generated_at).toBe(later.toISOString())
    expect(c.since).toBe(windowSince(later, WINDOW_MS))
    expect(c.persisted.since).toBe(c.since)
    const strip = (r: ActivationReport): string =>
      json({
        ...r,
        generated_at: '',
        since: '',
        persisted: { ...r.persisted, since: '' },
      })
    expect(strip(c)).toBe(strip(base))
  })
})

describe('the redaction whitelist', () => {
  const NEVER_IN_DEFAULT = [
    PLANTED.upstreamUrl,
    PLANTED.primeFailure,
    PLANTED.conditionalRule,
    PLANTED.decidingRule,
    PLANTED.destructiveRule,
    PLANTED.firstRule,
    PLANTED.toolName,
    PLANTED.otherTool,
    PLANTED.adapterOrigin,
    PLANTED.adapterTool,
    PLANTED.namedDoor,
    PLANTED.blockedTool,
    PLANTED.probeReason,
    'transfer_funds',
    'b'.repeat(64),
  ]

  it('copies no name, label, URL, failure text, hash or unknown reason by default (JSON keys and values, and text)', () => {
    const report = buildActivationReport(input())
    const strings = stringsOf(JSON.parse(json(report)))
    const text = renderActivationText(report)
    for (const planted of NEVER_IN_DEFAULT) {
      expect(strings, planted).not.toContain(planted)
      for (const s of strings) expect(s, `${planted} inside ${s}`).not.toContain(planted)
      expect(text, planted).not.toContain(planted)
    }
    expect(report.snapshot?.surface).not.toHaveProperty('annotation_free_doors')
    expect(report.snapshot?.surface).not.toHaveProperty('unavailable')
    expect(report.snapshot?.coverage).not.toHaveProperty('pairs')
    expect(report.timeline.first_rule).not.toHaveProperty('rule_name')
    expect(report.timeline.first_enforcement_decision).not.toHaveProperty('tool')
  })

  it('restores tool, door and rule names with --include-names, and says so on the face', () => {
    const report = buildActivationReport(input({ includeNames: true }))
    expect(report.names_included).toBe(true)
    const strings = stringsOf(JSON.parse(json(report)))
    const text = renderActivationText(report)
    const restored = [
      PLANTED.upstreamUrl,
      PLANTED.primeFailure,
      PLANTED.conditionalRule,
      PLANTED.decidingRule,
      PLANTED.destructiveRule,
      PLANTED.firstRule,
      PLANTED.toolName,
      PLANTED.otherTool,
      PLANTED.adapterOrigin,
      PLANTED.adapterTool,
      PLANTED.namedDoor,
      PLANTED.blockedTool,
      'transfer_funds',
    ]
    for (const planted of restored) {
      expect(
        strings.some((s) => s.includes(planted)),
        planted,
      ).toBe(true)
      expect(text, planted).toContain(planted)
    }
    expect(report.snapshot?.surface.annotation_free_doors).toEqual([PLANTED.upstreamUrl])
    expect(report.snapshot?.surface.unavailable).toEqual([
      { name: PLANTED.namedDoor, reason: PLANTED.primeFailure },
    ])
    expect(report.snapshot?.surface.doors[1]).toEqual({
      kind: 'upstream',
      available: false,
      tool_count: 0,
      annotated_count: 0,
      annotated_destructive: 0,
      name: PLANTED.namedDoor,
      unavailable_reason: PLANTED.primeFailure,
    })
    expect(report.snapshot?.surface.doors[2]).toMatchObject({ origin: PLANTED.adapterOrigin })
    expect(report.snapshot?.coverage.pairs).toHaveLength(5)
    expect(report.timeline.first_rule).toEqual({
      at: '2026-09-23T10:27:35.880Z',
      source: 'first_rule_decided_call',
      rule_name: PLANTED.decidingRule,
    })
    expect(report.timeline.first_enforcement_decision).toEqual({
      at: '2026-09-23T10:27:35.885Z',
      block_reason: 'other',
      tool: PLANTED.toolName,
    })
    expect(report.persisted.pairs_called_in_window).toEqual([
      { tool_name: PLANTED.otherTool, upstream: null, origin: 'mcp', calls: 35 },
      { tool_name: PLANTED.toolName, upstream: null, origin: 'mcp', calls: 34 },
      { tool_name: PLANTED.blockedTool, upstream: null, origin: 'mcp', calls: 20 },
      { tool_name: 'transfer_funds', upstream: null, origin: 'mcp', calls: 33 },
      { tool_name: PLANTED.adapterTool, upstream: null, origin: PLANTED.adapterOrigin, calls: 1 },
    ])
    // Never restored: the raw reason and the hash.
    expect(strings).not.toContain(PLANTED.probeReason)
    expect(strings).not.toContain('b'.repeat(64))
    expect(text).not.toContain(PLANTED.probeReason)
    expect(text).toContain('Names: INCLUDED (tool, door and rule names are in this file).')
  })
})

describe('renderActivationText', () => {
  const HEADER =
    'Helio activation report\n' +
    '  Written by Helio 0.15.0 on 2026-09-23 (UTC). Names: excluded (--include-names restores tool, door and rule names).\n' +
    '  Counts cover the last 7d; dates are within the audit retention of 90d.\n' +
    '  Sources: the audit database (read; this config file is the one that last wrote policy to it). The running proxy answered on the configured dashboard port (snapshot below); this command does not verify that it wrote this database.'
  const CAVEAT =
    '                                 Rules present at the first start, or edited between runs, leave no reload record; a rule is visible here only once it decides a call or arrives by a live reload.'

  it('prints every line of the fixture as the reader test words it', () => {
    const text = renderActivationText(buildActivationReport(input()))
    expect(text).toBe(
      `${HEADER}\n` +
        '\n' +
        'Timeline (dates within retention)\n' +
        '  First call observed            2026-09-23   earliest persisted tool call\n' +
        '  First rule                     2026-09-23   first call a rule decided\n' +
        `${CAVEAT}\n` +
        '  First generation               not available in this version\n' +
        '  First simulation               not available in this version\n' +
        '  First apply                    not available in this version\n' +
        '  First enforcement decision     2026-09-23   first blocked call (other)\n' +
        '\n' +
        'Persisted (last 7d)\n' +
        '  123 calls across 5 tool-door pairs, 7 sessions, 10 calls without a session id (denied and dry-run calls included)\n' +
        '  Decisions: 82 permitted, 41 blocked (policy_denied 40, other 1), 0 dry-run, 0 approvals requested\n' +
        '  Config versions seen: 3\n' +
        '  Config reloads: 2 (1 applied)\n' +
        '  audit rows since 2026-09-23\n' +
        '\n' +
        'Snapshot (running proxy, 2026-09-23 12:27 UTC, window 7d)\n' +
        '  Authority surface: 5 tool-door pairs across 2 upstreams and 1 adapter origin; 1 annotated destructive; 1 destructive by MCP default\n' +
        '  Policy: 4 rules, default allow, on_tool_drift block\n' +
        '  Policy coverage: 3 of 5 have a rule that can match them; 1 covered only when arguments match; 1 fall through to the default: allow\n' +
        '  Effective action: allow 2, deny 2, require_approval 1\n' +
        '  Reachable and permitted, never called in the last 7d: 0 (from the proxy)\n' +
        '  Called on no primed door in the last 7d: 1 (from the proxy)\n' +
        '  Readiness: suppressed, the policy enforces something (123 calls across 5 tool-door pairs in the last 7d)\n' +
        '  Doors: 1 upstream primed, 1 not primed, 1 without annotations, 1 adapter origin',
    )
  })

  it('prints the none faces, the caveat on every first-rule face, and the unreleased build line', () => {
    const text = renderActivationText(
      buildActivationReport(
        input({
          helioVersion: '0.0.0',
          snapshot: { ok: false, code: 'no_proxy_answered' },
          persisted: { ...persistedFixture(windowSince(NOW, WINDOW_MS)), first_seen: null },
          timeline: {
            first_rule_decided_call: null,
            first_applied_reload: null,
            any_policy_block: false,
            first_blocked_call: null,
            newest_record_hash: null,
          },
          configFileVsLastPolicyWrite: 'no_record',
        }),
      ),
    )
    expect(text).toContain('  Written by Helio 0.0.0 (unreleased build) on 2026-09-23 (UTC).')
    expect(text).toContain(
      '  Sources: the audit database (read; no record has been written yet). No proxy answered on the configured dashboard port, so the snapshot section is absent.',
    )
    expect(text).toContain(
      '  First call observed            none: no tool call persisted within retention\n',
    )
    expect(text).toContain(
      '  First rule                     none: no call decided by a rule and no applied reload within retention (a rule may be in the file and never have matched)\n' +
        `${CAVEAT}\n`,
    )
    expect(text).toContain(
      '  First enforcement decision     none: no call blocked within retention\n',
    )
    expect(text).toContain('  no tool calls persisted yet')
    expect(text).not.toContain('Snapshot (')
    expect(text).not.toContain('done')
    expect(text).not.toContain('skipped')
    expect(text).not.toContain('not yet done')
  })

  it('names the reload source on the dated line and keeps the caveat', () => {
    const text = renderActivationText(
      buildActivationReport(
        input({
          timeline: {
            ...timelineFixture(),
            first_rule_decided_call: null,
            first_applied_reload: { created_at: '2026-09-23T11:00:00.000Z' },
          },
        }),
      ),
    )
    expect(text).toContain(
      '  First rule                     2026-09-23   first applied config reload\n' + `${CAVEAT}\n`,
    )
  })

  it('renders one fixed sentence per absent-snapshot code, with no host, port or path', () => {
    const expected: Record<SnapshotAbsentReason, string> = {
      no_proxy_answered: 'No proxy answered on the configured dashboard port',
      dashboard_disabled: 'The dashboard is disabled in the config file',
      secret_is_digest: 'The dashboard secret found is a sha256: digest, not the secret',
      secret_refused: 'The proxy refused the dashboard secret',
      status_unavailable:
        'A process answered but serves no policy status (a library embedding, not helio start)',
      api_error: 'The proxy answered with an error',
    }
    for (const [code, sentence] of Object.entries(expected) as [SnapshotAbsentReason, string][]) {
      const text = renderActivationText(
        buildActivationReport(input({ snapshot: { ok: false, code } })),
      )
      expect(text, code).toContain(`${sentence}, so the snapshot section is absent.`)
      expect(text, code).not.toContain('127.0.0.1')
      expect(text, code).not.toContain('helio.yaml')
    }
  })

  it('renders the four same-file faces as their own sentences', () => {
    const expected: Record<ConfigFileVsLastPolicyWrite, string> = {
      match: 'this config file is the one that last wrote policy to it',
      mismatch: 'this config file is NOT the one that last wrote policy to it',
      no_hash: 'the newest record carries no config hash; the history predates v0.14',
      no_record: 'no record has been written yet',
    }
    for (const [value, sentence] of Object.entries(expected) as [
      ConfigFileVsLastPolicyWrite,
      string,
    ][]) {
      const report = buildActivationReport(input({ configFileVsLastPolicyWrite: value }))
      expect(report.sources.config_file_vs_last_policy_write).toBe(value)
      expect(renderActivationText(report), value).toContain(
        `  Sources: the audit database (read; ${sentence}).`,
      )
    }
  })

  it('prints no session ids recorded for a window with calls and zero sessions', () => {
    const since = windowSince(NOW, WINDOW_MS)
    const text = renderActivationText(
      buildActivationReport(
        input({
          persisted: { ...persistedFixture(since), sessions: 0 },
          activationWindow: { ...windowFixture(since), anonymous_calls: 123 },
        }),
      ),
    )
    expect(text).toContain(
      '  123 calls across 5 tool-door pairs, no session ids recorded (denied and dry-run calls included)',
    )
    expect(text).not.toContain('0 sessions')
  })

  it('prints the policy flags, the ready and not-yet readiness sentences, and the names-only lines', () => {
    const status = statusFixture()
    const flagged: PolicyStatusReport = {
      ...status,
      policy: { ...status.policy, dry_run: true, flag_destructive: 'require_approval' },
      readiness: { ...status.readiness, suppressed: false, ready: true },
    }
    const ready = renderActivationText(
      buildActivationReport(input({ includeNames: true, snapshot: { ok: true, report: flagged } })),
    )
    expect(ready).toContain(
      '  Policy: 4 rules, default allow, on_tool_drift block, flag_destructive require_approval, dry-run',
    )
    expect(ready).toContain(
      '  Readiness: ready (123 calls across 5 tool-door pairs in the last 7d; floor 100 across 3)',
    )
    expect(ready).toContain(
      '  First rule                     2026-09-23   first call a rule decided (rule "block-email")',
    )
    expect(ready).toContain(
      '  First enforcement decision     2026-09-23   first blocked call (other, tool send_email)',
    )
    expect(ready).toContain(`    not primed: ${PLANTED.namedDoor} (${PLANTED.primeFailure})`)
    expect(ready).toContain(`    no annotations: ${PLANTED.upstreamUrl}`)
    expect(ready).toContain('Tool-door pairs (calls in the last 7d, from the audit database)')
    expect(ready).toMatch(/send_email\s+upstream\s+deny\s+rule "block-email"\s+34/)
    expect(ready).toMatch(
      /transfer_funds\s+upstream\s+allow\s+no rule, default allow; "big-transfer" only when arguments match\s+33/,
    )
    expect(ready).toMatch(
      /send_message\s+openclaw\s+require_approval\s+no rule, flag_destructive\s+1/,
    )
    expect(ready).toMatch(/delete_record\s+crm-door\s+deny\s+rule "block-destructive"\s+0/)

    const notYet: PolicyStatusReport = {
      ...status,
      readiness: { ...status.readiness, suppressed: false, ready: false },
    }
    const text = renderActivationText(
      buildActivationReport(input({ snapshot: { ok: true, report: notYet } })),
    )
    expect(text).toContain(
      '  Readiness: not yet (123 calls across 5 tool-door pairs in the last 7d; floor 100 across 3)',
    )
  })
})

describe('the builder is pure', () => {
  it('imports nothing network-shaped and calls no fetch', () => {
    const source = readFileSync(join(import.meta.dirname, 'activation.ts'), 'utf-8')
    for (const banned of [
      'node:http',
      'node:https',
      'node:net',
      'node:tls',
      'node:child_process',
      'undici',
      "from 'http'",
      "from 'https'",
      "from 'net'",
    ]) {
      expect(source, banned).not.toContain(banned)
    }
    expect(source).not.toContain('fetch(')
    expect(source).not.toContain('Date.now(')
    expect(source).not.toContain('new Date()')
  })
})
