/**
 * Two-upstream end-to-end isolation and sharing suite (issue #296).
 *
 * Two REAL MCP servers — one legacy stateful (sessions + SSE framing), one
 * modern 2026-07-28-only — composed behind one `createMultiApp` on a real
 * socket, governed per door exactly the way `cli.ts` governs: production
 * `createForwarderFromConfig` per entry, one `GovernedForwarder` per door,
 * and ONE shared governance object (audit, evidence, approval, limiters,
 * budgets, session) mirroring the cli's field set. The suite proves the
 * multi-upstream contract's isolation claims (what must never cross doors),
 * its deliberate-sharing claims (what must pool), and its identity claims.
 *
 * Every composition's policy carries a deny rule and at least one assertion
 * that only passes THROUGH governance — a raw transport forwarder mounted by
 * mistake fails those loudly instead of silently bypassing policy.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import { createMultiApp } from '../server.js'
import { createForwarderFromConfig } from '../cli-forwarder.js'
import { GovernedForwarder } from '../policy/governed-forwarder.js'
import type { GovernedForwarderOptions } from '../policy/governed-forwarder.js'
import { compilePolicies, RateLimiter, SpendLimiter } from '../policy/index.js'
import { compileSessionIdentity } from '../mcp/session-resolver.js'
import { AuditStore, AuditWriter, buildHeaderMismatchAuditRecord } from '../audit/index.js'
import { EvidenceStore } from '../evidence/index.js'
import { ApprovalQueue, ApprovalRouter, createChannels } from '../approval/index.js'
import { BudgetEngine, compileBudgets } from '../budget/index.js'
import { parseDuration } from '../config/schema.js'
import { isNamedConfig } from '../config/index.js'
import type { HelioConfig, PoliciesConfig } from '../config/index.js'
import type { McpForwarder } from '../mcp/types.js'
import {
  startSessionEnforcingHttpMcpServer,
  startModernOnlyHttpMcpServer,
} from './helpers/mcp-test-server.js'
import type { ModernOnlyMcpServer } from './helpers/mcp-test-server.js'
import { startOnDynamicPort, makeNamedConfig, sendMcpRequest } from './helpers/test-utils.js'
import type { ManagedServer } from './helpers/test-utils.js'

// ---------------------------------------------------------------------------
// File-scope fixtures — one legacy door, one modern door, shared by every
// composition. Anything that mutates fixture state (setTools) must restore
// it: owning a composition does not own these servers.
// ---------------------------------------------------------------------------

let alphaFixture: { port: number; close: () => Promise<void> }
let betaFixture: ModernOnlyMcpServer

beforeAll(async () => {
  alphaFixture = await startSessionEnforcingHttpMcpServer()
  betaFixture = await startModernOnlyHttpMcpServer()
})

afterAll(async () => {
  await alphaFixture.close()
  await betaFixture.close()
})

// ---------------------------------------------------------------------------
// Composition harness
// ---------------------------------------------------------------------------

type DoorName = 'alpha' | 'beta'

interface TwoDoorComposition {
  proxy: ManagedServer
  config: HelioConfig
  governed: Record<DoorName, GovernedForwarder>
  auditStore: AuditStore
  auditWriter: AuditWriter
  evidenceStore: EvidenceStore
  rateLimiter: RateLimiter
  spendLimiter: SpendLimiter
  budgetEngine: BudgetEngine
  mcpUrl: (door: DoorName) => string
  sseUrl: (door: DoorName) => string
  close: () => Promise<void>
}

/**
 * Compose the two file-scope fixtures behind one createMultiApp on a real
 * socket, governed the way cli.ts governs a named config: phase 1 connects
 * every upstream (production createForwarderFromConfig per entry, with the
 * entry name), then the shared services are built once and every door's
 * GovernedForwarder composes them via ONE governance object carrying the
 * cli.ts field set: environment, auditWriter, evidenceStore, approvalRouter,
 * rateLimiter, spendLimiter, budgetEngine, session.
 */
