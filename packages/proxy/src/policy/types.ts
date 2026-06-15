// ---------------------------------------------------------------------------
// Compiled policy types — internal representation for the policy engine.
//
// Config types (from config/schema.ts) carry raw strings and are validated
// by Zod at load time. Compiled types carry pre-built matchers, pre-compiled
// regexes, and pre-parsed millisecond durations for zero-overhead evaluation.
// ---------------------------------------------------------------------------

/** Pre-compiled glob matcher for tool names. */
export interface ToolMatcher {
  /** Original glob pattern string (e.g. "send_*") for audit/logging. */
  readonly pattern: string
  /** Compiled test function — returns true if the tool name matches. */
  readonly test: (toolName: string) => boolean
}

/** Compiled annotation match conditions. */
export interface AnnotationMatch {
  readonly readOnlyHint?: boolean
  readonly destructiveHint?: boolean
  readonly idempotentHint?: boolean
  readonly openWorldHint?: boolean
}

/**
 * A single flattened input condition.
 *
 * Config format `{ '$.amount': { gt: 10, lt: 100 } }` is flattened into
 * two separate InputCondition entries — one per operator — to simplify
 * the engine's evaluation loop.
 */
export interface InputCondition {
  /** JSONPath string (e.g. "$.amount"). */
  readonly path: string
  /** Comparison operator. */
  readonly operator: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'regex'
  /** The comparison value. */
  readonly value: unknown
  /** Pre-compiled RegExp when operator is 'regex'. */
  readonly regex?: RegExp
}

/**
 * A single flattened metadata condition (issue #13 — `match.metadata.*`).
 *
 * Mirrors InputCondition but matches a flat top-level key of the adapter-supplied
 * context object (no JSONPath traversal), and is restricted to the string-friendly
 * operator subset — metadata values (channel_id, sender_id, …) are strings, so the
 * numeric comparators are deliberately excluded.
 */
export interface MetadataCondition {
  /** The metadata key to read (e.g. "channel_id", "sender_id", or virtual "agent_id"). */
  readonly key: string
  readonly operator: 'eq' | 'neq' | 'contains' | 'regex'
  readonly value: unknown
  /** Pre-compiled RegExp when operator is 'regex'. */
  readonly regex?: RegExp
}

/** Compiled match block for a policy rule. */
export interface CompiledMatch {
  readonly tool?: ToolMatcher
  readonly annotations?: AnnotationMatch
  /** Flattened list of input conditions (one entry per path+operator pair). */
  readonly input?: readonly InputCondition[]
  readonly environment?: string
  /** Flattened list of metadata conditions (one entry per key+operator pair). */
  readonly metadata?: readonly MetadataCondition[]
}

/** Compiled approval configuration with durations as milliseconds. */
export interface CompiledApproval {
  readonly channel: string
  readonly timeoutMs?: number
  readonly delegates?: readonly string[]
  readonly escalationAfterMs?: number
}

/** Compiled spend limit with window as milliseconds. */
export interface CompiledSpendLimit {
  readonly field: string
  readonly limit: number
  readonly currency: string
  readonly windowMs: number
  readonly key?: 'tool' | 'agent' | 'session' | 'sender_id'
}

/** Compiled rate/spend limit configuration. */
export interface CompiledLimits {
  readonly maxCalls?: number
  readonly windowMs?: number
  readonly key?: 'tool' | 'agent' | 'session' | 'sender_id'
  readonly maxSpend?: CompiledSpendLimit
}

/** Policy action types. */
export type PolicyAction =
  | 'allow'
  | 'deny'
  | 'require_approval'
  | 'rate_limit'
  | 'spend_limit'
  | 'dry_run'

