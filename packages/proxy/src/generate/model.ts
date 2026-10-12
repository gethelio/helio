import { createHash } from 'node:crypto'
import type { PersistedSummary } from '../audit/types.js'
import type { PolicyGenerationEvidence } from '../audit/policy-generation.js'
import { hasDashboardApiSecret, policyRuleSchema } from '../config/schema.js'
import type { HelioConfig } from '../config/schema.js'
import { compilePolicies } from '../policy/parser.js'
import {
  allowRule,
  approvalRule,
  exactPattern,
  exactlyMatchable,
  quoted,
} from '../policy/rule-text.js'
import { doorOfRow, pairKey } from '../policy/status.js'
import { classifySurface } from '../policy/surface.js'
import type {
  SurfaceDoor,
  SurfaceDoorRef,
  SurfaceEffectiveSource,
  SurfacePair,
  SurfaceReport,
  SurfaceTool,
} from '../policy/surface.js'
import { pickHints } from '../policy/tool-definitions.js'
import type { CompiledPolicy, PolicyAction } from '../policy/types.js'
import { NEEDS_DECISION_REASONS, classifyDefinition } from './classify.js'
import type {
  ClassifiedDefinition,
  GenerationClass,
  GenerationDefinition,
  GenerationReason,
  GenerationSignals,
} from './classify.js'
import { appendRules } from './splice.js'
import type { SpliceRefusal } from './splice.js'

// ---------------------------------------------------------------------------
// The generation model (issue #522): eligible, observed, kept, written. Joins
// the classified definitions, the source config's surface and the audit
// store's observed summary into one disposition per tool-door pair, writes
// the exact-name rules the intersection earns into a copy of the source
// text, and proves the candidate's surface. Pure: no I/O, no clock.
//
// Helio generates a candidate. Humans decide what becomes policy.
// ---------------------------------------------------------------------------

/** The deployed config: the loader's validated object and the bytes it was read from. */
export interface GenerationSource {
  /** `ConfigSource.raw`: comments and `${VAR}` placeholders intact. */
  readonly raw: string
  readonly sha256: string
  /** `parseConfigSource(...).config`, interpolated in the caller's environment. */
  readonly config: HelioConfig
}

/** One upstream door and its listed definitions (adapter origins are not definition doors). */
export interface GenerationDoor {
  /** The configured upstream name; undefined in singular mode. */
  readonly name: string | undefined
  readonly tools: readonly GenerationDefinition[]
}

export interface GenerationModelInput {
  readonly source: GenerationSource
  readonly doors: readonly GenerationDoor[]
  /** The audit store's summary of the generation window: `store.persistedSummary(sinceIso)`. */
  readonly observed: PersistedSummary
}

export type GenerationDisposition =
  | 'written'
  | 'kept'
  | 'needs_decision'
  | 'eligible_unobserved'
  | 'needs_dashboard_secret'
  | 'needs_dashboard_enabled'
  | 'unmatchable'

/** What keeps a pair: the source rule that decides it, or the `flag_destructive: require_approval` gate. */
export type GenerationKeptBy =
  | { readonly kind: 'rule'; readonly name: string | null; readonly index: number }
  | { readonly kind: 'flag_destructive' }

/** A written rule: its name, its action and its text (one comment line and the rule, unindented). */
export interface GenerationRule {
  readonly name: string
  readonly action: 'allow' | 'require_approval'
  readonly text: string
}

export interface GenerationPair {
  readonly door: SurfaceDoorRef
  readonly tool: string
  readonly class: GenerationClass
  readonly reason: GenerationReason
  readonly signals: GenerationSignals
  readonly drifted: boolean
  /** Rows in the window; a column, never a sort key. */
  readonly calls: number
  readonly disposition: GenerationDisposition
  readonly kept_by: GenerationKeptBy | null
  readonly rule: GenerationRule | null
  readonly source_effective_action: PolicyAction
  readonly source_effective_source: SurfaceEffectiveSource
  /** The candidate surface's reading of a written pair; null unless written into a candidate. */
  readonly candidate_effective_action: PolicyAction | null
  readonly candidate_effective_source: SurfaceEffectiveSource | null
}

export type GenerationCandidate =
  | {
      readonly text: string
      readonly sha256: string
      readonly rules: number
      readonly policy: CompiledPolicy
      readonly surface: SurfaceReport
    }
  | { readonly refused: SpliceRefusal }

