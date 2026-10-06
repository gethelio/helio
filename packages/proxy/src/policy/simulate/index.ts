// ---------------------------------------------------------------------------
// The policy simulation harness (issue #488): the public surface the CLI
// (`helio policy simulate`, issue #490) and the tests import.
// ---------------------------------------------------------------------------

export { simulatePolicy, createVirtualClock } from './harness.js'
export { trailAnnotationSource } from './context.js'
export type {
  AnnotationQuery,
  AnnotationResolution,
  AnnotationSource,
  BudgetCheck,
  ConfigEpoch,
  FidelityDimension,
  FidelityMark,
  FidelityWarning,
  PolicyFidelityReport,
  PolicySimulationCandidate,
  PolicySimulationDelta,
  PolicySimulationEpochSelector,
  PolicySimulationOptions,
  PolicySimulationResult,
  PolicySimulationWindow,
  SimulatedOutcome,
  SimulatedRow,
  SkippedRows,
  TicketKind,
  VirtualClock,
} from './types.js'
