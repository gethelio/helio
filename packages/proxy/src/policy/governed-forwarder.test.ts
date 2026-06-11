import { describe, it, expect, vi } from 'vitest'
import { GovernedForwarder } from './governed-forwarder.js'
import { compilePolicies } from './parser.js'
import type { McpForwarder, McpRequest, ForwardResult, McpResponse } from '../mcp/types.js'
import type { PoliciesConfig } from '../config/schema.js'
import type { CompiledPolicy } from './types.js'
import { AuditWriter } from '../audit/writer.js'
import { AuditStore } from '../audit/store.js'
import { EvidenceStore } from '../evidence/index.js'
import { ApprovalRouter } from '../approval/router.js'
import { ApprovalQueue } from '../approval/queue.js'
import { QueueChannel } from '../approval/channels.js'
import type { ApprovalChannel } from '../approval/types.js'
import { RateLimiter } from './rate-limiter.js'
import { SpendLimiter } from './spend-limiter.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a compiled policy from a PoliciesConfig. */
function compile(config: Omit<PoliciesConfig, 'dry_run'> & { dry_run?: boolean }): CompiledPolicy {
  return compilePolicies({ dry_run: false, ...config }).policy
}

/** Build an McpRequest for tools/call. */
function toolsCallRequest(
  name: string,
  args?: Record<string, unknown>,
  id: string | number = 1,
): McpRequest {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: args ?? {} },
  }
}

/** Build an McpRequest for tools/list. */
function toolsListRequest(id: string | number = 1): McpRequest {
  return { jsonrpc: '2.0', id, method: 'tools/list' }
}

/** Build an McpRequest for a non-tool method. */
function otherRequest(method: string, params?: unknown, id: string | number = 1): McpRequest {
  return { jsonrpc: '2.0', id, method, params }
}

/** Build a successful ForwardResult with the given body. */
function successResult(body: unknown): ForwardResult {
  const response: McpResponse = {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body,
  }
  return { response, durationMs: 5 }
}

/** Build a tools/list ForwardResult containing tool entries. */
function toolsListResult(
  tools: Array<{ name: string; annotations?: Record<string, boolean>; inputSchema?: unknown }>,
): ForwardResult {
  return successResult({
    jsonrpc: '2.0',
    id: 1,
    result: { tools },
  })
}

/** Create a mock McpForwarder. */
function mockForwarder(
  result?: ForwardResult,
): McpForwarder & { forward: ReturnType<typeof vi.fn> } {
  return {
    forward: vi.fn().mockResolvedValue(
      result ??
        successResult({
          jsonrpc: '2.0',
          id: 1,
          result: { content: [{ type: 'text', text: 'ok' }] },
        }),
    ),
  }
}

/** Build a tools/call request with a session ID. */
function toolsCallWithSession(
  name: string,
  sessionId: string,
  args?: Record<string, unknown>,
): McpRequest {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args ?? {} },
    sessionId,
  }
}

/** Extract the JSON-RPC error from a ForwardResult. */
function errorFromResult(result: ForwardResult) {
  const body = result.response.body as Record<string, unknown>
  return body['error'] as { code: number; message: string; data: Record<string, unknown> }
}

// ---------------------------------------------------------------------------
// GovernedForwarder
// ---------------------------------------------------------------------------

