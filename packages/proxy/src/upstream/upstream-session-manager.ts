import { mergeUpstreamHeaders } from './merge-headers.js'
import { describeUnreachableUpstream } from './connection-error.js'
import { parseSseChunk, readSseJsonRpcResponse } from './sse-parse.js'

/** The legacy leg's protocol offer — one of the two revisions Helio speaks. */
export const HELIO_MCP_LEGACY_PROTOCOL_VERSION = '2025-06-18'
/** MCP revision Helio speaks to a modern upstream (no initialize handshake). */
export const HELIO_MCP_MODERN_PROTOCOL_VERSION = '2026-07-28'
/**
 * Throttle on era re-probing, armed by a probe failure and by both
 * falsified-era clears (relay falsification and the internal initialize
 * failure). Relays presume legacy inside the window without waiting; the
 * first relay after it re-probes. `establish()` alone is backoff-free — its
 * callers retry on the prime loop's own cadence.
 */
export const ERA_PROBE_BACKOFF_MS = 30_000
const MAX_SSE_SCAN_BYTES = 256 * 1024
/** JSON-RPC id of the era probe, matched when its reply arrives SSE-framed. */
const ERA_PROBE_REQUEST_ID = 'helio-era-probe'
/** JSON-RPC error codes only a 2026-07-28 server emits. */
const MCP_HEADER_MISMATCH_CODE = -32020
const MCP_MISSING_CLIENT_CAPABILITY_CODE = -32021
const MCP_UNSUPPORTED_PROTOCOL_VERSION_CODE = -32022
/**
 * The same three codes as a set, for consumers that only need "is this a
 * code no legacy server emits" (the relay-side era falsification door).
 */
export const MCP_MODERN_ONLY_ERROR_CODES: ReadonlySet<number> = new Set([
  MCP_HEADER_MISMATCH_CODE,
  MCP_MISSING_CLIENT_CAPABILITY_CODE,
  MCP_UNSUPPORTED_PROTOCOL_VERSION_CODE,
])

/** Which MCP revision an upstream speaks, decided by the `server/discover` probe. */
export type UpstreamEra = 'modern' | 'legacy'

/**
 * `upstream.protocol_version`: `auto` probes and caches; a dated pin is a
 * constant — never probed, never cached, never cleared.
 */
export type UpstreamProtocolVersionPin = 'auto' | '2025-06-18' | '2026-07-28'

/**
 * DiscoverResult fields captured at probe time on a modern classification,
 * consumed by the relay leg's initialize synthesis. Cleared with the era it
 * came from; every modern classification re-captures from its own fresh
 * result.
 */
export interface DiscoverCapture {
  readonly capabilities?: Record<string, unknown>
  readonly instructions?: string
}

/** A live upstream session Helio established for its own sessionless requests. */
export interface UpstreamSession {
  readonly sessionId: string | undefined
  readonly protocolVersion: string
  readonly era: UpstreamEra
}

export interface UpstreamSessionManagerOptions {
  url: string
  staticHeaders: Record<string, string>
  requestTimeoutMs?: number
  protocolVersion?: UpstreamProtocolVersionPin
}

/** Standard modern `_meta` for Helio-internal requests. */
export function buildInternalMeta(): Record<string, unknown> {
  return {
    'io.modelcontextprotocol/protocolVersion': HELIO_MCP_MODERN_PROTOCOL_VERSION,
    'io.modelcontextprotocol/clientCapabilities': {},
    'io.modelcontextprotocol/clientInfo': { name: 'helio-proxy', version: '0' },
  }
}

/**
 * What the probe tells `establish()` to do next. `era` is ACTION semantics:
 * 'modern' mints the handshakeless session, 'legacy' runs the (single)
 * `initialize` call site. The -32022 salvage therefore reports 'legacy' even
 * though the server is modern — `unsupportedModernVersions` carries the
 * server's real nature into the error message if that initialize also fails.
 */
type EraProbeOutcome =
  | {
      readonly era: 'modern'
      readonly capabilities?: Record<string, unknown>
      readonly instructions?: string
    }
  | { readonly era: 'legacy'; readonly unsupportedModernVersions?: readonly string[] }

