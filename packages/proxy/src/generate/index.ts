import type { PersistedSummary } from '../audit/types.js'
import type { PolicyGenerationEvidence } from '../audit/policy-generation.js'
import { buildGenerationEvidence, buildGenerationModel } from './model.js'
import type { GenerationDoor, GenerationSource } from './model.js'
import { buildGenerationReport } from './report.js'
import type { GenerationReport } from './report.js'

// ---------------------------------------------------------------------------
// Policy generation (issue #522): the one entry point a command calls. Pure
// and synchronous: no I/O, no clock (`now` is an input), no environment.
// Helio generates a candidate. Humans decide what becomes policy.
// ---------------------------------------------------------------------------

/** The `since` a whole-trail run passes to the store; the open's retention purge is the real lower bound. */
export const WHOLE_TRAIL_SINCE = '1970-01-01T00:00:00.000Z'

/** How a whole-trail window is labeled in the report. */
export const WHOLE_TRAIL_LABEL = 'whole trail within retention'

export interface GenerationInput {
  /** The deployed config: the loader's validated object and the bytes it was read from. */
  readonly source: GenerationSource
  /** The upstream doors and their listed definitions (adapter origins are not definition doors). */
  readonly doors: readonly GenerationDoor[]
  /** The audit store's summary of the generation window: `store.persistedSummary(sinceIso)`. */
  readonly observed: PersistedSummary
  /** The window as the caller labels it; `since` null for the whole trail. */
  readonly window: { readonly since: string | null; readonly label: string }
  readonly annotationSource: 'proxy' | 'demo'
  readonly now: Date
  readonly helioVersion: string
}

export interface GenerationResult {
  readonly report: GenerationReport
  /** The complete candidate config, or null when no rule was written or the splice refused. */
  readonly candidate: { readonly text: string; readonly sha256: string } | null
  /** The facts the record carries; the caller adds the path and the environment. */
  readonly evidence: PolicyGenerationEvidence
}

/** Classify, join, decide, write and report in one call. */
export function generatePolicy(input: GenerationInput): GenerationResult {
  const model = buildGenerationModel({
    source: input.source,
    doors: input.doors,
    observed: input.observed,
  })
  const report = buildGenerationReport(model, {
    window: input.window,
    annotationSource: input.annotationSource,
    now: input.now,
    helioVersion: input.helioVersion,
  })
  const candidate =
    model.candidate !== null && !('refused' in model.candidate)
      ? { text: model.candidate.text, sha256: model.candidate.sha256 }
      : null
  return {
    report,
    candidate,
    evidence: buildGenerationEvidence(model, {
      helioVersion: input.helioVersion,
      annotationSource: input.annotationSource,
    }),
  }
}

export {
  DESCRIPTION_SKIP,
  EXECUTE_SHAPED_SEGMENTS,
  IRREVERSIBILITY_MARKERS,
  NAME_DESTROY,
  NAME_EXEC,
  NAME_READ,
  NAME_WRITE,
  NAMESPACE_PREFIXES,
  NEEDS_DECISION_REASONS,
  READ_MARKERS,
  classifyDefinition,
  definitionFromListed,
  firstToken,
  inputKeyPaths,
} from './classify.js'
export type {
  ClassifiedDefinition,
  GenerationBaseline,
  GenerationClass,
  GenerationDefinition,
  GenerationReason,
  GenerationSignals,
} from './classify.js'
export {
  NEEDS_DASHBOARD_ENABLED_SENTENCE,
  NEEDS_DASHBOARD_SECRET_SENTENCE,
  frequencyWords,
} from './model.js'
export type {
  GenerationCounts,
  GenerationDisposition,
  GenerationDoor,
  GenerationKeptBy,
  GenerationObserved,
  GenerationPair,
  GenerationRule,
  GenerationSource,
} from './model.js'
export {
  CANDIDATE_SENSITIVITY_LINE,
  GENERATION_REPORT_SCHEMA_VERSION,
  renderGenerationText,
} from './report.js'
export type { GenerationReport, GenerationReportCandidate, GenerationReportSide } from './report.js'
export type { SpliceRefusal } from './splice.js'
