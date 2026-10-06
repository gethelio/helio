// ---------------------------------------------------------------------------
// The policy simulation harness's shapes (issue #488): what a run is given,
// what it answers with, and the one interface a caller supplies for tool
// annotations. The option types are internal and camelCase; the result
// types cross a JSON boundary (`helio policy simulate --format json` prints
// them), so their fields are snake_case, the wire convention.
// ---------------------------------------------------------------------------

import type { AuditStore } from '../../audit/store.js'
import type { ConfigEpochRun } from '../../audit/types.js'
import type { ConfigSource } from '../../config/loader.js'
import type { HelioConfig } from '../../config/schema.js'
import type { ToolAnnotationHints } from '../types.js'

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------

/**
 * The one clock every store of a run reads: parked on each row's instant
 * before anything reads it, so windows slide and pots age as they did live.
 */
export interface VirtualClock {
  /** The current virtual instant in epoch milliseconds. */
  now(): number
  /** Move the clock to `ms`. */
  set(ms: number): void
}

// ---------------------------------------------------------------------------
// Annotations: the one input a caller supplies
// ---------------------------------------------------------------------------

/** What the harness asks an annotation source about one replayed row. */
export interface AnnotationQuery {
  /** The MCP door's configured name, or null on a singular door and on every sideband row. */
  readonly upstream: string | null
  readonly tool: string
  /** `mcp` for the proxy path, the adapter's declared origin for a sideband row. */
  readonly origin: string
  /** The row's `timestamp`, the instant the decision ran. */
  readonly timestamp: string
}

/**
 * An answer from an annotation source. `known` with `hints: undefined` is a
 * definition listed without annotations, evaluated through the MCP defaults
 * exactly as live and never warned; `unknown` is evaluated through the same
 * defaults and named in the report.
 */
export type AnnotationResolution =
  | {
      readonly kind: 'known'
      readonly hints: ToolAnnotationHints | undefined
      /** Where the hints came from, for the row's data; never printed in a frozen line. */
      readonly source: string
    }
  | { readonly kind: 'unknown' }

/**
 * Where a run gets the baseline annotations of an undrifted call. The
 * trail source (`trailAnnotationSource`) reads the baseline table unwound
 * through later acceptances; `helio policy simulate --demo` supplies the
 * sample server's listed definitions instead.
 */
