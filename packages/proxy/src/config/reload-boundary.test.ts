import { describe, it, expect } from 'vitest'
import { helioConfigSchema, type HelioConfig } from './schema.js'
import { diffReloadBoundary } from './reload-boundary.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseConfig(config: Record<string, unknown>): HelioConfig {
  return helioConfigSchema.parse(config)
}

function minimalConfig(overrides: Record<string, unknown> = {}): HelioConfig {
  return parseConfig({
    version: '1',
    upstream: { url: 'http://localhost:8080/mcp' },
    dashboard: { enabled: false },
    ...overrides,
  })
}

// ---------------------------------------------------------------------------
// diffReloadBoundary
// ---------------------------------------------------------------------------

describe('diffReloadBoundary', () => {
  it('does not require restart when only policy rules change', () => {
    const previous = minimalConfig()
    const next = minimalConfig({
      policies: {
        rules: [{ match: { tool: 'send_email' }, action: 'deny' }],
      },
    })

    const diff = diffReloadBoundary(previous, next)
    expect(diff.restartRequiredPaths).toEqual([])
  })

  it('does not require restart when only policy defaults/flags change', () => {
    const previous = minimalConfig()
    const next = minimalConfig({
      policies: {
        default: 'deny',
        flag_destructive: 'log',
        dry_run: true,
      },
    })

    const diff = diffReloadBoundary(previous, next)
    expect(diff.restartRequiredPaths).toEqual([])
  })

  it('treats policies.hot_reload undefined and true as equivalent', () => {
    const previous = minimalConfig()
    const next = minimalConfig({
      policies: {
        hot_reload: true,
      },
    })

    const diff = diffReloadBoundary(previous, next)
    expect(diff.restartRequiredPaths).toEqual([])
  })

  it('requires restart when policies.hot_reload effective value changes', () => {
    const previous = minimalConfig()
    const next = minimalConfig({
      policies: {
        hot_reload: false,
      },
    })

    const diff = diffReloadBoundary(previous, next)
    expect(diff.restartRequiredPaths).toEqual(['policies.hot_reload'])
  })

  it('requires restart when environment changes', () => {
    const previous = minimalConfig({
      environment: 'production',
    })
    const next = minimalConfig({
      environment: 'staging',
    })

    const diff = diffReloadBoundary(previous, next)
    expect(diff.restartRequiredPaths).toEqual(['environment'])
  })

  it('requires restart when upstream changes', () => {
    const previous = minimalConfig()
    const next = minimalConfig({
      upstream: { url: 'http://localhost:9090/mcp' },
    })

    const diff = diffReloadBoundary(previous, next)
    expect(diff.restartRequiredPaths).toEqual(['upstream'])
  })

  it('returns multiple paths in stable order', () => {
    const previous = minimalConfig()
    const next = minimalConfig({
      listen: { port: 4000, host: '127.0.0.1' },
      audit: { path: './other-audit.db' },
    })

    const diff = diffReloadBoundary(previous, next)
    expect(diff.restartRequiredPaths).toEqual(['listen', 'audit'])
  })
})
