import { describe, it, expect, vi, beforeEach } from 'vitest'
import { decide } from './decision-pipeline.js'
import type { DecideInput } from './decision-pipeline.js'
import { compilePolicies } from './parser.js'
import type { PoliciesConfig } from '../config/schema.js'
import type { CompiledPolicy } from './types.js'
import type { ToolDriftEvent } from './annotation-cache.js'
import { evaluatePolicy } from './engine.js'

// Spy-mode module mock: the real evaluatePolicy runs, its calls are observable.
// Call history is FILE-WIDE — the beforeEach mockClear below is load-bearing for
// every call-index assertion (calls[1] = "the second call of THIS test").
vi.mock('./engine.js', { spy: true })

// ---------------------------------------------------------------------------
// Upstream label threading through decide() (issue #295)
// ---------------------------------------------------------------------------

function compile(config: Omit<PoliciesConfig, 'dry_run'> & { dry_run?: boolean }): CompiledPolicy {
  return compilePolicies({ dry_run: false, ...config }).policy
}

function input(overrides: Partial<DecideInput> & { policy: CompiledPolicy }): DecideInput {
  return {
    toolName: 'send',
    toolArguments: {},
    sessionId: undefined,
    environment: undefined,
    evidenceStore: undefined,
    baselineAnnotations: undefined,
    currentAnnotations: undefined,
    driftEvent: undefined,
    ...overrides,
  }
}

const drift = (aspects: string[]): ToolDriftEvent => ({
  toolName: 'send',
  changes: aspects.map((aspect) => ({ aspect: aspect as never, baseline: 1, current: 2 })),
})

beforeEach(() => {
  vi.mocked(evaluatePolicy).mockClear()
})

describe('decide — match.upstreams scoping (issue #293)', () => {
  const scopedDeny = () =>
    compile({
      default: 'allow',
      rules: [{ match: { upstreams: ['a'] }, action: 'deny' }],
    })

  it('fires for the named door', () => {
    const { decision } = decide(input({ policy: scopedDeny(), upstream: 'a' }))
    expect(decision.action).toBe('deny')
  })

  it('does not fire for another door', () => {
    const { decision } = decide(input({ policy: scopedDeny(), upstream: 'b' }))
    expect(decision.action).toBe('allow')
  })

  it('does not fire on the sideband, where upstream is unset', () => {
    const { decision } = decide(input({ policy: scopedDeny() }))
    expect(decision.action).toBe('allow')
  })
})

describe('decide — upstream threading (issue #295)', () => {
  it('threads upstream into the base evaluatePolicy match context', () => {
    const policy = compile({ default: 'allow', rules: [] })
    decide(input({ policy, upstream: 'payments' }))
    expect(vi.mocked(evaluatePolicy)).toHaveBeenCalledTimes(1)
    const ctx = vi.mocked(evaluatePolicy).mock.calls[0]?.[1]
    expect(ctx?.upstream).toBe('payments')
  })

  it('threads upstream into the second (current-annotations) context in drift log mode', () => {
    const policy = compile({ default: 'allow', on_tool_drift: 'log', rules: [] })
    decide(input({ policy, upstream: 'payments', driftEvent: drift(['description']) }))
    expect(vi.mocked(evaluatePolicy)).toHaveBeenCalledTimes(2)
    const ctx = vi.mocked(evaluatePolicy).mock.calls[1]?.[1]
    expect(ctx?.upstream).toBe('payments')
  })

  it('without upstream, both match contexts carry the key with value undefined', () => {
    // The always-pass convention (the metadata pattern): the key is present on
    // every match context; the sideband's inertness lives in the VALUE being
    // undefined, never in key absence.
    const policy = compile({ default: 'allow', on_tool_drift: 'log', rules: [] })
    decide(input({ policy, driftEvent: drift(['description']) }))
    expect(vi.mocked(evaluatePolicy)).toHaveBeenCalledTimes(2)
    for (const call of vi.mocked(evaluatePolicy).mock.calls) {
      const ctx = call[1]
      expect(ctx.upstream).toBeUndefined()
      expect('upstream' in ctx).toBe(true)
    }
  })
})
