import { describe, it, expect, vi } from 'vitest'
import { GovernanceService } from '../sideband/governance-service.js'
import { GovernedForwarder } from '../policy/governed-forwarder.js'
import { compilePolicies } from '../policy/parser.js'
import { RateLimiter } from '../policy/rate-limiter.js'
import type { McpForwarder, McpRequest, ForwardResult } from '../mcp/types.js'

// ---------------------------------------------------------------------------
// Shared-limiter integration (issue #12): a rate counter consumed by a
// sideband /audit must be visible to a subsequent MCP-path tools/call, and
// vice versa — one budget, both doors.
// ---------------------------------------------------------------------------

function mockForwarder(): McpForwarder {
  const body = { jsonrpc: '2.0' as const, id: 1, result: { content: [] } }
  const response = { status: 200, headers: {}, body }
  const result: ForwardResult = { response, durationMs: 1 }
  return { forward: vi.fn().mockResolvedValue(result) }
}

function toolsCall(name: string): McpRequest {
  return { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } }
}

function isBlocked(result: ForwardResult): boolean {
  const body = result.response.body as { error?: unknown }
  return body.error !== undefined
}

describe('sideband ↔ MCP shared rate limiter', () => {
  it('counts a sideband /audit consumption against the MCP-path budget', async () => {
    const policy = compilePolicies({
      default: 'allow',
      dry_run: false,
      rules: [
        {
          name: 'rl',
          match: { tool: 'send' },
          action: 'rate_limit',
          limits: { max_calls: 2, window: '60s' },
        },
      ],
    }).policy

    // One limiter instance shared by both paths.
    const rateLimiter = new RateLimiter({ cleanupIntervalMs: 0 })
    const service = new GovernanceService({ policy, rateLimiter, sweepIntervalMs: 0 })
    const forwarder = new GovernedForwarder(mockForwarder(), policy, { rateLimiter })

    // 1) Sideband evaluate + audit consumes slot 1 of 2.
    const ev = service.evaluate({
      origin: 'openclaw',
      agent_id: null,
      session_id: null,
      tool: { name: 'send' },
      arguments: {},
      metadata: null,
    })
    expect(ev.body['decision']).toBe('allow')
    service.audit({ evaluation_id: ev.body['evaluation_id'] as string, status: 'success' }, 'h')
    expect(rateLimiter.getKeyState('tool:send')?.current).toBe(1)

    // 2) MCP tools/call consumes slot 2 of 2 — allowed.
    const first = await forwarder.forward(toolsCall('send'))
    expect(isBlocked(first)).toBe(false)
    expect(rateLimiter.getKeyState('tool:send')?.current).toBe(2)

    // 3) MCP tools/call now over the shared budget — blocked.
    const second = await forwarder.forward(toolsCall('send'))
    expect(isBlocked(second)).toBe(true)

    rateLimiter.close()
    service.close()
  })
})
