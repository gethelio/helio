import { describe, it, expect } from 'vitest'
import { DEMO_ANNOTATION_LINE, demoAnnotationSource } from './annotations.js'

// ---------------------------------------------------------------------------
// The sample server's listed definitions as the harness's annotation source
// (issue #490): what `helio policy simulate --demo` hands the replay.
// ---------------------------------------------------------------------------

describe('demoAnnotationSource (issue #490)', () => {
  const source = demoAnnotationSource()
  const at = '2026-09-24T12:00:00.000Z'

  it('answers known with the listed hints for a listed MCP tool on its door', () => {
    expect(
      source.resolve({ upstream: 'demo-crm', tool: 'get_customer', origin: 'mcp', timestamp: at }),
    ).toEqual({
      kind: 'known',
      hints: { readOnlyHint: true, destructiveHint: false },
      source: 'demo',
    })
  })

  it('answers known with no hints for a tool listed without annotations', () => {
    expect(
      source.resolve({
        upstream: 'demo-crm',
        tool: 'export_customers',
        origin: 'mcp',
        timestamp: at,
      }),
    ).toEqual({ kind: 'known', hints: undefined, source: 'demo' })
  })

  it('answers unknown for a sideband origin', () => {
    expect(
      source.resolve({
        upstream: 'demo-crm',
        tool: 'get_customer',
        origin: 'lab-adapter',
        timestamp: at,
      }),
    ).toEqual({ kind: 'unknown' })
  })

  it('answers unknown for an unlisted tool and for a listed tool on the wrong door', () => {
    expect(
      source.resolve({ upstream: 'demo-crm', tool: 'send_message', origin: 'mcp', timestamp: at }),
    ).toEqual({ kind: 'unknown' })
    expect(
      source.resolve({
        upstream: 'demo-billing',
        tool: 'get_customer',
        origin: 'mcp',
        timestamp: at,
      }),
    ).toEqual({ kind: 'unknown' })
    expect(
      source.resolve({ upstream: null, tool: 'get_customer', origin: 'mcp', timestamp: at }),
    ).toEqual({ kind: 'unknown' })
  })

  it('names the demo-only source with the fidelity page line, verbatim', () => {
    // docs/policy-fidelity.md, "The report's language": the one line printed by --demo alone.
    expect(DEMO_ANNOTATION_LINE).toBe(
      "Annotations for --demo came from the sample server's listed definitions, not from the audit trail.",
    )
  })
})
