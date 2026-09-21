// ---------------------------------------------------------------------------
// Authority surface: the classified tool surface the proxy can reach and the
// coverage the loaded policy has over it (issue #396).
//
// One classifier for the startup lines, `GET /api/policy/status`, the CLI
// and, later, `helio scan` (#299). Leaf module: it imports the matcher, the
// engine and the pipeline's severity ranking, and nothing from the cache,
// the forwarder, the store or the CLI. Pure and deterministic: no I/O.
//
// The two formatters ARE the vocabulary: "tool-door pair", "annotated
// destructive", "destructive by MCP default", "have a rule that can match
// them", "covered only when arguments match". Never "flagged destructive",
// never "used", never "occurred".
// ---------------------------------------------------------------------------

import type {
  CompiledPolicy,
  CompiledPolicyRule,
  MatchContext,
  PolicyAction,
  ToolAnnotationHints,
} from './types.js'
import { matchRule } from './matchers.js'
import { evaluatePolicy } from './engine.js'
import type { PolicyDecision } from './engine.js'
import { stricterDecision } from './decision-pipeline.js'

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** One tool on one door, as a snapshot: nothing here references a cache map. */
export interface SurfaceTool {
  readonly name: string
  /** The baseline's four MCP hints, picked onto a fresh object; undefined when the baseline has none. */
  readonly annotations: ToolAnnotationHints | undefined
  /** The latest list's hints, the same way; read only for log-mode drift. */
  readonly current_annotations: ToolAnnotationHints | undefined
  readonly drifted: boolean
}

/**
 * One door of the surface. A listed upstream carries its tools; an upstream
 * whose prime has not succeeded carries the reason instead (`helio start`
 * maps a prime controller that is not primed to `unavailable: lastFailure`;
 * `helio scan` maps a failed tools/list to the error and mints no process
 * flag). An adapter origin is a sideband cache, on no MCP door.
 */
export type SurfaceDoor =
  | {
      readonly kind: 'upstream'
      /** The configured upstream name; undefined in singular mode. */
      readonly name: string | undefined
      /** What a line calls a door without a name (the URL or command in singular mode). */
      readonly label?: string
      readonly tools: readonly SurfaceTool[]
    }
  | {
      readonly kind: 'upstream'
      readonly name: string | undefined
      readonly label?: string
      readonly unavailable: string
    }
  | { readonly kind: 'adapter'; readonly origin: string; readonly tools: readonly SurfaceTool[] }

export interface SurfaceInput {
  readonly doors: readonly SurfaceDoor[]
  readonly policy: CompiledPolicy
  readonly environment: string | undefined
}

// ---------------------------------------------------------------------------
// Report (snake_case: the endpoint serializes it verbatim)
// ---------------------------------------------------------------------------

/** The door a pair or a persisted row belongs to. */
export type SurfaceDoorRef =
  | { readonly kind: 'upstream'; readonly name: string | null }
  | { readonly kind: 'adapter'; readonly origin: string }

export type SurfaceDoorReport = SurfaceDoorRef & {
  readonly available: boolean
  readonly unavailable_reason: string | null
  readonly tool_count: number
  readonly annotated_count: number
  readonly annotated_destructive: number
}

export type SurfaceDestructive = 'annotated' | 'default' | 'no'
export type SurfacePairStatus = 'matched' | 'conditional' | 'uncovered'
export type SurfaceEffectiveSource = 'rule' | 'default' | 'flag_destructive' | 'drift'

export interface SurfaceRuleRef {
  readonly name: string | null
  readonly index: number
  readonly action: PolicyAction
}

export interface SurfaceConditionalRule extends SurfaceRuleRef {
  /** The dimension the synthesized context cannot know before a call. */
  readonly on: 'arguments' | 'metadata'
}

