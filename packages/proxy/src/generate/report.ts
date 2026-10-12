import type { SurfaceCoverage, SurfaceDoorRef } from '../policy/surface.js'
import { describePolicy, renderPolicyCoverageLines } from '../policy/status.js'
import type { PolicyStatusPolicy } from '../policy/status.js'
import { unmatchableNote } from '../policy/rule-text.js'
import { formatUtcMinute } from '../util/format-time.js'
import { classWords, frequencyWords } from './model.js'
import type {
  GenerationCounts,
  GenerationModel,
  GenerationObserved,
  GenerationPair,
} from './model.js'
import type { SpliceRefusal } from './splice.js'

// ---------------------------------------------------------------------------
// The generation report (issue #522): the JSON the command prints and its
// text, sections in class-first order, calls as a column and never a sort
// key, nothing truncated. The closers (where the candidate went, the next
// step) are the command's lines, not this renderer's. Pure.
// ---------------------------------------------------------------------------

/** The report's schema version; bumped only for a breaking change. */
export const GENERATION_REPORT_SCHEMA_VERSION = 1

/** Printed under the candidate block whenever a candidate was written. */
export const CANDIDATE_SENSITIVITY_LINE =
  'The candidate carries the same sensitivity as helio.yaml (every placeholder and header it ' +
  'holds); keep it out of version control or add it to .gitignore.'

export interface GenerationReportSide {
  readonly sha256: string
  readonly policy: PolicyStatusPolicy
  readonly surface_pairs: number
  readonly coverage: SurfaceCoverage
}

export type GenerationReportCandidate =
  | (GenerationReportSide & { readonly rules: number })
  | { readonly refused: SpliceRefusal }

export interface GenerationReport {
  readonly schema_version: number
  readonly generated_at: string
  readonly helio_version: string
  readonly annotation_source: 'proxy' | 'demo'
  /** The window as the caller labels it; `since` null for the whole trail. */
  readonly window: { readonly since: string | null; readonly label: string }
  readonly source: GenerationReportSide
  /** Null when no rule was written. */
  readonly candidate: GenerationReportCandidate | null
  readonly observed: GenerationObserved
  readonly pairs: readonly GenerationPair[]
  readonly counts: GenerationCounts
}

export interface GenerationReportArgs {
  readonly window: { readonly since: string | null; readonly label: string }
  readonly annotationSource: 'proxy' | 'demo'
  readonly now: Date
  readonly helioVersion: string
}

