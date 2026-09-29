import { compilePolicies } from '../policy/parser.js'
import {
  classifySurface,
  formatCoverageLine,
  formatSurfaceLine,
  pairRuleLabel,
  unmatchedRules,
} from '../policy/surface.js'
import type {
  SurfaceCoverage,
  SurfaceDestructive,
  SurfaceDoor,
  SurfacePair,
  SurfaceReport,
  SurfaceTool,
  UnmatchedRule,
} from '../policy/surface.js'
import type { CompiledPolicy } from '../policy/types.js'
import type { CompiledBudget } from '../budget/types.js'
import { formatUtcMinute } from '../util/format-time.js'
import { candidatesOf } from './candidates.js'
import type { ArgumentCandidate } from './candidates.js'
import type { DuplicateTool, SurfaceToolsFromList } from './tools.js'
import type { ScanTransport } from './target.js'

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface ScanReportTarget {
  readonly label: string
  readonly transport: ScanTransport
  /** The door name on a named config. */
  readonly upstream: string | undefined
  /** The config path when one was loaded. */
  readonly config: string | undefined
}

export interface ScanReportInput {
  readonly target: ScanReportTarget
  /** ISO 8601 instant of the run. */
  readonly generatedAt: string
  /** The loaded policy, or `emptyAllowPolicy()` when no config was loaded. */
  readonly policy: CompiledPolicy
  /** False when no config was loaded: the JSON `policy` is then null. */
  readonly policyLoaded: boolean
  readonly budgets: readonly CompiledBudget[]
  readonly environment: string | undefined
  /** The listed tools, or null when the list failed. */
  readonly listed: SurfaceToolsFromList | null
  /** The failure line when the list failed. */
  readonly unavailable: string | undefined
}

// ---------------------------------------------------------------------------
// Report (snake_case: `--format json` serializes it verbatim)
// ---------------------------------------------------------------------------

/** Scan's own document version, separate from the policy status report's. */
export const SCAN_SCHEMA_VERSION = 1

export type HintSource = 'server' | 'default'

/** One MCP hint with where its value came from: the server's annotations, or the MCP default. */
export interface ScanHint {
  readonly value: boolean
  readonly source: HintSource
}

export interface ScanReportTool {
  readonly name: string
  readonly destructive: SurfaceDestructive
  readonly hints: {
    readonly destructiveHint: ScanHint
    readonly readOnlyHint: ScanHint
  }
  readonly candidates: readonly ArgumentCandidate[]
}

export interface ScanReportPolicy {
  readonly rule_count: number
  readonly default_action: 'allow' | 'deny'
  readonly flag_destructive: 'log' | 'require_approval' | null
  readonly on_tool_drift: 'block' | 'require_approval' | 'log'
  readonly dry_run: boolean
}

export interface ScanReportSummary {
  readonly tools: number
  readonly destructive: number
  readonly destructive_by_default: number
  /** Equals `coverage.matched`: pairs a rule can match for an argument-less call. */
  readonly governed: number
  readonly conditional: number
}

