import { describe, it, expect } from 'vitest'
import { isModernProtocolClaim } from '../mcp/protocol-version.js'
import {
  validateHeaderBodyAgreement,
  type HeaderBodyAgreementInput,
} from './header-body-agreement.js'

const MODERN = '2026-07-28'
const MIRROR_KEY = 'io.modelcontextprotocol/protocolVersion'

/** Sentinel-wrapped 'Hello, 世界' — hand-rolled, not built with the encoder. */
const ENCODED_HELLO_WORLD = '=?base64?SGVsbG8sIOS4lueVjA==?='

function expectPass(input: HeaderBodyAgreementInput): void {
  const result = validateHeaderBodyAgreement(input)
  expect(result).toEqual({ ok: true })
}

function expectReject(input: HeaderBodyAgreementInput, reasonPart: string): string {
  const result = validateHeaderBodyAgreement(input)
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('unreachable')
  expect(result.reason).toContain(reasonPart)
  return result.reason
}

describe('isModernProtocolClaim (the pinned tier tokenizer)', () => {
  const cases: readonly [raw: string | undefined, modern: boolean, label: string][] = [
    ['2026-07-28', true, 'the exact modern revision'],
    ['2026-07-28, 2026-07-28', true, 'a duplicated modern claim (comma-joined)'],
    ['2026-07-28,2026-07-28', true, 'a duplicated modern claim without the join space'],
    ['2026-07-28,', true, 'a trailing comma (empty token dropped)'],
    [',', false, 'a bare comma (no tokens remain)'],
    [' , ', false, 'whitespace-only tokens (no tokens remain)'],
    // The discriminating .trim() vector: NBSP is Unicode whitespace that
    // String.prototype.trim removes and an RFC-OWS trim ([ \t]) would not.
    ['2026-07-28\u00A0', true, 'a NBSP-padded modern claim'],
    ['\u00A02026-07-28', true, 'a leading-NBSP modern claim'],
    ['2026-07-28, 2025-06-18', false, 'a mixed-duplicate claim'],
    ['2025-06-18', false, 'the legacy revision'],
    ['not-a-version', false, 'a garbage value'],
    ['', false, 'the empty string'],
    [undefined, false, 'an absent header'],
  ]

  for (const [raw, modern, label] of cases) {
    it(`classifies ${label} as ${modern ? 'a modern claim' : 'tier 2'}`, () => {
      expect(isModernProtocolClaim(raw)).toBe(modern)
    })
  }
})