/**
 * Lenient, total reading of a probe response body. Unlike
 * `readRequiredJsonRpcEnvelope` this never throws: an empty or non-JSON body is
 * a classification input (legacy fallback), not a failure — a legacy server
 * answering unknown methods with `202`-empty must not wedge the prime loop.
 */
type ProbeBody =
  | { readonly kind: 'result'; readonly envelope: Record<string, unknown> }
  | { readonly kind: 'error'; readonly envelope: Record<string, unknown> }
  | { readonly kind: 'unparseable' }
  | { readonly kind: 'stalled'; readonly reason: string }

/** Bounded SSE scan outcome; callers map it onto their own step errors. */
type SseScanResult<T> =
  | { readonly outcome: 'found'; readonly value: T }
  | { readonly outcome: 'closed' }
  | { readonly outcome: 'timed-out' }
  | { readonly outcome: 'too-large' }

/**
 * Owns the upstream session for Helio-internal requests that arrive without a
 * downstream session (startup annotation prime, internal maintenance).
 *
 * Establishment starts with a `server/discover` probe that classifies the
 * upstream's MCP era: a modern (2026-07-28) upstream needs no handshake, a
 * legacy one gets the `initialize` + `notifications/initialized` pair. Era and
 * session are cached lazily and reused until invalidated (e.g. upstream 404),
 * which re-probes — the era is a property of the origin, and the spec asks
 * clients to re-probe once a cached assumption stops holding.
 */
export class UpstreamSessionManager {
  private readonly url: string
  private readonly staticHeaders: Record<string, string>
  private readonly requestTimeoutMs: number
  private readonly pin: UpstreamProtocolVersionPin
  private internal: UpstreamSession | undefined
  private era: UpstreamEra | undefined
  private capture: DiscoverCapture | undefined
  private inflight: Promise<UpstreamSession> | undefined
  private inflightProbe: Promise<EraProbeOutcome> | undefined
  private probeBackoffUntil = 0

  constructor(options: UpstreamSessionManagerOptions) {
    this.url = options.url
    this.staticHeaders = options.staticHeaders
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000
    this.pin = options.protocolVersion ?? 'auto'
  }

  /** Return the internal session, establishing it once if needed. */
  ensureInternalSession(): Promise<UpstreamSession> {
    if (this.internal) return Promise.resolve(this.internal)
    // Collapse concurrent first-callers onto a single establishment.
    this.inflight ??= this.establish()
      .then((session) => {
        this.internal = session
        return session
      })
      .finally(() => {
        this.inflight = undefined
      })
    return this.inflight
  }

  /**
   * Drop the cached internal session and era so the next call re-probes.
   * Does not cancel any in-flight establishment. Every era wipe drops the
   * probe-time DiscoverResult capture with it; invalidation is session
   * lifecycle, not falsification, so it must NOT arm the probe backoff.
   */
  invalidateInternalSession(): void {
    this.internal = undefined
    this.era = undefined
    this.capture = undefined
  }

  /**
   * Resolve the era a relayed request should be sent under. Evaluated in a
   * strict total order: pin, cached era, join an in-flight probe, backoff
   * presumption, start a probe. A probe failure never fails the relay — the
   * request proceeds under a per-request legacy presumption, preserving
   * today's behavior for deployments the probe cannot classify (for example
   * per-client Authorization pass-through, where the probe is refused
   * forever while relays carry the client's own credentials and succeed).
   */
  async resolveRelayEra(): Promise<UpstreamEra> {
    const pinned = this.pinnedEra()
    if (pinned) return pinned
    if (this.era) return this.era
    const joined = this.inflightProbe
    if (joined) {
      // Joining precedes the backoff check so a post-backoff in-flight probe
      // can never coexist with legacy-presumed siblings in the same burst.
      try {
        const outcome = await joined
        return outcome.era
      } catch {
        // The shared attempt's own failure already armed the backoff; a
        // join-failure must never bypass that window and start a second
        // probe.
        return 'legacy'
      }
    }
    if (Date.now() < this.probeBackoffUntil) return 'legacy'
    try {
      const outcome = await this.sharedProbe()
      this.cacheRelayClassification(outcome)
      return outcome.era
    } catch {
      // sharedProbe() noted the failure time; presume legacy for this
      // request only, caching nothing.
      return 'legacy'
    }
  }