describe('GovernedForwarder', () => {
  describe('allow action', () => {
    it('forwards request to inner forwarder and returns response', async () => {
      const inner = mockForwarder()
      const policy = compile({
        default: 'allow',
        rules: [{ match: { tool: 'get_weather' }, action: 'allow' }],
      })
      const governed = new GovernedForwarder(inner, policy)

      const request = toolsCallRequest('get_weather', { city: 'London' })
      const result = await governed.forward(request)

      expect(inner.forward).toHaveBeenCalledWith(request)
      expect(result.response.status).toBe(200)
      expect(result.durationMs).toBe(5)
    })

    it('forwards when default policy is allow and no rule matches', async () => {
      const inner = mockForwarder()
      const policy = compile({ default: 'allow', rules: [] })
      const governed = new GovernedForwarder(inner, policy)

      await governed.forward(toolsCallRequest('anything'))
      expect(inner.forward).toHaveBeenCalled()
    })
  })

  describe('deny action', () => {
    it('returns JSON-RPC error without forwarding to inner', async () => {
      const inner = mockForwarder()
      const policy = compile({
        default: 'allow',
        rules: [{ match: { tool: 'delete_*' }, action: 'deny' }],
      })
      const governed = new GovernedForwarder(inner, policy)

      const result = await governed.forward(toolsCallRequest('delete_record', { id: '42' }))

      expect(inner.forward).not.toHaveBeenCalled()
      expect(result.response.status).toBe(200)
      expect(result.durationMs).toBe(0)

      const error = errorFromResult(result)
      expect(error.code).toBe(-32001)
      expect(error.data['blocked']).toBe(true)
      expect(error.data['action']).toBe('deny')
      expect(error.data['reason']).toBe('policy_denied')
      expect(error.data['policy_reason']).toBeTypeOf('string')
      expect(error.data['suggestion']).toBeTypeOf('string')
    })

    it('includes rule name in error data when present', async () => {
      const inner = mockForwarder()
      const policy = compile({
        default: 'allow',
        rules: [{ name: 'block-destructive', match: { tool: 'delete_*' }, action: 'deny' }],
      })
      const governed = new GovernedForwarder(inner, policy)

      const result = await governed.forward(toolsCallRequest('delete_record'))
      const error = errorFromResult(result)
      expect(error.data['rule']).toBe('block-destructive')
    })

    it('sets rule to null when rule has no name', async () => {
      const inner = mockForwarder()
      const policy = compile({
        default: 'allow',
        rules: [{ match: { tool: 'delete_*' }, action: 'deny' }],
      })
      const governed = new GovernedForwarder(inner, policy)

      const result = await governed.forward(toolsCallRequest('delete_record'))
      const error = errorFromResult(result)
      expect(error.data['rule']).toBeNull()
      expect(error.data['ruleIndex']).toBe(0)
    })

    it('uses feedback message when rule has one', async () => {
      const inner = mockForwarder()
      const policy = compile({
        default: 'allow',
        rules: [
          {
            match: { tool: 'delete_*' },
            action: 'deny',
            feedback: { message: 'Destructive operations are disabled' },
          },
        ],
      })
      const governed = new GovernedForwarder(inner, policy)

      const result = await governed.forward(toolsCallRequest('delete_record'))
      const error = errorFromResult(result)
      expect(error.message).toBe('Destructive operations are disabled')
      // feedback.message also flows into the suggestion when no explicit suggestion is set
      expect(error.data['suggestion']).toBe('Destructive operations are disabled')
    })

    it('uses feedback.suggestion over feedback.message for suggestion', async () => {
      const inner = mockForwarder()
      const policy = compile({
        default: 'allow',
        rules: [
          {
            match: { tool: 'delete_*' },
            action: 'deny',
            feedback: {
              message: 'Destructive operations are disabled',
              suggestion: 'Use the archive_record tool instead of delete.',
            },
          },
        ],
      })
      const governed = new GovernedForwarder(inner, policy)

      const result = await governed.forward(toolsCallRequest('delete_record'))
      const error = errorFromResult(result)
      // JSON-RPC message uses feedback.message
      expect(error.message).toBe('Destructive operations are disabled')
      // suggestion uses feedback.suggestion (takes precedence)
      expect(error.data['suggestion']).toBe('Use the archive_record tool instead of delete.')
    })

    it('preserves request id in deny response', async () => {
      const inner = mockForwarder()
      const policy = compile({
        default: 'allow',
        rules: [{ match: { tool: 'delete_*' }, action: 'deny' }],
      })
      const governed = new GovernedForwarder(inner, policy)

      const result = await governed.forward(toolsCallRequest('delete_record', {}, 42))
      const body = result.response.body as Record<string, unknown>
      expect(body['id']).toBe(42)
    })

    it('blocks when default policy is deny and no rule matches', async () => {
      const inner = mockForwarder()
      const policy = compile({ default: 'deny', rules: [] })
      const governed = new GovernedForwarder(inner, policy)

      const result = await governed.forward(toolsCallRequest('anything'))

      expect(inner.forward).not.toHaveBeenCalled()
      const error = errorFromResult(result)
      expect(error.code).toBe(-32001)
      expect(error.data['blocked']).toBe(true)
    })
  })

  describe('first-match-wins', () => {
    it('earlier allow rule takes precedence over later deny', async () => {
      const inner = mockForwarder()
      const policy = compile({
        default: 'deny',
        rules: [
          { name: 'allow-weather', match: { tool: 'get_weather' }, action: 'allow' },
          { name: 'deny-all', match: { tool: '*' }, action: 'deny' },
        ],
      })
      const governed = new GovernedForwarder(inner, policy)

      await governed.forward(toolsCallRequest('get_weather'))
      expect(inner.forward).toHaveBeenCalled()
    })

    it('later deny catch-all blocks unmatched tools', async () => {
      const inner = mockForwarder()
      const policy = compile({
        default: 'allow',
        rules: [
          { match: { tool: 'get_weather' }, action: 'allow' },
          { match: { tool: '*' }, action: 'deny' },
        ],
      })
      const governed = new GovernedForwarder(inner, policy)

      const result = await governed.forward(toolsCallRequest('send_email'))
      expect(inner.forward).not.toHaveBeenCalled()
      const error = errorFromResult(result)
      expect(error.data['blocked']).toBe(true)
    })
  })

  describe('non-tool methods pass through', () => {
    it('tools/list is forwarded regardless of policy', async () => {
      const inner = mockForwarder(toolsListResult([{ name: 'tool_a' }]))
      const policy = compile({
        default: 'deny',
        rules: [{ match: { tool: '*' }, action: 'deny' }],
      })
      const governed = new GovernedForwarder(inner, policy)

      const result = await governed.forward(toolsListRequest())
      expect(inner.forward).toHaveBeenCalled()
      expect(result.response.status).toBe(200)
    })

    it('prompts/list is forwarded regardless of policy', async () => {
      const inner = mockForwarder()
      const policy = compile({ default: 'deny', rules: [] })
      const governed = new GovernedForwarder(inner, policy)

      await governed.forward(otherRequest('prompts/list'))
      expect(inner.forward).toHaveBeenCalled()
    })

    it('resources/read is forwarded regardless of policy', async () => {
      const inner = mockForwarder()
      const policy = compile({ default: 'deny', rules: [] })
      const governed = new GovernedForwarder(inner, policy)

      await governed.forward(otherRequest('resources/read', { uri: 'test://resource' }))
      expect(inner.forward).toHaveBeenCalled()
    })

    it('initialize is forwarded regardless of policy', async () => {
      const inner = mockForwarder()
      const policy = compile({ default: 'deny', rules: [] })
      const governed = new GovernedForwarder(inner, policy)

      await governed.forward(otherRequest('initialize'))
      expect(inner.forward).toHaveBeenCalled()
    })
  })

  describe('annotation cache', () => {
    it('populates cache from tools/list response', async () => {
      const inner = mockForwarder(
        toolsListResult([
          // readOnlyHint: true AND destructiveHint: false → safe tool
          { name: 'get_weather', annotations: { readOnlyHint: true, destructiveHint: false } },
          // destructiveHint: true → dangerous tool
          { name: 'delete_record', annotations: { destructiveHint: true } },
        ]),
      )
      const policy = compile({
        default: 'allow',
        rules: [{ match: { annotations: { destructiveHint: true } }, action: 'deny' }],
      })
      const governed = new GovernedForwarder(inner, policy)

      // First, populate cache via tools/list
      await governed.forward(toolsListRequest())

      // Reset mock to track tools/call forwarding
      inner.forward.mockClear()
      inner.forward.mockResolvedValue(
        successResult({
          jsonrpc: '2.0',
          id: 2,
          result: { content: [{ type: 'text', text: 'ok' }] },
        }),
      )

      // get_weather (destructiveHint: false) → should be allowed
      await governed.forward(toolsCallRequest('get_weather'))
      expect(inner.forward).toHaveBeenCalled()

      // delete_record (destructiveHint: true) → should be denied
      inner.forward.mockClear()
      const result = await governed.forward(toolsCallRequest('delete_record'))
      expect(inner.forward).not.toHaveBeenCalled()
      const error = errorFromResult(result)
      expect(error.data['blocked']).toBe(true)
    })

    it('pins baseline annotations across tools/list refreshes (rug-pull guard)', async () => {
      const policy = compile({
        default: 'allow',
        rules: [{ match: { annotations: { destructiveHint: true } }, action: 'deny' }],
      })

      // First tools/list: tool_a is destructive — this becomes the baseline
      const inner = mockForwarder(
        toolsListResult([{ name: 'tool_a', annotations: { destructiveHint: true } }]),
      )
      const governed = new GovernedForwarder(inner, policy)
      await governed.forward(toolsListRequest())

      // tool_a is denied by the annotation rule
      inner.forward.mockClear()
      let result = await governed.forward(toolsCallRequest('tool_a'))
      expect(inner.forward).not.toHaveBeenCalled()
      expect(errorFromResult(result).data['blocked']).toBe(true)

      // Second tools/list claims tool_a is now non-destructive. The baseline
      // is pinned, so the deny keeps firing — the upstream cannot talk its
      // way out of a policy match by editing its own definition.
      inner.forward.mockResolvedValue(
        toolsListResult([
          { name: 'tool_a', annotations: { destructiveHint: false, readOnlyHint: true } },
        ]),
      )
      await governed.forward(toolsListRequest())

      inner.forward.mockClear()
      result = await governed.forward(toolsCallRequest('tool_a'))
      expect(inner.forward).not.toHaveBeenCalled()
      expect(errorFromResult(result).data['blocked']).toBe(true)
    })

    it('primeAnnotationCache populates cache via synthetic tools/list', async () => {
      const inner = mockForwarder(
        toolsListResult([
          { name: 'safe_tool', annotations: { destructiveHint: false, readOnlyHint: true } },
          { name: 'danger_tool', annotations: { destructiveHint: true } },
        ]),
      )
      const policy = compile({
        default: 'allow',
        rules: [{ match: { annotations: { destructiveHint: true } }, action: 'deny' }],
      })
      const governed = new GovernedForwarder(inner, policy)

      const prime = await governed.primeAnnotationCache()
      expect(prime).toEqual({ success: true, toolsCached: 2 })
      expect(inner.forward).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'tools/list', id: 'helio-prime-annotations' }),
      )

      inner.forward.mockClear()
      inner.forward.mockResolvedValue(
        successResult({
          jsonrpc: '2.0',
          id: 2,
          result: { content: [{ type: 'text', text: 'ok' }] },
        }),
      )

      await governed.forward(toolsCallRequest('safe_tool'))
      expect(inner.forward).toHaveBeenCalled()

      inner.forward.mockClear()
      const result = await governed.forward(toolsCallRequest('danger_tool'))
      expect(inner.forward).not.toHaveBeenCalled()
      expect(errorFromResult(result).data['blocked']).toBe(true)
    })

    it('primeAnnotationCache returns failure when tools/list payload shape is invalid', async () => {
      const inner = mockForwarder(
        successResult({
          jsonrpc: '2.0',
          id: 1,
          result: { prompts: [] },
        }),
      )
      const governed = new GovernedForwarder(inner, compile({ default: 'allow', rules: [] }))

      const prime = await governed.primeAnnotationCache()
      expect(prime.success).toBe(false)
      expect(prime.toolsCached).toBe(0)
      expect(prime.reason).toMatch(/missing result\.tools/i)
    })

    it('classifies a JSON-RPC error payload from the prime tools/list', async () => {
      const inner = {
        forward: () =>
          Promise.resolve({
            response: {
              status: 200,
              headers: {},
              body: {
                jsonrpc: '2.0',
                id: 'helio-prime-annotations',
                error: { code: -32600, message: 'Bad Request' },
              },
            },
            durationMs: 1,
          }),
      }
      const gf = new GovernedForwarder(inner, compile({ default: 'allow', rules: [] }))
      const result = await gf.primeAnnotationCache()
      expect(result.success).toBe(false)
      expect(result.reason).toMatch(/JSON-RPC error/i)
      expect(result.reason).toContain('Bad Request')
    })

    it('classifies a non-tools/list result shape', async () => {
      const inner = {
        forward: () =>
          Promise.resolve({
            response: {
              status: 200,
              headers: {},
              body: { jsonrpc: '2.0', id: 1, result: { notTools: true } },
            },
            durationMs: 1,
          }),
      }
      const gf = new GovernedForwarder(inner, compile({ default: 'allow', rules: [] }))
      const result = await gf.primeAnnotationCache()
      expect(result.success).toBe(false)
      expect(result.reason).toMatch(/missing result\.tools/i)
    })

    it('classifies an HTTP error status from the prime tools/list', async () => {
      const inner = {
        forward: () =>
          Promise.resolve({
            response: {
              status: 400,
              headers: { 'content-type': 'application/json' },
              body: { error: 'session required' },
            },
            durationMs: 1,
          }),
      }
      const gf = new GovernedForwarder(inner, compile({ default: 'allow', rules: [] }))
      const result = await gf.primeAnnotationCache()
      expect(result.success).toBe(false)
      expect(result.reason).toMatch(/HTTP 400/)
      expect(result.reason).toMatch(/session|initialize/i)
    })

    it('classifies a bare string error field from a non-conforming upstream', async () => {
      const inner = {
        forward: () =>
          Promise.resolve({
            response: {
              status: 200,
              headers: { 'content-type': 'application/json' },
              body: { jsonrpc: '2.0', id: 1, error: 'Not initialized' },
            },
            durationMs: 1,
          }),
      }
      const gf = new GovernedForwarder(inner, compile({ default: 'allow', rules: [] }))
      const result = await gf.primeAnnotationCache()
      expect(result.success).toBe(false)
      expect(result.reason).toMatch(/JSON-RPC error/i)
      expect(result.reason).toContain('Not initialized')
    })

    it('classifies a non-JSON body from the prime tools/list', async () => {
      const inner = {
        forward: () =>
          Promise.resolve({
            response: {
              status: 200,
              headers: { 'content-type': 'text/plain' },
              body: 'plain text',
            },
            durationMs: 1,
          }),
      }
      const gf = new GovernedForwarder(inner, compile({ default: 'allow', rules: [] }))
      const result = await gf.primeAnnotationCache()
      expect(result.success).toBe(false)
      expect(result.reason).toMatch(/non-JSON body/i)
      expect(result.reason).toContain('text/plain')
    })

    it('never treats an HTTP error as a successful prime, even with a tools-shaped body', async () => {
      const inner = {
        forward: () =>
          Promise.resolve({
            response: {
              status: 404,
              headers: { 'content-type': 'application/json' },
              body: {
                jsonrpc: '2.0',
                id: 'helio-prime-annotations',
                result: { tools: [{ name: 't1', annotations: {} }] },
              },
            },
            durationMs: 1,
          }),
      }
      const gf = new GovernedForwarder(inner, compile({ default: 'allow', rules: [] }))
      const result = await gf.primeAnnotationCache()
      expect(result.success).toBe(false)
      expect(result.reason).toMatch(/HTTP 404/)
    })

    it('routes the prime through forwardInternal when the inner forwarder provides it', async () => {
      const forwardSpy = vi.fn()
      const forwardInternalSpy = vi.fn().mockResolvedValue({
        response: {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: {
            jsonrpc: '2.0',
            id: 'helio-prime-annotations',
            result: { tools: [{ name: 't1', annotations: {} }] },
          },
        },
        durationMs: 1,
      })
      const inner = {
        forward: forwardSpy,
        forwardInternal: forwardInternalSpy,
      }
      const gf = new GovernedForwarder(inner, compile({ default: 'allow', rules: [] }))
      const result = await gf.primeAnnotationCache()
      expect(result.success).toBe(true)
      expect(forwardInternalSpy).toHaveBeenCalledOnce()
      expect(forwardSpy).not.toHaveBeenCalled()
    })

    it('primeAnnotationCache returns failure when upstream forwarding throws', async () => {
      const inner = mockForwarder()
      inner.forward.mockRejectedValue(new Error('upstream unavailable'))
      const governed = new GovernedForwarder(inner, compile({ default: 'allow', rules: [] }))

      const prime = await governed.primeAnnotationCache()
      expect(prime.success).toBe(false)
      expect(prime.toolsCached).toBe(0)
      expect(prime.reason).toBe('upstream unavailable')
    })
  })

  describe('actions without runtime dependency', () => {
    it.each(['require_approval', 'rate_limit', 'spend_limit'] as const)(
      '%s without its subsystem returns unsupported error',
      async (action) => {
        const inner = mockForwarder()
        const policy = compile({
          default: 'allow',
          rules: [{ name: `rule-${action}`, match: { tool: 'test_tool' }, action }],
        })
        const governed = new GovernedForwarder(inner, policy)

        const result = await governed.forward(toolsCallRequest('test_tool'))

        expect(inner.forward).not.toHaveBeenCalled()
        const error = errorFromResult(result)
        expect(error.code).toBe(-32001)
        expect(error.data['blocked']).toBe(true)
        expect(error.data['action']).toBe(action)
        expect(error.data['unsupported']).toBe(true)
        expect(error.message).toContain('not yet supported')
      },
    )
  })

  describe('environment', () => {
    it('uses environment option in match context', async () => {
      const inner = mockForwarder()
      const policy = compile({
        default: 'allow',
        rules: [{ match: { tool: '*', environment: 'production' }, action: 'deny' }],
      })
      const governed = new GovernedForwarder(inner, policy, { environment: 'production' })

      const result = await governed.forward(toolsCallRequest('send_email'))
      expect(inner.forward).not.toHaveBeenCalled()
      const error = errorFromResult(result)
      expect(error.data['blocked']).toBe(true)
    })

    it('does not match when environment differs', async () => {
      const inner = mockForwarder()
      const policy = compile({
        default: 'allow',
        rules: [{ match: { tool: '*', environment: 'production' }, action: 'deny' }],
      })
      const governed = new GovernedForwarder(inner, policy, { environment: 'staging' })

      await governed.forward(toolsCallRequest('send_email'))
      expect(inner.forward).toHaveBeenCalled()
    })
  })

  describe('updatePolicy', () => {
    it('swaps policy for subsequent requests', async () => {
      const inner = mockForwarder()
      const policyAllow = compile({ default: 'allow', rules: [] })
      const policyDeny = compile({ default: 'deny', rules: [] })
      const governed = new GovernedForwarder(inner, policyAllow)

      // Initially allows
      await governed.forward(toolsCallRequest('test_tool'))
      expect(inner.forward).toHaveBeenCalled()

      // Swap to deny
      governed.updatePolicy(policyDeny)
      inner.forward.mockClear()

      const result = await governed.forward(toolsCallRequest('test_tool'))
      expect(inner.forward).not.toHaveBeenCalled()
      const error = errorFromResult(result)
      expect(error.data['blocked']).toBe(true)
    })
  })

  describe('audit integration', () => {
    function createAuditWriter() {
      const store = new AuditStore({
        path: ':memory:',
        retention: '90d',
        includeResponses: true,
        cleanupIntervalMs: 0,
      })
      const writer = new AuditWriter({ store, flushIntervalMs: 0 })
      return { store, writer }
    }

    it('writes audit record for allowed tool calls', async () => {
      const inner = mockForwarder()
      const policy = compile({ default: 'allow', rules: [] })
      const { store, writer } = createAuditWriter()
      const governed = new GovernedForwarder(inner, policy, {
        environment: 'production',
        auditWriter: writer,
      })

      await governed.forward(toolsCallRequest('get_weather', { city: 'London' }))

      writer.flush()
      expect(store.count()).toBe(1)

      const { records } = store.list()
      expect(records[0]).toBeDefined()
      expect(records[0]?.tool_name).toBe('get_weather')
      expect(records[0]?.tool_input).toEqual({ city: 'London' })
      expect(records[0]?.policy_decision).toBe('allow')
      expect(records[0]?.environment).toBe('production')
      expect(records[0]?.matched_rule_index).toBeNull()
      expect(records[0]?.upstream_response).not.toBeNull()
      expect(records[0]?.upstream_http_status).toBe(200)
      expect(records[0]?.upstream_latency_ms).toBe(5)
      expect(records[0]?.total_duration_ms).toBeGreaterThan(0)
      expect(records[0]?.approval_wait_ms).toBe(0)
      expect(records[0]?.proxy_compute_ms).toBeGreaterThanOrEqual(0)
      expect(records[0]?.dry_run).toBe(false)

      writer.close()
    })

    it('writes audit record for denied tool calls', async () => {
      const inner = mockForwarder()
      const policy = compile({
        default: 'allow',
        rules: [{ name: 'block-delete', match: { tool: 'delete_*' }, action: 'deny' }],
      })
      const { store, writer } = createAuditWriter()
      const governed = new GovernedForwarder(inner, policy, { auditWriter: writer })

      await governed.forward(toolsCallRequest('delete_record', { id: '42' }))

      writer.flush()
      expect(store.count()).toBe(1)

      const { records } = store.list()
      expect(records[0]).toBeDefined()
      expect(records[0]?.tool_name).toBe('delete_record')
      expect(records[0]?.tool_input).toEqual({ id: '42' })
      expect(records[0]?.policy_decision).toBe('deny')
      expect(records[0]?.matched_rule).toBe('block-delete')
      expect(records[0]?.matched_rule_index).toBe(0)
      expect(records[0]?.upstream_response).toBeNull()
      expect(records[0]?.upstream_http_status).toBeNull()
      expect(records[0]?.upstream_latency_ms).toBeNull()
      expect(records[0]?.total_duration_ms).toBeGreaterThanOrEqual(0)
      expect(records[0]?.approval_wait_ms).toBe(0)
      expect(records[0]?.proxy_compute_ms).toBeGreaterThanOrEqual(0)

      writer.close()
    })

    it('captures session_id from request', async () => {
      const inner = mockForwarder()
      const policy = compile({ default: 'allow', rules: [] })
      const { store, writer } = createAuditWriter()
      const governed = new GovernedForwarder(inner, policy, { auditWriter: writer })

      const request: McpRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'test_tool', arguments: {} },
        sessionId: 'session-abc-123',
      }
      await governed.forward(request)

      writer.flush()
      const { records } = store.list()
      expect(records[0]).toBeDefined()
      expect(records[0]?.session_id).toBe('session-abc-123')

      writer.close()
    })

    it('does not write audit records for non-tool methods', async () => {
      const inner = mockForwarder(toolsListResult([{ name: 'tool_a' }]))
      const policy = compile({ default: 'allow', rules: [] })
      const { store, writer } = createAuditWriter()
      const governed = new GovernedForwarder(inner, policy, { auditWriter: writer })

      await governed.forward(toolsListRequest())
      await governed.forward(otherRequest('initialize'))

      writer.flush()
      expect(store.count()).toBe(0)

      writer.close()
    })

    it('stores response summary when includeResponses is false', async () => {
      const inner = mockForwarder()
      const policy = compile({ default: 'allow', rules: [] })
      const store = new AuditStore({
        path: ':memory:',
        retention: '90d',
        includeResponses: false,
        cleanupIntervalMs: 0,
      })
      const writer = new AuditWriter({ store, flushIntervalMs: 0 })
      const governed = new GovernedForwarder(inner, policy, { auditWriter: writer })

      await governed.forward(toolsCallRequest('get_weather', { city: 'London' }))

      writer.flush()
      const { records } = store.list()
      expect(records[0]).toBeDefined()

      // Should be a summary, not the full response body
      const response = records[0]?.upstream_response as Record<string, unknown>
      expect(response['success']).toBe(true)
      expect(response['has_error']).toBe(false)
      expect(response['content_types']).toEqual(['text'])
      expect(response['content_count']).toBe(1)
      expect(records[0]?.upstream_http_status).toBe(200)
      // Full body fields should NOT be present
      expect(response['jsonrpc']).toBeUndefined()
      expect(response['result']).toBeUndefined()

      writer.close()
    })

    it('stores null upstream_response for denied calls regardless of includeResponses', async () => {
      const inner = mockForwarder()
      const policy = compile({
        default: 'allow',
        rules: [{ match: { tool: 'delete_*' }, action: 'deny' }],
      })
      const store = new AuditStore({
        path: ':memory:',
        retention: '90d',
        includeResponses: false,
        cleanupIntervalMs: 0,
      })
      const writer = new AuditWriter({ store, flushIntervalMs: 0 })
      const governed = new GovernedForwarder(inner, policy, { auditWriter: writer })

      await governed.forward(toolsCallRequest('delete_record', { id: '42' }))

      writer.flush()
      const { records } = store.list()
      expect(records[0]).toBeDefined()
      expect(records[0]?.upstream_response).toBeNull()
      expect(records[0]?.upstream_http_status).toBeNull()
      expect(records[0]?.policy_decision).toBe('deny')

      writer.close()
    })

    it('records upstream_http_status for forwarded non-JSON-RPC failure bodies', async () => {
      const inner = mockForwarder({
        response: {
          status: 500,
          headers: { 'content-type': 'text/plain' },
          body: 'upstream failed',
        },
        durationMs: 12,
      })
      const policy = compile({ default: 'allow', rules: [] })
      const { store, writer } = createAuditWriter()
      const governed = new GovernedForwarder(inner, policy, { auditWriter: writer })

      await governed.forward(toolsCallRequest('get_weather', { city: 'London' }))

      writer.flush()
      const { records } = store.list()
      expect(records).toHaveLength(1)
      expect(records[0]?.upstream_http_status).toBe(500)
      expect(records[0]?.upstream_response).toBe('upstream failed')
      expect(records[0]?.upstream_latency_ms).toBe(12)

      writer.close()
    })

    it('writes audit row when upstream forwarding throws after policy allow', async () => {
      const inner = mockForwarder()
      inner.forward.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:8080'))
      const policy = compile({ default: 'allow', rules: [] })
      const { store, writer } = createAuditWriter()
      const governed = new GovernedForwarder(inner, policy, { auditWriter: writer })

      const result = await governed.forward(toolsCallRequest('get_weather'))
      const error = errorFromResult(result)
      expect(error.code).toBe(-32603)
      expect(error.data['failure_class']).toBe('upstream_forward_error')

      writer.flush()
      const { records } = store.list()
      expect(records).toHaveLength(1)
      expect(records[0]?.policy_decision).toBe('allow')
      expect(records[0]?.upstream_response).toBeNull()
      expect(records[0]?.upstream_http_status).toBeNull()
      expect(records[0]?.upstream_latency_ms).toBeNull()
      expect(records[0]?.upstream_error).toContain('ECONNREFUSED')

      writer.close()
    })

    it('works without audit writer configured', async () => {
      const inner = mockForwarder()
      const policy = compile({ default: 'allow', rules: [] })
      const governed = new GovernedForwarder(inner, policy)

      // Should not throw even though no auditWriter is set
      const result = await governed.forward(toolsCallRequest('test_tool'))
      expect(result.response.status).toBe(200)
    })

    it('queues deny records for prioritized async flush without blocking forward()', async () => {
      vi.useFakeTimers()
      try {
        const inner = mockForwarder()
        const policy = compile({
          default: 'allow',
          rules: [{ name: 'block-delete', match: { tool: 'delete_*' }, action: 'deny' }],
        })
        const { store, writer } = createAuditWriter()
        const governed = new GovernedForwarder(inner, policy, { auditWriter: writer })

        await governed.forward(toolsCallRequest('delete_record', { id: '42' }))

        // No synchronous write on the decision path.
        expect(store.count()).toBe(0)

        // Enforcement record is flushed on the next tick.
        await vi.advanceTimersByTimeAsync(0)
        expect(store.count()).toBe(1)
        const { records } = store.list()
        expect(records[0]?.policy_decision).toBe('deny')
        expect(records[0]?.matched_rule).toBe('block-delete')

        writer.close()
      } finally {
        vi.useRealTimers()
      }
    })

    it('buffers ordinary allow records instead of flushing synchronously', async () => {
      // Confirm we did not turn every push into an immediate flush — the hot
      // path for allowed calls must stay buffered to keep latency bounded.
      const inner = mockForwarder()
      const policy = compile({ default: 'allow', rules: [] })
      const { store, writer } = createAuditWriter()
      const governed = new GovernedForwarder(inner, policy, { auditWriter: writer })

      await governed.forward(toolsCallRequest('read_thing'))

      // Without an explicit flush, the allow record is still buffered.
      expect(store.count()).toBe(0)
      writer.flush()
      expect(store.count()).toBe(1)

      writer.close()
    })
  })

  describe('destructive detection', () => {
    function createAudit() {
      const store = new AuditStore({
        path: ':memory:',
        retention: '90d',
        includeResponses: true,
        cleanupIntervalMs: 0,
      })
      const writer = new AuditWriter({ store, flushIntervalMs: 0 })
      return { store, writer }
    }

    /**
     * Prime the annotation cache by sending a tools/list request through the
     * governed forwarder. The inner forwarder is temporarily overridden to
     * return the desired tools/list response.
     */
    async function primeCache(
      inner: McpForwarder & { forward: ReturnType<typeof vi.fn> },
      governed: GovernedForwarder,
      tools: Array<{ name: string; annotations?: Record<string, boolean> }>,
    ) {
      inner.forward.mockResolvedValueOnce(toolsListResult(tools))
      await governed.forward(toolsListRequest())
      // Restore default success response for subsequent tools/call
      inner.forward.mockResolvedValue(
        successResult({
          jsonrpc: '2.0',
          id: 1,
          result: { content: [{ type: 'text', text: 'ok' }] },
        }),
      )
    }

    describe('flag_destructive: log', () => {
      it('flags destructive tool with no matching rule', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        const inner = mockForwarder()
        const policy = compile({ default: 'allow', flag_destructive: 'log', rules: [] })
        const { store, writer } = createAudit()
        const governed = new GovernedForwarder(inner, policy, { auditWriter: writer })

        await primeCache(inner, governed, [
          { name: 'delete_user', annotations: { destructiveHint: true } },
        ])
        const result = await governed.forward(toolsCallRequest('delete_user'))

        // Tool is still forwarded (default: allow)
        expect(inner.forward).toHaveBeenCalled()
        expect(result.response.status).toBe(200)

        writer.flush()
        const { records } = store.list()
        expect(records).toHaveLength(1)
        expect(records[0]?.flagged_destructive).toBe(true)
        expect(records[0]?.policy_decision).toBe('allow')

        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining('Destructive tool detected: delete_user'),
        )

        errorSpy.mockRestore()
        writer.close()
      })

      it('does NOT flag non-destructive tool', async () => {
        const inner = mockForwarder()
        const policy = compile({ default: 'allow', flag_destructive: 'log', rules: [] })
        const { store, writer } = createAudit()
        const governed = new GovernedForwarder(inner, policy, { auditWriter: writer })

        await primeCache(inner, governed, [
          { name: 'get_info', annotations: { destructiveHint: false, readOnlyHint: true } },
        ])
        await governed.forward(toolsCallRequest('get_info'))

        writer.flush()
        const { records } = store.list()
        expect(records).toHaveLength(1)
        expect(records[0]?.flagged_destructive).toBe(false)

        writer.close()
      })

      it('does NOT flag when explicit rule matches', async () => {
        const inner = mockForwarder()
        const policy = compile({
          default: 'allow',
          flag_destructive: 'log',
          rules: [{ name: 'explicit-allow', match: { tool: 'delete_user' }, action: 'allow' }],
        })
        const { store, writer } = createAudit()
        const governed = new GovernedForwarder(inner, policy, { auditWriter: writer })

        await primeCache(inner, governed, [
          { name: 'delete_user', annotations: { destructiveHint: true } },
        ])
        await governed.forward(toolsCallRequest('delete_user'))

        writer.flush()
        const { records } = store.list()
        expect(records).toHaveLength(1)
        expect(records[0]?.flagged_destructive).toBe(false)
        expect(records[0]?.matched_rule).toBe('explicit-allow')

        writer.close()
      })
    })

    describe('flag_destructive: require_approval', () => {
      it('auto-escalates destructive tool to require_approval', async () => {
        const inner = mockForwarder()
        const policy = compile({
          default: 'allow',
          flag_destructive: 'require_approval',
          rules: [],
        })
        const { store, writer } = createAudit()
        const governed = new GovernedForwarder(inner, policy, { auditWriter: writer })

        await primeCache(inner, governed, [
          { name: 'drop_table', annotations: { destructiveHint: true } },
        ])
        inner.forward.mockClear()
        const result = await governed.forward(toolsCallRequest('drop_table'))

        // Tool is NOT forwarded — blocked by require_approval
        expect(inner.forward).not.toHaveBeenCalled()
        const error = errorFromResult(result)
        expect(error.message).toContain('flag_destructive policy')
        expect(error.message).toContain('drop_table')

        writer.flush()
        const { records } = store.list()
        expect(records).toHaveLength(1)
        expect(records[0]?.flagged_destructive).toBe(true)
        expect(records[0]?.policy_decision).toBe('require_approval')

        writer.close()
      })

      it('does NOT escalate when explicit rule matches', async () => {
        const inner = mockForwarder()
        const policy = compile({
          default: 'allow',
          flag_destructive: 'require_approval',
          rules: [{ name: 'block-drops', match: { tool: 'drop_table' }, action: 'deny' }],
        })
        const { store, writer } = createAudit()
        const governed = new GovernedForwarder(inner, policy, { auditWriter: writer })

        await primeCache(inner, governed, [
          { name: 'drop_table', annotations: { destructiveHint: true } },
        ])
        const result = await governed.forward(toolsCallRequest('drop_table'))

        const error = errorFromResult(result)
        expect(error.message).toContain('Policy denied')

        writer.flush()
        const { records } = store.list()
        expect(records).toHaveLength(1)
        expect(records[0]?.flagged_destructive).toBe(false)
        expect(records[0]?.policy_decision).toBe('deny')

        writer.close()
      })
    })

    describe('no flag_destructive configured', () => {
      it('does NOT flag destructive tools', async () => {
        const inner = mockForwarder()
        const policy = compile({ default: 'allow', rules: [] })
        const { store, writer } = createAudit()
        const governed = new GovernedForwarder(inner, policy, { auditWriter: writer })

        await primeCache(inner, governed, [
          { name: 'delete_user', annotations: { destructiveHint: true } },
        ])
        await governed.forward(toolsCallRequest('delete_user'))

        writer.flush()
        const { records } = store.list()
        expect(records).toHaveLength(1)
        expect(records[0]?.flagged_destructive).toBe(false)

        writer.close()
      })
    })

    describe('MCP annotation defaults', () => {
      it('flags tool with no annotations (defaults to destructive per MCP spec)', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        const inner = mockForwarder()
        const policy = compile({ default: 'allow', flag_destructive: 'log', rules: [] })
        const { store, writer } = createAudit()
        const governed = new GovernedForwarder(inner, policy, { auditWriter: writer })

        // Tool is in cache but has no annotations
        await primeCache(inner, governed, [{ name: 'unknown_tool' }])
        await governed.forward(toolsCallRequest('unknown_tool'))

        writer.flush()
        const { records } = store.list()
        expect(records).toHaveLength(1)
        expect(records[0]?.flagged_destructive).toBe(true)

        errorSpy.mockRestore()
        writer.close()
      })

      it('flags tool not in cache (defaults to destructive per MCP spec)', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        const inner = mockForwarder()
        const policy = compile({ default: 'allow', flag_destructive: 'log', rules: [] })
        const { store, writer } = createAudit()
        const governed = new GovernedForwarder(inner, policy, { auditWriter: writer })

        // No cache priming — tool completely unknown
        await governed.forward(toolsCallRequest('never_seen_tool'))

        writer.flush()
        const { records } = store.list()
        expect(records).toHaveLength(1)
        expect(records[0]?.flagged_destructive).toBe(true)

        errorSpy.mockRestore()
        writer.close()
      })

      it('does NOT flag tool with explicit destructiveHint: false', async () => {
        const inner = mockForwarder()
        const policy = compile({ default: 'allow', flag_destructive: 'log', rules: [] })
        const { store, writer } = createAudit()
        const governed = new GovernedForwarder(inner, policy, { auditWriter: writer })

        await primeCache(inner, governed, [
          { name: 'read_data', annotations: { destructiveHint: false } },
        ])
        await governed.forward(toolsCallRequest('read_data'))

        writer.flush()
        const { records } = store.list()
        expect(records).toHaveLength(1)
        expect(records[0]?.flagged_destructive).toBe(false)

        writer.close()
      })
    })

    describe('flagged_destructive filter in audit queries', () => {
      it('filters audit records by flagged_destructive', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        const inner = mockForwarder()
        const policy = compile({ default: 'allow', flag_destructive: 'log', rules: [] })
        const { store, writer } = createAudit()
        const governed = new GovernedForwarder(inner, policy, { auditWriter: writer })

        await primeCache(inner, governed, [
          { name: 'destructive_tool', annotations: { destructiveHint: true } },
          { name: 'safe_tool', annotations: { destructiveHint: false } },
        ])

        await governed.forward(toolsCallRequest('destructive_tool'))
        await governed.forward(toolsCallRequest('safe_tool'))

        writer.flush()

        const flagged = store.list({ flagged_destructive: true })
        expect(flagged.total).toBe(1)
        expect(flagged.records[0]?.tool_name).toBe('destructive_tool')

        const unflagged = store.list({ flagged_destructive: false })
        expect(unflagged.total).toBe(1)
        expect(unflagged.records[0]?.tool_name).toBe('safe_tool')

        errorSpy.mockRestore()
        writer.close()
      })
    })
  })

  describe('edge cases', () => {
    it('passes through tools/call with missing params.name to upstream', async () => {
      const inner = mockForwarder()
      const policy = compile({ default: 'deny', rules: [] })
      const governed = new GovernedForwarder(inner, policy)

      const request: McpRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {},
      }
      await governed.forward(request)
      expect(inner.forward).toHaveBeenCalled()
    })

    it('handles tools/call with no params at all by forwarding to upstream', async () => {
      const inner = mockForwarder()
      const policy = compile({ default: 'deny', rules: [] })
      const governed = new GovernedForwarder(inner, policy)

      const request: McpRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
      }
      await governed.forward(request)
      expect(inner.forward).toHaveBeenCalled()
    })

    it('handles notification (no id) for denied tools/call', async () => {
      const inner = mockForwarder()
      const policy = compile({
        default: 'allow',
        rules: [{ match: { tool: 'blocked' }, action: 'deny' }],
      })
      const governed = new GovernedForwarder(inner, policy)

      const request: McpRequest = {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'blocked' },
      }
      const result = await governed.forward(request)
      const body = result.response.body as Record<string, unknown>
      expect(body['id']).toBeNull()
    })
  })

  // -----------------------------------------------------------------------
  // Evidence grounding
  // -----------------------------------------------------------------------

  describe('evidence grounding', () => {
    it('allows action when all required evidence is present', async () => {
      const inner = mockForwarder()
      const store = new EvidenceStore({ cleanupIntervalMs: 0 })
      store.putEvidence('session-1', {
        evidence_key: 'orders.lookup',
        data: {},
        tool_name: 'get_order',
      })

      const policy = compile({
        default: 'deny',
        rules: [
          {
            name: 'refund-with-evidence',
            match: { tool: 'process_refund' },
            action: 'allow',
            evidence: { requires: ['orders.lookup'] },
          },
        ],
      })
      const governed = new GovernedForwarder(inner, policy, { evidenceStore: store })

      const result = await governed.forward(toolsCallWithSession('process_refund', 'session-1'))
      expect(inner.forward).toHaveBeenCalled()
      expect(result.response.status).toBe(200)
    })

    it('blocks action when required evidence is missing', async () => {
      const inner = mockForwarder()
      const store = new EvidenceStore({ cleanupIntervalMs: 0 })

      const policy = compile({
        default: 'deny',
        rules: [
          {
            name: 'refund-with-evidence',
            match: { tool: 'process_refund' },
            action: 'allow',
            evidence: { requires: ['orders.lookup'] },
          },
        ],
      })
      const governed = new GovernedForwarder(inner, policy, { evidenceStore: store })

      const result = await governed.forward(toolsCallWithSession('process_refund', 'session-1'))
      expect(inner.forward).not.toHaveBeenCalled()

      const error = errorFromResult(result)
      expect(error.data['reason']).toBe('evidence_missing')
      expect(error.data['missing_evidence']).toEqual(['orders.lookup'])
      expect(error.data['retry_allowed']).toBe(true)
      expect(error.data['suggestion']).toContain('orders.lookup')
    })

    it('ignores evidence keys that are not declared by policy', async () => {
      const inner = mockForwarder()
      const store = new EvidenceStore({ cleanupIntervalMs: 0 })

      const policy = compile({
        default: 'deny',
        rules: [
          {
            name: 'refund-with-evidence',
            match: { tool: 'process_refund' },
            action: 'allow',
            evidence: { requires: ['orders.lookup'] },
          },
        ],
      })
      const governed = new GovernedForwarder(inner, policy, { evidenceStore: store })
      store.putEvidence('session-1', {
        evidence_key: 'not.required',
        data: {},
        tool_name: 'other_tool',
      })

      const result = await governed.forward(toolsCallWithSession('process_refund', 'session-1'))
      expect(inner.forward).not.toHaveBeenCalled()
      expect(store.hasSeenEvidence('session-1', 'not.required')).toBe(false)

      const error = errorFromResult(result)
      expect(error.data['reason']).toBe('evidence_missing')
      expect(error.data['missing_evidence']).toEqual(['orders.lookup'])
    })

    it('blocks action when required evidence is expired', async () => {
      let time = 1_000_000
      const store = new EvidenceStore({
        defaultTtlSeconds: 1,
        cleanupIntervalMs: 0,
        now: () => time,
      })
      store.putEvidence('session-1', {
        evidence_key: 'orders.lookup',
        data: {},
        tool_name: 'get_order',
      })
      time += 2_000 // past TTL

      const inner = mockForwarder()
      const policy = compile({
        default: 'deny',
        rules: [
          {
            name: 'refund-with-evidence',
            match: { tool: 'process_refund' },
            action: 'allow',
            evidence: { requires: ['orders.lookup'] },
          },
        ],
      })
      const governed = new GovernedForwarder(inner, policy, { evidenceStore: store })

      const result = await governed.forward(toolsCallWithSession('process_refund', 'session-1'))
      expect(inner.forward).not.toHaveBeenCalled()

      const error = errorFromResult(result)
      expect(error.data['reason']).toBe('evidence_expired')
      expect(error.data['expired_evidence']).toEqual(['orders.lookup'])
      expect(error.data['suggestion']).toContain('expired')
    })

    it('refreshes evidence key allowlist on hot-reload', async () => {
      const inner = mockForwarder()
      const store = new EvidenceStore({ cleanupIntervalMs: 0 })
      const initialPolicy = compile({
        default: 'deny',
        rules: [
          {
            name: 'refund-with-evidence',
            match: { tool: 'process_refund' },
            action: 'allow',
            evidence: { requires: ['old.lookup'] },
          },
        ],
      })
      const governed = new GovernedForwarder(inner, initialPolicy, { evidenceStore: store })
      const reloadedPolicy = compile({
        default: 'deny',
        rules: [
          {
            name: 'refund-with-evidence',
            match: { tool: 'process_refund' },
            action: 'allow',
            evidence: { requires: ['new.lookup'] },
          },
        ],
      })

      governed.updatePolicy(reloadedPolicy)
      store.putEvidence('session-1', {
        evidence_key: 'old.lookup',
        data: {},
        tool_name: 'old_tool',
      })
      store.putEvidence('session-1', {
        evidence_key: 'new.lookup',
        data: {},
        tool_name: 'new_tool',
      })

      const result = await governed.forward(toolsCallWithSession('process_refund', 'session-1'))
      expect(result.response.status).toBe(200)
      expect(inner.forward).toHaveBeenCalledTimes(1)
      expect(store.hasSeenEvidence('session-1', 'old.lookup')).toBe(false)
      expect(store.hasSeenEvidence('session-1', 'new.lookup')).toBe(true)
    })

    it('blocks when multiple requirements are partially satisfied', async () => {
      const inner = mockForwarder()
      const store = new EvidenceStore({ cleanupIntervalMs: 0 })
      store.putEvidence('s1', { evidence_key: 'a', data: {}, tool_name: 't' })
      // 'b' is missing

      const policy = compile({
        default: 'deny',
        rules: [
          {
            match: { tool: 'action' },
            action: 'allow',
            evidence: { requires: ['a', 'b'] },
          },
        ],
      })
      const governed = new GovernedForwarder(inner, policy, { evidenceStore: store })

      const result = await governed.forward(toolsCallWithSession('action', 's1'))
      expect(inner.forward).not.toHaveBeenCalled()

      const error = errorFromResult(result)
      expect(error.data['missing_evidence']).toEqual(['b'])
    })
  })

  // -----------------------------------------------------------------------
  // Dependency chains
  // -----------------------------------------------------------------------

  describe('dependency chains', () => {
    it('allows action when required tool has been called', async () => {
      const inner = mockForwarder()
      const store = new EvidenceStore({ cleanupIntervalMs: 0 })
      store.recordToolCall('s1', 'orders.lookup', true)

      const policy = compile({
        default: 'deny',
        rules: [
          {
            match: { tool: 'process_refund' },
            action: 'allow',
            requires: ['orders.lookup'],
          },
        ],
      })
      const governed = new GovernedForwarder(inner, policy, { evidenceStore: store })

      const result = await governed.forward(toolsCallWithSession('process_refund', 's1'))
      expect(inner.forward).toHaveBeenCalled()
      expect(result.response.status).toBe(200)
    })

    it('blocks action when required tool has not been called', async () => {
      const inner = mockForwarder()
      const store = new EvidenceStore({ cleanupIntervalMs: 0 })

      const policy = compile({
        default: 'deny',
        rules: [
          {
            match: { tool: 'process_refund' },
            action: 'allow',
            requires: ['orders.lookup'],
          },
        ],
      })
      const governed = new GovernedForwarder(inner, policy, { evidenceStore: store })

      const result = await governed.forward(toolsCallWithSession('process_refund', 's1'))
      expect(inner.forward).not.toHaveBeenCalled()

      const error = errorFromResult(result)
      expect(error.data['reason']).toBe('dependency_missing')
      expect(error.data['missing_dependencies']).toEqual(['orders.lookup'])
      expect(error.data['suggestion']).toContain('orders.lookup')
    })

    it('records tool call after forwarding', async () => {
      const inner = mockForwarder()
      const store = new EvidenceStore({ cleanupIntervalMs: 0 })

      const policy = compile({
        default: 'allow',
        rules: [],
      })
      const governed = new GovernedForwarder(inner, policy, { evidenceStore: store })

      await governed.forward(toolsCallWithSession('get_order', 's1'))
      expect(store.hasCompletedTool('s1', 'get_order')).toBe(true)
    })

    it('records tool call even when upstream returns error', async () => {
      const inner = mockForwarder(
        successResult({
          jsonrpc: '2.0',
          id: 1,
          error: { code: -1, message: 'upstream failed' },
        }),
      )
      const store = new EvidenceStore({ cleanupIntervalMs: 0 })

      const policy = compile({ default: 'allow', rules: [] })
      const governed = new GovernedForwarder(inner, policy, { evidenceStore: store })

      await governed.forward(toolsCallWithSession('failing_tool', 's1'))
      expect(store.hasCompletedTool('s1', 'failing_tool')).toBe(true)
    })

    it('blocks action when the only prior dependency call failed upstream', async () => {
      const inner = mockForwarder()
      const store = new EvidenceStore({ cleanupIntervalMs: 0 })
      store.recordToolCall('s1', 'orders.lookup', false)

      const policy = compile({
        default: 'deny',
        rules: [
          {
            match: { tool: 'process_refund' },
            action: 'allow',
            requires: ['orders.lookup'],
          },
        ],
      })
      const governed = new GovernedForwarder(inner, policy, { evidenceStore: store })

      const result = await governed.forward(toolsCallWithSession('process_refund', 's1'))
      expect(inner.forward).not.toHaveBeenCalled()

      const error = errorFromResult(result)
      expect(error.data['reason']).toBe('dependency_missing')
      expect(error.data['missing_dependencies']).toEqual(['orders.lookup'])
    })

    it('keeps the dependency satisfied when a satisfied tool is later retried and fails', async () => {
      const inner = mockForwarder()
      const store = new EvidenceStore({ cleanupIntervalMs: 0 })
      store.recordToolCall('s1', 'orders.lookup', true)
      store.recordToolCall('s1', 'orders.lookup', false) // retry with a bad arg

      const policy = compile({
        default: 'deny',
        rules: [
          {
            match: { tool: 'process_refund' },
            action: 'allow',
            requires: ['orders.lookup'],
          },
        ],
      })
      const governed = new GovernedForwarder(inner, policy, { evidenceStore: store })

      const result = await governed.forward(toolsCallWithSession('process_refund', 's1'))
      expect(inner.forward).toHaveBeenCalled()
      expect(result.response.status).toBe(200)
    })

    it('allows action when the rule opts out via requires_success: false', async () => {
      const inner = mockForwarder()
      const store = new EvidenceStore({ cleanupIntervalMs: 0 })
      store.recordToolCall('s1', 'orders.lookup', false)

      const policy = compile({
        default: 'deny',
        rules: [
          {
            match: { tool: 'process_refund' },
            action: 'allow',
            requires: ['orders.lookup'],
            requires_success: false,
          },
        ],
      })
      const governed = new GovernedForwarder(inner, policy, { evidenceStore: store })

      const result = await governed.forward(toolsCallWithSession('process_refund', 's1'))
      expect(inner.forward).toHaveBeenCalled()
      expect(result.response.status).toBe(200)
    })
  })

  // -----------------------------------------------------------------------
  // Evidence on require_approval
  // -----------------------------------------------------------------------

  describe('evidence on require_approval', () => {
    it('blocks require_approval when evidence is missing', async () => {
      const inner = mockForwarder()
      const store = new EvidenceStore({ cleanupIntervalMs: 0 })

      const policy = compile({
        default: 'deny',
        rules: [
          {
            name: 'approve-with-evidence',
            match: { tool: 'process_refund' },
            action: 'require_approval',
            evidence: { requires: ['orders.lookup'] },
          },
        ],
      })
      const governed = new GovernedForwarder(inner, policy, { evidenceStore: store })

      const result = await governed.forward(toolsCallWithSession('process_refund', 's1'))
      // Should be blocked by evidence check, NOT routed to approval
      const error = errorFromResult(result)
      expect(error.data['reason']).toBe('evidence_missing')
      expect(error.data['missing_evidence']).toEqual(['orders.lookup'])
    })

    it('proceeds with require_approval when evidence is satisfied', async () => {
      const inner = mockForwarder()
      const store = new EvidenceStore({ cleanupIntervalMs: 0 })
      store.putEvidence('s1', { evidence_key: 'orders.lookup', data: {}, tool_name: 'get_order' })

      const policy = compile({
        default: 'deny',
        rules: [
          {
            match: { tool: 'process_refund' },
            action: 'require_approval',
            evidence: { requires: ['orders.lookup'] },
          },
        ],
      })
      const governed = new GovernedForwarder(inner, policy, { evidenceStore: store })

      const result = await governed.forward(toolsCallWithSession('process_refund', 's1'))
      // Should NOT be blocked by evidence — should proceed to the "unsupported" path
      // (require_approval is not yet implemented, so it returns an unsupported error)
      const error = errorFromResult(result)
      expect(error.data['unsupported']).toBe(true)
    })
  })

  // -----------------------------------------------------------------------
  // Combined evidence + dependencies
  // -----------------------------------------------------------------------

  describe('combined evidence and dependencies', () => {
    it('requires both evidence and dependencies to be satisfied', async () => {
      const inner = mockForwarder()
      const store = new EvidenceStore({ cleanupIntervalMs: 0 })
      store.putEvidence('s1', { evidence_key: 'orders.lookup', data: {}, tool_name: 'get_order' })
      // Dependency 'verify_customer' NOT recorded

      const policy = compile({
        default: 'deny',
        rules: [
          {
            match: { tool: 'process_refund' },
            action: 'allow',
            evidence: { requires: ['orders.lookup'] },
            requires: ['verify_customer'],
          },
        ],
      })
      const governed = new GovernedForwarder(inner, policy, { evidenceStore: store })

      const result = await governed.forward(toolsCallWithSession('process_refund', 's1'))
      expect(inner.forward).not.toHaveBeenCalled()

      const error = errorFromResult(result)
      expect(error.data['reason']).toBe('dependency_missing')
      expect(error.data['missing_dependencies']).toEqual(['verify_customer'])
    })

    it('evidence is checked first — fails on evidence before reaching dependencies', async () => {
      const inner = mockForwarder()
      const store = new EvidenceStore({ cleanupIntervalMs: 0 })
      // Neither evidence nor dependency satisfied

      const policy = compile({
        default: 'deny',
        rules: [
          {
            match: { tool: 'process_refund' },
            action: 'allow',
            evidence: { requires: ['orders.lookup'] },
            requires: ['verify_customer'],
          },
        ],
      })
      const governed = new GovernedForwarder(inner, policy, { evidenceStore: store })

      const result = await governed.forward(toolsCallWithSession('process_refund', 's1'))
      const error = errorFromResult(result)
      // Evidence check fails first
      expect(error.data['reason']).toBe('evidence_missing')
      expect(error.data['missing_evidence']).toEqual(['orders.lookup'])
    })
  })

  // -----------------------------------------------------------------------
  // No session ID — grounded rules fail closed
  // -----------------------------------------------------------------------

  describe('no session ID', () => {
    it('denies evidence-gated rules when request has no sessionId', async () => {
      const inner = mockForwarder()
      const store = new EvidenceStore({ cleanupIntervalMs: 0 })

      const policy = compile({
        default: 'deny',
        rules: [
          {
            match: { tool: 'process_refund' },
            action: 'allow',
            evidence: { requires: ['orders.lookup'] },
          },
        ],
      })
      const governed = new GovernedForwarder(inner, policy, { evidenceStore: store })

      const result = await governed.forward(toolsCallRequest('process_refund'))
      expect(inner.forward).not.toHaveBeenCalled()
      const error = errorFromResult(result)
      expect(error.data['reason']).toBe('policy_denied')
      expect(error.message).toContain('Mcp-Session-Id')
    })
  })

  // -----------------------------------------------------------------------
  // Audit trail — evidence_chain
  // -----------------------------------------------------------------------

  describe('audit trail evidence_chain', () => {
    it('populates evidence_chain when evidence checks run', async () => {
      const inner = mockForwarder()
      const auditStore = new AuditStore({
        path: ':memory:',
        retention: '90d',
        includeResponses: true,
        cleanupIntervalMs: 0,
      })
      const auditWriter = new AuditWriter({ store: auditStore, flushIntervalMs: 0 })
      const evidenceStore = new EvidenceStore({ cleanupIntervalMs: 0 })
      evidenceStore.putEvidence('s1', {
        evidence_key: 'orders.lookup',
        data: { id: 1 },
        tool_name: 'get_order',
      })

      const policy = compile({
        default: 'deny',
        rules: [
          {
            name: 'refund-rule',
            match: { tool: 'process_refund' },
            action: 'allow',
            evidence: { requires: ['orders.lookup'] },
          },
        ],
      })
      const governed = new GovernedForwarder(inner, policy, { auditWriter, evidenceStore })

      await governed.forward(toolsCallWithSession('process_refund', 's1'))
      auditWriter.flush()

      const records = auditStore.list({}).records
      expect(records).toHaveLength(1)

      const record = records[0] as (typeof records)[number]
      const chain = record.evidence_chain as Record<string, unknown>
      expect(chain).not.toBeNull()
      expect(chain['blocked']).toBe(false)

      const evidence = chain['evidence'] as Record<string, unknown>
      expect(evidence['found']).toEqual(['orders.lookup'])
      expect(evidence['missing']).toEqual([])

      auditWriter.close()
    })

    it('evidence_chain is null when no evidence requirements on rule', async () => {
      const inner = mockForwarder()
      const auditStore = new AuditStore({
        path: ':memory:',
        retention: '90d',
        includeResponses: true,
        cleanupIntervalMs: 0,
      })
      const auditWriter = new AuditWriter({ store: auditStore, flushIntervalMs: 0 })
      const evidenceStore = new EvidenceStore({ cleanupIntervalMs: 0 })

      const policy = compile({
        default: 'allow',
        rules: [],
      })
      const governed = new GovernedForwarder(inner, policy, { auditWriter, evidenceStore })

      await governed.forward(toolsCallWithSession('any_tool', 's1'))
      auditWriter.flush()

      const records = auditStore.list({}).records
      expect(records).toHaveLength(1)
      expect((records[0] as (typeof records)[number]).evidence_chain).toBeNull()

      auditWriter.close()
    })
  })

  // -----------------------------------------------------------------------
  // break-glass approval outcome
  // -----------------------------------------------------------------------

  describe('break-glass approval outcome', () => {
    function createAudit() {
      const auditStore = new AuditStore({
        path: ':memory:',
        retention: '90d',
        includeResponses: true,
        cleanupIntervalMs: 0,
      })
      const auditWriter = new AuditWriter({ store: auditStore, flushIntervalMs: 0 })
      return { auditStore, auditWriter }
    }

    it('break_glass outcome forwards request upstream', async () => {
      const inner = mockForwarder()
      const policy = compile({
        default: 'allow',
        rules: [
          {
            match: { tool: 'deploy_production' },
            action: 'require_approval',
            approval: { channel: 'dashboard' },
          },
        ],
      })

      const queue = new ApprovalQueue({ cleanupIntervalMs: 0 })
      const channels = new Map<string, ApprovalChannel>([['dashboard', new QueueChannel()]])
      const approvalRouter = new ApprovalRouter({
        defaultTimeoutMs: 300_000,
        defaultOnTimeout: 'deny',
        channels,
        queue,
      })

      const governed = new GovernedForwarder(inner, policy, { approvalRouter })

      // Submit and break-glass in parallel
      const resultPromise = governed.forward(toolsCallRequest('deploy_production', { env: 'prod' }))

      // Break-glass the pending ticket
      const pending = queue.listPending()
      expect(pending).toHaveLength(1)
      const ticketId = pending[0]?.id as string
      approvalRouter.breakGlass(ticketId, 'admin', 'Emergency hotfix')

      const result = await resultPromise

      // Should have forwarded upstream
      expect(inner.forward).toHaveBeenCalled()
      expect(result.response.status).toBe(200)

      approvalRouter.close()
    })

    it('break_glass audit record has break_glass status and evidence_chain metadata', async () => {
      const inner = mockForwarder()
      const { auditStore, auditWriter } = createAudit()
      const policy = compile({
        default: 'allow',
        rules: [
          {
            match: { tool: 'deploy_production' },
            action: 'require_approval',
            approval: { channel: 'dashboard' },
          },
        ],
      })

      const queue = new ApprovalQueue({ cleanupIntervalMs: 0 })
      const channels = new Map<string, ApprovalChannel>([['dashboard', new QueueChannel()]])
      const approvalRouter = new ApprovalRouter({
        defaultTimeoutMs: 300_000,
        defaultOnTimeout: 'deny',
        channels,
        queue,
      })

      const governed = new GovernedForwarder(inner, policy, { approvalRouter, auditWriter })

      const resultPromise = governed.forward(toolsCallRequest('deploy_production', { env: 'prod' }))

      const pending = queue.listPending()
      const ticketId = pending[0]?.id as string
      approvalRouter.breakGlass(ticketId, 'admin', 'Emergency hotfix')

      await resultPromise
      auditWriter.flush()

      const { records } = auditStore.list()
      expect(records).toHaveLength(1)
      const record = records[0]
      expect(record).toBeDefined()
      expect(record?.approval_status).toBe('break_glass')
      expect(record?.approved_by).toBe('admin')
      expect(record?.policy_decision).toBe('require_approval')

      // evidence_chain should contain break_glass metadata
      const chain = record?.evidence_chain as Record<string, unknown>
      expect(chain).not.toBeNull()
      const breakGlass = chain['break_glass'] as { reason: string; invoked_by: string }
      expect(breakGlass.reason).toBe('Emergency hotfix')
      expect(breakGlass.invoked_by).toBe('admin')

      // Upstream should have been forwarded
      expect(record?.upstream_response).not.toBeNull()
      expect(record?.total_duration_ms).toBeGreaterThanOrEqual(0)
      expect(record?.approval_wait_ms).toBeGreaterThanOrEqual(0)
      expect(record?.proxy_compute_ms).toBeGreaterThanOrEqual(0)

      auditWriter.close()
      approvalRouter.close()
    })

    it('records approval_wait_ms separately from proxy_compute_ms', async () => {
      const inner = mockForwarder({
        response: {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: {
            jsonrpc: '2.0',
            id: 1,
            result: { content: [{ type: 'text', text: 'ok' }] },
          },
        },
        durationMs: 0,
      })
      const { auditStore, auditWriter } = createAudit()
      const policy = compile({
        default: 'allow',
        rules: [
          {
            match: { tool: 'deploy_production' },
            action: 'require_approval',
            approval: { channel: 'dashboard' },
          },
        ],
      })

      const queue = new ApprovalQueue({ cleanupIntervalMs: 0 })
      const channels = new Map<string, ApprovalChannel>([['dashboard', new QueueChannel()]])
      const approvalRouter = new ApprovalRouter({
        defaultTimeoutMs: 300_000,
        defaultOnTimeout: 'deny',
        channels,
        queue,
      })

      const governed = new GovernedForwarder(inner, policy, { approvalRouter, auditWriter })
      const resultPromise = governed.forward(toolsCallRequest('deploy_production', { env: 'prod' }))

      const pending = queue.listPending()
      const ticketId = pending[0]?.id as string
      await new Promise((resolve) => setTimeout(resolve, 40))
      approvalRouter.approve(ticketId, 'admin')

      await resultPromise
      auditWriter.flush()

      const { records } = auditStore.list()
      const record = records[0]
      expect(record).toBeDefined()
      expect(record?.approval_wait_ms).toBeGreaterThanOrEqual(30)
      expect(record?.upstream_latency_ms).toBe(0)
      expect(record?.proxy_compute_ms).toBeGreaterThanOrEqual(0)
      const reconstructedTotal =
        (record?.approval_wait_ms ?? 0) +
        (record?.upstream_latency_ms ?? 0) +
        (record?.proxy_compute_ms ?? 0)
      expect(Math.abs((record?.total_duration_ms ?? 0) - reconstructedTotal)).toBeLessThan(10)

      auditWriter.close()
      approvalRouter.close()
    })
  })

  // -----------------------------------------------------------------------
  // client_disconnected approval outcome
  // -----------------------------------------------------------------------

  describe('client_disconnected approval outcome', () => {
    it('returns client_disconnected feedback and skips upstream forward', async () => {
      const inner = mockForwarder()
      const policy = compile({
        default: 'allow',
        rules: [
          {
            match: { tool: 'deploy_production' },
            action: 'require_approval',
            approval: { channel: 'dashboard' },
          },
        ],
      })

      const queue = new ApprovalQueue({ cleanupIntervalMs: 0 })
      const channels = new Map<string, ApprovalChannel>([['dashboard', new QueueChannel()]])
      const approvalRouter = new ApprovalRouter({
        defaultTimeoutMs: 300_000,
        defaultOnTimeout: 'deny',
        channels,
        queue,
      })
      const governed = new GovernedForwarder(inner, policy, { approvalRouter })
      const controller = new AbortController()

      const request: McpRequest = {
        ...toolsCallRequest('deploy_production', { env: 'prod' }),
        signal: controller.signal,
      }
      const resultPromise = governed.forward(request)
      const ticketId = queue.listPending()[0]?.id as string
      controller.abort()

      const result = await resultPromise
      const error = errorFromResult(result)
      expect(inner.forward).not.toHaveBeenCalled()
      expect(error.data['reason']).toBe('client_disconnected')
      expect(queue.get(ticketId)?.status).toBe('client_disconnected')
    })

    it('writes audit row with block_reason and approval_status set to client_disconnected', async () => {
      const inner = mockForwarder()
      const policy = compile({
        default: 'allow',
        rules: [
          {
            match: { tool: 'deploy_production' },
            action: 'require_approval',
            approval: { channel: 'dashboard' },
          },
        ],
      })

      const store = new AuditStore({
        path: ':memory:',
        retention: '90d',
        includeResponses: true,
        cleanupIntervalMs: 0,
      })
      const writer = new AuditWriter({ store, flushIntervalMs: 0 })

      const queue = new ApprovalQueue({ cleanupIntervalMs: 0 })
      const channels = new Map<string, ApprovalChannel>([['dashboard', new QueueChannel()]])
      const approvalRouter = new ApprovalRouter({
        defaultTimeoutMs: 300_000,
        defaultOnTimeout: 'deny',
        channels,
        queue,
      })
      const governed = new GovernedForwarder(inner, policy, {
        approvalRouter,
        auditWriter: writer,
      })
      const controller = new AbortController()

      const request: McpRequest = {
        ...toolsCallRequest('deploy_production', { env: 'prod' }),
        signal: controller.signal,
      }
      const resultPromise = governed.forward(request)
      controller.abort()
      await resultPromise

      writer.flush()
      expect(store.count()).toBe(1)

      const { records } = store.list()
      expect(records[0]).toBeDefined()
      expect(records[0]?.tool_name).toBe('deploy_production')
      expect(records[0]?.policy_decision).toBe('require_approval')
      expect(records[0]?.block_reason).toBe('client_disconnected')
      expect(records[0]?.approval_status).toBe('client_disconnected')
    })

    it('skips upstream when client aborts after approval resolution', async () => {
      const inner = mockForwarder()
      const policy = compile({
        default: 'allow',
        rules: [
          {
            match: { tool: 'deploy_production' },
            action: 'require_approval',
            approval: { channel: 'dashboard' },
          },
        ],
      })

      const queue = new ApprovalQueue({ cleanupIntervalMs: 0 })
      const channels = new Map<string, ApprovalChannel>([['dashboard', new QueueChannel()]])
      const approvalRouter = new ApprovalRouter({
        defaultTimeoutMs: 300_000,
        defaultOnTimeout: 'deny',
        channels,
        queue,
      })
      const governed = new GovernedForwarder(inner, policy, { approvalRouter })
      const controller = new AbortController()

      const request: McpRequest = {
        ...toolsCallRequest('deploy_production', { env: 'prod' }),
        signal: controller.signal,
      }
      const resultPromise = governed.forward(request)
      const ticketId = queue.listPending()[0]?.id as string
      approvalRouter.approve(ticketId, 'admin')
      controller.abort()

      const result = await resultPromise
      const error = errorFromResult(result)
      expect(inner.forward).not.toHaveBeenCalled()
      expect(error.data['reason']).toBe('client_disconnected')
      expect(queue.get(ticketId)?.status).toBe('approved')
    })

    it('skips timeout-allow forwarding when signal aborts before continuation', async () => {
      vi.useFakeTimers()
      try {
        const inner = mockForwarder()
        const policy = compile({
          default: 'allow',
          rules: [
            {
              match: { tool: 'deploy_production' },
              action: 'require_approval',
              approval: { channel: 'dashboard', timeout: '1s' },
            },
          ],
        })

        const queue = new ApprovalQueue({ cleanupIntervalMs: 0 })
        const channels = new Map<string, ApprovalChannel>([['dashboard', new QueueChannel()]])
        const approvalRouter = new ApprovalRouter({
          defaultTimeoutMs: 1_000,
          defaultOnTimeout: 'allow',
          channels,
          queue,
        })
        const governed = new GovernedForwarder(inner, policy, { approvalRouter })
        const controller = new AbortController()

        const request: McpRequest = {
          ...toolsCallRequest('deploy_production', { env: 'prod' }),
          signal: controller.signal,
        }
        const resultPromise = governed.forward(request)

        vi.advanceTimersByTime(1_001)
        controller.abort()

        const result = await resultPromise
        const error = errorFromResult(result)
        expect(inner.forward).not.toHaveBeenCalled()
        expect(error.data['reason']).toBe('client_disconnected')
      } finally {
        vi.useRealTimers()
      }
    })
  })

  // -----------------------------------------------------------------------
  // shutdown_cancelled approval outcome
  // -----------------------------------------------------------------------

  describe('shutdown_cancelled approval outcome', () => {
    it('returns shutdown_cancelled feedback and skips upstream forward', async () => {
      const inner = mockForwarder()
      const policy = compile({
        default: 'allow',
        rules: [
          {
            match: { tool: 'deploy_production' },
            action: 'require_approval',
            approval: { channel: 'dashboard' },
          },
        ],
      })

      const queue = new ApprovalQueue({ cleanupIntervalMs: 0 })
      const channels = new Map<string, ApprovalChannel>([['dashboard', new QueueChannel()]])
      const approvalRouter = new ApprovalRouter({
        defaultTimeoutMs: 300_000,
        defaultOnTimeout: 'allow',
        channels,
        queue,
      })
      const governed = new GovernedForwarder(inner, policy, { approvalRouter })

      const resultPromise = governed.forward(toolsCallRequest('deploy_production', { env: 'prod' }))
      const ticketId = queue.listPending()[0]?.id as string
      approvalRouter.close()

      const result = await resultPromise
      const error = errorFromResult(result)
      expect(inner.forward).not.toHaveBeenCalled()
      expect(error.message).toBe('Approval cancelled by proxy shutdown')
      expect(error.data['reason']).toBe('shutdown_cancelled')
      expect(queue.get(ticketId)?.status).toBe('shutdown_cancelled')
    })

    it('writes audit row with block_reason and approval_status set to shutdown_cancelled', async () => {
      const inner = mockForwarder()
      const policy = compile({
        default: 'allow',
        rules: [
          {
            match: { tool: 'deploy_production' },
            action: 'require_approval',
            approval: { channel: 'dashboard' },
          },
        ],
      })

      const store = new AuditStore({
        path: ':memory:',
        retention: '90d',
        includeResponses: true,
        cleanupIntervalMs: 0,
      })
      const writer = new AuditWriter({ store, flushIntervalMs: 0 })

      const queue = new ApprovalQueue({ cleanupIntervalMs: 0 })
      const channels = new Map<string, ApprovalChannel>([['dashboard', new QueueChannel()]])
      const approvalRouter = new ApprovalRouter({
        defaultTimeoutMs: 300_000,
        defaultOnTimeout: 'allow',
        channels,
        queue,
      })
      const governed = new GovernedForwarder(inner, policy, {
        approvalRouter,
        auditWriter: writer,
      })

      const resultPromise = governed.forward(toolsCallRequest('deploy_production', { env: 'prod' }))
      approvalRouter.close()
      await resultPromise

      writer.flush()
      expect(store.count()).toBe(1)

      const { records } = store.list()
      expect(records[0]).toBeDefined()
      expect(records[0]?.tool_name).toBe('deploy_production')
      expect(records[0]?.policy_decision).toBe('require_approval')
      expect(records[0]?.block_reason).toBe('shutdown_cancelled')
      expect(records[0]?.approval_status).toBe('shutdown_cancelled')
    })
  })

  // -----------------------------------------------------------------------
  // Rate limit action
  // -----------------------------------------------------------------------

  describe('rate_limit action', () => {
    function createRateLimiter() {
      let time = 1_000_000
      const advance = (ms: number) => {
        time += ms
      }
      const limiter = new RateLimiter({ now: () => time, cleanupIntervalMs: 0 })
      return { limiter, advance }
    }

    function createAuditForRateLimit() {
      const auditStore = new AuditStore({
        path: ':memory:',
        retention: '90d',
        includeResponses: true,
        cleanupIntervalMs: 0,
      })
      const auditWriter = new AuditWriter({ store: auditStore, flushIntervalMs: 0 })
      return { auditStore, auditWriter }
    }

    it('forwards request when under the rate limit', async () => {
      const inner = mockForwarder()
      const { limiter } = createRateLimiter()
      const policy = compile({
        default: 'allow',
        rules: [
          {
            name: 'rate-limit-weather',
            match: { tool: 'get_weather' },
            action: 'rate_limit',
            limits: { max_calls: 3, window: '1m', key: 'tool' },
          },
        ],
      })
      const governed = new GovernedForwarder(inner, policy, { rateLimiter: limiter })

      const result = await governed.forward(toolsCallRequest('get_weather', { city: 'London' }))
      expect(inner.forward).toHaveBeenCalled()
      expect(result.response.status).toBe(200)
    })

    it('blocks request when rate limit exceeded with feedback', async () => {
      const inner = mockForwarder()
      const { limiter } = createRateLimiter()
      const policy = compile({
        default: 'allow',
        rules: [
          {
            name: 'rate-limit-weather',
            match: { tool: 'get_weather' },
            action: 'rate_limit',
            limits: { max_calls: 2, window: '1m', key: 'tool' },
          },
        ],
      })
      const governed = new GovernedForwarder(inner, policy, { rateLimiter: limiter })

      // Two calls within limit
      await governed.forward(toolsCallRequest('get_weather', {}, 1))
      await governed.forward(toolsCallRequest('get_weather', {}, 2))
      expect(inner.forward).toHaveBeenCalledTimes(2)

      // Third call should be blocked
      inner.forward.mockClear()
      const result = await governed.forward(toolsCallRequest('get_weather', {}, 3))
      expect(inner.forward).not.toHaveBeenCalled()

      const error = errorFromResult(result)
      expect(error.code).toBe(-32001)
      expect(error.data['blocked']).toBe(true)
      expect(error.data['reason']).toBe('rate_limited')
      expect(error.data['action']).toBe('rate_limit')
      expect(error.data['retry_allowed']).toBe(true)
      expect(error.data['current_calls']).toBe(2)
      expect(error.data['max_calls']).toBe(2)
      expect(error.data['window_seconds']).toBe(60)
      expect(error.data['reset_at']).toBeDefined()
    })

    it('isolates limits per tool name with key: tool', async () => {
      const inner = mockForwarder()
      const { limiter } = createRateLimiter()
      const policy = compile({
        default: 'allow',
        rules: [
          {
            match: { tool: '*' },
            action: 'rate_limit',
            limits: { max_calls: 1, window: '1m', key: 'tool' },
          },
        ],
      })
      const governed = new GovernedForwarder(inner, policy, { rateLimiter: limiter })

      // tool A uses its slot
      await governed.forward(toolsCallRequest('tool_a'))
      expect(inner.forward).toHaveBeenCalledTimes(1)

      // tool B should still have its own slot
      await governed.forward(toolsCallRequest('tool_b'))
      expect(inner.forward).toHaveBeenCalledTimes(2)

      // tool A is now blocked
      inner.forward.mockClear()
      const result = await governed.forward(toolsCallRequest('tool_a'))
      expect(inner.forward).not.toHaveBeenCalled()
      expect(errorFromResult(result).data['reason']).toBe('rate_limited')
    })

    it('isolates limits per session with key: session', async () => {
      const inner = mockForwarder()
      const { limiter } = createRateLimiter()
      const policy = compile({
        default: 'allow',
        rules: [
          {
            match: { tool: 'get_weather' },
            action: 'rate_limit',
            limits: { max_calls: 1, window: '1m', key: 'session' },
          },
        ],
      })
      const governed = new GovernedForwarder(inner, policy, { rateLimiter: limiter })

      // Session A
      await governed.forward(toolsCallWithSession('get_weather', 'sess-a'))
      expect(inner.forward).toHaveBeenCalledTimes(1)

      // Session B — independent limit
      await governed.forward(toolsCallWithSession('get_weather', 'sess-b'))
      expect(inner.forward).toHaveBeenCalledTimes(2)

      // Session A blocked
      inner.forward.mockClear()
      const result = await governed.forward(toolsCallWithSession('get_weather', 'sess-a'))
      expect(inner.forward).not.toHaveBeenCalled()
      expect(errorFromResult(result).data['reason']).toBe('rate_limited')
    })

    it('allows calls again after window slides', async () => {
      const inner = mockForwarder()
      const { limiter, advance } = createRateLimiter()
      const policy = compile({
        default: 'allow',
        rules: [
          {
            match: { tool: 'get_weather' },
            action: 'rate_limit',
            limits: { max_calls: 1, window: '1m', key: 'tool' },
          },
        ],
      })
      const governed = new GovernedForwarder(inner, policy, { rateLimiter: limiter })

      await governed.forward(toolsCallRequest('get_weather'))
      expect(inner.forward).toHaveBeenCalledTimes(1)

      // Blocked
      inner.forward.mockClear()
      const blocked = await governed.forward(toolsCallRequest('get_weather'))
      expect(errorFromResult(blocked).data['reason']).toBe('rate_limited')

      // Advance past window
      advance(60_001)

      // Should be allowed again
      const result = await governed.forward(toolsCallRequest('get_weather'))
      expect(inner.forward).toHaveBeenCalled()
      expect(result.response.status).toBe(200)
    })

    it('records audit with policy_decision rate_limit for allowed calls', async () => {
      const inner = mockForwarder()
      const { limiter } = createRateLimiter()
      const { auditStore, auditWriter } = createAuditForRateLimit()
      const policy = compile({
        default: 'allow',
        rules: [
          {
            name: 'rl-test',
            match: { tool: 'get_weather' },
            action: 'rate_limit',
            limits: { max_calls: 5, window: '1m', key: 'tool' },
          },
        ],
      })
      const governed = new GovernedForwarder(inner, policy, {
        rateLimiter: limiter,
        auditWriter,
      })

      await governed.forward(toolsCallRequest('get_weather'))
      auditWriter.flush()

      const { records } = auditStore.list()
      expect(records).toHaveLength(1)
      expect(records[0]?.policy_decision).toBe('rate_limit')
      expect(records[0]?.matched_rule).toBe('rl-test')
      // Should have upstream response since it was forwarded
      expect(records[0]?.upstream_response).not.toBeNull()

      auditWriter.close()
    })

    it('includes rate_limit metadata in evidence_chain audit field', async () => {
      const inner = mockForwarder()
      const { limiter } = createRateLimiter()
      const { auditStore, auditWriter } = createAuditForRateLimit()
      const policy = compile({
        default: 'allow',
        rules: [
          {
            match: { tool: 'get_weather' },
            action: 'rate_limit',
            limits: { max_calls: 5, window: '1m', key: 'tool' },
          },
        ],
      })
      const governed = new GovernedForwarder(inner, policy, {
        rateLimiter: limiter,
        auditWriter,
      })

      await governed.forward(toolsCallRequest('get_weather'))
      auditWriter.flush()

      const { records } = auditStore.list()
      const chain = records[0]?.evidence_chain as Record<string, unknown>
      expect(chain).not.toBeNull()
      const rl = chain['rate_limit'] as Record<string, unknown>
      expect(rl['allowed']).toBe(true)
      expect(rl['current']).toBe(1)
      expect(rl['limit']).toBe(5)

      auditWriter.close()
    })

    it('records tool call for dependency tracking when allowed', async () => {
      const inner = mockForwarder()
      const { limiter } = createRateLimiter()
      const evidenceStore = new EvidenceStore({ cleanupIntervalMs: 0 })
      const policy = compile({
        default: 'allow',
        rules: [
          {
            match: { tool: 'get_weather' },
            action: 'rate_limit',
            limits: { max_calls: 5, window: '1m', key: 'tool' },
          },
        ],
      })
      const governed = new GovernedForwarder(inner, policy, {
        rateLimiter: limiter,
        evidenceStore,
      })

      await governed.forward(toolsCallWithSession('get_weather', 's1'))
      expect(evidenceStore.hasCompletedTool('s1', 'get_weather')).toBe(true)
    })

    it('fails closed when limits config is missing on rate_limit rule', async () => {
      const inner = mockForwarder()
      const { limiter } = createRateLimiter()
      const policy = compile({
        default: 'allow',
        rules: [
          {
            match: { tool: 'get_weather' },
            action: 'rate_limit',
            // No limits block
          },
        ],
      })
      const governed = new GovernedForwarder(inner, policy, { rateLimiter: limiter })

      const result = await governed.forward(toolsCallRequest('get_weather'))
      expect(inner.forward).not.toHaveBeenCalled()
      const error = errorFromResult(result)
      expect(error.message).toContain('Policy misconfigured')
      expect(error.message).toContain('limits.max_calls')
    })

    it('updatePolicy preserves rate limit state when the rule config is unchanged', async () => {
      const inner = mockForwarder()
      const { limiter } = createRateLimiter()
      const policy = compile({
        default: 'allow',
        rules: [
          {
            match: { tool: 'get_weather' },
            action: 'rate_limit',
            limits: { max_calls: 1, window: '1m', key: 'tool' },
          },
        ],
      })
      const governed = new GovernedForwarder(inner, policy, { rateLimiter: limiter })

      // Exhaust the limit
      await governed.forward(toolsCallRequest('get_weather', {}, 1))
      inner.forward.mockClear()
      const blocked = await governed.forward(toolsCallRequest('get_weather', {}, 2))
      expect(errorFromResult(blocked).data['reason']).toBe('rate_limited')

      // Hot-reload: swap in an equivalent compiled policy with the same limits.
      // Reconcile should preserve the bucket counter since the tuple matches.
      const reloadedPolicy = compile({
        default: 'allow',
        rules: [
          {
            match: { tool: 'get_weather' },
            action: 'rate_limit',
            limits: { max_calls: 1, window: '1m', key: 'tool' },
          },
        ],
      })
      governed.updatePolicy(reloadedPolicy)

      // Bucket counter was preserved — request is still rate-limited.
      inner.forward.mockClear()
      const stillBlocked = await governed.forward(toolsCallRequest('get_weather', {}, 3))
      expect(inner.forward).not.toHaveBeenCalled()
      expect(errorFromResult(stillBlocked).data['reason']).toBe('rate_limited')
    })

    it('updatePolicy evicts the rate limit bucket when the rule config changed', async () => {
      const inner = mockForwarder()
      const { limiter } = createRateLimiter()
      const policy = compile({
        default: 'allow',
        rules: [
          {
            match: { tool: 'get_weather' },
            action: 'rate_limit',
            limits: { max_calls: 1, window: '1m', key: 'tool' },
          },
        ],
      })
      const governed = new GovernedForwarder(inner, policy, { rateLimiter: limiter })

      // Exhaust the limit
      await governed.forward(toolsCallRequest('get_weather', {}, 1))
      inner.forward.mockClear()
      const blocked = await governed.forward(toolsCallRequest('get_weather', {}, 2))
      expect(errorFromResult(blocked).data['reason']).toBe('rate_limited')

      // Hot-reload: change the rate limit config. Reconcile evicts the stale
      // bucket and the next request is allowed again.
      const updatedPolicy = compile({
        default: 'allow',
        rules: [
          {
            match: { tool: 'get_weather' },
            action: 'rate_limit',
            limits: { max_calls: 5, window: '1m', key: 'tool' },
          },
        ],
      })
      governed.updatePolicy(updatedPolicy)

      const result = await governed.forward(toolsCallRequest('get_weather', {}, 3))
      expect(inner.forward).toHaveBeenCalled()
      expect(result.response.status).toBe(200)
    })

    it('updatePolicy evicts the rate limit bucket when the rule is removed', async () => {
      const inner = mockForwarder()
      const { limiter } = createRateLimiter()
      const policy = compile({
        default: 'allow',
        rules: [
          {
            match: { tool: 'get_weather' },
            action: 'rate_limit',
            limits: { max_calls: 1, window: '1m', key: 'tool' },
          },
        ],
      })
      const governed = new GovernedForwarder(inner, policy, { rateLimiter: limiter })

      await governed.forward(toolsCallRequest('get_weather', {}, 1))
      expect(limiter.getKeyState('tool:get_weather')?.current).toBe(1)

      // Hot-reload: drop the rate limit rule entirely.
      const emptyPolicy = compile({ default: 'allow', rules: [] })
      governed.updatePolicy(emptyPolicy)

      expect(limiter.getKeyState('tool:get_weather')).toBeUndefined()
    })

    it('uses feedback.message from rule when present', async () => {
      const inner = mockForwarder()
      const { limiter } = createRateLimiter()
      const policy = compile({
        default: 'allow',
        rules: [
          {
            match: { tool: 'get_weather' },
            action: 'rate_limit',
            limits: { max_calls: 1, window: '1m', key: 'tool' },
            feedback: { message: 'Slow down, please.' },
          },
        ],
      })
      const governed = new GovernedForwarder(inner, policy, { rateLimiter: limiter })

      await governed.forward(toolsCallRequest('get_weather', {}, 1))
      const result = await governed.forward(toolsCallRequest('get_weather', {}, 2))
      const error = errorFromResult(result)
      expect(error.message).toBe('Slow down, please.')
    })
  })

  // -------------------------------------------------------------------------
  // spend_limit action
  // -------------------------------------------------------------------------

  describe('spend_limit action', () => {
    function createSpendLimiter() {
      let time = 1_000_000
      const advance = (ms: number) => {
        time += ms
      }
      const limiter = new SpendLimiter({ now: () => time, cleanupIntervalMs: 0 })
      return { limiter, advance }
    }

    function createAuditForSpendLimit() {
      const auditStore = new AuditStore({
        path: ':memory:',
        retention: '90d',
        includeResponses: true,
        cleanupIntervalMs: 0,
      })
      const auditWriter = new AuditWriter({ store: auditStore, flushIntervalMs: 0 })
      return { auditStore, auditWriter }
    }

    it('forwards request when spend is within limit', async () => {
      const inner = mockForwarder()
      const { limiter } = createSpendLimiter()
      const policy = compile({
        default: 'allow',
        rules: [
          {
            name: 'spend-limit-payments',
            match: { tool: 'create_payment' },
            action: 'spend_limit',
            limits: {
              max_spend: { field: '$.amount', limit: 5000, currency: 'GBP', window: '24h' },
            },
          },
        ],
      })
      const governed = new GovernedForwarder(inner, policy, { spendLimiter: limiter })

      const result = await governed.forward(toolsCallRequest('create_payment', { amount: 1000 }))
      expect(inner.forward).toHaveBeenCalled()
      expect(result.response.status).toBe(200)
    })

    it('blocks request when cumulative spend exceeds limit', async () => {
      const inner = mockForwarder()
      const { limiter } = createSpendLimiter()
      const policy = compile({
        default: 'allow',
        rules: [
          {
            name: 'spend-limit-payments',
            match: { tool: 'create_payment' },
            action: 'spend_limit',
            limits: {
              max_spend: { field: '$.amount', limit: 5000, currency: 'GBP', window: '24h' },
            },
          },
        ],
      })
      const governed = new GovernedForwarder(inner, policy, { spendLimiter: limiter })

      // Spend 4000 within limit
      await governed.forward(toolsCallRequest('create_payment', { amount: 4000 }, 1))
      expect(inner.forward).toHaveBeenCalledTimes(1)

      // Spend 2000 more — exceeds 5000 limit
      inner.forward.mockClear()
      const result = await governed.forward(toolsCallRequest('create_payment', { amount: 2000 }, 2))
      expect(inner.forward).not.toHaveBeenCalled()

      const error = errorFromResult(result)
      expect(error.code).toBe(-32001)
      expect(error.data['blocked']).toBe(true)
      expect(error.data['reason']).toBe('spend_limited')
      expect(error.data['action']).toBe('spend_limit')
      expect(error.data['retry_allowed']).toBe(true)
      expect(error.data['current_spend']).toBe(4000)
      expect(error.data['max_spend']).toBe(5000)
      expect(error.data['currency']).toBe('GBP')
      expect(error.data['window_seconds']).toBe(86400)
      expect(error.data['reset_at']).toBeDefined()
    })

    it('tracks cumulative spend across multiple calls', async () => {
      const inner = mockForwarder()
      const { limiter } = createSpendLimiter()
      const policy = compile({
        default: 'allow',
        rules: [
          {
            match: { tool: 'create_payment' },
            action: 'spend_limit',
            limits: {
              max_spend: { field: '$.amount', limit: 1000, currency: 'USD', window: '1h' },
            },
          },
        ],
      })
      const governed = new GovernedForwarder(inner, policy, { spendLimiter: limiter })

      await governed.forward(toolsCallRequest('create_payment', { amount: 300 }, 1))
      await governed.forward(toolsCallRequest('create_payment', { amount: 300 }, 2))
      await governed.forward(toolsCallRequest('create_payment', { amount: 300 }, 3))
      expect(inner.forward).toHaveBeenCalledTimes(3)

      // 900 total, next 200 would exceed
      inner.forward.mockClear()
      const result = await governed.forward(toolsCallRequest('create_payment', { amount: 200 }, 4))
      expect(inner.forward).not.toHaveBeenCalled()
      expect(errorFromResult(result).data['reason']).toBe('spend_limited')
    })

    it('allows spend again after window slides', async () => {
      const inner = mockForwarder()
      const { limiter, advance } = createSpendLimiter()
      const policy = compile({
        default: 'allow',
        rules: [
          {
            match: { tool: 'create_payment' },
            action: 'spend_limit',
            limits: {
              max_spend: { field: '$.amount', limit: 500, currency: 'GBP', window: '1h' },
            },
          },
        ],
      })
      const governed = new GovernedForwarder(inner, policy, { spendLimiter: limiter })

      await governed.forward(toolsCallRequest('create_payment', { amount: 500 }, 1))

      // Blocked
      inner.forward.mockClear()
      const blocked = await governed.forward(toolsCallRequest('create_payment', { amount: 100 }, 2))
      expect(errorFromResult(blocked).data['reason']).toBe('spend_limited')

      // Advance past window
      advance(3_600_001)

      // Should be allowed again
      const result = await governed.forward(toolsCallRequest('create_payment', { amount: 100 }, 3))
      expect(inner.forward).toHaveBeenCalled()
      expect(result.response.status).toBe(200)
    })

    it('denies when field does not resolve to a number', async () => {
      const inner = mockForwarder()
      const { limiter } = createSpendLimiter()
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const policy = compile({
        default: 'allow',
        rules: [
          {
            match: { tool: 'create_payment' },
            action: 'spend_limit',
            limits: {
              max_spend: { field: '$.amount', limit: 500, currency: 'GBP', window: '1h' },
            },
          },
        ],
      })
      const governed = new GovernedForwarder(inner, policy, { spendLimiter: limiter })

      // amount is a string, not a number
      const result = await governed.forward(
        toolsCallRequest('create_payment', { amount: 'not-a-number' }),
      )
      expect(inner.forward).not.toHaveBeenCalled()
      expect(errorFromResult(result).data['reason']).toBe('spend_limited')
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('did not resolve to a number'),
      )

      consoleSpy.mockRestore()
    })

    it('denies when field path does not exist in arguments', async () => {
      const inner = mockForwarder()
      const { limiter } = createSpendLimiter()
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const policy = compile({
        default: 'allow',
        rules: [
          {
            match: { tool: 'create_payment' },
            action: 'spend_limit',
            limits: {
              max_spend: { field: '$.cost', limit: 500, currency: 'GBP', window: '1h' },
            },
          },
        ],
      })
      const governed = new GovernedForwarder(inner, policy, { spendLimiter: limiter })

      // No "cost" field in arguments
      const result = await governed.forward(toolsCallRequest('create_payment', { amount: 100 }))
      expect(inner.forward).not.toHaveBeenCalled()
      expect(errorFromResult(result).data['reason']).toBe('spend_limited')
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('did not resolve to a number'),
      )

      consoleSpy.mockRestore()
    })

    it('returns unsupported when no spendLimiter provided', async () => {
      const inner = mockForwarder()
      const policy = compile({
        default: 'allow',
        rules: [
          {
            match: { tool: 'create_payment' },
            action: 'spend_limit',
            limits: {
              max_spend: { field: '$.amount', limit: 500, currency: 'GBP', window: '1h' },
            },
          },
        ],
      })
      // No spendLimiter
      const governed = new GovernedForwarder(inner, policy, {})

      const result = await governed.forward(toolsCallRequest('create_payment', { amount: 100 }))
      expect(inner.forward).not.toHaveBeenCalled()
      const error = errorFromResult(result)
      expect(error.message).toContain('not yet supported')
    })

    it('fails closed when max_spend config is missing on spend_limit rule', async () => {
      const inner = mockForwarder()
      const { limiter } = createSpendLimiter()
      const policy = compile({
        default: 'allow',
        rules: [
          {
            match: { tool: 'create_payment' },
            action: 'spend_limit',
            // No limits.max_spend block
          },
        ],
      })
      const governed = new GovernedForwarder(inner, policy, { spendLimiter: limiter })

      const result = await governed.forward(toolsCallRequest('create_payment', { amount: 100 }))
      expect(inner.forward).not.toHaveBeenCalled()
      const error = errorFromResult(result)
      expect(error.message).toContain('Policy misconfigured')
      expect(error.message).toContain('limits.max_spend')
    })

    it('records audit with spend_limit metadata in evidence_chain', async () => {
      const inner = mockForwarder()
      const { limiter } = createSpendLimiter()
      const { auditStore, auditWriter } = createAuditForSpendLimit()
      const policy = compile({
        default: 'allow',
        rules: [
          {
            match: { tool: 'create_payment' },
            action: 'spend_limit',
            limits: {
              max_spend: { field: '$.amount', limit: 5000, currency: 'GBP', window: '24h' },
            },
          },
        ],
      })
      const governed = new GovernedForwarder(inner, policy, {
        spendLimiter: limiter,
        auditWriter,
      })

      await governed.forward(toolsCallRequest('create_payment', { amount: 1000 }))
      auditWriter.flush()

      const { records } = auditStore.list()
      expect(records).toHaveLength(1)
      expect(records[0]?.policy_decision).toBe('spend_limit')

      const chain = records[0]?.evidence_chain as Record<string, unknown>
      expect(chain).not.toBeNull()
      const sl = chain['spend_limit'] as Record<string, unknown>
      expect(sl['allowed']).toBe(true)
      expect(sl['current_spend']).toBe(1000)
      expect(sl['limit']).toBe(5000)

      auditWriter.close()
    })

    it('extracts amount from nested field path', async () => {
      const inner = mockForwarder()
      const { limiter } = createSpendLimiter()
      const policy = compile({
        default: 'allow',
        rules: [
          {
            match: { tool: 'create_payment' },
            action: 'spend_limit',
            limits: {
              max_spend: {
                field: '$.payment.total',
                limit: 500,
                currency: 'EUR',
                window: '1h',
              },
            },
          },
        ],
      })
      const governed = new GovernedForwarder(inner, policy, { spendLimiter: limiter })

      await governed.forward(toolsCallRequest('create_payment', { payment: { total: 400 } }, 1))
      expect(inner.forward).toHaveBeenCalledTimes(1)

      // 400 + 200 > 500 — should be blocked
      inner.forward.mockClear()
      const result = await governed.forward(
        toolsCallRequest('create_payment', { payment: { total: 200 } }, 2),
      )
      expect(inner.forward).not.toHaveBeenCalled()
      expect(errorFromResult(result).data['reason']).toBe('spend_limited')
    })

    it('updatePolicy preserves spend limit state when the rule config is unchanged', async () => {
      const inner = mockForwarder()
      const { limiter } = createSpendLimiter()
      const policy = compile({
        default: 'allow',
        rules: [
          {
            match: { tool: 'create_payment' },
            action: 'spend_limit',
            limits: {
              max_spend: { field: '$.amount', limit: 500, currency: 'GBP', window: '1h' },
            },
          },
        ],
      })
      const governed = new GovernedForwarder(inner, policy, { spendLimiter: limiter })

      // Exhaust the budget
      await governed.forward(toolsCallRequest('create_payment', { amount: 500 }, 1))
      inner.forward.mockClear()
      const blocked = await governed.forward(toolsCallRequest('create_payment', { amount: 1 }, 2))
      expect(errorFromResult(blocked).data['reason']).toBe('spend_limited')

      // Hot-reload: swap in an equivalent compiled policy with the same limits.
      // Reconcile should preserve the cumulative spend — the bucket stays hot.
      const reloadedPolicy = compile({
        default: 'allow',
        rules: [
          {
            match: { tool: 'create_payment' },
            action: 'spend_limit',
            limits: {
              max_spend: { field: '$.amount', limit: 500, currency: 'GBP', window: '1h' },
            },
          },
        ],
      })
      governed.updatePolicy(reloadedPolicy)

      // Budget was preserved — request is still blocked.
      inner.forward.mockClear()
      const stillBlocked = await governed.forward(
        toolsCallRequest('create_payment', { amount: 1 }, 3),
      )
      expect(inner.forward).not.toHaveBeenCalled()
      expect(errorFromResult(stillBlocked).data['reason']).toBe('spend_limited')
    })

    it('updatePolicy evicts the spend limit bucket when the rule config changed', async () => {
      const inner = mockForwarder()
      const { limiter } = createSpendLimiter()
      const policy = compile({
        default: 'allow',
        rules: [
          {
            match: { tool: 'create_payment' },
            action: 'spend_limit',
            limits: {
              max_spend: { field: '$.amount', limit: 500, currency: 'GBP', window: '1h' },
            },
          },
        ],
      })
      const governed = new GovernedForwarder(inner, policy, { spendLimiter: limiter })

      // Exhaust the budget
      await governed.forward(toolsCallRequest('create_payment', { amount: 500 }, 1))
      inner.forward.mockClear()
      const blocked = await governed.forward(toolsCallRequest('create_payment', { amount: 1 }, 2))
      expect(errorFromResult(blocked).data['reason']).toBe('spend_limited')

      // Hot-reload: raise the budget. Reconcile evicts the stale bucket.
      const updatedPolicy = compile({
        default: 'allow',
        rules: [
          {
            match: { tool: 'create_payment' },
            action: 'spend_limit',
            limits: {
              max_spend: { field: '$.amount', limit: 2000, currency: 'GBP', window: '1h' },
            },
          },
        ],
      })
      governed.updatePolicy(updatedPolicy)

      const result = await governed.forward(toolsCallRequest('create_payment', { amount: 100 }, 3))
      expect(inner.forward).toHaveBeenCalled()
      expect(result.response.status).toBe(200)
    })

    it('updatePolicy evicts the spend limit bucket when the currency changed', async () => {
      const inner = mockForwarder()
      const { limiter } = createSpendLimiter()
      const policy = compile({
        default: 'allow',
        rules: [
          {
            match: { tool: 'create_payment' },
            action: 'spend_limit',
            limits: {
              max_spend: { field: '$.amount', limit: 500, currency: 'GBP', window: '1h' },
            },
          },
        ],
      })
      const governed = new GovernedForwarder(inner, policy, { spendLimiter: limiter })

      await governed.forward(toolsCallRequest('create_payment', { amount: 300 }, 1))
      expect(limiter.getKeyState('tool:create_payment')?.current_spend).toBe(300)

      // Switch currency GBP → EUR while keeping the numeric limit. This is a
      // meaningful policy change — the budget pool resets.
      const eurPolicy = compile({
        default: 'allow',
        rules: [
          {
            match: { tool: 'create_payment' },
            action: 'spend_limit',
            limits: {
              max_spend: { field: '$.amount', limit: 500, currency: 'EUR', window: '1h' },
            },
          },
        ],
      })
      governed.updatePolicy(eurPolicy)

      expect(limiter.getKeyState('tool:create_payment')).toBeUndefined()
    })

    it('uses feedback.message from rule when present', async () => {
      const inner = mockForwarder()
      const { limiter } = createSpendLimiter()
      const policy = compile({
        default: 'allow',
        rules: [
          {
            match: { tool: 'create_payment' },
            action: 'spend_limit',
            limits: {
              max_spend: { field: '$.amount', limit: 100, currency: 'GBP', window: '1h' },
            },
            feedback: { message: 'Budget exceeded for this period.' },
          },
        ],
      })
      const governed = new GovernedForwarder(inner, policy, { spendLimiter: limiter })

      await governed.forward(toolsCallRequest('create_payment', { amount: 100 }, 1))
      const result = await governed.forward(toolsCallRequest('create_payment', { amount: 1 }, 2))
      const error = errorFromResult(result)
      expect(error.message).toBe('Budget exceeded for this period.')
    })

    describe('invalid amount', () => {
      function spendLimitPolicy(limit = 1000) {
        return compile({
          default: 'allow',
          rules: [
            {
              name: 'spend-limit-payments',
              match: { tool: 'create_payment' },
              action: 'spend_limit',
              limits: {
                max_spend: { field: '$.amount', limit, currency: 'GBP', window: '24h' },
              },
            },
          ],
        })
      }

      it('denies negative amount and writes audit with upstream_error', async () => {
        const inner = mockForwarder()
        const { limiter } = createSpendLimiter()
        const { auditStore, auditWriter } = createAuditForSpendLimit()
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        const governed = new GovernedForwarder(inner, spendLimitPolicy(), {
          spendLimiter: limiter,
          auditWriter,
        })

        // Seed a legitimate spend so we can verify the attack audit row carries
        // the real bucket state, not a synthetic zero.
        await governed.forward(toolsCallRequest('create_payment', { amount: 500 }, 1))
        expect(inner.forward).toHaveBeenCalledTimes(1)
        inner.forward.mockClear()

        const result = await governed.forward(
          toolsCallRequest('create_payment', { amount: -100 }, 2),
        )
        expect(inner.forward).not.toHaveBeenCalled()
        const error = errorFromResult(result)
        expect(error.message).toContain('invalid amount')
        expect(error.data['blocked']).toBe(true)
        expect(error.data['reason']).toBe('spend_limited')
        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining('resolved to invalid amount'),
        )

        auditWriter.flush()
        const { records } = auditStore.list()
        expect(records).toHaveLength(2)
        const attackRecord = records.find((r) => r.upstream_error === 'invalid spend amount')
        expect(attackRecord).toBeDefined()
        expect(attackRecord?.policy_decision).toBe('spend_limit')
        expect(attackRecord?.dry_run).toBe(false)
        const chain = attackRecord?.evidence_chain as Record<string, unknown>
        const sl = chain['spend_limit'] as Record<string, unknown>
        expect(sl['allowed']).toBe(false)
        expect(sl['reason']).toBe('invalid_amount')
        // Audit must reflect the real bucket state at attack time, not zero.
        expect(sl['current_spend']).toBe(500)
        expect(sl['limit']).toBe(1000)

        // The current_spend in the user-facing feedback should also reflect
        // the real bucket state, not a synthetic zero.
        expect(error.data['current_spend']).toBe(500)

        auditWriter.close()
        consoleSpy.mockRestore()
      })

      it('denies NaN amount with the same audit signal', async () => {
        const inner = mockForwarder()
        const { limiter } = createSpendLimiter()
        const { auditStore, auditWriter } = createAuditForSpendLimit()
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        const governed = new GovernedForwarder(inner, spendLimitPolicy(), {
          spendLimiter: limiter,
          auditWriter,
        })

        await governed.forward(toolsCallRequest('create_payment', { amount: Number.NaN }))
        expect(inner.forward).not.toHaveBeenCalled()

        auditWriter.flush()
        const { records } = auditStore.list()
        expect(records[0]?.upstream_error).toBe('invalid spend amount')
        const chain = records[0]?.evidence_chain as Record<string, unknown>
        const sl = chain['spend_limit'] as Record<string, unknown>
        expect(sl['reason']).toBe('invalid_amount')

        auditWriter.close()
        consoleSpy.mockRestore()
      })

      it('large negative amount cannot bypass spend cap', async () => {
        const inner = mockForwarder()
        const { limiter } = createSpendLimiter()
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        const governed = new GovernedForwarder(inner, spendLimitPolicy(1000), {
          spendLimiter: limiter,
        })

        // Step 1: seed bucket with legitimate spend
        await governed.forward(toolsCallRequest('create_payment', { amount: 500 }, 1))
        expect(inner.forward).toHaveBeenCalledTimes(1)

        // Step 2: attack with a large negative-amount payload
        inner.forward.mockClear()
        const attack = await governed.forward(
          toolsCallRequest('create_payment', { amount: -9_999_999 }, 2),
        )
        expect(inner.forward).not.toHaveBeenCalled()
        expect(errorFromResult(attack).data['reason']).toBe('spend_limited')
        // Bucket state must still reflect 500 — the attack did not corrupt it
        expect(limiter.getKeyState('tool:create_payment')?.current_spend).toBe(500)

        // Step 3: legitimate follow-up consumes budget normally
        const followUp = await governed.forward(
          toolsCallRequest('create_payment', { amount: 400 }, 3),
        )
        expect(inner.forward).toHaveBeenCalled()
        expect(followUp.response.status).toBe(200)
        expect(limiter.getKeyState('tool:create_payment')?.current_spend).toBe(900)

        // Step 4: exceeding the cap is correctly denied (would be 1100 > 1000)
        inner.forward.mockClear()
        const overflow = await governed.forward(
          toolsCallRequest('create_payment', { amount: 200 }, 4),
        )
        expect(inner.forward).not.toHaveBeenCalled()
        expect(errorFromResult(overflow).data['reason']).toBe('spend_limited')
        expect(limiter.getKeyState('tool:create_payment')?.current_spend).toBe(900)

        consoleSpy.mockRestore()
      })

      it('dry-run with negative amount denies and logs warning without consuming budget', async () => {
        const inner = mockForwarder()
        const { limiter } = createSpendLimiter()
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        const policy = compile({
          dry_run: true,
          default: 'allow',
          rules: [
            {
              name: 'spend-limit-payments',
              match: { tool: 'create_payment' },
              action: 'spend_limit',
              limits: {
                max_spend: { field: '$.amount', limit: 1000, currency: 'GBP', window: '24h' },
              },
            },
          ],
        })
        const governed = new GovernedForwarder(inner, policy, { spendLimiter: limiter })

        const result = await governed.forward(toolsCallRequest('create_payment', { amount: -100 }))
        expect(inner.forward).not.toHaveBeenCalled()
        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining('resolved to invalid amount'),
        )

        // Dry-run synthetic response payload
        const body = result.response.body as Record<string, unknown>
        const mcpResult = body['result'] as Record<string, unknown>
        const content = mcpResult['content'] as Array<{ type: string; text: string }>
        const first = content[0]
        if (!first) throw new Error('expected content item')
        const payload = JSON.parse(first.text) as Record<string, unknown>
        expect(payload['dry_run']).toBe(true)
        expect(payload['would_forward']).toBe(false)
        expect(payload['limits_ok']).toBe(false)

        // Bucket state must remain empty — dry-run never consumes
        expect(limiter.listKeyStates()).toEqual([])

        consoleSpy.mockRestore()
      })
    })
  })

  // ---------------------------------------------------------------------------
  // Dry-run mode
  // ---------------------------------------------------------------------------

  describe('dry_run', () => {
    /** Extract the dry-run payload from a synthetic ForwardResult. */
    function dryRunPayloadFromResult(result: ForwardResult): Record<string, unknown> {
      const body = result.response.body as Record<string, unknown>
      const mcpResult = body['result'] as Record<string, unknown>
      const content = mcpResult['content'] as Array<{ type: string; text: string }>
      const first = content[0]
      if (!first) throw new Error('expected at least one content item')
      return JSON.parse(first.text) as Record<string, unknown>
    }

    function createAuditWriter() {
      const store = new AuditStore({
        path: ':memory:',
        retention: '90d',
        includeResponses: true,
        cleanupIntervalMs: 0,
      })
      const writer = new AuditWriter({ store, flushIntervalMs: 0 })
      return { store, writer }
    }

    describe('per-rule dry_run (action: dry_run)', () => {
      it('does not forward to upstream', async () => {
        const inner = mockForwarder()
        const policy = compile({
          default: 'allow',
          rules: [{ name: 'shadow-all', match: { tool: '*' }, action: 'dry_run' }],
        })
        const governed = new GovernedForwarder(inner, policy)

        await governed.forward(toolsCallRequest('send_email'))

        expect(inner.forward).not.toHaveBeenCalled()
      })

      it('returns JSON-RPC success with MCP content', async () => {
        const inner = mockForwarder()
        const policy = compile({
          default: 'allow',
          rules: [{ name: 'shadow-all', match: { tool: '*' }, action: 'dry_run' }],
        })
        const governed = new GovernedForwarder(inner, policy)

        const result = await governed.forward(toolsCallRequest('send_email'))

        // Should be a success response (no error field)
        const body = result.response.body as Record<string, unknown>
        expect(body['error']).toBeUndefined()
        expect(body['result']).toBeDefined()

        const payload = dryRunPayloadFromResult(result)
        expect(payload['dry_run']).toBe(true)
        expect(payload['would_forward']).toBe(false)
        expect(payload['policy_decision']).toBe('dry_run')
        expect(payload['matched_rule']).toBe('shadow-all')
        expect(payload['evidence_satisfied']).toBe(true)
        expect(payload['limits_ok']).toBe(true)
      })

      it('writes audit record with dry_run: true', async () => {
        const inner = mockForwarder()
        const policy = compile({
          default: 'allow',
          rules: [{ name: 'shadow-all', match: { tool: '*' }, action: 'dry_run' }],
        })
        const { store, writer } = createAuditWriter()
        const governed = new GovernedForwarder(inner, policy, { auditWriter: writer })

        await governed.forward(toolsCallRequest('send_email'))

        writer.flush()
        const { records } = store.list()
        expect(records).toHaveLength(1)
        expect(records[0]?.dry_run).toBe(true)
        expect(records[0]?.policy_decision).toBe('dry_run')
        expect(records[0]?.upstream_response).toBeNull()
        expect(records[0]?.upstream_latency_ms).toBeNull()

        writer.close()
      })

      it('with evidence blocking shows evidence_satisfied: false', async () => {
        const inner = mockForwarder()
        const policy = compile({
          default: 'allow',
          rules: [
            {
              name: 'dry-with-evidence',
              match: { tool: 'refund' },
              action: 'dry_run',
              evidence: { requires: ['orders.lookup'] },
            },
          ],
        })
        const evidenceStore = new EvidenceStore({ cleanupIntervalMs: 0 })
        const governed = new GovernedForwarder(inner, policy, { evidenceStore })

        const result = await governed.forward(toolsCallWithSession('refund', 'sess-1'))

        const payload = dryRunPayloadFromResult(result)
        expect(payload['dry_run']).toBe(true)
        expect(payload['evidence_satisfied']).toBe(false)
        expect(payload['would_forward']).toBe(false)
      })
    })

    describe('global dry_run (policies.dry_run: true)', () => {
      it('does not forward even when policy says allow', async () => {
        const inner = mockForwarder()
        const policy = compile({
          dry_run: true,
          default: 'allow',
          rules: [],
        })
        const governed = new GovernedForwarder(inner, policy)

        await governed.forward(toolsCallRequest('get_weather'))

        expect(inner.forward).not.toHaveBeenCalled()
      })

      it('returns would_forward: true for allow decisions', async () => {
        const inner = mockForwarder()
        const policy = compile({
          dry_run: true,
          default: 'allow',
          rules: [],
        })
        const governed = new GovernedForwarder(inner, policy)

        const result = await governed.forward(toolsCallRequest('get_weather'))

        const payload = dryRunPayloadFromResult(result)
        expect(payload['dry_run']).toBe(true)
        expect(payload['would_forward']).toBe(true)
        expect(payload['policy_decision']).toBe('allow')
      })

      it('returns would_forward: false for deny decisions', async () => {
        const inner = mockForwarder()
        const policy = compile({
          dry_run: true,
          default: 'deny',
          rules: [],
        })
        const governed = new GovernedForwarder(inner, policy)

        const result = await governed.forward(toolsCallRequest('send_email'))

        const payload = dryRunPayloadFromResult(result)
        expect(payload['dry_run']).toBe(true)
        expect(payload['would_forward']).toBe(false)
        expect(payload['policy_decision']).toBe('deny')
      })

      it('peeks rate limiter without consuming budget', async () => {
        const inner = mockForwarder()
        const policy = compile({
          dry_run: true,
          default: 'allow',
          rules: [
            {
              name: 'limit-weather',
              match: { tool: 'get_weather' },
              action: 'rate_limit',
              limits: { max_calls: 2, window: '1h' },
            },
          ],
        })
        const rateLimiter = new RateLimiter({ cleanupIntervalMs: 0 })
        const governed = new GovernedForwarder(inner, policy, { rateLimiter })

        // Send 3 dry-run requests — none should consume budget
        await governed.forward(toolsCallRequest('get_weather'))
        await governed.forward(toolsCallRequest('get_weather'))
        const result = await governed.forward(toolsCallRequest('get_weather'))

        const payload = dryRunPayloadFromResult(result)
        expect(payload['would_forward']).toBe(true)
        expect(payload['limits_ok']).toBe(true)

        // Verify budget was not consumed — a real check should still succeed
        const realCheck = rateLimiter.check({
          key: 'tool:get_weather',
          maxCalls: 2,
          windowMs: 3_600_000,
        })
        expect(realCheck.allowed).toBe(true)
        expect(realCheck.current).toBe(1)

        rateLimiter.close()
      })

      it('peeks spend limiter without consuming budget', async () => {
        const inner = mockForwarder()
        const policy = compile({
          dry_run: true,
          default: 'allow',
          rules: [
            {
              name: 'limit-payments',
              match: { tool: 'create_payment' },
              action: 'spend_limit',
              limits: {
                max_spend: { field: '$.amount', limit: 100, currency: 'GBP', window: '1h' },
              },
            },
          ],
        })
        const spendLimiter = new SpendLimiter({ cleanupIntervalMs: 0 })
        const governed = new GovernedForwarder(inner, policy, { spendLimiter })

        // Send dry-run request
        await governed.forward(toolsCallRequest('create_payment', { amount: 80 }))

        // Verify budget not consumed — real check should still have full budget
        const realCheck = spendLimiter.check({
          key: 'tool:create_payment',
          amount: 80,
          limit: 100,
          windowMs: 3_600_000,
        })
        expect(realCheck.allowed).toBe(true)
        expect(realCheck.currentSpend).toBe(80) // Only the real check consumed it

        spendLimiter.close()
      })

      it('returns would_forward: false for require_approval', async () => {
        const inner = mockForwarder()
        const policy = compile({
          dry_run: true,
          default: 'allow',
          rules: [
            {
              name: 'approve-deletes',
              match: { tool: 'delete_*' },
              action: 'require_approval',
              approval: { channel: 'slack' },
            },
          ],
        })
        const governed = new GovernedForwarder(inner, policy)

        const result = await governed.forward(toolsCallRequest('delete_record'))

        const payload = dryRunPayloadFromResult(result)
        expect(payload['would_forward']).toBe(false)
        expect(payload['policy_decision']).toBe('require_approval')
      })

      it('writes audit with dry_run: true and real policy_decision', async () => {
        const inner = mockForwarder()
        const policy = compile({
          dry_run: true,
          default: 'allow',
          rules: [{ name: 'allow-weather', match: { tool: 'get_weather' }, action: 'allow' }],
        })
        const { store, writer } = createAuditWriter()
        const governed = new GovernedForwarder(inner, policy, { auditWriter: writer })

        await governed.forward(toolsCallRequest('get_weather'))

        writer.flush()
        const { records } = store.list()
        expect(records).toHaveLength(1)
        expect(records[0]?.dry_run).toBe(true)
        expect(records[0]?.policy_decision).toBe('allow')
        expect(records[0]?.upstream_response).toBeNull()
        expect(records[0]?.upstream_latency_ms).toBeNull()

        writer.close()
      })

      it('does not record tool call for dependency tracking', async () => {
        const inner = mockForwarder()
        const policy = compile({
          dry_run: true,
          default: 'allow',
          rules: [{ match: { tool: '*' }, action: 'allow' }],
        })
        const evidenceStore = new EvidenceStore({ cleanupIntervalMs: 0 })
        const governed = new GovernedForwarder(inner, policy, { evidenceStore })

        await governed.forward(toolsCallWithSession('get_weather', 'sess-1'))

        expect(evidenceStore.hasCompletedTool('sess-1', 'get_weather')).toBe(false)
      })

      it('updatePolicy with dryRun activates dry-run for subsequent requests', async () => {
        const inner = mockForwarder()
        const policyNormal = compile({ default: 'allow', rules: [] })
        const policyDryRun = compile({ dry_run: true, default: 'allow', rules: [] })
        const governed = new GovernedForwarder(inner, policyNormal)

        // First request: normal mode — should forward
        await governed.forward(toolsCallRequest('get_weather'))
        expect(inner.forward).toHaveBeenCalledTimes(1)

        // Switch to dry-run
        governed.updatePolicy(policyDryRun)
        inner.forward.mockClear()

        // Second request: dry-run mode — should NOT forward
        const result = await governed.forward(toolsCallRequest('get_weather'))
        expect(inner.forward).not.toHaveBeenCalled()

        const payload = dryRunPayloadFromResult(result)
        expect(payload['dry_run']).toBe(true)
      })
    })
  })
})