describe('validateHeaderBodyAgreement — modern claim, requests', () => {
  const conformantToolsCall: HeaderBodyAgreementInput = {
    method: 'tools/call',
    id: 1,
    params: { name: 'get_status', arguments: {}, _meta: { [MIRROR_KEY]: MODERN } },
    headers: {
      'mcp-method': 'tools/call',
      'mcp-name': 'get_status',
      'mcp-protocol-version': MODERN,
    },
  }

  it('passes a fully conformant tools/call with a plain name', () => {
    expectPass(conformantToolsCall)
  })

  it('passes a fully conformant tools/call with a sentinel-encoded name', () => {
    expectPass({
      method: 'tools/call',
      id: 1,
      params: { name: 'Hello, 世界', _meta: { [MIRROR_KEY]: MODERN } },
      headers: {
        'mcp-method': 'tools/call',
        'mcp-name': ENCODED_HELLO_WORLD,
        'mcp-protocol-version': MODERN,
      },
    })
  })

  it('passes a conformant tools/list (no name-bearing field, no mcp-name)', () => {
    expectPass({
      method: 'tools/list',
      id: 2,
      params: { _meta: { [MIRROR_KEY]: MODERN } },
      headers: { 'mcp-method': 'tools/list', 'mcp-protocol-version': MODERN },
    })
  })

  it('ignores a stray mcp-name on tools/list rather than rejecting it', () => {
    expectPass({
      method: 'tools/list',
      id: 2,
      params: { _meta: { [MIRROR_KEY]: MODERN } },
      headers: {
        'mcp-method': 'tools/list',
        'mcp-name': 'unexpected',
        'mcp-protocol-version': MODERN,
      },
    })
  })

  it('passes a nameless tools/call (no string name field — missing_tool_name owns it downstream)', () => {
    expectPass({
      method: 'tools/call',
      id: 3,
      params: { arguments: {}, _meta: { [MIRROR_KEY]: MODERN } },
      headers: { 'mcp-method': 'tools/call', 'mcp-protocol-version': MODERN },
    })
  })

  it('ignores a stray mcp-name when the name-bearing field is non-string', () => {
    expectPass({
      method: 'tools/call',
      id: 3,
      params: { name: 42, _meta: { [MIRROR_KEY]: MODERN } },
      headers: {
        'mcp-method': 'tools/call',
        'mcp-name': 'anything',
        'mcp-protocol-version': MODERN,
      },
    })
  })

  it('rejects a missing mcp-method', () => {
    expectReject(
      {
        method: 'tools/list',
        id: 1,
        params: { _meta: { [MIRROR_KEY]: MODERN } },
        headers: { 'mcp-protocol-version': MODERN },
      },
      'missing mcp-method',
    )
  })

  it('rejects a mismatched mcp-method', () => {
    expectReject(
      {
        method: 'tools/call',
        id: 1,
        params: { name: 'get_status', _meta: { [MIRROR_KEY]: MODERN } },
        headers: {
          'mcp-method': 'tools/list',
          'mcp-name': 'get_status',
          'mcp-protocol-version': MODERN,
        },
      },
      'mismatched mcp-method',
    )
  })

  it('rejects a comma-joined duplicated mcp-method (byte-inequality)', () => {
    expectReject(
      {
        method: 'tools/list',
        id: 1,
        params: { _meta: { [MIRROR_KEY]: MODERN } },
        headers: { 'mcp-method': 'tools/list, tools/list', 'mcp-protocol-version': MODERN },
      },
      'mismatched mcp-method',
    )
  })

  it('rejects a missing mcp-name when the body carries a string name', () => {
    expectReject(
      {
        method: 'tools/call',
        id: 1,
        params: { name: 'get_status', _meta: { [MIRROR_KEY]: MODERN } },
        headers: { 'mcp-method': 'tools/call', 'mcp-protocol-version': MODERN },
      },
      'missing mcp-name',
    )
  })

  it('rejects a raw mcp-name mismatch', () => {
    expectReject(
      {
        method: 'tools/call',
        id: 1,
        params: { name: 'transfer_funds', _meta: { [MIRROR_KEY]: MODERN } },
        headers: {
          'mcp-method': 'tools/call',
          'mcp-name': 'list_orders',
          'mcp-protocol-version': MODERN,
        },
      },
      'mismatched mcp-name',
    )
  })

  it('rejects a sentinel-encoded mcp-name that decodes to a different value', () => {
    expectReject(
      {
        method: 'tools/call',
        id: 1,
        params: { name: 'get_status', _meta: { [MIRROR_KEY]: MODERN } },
        headers: {
          'mcp-method': 'tools/call',
          'mcp-name': ENCODED_HELLO_WORLD,
          'mcp-protocol-version': MODERN,
        },
      },
      'mismatched mcp-name',
    )
  })

  it('rejects a missing _meta mirror', () => {
    expectReject(
      {
        method: 'tools/list',
        id: 1,
        params: {},
        headers: { 'mcp-method': 'tools/list', 'mcp-protocol-version': MODERN },
      },
      'missing params._meta',
    )
  })

  it('rejects a missing mirror when params is absent entirely', () => {
    expectReject(
      {
        method: 'tools/list',
        id: 1,
        headers: { 'mcp-method': 'tools/list', 'mcp-protocol-version': MODERN },
      },
      'missing params._meta',
    )
  })

  it('rejects array params as a missing mirror', () => {
    expectReject(
      {
        method: 'tools/list',
        id: 1,
        params: [],
        headers: { 'mcp-method': 'tools/list', 'mcp-protocol-version': MODERN },
      },
      'missing params._meta',
    )
  })

  it('rejects primitive params as a missing mirror', () => {
    expectReject(
      {
        method: 'tools/list',
        id: 1,
        params: 'not-an-object',
        headers: { 'mcp-method': 'tools/list', 'mcp-protocol-version': MODERN },
      },
      'missing params._meta',
    )
  })

  it('rejects a non-object _meta as a missing mirror', () => {
    expectReject(
      {
        method: 'tools/list',
        id: 1,
        params: { _meta: 'not-an-object' },
        headers: { 'mcp-method': 'tools/list', 'mcp-protocol-version': MODERN },
      },
      'missing params._meta',
    )
  })

  it('rejects a mirror that disagrees with the modern constant', () => {
    expectReject(
      {
        method: 'tools/list',
        id: 1,
        params: { _meta: { [MIRROR_KEY]: '2025-06-18' } },
        headers: { 'mcp-method': 'tools/list', 'mcp-protocol-version': MODERN },
      },
      'mismatched params._meta',
    )
  })

  it('rejects a non-string mirror (number) as present-and-not-equal', () => {
    expectReject(
      {
        method: 'tools/list',
        id: 1,
        params: { _meta: { [MIRROR_KEY]: 5 } },
        headers: { 'mcp-method': 'tools/list', 'mcp-protocol-version': MODERN },
      },
      'mismatched params._meta',
    )
  })

  it('rejects a null mirror as present-and-not-equal', () => {
    expectReject(
      {
        method: 'tools/list',
        id: 1,
        params: { _meta: { [MIRROR_KEY]: null } },
        headers: { 'mcp-method': 'tools/list', 'mcp-protocol-version': MODERN },
      },
      'mismatched params._meta',
    )
  })

  // R2 F3: the mirror comparison target is the CONSTANT, never the raw or
  // comma-joined header value.
  it('passes a duplicated modern claim with the canonical mirror', () => {
    expectPass({
      method: 'tools/list',
      id: 1,
      params: { _meta: { [MIRROR_KEY]: MODERN } },
      headers: { 'mcp-method': 'tools/list', 'mcp-protocol-version': '2026-07-28, 2026-07-28' },
    })
  })

  it('rejects a duplicated modern claim whose mirror equals the joined header string', () => {
    expectReject(
      {
        method: 'tools/list',
        id: 1,
        params: { _meta: { [MIRROR_KEY]: '2026-07-28, 2026-07-28' } },
        headers: { 'mcp-method': 'tools/list', 'mcp-protocol-version': '2026-07-28, 2026-07-28' },
      },
      'mismatched params._meta',
    )
  })

  // R2 F1: id: null is a REQUEST for presence classification — the route's
  // notification predicate is `id === undefined` only.
  it('holds an id: null envelope to the full request presence profile', () => {
    expectReject(
      {
        method: 'tools/call',
        id: null,
        params: { name: 'get_status', _meta: { [MIRROR_KEY]: MODERN } },
        headers: { 'mcp-protocol-version': MODERN },
      },
      'missing mcp-method',
    )
  })

  // R2 F2 / R4 F1: tokenizer-normalized claims still gate presence.
  it('enforces presence under a trailing-comma modern claim', () => {
    expectReject(
      {
        method: 'tools/list',
        id: 1,
        params: { _meta: { [MIRROR_KEY]: MODERN } },
        headers: { 'mcp-protocol-version': '2026-07-28,' },
      },
      'missing mcp-method',
    )
  })

  it('enforces presence under a NBSP-padded modern claim', () => {
    expectReject(
      {
        method: 'tools/list',
        id: 1,
        params: { _meta: { [MIRROR_KEY]: MODERN } },
        headers: { 'mcp-protocol-version': '2026-07-28\u00A0' },
      },
      'missing mcp-method',
    )
  })

  it('selects params.name on prompts/get', () => {
    expectPass({
      method: 'prompts/get',
      id: 1,
      params: { name: 'summarize', _meta: { [MIRROR_KEY]: MODERN } },
      headers: {
        'mcp-method': 'prompts/get',
        'mcp-name': 'summarize',
        'mcp-protocol-version': MODERN,
      },
    })
  })

  it('does not treat params.uri as name-bearing on prompts/get', () => {
    expectPass({
      method: 'prompts/get',
      id: 1,
      params: { uri: 'file:///prompt.md', _meta: { [MIRROR_KEY]: MODERN } },
      headers: { 'mcp-method': 'prompts/get', 'mcp-protocol-version': MODERN },
    })
  })

  it('selects params.uri on resources/read', () => {
    expectReject(
      {
        method: 'resources/read',
        id: 1,
        params: { uri: 'file:///secret.txt', _meta: { [MIRROR_KEY]: MODERN } },
        headers: {
          'mcp-method': 'resources/read',
          'mcp-name': 'file:///public.txt',
          'mcp-protocol-version': MODERN,
        },
      },
      'mismatched mcp-name',
    )
  })

  it('does not read a name through the prototype chain', () => {
    const params = Object.create({ name: 'inherited' }) as Record<string, unknown>
    params['_meta'] = { [MIRROR_KEY]: MODERN }
    // The inherited name is not an own field, so the body has no name-bearing
    // string field and the header is ignored rather than compared against it.
    expectPass({
      method: 'tools/call',
      id: 1,
      params,
      headers: {
        'mcp-method': 'tools/call',
        'mcp-name': 'anything',
        'mcp-protocol-version': MODERN,
      },
    })
  })

  it('passes an empty method mirrored by an empty mcp-method header', () => {
    expectPass({
      method: '',
      id: 1,
      params: { _meta: { [MIRROR_KEY]: MODERN } },
      headers: { 'mcp-method': '', 'mcp-protocol-version': MODERN },
    })
  })
})