export interface AnnotationSource {
  resolve(query: AnnotationQuery): AnnotationResolution
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** The candidate policy: the parsed config and the bytes and hash it was read from. */
export interface PolicySimulationCandidate {
  readonly config: HelioConfig
  readonly source: ConfigSource
}

/** The instants a run is bounded to, inclusive, on `timestamp`. */
export interface PolicySimulationWindow {
  readonly from?: string
  readonly to?: string
}

/**
 * Which config epoch of the window to simulate: the last run (the default),
 * every row of the window in one pass, or the last run of one hash, `null`
 * naming the rows that carry none.
 */
export type PolicySimulationEpochSelector =
  | 'latest'
  | 'all'
  | { readonly configSha256: string | null }

export interface PolicySimulationOptions {
  /** The audit store, opened by the caller with `cleanupIntervalMs: 0`. */
  readonly store: AuditStore
  readonly candidate: PolicySimulationCandidate
  /** Every other config file handed to the run; the candidate's own source is always in the set. */
  readonly sources?: readonly ConfigSource[]
  readonly window?: PolicySimulationWindow
  /** Exact match on the rows' `upstream`. */
  readonly upstream?: string
  /** Exact match on the rows' `session_id`. */
  readonly sessionId?: string
  readonly epoch?: PolicySimulationEpochSelector
  readonly annotations: AnnotationSource
  /** The clock to drive; a fresh one starting at 0 when absent. */
  readonly clock?: VirtualClock
  /**
   * Where every operational line the doors' code would print goes. Absent,
   * the lines are counted into `warnings_suppressed` and printed nowhere.
   */
  readonly warn?: (message: string) => void
}

// ---------------------------------------------------------------------------
// The result
// ---------------------------------------------------------------------------

/** A run of equal `config_sha256`, marked when it is the one simulated. */
export interface ConfigEpoch extends ConfigEpochRun {
  readonly selected: boolean
}

/** Which human gates a call raised: a rule ticket, a budget ticket, both or none. */
export type TicketKind = 'none' | 'rule' | 'budget' | 'both'

/** The four members compared per row; a delta is any one differing. */
export interface SimulatedOutcome {
  readonly policy_decision: string
  readonly block_reason: string | null
  readonly dry_run: boolean
  readonly ticket: TicketKind
}

/** The closed set of six dimensions the first frozen sentence names. */
export type FidelityDimension =
  | 'tool annotations'
  | 'tool definition drift'
  | 'evidence'
  | 'dependency state'
  | 'rate window'
  | 'spend amount'

/** One thing the harness could not verify on one row: the key the report aggregates by. */
export interface FidelityMark {
  /** The candidate's matched rule name, `rule[<index>]` when unnamed, `default` when no rule matched. */
  readonly rule: string
  readonly dimension: FidelityDimension
  /** The tool and its door or origin, as the report prints it. */
  readonly subject: string
}

/** One aggregated warning: a mark's key with the calls it covers and their instants. */
export interface FidelityWarning extends FidelityMark {
  readonly calls: number
  readonly instants: readonly string[]
}

/** One replayed row: the stored outcome beside the simulated one. */
export interface SimulatedRow {
  /** The audit record's id, data for an operator who has the database; never in a rendered line. */
  readonly record_id: string
  readonly timestamp: string
  readonly tool_name: string
  readonly upstream: string | null
  readonly origin: string
  /** Data on the row, never in a rendered line. */
  readonly session_id: string | null
  readonly stored: SimulatedOutcome
  readonly simulated: SimulatedOutcome
  /** The candidate's matched rule, when one matched. */
  readonly matched_rule: string | null
  readonly matched_rule_index: number | null
  /**
   * How a ticket the candidate raised was answered: `recorded` replays the
   * human's stored decision, `unanswered` means nobody was asked live and
   * the call would have been held; null when the candidate raised none.
   */
  readonly ticket_answer: 'recorded' | 'unanswered' | null
  readonly unverified: readonly FidelityMark[]
}

/** The rows whose outcome changed under the candidate. */
export type PolicySimulationDelta = SimulatedRow

/** A committed pot snapshot the rebuilt spend did not meet. */
export interface BudgetCheck {
  readonly budget: string
  readonly timestamp: string
  readonly stored_spent: number
  readonly simulated_spent: number
}

/** The rows the skip predicate removed before any reconstruction. */
export interface SkippedRows {
  readonly rejected: number
  readonly kill_switch: number
}

/** The fidelity report: the frozen sentences and the data behind them. */
export interface PolicyFidelityReport {
  /** The frozen sentences, in order, exactly as the fidelity page words them. */
  readonly lines: readonly string[]
  readonly warnings: readonly FidelityWarning[]
  readonly skipped: SkippedRows
  readonly unreported: number
}

export interface PolicySimulationResult {
  readonly candidate_sha256: string
  /** Every run in the window, the simulated one marked. */
  readonly epochs: readonly ConfigEpoch[]
  /** Rows compared. */
  readonly replayed: number
  readonly skipped: SkippedRows
  /** `evaluation_expired` rows in the selected epoch. */
  readonly unreported: number
  /** One per replayed row, in order. */
  readonly rows: readonly SimulatedRow[]
  readonly deltas: readonly PolicySimulationDelta[]
  readonly fidelity: PolicyFidelityReport
  readonly budget_checks: readonly BudgetCheck[]
  /** Operational lines the default collector swallowed. */
  readonly warnings_suppressed: number
}