export interface ScanReport {
  readonly schema_version: typeof SCAN_SCHEMA_VERSION
  readonly generated_at: string
  readonly target: {
    readonly label: string
    readonly transport: ScanTransport
    readonly upstream: string | null
    readonly config: string | null
  }
  readonly policy: ScanReportPolicy | null
  readonly surface: Omit<SurfaceReport, 'coverage'>
  readonly coverage: SurfaceCoverage
  readonly tools: readonly ScanReportTool[]
  readonly duplicates: readonly DuplicateTool[]
  readonly unmatched_rules: readonly UnmatchedRule[]
  readonly summary: ScanReportSummary
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/** The policy a scan without a config classifies against: no rule, default allow. */
export function emptyAllowPolicy(): CompiledPolicy {
  return compilePolicies({ default: 'allow', rules: [], dry_run: false }).policy
}

function hintOf(tool: SurfaceTool, key: 'readOnlyHint' | 'destructiveHint'): ScanHint {
  const annotations = tool.annotations
  if (annotations !== undefined && key in annotations) {
    return { value: Boolean(annotations[key]), source: 'server' }
  }
  // The MCP defaults: a tool is destructive and not read-only until it says otherwise.
  return { value: key === 'destructiveHint', source: 'default' }
}

/** Assemble the report from the resolved target, the listed tools and the policy. */
export function buildScanReport(input: ScanReportInput): ScanReport {
  const { target, listed } = input
  const door: SurfaceDoor =
    listed === null
      ? {
          kind: 'upstream',
          name: target.upstream,
          label: target.label,
          unavailable: input.unavailable ?? 'tools/list failed',
        }
      : { kind: 'upstream', name: target.upstream, label: target.label, tools: listed.tools }
  const surface = classifySurface({
    doors: [door],
    policy: input.policy,
    environment: input.environment,
  })
  const { coverage, ...rest } = surface

  const destructiveByName = new Map(coverage.pairs.map((pair) => [pair.tool, pair.destructive]))
  const tools: ScanReportTool[] =
    listed === null
      ? []
      : listed.tools.map((tool) => ({
          name: tool.name,
          destructive: destructiveByName.get(tool.name) ?? 'default',
          hints: {
            destructiveHint: hintOf(tool, 'destructiveHint'),
            readOnlyHint: hintOf(tool, 'readOnlyHint'),
          },
          candidates: candidatesOf(listed.definitions.get(tool.name)?.['inputSchema']),
        }))

  return {
    schema_version: SCAN_SCHEMA_VERSION,
    generated_at: input.generatedAt,
    target: {
      label: target.label,
      transport: target.transport,
      upstream: target.upstream ?? null,
      config: target.config ?? null,
    },
    policy: input.policyLoaded
      ? {
          rule_count: input.policy.rules.length,
          default_action: input.policy.defaultAction,
          flag_destructive: input.policy.flagDestructive ?? null,
          on_tool_drift: input.policy.onToolDrift ?? 'block',
          dry_run: input.policy.dryRun === true,
        }
      : null,
    surface: rest,
    coverage,
    tools,
    duplicates: listed?.duplicates ?? [],
    unmatched_rules:
      listed === null
        ? []
        : unmatchedRules({ policy: input.policy, budgets: input.budgets, doors: [door] }),
    summary: {
      tools: surface.pairs,
      destructive: surface.annotated_destructive + surface.default_destructive,
      destructive_by_default: surface.default_destructive,
      governed: coverage.matched,
      conditional: coverage.conditional,
    },
  }
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

function n(value: number): string {
  return String(value)
}

function plural(count: number, singular: string): string {
  return `${n(count)} ${count === 1 ? singular : `${singular}s`}`
}

function readOnlyCell(hint: ScanHint): string {
  const source = hint.source === 'server' ? '(server)' : '(MCP default)'
  return `${hint.value ? 'read-only' : 'not read-only'} ${source}`
}

function destructiveCell(hint: ScanHint): string {
  const source = hint.source === 'server' ? '(server)' : '(MCP default)'
  return `${hint.value ? 'destructive' : 'not destructive'} ${source}`
}

function candidateCell(candidates: readonly ArgumentCandidate[]): string {
  if (candidates.length === 0) return ''
  return `candidate: ${candidates.map((c) => `${c.kind} ${c.path}`).join('; ')}`
}

function unmatchedLine(entry: UnmatchedRule): string {
  const scope = entry.upstreams === null ? '' : `, upstreams: ${entry.upstreams.join(', ')}`
  if (entry.kind === 'budget_contributor') {
    return `  budget "${entry.name ?? ''}" contributor ${n(entry.contributor_index ?? 0)}${scope}: match.tool ${entry.pattern}`
  }
  const where = `rules[${n(entry.index)}]`
  return entry.name === null
    ? `  rule ${where}${scope}: match.tool ${entry.pattern}`
    : `  rule "${entry.name}" (${where}${scope}): match.tool ${entry.pattern}`
}

/** The text report: header, the two surface lines, one row per tool, the no-match section, the summary. */
export function renderScanText(report: ScanReport): string {
  const lines: string[] = []
  lines.push(
    `Scan of ${report.target.label} (${report.target.transport}), ${formatUtcMinute(report.generated_at)}`,
  )
  const unavailable = report.surface.unavailable[0]
  if (unavailable !== undefined) {
    lines.push(unavailable.reason)
    return lines.join('\n')
  }

  const surface: SurfaceReport = { ...report.surface, coverage: report.coverage }
  lines.push(formatSurfaceLine(surface))
  const coverageLine = formatCoverageLine(surface)
  if (coverageLine !== undefined) {
    lines.push(
      report.target.config === null ? coverageLine : `${coverageLine} (${report.target.config})`,
    )
  }
  if (report.target.config === null) {
    lines.push('  no config loaded: pass -c helio.yaml to cross-check coverage')
  }

  for (const duplicate of report.duplicates) {
    lines.push(
      `Warning: "${duplicate.name}" appears ${n(duplicate.count)} times in tools/list; its annotations are read as unset`,
    )
  }

  const policy = {
    default_action: report.coverage.default_action,
    on_tool_drift: report.policy?.on_tool_drift ?? 'block',
  }
  const pairs = new Map<string, SurfacePair>(report.coverage.pairs.map((pair) => [pair.tool, pair]))
  const rows = report.tools.map((tool) => {
    const pair = pairs.get(tool.name)
    return {
      name: tool.name,
      readOnly: readOnlyCell(tool.hints.readOnlyHint),
      destructive: destructiveCell(tool.hints.destructiveHint),
      action: pair?.effective_action ?? '',
      rule: pair === undefined ? '' : pairRuleLabel(pair, policy),
      candidates: candidateCell(tool.candidates),
    }
  })
  const width = (key: 'name' | 'readOnly' | 'destructive' | 'action') =>
    rows.reduce((w, row) => Math.max(w, row[key].length), 0)
  const w = {
    name: width('name'),
    readOnly: width('readOnly'),
    destructive: width('destructive'),
    action: width('action'),
  }
  lines.push('')
  lines.push('Tools')
  for (const row of rows) {
    const cells = [
      row.name.padEnd(w.name),
      row.readOnly.padEnd(w.readOnly),
      row.destructive.padEnd(w.destructive),
      row.action.padEnd(w.action),
      row.rule,
    ]
    if (row.candidates !== '') cells.push(row.candidates)
    lines.push(`  ${cells.join('  ')}`)
  }
  if (rows.length === 0) lines.push('  (the upstream lists no tool)')

  if (report.unmatched_rules.length > 0) {
    lines.push('')
    lines.push(`Rules that match no tool on this upstream (${n(report.unmatched_rules.length)})`)
    for (const entry of report.unmatched_rules) lines.push(unmatchedLine(entry))
    lines.push(
      '  (a rule written ahead of a tool the upstream has not shipped yet is fine; this never blocks anything)',
    )
  }

  const { summary } = report
  let summaryLine =
    `Summary: ${plural(summary.tools, 'tool')} exposed, ${n(summary.destructive)} destructive ` +
    `(${n(summary.destructive_by_default)} by MCP default), ${n(summary.governed)} governed`
  if (summary.conditional > 0) {
    summaryLine += `, ${n(summary.conditional)} only when arguments match`
  }
  lines.push('')
  lines.push(summaryLine)
  return lines.join('\n')
}