describe('validateHeaderBodyAgreement — modern claim, notifications', () => {
  // R1 F5: the revision leaves notification-POST header requirements
  // undefined, so nothing is REQUIRED to be present — agreement only.
  it('passes a notification with no markers and no mirror at all', () => {
    expectPass({
      method: 'notifications/initialized',
      params: {},
      headers: { 'mcp-protocol-version': MODERN },
    })
  })

  it('passes a notification with an agreeing mcp-method', () => {
    expectPass({
      method: 'notifications/initialized',
      params: {},
      headers: { 'mcp-method': 'notifications/initialized', 'mcp-protocol-version': MODERN },
    })
  })

  it('rejects a notification with a lying mcp-method', () => {
    expectReject(
      {
        method: 'notifications/initialized',
        params: {},
        headers: { 'mcp-method': 'tools/call', 'mcp-protocol-version': MODERN },
      },
      'mismatched mcp-method',
    )
  })

  it('ignores a stray mcp-name on a non-name-bearing notification', () => {
    expectPass({
      method: 'notifications/initialized',
      params: {},
      headers: { 'mcp-name': 'unexpected', 'mcp-protocol-version': MODERN },
    })
  })

  it('passes a notification with a present agreeing mirror', () => {
    expectPass({
      method: 'notifications/initialized',
      params: { _meta: { [MIRROR_KEY]: MODERN } },
      headers: { 'mcp-protocol-version': MODERN },
    })
  })

  it('rejects a notification whose present mirror disagrees', () => {
    expectReject(
      {
        method: 'notifications/initialized',
        params: { _meta: { [MIRROR_KEY]: '2025-06-18' } },
        headers: { 'mcp-protocol-version': MODERN },
      },
      'mismatched params._meta',
    )
  })

  it('accepts array params on a notification (no mirror required)', () => {
    expectPass({
      method: 'notifications/progress',
      params: [],
      headers: { 'mcp-protocol-version': MODERN },
    })
  })
})