/** Assemble the report from the model. Pure: no clock but `args.now`. */
export function buildGenerationReport(
  model: GenerationModel,
  args: GenerationReportArgs,
): GenerationReport {
  const candidate: GenerationReportCandidate | null =
    model.candidate === null
      ? null
      : 'refused' in model.candidate
        ? { refused: model.candidate.refused }
        : {
            sha256: model.candidate.sha256,
            rules: model.candidate.rules,
            policy: describePolicy(model.candidate.policy),
            surface_pairs: model.candidate.surface.pairs,
            coverage: model.candidate.surface.coverage,
          }
  return {
    schema_version: GENERATION_REPORT_SCHEMA_VERSION,
    generated_at: args.now.toISOString(),
    helio_version: args.helioVersion,
    annotation_source: args.annotationSource,
    window: args.window,
    source: {
      sha256: model.source.sha256,
      policy: describePolicy(model.source.policy),
      surface_pairs: model.source.surface.pairs,
      coverage: model.source.surface.coverage,
    },
    candidate,
    observed: model.observed,
    pairs: model.pairs,
    counts: model.counts,
  }
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

function n(value: number): string {
  return value.toLocaleString('en-US')
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n(count)} ${count === 1 ? singular : pluralForm}`
}

function doorName(door: SurfaceDoorRef): string {
  return door.kind === 'adapter' ? door.origin : (door.name ?? 'upstream')
}

function keptWords(pair: GenerationPair): string {
  const kept = pair.kept_by
  if (kept === null) return 'kept'
  if (kept.kind === 'flag_destructive') return 'kept (flag_destructive: require_approval)'
  return kept.name !== null
    ? `kept (source rule "${kept.name}")`
    : `kept (source rule[${String(kept.index)}])`
}

/** Rows padded column by column, as the status pairs table pads them; the last column is not padded. */
function table(rows: readonly (readonly string[])[]): string[] {
  const widths: number[] = []
  for (const row of rows) {
    for (const [i, cell] of row.entries()) widths[i] = Math.max(widths[i] ?? 0, cell.length)
  }
  return rows.map((row) =>
    `  ${row
      .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
      .join('  ')}`.trimEnd(),
  )
}

function driftClause(pair: GenerationPair, policy: PolicyStatusPolicy): string[] {
  return pair.candidate_effective_source === 'drift'
    ? [
        `drifted: on_tool_drift ${policy.on_tool_drift} decides this pair until its baseline is accepted`,
      ]
    : []
}

function writtenRow(pair: GenerationPair, policy: PolicyStatusPolicy): string[] {
  return [
    pair.tool,
    doorName(pair.door),
    pair.rule?.action ?? '',
    classWords(pair.class),
    pair.reason,
    frequencyWords(pair.calls),
    ...driftClause(pair, policy),
  ]
}

function classRow(pair: GenerationPair): string[] {
  return [
    pair.tool,
    doorName(pair.door),
    classWords(pair.class),
    pair.reason,
    frequencyWords(pair.calls),
  ]
}

/**
 * The text report: the source's `Policy coverage` block, the candidate and
 * its coverage when one was written, the two `Needs dashboard.*` headings,
 * `Needs your decision`, `Eligible, not yet observed`, `Kept`, `Could not
 * be written` and the `Observed` summary. An empty section is omitted.
 * Sections are joined by a blank line; no trailing newline.
 */
export function renderGenerationText(report: GenerationReport): string {
  const sections: string[][] = []
  const of = (disposition: GenerationPair['disposition']): GenerationPair[] =>
    report.pairs.filter((pair) => pair.disposition === disposition)

  sections.push(
    renderPolicyCoverageLines(
      report.source.coverage,
      report.source.surface_pairs,
      report.source.policy,
    ),
  )

  const written = of('written')
  const candidate = report.candidate
  if (candidate !== null && !('refused' in candidate)) {
    sections.push([
      'Generated candidate',
      `  ${plural(candidate.rules, 'rule')}`,
      ...table(written.map((pair) => writtenRow(pair, report.source.policy))),
    ])
    sections.push(
      renderPolicyCoverageLines(
        candidate.coverage,
        candidate.surface_pairs,
        candidate.policy,
        'Policy coverage (candidate)',
      ),
    )
    sections.push([`  ${CANDIDATE_SENSITIVITY_LINE}`])
  }

  const needsSecret = of('needs_dashboard_secret')
  if (needsSecret.length > 0) {
    sections.push([
      'Needs dashboard.api_secret',
      `  ${NEEDS_SECRET_LINE}`,
      ...table(needsSecret.map(classRow)),
    ])
  }
  const needsEnabled = of('needs_dashboard_enabled')
  if (needsEnabled.length > 0) {
    sections.push([
      'Needs dashboard.enabled',
      `  ${NEEDS_ENABLED_LINE}`,
      ...table(needsEnabled.map(classRow)),
    ])
  }

  const needsDecision = of('needs_decision')
  if (needsDecision.length > 0) {
    sections.push([
      'Needs your decision',
      ...table(
        needsDecision.map((pair) => [
          pair.tool,
          doorName(pair.door),
          frequencyWords(pair.calls),
          pair.reason,
        ]),
      ),
    ])
  }

  const unobserved = of('eligible_unobserved')
  if (unobserved.length > 0) {
    sections.push([
      'Eligible, not yet observed',
      ...table(
        unobserved.map((pair) => [
          pair.tool,
          doorName(pair.door),
          classWords(pair.class),
          pair.reason,
        ]),
      ),
    ])
  }

  const kept = of('kept')
  if (kept.length > 0) {
    sections.push([
      'Kept',
      ...table(
        kept.map((pair) => [
          pair.tool,
          doorName(pair.door),
          keptWords(pair),
          classWords(pair.class),
          pair.reason,
          frequencyWords(pair.calls),
        ]),
      ),
    ])
  }

  const unmatchable = of('unmatchable')
  const refused = candidate !== null && 'refused' in candidate ? candidate.refused : null
  if (unmatchable.length > 0 || refused !== null) {
    const lines = ['Could not be written']
    for (const pair of unmatchable) {
      lines.push(`  ${unmatchableNote(pair.tool, '').slice(2).trimEnd()}`)
    }
    if (refused !== null) {
      lines.push(`  could not write the candidate: ${refused}; write the rule by hand`)
      lines.push(...table(written.map((pair) => writtenRow(pair, report.source.policy))))
    }
    sections.push(lines)
  }

  const observed = report.observed
  const summary =
    `  ${plural(observed.calls, 'call')} across ${plural(observed.pairs_observed, 'tool-door pair')}` +
    (observed.observed_not_listed > 0
      ? `; ${n(observed.observed_not_listed)} observed on no listed door`
      : '')
  sections.push([
    `Observed (${report.window.label})`,
    summary,
    observed.first_seen_in_window !== null && observed.last_seen_in_window !== null
      ? `  first call ${formatUtcMinute(observed.first_seen_in_window)}, last call ${formatUtcMinute(observed.last_seen_in_window)}`
      : '  no tool call persisted in the window',
  ])

  return sections.map((lines) => lines.join('\n')).join('\n\n')
}

// The two gate sentences are the model's constants; re-declared here by import
// so the renderer prints exactly what the model promises.
import { NEEDS_DASHBOARD_ENABLED_SENTENCE, NEEDS_DASHBOARD_SECRET_SENTENCE } from './model.js'
const NEEDS_SECRET_LINE = NEEDS_DASHBOARD_SECRET_SENTENCE
const NEEDS_ENABLED_LINE = NEEDS_DASHBOARD_ENABLED_SENTENCE
