import { describe, it, expect } from 'vitest'
import * as proxy from './index.js'

describe('proxy', () => {
  it('exports a version string', () => {
    expect(proxy.VERSION).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('exports core classes and functions', () => {
    // Config
    expect(proxy.loadConfig).toBeTypeOf('function')
    expect(proxy.ConfigError).toBeTypeOf('function')

    // Server
    expect(proxy.createApp).toBeTypeOf('function')
    expect(proxy.startServer).toBeTypeOf('function')

    // Policy
    expect(proxy.compilePolicies).toBeTypeOf('function')
    expect(proxy.GovernedForwarder).toBeTypeOf('function')
    expect(proxy.RateLimiter).toBeTypeOf('function')
    expect(proxy.SpendLimiter).toBeTypeOf('function')

    // Evidence
    expect(proxy.EvidenceStore).toBeTypeOf('function')
    expect(proxy.createSidebandApp).toBeTypeOf('function')

    // Audit
    expect(proxy.AuditStore).toBeTypeOf('function')
    expect(proxy.AuditWriter).toBeTypeOf('function')

    // Approvals
    expect(proxy.ApprovalQueue).toBeTypeOf('function')
    expect(proxy.ApprovalRouter).toBeTypeOf('function')
    expect(proxy.createApprovalApp).toBeTypeOf('function')

    // Transport
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- the deprecated compat alias must stay exported
    expect(proxy.UpstreamForwarder).toBeTypeOf('function')
    expect(proxy.StreamableHttpForwarder).toBeTypeOf('function')
    expect(proxy.StdioForwarder).toBeTypeOf('function')
  })
})