describe('validateHeaderBodyAgreement — tier 2', () => {
  // The R1 F1 named regression, unit half: Helio's own legacy relay leg
  // forwards a modern client's body VERBATIM (mirror 2026-07-28 intact) under
  // a 2025-06-18 stamp with agreeing mcp-method/mcp-name. A downstream
  // Helio's door must pass it, or every legacy-leg relay of modern-client
  // traffic manufactures a -32020 that clears a correctly cached era.
  it('passes the Helio-legacy-leg shape: legacy header, modern mirror, agreeing stamps', () => {
    expectPass({
      method: 'tools/call',
      id: 1,
      params: { name: 'get_status', _meta: { [MIRROR_KEY]: MODERN } },
      headers: {
        'mcp-method': 'tools/call',
        'mcp-name': 'get_status',
        'mcp-protocol-version': '2025-06-18',
      },
    })
  })

  it('passes a bare legacy request (version claim, no markers)', () => {
    expectPass({
      method: 'tools/call',
      id: 1,
      params: { name: 'get_status' },
      headers: { 'mcp-protocol-version': '2025-06-18' },
    })
  })

  it('passes a request with no version claim and no markers (byte-for-byte legacy path)', () => {
    expectPass({
      method: 'tools/call',
      id: 1,
      params: { name: 'get_status' },
      headers: {},
    })
  })

  it('passes an unknown version claim with no markers', () => {
    expectPass({
      method: 'tools/call',
      id: 1,
      params: { name: 'get_status' },
      headers: { 'mcp-protocol-version': 'not-a-version' },
    })
  })

  it('does not require presence under a mixed-duplicate claim', () => {
    expectPass({
      method: 'tools/list',
      id: 1,
      params: {},
      headers: { 'mcp-protocol-version': '2026-07-28, 2025-06-18' },
    })
  })

  it('never examines the mirror: mixed-duplicate claim with a disagreeing mirror passes', () => {
    expectPass({
      method: 'tools/list',
      id: 1,
      params: { _meta: { [MIRROR_KEY]: MODERN } },
      headers: { 'mcp-protocol-version': '2026-07-28, 2025-06-18' },
    })
  })

  it('rejects a lying mcp-method with no version claim at all', () => {
    expectReject(
      {
        method: 'tools/call',
        id: 1,
        params: { name: 'get_status' },
        headers: { 'mcp-method': 'tools/list' },
      },
      'mismatched mcp-method',
    )
  })

  it('rejects a lying mcp-name against a string body name with no version claim', () => {
    expectReject(
      {
        method: 'tools/call',
        id: 1,
        params: { name: 'transfer_funds' },
        headers: { 'mcp-name': 'list_orders' },
      },
      'mismatched mcp-name',
    )
  })

  it('passes agreeing markers with no version claim', () => {
    expectPass({
      method: 'tools/call',
      id: 1,
      params: { name: 'get_status' },
      headers: { 'mcp-method': 'tools/call', 'mcp-name': 'get_status' },
    })
  })

  it('ignores a stray mcp-name on tools/list', () => {
    expectPass({
      method: 'tools/list',
      id: 1,
      params: {},
      headers: { 'mcp-name': 'unexpected' },
    })
  })

  it('treats an empty-string mcp-method as present and rejects the disagreement', () => {
    expectReject(
      {
        method: 'tools/list',
        id: 1,
        params: {},
        headers: { 'mcp-method': '' },
      },
      'mismatched mcp-method',
    )
  })

  it('applies agreement to tier-2 notifications too', () => {
    expectReject(
      {
        method: 'notifications/initialized',
        params: {},
        headers: { 'mcp-method': 'tools/call' },
      },
      'mismatched mcp-method',
    )
  })

  it('decode-compares an agreeing sentinel-encoded mcp-name on tier 2', () => {
    expectPass({
      method: 'tools/call',
      id: 1,
      params: { name: 'Hello, 世界' },
      headers: { 'mcp-name': ENCODED_HELLO_WORLD },
    })
  })
})

