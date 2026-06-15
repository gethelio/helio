import { describe, it, expect, vi } from 'vitest'
import { decide } from './decision-pipeline.js'
import type { DecideInput } from './decision-pipeline.js'
import { compilePolicies } from './parser.js'
import type { PoliciesConfig } from '../config/schema.js'
import type { CompiledPolicy } from './types.js'
import type { ToolDriftEvent } from './annotation-cache.js'
import { EvidenceStore } from '../evidence/index.js'

// ---------------------------------------------------------------------------
// Helpers
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

// ---------------------------------------------------------------------------
// match.metadata threading (issue #13)
// ---------------------------------------------------------------------------

describe('match.metadata threading (issue #13)', () => {
  const denyOnChannel = (key: string, value: string) =>
    compile({
      default: 'allow',
      rules: [{ match: { metadata: { [key]: value } }, action: 'deny' }],
    })

  it('a metadata-keyed rule matches when the keyed context is supplied', () => {
    const policy = denyOnChannel('channel_id', 'C1')
    const r = decide(input({ policy, metadata: { channel_id: 'C1' } }))
    expect(r.decision.action).toBe('deny')
  })

  it('is inert when metadata is absent (MCP path) — falls through to default', () => {
    const policy = denyOnChannel('channel_id', 'C1')
    const r = decide(input({ policy }))
    expect(r.decision.action).toBe('allow')
  })

  it('does not match when the supplied metadata value differs', () => {
    const policy = denyOnChannel('channel_id', 'C1')
    const r = decide(input({ policy, metadata: { channel_id: 'C2' } }))
    expect(r.decision.action).toBe('allow')
  })

  it('matches the virtual agent_id key against the request agent id', () => {
    const policy = denyOnChannel('agent_id', 'main')
    const r = decide(input({ policy, agentId: 'main' }))
    expect(r.decision.action).toBe('deny')
  })

  it('matches the virtual agent_id even with no metadata object present', () => {
    const policy = denyOnChannel('agent_id', 'main')
    // metadata undefined, only agentId provided
    const r = decide(input({ policy, agentId: 'main', metadata: undefined }))
    expect(r.decision.action).toBe('deny')
  })

  it('the request agent_id shadows a literal metadata.agent_id at match time', () => {
    const policy = denyOnChannel('agent_id', 'main')
    // even if a literal metadata.agent_id sneaks through, the virtual key wins
    const r = decide(input({ policy, agentId: 'main', metadata: { agent_id: 'other' } }))
    expect(r.decision.action).toBe('deny')
  })
})

// ---------------------------------------------------------------------------
// decide()
// ---------------------------------------------------------------------------

