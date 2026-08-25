import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GovernedForwarder } from './governed-forwarder.js'
import { compilePolicies } from './parser.js'
import { decide } from './decision-pipeline.js'
import type { McpForwarder, McpRequest, ForwardResult, McpResponse } from '../mcp/types.js'
import type { PoliciesConfig } from '../config/schema.js'

// Spy-mode module mock: the real decide() runs, its inputs are observable.
// Call history is FILE-WIDE — the beforeEach mockClear is load-bearing.
vi.mock('./decision-pipeline.js', { spy: true })

// ---------------------------------------------------------------------------
// GovernedForwarder → decide() upstream stamping (issue #295)
// ---------------------------------------------------------------------------

function compile(config: Partial<PoliciesConfig> & Pick<PoliciesConfig, 'rules'>) {
  return compilePolicies({ default: 'allow', dry_run: false, ...config }).policy
}

function toolsCall(name: string, args: Record<string, unknown> = {}): McpRequest {
  return { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }
}

function successResult(): ForwardResult {
  const response: McpResponse = {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'ok' }] } },
  }
  return { response, durationMs: 5 }
}

function mockForwarder(): McpForwarder & { forward: ReturnType<typeof vi.fn> } {
  return { forward: vi.fn().mockResolvedValue(successResult()) }
}

beforeEach(() => {
  vi.mocked(decide).mockClear()
})

describe('GovernedForwarder — upstream stamping (issue #295)', () => {
  it('stamps the configured upstreamName into the decide() input', async () => {
    const governed = new GovernedForwarder(mockForwarder(), compile({ rules: [] }), {
      upstreamName: 'payments',
    })
    await governed.forward(toolsCall('get_weather'))
    expect(vi.mocked(decide)).toHaveBeenCalledTimes(1)
    const input = vi.mocked(decide).mock.calls[0]?.[0]
    expect(input?.upstream).toBe('payments')
  })
})
