import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import {
  WHOLE_TRAIL_LABEL,
  WHOLE_TRAIL_SINCE,
  generatePolicy,
  renderGenerationText,
} from './index.js'
import { demoGenerationInput } from './__fixtures__/demo-input.js'
import { parseConfigSource, readConfigSource } from '../config/loader.js'
import {
  readPolicyGenerationEvidence,
  buildPolicyGenerationRecord,
} from '../audit/policy-generation.js'

const NOW = new Date('2026-10-12T12:00:00.000Z')

describe('generatePolicy over the shipped demo', () => {
  const input = demoGenerationInput(new Date('2026-10-12T11:00:00.000Z'))
  const result = generatePolicy({
    ...input,
    window: { since: null, label: WHOLE_TRAIL_LABEL },
    annotationSource: 'demo',
    now: NOW,
    helioVersion: '0.0.0',
  })

  it('writes no candidate and reports six kept, four needs-decision and the four coverage lines', () => {
    expect(result.candidate).toBeNull()
    expect(result.evidence.candidate_sha256).toBeNull()
    expect(result.evidence.rules_generated).toBe(0)
    expect(result.evidence.rules_kept).toBe(6)
    expect(result.evidence.needs_decision).toBe(4)
    expect(result.evidence.eligible_unobserved).toBe(0)
    expect(result.evidence.call_count).toBe(352)
    expect(result.evidence.default_action).toEqual({ source: 'allow', candidate: null })
    expect(result.evidence.annotation_source).toBe('demo')
    expect(result.report.window).toEqual({ since: null, label: 'whole trail within retention' })
    expect(WHOLE_TRAIL_SINCE).toBe('1970-01-01T00:00:00.000Z')
    // The evidence is the record's shape: the builder's strict read returns it whole.
    const record = buildPolicyGenerationRecord({
      candidatePath: null,
      environment: 'demo',
      evidence: result.evidence,
    })
    expect(readPolicyGenerationEvidence(record)).toEqual(result.evidence)
  })

  it('renders the text the demo pins, in class-door-name order with calls as a column', () => {
    const text = renderGenerationText(result.report)
    expect(text).toMatchInlineSnapshot(`
      "Policy coverage
        6 of 10 have a rule that can match them
        4 fall through to the default: allow
        Effective action: allow 7, deny 3
        on_tool_drift: block

      Needs your decision
        create_charge    demo-billing  observed 39 times  write-class name
        send_invoice     demo-billing  observed 39 times  write-class name
        update_customer  demo-crm      observed 40 times  write-class name
        refund_charge    demo-billing  observed 25 times  unknown name

      Kept
        delete_customer   demo-crm      kept (source rule "block-destructive")  confident restrict  destructiveHint: true             observed 40 times
        merge_customers   demo-crm      kept (source rule "block-destructive")  confident restrict  destructiveHint: true             never observed
        export_customers  demo-crm      kept (source rule "block-destructive")  needs decision      unknown name                      observed 40 times
        get_invoice       demo-billing  kept (source rule "allow-reads")        needs decision      description silent                observed 64 times
        get_customer      demo-crm      kept (source rule "allow-reads")        needs decision      description silent                observed 65 times
        list_invoices     demo-billing  kept (source rule "allow-reads")        confident read      name, hint and description agree  never observed

      Observed (whole trail within retention)
        352 calls across 8 tool-door pairs
        first call 2026-08-28 11:00 UTC, last call 2026-10-12 10:50 UTC"
    `)
    expect(
      text.startsWith(
        'Policy coverage\n' +
          '  6 of 10 have a rule that can match them\n' +
          '  4 fall through to the default: allow\n' +
          '  Effective action: allow 7, deny 3\n' +
          '  on_tool_drift: block\n',
      ),
    ).toBe(true)
    expect(text).not.toContain('Generated candidate')
    expect(text).not.toContain('Needs dashboard')
    expect(text).not.toContain('Eligible, not yet observed')
    const column = (section: string, next: string) =>
      text
        .slice(text.indexOf(section), text.indexOf(next))
        .split('\n')
        .filter((line) => line.startsWith('  '))
        .map((line) => line.trim().split(/\s{2,}/))
    expect(column('Needs your decision', '\n\nKept').map((cols) => [cols[0], cols[2]])).toEqual([
      ['create_charge', 'observed 39 times'],
      ['send_invoice', 'observed 39 times'],
      ['update_customer', 'observed 40 times'],
      ['refund_charge', 'observed 25 times'],
    ])
    expect(column('Kept', '\n\nObserved').map((cols) => [cols[0], cols[cols.length - 1]])).toEqual([
      ['delete_customer', 'observed 40 times'],
      ['merge_customers', 'never observed'],
      ['export_customers', 'observed 40 times'],
      ['get_invoice', 'observed 64 times'],
      ['get_customer', 'observed 65 times'],
      ['list_invoices', 'never observed'],
    ])
  })
})

describe('generatePolicy candidate hash', () => {
  it('round-trips through readConfigSource when the text is written as UTF-8', async () => {
    const raw =
      "version: '1'\nupstream:\n  url: 'http://localhost:8080/mcp'\n  transport: streamable-http\npolicies:\n  default: allow\n  rules: []\ndashboard:\n  enabled: false\n"
    const sha256 = createHash('sha256').update(raw).digest('hex')
    const result = generatePolicy({
      source: { raw, sha256, config: parseConfigSource({ raw, sha256 }, 'x.yaml', {}).config },
      doors: [
        {
          name: undefined,
          tools: [
            {
              name: 'read_file',
              description: 'Read the complete contents of a file',
              annotations: { readOnlyHint: true, destructiveHint: false },
              input_keys: ['$.path'],
            },
          ],
        },
      ],
      observed: {
        since: WHOLE_TRAIL_SINCE,
        calls: 3,
        sessions: 1,
        first_seen_in_window: '2026-10-01T10:00:00.000Z',
        last_seen_in_window: '2026-10-01T11:00:00.000Z',
        pairs: [{ tool_name: 'read_file', upstream: null, origin: 'mcp', calls: 3 }],
        first_seen: '2026-10-01T10:00:00.000Z',
      },
      window: { since: null, label: WHOLE_TRAIL_LABEL },
      annotationSource: 'proxy',
      now: NOW,
      helioVersion: '0.16.0',
    })
    if (result.candidate === null) throw new Error('no candidate')
    expect(result.evidence.candidate_sha256).toBe(result.candidate.sha256)
    expect(result.evidence.rules_generated).toBe(1)
    const dir = mkdtempSync(join(tmpdir(), 'helio-generate-'))
    try {
      const path = join(dir, 'helio.candidate.yaml')
      writeFileSync(path, result.candidate.text, 'utf-8')
      const read = await readConfigSource(path)
      expect(read.sha256).toBe(result.candidate.sha256)
      expect(read.raw).toBe(result.candidate.text)
      expect(parseConfigSource(read, path, {}).config.policies.rules.map((r) => r.name)).toEqual([
        'allow-read_file',
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
