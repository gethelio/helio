export { VERSION } from './version.js'

export { loadConfig, ConfigError } from './config/index.js'
export type { HelioConfig } from './config/index.js'
export { createApp, startServer, startSidebandServer } from './server.js'
export type { ServerHandle, CreateAppOptions } from './server.js'
// eslint-disable-next-line @typescript-eslint/no-deprecated -- deliberate compat re-export of the deprecated alias
export { UpstreamForwarder } from './upstream/index.js'
export type { UpstreamForwarderOptions } from './upstream/index.js'
export { StreamableHttpForwarder } from './upstream/index.js'
export type { StreamableHttpForwarderOptions } from './upstream/index.js'
export { SseUpstreamForwarder } from './upstream/index.js'
export type { SseUpstreamForwarderOptions } from './upstream/index.js'
export { StdioForwarder } from './transport/stdio-wrapper.js'
export type { StdioForwarderOptions } from './transport/stdio-wrapper.js'
export { compilePolicies, PolicyParseError, matchRule, evaluatePolicy } from './policy/index.js'
export { GovernedForwarder } from './policy/index.js'
export { RateLimiter } from './policy/index.js'
export { SpendLimiter } from './policy/index.js'
export type {
  CompiledPolicy,
  CompiledPolicyRule,
  CompilePoliciesResult,
  MatchContext,
  PolicyDecision,
  GovernedForwarderOptions,
  RateLimiterOptions,
  RateLimitCheckParams,
  RateLimitResult,
  RateLimitKeyState,
  SpendLimiterOptions,
  SpendLimitCheckParams,
  SpendLimitResult,
  SpendLimitKeyState,
} from './policy/index.js'
export { EvidenceStore, createSidebandApp } from './evidence/index.js'
export type { EvidenceEntry, SessionState, EvidenceStoreOptions } from './evidence/index.js'
export { GovernanceService } from './sideband/governance-service.js'
export { GovernanceConfigError } from './sideband/errors.js'
export type {
  GovernanceServiceOptions,
  WireDecision,
  EvaluateInput,
  AuditInput,
  InstallScanInput,
  ResolveApprovalInput,
  AdapterLivenessEntry,
} from './sideband/governance-service.js'
export { AuditStore, AuditWriter } from './audit/index.js'
export type {
  AuditRecord,
  AuditQueryFilters,
  AuditPaginationOptions,
  AuditListResult,
  AuditAggregateStats,
  AuditTimeBucket,
  AuditStoreOptions,
  AuditWriterOptions,
} from './audit/index.js'
export {
  ApprovalQueue,
  ApprovalRouter,
  QueueChannel,
  WebhookChannel,
  SlackChannel,
  createChannels,
  createApprovalApp,
  createSlackActionApp,
} from './approval/index.js'
export type {
  ApprovalTicket,
  ApprovalOutcome,
  ApprovalStatus,
  ApprovalChannel,
  ApprovalAppOptions,
  ApprovalQueueOptions,
  ApprovalRouterOptions,
  WebhookChannelOptions,
  SlackChannelOptions,
  SlackActionAppOptions,
} from './approval/index.js'
export { createDashboardApp, DashboardEventBus } from './dashboard/index.js'
export type {
  DashboardAppDeps,
  DashboardAppOptions,
  DashboardEvents,
  DashboardEventType,
} from './dashboard/index.js'