/** A fully compiled policy rule ready for engine evaluation. */
export interface CompiledPolicyRule {
  /** Original position in the rules array (for audit/debugging). */
  readonly index: number
  readonly name?: string
  readonly match: CompiledMatch
  readonly action: PolicyAction
  readonly approval?: CompiledApproval
  readonly evidence?: { readonly requires: readonly string[] }
  readonly requires?: readonly string[]
  /**
   * When `requires` is set, controls whether dependency calls must have
   * succeeded upstream. Undefined defaults to `true` at the check site — a
   * failed call does NOT satisfy the dependency by default. Set to `false`
   * in config (`requires_success: false`) to opt out of the outcome check
   * and treat any attempted call as satisfying the dependency.
   */
  readonly requiresSuccess?: boolean
  readonly limits?: CompiledLimits
  readonly feedback?: { readonly message: string; readonly suggestion?: string }
}

/** Compiled match block for an install-time rule (issue #13). */
export interface CompiledInstallMatch {
  /** Glob matcher on the package name. */
  readonly name?: ToolMatcher
  /** Exact ecosystem/source match (npm | pip | …). */
  readonly source?: string
  /** Flattened metadata conditions (sender/channel-gated installs). */
  readonly metadata?: readonly MetadataCondition[]
}

/** A compiled install-time rule. */
export interface CompiledInstallRule {
  readonly index: number
  readonly name?: string
  readonly match: CompiledInstallMatch
  readonly action: 'deny_install' | 'allow'
  readonly feedback?: { readonly message: string; readonly suggestion?: string }
}

/** Compiled install-time policy (issue #13). */
export interface CompiledInstallPolicy {
  readonly defaultAction: 'allow' | 'deny'
  readonly rules: readonly CompiledInstallRule[]
}

/** Top-level compiled policy — what the engine consumes. */
export interface CompiledPolicy {
  readonly defaultAction: 'allow' | 'deny'
  readonly flagDestructive?: 'log' | 'require_approval'
  readonly dryRun?: boolean
  /**
   * Response to tool definition drift (issue #25). Undefined means "block"
   * at the use site — conservative by default.
   */
  readonly onToolDrift?: 'block' | 'require_approval' | 'log'
  readonly rules: readonly CompiledPolicyRule[]
  /** Install-time policy (issue #13 — deny_install). Undefined ⇒ observational. */
  readonly install?: CompiledInstallPolicy
}

/** A non-fatal warning produced during policy compilation. */
export interface PolicyParseWarning {
  readonly ruleIndex: number
  readonly ruleName?: string
  readonly message: string
}

/** Result of compiling a PoliciesConfig into engine-ready form. */
export interface CompilePoliciesResult {
  readonly policy: CompiledPolicy
  readonly warnings: readonly PolicyParseWarning[]
}

// ---------------------------------------------------------------------------
// Matcher types — runtime evaluation context for policy rules.
// ---------------------------------------------------------------------------

/**
 * Tool annotation hints as reported by the MCP server's tools/list response.
 *
 * Mirrors the MCP spec's annotation boolean fields. Defined locally to avoid
 * a runtime dependency on `@modelcontextprotocol/sdk`.
 */
export interface ToolAnnotationHints {
  readonly readOnlyHint?: boolean
  readonly destructiveHint?: boolean
  readonly idempotentHint?: boolean
  readonly openWorldHint?: boolean
}

/**
 * Context passed to matchers when evaluating a policy rule against a request.
 *
 * Built by the engine from the MCP request and cached tool metadata.
 * All fields are optional — not every MCP method involves a tool call.
 */
export interface MatchContext {
  /** The tool name from the tools/call request params. */
  readonly toolName?: string
  /** Annotations from the MCP tool's metadata (tools/list cache). */
  readonly annotations?: ToolAnnotationHints
  /** The `arguments` object from the tools/call request params. */
  readonly toolArguments?: Readonly<Record<string, unknown>>
  /** The configured environment label (e.g. "production", "staging"). */
  readonly environment?: string
  /**
   * Adapter-supplied context for `match.metadata.*` (issue #13). Present only on
   * the sideband (host-enforced) path; always absent on the MCP path, so metadata
   * rules are inert there by construction. The virtual `agent_id` key (from the
   * request column) is merged in by the decision pipeline, not stored here twice.
   */
  readonly metadata?: Readonly<Record<string, unknown>>
}
