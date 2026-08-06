import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SessionConfig } from '../config/schema.js'
import {
  compileSessionIdentity,
  resolveSession,
  resetSessionResolverWarningForTests,
  type CompiledSessionIdentity,
} from './session-resolver.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function compile(overrides: Partial<SessionConfig> = {}): CompiledSessionIdentity {
  return compileSessionIdentity({
    identity: [{ source: 'header', name: 'x-helio-session-id' }, { source: 'legacy_header' }],
    on_unresolved: 'deny',
    ...overrides,
  })
}

const DEFAULT = compile()

/** _meta carrying a well-formed clientInfo claim. */
function clientInfoMeta(name: string, version?: string): unknown {
  return {
    'io.modelcontextprotocol/clientInfo': version === undefined ? { name } : { name, version },
  }
}

beforeEach(() => {
  resetSessionResolverWarningForTests()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// compileSessionIdentity
// ---------------------------------------------------------------------------

describe('compileSessionIdentity', () => {
  it('summarizes the default chain for deny messages', () => {
    expect(DEFAULT.strategySummary).toBe('header "x-helio-session-id", legacy_header')
  })

  it('summarizes meta and custom header names in configured order', () => {
    const compiled = compile({
      identity: [
        { source: 'meta' },
        { source: 'header', name: 'x-team-session' },
        { source: 'legacy_header' },
      ],
    })
    expect(compiled.strategySummary).toBe('meta, header "x-team-session", legacy_header')
  })

  it('carries the on_unresolved mode through', () => {
    expect(DEFAULT.onUnresolved).toBe('deny')
    expect(compile({ on_unresolved: 'anonymous' }).onUnresolved).toBe('anonymous')
  })
})

// ---------------------------------------------------------------------------
// resolveSession — per-source behavior
// ---------------------------------------------------------------------------

describe('resolveSession', () => {
  describe('header source', () => {
    it('resolves the configured header', () => {
      const resolved = resolveSession({ headers: { 'x-helio-session-id': 'run-a' } }, DEFAULT)
      expect(resolved).toEqual({ id: 'run-a', source: 'header' })
    })

    it('reads a custom configured name', () => {
      const compiled = compile({ identity: [{ source: 'header', name: 'x-team-session' }] })
      const resolved = resolveSession(
        { headers: { 'x-team-session': 'team-1', 'x-helio-session-id': 'ignored' } },
        compiled,
      )
      expect(resolved).toEqual({ id: 'team-1', source: 'header' })
    })

    it('uses the value verbatim (no trimming)', () => {
      const resolved = resolveSession({ headers: { 'x-helio-session-id': ' padded ' } }, DEFAULT)
      expect(resolved).toEqual({ id: ' padded ', source: 'header' })
    })
  })

  describe('meta source', () => {
    const META_ONLY = compile({ identity: [{ source: 'meta' }] })

    it('derives clientinfo:<name>@<version> from clientInfo', () => {
      const resolved = resolveSession(
        { headers: {}, meta: clientInfoMeta('claude-code', '2.1') },
        META_ONLY,
      )
      expect(resolved).toEqual({ id: 'clientinfo:claude-code@2.1', source: 'meta' })
    })

    it('falls back to @unknown when version is absent', () => {
      const resolved = resolveSession(
        { headers: {}, meta: clientInfoMeta('claude-code') },
        META_ONLY,
      )
      expect(resolved).toEqual({ id: 'clientinfo:claude-code@unknown', source: 'meta' })
    })

    it('treats a non-string version as unknown', () => {
      const resolved = resolveSession(
        { headers: {}, meta: { 'io.modelcontextprotocol/clientInfo': { name: 'c', version: 4 } } },
        META_ONLY,
      )
      expect(resolved).toEqual({ id: 'clientinfo:c@unknown', source: 'meta' })
    })

    it.each([
      ['no meta at all', undefined],
      ['meta is not an object', 'nope'],
      ['clientInfo key missing', {}],
      ['clientInfo is not an object', { 'io.modelcontextprotocol/clientInfo': 'x' }],
      ['name missing', { 'io.modelcontextprotocol/clientInfo': { version: '1' } }],
      ['name not a string', { 'io.modelcontextprotocol/clientInfo': { name: 7 } }],
      ['name empty', { 'io.modelcontextprotocol/clientInfo': { name: '' } }],
      ['name whitespace-only', { 'io.modelcontextprotocol/clientInfo': { name: '  ' } }],
    ])('does not resolve when %s', (_label, meta) => {
      expect(resolveSession({ headers: {}, meta }, META_ONLY)).toBeUndefined()
    })
  })

  describe('legacy_header source', () => {
    it('resolves the verbatim transport session id', () => {
      const resolved = resolveSession({ headers: {}, transportSessionId: 'legacy-1' }, DEFAULT)
      expect(resolved).toEqual({ id: 'legacy-1', source: 'legacy_header' })
    })

    it('does not resolve from the transport id when legacy_header is not configured', () => {
      const compiled = compile({ identity: [{ source: 'header', name: 'x-helio-session-id' }] })
      expect(
        resolveSession({ headers: {}, transportSessionId: 'legacy-1' }, compiled),
      ).toBeUndefined()
    })
  })

  // -------------------------------------------------------------------------
  // Precedence
  // -------------------------------------------------------------------------

  describe('precedence', () => {
    it('header beats legacy_header when both are present (default chain)', () => {
      const resolved = resolveSession(
        { headers: { 'x-helio-session-id': 'explicit' }, transportSessionId: 'legacy-1' },
        DEFAULT,
      )
      expect(resolved).toEqual({ id: 'explicit', source: 'header' })
    })

    it('respects the configured order (legacy_header first wins)', () => {
      const compiled = compile({
        identity: [{ source: 'legacy_header' }, { source: 'header', name: 'x-helio-session-id' }],
      })
      const resolved = resolveSession(
        { headers: { 'x-helio-session-id': 'explicit' }, transportSessionId: 'legacy-1' },
        compiled,
      )
      expect(resolved).toEqual({ id: 'legacy-1', source: 'legacy_header' })
    })

    it('ignores clientInfo when meta is not in the chain', () => {
      const resolved = resolveSession(
        { headers: {}, meta: clientInfoMeta('claude-code', '2.1') },
        DEFAULT,
      )
      expect(resolved).toBeUndefined()
    })
  })

  // -------------------------------------------------------------------------
  // Implicit SSE transport fallback
  // -------------------------------------------------------------------------

  describe('transport fallback', () => {
    it('falls back to the minted stream id when nothing else matches', () => {
      const resolved = resolveSession({ headers: {}, transportMintedId: 'stream-7' }, DEFAULT)
      expect(resolved).toEqual({ id: 'stream-7', source: 'transport' })
    })

    it('lets an explicit header override the minted stream id', () => {
      const resolved = resolveSession(
        { headers: { 'x-helio-session-id': 'explicit' }, transportMintedId: 'stream-7' },
        DEFAULT,
      )
      expect(resolved).toEqual({ id: 'explicit', source: 'header' })
    })

    it('applies even when the chain has no legacy_header', () => {
      const compiled = compile({ identity: [{ source: 'meta' }] })
      const resolved = resolveSession({ headers: {}, transportMintedId: 'stream-7' }, compiled)
      expect(resolved).toEqual({ id: 'stream-7', source: 'transport' })
    })
  })

  // -------------------------------------------------------------------------
  // Value hygiene — skip-and-continue
  // -------------------------------------------------------------------------

  describe('value hygiene', () => {
    it('skips an empty header value and continues down the chain', () => {
      const resolved = resolveSession(
        { headers: { 'x-helio-session-id': '' }, transportSessionId: 'legacy-1' },
        DEFAULT,
      )
      expect(resolved).toEqual({ id: 'legacy-1', source: 'legacy_header' })
    })

    it('skips a whitespace-only header value', () => {
      const resolved = resolveSession({ headers: { 'x-helio-session-id': '   ' } }, DEFAULT)
      expect(resolved).toBeUndefined()
    })

    it('skips a value longer than 256 chars and continues down the chain', () => {
      const resolved = resolveSession(
        { headers: { 'x-helio-session-id': 'a'.repeat(257) }, transportSessionId: 'legacy-1' },
        DEFAULT,
      )
      expect(resolved).toEqual({ id: 'legacy-1', source: 'legacy_header' })
    })

    it('accepts a value of exactly 256 chars', () => {
      const id = 'a'.repeat(256)
      const resolved = resolveSession({ headers: { 'x-helio-session-id': id } }, DEFAULT)
      expect(resolved).toEqual({ id, source: 'header' })
    })

    it('skips an over-long legacy transport id (previously unbounded on the MCP path)', () => {
      const resolved = resolveSession({ headers: {}, transportSessionId: 'a'.repeat(257) }, DEFAULT)
      expect(resolved).toBeUndefined()
    })

    it('warns once per process across malformed values', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      resolveSession({ headers: { 'x-helio-session-id': '' } }, DEFAULT)
      resolveSession({ headers: { 'x-helio-session-id': 'b'.repeat(300) } }, DEFAULT)
      expect(errorSpy).toHaveBeenCalledTimes(1)
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('session identity'))
    })

    it('does not warn on clean resolutions', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      resolveSession({ headers: { 'x-helio-session-id': 'ok' } }, DEFAULT)
      expect(errorSpy).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // Unresolved
  // -------------------------------------------------------------------------

  it('returns undefined when no source matches and no minted id exists', () => {
    expect(resolveSession({ headers: {} }, DEFAULT)).toBeUndefined()
  })
})