export interface GenerationObserved {
  readonly calls: number
  /** Rows grouped by (tool, upstream, origin), on a listed door or not. */
  readonly pairs_observed: number
  /** Definition pairs classified. */
  readonly pairs_exposed: number
  /** Observed pairs on no definition door: an adapter origin, a tool that left the list, a door not in the run. */
  readonly observed_not_listed: number
  readonly first_seen_in_window: string | null
  readonly last_seen_in_window: string | null
}

export interface GenerationCounts {
  readonly written: number
  readonly kept: number
  readonly needs_decision: number
  readonly eligible_unobserved: number
  /** The two `Needs dashboard.*` headings together. */
  readonly needs_dashboard: number
  readonly unmatchable: number
}

export interface GenerationModel {
  readonly source: {
    readonly sha256: string
    readonly policy: CompiledPolicy
    readonly surface: SurfaceReport
  }
  /** Null when no rule was written; a refusal when the splice would not touch the text. */
  readonly candidate: GenerationCandidate | null
  /** Every exposed pair, in report order: class, then door, then tool. */
  readonly pairs: readonly GenerationPair[]
  readonly observed: GenerationObserved
  readonly counts: GenerationCounts
  readonly multi_upstream: boolean
}

// ---------------------------------------------------------------------------
// The two gate sentences (the schema's own messages, one line each)
// ---------------------------------------------------------------------------

export const NEEDS_DASHBOARD_SECRET_SENTENCE =
  'dashboard.api_secret is required when any rule uses require_approval. ' +
  'Run helio secret and set the printed digest under dashboard.api_secret.'

export const NEEDS_DASHBOARD_ENABLED_SENTENCE =
  'This rule would route approvals to the dashboard channel, but dashboard.enabled is false. ' +
  'Enable the dashboard or route approval.channel to a Slack channel.'

// ---------------------------------------------------------------------------
// Words and order
// ---------------------------------------------------------------------------

/** How a call count reads: `never observed`, `observed once`, `observed N times`. */
export function frequencyWords(calls: number): string {
  if (calls === 0) return 'never observed'
  if (calls === 1) return 'observed once'
  return `observed ${String(calls)} times`
}

const CLASS_WORDS: Readonly<Record<GenerationClass, string>> = {
  confident_read: 'confident read',
  confident_restrict: 'confident restrict',
  needs_decision: 'needs decision',
}

/** The class in words, as the generated comment and the report print it. */
export function classWords(cls: GenerationClass): string {
  return CLASS_WORDS[cls]
}

function doorName(door: SurfaceDoorRef): string {
  return door.kind === 'adapter' ? door.origin : (door.name ?? 'upstream')
}

/** Restrict first, then needs-decision in the nine-reason order, then read. */
function classRank(pair: {
  readonly class: GenerationClass
  readonly reason: GenerationReason
}): number {
  if (pair.class === 'confident_restrict') return 0
  if (pair.class === 'needs_decision') {
    const index = (NEEDS_DECISION_REASONS as readonly string[]).indexOf(pair.reason)
    return 1 + (index === -1 ? NEEDS_DECISION_REASONS.length : index)
  }
  return 1 + NEEDS_DECISION_REASONS.length + 1
}

/** The report order: class rank, then door name, then tool name. Calls never enter. */
export function comparePairs(
  a: Pick<GenerationPair, 'class' | 'reason' | 'door' | 'tool'>,
  b: Pick<GenerationPair, 'class' | 'reason' | 'door' | 'tool'>,
): number {
  const rank = classRank(a) - classRank(b)
  if (rank !== 0) return rank
  const door = doorName(a.door).localeCompare(doorName(b.door))
  if (door !== 0) return door
  return a.tool.localeCompare(b.tool)
}

// ---------------------------------------------------------------------------
// The surface
// ---------------------------------------------------------------------------

function surfaceDoors(doors: readonly GenerationDoor[]): SurfaceDoor[] {
  return doors.map((door) => ({
    kind: 'upstream',
    name: door.name,
    tools: door.tools.map((def): SurfaceTool => {
      const hints = pickHints(def.annotations)
      return {
        name: def.name,
        annotations: hints,
        current_annotations: hints,
        drifted: def.baseline?.drifted ?? false,
      }
    }),
  }))
}

function keptBy(pair: SurfacePair): GenerationKeptBy | null {
  if (pair.matched_rule !== null) {
    return { kind: 'rule', name: pair.matched_rule.name, index: pair.matched_rule.index }
  }
  if (pair.effective_source === 'flag_destructive') return { kind: 'flag_destructive' }
  return null
}

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