// ---------------------------------------------------------------------------
// Tool definition drift — detection and audit
// ---------------------------------------------------------------------------

/** Minimal fake AuditWriter capturing pushed records. */
function fakeAuditWriter() {
  return {
    push: vi.fn(),
    pushImmediate: vi.fn(),
  } as unknown as AuditWriter & {
    push: ReturnType<typeof vi.fn>
    pushImmediate: ReturnType<typeof vi.fn>
  }
}

describe('tool definition drift — detection and audit', () => {
  it('audits a tool_drift record when a definition changes after baseline', async () => {
    const inner = mockForwarder()
    inner.forward
      .mockResolvedValueOnce(
        toolsListResult([{ name: 'send_email', annotations: { destructiveHint: false } }]),
      )
      .mockResolvedValueOnce(
        toolsListResult([{ name: 'send_email', annotations: { destructiveHint: true } }]),
      )
    const auditWriter = fakeAuditWriter()
    const governed = new GovernedForwarder(inner, compile({ default: 'allow', rules: [] }), {
      auditWriter,
    })

    await governed.forward(toolsListRequest())
    expect(auditWriter.pushImmediate).not.toHaveBeenCalled()

    await governed.forward(toolsListRequest(2))
    expect(auditWriter.pushImmediate).toHaveBeenCalledTimes(1)
    const record = auditWriter.pushImmediate.mock.calls[0]?.[0] as Record<string, unknown>
    expect(record['policy_decision']).toBe('tool_drift')
    expect(record['tool_name']).toBe('send_email')
    expect(record['evidence_chain']).toMatchObject({
      tool_drift: {
        changes: [
          {
            aspect: 'annotations',
            baseline: { destructiveHint: false },
            current: { destructiveHint: true },
          },
        ],
      },
    })
  })

  it('audits a tool_drift_reverted record when the definition reverts', async () => {
    const inner = mockForwarder()
    inner.forward
      .mockResolvedValueOnce(toolsListResult([{ name: 't', annotations: { readOnlyHint: true } }]))
      .mockResolvedValueOnce(toolsListResult([{ name: 't', annotations: { readOnlyHint: false } }]))
      .mockResolvedValueOnce(toolsListResult([{ name: 't', annotations: { readOnlyHint: true } }]))
    const auditWriter = fakeAuditWriter()
    const governed = new GovernedForwarder(inner, compile({ default: 'allow', rules: [] }), {
      auditWriter,
    })

    await governed.forward(toolsListRequest())
    await governed.forward(toolsListRequest(2))
    await governed.forward(toolsListRequest(3))
    expect(auditWriter.pushImmediate).toHaveBeenCalledTimes(2)
    const reverted = auditWriter.pushImmediate.mock.calls[1]?.[0] as Record<string, unknown>
    expect(reverted['policy_decision']).toBe('tool_drift_reverted')
    expect(reverted['tool_name']).toBe('t')
  })

  it('detects drift across primeAnnotationCache and a later tools/list', async () => {
    const inner = mockForwarder()
    inner.forward
      .mockResolvedValueOnce(toolsListResult([{ name: 't', inputSchema: { type: 'object' } }]))
      .mockResolvedValueOnce(
        toolsListResult([
          { name: 't', inputSchema: { type: 'object', properties: { exfil: {} } } },
        ]),
      )
    const auditWriter = fakeAuditWriter()
    const governed = new GovernedForwarder(inner, compile({ default: 'allow', rules: [] }), {
      auditWriter,
    })

    const prime = await governed.primeAnnotationCache()
    expect(prime.success).toBe(true)
    await governed.forward(toolsListRequest())
    expect(auditWriter.pushImmediate).toHaveBeenCalledTimes(1)
    const record = auditWriter.pushImmediate.mock.calls[0]?.[0] as Record<string, unknown>
    expect(record['policy_decision']).toBe('tool_drift')
  })
})