  /**
   * Relay-side falsification door: a relayed response just contradicted a
   * cached legacy era (a modern-only JSON-RPC code on any method, or a
   * 404/-32601 answer to a relayed initialize). No-ops unless the cached era
   * is 'legacy': a cached modern era is never cleared automatically — no
   * reliable legacy-rejection signal exists, and recovery from an upstream
   * downgrade is pin-or-restart.
   */
  clearFalsifiedLegacyEra(door: string): void {
    if (this.era !== 'legacy') return
    this.clearEraAndArmBackoff(door)
  }

  /** Probe-captured DiscoverResult fields for the relay initialize synthesis. */
  getDiscoverCapture(): DiscoverCapture | undefined {
    return this.capture
  }

  /** The era a non-auto pin dictates; undefined in auto mode. */
  private pinnedEra(): UpstreamEra | undefined {
    if (this.pin === HELIO_MCP_MODERN_PROTOCOL_VERSION) return 'modern'
    if (this.pin === HELIO_MCP_LEGACY_PROTOCOL_VERSION) return 'legacy'
    return undefined
  }

  /**
   * One in-flight `server/discover` per manager, shared by `establish()` and
   * `resolveRelayEra()` — whichever asks first starts it, later callers
   * join. A failure notes its time, arming the relay-path backoff, then
   * rethrows for the consumer's own handling.
   */
  private sharedProbe(): Promise<EraProbeOutcome> {
    this.inflightProbe ??= this.probeEra()
      .catch((error: unknown) => {
        this.probeBackoffUntil = Date.now() + ERA_PROBE_BACKOFF_MS
        throw error
      })
      .finally(() => {
        this.inflightProbe = undefined
      })
    return this.inflightProbe
  }

  /**
   * Relay-path caching: the probe classification alone settles the era.
   * Caching 'legacy' without a proven initialize is what makes
   * `establish()`'s legacy fast path live; the two-sided re-probe rule
   * (`clearFalsifiedLegacyEra()` and the internal initialize catch) heals a
   * wrong conclusion.
   */
  private cacheRelayClassification(outcome: EraProbeOutcome): void {
    if (outcome.era === 'modern') {
      this.cacheModernClassification(outcome)
      return
    }
    this.setEra('legacy')
  }

  /** Every modern classification re-captures from its own fresh DiscoverResult. */
  private cacheModernClassification(outcome: {
    readonly capabilities?: Record<string, unknown>
    readonly instructions?: string
  }): void {
    this.capture = { capabilities: outcome.capabilities, instructions: outcome.instructions }
    this.setEra('modern')
  }

  /**
   * Falsified-classification clear: any cleared era means the classification
   * was just contradicted, so re-probing is throttled no matter which door
   * noticed. No-ops under a pin and on uncached eras; drops the probe-time
   * DiscoverResult capture with the era it came from; emits exactly one
   * operator line per clear.
   */
  private clearEraAndArmBackoff(door: string): void {
    if (this.pinnedEra()) return
    if (this.era === undefined) return
    this.era = undefined
    this.capture = undefined
    this.probeBackoffUntil = Date.now() + ERA_PROBE_BACKOFF_MS
    // eslint-disable-next-line no-console -- operator-visible era lifecycle detail
    console.error(
      `[helio] Upstream MCP era cleared: ${door}; ` +
        `relays presume legacy and re-probing is throttled for ` +
        `${String(ERA_PROBE_BACKOFF_MS / 1000)}s`,
    )
  }

  /** Convert a fetch failure into an actionable error for the given step. */
  private describeFetchFailure(error: unknown, step: string): Error {
    if (error instanceof Error && error.name === 'TimeoutError') {
      return new Error(`upstream ${step} timed out after ${String(this.requestTimeoutMs)}ms`)
    }
    return (
      describeUnreachableUpstream(error, this.url) ??
      (error instanceof Error ? error : new Error(String(error)))
    )
  }

  private async establish(): Promise<UpstreamSession> {
    // A pinned era is a constant: never probed, never cached, never cleared.
    const pinned = this.pinnedEra()
    if (pinned === 'modern') return this.modernSession()
    if (pinned === 'legacy') return this.legacyInitialize()
    if (this.era === 'modern') return this.modernSession()
    if (this.era === 'legacy') return this.legacyInitializeCachingEra(undefined)
    const probe = await this.sharedProbe()
    if (probe.era === 'modern') {
      this.cacheModernClassification(probe)
      return this.modernSession()
    }
    return this.legacyInitializeCachingEra(probe.unsupportedModernVersions)
  }

