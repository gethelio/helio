import type { SessionConfig, SessionIdentitySource } from '../config/schema.js'
import type { ResolvedSession } from './types.js'

// ---------------------------------------------------------------------------
// Session identity resolver (issue #218)
//
// A pure per-request function: the transports evaluate the configured
// identity chain against the RAW route-factory headers (never the
// allowlist-filtered McpRequest.headers, which typically drops
// x-helio-session-id) and stamp the result on the request. Resolution holds
// no state — every stateful consumer (evidence store, budget engine,
// limiters, SSE streams) already has its own lifecycle.
// ---------------------------------------------------------------------------

/**
 * Maximum accepted identity value length — mirrors the sideband's session_id
 * cap so caller-minted ids cannot inflate bucket-key memory unaccounted.
 */
const MAX_SESSION_ID_LENGTH = 256

const CLIENT_INFO_META_KEY = 'io.modelcontextprotocol/clientInfo'

/** Compiled session config, wired into the route factories at startup. */
export interface CompiledSessionIdentity {
  /** The configured identity chain, in order; first match wins. */
  readonly sources: readonly SessionIdentitySource[]
  readonly onUnresolved: 'deny' | 'anonymous'
  /**
   * Human-readable strategy list (e.g. `header "x-helio-session-id",
   * legacy_header`) — deny messages name the strategies that were tried.
   */
  readonly strategySummary: string
}

/** Compile the validated `session` config section for the request path. */
export function compileSessionIdentity(config: SessionConfig): CompiledSessionIdentity {
  const strategySummary = config.identity
    .map((entry) => (entry.source === 'header' ? `header "${entry.name}"` : entry.source))
    .join(', ')
  return {
    sources: config.identity,
    onUnresolved: config.on_unresolved,
    strategySummary,
  }
}

/**
 * The schema-default identity chain, compiled. Route factories fall back to
 * it when no compiled config is supplied (direct or library construction),
 * matching the behavior of an absent `session:` section.
 */
export const DEFAULT_SESSION_IDENTITY: CompiledSessionIdentity = compileSessionIdentity({
  identity: [{ source: 'header', name: 'x-helio-session-id' }, { source: 'legacy_header' }],
  on_unresolved: 'deny',
})

/** Extract `params._meta` from a JSON-RPC params value, if any. */
export function paramsMeta(params: unknown): unknown {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) return undefined
  return (params as Record<string, unknown>)['_meta']
}

/** Per-request inputs the transports hand to the resolver. */
export interface ResolveSessionInput {
  /** RAW request headers (lowercased names), before any forward allowlist. */
  headers: Record<string, string>
  /** The request's `params._meta`, when present. */
  meta?: unknown
  /** Verbatim `Mcp-Session-Id` from the wire. */
  transportSessionId?: string
  /** Transport-minted per-stream id (`/sse` only). */
  transportMintedId?: string
}

let malformedValueWarned = false

/** Test-only: re-arm the one-shot malformed-value warning. */
export function resetSessionResolverWarningForTests(): void {
  malformedValueWarned = false
}

/**
 * Accept a candidate identity value verbatim, or skip it (undefined) when it
 * is empty after trimming or longer than the cap. Skipping continues the
 * chain — a malformed value in one source must not veto a later source.
 */
function sanitizeCandidate(value: string | undefined, origin: string): string | undefined {
  if (value === undefined) return undefined
  if (value.trim() === '' || value.length > MAX_SESSION_ID_LENGTH) {
    if (!malformedValueWarned) {
      malformedValueWarned = true
      // eslint-disable-next-line no-console -- Intentional operational warning
      console.error(
        `[helio] Warning: session identity value from ${origin} was skipped ` +
          `(empty or longer than ${String(MAX_SESSION_ID_LENGTH)} chars); ` +
          'continuing down the identity chain. Further skips will not be logged.',
      )
    }
    return undefined
  }
  return value
}

/** Derive `clientinfo:<name>@<version>` from a clientInfo `_meta` claim. */
function clientInfoId(meta: unknown): string | undefined {
  if (meta === null || typeof meta !== 'object') return undefined
  const clientInfo = (meta as Record<string, unknown>)[CLIENT_INFO_META_KEY]
  if (clientInfo === null || typeof clientInfo !== 'object') return undefined
  const { name, version } = clientInfo as Record<string, unknown>
  if (typeof name !== 'string' || name.trim() === '') return undefined
  // The namespace prevents accidental collision between a meta-derived key
  // and a deliberately chosen header key.
  return `clientinfo:${name}@${typeof version === 'string' ? version : 'unknown'}`
}

/**
 * Resolve the governance session identity for one request by walking the
 * configured chain in order. Returns undefined when nothing matches — the
 * caller decides what unresolved means (`on_unresolved`).
 *
 * The final transport fallback is implicit and not configurable: on `/sse`
 * the stream id Helio mints preserves today's per-stream isolation, so SSE
 * requests never become unresolved, while an explicit header still overrides
 * the stream identity.
 */
export function resolveSession(
  input: ResolveSessionInput,
  identity: CompiledSessionIdentity,
): ResolvedSession | undefined {
  for (const strategy of identity.sources) {
    switch (strategy.source) {
      case 'header': {
        const value = sanitizeCandidate(input.headers[strategy.name], `header "${strategy.name}"`)
        if (value !== undefined) return { id: value, source: 'header' }
        break
      }
      case 'meta': {
        const id = sanitizeCandidate(clientInfoId(input.meta), 'meta clientInfo')
        if (id !== undefined) return { id, source: 'meta' }
        break
      }
      case 'legacy_header': {
        const value = sanitizeCandidate(input.transportSessionId, 'legacy_header')
        if (value !== undefined) return { id: value, source: 'legacy_header' }
        break
      }
    }
  }
  if (input.transportMintedId !== undefined) {
    return { id: input.transportMintedId, source: 'transport' }
  }
  return undefined
}