async function composeTwoDoors(options: {
  policies: PoliciesConfig
  session?: Partial<HelioConfig['session']>
  budgets?: HelioConfig['budgets']
  environment?: string
  /** Await a direct annotation-cache prime per door (no prime-loop windows). */
  prime?: boolean
  /** Per-door /sse concurrent-session cap (the issue #296 I4 seam). */
  sse?: { maxConcurrentSessions?: number }
}): Promise<TwoDoorComposition> {
  const config = makeNamedConfig(['alpha', 'beta'], {
    urls: {
      alpha: `http://127.0.0.1:${String(alphaFixture.port)}/mcp`,
      beta: `http://127.0.0.1:${String(betaFixture.port)}/mcp`,
    },
    policies: options.policies,
    session: options.session,
    budgets: options.budgets,
    environment: options.environment,
  })
  if (!isNamedConfig(config)) throw new Error('unreachable: makeNamedConfig builds named configs')

  // Phase 1 (cli.ts order): connect every upstream before any shared service.
  const doors: Array<{ name: string; forwarder: McpForwarder; close?: () => Promise<void> }> = []
  for (const entry of config.upstreams) {
    const built = await createForwarderFromConfig({ upstream: entry }, entry.name)
    doors.push({ name: entry.name, forwarder: built.forwarder, close: built.close })
  }

  const auditStore = new AuditStore({
    path: ':memory:',
    retention: '90d',
    includeResponses: true,
    cleanupIntervalMs: 0,
  })
  const auditWriter = new AuditWriter({ store: auditStore, flushIntervalMs: 0 })
  const evidenceStore = new EvidenceStore({ cleanupIntervalMs: 0 })
  const approvalQueue = new ApprovalQueue({ cleanupIntervalMs: 0 })
  const approvalRouter = new ApprovalRouter({
    defaultTimeoutMs: parseDuration(config.approval.timeout),
    defaultOnTimeout: config.approval.default_on_timeout,
    channels: createChannels(config.approval.channels),
    queue: approvalQueue,
  })
  const rateLimiter = new RateLimiter({ cleanupIntervalMs: 0 })
  const spendLimiter = new SpendLimiter({ cleanupIntervalMs: 0 })
  const budgetEngine = new BudgetEngine({
    budgets: compileBudgets(config.budgets),
    cleanupIntervalMs: 0,
  })
  const session = compileSessionIdentity(config.session)
  const { policy } = compilePolicies(config.policies)

  // The one governance object every door shares — cli.ts field for field.
  const governance: GovernedForwarderOptions = {
    environment: config.environment,
    auditWriter,
    evidenceStore,
    approvalRouter,
    rateLimiter,
    spendLimiter,
    budgetEngine,
    session,
  }

  const governed = {} as Record<DoorName, GovernedForwarder>
  const forwarders: Record<string, GovernedForwarder> = {}
  for (const door of doors) {
    const governedForwarder = new GovernedForwarder(door.forwarder, policy, {
      ...governance,
      upstreamName: door.name,
    })
    governed[door.name as DoorName] = governedForwarder
    forwarders[door.name] = governedForwarder
  }

  if (options.prime) {
    for (const door of ['alpha', 'beta'] as const) {
      const primed = await governed[door].primeAnnotationCache()
      if (!primed.success) throw new Error(`annotation prime failed for ${door}`)
    }
  }

  const app = createMultiApp(config, forwarders, {
    onHeaderMismatch: (rejection, upstreamName) => {
      auditWriter.pushImmediate(
        buildHeaderMismatchAuditRecord(rejection, config.environment, upstreamName),
      )
    },
    sse: options.sse,
  })
  const proxy = startOnDynamicPort(app)
  const base = `http://127.0.0.1:${String(proxy.port)}`

  return {
    proxy,
    config,
    governed,
    auditStore,
    auditWriter,
    evidenceStore,
    rateLimiter,
    spendLimiter,
    budgetEngine,
    mcpUrl: (door) => `${base}/mcp/${door}`,
    sseUrl: (door) => `${base}/sse/${door}`,
    close: async () => {
      await proxy.close()
      for (const door of doors) {
        await door.close?.()
      }
      approvalRouter.close()
      approvalQueue.close()
      rateLimiter.close()
      spendLimiter.close()
      budgetEngine.close()
      evidenceStore.close()
      auditWriter.close() // also closes auditStore
    },
  }
}

/**
 * Run the legacy door's downstream handshake through the proxy: initialize,
 * capture the fixture-minted wire session, send notifications/initialized.
 * Returns the wire session id for subsequent session'd calls.
 */
async function initializeLegacyDoor(
  url: string,
  options?: { helioSessionId?: string },
): Promise<string> {
  const init = await sendMcpRequest(
    url,
    'initialize',
    {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'two-upstream-suite', version: '1' },
    },
    'init-1',
    options,
  )
  expect(init.status).toBe(200)
  const wireSession = init.headers.get('mcp-session-id')
  if (!wireSession) throw new Error('legacy door minted no wire session')
  await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'mcp-session-id': wireSession },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  })
  return wireSession
}

// ---------------------------------------------------------------------------
// Composition skeleton — the two doors work end-to-end, and each mount
// serves its GOVERNED forwarder (the deny probe never reaches an upstream).
// ---------------------------------------------------------------------------