  /** The only `initialize` call site: one handshake attempt per establishment. */
  private async legacyInitializeCachingEra(
    unsupportedModernVersions: readonly string[] | undefined,
  ): Promise<UpstreamSession> {
    try {
      const session = await this.legacyInitialize()
      this.setEra('legacy')
      return session
    } catch (error) {
      // Internal-side falsification door: a CACHED legacy era whose own
      // initialize just failed was a wrong classification, cleared and
      // throttled through the same helper the relay door uses. On a fresh
      // establishment nothing is cached and the helper no-ops, keeping
      // today's behavior.
      this.clearEraAndArmBackoff('internal initialize failed against the cached legacy era')
      if (unsupportedModernVersions) {
        throw new Error(
          `upstream is a modern MCP server supporting [${unsupportedModernVersions.join(', ')}] ` +
            `(helio speaks ${HELIO_MCP_MODERN_PROTOCOL_VERSION} or legacy initialize); ` +
            `legacy fallback also failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      throw error
    }
  }

  /** Single owner of era assignment and of the era-detected log line. */
  private setEra(era: UpstreamEra): void {
    // Idempotent: two consumers of one shared probe may both record the same
    // conclusion, and the second assignment must not re-log it.
    if (this.era === era) return
    this.era = era
    // eslint-disable-next-line no-console -- operator-visible startup detail
    console.error(
      era === 'modern'
        ? `[helio] Upstream MCP era detected: modern (${HELIO_MCP_MODERN_PROTOCOL_VERSION}, via server/discover)`
        : '[helio] Upstream MCP era detected: legacy (initialize handshake)',
    )
  }

  /** A modern upstream neither mints nor echoes session ids — nothing to hold. */
  private modernSession(): UpstreamSession {
    return {
      sessionId: undefined,
      protocolVersion: HELIO_MCP_MODERN_PROTOCOL_VERSION,
      era: 'modern',
    }
  }

  /**
   * Classify the upstream's era with one `server/discover` request.
   *
   * A pure classifier: it performs no handshake, so the dual-era salvage cannot
   * double-initialize. It throws when no era conclusion is possible — a
   * transport failure, a status that says nothing about the era (401/403/5xx),
   * or a known-modern server refusing Helio's own probe — leaving the era
   * uncached so the next attempt re-probes.
   */
  private async probeEra(): Promise<EraProbeOutcome> {
    const headers = mergeUpstreamHeaders(
      {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': HELIO_MCP_MODERN_PROTOCOL_VERSION,
        'mcp-method': 'server/discover',
      },
      {},
      this.staticHeaders,
    )
    // staticHeaders win the merge above, so a library caller's constructor
    // headers could otherwise override the probe's own constant with a lie.
    // The probe is a pure classifier with a fixed method — force the
    // truthful value back on, rather than routing through the general
    // standard-headers helper.
    headers['mcp-method'] = 'server/discover'
    delete headers['mcp-name']

    const probeBody = {
      jsonrpc: '2.0' as const,
      id: ERA_PROBE_REQUEST_ID,
      method: 'server/discover',
      params: { _meta: buildInternalMeta() },
    }

    let res: Response
    try {
      res = await fetch(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(probeBody),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      })
    } catch (error) {
      throw this.describeFetchFailure(error, 'server/discover probe')
    }

    // Only 2xx and the spec's backward-compat statuses carry era evidence.
    // Anything else (401/403/5xx) leaves an auth-gated or briefly-down modern
    // server indistinguishable from a legacy one, so we conclude nothing.
    if (!isClassifiableProbeStatus(res.status)) {
      throw new Error(`upstream server/discover probe failed: HTTP ${String(res.status)}`)
    }

    const body = await this.readProbeBody(res)
    if (body.kind === 'stalled') {
      throw new Error(`upstream server/discover probe ${body.reason}`)
    }
    if (body.kind === 'unparseable') {
      // Empty, non-JSON, or an SSE stream that closed without our envelope:
      // the server answered something no modern server would. Try initialize.
      return { era: 'legacy' }
    }
    if (body.kind === 'error') {
      return classifyProbeError(body.envelope)
    }
    return classifyProbeResult(body.envelope)
  }

  private async readProbeBody(res: Response): Promise<ProbeBody> {
    const contentType = res.headers.get('content-type') ?? ''
    if (contentType.includes('text/event-stream')) {
      if (!res.body) return { kind: 'unparseable' }
      const scan = await this.scanSseEvents(res.body, (payload) =>
        payload['id'] === ERA_PROBE_REQUEST_ID ? payload : undefined,
      )
      switch (scan.outcome) {
        case 'found':
          return classifyEnvelopeShape(scan.value)
        case 'closed':
          return { kind: 'unparseable' }
        case 'timed-out':
          return {
            kind: 'stalled',
            reason: `SSE response timed out after ${String(this.requestTimeoutMs)}ms`,
          }
        case 'too-large':
          return {
            kind: 'stalled',
            reason: `SSE response exceeded ${String(MAX_SSE_SCAN_BYTES)} bytes`,
          }
      }
    }

    const raw = await res.text()
    if (!raw.trim()) return { kind: 'unparseable' }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { kind: 'unparseable' }
    }
    if (typeof parsed !== 'object' || parsed === null) return { kind: 'unparseable' }
    return classifyEnvelopeShape(parsed as Record<string, unknown>)
  }

  private async legacyInitialize(): Promise<UpstreamSession> {
    const headers = mergeUpstreamHeaders(
      {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      {},
      this.staticHeaders,
    )
    // Neither this `initialize` POST nor the `notifications/initialized` POST
    // it feeds (via the `notifyHeaders` clone below) route through send()'s
    // standard-headers helper, and staticHeaders wins the merge above — so a
    // library caller's constructor headers could otherwise inject a lie on
    // both. Absence cannot lie; strip it immediately, before either POST.
    delete headers['mcp-method']
    delete headers['mcp-name']

    const initBody = {
      jsonrpc: '2.0' as const,
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: HELIO_MCP_LEGACY_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'helio-proxy', version: '0' },
      },
    }

    let res: Response
    try {
      res = await fetch(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(initBody),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      })
    } catch (error) {
      throw this.describeFetchFailure(error, 'initialize')
    }

    if (!res.ok) {
      throw new Error(`upstream initialize failed: HTTP ${String(res.status)}`)
    }

    const sessionId = res.headers.get('mcp-session-id') ?? undefined
    const initializeEnvelope = await this.readRequiredJsonRpcEnvelope(
      res,
      initBody.id,
      'initialize',
    )
    const initializeError = extractJsonRpcErrorMessage(initializeEnvelope)
    if (initializeError) {
      throw new Error(`upstream initialize returned JSON-RPC error: ${initializeError}`)
    }
    const negotiatedProtocolVersion = extractNegotiatedProtocolVersion(initializeEnvelope)

    // Per spec, the client confirms with notifications/initialized.
    const notifyHeaders = { ...headers }
    if (sessionId) notifyHeaders['mcp-session-id'] = sessionId
    notifyHeaders['mcp-protocol-version'] = negotiatedProtocolVersion
    const notifyRes = await fetch(this.url, {
      method: 'POST',
      headers: notifyHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    }).catch((error: unknown) => {
      throw this.describeFetchFailure(error, 'notifications/initialized')
    })
    if (!notifyRes.ok) {
      throw new Error(`upstream notifications/initialized failed: HTTP ${String(notifyRes.status)}`)
    }
    const notifyError = await this.readOptionalJsonRpcError(notifyRes)
    if (notifyError) {
      throw new Error(`upstream notifications/initialized returned JSON-RPC error: ${notifyError}`)
    }

    return { sessionId, protocolVersion: negotiatedProtocolVersion, era: 'legacy' }
  }

  private async readRequiredJsonRpcEnvelope(
    res: Response,
    requestId: string | number | null,
    step: string,
  ): Promise<Record<string, unknown>> {
    const contentType = res.headers.get('content-type') ?? ''
    if (contentType.includes('text/event-stream')) {
      const payload = await readSseJsonRpcResponse(res, requestId)
      return payload as unknown as Record<string, unknown>
    }

    const raw = await res.text()
    if (!raw.trim()) {
      throw new Error(`upstream ${step} returned an empty body`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error(`upstream ${step} returned non-JSON body`)
    }
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error(`upstream ${step} returned non-object JSON`)
    }
    return parsed as Record<string, unknown>
  }

  private async readOptionalJsonRpcError(res: Response): Promise<string | undefined> {
    const contentType = res.headers.get('content-type') ?? ''
    if (contentType.includes('text/event-stream')) {
      if (!res.body) return undefined
      const scan = await this.scanSseEvents(res.body, (payload) =>
        extractJsonRpcErrorMessage(payload),
      )
      switch (scan.outcome) {
        case 'found':
          return scan.value
        case 'closed':
          return undefined
        case 'timed-out':
          throw new Error(
            `upstream notifications/initialized SSE response timed out after ${String(this.requestTimeoutMs)}ms`,
          )
        case 'too-large':
          throw new Error(
            `upstream notifications/initialized SSE response exceeded ${String(MAX_SSE_SCAN_BYTES)} bytes`,
          )
      }
    }

    const raw = await res.text()
    if (!raw.trim()) return undefined
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return undefined
    }
    if (typeof parsed !== 'object' || parsed === null) return undefined
    return extractJsonRpcErrorMessage(parsed as Record<string, unknown>)
  }

  /**
   * Read an SSE POST response body under an explicit read deadline and byte
   * cap, returning the first `message` payload `select` accepts. The
   * fetch-level `AbortSignal.timeout` would eventually abort a stalled body
   * read; these bounds are the belt to its braces.
   */
  private async scanSseEvents<T>(
    body: ReadableStream<Uint8Array>,
    select: (payload: Record<string, unknown>) => T | undefined,
  ): Promise<SseScanResult<T>> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let state = { event: '', data: '', remainder: '' }
    let found: T | undefined
    let scannedBytes = 0
    const deadline = Date.now() + this.requestTimeoutMs

    const onEvent = (event: string, data: string): void => {
      if (found !== undefined) return
      if (event && event !== 'message') return
      let parsed: unknown
      try {
        parsed = JSON.parse(data)
      } catch {
        return
      }
      if (typeof parsed !== 'object' || parsed === null) return
      found = select(parsed as Record<string, unknown>)
    }

    for (;;) {
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) {
        await reader.cancel().catch(() => undefined)
        return { outcome: 'timed-out' }
      }
      let chunk: SseReadChunk
      try {
        chunk = await readSseChunkWithTimeout(reader, remainingMs)
      } catch {
        await reader.cancel().catch(() => undefined)
        return { outcome: 'timed-out' }
      }
      const { done, value } = chunk
      if (value !== undefined) {
        scannedBytes += value.byteLength
        if (scannedBytes > MAX_SSE_SCAN_BYTES) {
          await reader.cancel().catch(() => undefined)
          return { outcome: 'too-large' }
        }
        state = parseSseChunk(decoder.decode(value, { stream: true }), state, onEvent)
        if (found !== undefined) {
          await reader.cancel().catch(() => undefined)
          return { outcome: 'found', value: found }
        }
      }
      if (done) {
        const tail = decoder.decode()
        if (tail) {
          state = parseSseChunk(tail, state, onEvent)
        }
        return found !== undefined ? { outcome: 'found', value: found } : { outcome: 'closed' }
      }
    }
  }
}

async function readSseChunkWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<SseReadChunk> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race<unknown>([
      reader.read() as Promise<unknown>,
      new Promise<unknown>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`sse read timed out after ${String(timeoutMs)}ms`))
        }, timeoutMs)
      }),
    ])
    if (!isSseReadChunk(result)) {
      throw new Error('upstream SSE response returned invalid chunk')
    }
    return result
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
  }
}

interface SseReadChunk {
  readonly done: boolean
  readonly value: Uint8Array | undefined
}

function isSseReadChunk(value: unknown): value is SseReadChunk {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { done?: unknown; value?: unknown }
  if (typeof candidate.done !== 'boolean') return false
  if (candidate.value === undefined) return true
  return candidate.value instanceof Uint8Array
}

/** Statuses whose body the spec's backward-compat rules let us classify. */
function isClassifiableProbeStatus(status: number): boolean {
  if (status >= 200 && status < 300) return true
  return status === 400 || status === 404 || status === 405
}

function classifyEnvelopeShape(envelope: Record<string, unknown>): ProbeBody {
  if (envelope['error'] !== undefined) return { kind: 'error', envelope }
  if (envelope['result'] !== undefined) return { kind: 'result', envelope }
  return { kind: 'unparseable' }
}

function classifyProbeError(envelope: Record<string, unknown>): EraProbeOutcome {
  const error = envelope['error']
  const code =
    typeof error === 'object' && error !== null
      ? (error as Record<string, unknown>)['code']
      : undefined

  if (code === MCP_UNSUPPORTED_PROTOCOL_VERSION_CODE) {
    // The wire shape a version-mismatched probe MUST produce: the server is
    // modern but speaks no version Helio does. Try the legacy handshake once.
    const data = (error as Record<string, unknown>)['data']
    return {
      era: 'legacy',
      unsupportedModernVersions: readStringArray(
        typeof data === 'object' && data !== null
          ? (data as Record<string, unknown>)['supported']
          : undefined,
      ),
    }
  }

  if (code === MCP_HEADER_MISMATCH_CODE || code === MCP_MISSING_CLIENT_CAPABILITY_CODE) {
    // A modern server that refused our probe: Helio's conformance bug or the
    // server's policy. Falling back to initialize would only mask it.
    throw new Error(
      `upstream refused Helio's server/discover probe with modern MCP error ` +
        `${String(code)}: ${extractJsonRpcErrorMessage(envelope) ?? 'unknown JSON-RPC error'} ` +
        `(the upstream is a modern MCP server, so Helio does not fall back to initialize)`,
    )
  }

  // Any other JSON-RPC error, -32601 included: the server parsed and answered
  // a method every modern server MUST implement, so it is a legacy server.
  return { era: 'legacy' }
}

function classifyProbeResult(envelope: Record<string, unknown>): EraProbeOutcome {
  const result = envelope['result']
  if (typeof result !== 'object' || result === null) return { era: 'legacy' }
  const supportedVersions = (result as Record<string, unknown>)['supportedVersions']
  if (!Array.isArray(supportedVersions)) {
    // A JSON-RPC result without supportedVersions is not a DiscoverResult:
    // a misrouted or non-MCP endpoint. Let initialize settle it.
    return { era: 'legacy' }
  }
  const versions = readStringArray(supportedVersions)
  if (versions.includes(HELIO_MCP_MODERN_PROTOCOL_VERSION)) {
    // Capture the DiscoverResult fields the relay initialize synthesis
    // reuses. Absent fields stay absent — a fresh result without them must
    // not inherit a stale capture.
    const record = result as Record<string, unknown>
    const capabilities = record['capabilities']
    const instructions = record['instructions']
    return {
      era: 'modern',
      capabilities:
        typeof capabilities === 'object' && capabilities !== null && !Array.isArray(capabilities)
          ? (capabilities as Record<string, unknown>)
          : undefined,
      instructions: typeof instructions === 'string' ? instructions : undefined,
    }
  }
  // A modern server speaking none of Helio's versions: one initialize attempt
  // salvages the dual-era case, and its failure names both sides' versions.
  return { era: 'legacy', unsupportedModernVersions: versions }
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return (value as unknown[]).filter((entry): entry is string => typeof entry === 'string')
}

function extractJsonRpcErrorMessage(payload: Record<string, unknown>): string | undefined {
  const error = payload['error']
  if (typeof error === 'string') return error
  if (typeof error !== 'object' || error === null) return undefined
  const message = (error as Record<string, unknown>)['message']
  if (typeof message === 'string' && message.trim()) return message
  return 'unknown JSON-RPC error'
}

function extractNegotiatedProtocolVersion(payload: Record<string, unknown>): string {
  const result = payload['result']
  if (typeof result !== 'object' || result === null) {
    return HELIO_MCP_LEGACY_PROTOCOL_VERSION
  }
  const protocolVersion = (result as Record<string, unknown>)['protocolVersion']
  return typeof protocolVersion === 'string' && protocolVersion.trim()
    ? protocolVersion
    : HELIO_MCP_LEGACY_PROTOCOL_VERSION
}
