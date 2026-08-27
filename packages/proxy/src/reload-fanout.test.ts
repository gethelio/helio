import { describe, it, expect } from 'vitest'
import { applyReloadedPolicy } from './reload-fanout.js'
import { compilePolicies } from './policy/index.js'
import type { CompiledPolicy, CompiledToolRevalidation } from './policy/types.js'

function stubStack(name: string, log: string[]) {
  return {
    governedForwarder: {
      updatePolicy: (policy: CompiledPolicy) => {
        log.push(`${name}:updatePolicy:${policy.defaultAction}`)
      },
    },
    annotationPrime: {
      reconfigure: (revalidation: CompiledToolRevalidation | undefined) => {
        log.push(`${name}:reconfigure:${String(revalidation?.enabled ?? 'none')}`)
      },
    },
  }
}

describe('applyReloadedPolicy', () => {
  it('applies update and reconfigure to every stack, paired, in order (issue #294)', () => {
    const log: string[] = []
    const stacks = [stubStack('files', log), stubStack('github', log)]
    const { policy } = compilePolicies({
      default: 'deny',
      dry_run: false,
      rules: [],
      tool_revalidation: { enabled: false, interval: '5m' },
    })

    applyReloadedPolicy(stacks, policy)

    // Paired per stack (update then reconfigure), stacks in config order —
    // matching the singular sequence, so a future partial failure surfaces
    // adjacent to its door.
    expect(log).toEqual([
      'files:updatePolicy:deny',
      'files:reconfigure:false',
      'github:updatePolicy:deny',
      'github:reconfigure:false',
    ])
  })

  it('passes the reloaded revalidation section through to reconfigure', () => {
    const log: string[] = []
    const stacks = [stubStack('files', log)]
    const { policy } = compilePolicies({
      default: 'allow',
      dry_run: false,
      rules: [],
      tool_revalidation: { enabled: true, interval: '5m' },
    })

    applyReloadedPolicy(stacks, policy)

    expect(log).toEqual(['files:updatePolicy:allow', 'files:reconfigure:true'])
  })
})