function ruleText(
  tool: string,
  classified: ClassifiedDefinition,
  calls: number,
  action: 'allow' | 'require_approval',
  scope: { readonly upstream: string } | undefined,
  taken: ReadonlySet<string>,
): GenerationRule {
  const base = `${action === 'allow' ? 'allow' : 'approve'}-${tool}`
  const name = taken.has(base) ? `${base}-generated` : base
  const rendered = action === 'allow' ? allowRule(tool, '', scope) : approvalRule(tool, '', scope)
  // The renderers name the rule from the tool; the collision suffix is this module's. The
  // one name line is swapped by split and join, never String.replace, whose replacement
  // string reads `$&`, `$'`, `$\`` and `$$` as patterns.
  const named =
    name === base
      ? rendered
      : rendered.split(`- name: ${quoted(base)}\n`).join(`- name: ${quoted(name)}\n`)
  const comment = `# generated: ${classWords(classified.class)}, ${classified.reason}; ${frequencyWords(calls)}\n`
  return { name, action, text: `${comment}${named}` }
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

/**
 * Build the model: classify every definition, read the source surface for
 * what already decides each pair, join the observed rows, decide one
 * disposition per pair, write the earned rules into a copy of the source
 * text and classify the candidate's surface. The same inputs always give the
 * same model.
 */
export function buildGenerationModel(input: GenerationModelInput): GenerationModel {
  const { config } = input.source
  const multiUpstream = 'upstreams' in config
  const sourcePolicy = compilePolicies(config.policies).policy
  const doors = surfaceDoors(input.doors)
  const sourceSurface = classifySurface({
    doors,
    policy: sourcePolicy,
    environment: config.environment,
  })
  const surfaceByKey = new Map(
    sourceSurface.coverage.pairs.map((pair) => [pairKey(pair.door, pair.tool), pair]),
  )

  // Observed rows joined to definition pairs; rows on no definition door are counted, never classified.
  const callsByKey = new Map<string, number>()
  for (const row of input.observed.pairs) {
    const key = pairKey(doorOfRow(row), row.tool_name)
    callsByKey.set(key, (callsByKey.get(key) ?? 0) + row.calls)
  }
  let observedNotListed = 0
  for (const key of callsByKey.keys()) if (!surfaceByKey.has(key)) observedNotListed += 1

  const gate = {
    secret: hasDashboardApiSecret(config.dashboard.api_secret),
    enabled: config.dashboard.enabled,
  }
  const takenNames = new Set(
    sourcePolicy.rules
      .map((rule) => rule.name)
      .filter((name): name is string => name !== undefined),
  )

  const pairs: GenerationPair[] = []
  for (const door of input.doors) {
    const ref: SurfaceDoorRef = { kind: 'upstream', name: door.name ?? null }
    for (const def of door.tools) {
      const classified = classifyDefinition(def)
      const key = pairKey(ref, def.name)
      const surfacePair = surfaceByKey.get(key)
      if (surfacePair === undefined) continue
      const calls = callsByKey.get(key) ?? 0
      const kept = keptBy(surfacePair)
      let disposition: GenerationDisposition
      let rule: GenerationRule | null = null
      if (!exactlyMatchable(def.name)) {
        disposition = 'unmatchable'
      } else if (kept !== null) {
        disposition = 'kept'
      } else if (classified.class === 'needs_decision') {
        disposition = 'needs_decision'
      } else if (calls === 0) {
        disposition = 'eligible_unobserved'
      } else if (classified.class === 'confident_restrict' && !gate.secret) {
        disposition = 'needs_dashboard_secret'
      } else if (classified.class === 'confident_restrict' && !gate.enabled) {
        disposition = 'needs_dashboard_enabled'
      } else {
        disposition = 'written'
        rule = ruleText(
          def.name,
          classified,
          calls,
          classified.class === 'confident_read' ? 'allow' : 'require_approval',
          multiUpstream && door.name !== undefined ? { upstream: door.name } : undefined,
          takenNames,
        )
      }
      pairs.push({
        door: ref,
        tool: def.name,
        class: classified.class,
        reason: classified.reason,
        signals: classified.signals,
        drifted: surfacePair.drifted,
        calls,
        disposition,
        kept_by: disposition === 'kept' ? kept : null,
        rule,
        source_effective_action: surfacePair.effective_action,
        source_effective_source: surfacePair.effective_source,
        candidate_effective_action: null,
        candidate_effective_source: null,
      })
    }
  }
  pairs.sort(comparePairs)

  const written = pairs.filter((pair) => pair.rule !== null)
  const candidate =
    written.length === 0 ? null : writeCandidate(input.source, sourcePolicy, doors, written)
  const finalPairs =
    candidate === null || 'refused' in candidate
      ? pairs
      : pairs.map((pair) => {
          if (pair.rule === null) return pair
          const after = candidate.surface.coverage.pairs.find(
            (p) => pairKey(p.door, p.tool) === pairKey(pair.door, pair.tool),
          )
          return after === undefined
            ? pair
            : {
                ...pair,
                candidate_effective_action: after.effective_action,
                candidate_effective_source: after.effective_source,
              }
        })

  const count = (disposition: GenerationDisposition): number =>
    finalPairs.filter((pair) => pair.disposition === disposition).length
  return {
    source: { sha256: input.source.sha256, policy: sourcePolicy, surface: sourceSurface },
    candidate,
    pairs: finalPairs,
    observed: {
      calls: input.observed.calls,
      pairs_observed: input.observed.pairs.length,
      pairs_exposed: finalPairs.length,
      observed_not_listed: observedNotListed,
      first_seen_in_window: input.observed.first_seen_in_window,
      last_seen_in_window: input.observed.last_seen_in_window,
    },
    counts: {
      written: count('written'),
      kept: count('kept'),
      needs_decision: count('needs_decision'),
      eligible_unobserved: count('eligible_unobserved'),
      needs_dashboard: count('needs_dashboard_secret') + count('needs_dashboard_enabled'),
      unmatchable: count('unmatchable'),
    },
    multi_upstream: multiUpstream,
  }
}

/**
 * Append the written rules, in report order, after the last source rule in
 * a copy of the source text; compile the candidate's policy from the source
 * policy plus the same rules validated one by one through the rule schema,
 * each with the EXACT pattern the file carries as its `match.tool` (the raw
 * name would be read as a glob and swallow siblings the file does not match;
 * the model has no environment to re-interpolate the text with); classify
 * its surface.
 */
function writeCandidate(
  source: GenerationSource,
  sourcePolicy: CompiledPolicy,
  doors: readonly SurfaceDoor[],
  written: readonly GenerationPair[],
): GenerationCandidate {
  const fragment = written.map((pair) => pair.rule?.text ?? '').join('')
  const spliced = appendRules(source.raw, fragment)
  if ('refused' in spliced) return spliced
  const appended = written.map((pair) => {
    const scope =
      pair.door.kind === 'upstream' && pair.door.name !== null && 'upstreams' in source.config
        ? { upstreams: [pair.door.name] }
        : {}
    const rule = pair.rule as GenerationRule
    return policyRuleSchema.parse({
      name: rule.name,
      match: { tool: exactPattern(pair.tool), ...scope },
      action: rule.action,
      ...(rule.action === 'require_approval' ? { approval: { channel: 'dashboard' } } : {}),
    })
  })
  const policy = compilePolicies({
    ...source.config.policies,
    rules: [...source.config.policies.rules, ...appended],
  }).policy
  const surface = classifySurface({ doors, policy, environment: source.config.environment })
  return {
    text: spliced.text,
    sha256: createHash('sha256').update(Buffer.from(spliced.text, 'utf-8')).digest('hex'),
    rules: written.length,
    policy,
    surface,
  }
}

// ---------------------------------------------------------------------------
// The record's facts
// ---------------------------------------------------------------------------

/** The evidence the generation record carries, read off the model. */
export function buildGenerationEvidence(
  model: GenerationModel,
  args: { readonly helioVersion: string; readonly annotationSource: 'proxy' | 'demo' },
): PolicyGenerationEvidence {
  const candidate =
    model.candidate !== null && !('refused' in model.candidate) ? model.candidate : null
  return {
    candidate_sha256: candidate?.sha256 ?? null,
    source_config_sha256: model.source.sha256,
    helio_version: args.helioVersion,
    traffic_start: model.observed.first_seen_in_window,
    traffic_end: model.observed.last_seen_in_window,
    call_count: model.observed.calls,
    pairs_observed: model.observed.pairs_observed,
    pairs_exposed: model.observed.pairs_exposed,
    rules_generated: candidate?.rules ?? 0,
    rules_kept: model.counts.kept,
    needs_decision: model.counts.needs_decision,
    eligible_unobserved: model.counts.eligible_unobserved,
    needs_dashboard: model.counts.needs_dashboard,
    default_action: {
      source: model.source.policy.defaultAction,
      candidate: candidate?.policy.defaultAction ?? null,
    },
    annotation_source: args.annotationSource,
  }
}