export interface SurfacePair {
  readonly door: SurfaceDoorRef
  readonly tool: string
  readonly destructive: SurfaceDestructive
  readonly drifted: boolean
  /** True when `flag_destructive` would fire for an argument-less call. */
  readonly flagged_destructive: boolean
  readonly status: SurfacePairStatus
  /** The deciding rule for an argument-less call, or null for the default. */
  readonly matched_rule: SurfaceRuleRef | null
  /** Rules ahead of the deciding one that fire only for some calls. */
  readonly conditional_rules: readonly SurfaceConditionalRule[]
  readonly effective_action: PolicyAction
  readonly effective_source: SurfaceEffectiveSource
}

export interface SurfaceCoverage {
  readonly matched: number
  readonly conditional: number
  readonly uncovered: number
  /** What an uncovered pair falls through to (`policies.default`). */
  readonly default_action: 'allow' | 'deny'
  readonly by_effective_action: Readonly<Record<PolicyAction, number>>
  readonly pairs: readonly SurfacePair[]
}

export interface SurfaceReport {
  /** Tool-door pairs on every available door, adapter origins included. */
  readonly pairs: number
  /** Available (primed) upstream doors. */
  readonly upstream_count: number
  readonly adapter_origin_count: number
  /** Pairs whose baseline sets `destructiveHint: true` explicitly. */
  readonly annotated_destructive: number
  /** Pairs destructive by MCP default: no annotations object, or no `destructiveHint` key. */
  readonly default_destructive: number
  /** Doors with tools where no tool carries an annotations object. */
  readonly annotation_free_doors: readonly string[]
  readonly doors: readonly SurfaceDoorReport[]
  readonly unavailable: readonly { readonly name: string; readonly reason: string }[]
  readonly coverage: SurfaceCoverage
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

const ACTIONS: readonly PolicyAction[] = [
  'allow',
  'deny',
  'require_approval',
  'rate_limit',
  'spend_limit',
  'dry_run',
]

function doorLabel(door: SurfaceDoor): string {
  if (door.kind === 'adapter') return door.origin
  return door.name ?? door.label ?? 'upstream'
}

function doorRef(door: SurfaceDoor): SurfaceDoorRef {
  return door.kind === 'adapter'
    ? { kind: 'adapter', origin: door.origin }
    : { kind: 'upstream', name: door.name ?? null }
}

function ruleRef(rule: CompiledPolicyRule): SurfaceRuleRef {
  return { name: rule.name ?? null, index: rule.index, action: rule.action }
}

function classifyDestructive(annotations: ToolAnnotationHints | undefined): SurfaceDestructive {
  if (annotations === undefined || annotations.destructiveHint === undefined) return 'default'
  return annotations.destructiveHint ? 'annotated' : 'no'
}

/**
 * The copy of a rule whose unknowable dimensions are removed: `match.input`
 * always (arguments exist only per call), `match.metadata` on adapter origins
 * only (on the MCP path a metadata rule is inert, never conditional).
 */
function stripUnknowable(rule: CompiledPolicyRule, adapter: boolean): CompiledPolicyRule {
  const { input: _input, metadata, ...rest } = rule.match
  return { ...rule, match: adapter ? rest : { ...rest, metadata } }
}

function conditionalOn(rule: CompiledPolicyRule): 'arguments' | 'metadata' {
  return rule.match.input !== undefined ? 'arguments' : 'metadata'
}

/**
 * The effective action for an argument-less call, folded in the same order
 * `decide()` folds it (decision-pipeline.ts): rule evaluation on the
 * baseline hints; in log-mode drift the stricter of baseline and current;
 * `flag_destructive` when no rule matched and the tool is destructive by the
 * pipeline's own OR of baseline and log-mode current claim; then the drift
 * gate in block or require_approval mode overriding everything before it.
 * Global `dry_run` never rewrites the action (the pipeline records it beside
 * the decision), so it is reported at policy level, not here.
 */
function foldEffectiveAction(
  policy: CompiledPolicy,
  tool: SurfaceTool,
  ctx: MatchContext,
): {
  readonly base: PolicyDecision
  readonly effective_action: PolicyAction
  readonly effective_source: SurfaceEffectiveSource
  readonly flagged_destructive: boolean
} {
  const driftMode = policy.onToolDrift ?? 'block'
  const base = evaluatePolicy(policy, ctx)
  let decision = base
  if (tool.drifted && driftMode === 'log') {
    decision = stricterDecision(
      decision,
      evaluatePolicy(policy, { ...ctx, annotations: tool.current_annotations }),
    )
  }
  let source: SurfaceEffectiveSource = decision.matchedRule ? 'rule' : 'default'
  let action = decision.action

  const baselineDestructive = tool.annotations?.destructiveHint ?? true
  const currentDestructive =
    tool.drifted && driftMode === 'log'
      ? (tool.current_annotations?.destructiveHint ?? true)
      : false
  const isDestructive = baselineDestructive || currentDestructive
  let flagged = false
  if (isDestructive && !decision.matchedRule && policy.flagDestructive) {
    flagged = true
    if (policy.flagDestructive === 'require_approval') {
      action = 'require_approval'
      source = 'flag_destructive'
    }
  }

  if (tool.drifted && driftMode !== 'log') {
    action = driftMode === 'block' ? 'deny' : 'require_approval'
    source = 'drift'
  }

  return { base, effective_action: action, effective_source: source, flagged_destructive: flagged }
}

function classifyPair(
  policy: CompiledPolicy,
  environment: string | undefined,
  door: SurfaceDoor,
  tool: SurfaceTool,
): SurfacePair {
  const adapter = door.kind === 'adapter'
  const ctx: MatchContext = {
    toolName: tool.name,
    annotations: tool.annotations,
    environment,
    upstream: adapter ? undefined : door.name,
  }

  const conditional: SurfaceConditionalRule[] = []
  let matched: CompiledPolicyRule | undefined
  for (const rule of policy.rules) {
    if (matchRule(rule, ctx)) {
      matched = rule
      break
    }
    const hasUnknowable =
      rule.match.input !== undefined || (adapter && rule.match.metadata !== undefined)
    if (hasUnknowable && matchRule(stripUnknowable(rule, adapter), ctx)) {
      conditional.push({ ...ruleRef(rule), on: conditionalOn(rule) })
    }
  }

  const fold = foldEffectiveAction(policy, tool, ctx)
  const status: SurfacePairStatus = matched
    ? 'matched'
    : conditional.length > 0
      ? 'conditional'
      : 'uncovered'

  return {
    door: doorRef(door),
    tool: tool.name,
    destructive: classifyDestructive(tool.annotations),
    drifted: tool.drifted,
    flagged_destructive: fold.flagged_destructive,
    status,
    matched_rule: fold.base.matchedRule ? ruleRef(fold.base.matchedRule) : null,
    conditional_rules: conditional,
    effective_action: fold.effective_action,
    effective_source: fold.effective_source,
  }
}

/**
 * Classify the surface against the policy. Pure: the same doors and policy
 * always give the same report, and the report holds no reference to any
 * input object.
 */
export function classifySurface(input: SurfaceInput): SurfaceReport {
  const { policy, environment } = input
  const doors: SurfaceDoorReport[] = []
  const unavailable: { name: string; reason: string }[] = []
  const annotationFree: string[] = []
  const pairs: SurfacePair[] = []
  let upstreamCount = 0
  const adapterOrigins = new Set<string>()
  let annotatedDestructive = 0
  let defaultDestructive = 0

  for (const door of input.doors) {
    const ref = doorRef(door)
    if (!('tools' in door)) {
      unavailable.push({ name: doorLabel(door), reason: door.unavailable })
      doors.push({
        ...ref,
        available: false,
        unavailable_reason: door.unavailable,
        tool_count: 0,
        annotated_count: 0,
        annotated_destructive: 0,
      })
      continue
    }
    if (door.kind === 'adapter') adapterOrigins.add(door.origin)
    else upstreamCount += 1

    let annotatedCount = 0
    let doorAnnotatedDestructive = 0
    for (const tool of door.tools) {
      if (tool.annotations !== undefined) annotatedCount += 1
      const destructive = classifyDestructive(tool.annotations)
      if (destructive === 'annotated') {
        annotatedDestructive += 1
        doorAnnotatedDestructive += 1
      } else if (destructive === 'default') {
        defaultDestructive += 1
      }
      pairs.push(classifyPair(policy, environment, door, tool))
    }
    if (door.tools.length > 0 && annotatedCount === 0) annotationFree.push(doorLabel(door))
    doors.push({
      ...ref,
      available: true,
      unavailable_reason: null,
      tool_count: door.tools.length,
      annotated_count: annotatedCount,
      annotated_destructive: doorAnnotatedDestructive,
    })
  }

  const byAction = Object.fromEntries(ACTIONS.map((a) => [a, 0])) as Record<PolicyAction, number>
  let matched = 0
  let conditional = 0
  let uncovered = 0
  for (const pair of pairs) {
    byAction[pair.effective_action] += 1
    if (pair.status === 'matched') matched += 1
    else if (pair.status === 'conditional') conditional += 1
    else uncovered += 1
  }

  return {
    pairs: pairs.length,
    upstream_count: upstreamCount,
    adapter_origin_count: adapterOrigins.size,
    annotated_destructive: annotatedDestructive,
    default_destructive: defaultDestructive,
    annotation_free_doors: annotationFree,
    doors,
    unavailable,
    coverage: {
      matched,
      conditional,
      uncovered,
      default_action: policy.defaultAction,
      by_effective_action: byAction,
      pairs,
    },
  }
}

// ---------------------------------------------------------------------------
// Formatters: the vocabulary
// ---------------------------------------------------------------------------

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${String(count)} ${count === 1 ? singular : pluralForm}`
}

/**
 * The startup surface line (and `helio scan`'s summary line). One line per
 * door that is not primed, naming the reason and the command that reports
 * coverage once priming succeeds; the counts line covers the available
 * doors and is omitted when none is available. Lines are joined by `\n`.
 */
export function formatSurfaceLine(report: SurfaceReport): string {
  const lines: string[] = []
  const hasAvailableDoor = report.doors.some((d) => d.available)
  if (hasAvailableDoor) {
    const across = [plural(report.upstream_count, 'upstream')]
    if (report.adapter_origin_count > 0) {
      across.push(plural(report.adapter_origin_count, 'adapter origin'))
    }
    let line = `Authority surface: ${plural(report.pairs, 'tool-door pair')} across ${across.join(' and ')}`
    if (report.pairs > 0) {
      const anyAnnotated = report.doors.some((d) => d.annotated_count > 0)
      line += anyAnnotated
        ? `, ${String(report.annotated_destructive)} annotated destructive`
        : ', none annotated'
    }
    lines.push(line)
  }
  for (const door of report.unavailable) {
    lines.push(
      `Authority surface: not primed on ${door.name} (${door.reason}). helio policy status reports coverage once priming succeeds.`,
    )
  }
  return lines.join('\n')
}

/**
 * The startup coverage line. Undefined when there is no pair to cover (no
 * primed door, or zero tools on every primed door).
 */
export function formatCoverageLine(report: SurfaceReport): string | undefined {
  if (report.pairs === 0) return undefined
  const { matched, conditional } = report.coverage
  let line = `Policy coverage: ${String(matched)} of ${String(report.pairs)} have a rule that can match them`
  if (conditional > 0) {
    line += `, ${String(conditional)} covered only when ${conditionalWhenClause(report.coverage)}`
  }
  line += `, default ${report.coverage.default_action}`
  return line
}

/**
 * The dimension the conditional pairs wait on, as the startup line and the
 * text report both phrase it: `arguments match` when every conditional rule
 * is argument-conditioned, `metadata matches` when every one is
 * metadata-conditioned (adapter origins only), else both.
 */
export function conditionalWhenClause(coverage: SurfaceCoverage): string {
  const conditionalPairs = coverage.pairs.filter((p) => p.status === 'conditional')
  const every = (on: 'arguments' | 'metadata') =>
    conditionalPairs.every((p) => p.conditional_rules.every((r) => r.on === on))
  if (every('arguments')) return 'arguments match'
  if (every('metadata')) return 'metadata matches'
  return 'arguments or metadata match'
}