describe('validateHeaderBodyAgreement — rejection evidence', () => {
  it('carries the present headers verbatim and the body name', () => {
    const result = validateHeaderBodyAgreement({
      method: 'tools/call',
      id: 1,
      params: { name: 'transfer_funds', _meta: { [MIRROR_KEY]: MODERN } },
      headers: {
        'mcp-method': 'tools/call',
        'mcp-name': 'list_orders',
        'mcp-protocol-version': '2026-07-28, 2026-07-28',
      },
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.evidence).toEqual({
      headers: {
        'mcp-method': 'tools/call',
        'mcp-name': 'list_orders',
        'mcp-protocol-version': '2026-07-28, 2026-07-28',
      },
      bodyName: 'transfer_funds',
    })
  })

  it('omits absent headers and an absent body name from the evidence', () => {
    const result = validateHeaderBodyAgreement({
      method: 'tools/list',
      id: 1,
      params: {},
      headers: { 'mcp-method': 'tools/call' },
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.evidence).toEqual({ headers: { 'mcp-method': 'tools/call' } })
  })
})

describe('validateHeaderBodyAgreement — display caps on echoed values', () => {
  it('caps a body-derived echo at 256 chars and marks it truncated', () => {
    const hugeName = 'n'.repeat(300)
    const reason = expectReject(
      {
        method: 'tools/call',
        id: 1,
        params: { name: hugeName, _meta: { [MIRROR_KEY]: MODERN } },
        headers: {
          'mcp-method': 'tools/call',
          'mcp-name': 'short',
          'mcp-protocol-version': MODERN,
        },
      },
      'truncated',
    )
    expect(reason).not.toContain(hugeName)
  })

  it('caps a header-derived echo at 256 chars and marks it truncated', () => {
    const hugeHeader = 'h'.repeat(300)
    const reason = expectReject(
      {
        method: 'tools/call',
        id: 1,
        params: { name: 'short', _meta: { [MIRROR_KEY]: MODERN } },
        headers: {
          'mcp-method': 'tools/call',
          'mcp-name': hugeHeader,
          'mcp-protocol-version': MODERN,
        },
      },
      'truncated',
    )
    expect(reason).not.toContain(hugeHeader)
  })

  it('does not mark a short echo as truncated', () => {
    const reason = expectReject(
      {
        method: 'tools/call',
        id: 1,
        params: { name: 'transfer_funds', _meta: { [MIRROR_KEY]: MODERN } },
        headers: {
          'mcp-method': 'tools/call',
          'mcp-name': 'list_orders',
          'mcp-protocol-version': MODERN,
        },
      },
      'mismatched mcp-name',
    )
    expect(reason).not.toContain('truncated')
  })
})
