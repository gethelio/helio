import { describe, it, expect } from 'vitest'
import { formatOrigin, formatRecordKind } from './origin'

describe('formatOrigin', () => {
  it('maps known origins to friendly labels', () => {
    expect(formatOrigin('mcp')).toBe('MCP')
    expect(formatOrigin('openclaw')).toBe('OpenClaw')
  })
  it('falls back to the raw slug for unknown origins', () => {
    expect(formatOrigin('some_adapter')).toBe('some_adapter')
  })
})

describe('formatRecordKind', () => {
  it('returns null for tool_call (no chip)', () => {
    expect(formatRecordKind('tool_call')).toBeNull()
  })
  it('labels non-default kinds', () => {
    expect(formatRecordKind('install_scan')).toBe('Install Scan')
    expect(formatRecordKind('drift_event')).toBe('Drift')
    expect(formatRecordKind('evaluation_expired')).toBe('Expired')
  })
  it('falls back to the raw kind for unknown values', () => {
    expect(formatRecordKind('something_new')).toBe('something_new')
  })
})
