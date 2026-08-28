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

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
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