describe('decide', () => {
  it('returns the matched rule action', () => {
    const policy = compile({
      default: 'allow',
      rules: [{ name: 'block-send', match: { tool: 'send' }, action: 'deny' }],
    })
    const r = decide(input({ policy }))
    expect(r.decision.action).toBe('deny')
    expect(r.decision.matchedRule?.name).toBe('block-send')
  })

  it('falls back to the default action with no matched rule', () => {
    const policy = compile({ default: 'allow', rules: [] })
    const r = decide(input({ policy }))
    expect(r.decision.action).toBe('allow')
    expect(r.decision.matchedRule).toBeUndefined()
  })

  describe('drift gate', () => {
    it('block mode denies a drifted tool', () => {
      const policy = compile({ default: 'allow', on_tool_drift: 'block', rules: [] })
      const r = decide(input({ policy, driftEvent: drift(['description']) }))
      expect(r.decision.action).toBe('deny')
      expect(r.driftBlocked).toBe(true)
    })

    it('require_approval mode escalates a drifted tool', () => {
      const policy = compile({ default: 'allow', on_tool_drift: 'require_approval', rules: [] })
      const r = decide(input({ policy, driftEvent: drift(['inputSchema']) }))
      expect(r.decision.action).toBe('require_approval')
      expect(r.driftBlocked).toBe(false)
    })

    it('log mode keeps the stricter of baseline and current decisions', () => {
      // Baseline annotations (readOnly) match an allow rule; current (destructive)
      // matches a deny rule. Stricter (deny) must win.
      const policy = compile({
        default: 'allow',
        on_tool_drift: 'log',
        rules: [
          { name: 'allow-ro', match: { annotations: { readOnlyHint: true } }, action: 'allow' },
          {
            name: 'deny-destructive',
            match: { annotations: { destructiveHint: true } },
            action: 'deny',
          },
        ],
      })
      const r = decide(
        input({
          policy,
          driftEvent: drift(['annotations']),
          baselineAnnotations: { readOnlyHint: true },
          currentAnnotations: { destructiveHint: true },
        }),
      )
      expect(r.decision.action).toBe('deny')
      expect(r.driftBlocked).toBe(false) // log mode never sets driftBlocked
    })
  })

  describe('flag_destructive', () => {
    it('log mode warns but leaves the decision unchanged', () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const policy = compile({ default: 'allow', flag_destructive: 'log', rules: [] })
      const r = decide(input({ policy, baselineAnnotations: { destructiveHint: true } }))
      expect(r.flaggedDestructive).toBe(true)
      expect(r.decision.action).toBe('allow')
      expect(spy).toHaveBeenCalledOnce()
      spy.mockRestore()
    })

    it('require_approval mode escalates an unguarded destructive tool', () => {
      const policy = compile({
        default: 'allow',
        flag_destructive: 'require_approval',
        rules: [],
      })
      const r = decide(input({ policy, baselineAnnotations: { destructiveHint: true } }))
      expect(r.flaggedDestructive).toBe(true)
      expect(r.decision.action).toBe('require_approval')
    })

    it('does not flag when a rule already matched', () => {
      const policy = compile({
        default: 'allow',
        flag_destructive: 'require_approval',
        rules: [{ name: 'explicit', match: { tool: 'send' }, action: 'allow' }],
      })
      const r = decide(input({ policy, baselineAnnotations: { destructiveHint: true } }))
      expect(r.flaggedDestructive).toBe(false)
      expect(r.decision.action).toBe('allow')
    })
  })

  describe('evidence / session gating', () => {
    it('denies an evidence-gated rule when no session id is present', () => {
      const policy = compile({
        default: 'deny',
        rules: [
          {
            name: 'needs-evidence',
            match: { tool: 'send' },
            action: 'allow',
            evidence: { requires: ['lookup'] },
          },
        ],
      })
      const r = decide(input({ policy, sessionId: undefined }))
      expect(r.sessionBlocked).toBe(true)
      expect(r.evidenceBlocked).toBe(true)
      expect(r.decision.action).toBe('deny')
    })

    it('denies when required evidence is missing for a session', () => {
      const store = new EvidenceStore()
      store.setAllowedEvidenceKeys(['lookup'])
      const policy = compile({
        default: 'deny',
        rules: [
          {
            name: 'needs-evidence',
            match: { tool: 'send' },
            action: 'allow',
            evidence: { requires: ['lookup'] },
          },
        ],
      })
      const r = decide(input({ policy, sessionId: 'sess-1', evidenceStore: store }))
      expect(r.evidenceBlocked).toBe(true)
      expect(r.decision.action).toBe('deny')
      expect(r.evidenceResult?.satisfied).toBe(false)
      store.close()
    })
  })

  describe('dry-run determination', () => {
    it('flags a per-rule dry_run action', () => {
      const policy = compile({
        default: 'allow',
        rules: [{ name: 'dr', match: { tool: 'send' }, action: 'dry_run' }],
      })
      const r = decide(input({ policy }))
      expect(r.isDryRun).toBe(true)
    })

    it('flags the global dry_run policy', () => {
      const policy = compile({ default: 'allow', dry_run: true, rules: [] })
      const r = decide(input({ policy }))
      expect(r.isDryRun).toBe(true)
    })

    it('does not treat a session-blocked call as dry-run', () => {
      const policy = compile({
        default: 'allow',
        dry_run: true,
        rules: [
          {
            name: 'needs-evidence',
            match: { tool: 'send' },
            action: 'allow',
            evidence: { requires: ['lookup'] },
          },
        ],
      })
      const r = decide(input({ policy, sessionId: undefined }))
      expect(r.sessionBlocked).toBe(true)
      expect(r.isDryRun).toBe(false)
    })
  })
})