describe('tool definition drift — call gating', () => {
  /** Drive the forwarder to a drifted state for `send_email`. */
  async function setupDrifted(
    policyConfig: Parameters<typeof compile>[0],
    auditWriter?: AuditWriter,
  ) {
    const inner = mockForwarder()
    inner.forward
      .mockResolvedValueOnce(
        toolsListResult([{ name: 'send_email', annotations: { destructiveHint: false } }]),
      )
      .mockResolvedValueOnce(
        toolsListResult([{ name: 'send_email', annotations: { destructiveHint: true } }]),
      )
    const governed = new GovernedForwarder(inner, compile(policyConfig), { auditWriter })
    await governed.forward(toolsListRequest())
    await governed.forward(toolsListRequest(2))
    return { inner, governed }
  }

  it('blocks calls to a drifted tool by default', async () => {
    const { inner, governed } = await setupDrifted({ default: 'allow', rules: [] })
    const result = await governed.forward(toolsCallRequest('send_email'))
    const error = errorFromResult(result)
    expect(error.code).toBe(-32001)
    expect(error.data['reason']).toBe('tool_definition_drift')
    expect(error.data['drifted_aspects']).toEqual(['annotations'])
    // two tools/list forwards only — the call never reached upstream
    expect(inner.forward).toHaveBeenCalledTimes(2)
  })

  it('blocks even when an explicit allow rule matches (drift overrides)', async () => {
    const { inner, governed } = await setupDrifted({
      default: 'deny',
      rules: [{ match: { tool: 'send_email' }, action: 'allow' }],
    })
    const result = await governed.forward(toolsCallRequest('send_email'))
    expect(errorFromResult(result).data['reason']).toBe('tool_definition_drift')
    expect(inner.forward).toHaveBeenCalledTimes(2)
  })

  it('does not gate non-drifted tools', async () => {
    const { inner, governed } = await setupDrifted({ default: 'allow', rules: [] })
    inner.forward.mockResolvedValueOnce(
      successResult({ jsonrpc: '2.0', id: 1, result: { content: [] } }),
    )
    const result = await governed.forward(toolsCallRequest('other_tool'))
    expect((result.response.body as Record<string, unknown>)['error']).toBeUndefined()
  })

  it('escalates through the approval router when on_tool_drift is require_approval', async () => {
    const inner = mockForwarder()
    inner.forward
      .mockResolvedValueOnce(
        toolsListResult([{ name: 'send_email', annotations: { destructiveHint: false } }]),
      )
      .mockResolvedValueOnce(
        toolsListResult([{ name: 'send_email', annotations: { destructiveHint: true } }]),
      )
    const submit = vi.fn().mockResolvedValue({ status: 'approved', resolvedBy: 'tester' })
    const approvalRouter = { submit, defaultOnTimeout: 'deny' } as unknown as ApprovalRouter
    const governed = new GovernedForwarder(
      inner,
      compile({ default: 'allow', rules: [], on_tool_drift: 'require_approval' }),
      { approvalRouter },
    )
    await governed.forward(toolsListRequest())
    await governed.forward(toolsListRequest(2))

    const result = await governed.forward(toolsCallRequest('send_email'))
    expect(submit).toHaveBeenCalledTimes(1)
    // approved → forwarded upstream (third inner.forward call)
    expect(inner.forward).toHaveBeenCalledTimes(3)
    expect((result.response.body as Record<string, unknown>)['error']).toBeUndefined()
  })

  it('blocks when the drift approval is denied', async () => {
    const inner = mockForwarder()
    inner.forward
      .mockResolvedValueOnce(
        toolsListResult([{ name: 'send_email', annotations: { destructiveHint: false } }]),
      )
      .mockResolvedValueOnce(
        toolsListResult([{ name: 'send_email', annotations: { destructiveHint: true } }]),
      )
    const submit = vi
      .fn()
      .mockResolvedValue({ status: 'denied', resolvedBy: 'operator', reason: 'looks malicious' })
    const approvalRouter = { submit, defaultOnTimeout: 'deny' } as unknown as ApprovalRouter
    const governed = new GovernedForwarder(
      inner,
      compile({ default: 'allow', rules: [], on_tool_drift: 'require_approval' }),
      { approvalRouter },
    )
    await governed.forward(toolsListRequest())
    await governed.forward(toolsListRequest(2))

    const result = await governed.forward(toolsCallRequest('send_email'))
    expect(errorFromResult(result).code).toBe(-32001)
    expect(inner.forward).toHaveBeenCalledTimes(2)
  })

  it('forwards but annotates the audit record when on_tool_drift is log', async () => {
    const auditWriter = fakeAuditWriter()
    const { inner, governed } = await setupDrifted(
      { default: 'allow', rules: [], on_tool_drift: 'log' },
      auditWriter,
    )
    const result = await governed.forward(toolsCallRequest('send_email'))
    expect((result.response.body as Record<string, unknown>)['error']).toBeUndefined()
    expect(inner.forward).toHaveBeenCalledTimes(3)
    // the tools/call audit record (a push, not pushImmediate) carries drift context
    const callRecord = auditWriter.push.mock.calls[0]?.[0] as Record<string, unknown>
    expect(callRecord['evidence_chain']).toMatchObject({
      tool_drift: { mode: 'log' },
    })
  })

  it('log mode: a rule matching the CURRENT annotations fires (the rug-pull)', async () => {
    // Rule denies destructive tools. Baseline is non-destructive; upstream
    // flips destructive. Stricter-of-both evaluation must deny.
    const inner = mockForwarder()
    inner.forward
      .mockResolvedValueOnce(
        toolsListResult([{ name: 'send_email', annotations: { destructiveHint: false } }]),
      )
      .mockResolvedValueOnce(
        toolsListResult([{ name: 'send_email', annotations: { destructiveHint: true } }]),
      )
    const governed = new GovernedForwarder(
      inner,
      compile({
        default: 'allow',
        rules: [{ match: { annotations: { destructiveHint: true } }, action: 'deny' }],
        on_tool_drift: 'log',
      }),
    )
    await governed.forward(toolsListRequest())
    await governed.forward(toolsListRequest(2))
    const result = await governed.forward(toolsCallRequest('send_email'))
    expect(errorFromResult(result).code).toBe(-32001)
    expect(inner.forward).toHaveBeenCalledTimes(2)
  })

  it('log mode: a rule matching the BASELINE annotations keeps firing (rug-pull inverse)', async () => {
    // Rule denies destructive tools. Baseline says destructive; upstream
    // flips to non-destructive (drift). The deny must keep firing.
    const inner = mockForwarder()
    inner.forward
      .mockResolvedValueOnce(
        toolsListResult([{ name: 'wipe_db', annotations: { destructiveHint: true } }]),
      )
      .mockResolvedValueOnce(
        toolsListResult([{ name: 'wipe_db', annotations: { destructiveHint: false } }]),
      )
    const governed = new GovernedForwarder(
      inner,
      compile({
        default: 'allow',
        rules: [{ match: { annotations: { destructiveHint: true } }, action: 'deny' }],
        on_tool_drift: 'log',
      }),
    )
    await governed.forward(toolsListRequest())
    await governed.forward(toolsListRequest(2))
    const result = await governed.forward(toolsCallRequest('wipe_db'))
    expect(errorFromResult(result).code).toBe(-32001)
    expect(inner.forward).toHaveBeenCalledTimes(2)
  })

  it('global dry_run simulates a drift block without forwarding', async () => {
    const { inner, governed } = await setupDrifted({ default: 'allow', rules: [], dry_run: true })
    const result = await governed.forward(toolsCallRequest('send_email'))
    expect(inner.forward).toHaveBeenCalledTimes(2)
    const body = result.response.body as { result: { content: Array<{ text: string }> } }
    const payload = JSON.parse(body.result.content[0]?.text ?? '{}') as Record<string, unknown>
    expect(payload['dry_run']).toBe(true)
    expect(payload['would_forward']).toBe(false)
    expect(payload['policy_decision']).toBe('deny')
  })

  it('drift block overrides a per-rule dry_run action', async () => {
    const { inner, governed } = await setupDrifted({
      default: 'allow',
      rules: [{ match: { tool: 'send_email' }, action: 'dry_run' }],
    })
    const result = await governed.forward(toolsCallRequest('send_email'))
    expect(errorFromResult(result).data['reason']).toBe('tool_definition_drift')
    expect(inner.forward).toHaveBeenCalledTimes(2)
  })

  it('unblocks the tool after the upstream reverts to baseline', async () => {
    const inner = mockForwarder()
    inner.forward
      .mockResolvedValueOnce(toolsListResult([{ name: 't', annotations: { readOnlyHint: true } }]))
      .mockResolvedValueOnce(toolsListResult([{ name: 't', annotations: { readOnlyHint: false } }]))
      .mockResolvedValueOnce(toolsListResult([{ name: 't', annotations: { readOnlyHint: true } }]))
    const governed = new GovernedForwarder(inner, compile({ default: 'allow', rules: [] }))
    await governed.forward(toolsListRequest())
    await governed.forward(toolsListRequest(2))
    await governed.forward(toolsListRequest(3))
    const result = await governed.forward(toolsCallRequest('t'))
    expect((result.response.body as Record<string, unknown>)['error']).toBeUndefined()
  })

  it('writes a deny audit record with block_reason tool_definition_drift', async () => {
    const auditWriter = fakeAuditWriter()
    const { governed } = await setupDrifted({ default: 'allow', rules: [] }, auditWriter)
    await governed.forward(toolsCallRequest('send_email'))
    // calls[0] is the tool_drift event from the second tools/list;
    // the blocked call is the second immediate record
    const blocked = auditWriter.pushImmediate.mock.calls[1]?.[0] as Record<string, unknown>
    expect(blocked['policy_decision']).toBe('deny')
    expect(blocked['block_reason']).toBe('tool_definition_drift')
  })

  it('log mode: flag_destructive catches a current-claim destructive flip', async () => {
    // No matching rule; baseline non-destructive; current flips destructive.
    // flag_destructive must see the current claim in log mode and escalate.
    const inner = mockForwarder()
    inner.forward
      .mockResolvedValueOnce(
        toolsListResult([{ name: 't', annotations: { destructiveHint: false } }]),
      )
      .mockResolvedValueOnce(
        toolsListResult([{ name: 't', annotations: { destructiveHint: true } }]),
      )
    const governed = new GovernedForwarder(
      inner,
      compile({
        default: 'allow',
        rules: [],
        on_tool_drift: 'log',
        flag_destructive: 'require_approval',
      }),
    )
    await governed.forward(toolsListRequest())
    await governed.forward(toolsListRequest(2))
    const result = await governed.forward(toolsCallRequest('t'))
    // No approval router configured → unsupported-result error, not a forward
    expect(errorFromResult(result).code).toBe(-32001)
    expect(inner.forward).toHaveBeenCalledTimes(2)
  })

  it('require_approval mode: timeout with defaultOnTimeout allow forwards (documented operator choice)', async () => {
    const inner = mockForwarder()
    inner.forward
      .mockResolvedValueOnce(
        toolsListResult([{ name: 'send_email', annotations: { destructiveHint: false } }]),
      )
      .mockResolvedValueOnce(
        toolsListResult([{ name: 'send_email', annotations: { destructiveHint: true } }]),
      )
    const submit = vi.fn().mockResolvedValue({ status: 'timeout', timeoutMs: 1000 })
    const approvalRouter = { submit, defaultOnTimeout: 'allow' } as unknown as ApprovalRouter
    const governed = new GovernedForwarder(
      inner,
      compile({ default: 'allow', rules: [], on_tool_drift: 'require_approval' }),
      { approvalRouter },
    )
    await governed.forward(toolsListRequest())
    await governed.forward(toolsListRequest(2))
    const result = await governed.forward(toolsCallRequest('send_email'))
    expect(inner.forward).toHaveBeenCalledTimes(3)
    expect((result.response.body as Record<string, unknown>)['error']).toBeUndefined()
  })

  it('log mode: a stricter current-claim dry_run rule simulates instead of forwarding', async () => {
    const inner = mockForwarder()
    inner.forward
      .mockResolvedValueOnce(toolsListResult([{ name: 't', annotations: { readOnlyHint: true } }]))
      .mockResolvedValueOnce(toolsListResult([{ name: 't', annotations: { readOnlyHint: false } }]))
    const governed = new GovernedForwarder(
      inner,
      compile({
        default: 'allow',
        rules: [{ match: { annotations: { readOnlyHint: false } }, action: 'dry_run' }],
        on_tool_drift: 'log',
      }),
    )
    await governed.forward(toolsListRequest())
    await governed.forward(toolsListRequest(2))
    const result = await governed.forward(toolsCallRequest('t'))
    expect(inner.forward).toHaveBeenCalledTimes(2)
    const body = result.response.body as { result: { content: Array<{ text: string }> } }
    const payload = JSON.parse(body.result.content[0]?.text ?? '{}') as Record<string, unknown>
    expect(payload['dry_run']).toBe(true)
    expect(payload['would_forward']).toBe(false)
  })
})