describe('two-door composition', () => {
  let comp: TwoDoorComposition

  beforeAll(async () => {
    comp = await composeTwoDoors({
      policies: {
        default: 'allow',
        dry_run: false,
        tool_revalidation: { enabled: false },
        rules: [{ name: 'denied-probe', match: { tool: 'denied_probe' }, action: 'deny' }],
      } as PoliciesConfig,
    })
  })

  afterAll(async () => {
    await comp.close()
  })

  it('serves the legacy door end-to-end: handshake relayed, minted session honored', async () => {
    const wireSession = await initializeLegacyDoor(comp.mcpUrl('alpha'))
    const call = await sendMcpRequest(
      comp.mcpUrl('alpha'),
      'tools/call',
      { name: 'get_weather', arguments: { city: 'Berlin' } },
      2,
      { sessionId: wireSession },
    )
    expect(call.status).toBe(200)
    expect(call.body['error']).toBeUndefined()
    const result = call.body['result'] as { content: { type: string; text: string }[] }
    expect(result.content[0]?.text).toBe('Sunny, 22°C in Berlin')
  })

  it('serves the modern door end-to-end: sessionless governed call succeeds', async () => {
    const call = await sendMcpRequest(
      comp.mcpUrl('beta'),
      'tools/call',
      { name: 'get_status', arguments: {} },
      3,
      { helioSessionId: 'skeleton-s1' },
    )
    expect(call.status).toBe(200)
    expect(call.body['error']).toBeUndefined()
    const result = call.body['result'] as { content: { type: string; text: string }[] }
    expect(result.content[0]?.text).toContain('get_status executed')
  })

  it('each mount serves its GOVERNED forwarder: the deny probe blocks and never reaches an upstream', async () => {
    const betaSeenBefore = betaFixture.receivedRequests.length
    for (const door of ['alpha', 'beta'] as const) {
      const res = await sendMcpRequest(
        comp.mcpUrl(door),
        'tools/call',
        { name: 'denied_probe', arguments: {} },
        `deny-${door}`,
        { helioSessionId: 'skeleton-deny' },
      )
      const error = res.body['error'] as { code: number; data: Record<string, unknown> }
      expect(error).toBeDefined()
      expect(error.code).toBe(-32001)
      expect(error.data['blocked']).toBe(true)
      expect(error.data['reason']).toBe('policy_denied')
      expect(error.data['rule']).toBe('denied-probe')
    }
    // Neither denied call was forwarded: the modern fixture saw no new
    // tools/call (the legacy fixture has no capture affordance; its deny
    // envelope above already proves the governed path).
    const newBetaCalls = betaFixture.receivedRequests
      .slice(betaSeenBefore)
      .filter((req) => req.method === 'tools/call')
    expect(newBetaCalls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Isolation family (issue #296 bullets I1, I2, I3, I5; I4 has its own
// describe below once the cap seam exists). Each assertion owns its
// composition: annotation caches, drift baselines, era caches, and limit
// counters all live per composition, so a fresh one is the cheapest way to
// guarantee no cross-test contamination.
// ---------------------------------------------------------------------------

describe('isolation: era caches classify independently (I1)', () => {
  let comp: TwoDoorComposition
  let errorSpy: MockInstance

  beforeAll(async () => {
    // Installed before the composition so both era-detected lines land in it.
    errorSpy = vi.spyOn(console, 'error')
    comp = await composeTwoDoors({
      policies: {
        default: 'allow',
        dry_run: false,
        tool_revalidation: { enabled: false },
        rules: [{ name: 'denied-probe', match: { tool: 'denied_probe' }, action: 'deny' }],
      } as PoliciesConfig,
    })
  })

  afterAll(async () => {
    errorSpy.mockRestore()
    await comp.close()
  })

  it('classifies one legacy and one modern door in the same process, beta first', async () => {
    const betaSeenBefore = betaFixture.receivedRequests.length

    // The order is the counterfactual's: beta's first relay (its era probe)
    // runs BEFORE alpha's handshake. A shared era cache would classify alpha
    // modern, strip its session, and the session-enforcing fixture would
    // answer the relayed call with HTTP 400 -32000 instead of 200.
    const betaCall = await sendMcpRequest(
      comp.mcpUrl('beta'),
      'tools/call',
      { name: 'get_status', arguments: {} },
      'era-beta-1',
      { helioSessionId: 'era-s1' },
    )
    expect(betaCall.status).toBe(200)
    expect(betaCall.body['error']).toBeUndefined()

    const wireSession = await initializeLegacyDoor(comp.mcpUrl('alpha'))
    const alphaCall = await sendMcpRequest(
      comp.mcpUrl('alpha'),
      'tools/call',
      { name: 'get_weather', arguments: { city: 'Berlin' } },
      'era-alpha-1',
      { sessionId: wireSession },
    )
    expect(alphaCall.status).toBe(200)
    expect(alphaCall.body['error']).toBeUndefined()

    // Every send to the modern door was sessionless and modern-versioned —
    // the behavioral half of beta's classification.
    const betaSeen = betaFixture.receivedRequests.slice(betaSeenBefore)
    expect(betaSeen.length).toBeGreaterThan(0)
    for (const received of betaSeen) {
      expect(received.headers['mcp-session-id']).toBeUndefined()
      expect(received.headers['mcp-protocol-version']).toBe('2026-07-28')
    }

    // Both door-tagged era lines appeared, in ONE process, simultaneously.
    const eraLines = errorSpy.mock.calls.map((args: unknown[]) => args.join(' '))
    expect(eraLines).toContain(
      '[helio][beta] Upstream MCP era detected: modern (2026-07-28, via server/discover)',
    )
    expect(eraLines).toContain(
      '[helio][alpha] Upstream MCP era detected: legacy (initialize handshake)',
    )
  })

  it('the composition is governed: the deny probe blocks on the alpha door', async () => {
    const res = await sendMcpRequest(
      comp.mcpUrl('alpha'),
      'tools/call',
      { name: 'denied_probe', arguments: {} },
      'era-deny',
      { helioSessionId: 'era-s1' },
    )
    const error = res.body['error'] as { code: number; data: Record<string, unknown> }
    expect(error.code).toBe(-32001)
    expect(error.data['rule']).toBe('denied-probe')
  })
})

// The modern fixture's startup tool set, verbatim (mcp-test-server.ts) — any
// test that calls setTools on the SHARED file-scope fixture restores this
// afterward, or a later family loses get_status.
const ORIGINAL_BETA_TOOLS: Record<string, unknown>[] = [
  {
    name: 'get_status',
    description: 'Report the current server status',
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: 'Hello, 世界',
    description: 'Report status with a non-ASCII display name',
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
]

/** A same-named twin of alpha's get_weather, advertised by beta via setTools. */
function betaWeatherTwin(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    name: 'get_weather',
    description: 'Get the current weather for a city (beta twin)',
    annotations: { readOnlyHint: true, destructiveHint: false },
    ...overrides,
  }
}

describe('isolation: annotation caches match per door (I2, annotation half)', () => {
  let comp: TwoDoorComposition

  beforeAll(async () => {
    // Beta's twin is genuinely destructive by ITS OWN advertised annotations;
    // alpha's get_weather is annotated {readOnlyHint: true, destructiveHint:
    // false} by the SDK fixture. Set before compose so the primed caches see
    // each door's real definitions. This composition never drifts.
    betaFixture.setTools([
      ...ORIGINAL_BETA_TOOLS,
      betaWeatherTwin({ annotations: { readOnlyHint: false, destructiveHint: true } }),
    ])
    comp = await composeTwoDoors({
      policies: {
        default: 'allow',
        dry_run: false,
        tool_revalidation: { enabled: false },
        rules: [
          {
            name: 'block-destructive',
            match: { annotations: { destructiveHint: true } },
            action: 'deny',
          },
        ],
      } as PoliciesConfig,
      prime: true,
    })
  })

  afterAll(async () => {
    betaFixture.setTools(ORIGINAL_BETA_TOOLS)
    await comp.close()
  })

  it("denies beta's destructive twin while alpha's read-only twin passes", async () => {
    const wireSession = await initializeLegacyDoor(comp.mcpUrl('alpha'))
    const alphaCall = await sendMcpRequest(
      comp.mcpUrl('alpha'),
      'tools/call',
      { name: 'get_weather', arguments: { city: 'Berlin' } },
      'i2a-alpha',
      { sessionId: wireSession },
    )
    expect(alphaCall.body['error']).toBeUndefined()
    const alphaResult = alphaCall.body['result'] as { content: { text: string }[] }
    expect(alphaResult.content[0]?.text).toBe('Sunny, 22°C in Berlin')

    // The SAME tool name on beta is denied — by beta's own primed cache, not
    // alpha's. A shared cache would give both doors one verdict.
    const betaCall = await sendMcpRequest(
      comp.mcpUrl('beta'),
      'tools/call',
      { name: 'get_weather', arguments: { city: 'Berlin' } },
      'i2a-beta',
      { helioSessionId: 'i2a-s1' },
    )
    const error = betaCall.body['error'] as { code: number; data: Record<string, unknown> }
    expect(error).toBeDefined()
    expect(error.code).toBe(-32001)
    expect(error.data['reason']).toBe('policy_denied')
    expect(error.data['rule']).toBe('block-destructive')
  })
})

describe('isolation: drift baselines gate per door (I2, drift half)', () => {
  let comp: TwoDoorComposition

  beforeAll(async () => {
    // A benign twin first — the pre-drift baseline. NO annotation rule in
    // this policy (the drift override discards matchedRule, so an annotation
    // assertion could never be read off a drifted cache); this half owns
    // revalidation deliberately and leaves tool_revalidation at its default.
    betaFixture.setTools([...ORIGINAL_BETA_TOOLS, betaWeatherTwin()])
    comp = await composeTwoDoors({
      policies: {
        default: 'allow',
        dry_run: false,
        on_tool_drift: 'block',
        rules: [{ name: 'denied-probe', match: { tool: 'denied_probe' }, action: 'deny' }],
      } as PoliciesConfig,
      prime: true,
    })
  })

  afterAll(async () => {
    betaFixture.setTools(ORIGINAL_BETA_TOOLS)
    await comp.close()
  })

  it('a drifted tool on beta gates beta only; alpha keeps serving', async () => {
    const wireSession = await initializeLegacyDoor(comp.mcpUrl('alpha'))

    // Pre-drift baseline: BOTH doors serve get_weather (the red step this
    // drift lever flips — valid because this policy has no annotation rule).
    const alphaPre = await sendMcpRequest(
      comp.mcpUrl('alpha'),
      'tools/call',
      { name: 'get_weather', arguments: { city: 'Berlin' } },
      'i2b-alpha-pre',
      { sessionId: wireSession },
    )
    expect(alphaPre.body['error']).toBeUndefined()
    const betaPre = await sendMcpRequest(
      comp.mcpUrl('beta'),
      'tools/call',
      { name: 'get_weather', arguments: { city: 'Berlin' } },
      'i2b-beta-pre',
      { helioSessionId: 'i2b-s1' },
    )
    expect(betaPre.body['error']).toBeUndefined()

    // Drift beta's twin out from under its baseline and re-prime BETA only
    // (stand-in for the scheduled revalidation tick).
    betaFixture.setTools([
      ...ORIGINAL_BETA_TOOLS,
      betaWeatherTwin({ description: 'Get the current weather for a city (beta twin, v2)' }),
    ])
    const reprimed = await comp.governed.beta.primeAnnotationCache()
    expect(reprimed.success).toBe(true)

    // Beta gates on ITS drift...
    const betaPost = await sendMcpRequest(
      comp.mcpUrl('beta'),
      'tools/call',
      { name: 'get_weather', arguments: { city: 'Berlin' } },
      'i2b-beta-post',
      { helioSessionId: 'i2b-s1' },
    )
    const error = betaPost.body['error'] as {
      code: number
      message: string
      data: Record<string, unknown>
    }
    expect(error).toBeDefined()
    expect(error.code).toBe(-32001)
    expect(error.message).toBe('Tool definition drift: "get_weather" changed after baseline')
    expect(error.data['reason']).toBe('tool_definition_drift')

    // ...while alpha's same-named tool keeps serving from ITS baseline.
    const alphaPost = await sendMcpRequest(
      comp.mcpUrl('alpha'),
      'tools/call',
      { name: 'get_weather', arguments: { city: 'Berlin' } },
      'i2b-alpha-post',
      { sessionId: wireSession },
    )
    expect(alphaPost.body['error']).toBeUndefined()

    // The drift event and the drift deny are both attributed to beta.
    comp.auditWriter.flush()
    const betaRecords = comp.auditStore.list({ upstream: 'beta' }).records
    expect(betaRecords.some((r) => r.record_kind === 'drift_event')).toBe(true)
    expect(
      betaRecords.some(
        (r) => r.record_kind === 'tool_call' && r.block_reason === 'tool_definition_drift',
      ),
    ).toBe(true)
    const alphaRecords = comp.auditStore.list({ upstream: 'alpha' }).records
    expect(alphaRecords.some((r) => r.record_kind === 'drift_event')).toBe(false)
    expect(alphaRecords.some((r) => r.block_reason === 'tool_definition_drift')).toBe(false)
  })
})

describe('isolation: tool limit buckets count per door (I3)', () => {
  let comp: TwoDoorComposition

  beforeAll(async () => {
    // An undrifted composition: same-named get_weather on both doors, one
    // rate_limit rule keyed on the tool.
    betaFixture.setTools([...ORIGINAL_BETA_TOOLS, betaWeatherTwin()])
    comp = await composeTwoDoors({
      policies: {
        default: 'allow',
        dry_run: false,
        tool_revalidation: { enabled: false },
        rules: [
          {
            name: 'limit-weather',
            match: { tool: 'get_weather' },
            action: 'rate_limit',
            limits: { max_calls: 1, window: '60s' },
          },
        ],
      } as PoliciesConfig,
    })
  })

  afterAll(async () => {
    betaFixture.setTools(ORIGINAL_BETA_TOOLS)
    await comp.close()
  })

  it("exhausting alpha's get_weather bucket leaves beta's untouched", async () => {
    const wireSession = await initializeLegacyDoor(comp.mcpUrl('alpha'))

    const first = await sendMcpRequest(
      comp.mcpUrl('alpha'),
      'tools/call',
      { name: 'get_weather', arguments: { city: 'Berlin' } },
      'i3-alpha-1',
      { sessionId: wireSession },
    )
    expect(first.body['error']).toBeUndefined()

    // The second alpha call trips ALPHA's bucket — the deny message embeds
    // the full partitioned key, the cheapest wire-visible observable.
    const second = await sendMcpRequest(
      comp.mcpUrl('alpha'),
      'tools/call',
      { name: 'get_weather', arguments: { city: 'Berlin' } },
      'i3-alpha-2',
      { sessionId: wireSession },
    )
    const error = second.body['error'] as { code: number; message: string }
    expect(error).toBeDefined()
    expect(error.code).toBe(-32001)
    expect(error.message).toBe('Rate limit exceeded for upstream:alpha:tool:get_weather:rule:0')

    // Beta's same-named bucket has its own count: its first call passes.
    const betaCall = await sendMcpRequest(
      comp.mcpUrl('beta'),
      'tools/call',
      { name: 'get_weather', arguments: { city: 'Berlin' } },
      'i3-beta-1',
      { helioSessionId: 'i3-s1' },
    )
    expect(betaCall.body['error']).toBeUndefined()
  })
})

describe('isolation: per-door /sse session caps (I4)', () => {
  let comp: TwoDoorComposition
  let errorSpy: MockInstance
  const streams: AbortController[] = []

  beforeAll(async () => {
    errorSpy = vi.spyOn(console, 'error')
    comp = await composeTwoDoors({
      policies: {
        default: 'allow',
        dry_run: false,
        tool_revalidation: { enabled: false },
        rules: [{ name: 'denied-probe', match: { tool: 'denied_probe' }, action: 'deny' }],
      } as PoliciesConfig,
      sse: { maxConcurrentSessions: 1 },
    })
  })

  afterAll(async () => {
    errorSpy.mockRestore()
    // Abort held streams FIRST or the proxy close hangs on live connections.
    for (const ac of streams) ac.abort()
    await comp.close()
  })

  /**
   * Open an /sse stream and HOLD it: cap occupancy is live map size (a
   * disconnect deletes the entry), so the occupant must stay connected.
   * Reads exactly the first chunk (the endpoint event) to guarantee the
   * session registered server-side before the caller proceeds.
   */
  async function openHeldSseStream(url: string): Promise<Response> {
    const ac = new AbortController()
    streams.push(ac)
    const res = await fetch(url, { signal: ac.signal })
    if (res.status === 200 && res.body) {
      const reader = res.body.getReader()
      await reader.read()
      reader.releaseLock()
    }
    return res
  }

  it('door A at cap refuses its second stream; door B still admits', async () => {
    const first = await openHeldSseStream(comp.sseUrl('alpha'))
    expect(first.status).toBe(200)
    expect(first.headers.get('content-type')).toBe('text/event-stream')

    const second = await openHeldSseStream(comp.sseUrl('alpha'))
    expect(second.status).toBe(503)
    expect(await second.json()).toEqual({ error: 'session capacity reached' })

    // The refusal line names the door that refused.
    const lines = errorSpy.mock.calls.map((args: unknown[]) => args.join(' '))
    expect(lines).toContain(
      '[helio] /sse/alpha at session cap (1); refusing new streams (1 refusals so far).',
    )

    // Door B's map is its own: its first stream admits while door A is full.
    const betaStream = await openHeldSseStream(comp.sseUrl('beta'))
    expect(betaStream.status).toBe(200)
    expect(betaStream.headers.get('content-type')).toBe('text/event-stream')
  })

  it('the composition is governed: the deny probe blocks through the mcp mount', async () => {
    const res = await sendMcpRequest(
      comp.mcpUrl('beta'),
      'tools/call',
      { name: 'denied_probe', arguments: {} },
      'i4-deny',
      { helioSessionId: 'i4-s1' },
    )
    const error = res.body['error'] as { code: number; data: Record<string, unknown> }
    expect(error.code).toBe(-32001)
    expect(error.data['rule']).toBe('denied-probe')
  })
})

describe('isolation: audit attribution follows routing (I5)', () => {
  let comp: TwoDoorComposition

  beforeAll(async () => {
    comp = await composeTwoDoors({
      policies: {
        default: 'allow',
        dry_run: false,
        tool_revalidation: { enabled: false },
        rules: [{ name: 'denied-probe', match: { tool: 'denied_probe' }, action: 'deny' }],
      } as PoliciesConfig,
    })
  })

  afterAll(async () => {
    await comp.close()
  })

  it('attributes every record to the door driven, under adversarial identity inputs', async () => {
    const wireSession = await initializeLegacyDoor(comp.mcpUrl('alpha'))
    // Adversarial drive: every call carries a crafted identity header and
    // client-authored _meta; beta also gets a LYING legacy wire session.
    // None of it may influence the upstream column — only routing does.
    const adversarialMeta = {
      'io.modelcontextprotocol/clientInfo': { name: 'liar', version: '9' },
    }

    const alphaCall = await sendMcpRequest(
      comp.mcpUrl('alpha'),
      'tools/call',
      { name: 'get_weather', arguments: { city: 'Berlin' }, _meta: adversarialMeta },
      'i5-alpha-1',
      { sessionId: wireSession, helioSessionId: 'i5-liar' },
    )
    expect(alphaCall.body['error']).toBeUndefined()

    const alphaDeny = await sendMcpRequest(
      comp.mcpUrl('alpha'),
      'tools/call',
      { name: 'denied_probe', arguments: {}, _meta: adversarialMeta },
      'i5-alpha-2',
      { helioSessionId: 'i5-liar' },
    )
    const denyError = alphaDeny.body['error'] as { code: number }
    expect(denyError.code).toBe(-32001)

    for (const id of ['i5-beta-1', 'i5-beta-2']) {
      const betaCall = await sendMcpRequest(
        comp.mcpUrl('beta'),
        'tools/call',
        { name: 'get_status', arguments: {}, _meta: adversarialMeta },
        id,
        { sessionId: 'fake-wire-session-lie', helioSessionId: 'i5-liar' },
      )
      expect(betaCall.body['error']).toBeUndefined()
    }

    comp.auditWriter.flush()
    const alphaRecords = comp.auditStore.list({ upstream: 'alpha' }).records
    const betaRecords = comp.auditStore.list({ upstream: 'beta' }).records
    expect(alphaRecords.map((r) => r.tool_name).sort()).toEqual(['denied_probe', 'get_weather'])
    expect(betaRecords.map((r) => r.tool_name)).toEqual(['get_status', 'get_status'])
  })

  it('a null-upstream record matches neither door filter (exclusion arm)', () => {
    // A synthetic upstream: null record makes the exclusion assertion
    // non-vacuous — without one in the store it would assert nothing.
    comp.auditWriter.push({
      timestamp: new Date().toISOString(),
      session_id: null,
      session_source: null,
      agent_id: null,
      environment: null,
      tool_name: 'synthetic_null_probe',
      tool_input: {},
      policy_decision: 'allow',
      block_reason: null,
      matched_rule: null,
      matched_rule_index: null,
      evidence_chain: null,
      approval_status: null,
      approved_by: null,
      upstream_response: null,
      upstream_error: null,
      upstream_http_status: null,
      upstream_latency_ms: null,
      total_duration_ms: 0,
      approval_wait_ms: 0,
      proxy_compute_ms: 0,
      flagged_destructive: false,
      dry_run: false,
      record_kind: 'tool_call',
      origin: 'mcp',
      metadata: null,
      protocol_version: null,
      upstream: null,
    })
    comp.auditWriter.flush()

    const all = comp.auditStore.list({}).records
    expect(all.some((r) => r.tool_name === 'synthetic_null_probe')).toBe(true)
    for (const door of ['alpha', 'beta'] as const) {
      const filtered = comp.auditStore.list({ upstream: door }).records
      expect(filtered.some((r) => r.tool_name === 'synthetic_null_probe')).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// Sharing family (issue #296 bullets S1, S2, S3): what must POOL across
// doors. Each claim runs beside its permanent negative control — the
// deliberately scoped variant whose non-pooling is the config-lever red.
// ---------------------------------------------------------------------------

describe('sharing: un-scoped session limits pool across doors (S1)', () => {
  let pooled: TwoDoorComposition
  let scoped: TwoDoorComposition

  const sessionLimitRule = (upstreams?: string[]): Record<string, unknown> => ({
    name: 'pool-session-calls',
    match: { tool: 'get_*', ...(upstreams ? { upstreams } : {}) },
    action: 'rate_limit',
    limits: { max_calls: 2, window: '60s', key: 'session' },
  })

  beforeAll(async () => {
    pooled = await composeTwoDoors({
      policies: {
        default: 'allow',
        dry_run: false,
        tool_revalidation: { enabled: false },
        rules: [sessionLimitRule()],
      } as PoliciesConfig,
    })
    scoped = await composeTwoDoors({
      policies: {
        default: 'allow',
        dry_run: false,
        tool_revalidation: { enabled: false },
        rules: [sessionLimitRule(['alpha'])],
      } as PoliciesConfig,
    })
  })

  afterAll(async () => {
    await pooled.close()
    await scoped.close()
  })

  it("one session's calls pool across both doors", async () => {
    const wireSession = await initializeLegacyDoor(pooled.mcpUrl('alpha'))
    const alpha1 = await sendMcpRequest(
      pooled.mcpUrl('alpha'),
      'tools/call',
      { name: 'get_weather', arguments: { city: 'Berlin' } },
      's1-a1',
      { sessionId: wireSession, helioSessionId: 's1-pool' },
    )
    expect(alpha1.body['error']).toBeUndefined()
    const beta1 = await sendMcpRequest(
      pooled.mcpUrl('beta'),
      'tools/call',
      { name: 'get_status', arguments: {} },
      's1-b1',
      { helioSessionId: 's1-pool' },
    )
    expect(beta1.body['error']).toBeUndefined()

    // The third call — back on ALPHA, which has only one call of its own —
    // denies: beta's call fed the SAME session bucket. The un-prefixed key
    // in the message is the design: session identity is proxy-owned.
    const alpha2 = await sendMcpRequest(
      pooled.mcpUrl('alpha'),
      'tools/call',
      { name: 'get_weather', arguments: { city: 'Berlin' } },
      's1-a2',
      { sessionId: wireSession, helioSessionId: 's1-pool' },
    )
    const error = alpha2.body['error'] as { code: number; message: string }
    expect(error).toBeDefined()
    expect(error.code).toBe(-32001)
    expect(error.message).toBe('Rate limit exceeded for session:s1-pool:rule:0')
  })

  it('negative control: the alpha-scoped rule never pools beta calls', async () => {
    const wireSession = await initializeLegacyDoor(scoped.mcpUrl('alpha'))
    const drive = async (door: DoorName, id: string) =>
      sendMcpRequest(
        scoped.mcpUrl(door),
        'tools/call',
        door === 'alpha'
          ? { name: 'get_weather', arguments: { city: 'Berlin' } }
          : { name: 'get_status', arguments: {} },
        id,
        door === 'alpha'
          ? { sessionId: wireSession, helioSessionId: 's1-scope' }
          : { helioSessionId: 's1-scope' },
      )

    // The exact sequence the pooled variant denies on: alpha, beta, alpha.
    expect((await drive('alpha', 's1s-a1')).body['error']).toBeUndefined()
    expect((await drive('beta', 's1s-b1')).body['error']).toBeUndefined()
    // Here the third call passes — beta's call never fed the scoped bucket.
    expect((await drive('alpha', 's1s-a2')).body['error']).toBeUndefined()
    // Beta keeps passing however often it calls...
    expect((await drive('beta', 's1s-b2')).body['error']).toBeUndefined()
    // ...and the scoped rule is no dead rule: alpha's own third call trips it.
    const alpha3 = await drive('alpha', 's1s-a3')
    const error = alpha3.body['error'] as { code: number; message: string }
    expect(error).toBeDefined()
    expect(error.message).toBe('Rate limit exceeded for session:s1-scope:rule:0')
  })
})

describe('sharing: one budget pot spans both doors (S2)', () => {
  let pooled: TwoDoorComposition
  let scoped: TwoDoorComposition

  const potBudget = (name: string, upstreams?: string[]): Record<string, unknown> => ({
    name,
    limit: 150,
    currency: 'USD',
    window: '24h',
    key: 'global',
    on_exceed: 'deny',
    contributors: [
      { match: { tool: 'create_payment', ...(upstreams ? { upstreams } : {}) }, field: '$.amount' },
    ],
  })

  const allowAllPolicies = {
    default: 'allow',
    dry_run: false,
    tool_revalidation: { enabled: false },
    rules: [],
  } as unknown as PoliciesConfig

  beforeAll(async () => {
    pooled = await composeTwoDoors({
      policies: allowAllPolicies,
      budgets: [potBudget('shared-pot')] as HelioConfig['budgets'],
    })
    scoped = await composeTwoDoors({
      policies: allowAllPolicies,
      budgets: [potBudget('scoped-pot', ['alpha'])] as HelioConfig['budgets'],
    })
  })

  afterAll(async () => {
    await pooled.close()
    await scoped.close()
  })

  const payment = { amount: 60, currency: 'USD' }

  it('charges from both doors drain one pot until it denies', async () => {
    const wireSession = await initializeLegacyDoor(pooled.mcpUrl('alpha'))
    const alpha1 = await sendMcpRequest(
      pooled.mcpUrl('alpha'),
      'tools/call',
      { name: 'create_payment', arguments: payment },
      's2-a1',
      { sessionId: wireSession, helioSessionId: 's2-1' },
    )
    expect(alpha1.body['error']).toBeUndefined()
    const beta1 = await sendMcpRequest(
      pooled.mcpUrl('beta'),
      'tools/call',
      { name: 'create_payment', arguments: payment },
      's2-b1',
      { helioSessionId: 's2-1' },
    )
    expect(beta1.body['error']).toBeUndefined()

    // Third charge on ALPHA (alpha alone would sit at 120 of 150): the deny
    // proves beta's 60 drained the same pot.
    const alpha2 = await sendMcpRequest(
      pooled.mcpUrl('alpha'),
      'tools/call',
      { name: 'create_payment', arguments: payment },
      's2-a2',
      { sessionId: wireSession, helioSessionId: 's2-1' },
    )
    const error = alpha2.body['error'] as { code: number; message: string }
    expect(error).toBeDefined()
    expect(error.code).toBe(-32001)
    expect(error.message).toBe('Budget exceeded: "shared-pot"')
  })

  it("negative control: an alpha-scoped contributor never charges beta's calls", async () => {
    const wireSession = await initializeLegacyDoor(scoped.mcpUrl('alpha'))
    const drive = async (door: DoorName, id: string) =>
      sendMcpRequest(
        scoped.mcpUrl(door),
        'tools/call',
        { name: 'create_payment', arguments: payment },
        id,
        door === 'alpha'
          ? { sessionId: wireSession, helioSessionId: 's2-2' }
          : { helioSessionId: 's2-2' },
      )
    const potSpent = (): number => {
      const state = scoped.budgetEngine.listStates().find((s) => s.name === 'scoped-pot')
      return state?.buckets.find((b) => b.bucket_key === 'budget:scoped-pot:global')?.spent ?? 0
    }

    expect((await drive('alpha', 's2s-a1')).body['error']).toBeUndefined()
    expect(potSpent()).toBe(60)
    // Beta's charge leaves the pot untouched...
    expect((await drive('beta', 's2s-b1')).body['error']).toBeUndefined()
    expect(potSpent()).toBe(60)
    // ...so the call the pooled pot denied passes here.
    expect((await drive('alpha', 's2s-a2')).body['error']).toBeUndefined()
    expect(potSpent()).toBe(120)
  })
})

describe('sharing: a cross-door requires dependency satisfies (S3)', () => {
  let comp: TwoDoorComposition

  beforeAll(async () => {
    // requires-gated rules make the identity chain header-only: the #293
    // guard rejects legacy_header beside evidence-gated rules in named mode,
    // and this suite's configs mirror what an operator could actually load.
    comp = await composeTwoDoors({
      policies: {
        default: 'allow',
        dry_run: false,
        tool_revalidation: { enabled: false },
        rules: [
          {
            name: 'gate-status-on-weather',
            match: { tool: 'get_status' },
            action: 'allow',
            requires: ['get_weather'],
          },
        ],
      } as PoliciesConfig,
      session: {
        identity: [{ source: 'header', name: 'x-helio-session-id' }],
        on_unresolved: 'deny',
      },
    })
  })

  afterAll(async () => {
    await comp.close()
  })

  it('a dependency completed on door A satisfies the gate on door B', async () => {
    const wireSession = await initializeLegacyDoor(comp.mcpUrl('alpha'))
    const dependency = await sendMcpRequest(
      comp.mcpUrl('alpha'),
      'tools/call',
      { name: 'get_weather', arguments: { city: 'Berlin' } },
      's3-a1',
      { sessionId: wireSession, helioSessionId: 's3-1' },
    )
    expect(dependency.body['error']).toBeUndefined()

    const gated = await sendMcpRequest(
      comp.mcpUrl('beta'),
      'tools/call',
      { name: 'get_status', arguments: {} },
      's3-b1',
      { helioSessionId: 's3-1' },
    )
    expect(gated.body['error']).toBeUndefined()
    const result = gated.body['result'] as { content: { text: string }[] }
    expect(result.content[0]?.text).toContain('get_status executed')
  })

  it('negative control: a fresh identity is denied with the dependency-missing envelope', async () => {
    const denied = await sendMcpRequest(
      comp.mcpUrl('beta'),
      'tools/call',
      { name: 'get_status', arguments: {} },
      's3-b2',
      { helioSessionId: 's3-2' },
    )
    const error = denied.body['error'] as {
      code: number
      message: string
      data: Record<string, unknown>
    }
    expect(error).toBeDefined()
    expect(error.code).toBe(-32001)
    expect(error.message).toBe(
      'Evidence grounding failed: Required tool calls not completed: get_weather',
    )
    expect(error.data['reason']).toBe('dependency_missing')
    expect(error.data['missing_dependencies']).toEqual(['get_weather'])
    expect(error.data['rule']).toBe('gate-status-on-weather')
  })
})
