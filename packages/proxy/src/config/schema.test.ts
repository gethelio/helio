import { describe, it, expect } from 'vitest'
import type { z } from 'zod'
import {
  helioConfigSchema,
  durationSchema,
  parseDuration,
  upstreamNameSchema,
  namedUpstreamEntrySchema,
  upstreamsListSchema,
  isSingularConfig,
  isNamedConfig,
} from './schema.js'
import type { HelioConfig } from './schema.js'

// Compile-time insurance: the schema's inferred output must stay exactly the
// declared HelioConfig union — a drift in the dispatch's return type fails
// `pnpm typecheck` here instead of silently widening downstream.
type Equal<A, B> =
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the single-use T on each side IS the exact-equality probe
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
const _schemaInfersTheDeclaredUnion: Equal<z.infer<typeof helioConfigSchema>, HelioConfig> = true
void _schemaInfersTheDeclaredUnion

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function minimalConfig(overrides: Record<string, unknown> = {}) {
  return {
    version: '1',
    upstream: { url: 'http://localhost:8080' },
    dashboard: { enabled: false },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Duration schema
// ---------------------------------------------------------------------------

describe('durationSchema', () => {
  it.each(['300s', '5m', '1h', '90d', '0s', '24h'])('accepts "%s"', (val) => {
    expect(durationSchema.safeParse(val).success).toBe(true)
  })

  it.each(['abc', '300', 's300', '', '300x', '1.5h', '-5s', '10 s'])('rejects "%s"', (val) => {
    expect(durationSchema.safeParse(val).success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// parseDuration
// ---------------------------------------------------------------------------

describe('parseDuration', () => {
  it('converts seconds to milliseconds', () => {
    expect(parseDuration('300s')).toBe(300_000)
  })

  it('converts minutes to milliseconds', () => {
    expect(parseDuration('5m')).toBe(300_000)
  })

  it('converts hours to milliseconds', () => {
    expect(parseDuration('1h')).toBe(3_600_000)
  })

  it('converts days to milliseconds', () => {
    expect(parseDuration('90d')).toBe(7_776_000_000)
  })

  it('throws on invalid input', () => {
    expect(() => parseDuration('abc')).toThrow('Invalid duration string')
  })
})

// ---------------------------------------------------------------------------
// Minimal valid config
// ---------------------------------------------------------------------------

describe('helioConfigSchema', () => {
  describe('sender_id limit key requires the sideband (issue #13)', () => {
    const senderRateRule = {
      match: { tool: 'send' },
      action: 'rate_limit',
      limits: { max_calls: 1, window: '1m', key: 'sender_id' },
    }
    const senderSpendRule = {
      match: { tool: 'pay' },
      action: 'spend_limit',
      limits: {
        max_spend: { field: '$.amt', limit: 5, currency: 'USD', window: '1h', key: 'sender_id' },
      },
    }

    it('rejects limits.key: sender_id when sdk.enabled is false (default)', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({ policies: { rules: [senderRateRule] } }),
      )
      expect(result.success).toBe(false)
    })

    it('rejects max_spend.key: sender_id when sdk.enabled is false', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({ policies: { rules: [senderSpendRule] } }),
      )
      expect(result.success).toBe(false)
    })

    it('accepts sender_id keys when sdk.enabled is true', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          sdk: { enabled: true },
          policies: { rules: [senderRateRule, senderSpendRule] },
        }),
      )
      expect(result.success).toBe(true)
    })

    it('still accepts session/tool keys with sdk disabled', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          policies: {
            rules: [
              {
                match: { tool: 'send' },
                action: 'rate_limit',
                limits: { max_calls: 1, window: '1m', key: 'session' },
              },
            ],
          },
        }),
      )
      expect(result.success).toBe(true)
    })
  })

  describe('minimal config', () => {
    it('parses with dashboard explicitly disabled', () => {
      const result = helioConfigSchema.safeParse(minimalConfig())
      expect(result.success).toBe(true)
    })

    it('applies all defaults', () => {
      const result = helioConfigSchema.safeParse(minimalConfig())
      expect(result.success).toBe(true)
      if (!result.success) return
      expect(isSingularConfig(result.data)).toBe(true)
      if (!isSingularConfig(result.data)) return

      expect(result.data.upstream.transport).toBe('streamable-http')
      expect(result.data.upstream.connect_timeout).toBe('10s')
      expect(result.data.upstream.request_timeout).toBe('30s')
      expect(result.data.upstream.forward_headers).toEqual([])
      expect(result.data.upstream.headers).toEqual({})
      expect(result.data.listen.port).toBe(3000)
      expect(result.data.listen.host).toBe('127.0.0.1')
      expect(result.data.dashboard.enabled).toBe(false)
      expect(result.data.dashboard.port).toBe(3100)
      expect(result.data.dashboard.allow_open_mode).toBe(false)
      expect(result.data.policies.default).toBe('allow')
      expect(result.data.policies.rules).toEqual([])
      expect(result.data.approval.timeout).toBe('300s')
      expect(result.data.approval.default_on_timeout).toBe('deny')
      expect(result.data.approval.channels).toEqual([])
      expect(result.data.audit.storage).toBe('sqlite')
      expect(result.data.audit.path).toBe('./helio-audit.db')
      expect(result.data.audit.retention).toBe('90d')
      expect(result.data.audit.include_responses).toBe(true)
      expect(result.data.sdk.enabled).toBe(false)
      expect(result.data.sdk.port).toBe(3200)
      expect(result.data.dashboard.host).toBe('127.0.0.1')
      expect(result.data.dashboard.sse_heartbeat_interval).toBe('30s')
      expect(result.data.sdk.host).toBe('127.0.0.1')
    })
  })

  // -------------------------------------------------------------------------
  // Canonical key order
  // -------------------------------------------------------------------------

  describe('canonical key order', () => {
    it('emits top-level keys in the canonical section order', () => {
      // Input keys are deliberately reversed: the assertion holds only while
      // zod emits output in shape-declaration order, so both a re-misplaced
      // shape field and a zod that starts preserving input order fail loudly.
      const result = helioConfigSchema.safeParse({
        sdk: {},
        dashboard: { enabled: false },
        audit: {},
        approval: {},
        budgets: [],
        policies: {},
        session: {},
        environment: 'production',
        listen: {},
        upstream: { url: 'http://localhost:8080' },
        version: '1',
      })
      expect(result.success).toBe(true)
      if (!result.success) return
      expect(Object.keys(result.data)).toEqual([
        'version',
        'upstream',
        'listen',
        'environment',
        'session',
        'policies',
        'budgets',
        'approval',
        'audit',
        'dashboard',
        'sdk',
      ])
    })
  })

  // -------------------------------------------------------------------------
  // Golden singular parse (issue #293)
  // -------------------------------------------------------------------------

  describe('golden singular parse (issue #293)', () => {
    it('parses a minimal singular config to exactly this defaulted object', () => {
      // Byte-identity pin for the multi-upstream schema work: singular configs
      // must keep parsing to exactly this object. A diff here means a schema
      // refactor changed singular behavior — fix the refactor, not this test.
      const result = helioConfigSchema.safeParse(minimalConfig())
      expect(result.success).toBe(true)
      if (!result.success) return
      expect(result.data).toStrictEqual({
        version: '1',
        upstream: {
          url: 'http://localhost:8080',
          transport: 'streamable-http',
          protocol_version: 'auto',
          connect_timeout: '10s',
          request_timeout: '30s',
          forward_headers: [],
          headers: {},
        },
        listen: { port: 3000, host: '127.0.0.1', allowed_origins: [] },
        session: {
          identity: [{ source: 'header', name: 'x-helio-session-id' }, { source: 'legacy_header' }],
          on_unresolved: 'deny',
        },
        policies: { default: 'allow', dry_run: false, rules: [] },
        budgets: [],
        approval: { timeout: '300s', default_on_timeout: 'deny', channels: [] },
        audit: {
          storage: 'sqlite',
          path: './helio-audit.db',
          retention: '90d',
          include_responses: true,
        },
        dashboard: {
          enabled: false,
          port: 3100,
          host: '127.0.0.1',
          allow_open_mode: false,
          sse_heartbeat_interval: '30s',
        },
        sdk: { enabled: false, port: 3200, host: '127.0.0.1', evaluation_ttl: '10m' },
      })
    })
  })

  // -------------------------------------------------------------------------
  // Named upstream leaf schemas (issue #293)
  // -------------------------------------------------------------------------

  describe('singular upstream refinement fold parity (issue #293)', () => {
    it('emits every refinement issue family, stdio-command first, in one parse', () => {
      // Pins the pre-#293 issue order and content for a singular upstream that
      // trips all four per-entry checks at once. The shared-superRefine fold
      // must keep this array identical — a diff means the fold changed
      // singular error behavior.
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          upstream: {
            url: 'x',
            transport: 'stdio',
            protocol_version: '2026-07-28',
            forward_headers: ['nope'],
            headers: { 'content-type': 'y' },
          },
        }),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      expect(
        result.error.issues.map((i) => ({ code: i.code, path: i.path, message: i.message })),
      ).toStrictEqual([
        {
          code: 'custom',
          path: ['upstream', 'command'],
          message: '"command" is required when transport is "stdio"',
        },
        {
          code: 'custom',
          path: ['upstream', 'protocol_version'],
          message:
            'protocol_version "2026-07-28" requires transport "streamable-http" — ' +
            'stdio modern-era support is tracked in #256.',
        },
        {
          code: 'custom',
          path: ['upstream', 'forward_headers', 0],
          message: 'Forwarded caller headers must start with "x-"',
        },
        {
          code: 'custom',
          path: ['upstream', 'headers', 'content-type'],
          message: 'upstream.headers must not set reserved header "content-type"',
        },
      ])
    })

    it('emits every co-firable issue family, url first, for a url-less sse upstream (issue #313)', () => {
      // The HTTP-side sibling of the pin above: url and protocol_version can
      // co-fire only on sse (the modern pin never fires on streamable-http),
      // so this is the one fixture that observes the url arm's position among
      // every family it can co-fire with.
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          upstream: {
            transport: 'sse',
            protocol_version: '2026-07-28',
            forward_headers: ['nope'],
            headers: { 'content-type': 'y' },
          },
        }),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      expect(
        result.error.issues.map((i) => ({ code: i.code, path: i.path, message: i.message })),
      ).toStrictEqual([
        {
          code: 'custom',
          path: ['upstream', 'url'],
          message: '"url" is required when transport is "sse"',
        },
        {
          code: 'custom',
          path: ['upstream', 'protocol_version'],
          message:
            'protocol_version "2026-07-28" requires transport "streamable-http" — ' +
            'the SSE upstream transport is the deprecated legacy transport.',
        },
        {
          code: 'custom',
          path: ['upstream', 'forward_headers', 0],
          message: 'Forwarded caller headers must start with "x-"',
        },
        {
          code: 'custom',
          path: ['upstream', 'headers', 'content-type'],
          message: 'upstream.headers must not set reserved header "content-type"',
        },
      ])
    })
  })

  describe('upstreamNameSchema (issue #293)', () => {
    it.each(['files', 'files-2', 'files_2', 'A1', 'a'.repeat(64)])('accepts "%s"', (name) => {
      expect(upstreamNameSchema.safeParse(name).success).toBe(true)
    })

    it('rejects the empty string', () => {
      expect(upstreamNameSchema.safeParse('').success).toBe(false)
    })

    it('rejects names longer than 64 characters', () => {
      expect(upstreamNameSchema.safeParse('a'.repeat(65)).success).toBe(false)
    })

    it.each(['with space', 'with:colon', 'with/slash', 'with.dot', 'naïve'])(
      'rejects "%s" with the charset message',
      (name) => {
        const result = upstreamNameSchema.safeParse(name)
        expect(result.success).toBe(false)
        if (result.success) return
        expect(result.error.issues.map((i) => i.message)).toContain(
          'Upstream names may only contain letters, digits, "_" and "-"',
        )
      },
    )
  })

  describe('namedUpstreamEntrySchema (issue #293)', () => {
    const entry = (overrides: Record<string, unknown> = {}) => ({
      name: 'files',
      url: 'http://localhost:8081/mcp',
      ...overrides,
    })

    it('parses a minimal entry with name first and singular defaults applied', () => {
      const result = namedUpstreamEntrySchema.safeParse(entry())
      expect(result.success).toBe(true)
      if (!result.success) return
      expect(Object.keys(result.data)).toEqual([
        'name',
        'url',
        'transport',
        'protocol_version',
        'connect_timeout',
        'request_timeout',
        'forward_headers',
        'headers',
      ])
      expect(result.data.transport).toBe('streamable-http')
      expect(result.data.protocol_version).toBe('auto')
      expect(result.data.connect_timeout).toBe('10s')
      expect(result.data.request_timeout).toBe('30s')
      expect(result.data.forward_headers).toEqual([])
      expect(result.data.headers).toEqual({})
    })

    it('requires the name', () => {
      const result = namedUpstreamEntrySchema.safeParse({ url: 'http://localhost:8081/mcp' })
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.issues[0]?.path).toEqual(['name'])
    })

    it('stays strict: an unknown entry key is rejected', () => {
      const result = namedUpstreamEntrySchema.safeParse(entry({ urll: 'typo' }))
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.issues.map((i) => i.message)).toContain('Unrecognized key: "urll"')
    })

    it('requires command for stdio transport, same message and path as singular', () => {
      const result = namedUpstreamEntrySchema.safeParse(entry({ transport: 'stdio' }))
      expect(result.success).toBe(false)
      if (result.success) return
      expect(
        result.error.issues.map((i) => ({ code: i.code, path: i.path, message: i.message })),
      ).toStrictEqual([
        {
          code: 'custom',
          path: ['command'],
          message: '"command" is required when transport is "stdio"',
        },
      ])
    })

    it('applies the modern-pin transport check per entry', () => {
      const result = namedUpstreamEntrySchema.safeParse(
        entry({ transport: 'sse', protocol_version: '2026-07-28' }),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.issues[0]?.path).toEqual(['protocol_version'])
      expect(result.error.issues[0]?.message).toBe(
        'protocol_version "2026-07-28" requires transport "streamable-http" — ' +
          'the SSE upstream transport is the deprecated legacy transport.',
      )
    })

    it('applies the forward_headers x- prefix check per entry', () => {
      const result = namedUpstreamEntrySchema.safeParse(entry({ forward_headers: ['bad'] }))
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.issues[0]?.path).toEqual(['forward_headers', 0])
      expect(result.error.issues[0]?.message).toBe('Forwarded caller headers must start with "x-"')
    })

    it('applies the reserved-header guard per entry', () => {
      const result = namedUpstreamEntrySchema.safeParse(
        entry({ headers: { 'mcp-session-id': 'x' } }),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.issues[0]?.path).toEqual(['headers', 'mcp-session-id'])
      expect(result.error.issues[0]?.message).toBe(
        'upstream.headers must not set reserved header "mcp-session-id"',
      )
    })
  })

  describe('upstreamsListSchema (issue #293)', () => {
    it('accepts a list of uniquely named entries', () => {
      const result = upstreamsListSchema.safeParse([
        { name: 'files', url: 'http://localhost:8081/mcp' },
        { name: 'search', url: 'http://localhost:8082/mcp' },
      ])
      expect(result.success).toBe(true)
    })

    it('rejects an empty list with the pinned message', () => {
      const result = upstreamsListSchema.safeParse([])
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.issues[0]?.message).toBe(
        'upstreams: must declare at least one upstream — an empty list would serve nothing. ' +
          'For a single upstream you can keep the "upstream:" form.',
      )
    })

    it('rejects duplicate names at the duplicate index', () => {
      const result = upstreamsListSchema.safeParse([
        { name: 'files', url: 'http://localhost:8081/mcp' },
        { name: 'search', url: 'http://localhost:8082/mcp' },
        { name: 'files', url: 'http://localhost:8083/mcp' },
      ])
      expect(result.success).toBe(false)
      if (result.success) return
      expect(
        result.error.issues.map((i) => ({ code: i.code, path: i.path, message: i.message })),
      ).toStrictEqual([
        {
          code: 'custom',
          path: [2, 'name'],
          message:
            'Duplicate upstream name "files". Upstream names embed in mount paths, limiter ' +
            'keys, and audit records — each upstream needs its own.',
        },
      ])
    })
  })

  // -------------------------------------------------------------------------
  // Mode dispatch: upstream | upstreams (issue #293)
  // -------------------------------------------------------------------------

  describe('mode dispatch: upstream | upstreams (issue #293)', () => {
    const namedMinimal = (overrides: Record<string, unknown> = {}) => ({
      version: '1',
      upstreams: [
        { name: 'files', url: 'http://localhost:8081/mcp' },
        { name: 'search', url: 'http://localhost:8082/mcp' },
      ],
      dashboard: { enabled: false },
      ...overrides,
    })

    it('parses a minimal named config with entry defaults applied', () => {
      const result = helioConfigSchema.safeParse(namedMinimal())
      expect(result.success).toBe(true)
      if (!result.success) return
      expect(isNamedConfig(result.data)).toBe(true)
      if (!isNamedConfig(result.data)) return
      expect(result.data.upstreams).toHaveLength(2)
      expect(result.data.upstreams[0]?.name).toBe('files')
      expect(result.data.upstreams[0]?.transport).toBe('streamable-http')
      expect(result.data.upstreams[0]?.protocol_version).toBe('auto')
      expect(result.data.upstreams[1]?.name).toBe('search')
      expect(result.data.session.on_unresolved).toBe('deny')
      expect(result.data.policies.default).toBe('allow')
    })

    it('rejects a bad entry name at the entry path through the root schema', () => {
      const result = helioConfigSchema.safeParse(
        namedMinimal({ upstreams: [{ name: 'with:colon', url: 'http://localhost:8081/mcp' }] }),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.issues.map((i) => ({ path: i.path, message: i.message }))).toStrictEqual([
        {
          path: ['upstreams', 0, 'name'],
          message: 'Upstream names may only contain letters, digits, "_" and "-"',
        },
      ])
    })

    it('rejects duplicate entry names at the duplicate index through the root schema', () => {
      const result = helioConfigSchema.safeParse(
        namedMinimal({
          upstreams: [
            { name: 'files', url: 'http://localhost:8081/mcp' },
            { name: 'files', url: 'http://localhost:8082/mcp' },
          ],
        }),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.issues[0]?.path).toEqual(['upstreams', 1, 'name'])
      expect(result.error.issues[0]?.message).toContain('Duplicate upstream name "files"')
    })

    it('applies every per-entry refinement at the entry path through the root schema', () => {
      const result = helioConfigSchema.safeParse(
        namedMinimal({
          upstreams: [
            { name: 'files', url: 'x', transport: 'stdio' },
            { name: 'search', url: 'x', headers: { 'mcp-session-id': 'y' } },
          ],
        }),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.issues.map((i) => ({ path: i.path, message: i.message }))).toStrictEqual([
        {
          path: ['upstreams', 0, 'command'],
          message: '"command" is required when transport is "stdio"',
        },
        {
          path: ['upstreams', 1, 'headers', 'mcp-session-id'],
          message: 'upstream.headers must not set reserved header "mcp-session-id"',
        },
      ])
    })

    it('rejects a config that sets both upstream: and upstreams:', () => {
      const result = helioConfigSchema.safeParse(
        namedMinimal({ upstream: { url: 'http://localhost:8080' } }),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.issues.map((i) => ({ path: i.path, message: i.message }))).toStrictEqual([
        {
          path: ['upstreams'],
          message:
            'Set exactly one of "upstream:" (single upstream) or "upstreams:" (named ' +
            'multi-upstream list) — not both. To migrate, move the upstream: fields into ' +
            'an upstreams: entry and give it a name.',
        },
      ])
    })

    it.each([
      ['null', null, 'null'],
      ['a string', 'nope', 'string'],
      ['an array', [], 'array'],
      ['a number', 3, 'number'],
    ])('rejects %s root as a type error, not a mode error', (_name, input, received) => {
      // A non-object document is not a config mapping at all — the diagnosis
      // is the type, never the exactly-one-of contract.
      const result = helioConfigSchema.safeParse(input)
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.issues.map((i) => ({ path: i.path, message: i.message }))).toStrictEqual([
        { path: [], message: `Invalid input: expected object, received ${received}` },
      ])
    })

    it('rejects a config that sets neither upstream: nor upstreams:', () => {
      const result = helioConfigSchema.safeParse({ version: '1', dashboard: { enabled: false } })
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.issues.map((i) => ({ path: i.path, message: i.message }))).toStrictEqual([
        {
          path: [],
          message:
            'Missing upstream configuration: set exactly one of "upstream:" (single ' +
            'upstream) or "upstreams:" (named multi-upstream list).',
        },
      ])
    })

    it('rejects an empty upstreams: list with the pinned message', () => {
      const result = helioConfigSchema.safeParse(namedMinimal({ upstreams: [] }))
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.issues.map((i) => ({ path: i.path, message: i.message }))).toStrictEqual([
        {
          path: ['upstreams'],
          message:
            'upstreams: must declare at least one upstream — an empty list would serve ' +
            'nothing. For a single upstream you can keep the "upstream:" form.',
        },
      ])
    })

    it('emits named-mode top-level keys in the canonical section order', () => {
      // Twin of the singular key-order pin: input keys deliberately reversed,
      // upstreams in slot 2.
      const result = helioConfigSchema.safeParse({
        sdk: {},
        dashboard: { enabled: false },
        audit: {},
        approval: {},
        budgets: [],
        policies: {},
        session: {},
        environment: 'production',
        listen: {},
        upstreams: [{ name: 'files', url: 'http://localhost:8081/mcp' }],
        version: '1',
      })
      expect(result.success).toBe(true)
      if (!result.success) return
      expect(Object.keys(result.data)).toEqual([
        'version',
        'upstreams',
        'listen',
        'environment',
        'session',
        'policies',
        'budgets',
        'approval',
        'audit',
        'dashboard',
        'sdk',
      ])
    })

    it('forwards singular-arm issues verbatim through the dispatch', () => {
      // Pinned so the dispatch encoding cannot bury or reword singular errors.
      const result = helioConfigSchema.safeParse(minimalConfig({ upstream: {} }))
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.issues.map((i) => ({ path: i.path, message: i.message }))).toStrictEqual([
        {
          path: ['upstream', 'url'],
          message: '"url" is required when transport is "streamable-http"',
        },
      ])
    })

    it('accepts a stdio entry with command and no url (issue #313)', () => {
      const result = helioConfigSchema.safeParse(
        namedMinimal({
          upstreams: [{ name: 'files', transport: 'stdio', command: 'node' }],
        }),
      )
      expect(result.success).toBe(true)
    })

    it('forwards the named sse missing-url issue with its full path (issue #313)', () => {
      const result = helioConfigSchema.safeParse(
        namedMinimal({
          upstreams: [{ name: 'files', transport: 'sse' }],
        }),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.issues.map((i) => ({ path: i.path, message: i.message }))).toStrictEqual([
        {
          path: ['upstreams', 0, 'url'],
          message: '"url" is required when transport is "sse"',
        },
      ])
    })

    it('narrows with the mode guards', () => {
      const singular = helioConfigSchema.safeParse(minimalConfig())
      const named = helioConfigSchema.safeParse(namedMinimal())
      expect(singular.success).toBe(true)
      expect(named.success).toBe(true)
      if (!singular.success || !named.success) return
      expect(isSingularConfig(singular.data)).toBe(true)
      expect(isNamedConfig(singular.data)).toBe(false)
      expect(isNamedConfig(named.data)).toBe(true)
      expect(isSingularConfig(named.data)).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // match.upstreams vocabulary (issue #293)
  // -------------------------------------------------------------------------

  describe('match.upstreams vocabulary (issue #293)', () => {
    const namedWithRules = (
      rules: unknown[],
      overrides: Record<string, unknown> = {},
    ): Record<string, unknown> => ({
      version: '1',
      upstreams: [
        { name: 'files', url: 'http://localhost:8081/mcp' },
        { name: 'search', url: 'http://localhost:8082/mcp' },
      ],
      policies: { rules },
      dashboard: { enabled: false },
      ...overrides,
    })

    it('accepts a rule scoped to configured upstream names', () => {
      const result = helioConfigSchema.safeParse(
        namedWithRules([{ match: { tool: '*', upstreams: ['files', 'search'] }, action: 'deny' }]),
      )
      expect(result.success).toBe(true)
    })

    it('rejects match.upstreams in singular mode', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          policies: { rules: [{ match: { tool: '*', upstreams: ['files'] }, action: 'deny' }] },
        }),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.issues.map((i) => ({ path: i.path, message: i.message }))).toStrictEqual([
        {
          path: ['policies', 'rules', 0, 'match', 'upstreams'],
          message:
            'Rule sets match.upstreams but the config declares a single "upstream:", which ' +
            'has no name on purpose. Upstream-scoped rules require the named "upstreams:" list.',
        },
      ])
    })

    it('rejects an unknown upstream name at the entry index', () => {
      const result = helioConfigSchema.safeParse(
        namedWithRules([{ match: { tool: '*', upstreams: ['files', 'ghost'] }, action: 'deny' }]),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.issues.map((i) => ({ path: i.path, message: i.message }))).toStrictEqual([
        {
          path: ['policies', 'rules', 0, 'match', 'upstreams', 1],
          message:
            'Rule names upstream "ghost" in match.upstreams but no configured upstream has ' +
            'that name. Every entry must name an upstream from the upstreams: list.',
        },
      ])
    })

    it('rejects an empty match.upstreams list with the pinned message', () => {
      const result = helioConfigSchema.safeParse(
        namedWithRules([{ match: { tool: '*', upstreams: [] }, action: 'deny' }]),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.issues.map((i) => ({ path: i.path, message: i.message }))).toStrictEqual([
        {
          path: ['policies', 'rules', 0, 'match', 'upstreams'],
          message:
            'match.upstreams must name at least one upstream — an empty list matches nothing.',
        },
      ])
    })

    it('rejects match.upstreams combined with match.metadata', () => {
      const result = helioConfigSchema.safeParse(
        namedWithRules([
          {
            match: { upstreams: ['files'], metadata: { channel_id: 'C1' } },
            action: 'deny',
          },
        ]),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.issues.map((i) => ({ path: i.path, message: i.message }))).toStrictEqual([
        {
          path: ['policies', 'rules', 0, 'match', 'upstreams'],
          message:
            'match.upstreams cannot be combined with match.metadata — metadata rules only ' +
            'match on the sideband (host) path and upstream-scoped rules only on the MCP ' +
            'path, so the combination can never match. Split it into two rules.',
        },
      ])
    })

    it('rejects match.upstreams combined with limits.key sender_id', () => {
      const result = helioConfigSchema.safeParse(
        namedWithRules(
          [
            {
              match: { tool: '*', upstreams: ['files'] },
              action: 'allow',
              limits: { key: 'sender_id', max_calls: 10, window: '60s' },
            },
          ],
          { sdk: { enabled: true } },
        ),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.issues.map((i) => ({ path: i.path, message: i.message }))).toStrictEqual([
        {
          path: ['policies', 'rules', 0, 'limits', 'key'],
          message:
            'limits.key "sender_id" cannot be combined with match.upstreams — an ' +
            'upstream-scoped rule only matches on the MCP path, where sender_id is absent ' +
            'and the key would silently collapse to tool scope.',
        },
      ])
    })

    it('rejects match.upstreams combined with limits.max_spend.key sender_id', () => {
      const result = helioConfigSchema.safeParse(
        namedWithRules(
          [
            {
              match: { tool: '*', upstreams: ['files'] },
              action: 'allow',
              limits: {
                max_spend: {
                  field: '$.amount',
                  limit: 100,
                  currency: 'USD',
                  window: '24h',
                  key: 'sender_id',
                },
              },
            },
          ],
          { sdk: { enabled: true } },
        ),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.issues.map((i) => ({ path: i.path, message: i.message }))).toStrictEqual([
        {
          path: ['policies', 'rules', 0, 'limits', 'max_spend', 'key'],
          message:
            'limits.max_spend.key "sender_id" cannot be combined with match.upstreams — an ' +
            'upstream-scoped rule only matches on the MCP path, where sender_id is absent ' +
            'and the key would silently collapse to tool scope.',
        },
      ])
    })

    it('adds no new rejection for agent keys on an upstream-scoped rule', () => {
      // Pinned exemption: agent keys stay warn-only at compile time; the
      // schema must not invent a rejection for them.
      const result = helioConfigSchema.safeParse(
        namedWithRules([
          {
            match: { tool: '*', upstreams: ['files'] },
            action: 'allow',
            limits: { key: 'agent', max_calls: 10, window: '60s' },
          },
        ]),
      )
      expect(result.success).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // Budget contributor upstreams scoping (issue #293)
  // -------------------------------------------------------------------------

  describe('budget contributor upstreams scoping (issue #293)', () => {
    const namedWithBudgets = (
      budgets: unknown[],
      overrides: Record<string, unknown> = {},
    ): Record<string, unknown> => ({
      version: '1',
      upstreams: [
        { name: 'files', url: 'http://localhost:8081/mcp' },
        { name: 'search', url: 'http://localhost:8082/mcp' },
      ],
      budgets,
      dashboard: { enabled: false },
      ...overrides,
    })

    const budget = (
      contributors: unknown[],
      overrides: Record<string, unknown> = {},
    ): Record<string, unknown> => ({
      name: 'cap',
      limit: 100,
      currency: 'USD',
      window: '24h',
      key: 'global',
      on_exceed: 'deny',
      contributors,
      ...overrides,
    })

    it('accepts a contributor scoped to configured upstream names', () => {
      const result = helioConfigSchema.safeParse(
        namedWithBudgets([
          budget([{ match: { tool: 'stripe_*', upstreams: ['files'] }, field: '$.amount' }]),
        ]),
      )
      expect(result.success).toBe(true)
    })

    it('rejects a scoped contributor in singular mode', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          budgets: [
            budget([{ match: { tool: 'stripe_*', upstreams: ['files'] }, field: '$.amount' }]),
          ],
        }),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.issues.map((i) => ({ path: i.path, message: i.message }))).toStrictEqual([
        {
          path: ['budgets', 0, 'contributors', 0, 'match', 'upstreams'],
          message:
            'Contributor sets match.upstreams but the config declares a single "upstream:", ' +
            'which has no name on purpose. Upstream-scoped contributors require the named ' +
            '"upstreams:" list.',
        },
      ])
    })

    it('rejects an unknown upstream name at the contributor entry index', () => {
      const result = helioConfigSchema.safeParse(
        namedWithBudgets([
          budget([
            { match: { tool: 'stripe_*', upstreams: ['files', 'ghost'] }, field: '$.amount' },
          ]),
        ]),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.issues.map((i) => ({ path: i.path, message: i.message }))).toStrictEqual([
        {
          path: ['budgets', 0, 'contributors', 0, 'match', 'upstreams', 1],
          message:
            'Contributor names upstream "ghost" in match.upstreams but no configured ' +
            'upstream has that name. Every entry must name an upstream from the upstreams: list.',
        },
      ])
    })

    it('rejects an empty contributor upstreams list with the pinned message', () => {
      const result = helioConfigSchema.safeParse(
        namedWithBudgets([
          budget([{ match: { tool: 'stripe_*', upstreams: [] }, field: '$.amount' }]),
        ]),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.issues.map((i) => ({ path: i.path, message: i.message }))).toStrictEqual([
        {
          path: ['budgets', 0, 'contributors', 0, 'match', 'upstreams'],
          message:
            'match.upstreams must name at least one upstream — an empty list matches nothing.',
        },
      ])
    })

    it('rejects a sender_id budget whose contributors are all upstream-scoped', () => {
      const result = helioConfigSchema.safeParse(
        namedWithBudgets(
          [
            budget(
              [
                { match: { tool: 'stripe_*', upstreams: ['files'] }, field: '$.amount' },
                { match: { tool: 'paypal_*', upstreams: ['search'] }, field: '$.total' },
              ],
              { key: 'sender_id' },
            ),
          ],
          { sdk: { enabled: true } },
        ),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.issues.map((i) => ({ path: i.path, message: i.message }))).toStrictEqual([
        {
          path: ['budgets', 0, 'key'],
          message:
            'budget key "sender_id" requires at least one contributor without an ' +
            '"upstreams" scope — upstream-scoped contributors only match MCP calls, which ' +
            'never carry a sender, so every charge would land in the shared "unknown" pot ' +
            'while sideband calls (the only ones with real senders) never feed this budget.',
        },
      ])
    })

    it('accepts a sender_id budget with at least one unscoped contributor', () => {
      const result = helioConfigSchema.safeParse(
        namedWithBudgets(
          [
            budget(
              [
                { match: { tool: 'stripe_*', upstreams: ['files'] }, field: '$.amount' },
                { match: { tool: 'paypal_*' }, field: '$.total' },
              ],
              { key: 'sender_id' },
            ),
          ],
          { sdk: { enabled: true } },
        ),
      )
      expect(result.success).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // Named-mode legacy_header identity guard (issue #293)
  // -------------------------------------------------------------------------

  describe('named-mode legacy_header identity guard (issue #293)', () => {
    const identityGuardMessage =
      'session.identity includes "legacy_header" while named upstreams and evidence-gated ' +
      'rules ("evidence"/"requires") are configured. On the legacy relay flow the ' +
      'Mcp-Session-Id a client echoes was minted by the upstream itself, so with multiple ' +
      'upstreams a hostile server could collide session identities across doors and ' +
      "pollute another door's evidence gates. Remove legacy_header from session.identity " +
      'and use a caller-owned source such as the default "x-helio-session-id" header.'

    const namedConfig = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
      version: '1',
      upstreams: [{ name: 'files', url: 'http://localhost:8081/mcp' }],
      dashboard: { enabled: false },
      ...overrides,
    })

    const explicitLegacyChain = {
      identity: [{ source: 'header', name: 'x-helio-session-id' }, { source: 'legacy_header' }],
    }

    it('rejects named + evidence rule + explicit legacy_header chain at the legacy index', () => {
      const result = helioConfigSchema.safeParse(
        namedConfig({
          session: explicitLegacyChain,
          policies: {
            rules: [
              { match: { tool: '*' }, action: 'allow', evidence: { requires: ['fact-check'] } },
            ],
          },
        }),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.issues.map((i) => ({ path: i.path, message: i.message }))).toStrictEqual([
        { path: ['session', 'identity', 1], message: identityGuardMessage },
      ])
    })

    it('rejects named + bare requires rule under the DEFAULT session chain', () => {
      // The default identity chain carries legacy_header at index 1 — the
      // guard deliberately fires here too, and the message spells the remedy.
      const result = helioConfigSchema.safeParse(
        namedConfig({
          policies: {
            rules: [{ match: { tool: '*' }, action: 'allow', requires: ['deploy_ticket'] }],
          },
        }),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.issues.map((i) => ({ path: i.path, message: i.message }))).toStrictEqual([
        { path: ['session', 'identity', 1], message: identityGuardMessage },
      ])
    })

    it('accepts singular + evidence rule + legacy_header', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          session: explicitLegacyChain,
          policies: {
            rules: [
              { match: { tool: '*' }, action: 'allow', evidence: { requires: ['fact-check'] } },
            ],
          },
        }),
      )
      expect(result.success).toBe(true)
    })

    it('accepts named + evidence rule + header-only chain', () => {
      const result = helioConfigSchema.safeParse(
        namedConfig({
          session: { identity: [{ source: 'header', name: 'x-helio-session-id' }] },
          policies: {
            rules: [
              { match: { tool: '*' }, action: 'allow', evidence: { requires: ['fact-check'] } },
            ],
          },
        }),
      )
      expect(result.success).toBe(true)
    })

    it('accepts named + requires_success-only rule + legacy_header', () => {
      // requires_success alone is inert at runtime — it only modifies a
      // non-empty requires list, so it must not trip the guard.
      const result = helioConfigSchema.safeParse(
        namedConfig({
          session: explicitLegacyChain,
          policies: {
            rules: [{ match: { tool: '*' }, action: 'allow', requires_success: true }],
          },
        }),
      )
      expect(result.success).toBe(true)
    })

    it('accepts named + empty evidence.requires + legacy_header (runtime-gate alignment)', () => {
      // An empty requires list never gates at runtime; a key-presence
      // predicate would reject configs the pipeline treats as ungated.
      const result = helioConfigSchema.safeParse(
        namedConfig({
          session: explicitLegacyChain,
          policies: {
            rules: [{ match: { tool: '*' }, action: 'allow', evidence: { requires: [] } }],
          },
        }),
      )
      expect(result.success).toBe(true)
    })

    it('accepts named + empty bare requires + legacy_header (runtime-gate alignment)', () => {
      const result = helioConfigSchema.safeParse(
        namedConfig({
          session: explicitLegacyChain,
          policies: {
            rules: [{ match: { tool: '*' }, action: 'allow', requires: [] }],
          },
        }),
      )
      expect(result.success).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // Session identity (issue #218)
  // -------------------------------------------------------------------------

  describe('session identity (issue #218)', () => {
    it('applies the default chain and mode when the section is absent', () => {
      const result = helioConfigSchema.safeParse(minimalConfig())
      expect(result.success).toBe(true)
      if (!result.success) return
      expect(result.data.session).toEqual({
        identity: [{ source: 'header', name: 'x-helio-session-id' }, { source: 'legacy_header' }],
        on_unresolved: 'deny',
      })
    })

    it('defaults header name to x-helio-session-id when omitted', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({ session: { identity: [{ source: 'header' }] } }),
      )
      expect(result.success).toBe(true)
      if (!result.success) return
      expect(result.data.session.identity).toEqual([
        { source: 'header', name: 'x-helio-session-id' },
      ])
      expect(result.data.session.on_unresolved).toBe('deny')
    })

    it('accepts an explicit chain and lowercases header names', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          session: {
            identity: [
              { source: 'header', name: 'X-Team-Session' },
              { source: 'meta' },
              { source: 'legacy_header' },
            ],
            on_unresolved: 'anonymous',
          },
        }),
      )
      expect(result.success).toBe(true)
      if (!result.success) return
      expect(result.data.session.identity[0]).toEqual({ source: 'header', name: 'x-team-session' })
      expect(result.data.session.on_unresolved).toBe('anonymous')
    })

    it('rejects an explicit empty identity chain', () => {
      // An explicit [] would override the default and permanently unresolve
      // every request — dead config, same treatment as contributors .min(1).
      const result = helioConfigSchema.safeParse(minimalConfig({ session: { identity: [] } }))
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.issues[0]?.path).toEqual(['session', 'identity'])
      expect(result.error.issues[0]?.message).toMatch(/unresolved/)
    })

    it('rejects an unknown key in session (no ttl knob)', () => {
      const result = helioConfigSchema.safeParse(minimalConfig({ session: { ttl: '1h' } }))
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.issues[0]?.path).toEqual(['session'])
      expect(result.error.issues[0]?.message).toBe('Unrecognized key: "ttl"')
    })

    it('rejects an unknown key inside an identity source entry (no meta path)', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({ session: { identity: [{ source: 'meta', path: '$.x' }] } }),
      )
      expect(result.success).toBe(false)
    })

    it('rejects an unknown source with the identity index in the path', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({ session: { identity: [{ source: 'auth_subject' }] } }),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.issues[0]?.path.slice(0, 3)).toEqual(['session', 'identity', 0])
    })

    it('rejects a header name without the x- prefix', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({ session: { identity: [{ source: 'header', name: 'session-id' }] } }),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.issues[0]?.path).toEqual(['session', 'identity', 0, 'name'])
      expect(result.error.issues[0]?.message).toMatch(/start with "x-"/)
    })

    it('rejects reserved transport headers as identity headers', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({ session: { identity: [{ source: 'header', name: 'Mcp-Session-Id' }] } }),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      const reservedIssue = result.error.issues.find((issue) => /reserved/i.test(issue.message))
      expect(reservedIssue?.path).toEqual(['session', 'identity', 0, 'name'])
    })

    it('rejects duplicate header names case-insensitively', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          session: {
            identity: [
              { source: 'header', name: 'x-run-id' },
              { source: 'header', name: 'X-Run-Id' },
            ],
          },
        }),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.issues[0]?.path).toEqual(['session', 'identity', 1, 'name'])
      expect(result.error.issues[0]?.message).toMatch(/[Dd]uplicate/)
    })

    it('accepts two header sources with distinct names', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          session: {
            identity: [{ source: 'header', name: 'x-run-id' }, { source: 'header' }],
          },
        }),
      )
      expect(result.success).toBe(true)
    })

    it('rejects on_unresolved values outside deny | anonymous', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({ session: { on_unresolved: 'warn' } }),
      )
      expect(result.success).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // Version
  // -------------------------------------------------------------------------

  describe('version', () => {
    it('rejects version "2"', () => {
      const result = helioConfigSchema.safeParse(minimalConfig({ version: '2' }))
      expect(result.success).toBe(false)
    })

    it('rejects missing version', () => {
      const { version: _, ...noVersion } = minimalConfig()
      const result = helioConfigSchema.safeParse(noVersion)
      expect(result.success).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // Upstream
  // -------------------------------------------------------------------------

  describe('upstream', () => {
    it('rejects missing url for sse transport with the transport-naming message (issue #313)', () => {
      const result = helioConfigSchema.safeParse(minimalConfig({ upstream: { transport: 'sse' } }))
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.issues.map((i) => ({ path: i.path, message: i.message }))).toStrictEqual([
        {
          path: ['upstream', 'url'],
          message: '"url" is required when transport is "sse"',
        },
      ])
    })

    it('reports both the missing url and sibling violations in one parse (issue #313)', () => {
      // Pre-#313 the missing-url failure happened at base object parse, which
      // masked every superRefine family until the url was supplied.
      const result = helioConfigSchema.safeParse(
        minimalConfig({ upstream: { forward_headers: ['nope'] } }),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      const issues = result.error.issues.map((i) => ({ path: i.path, message: i.message }))
      expect(issues).toHaveLength(2)
      expect(issues).toContainEqual({
        path: ['upstream', 'url'],
        message: '"url" is required when transport is "streamable-http"',
      })
      expect(issues).toContainEqual({
        path: ['upstream', 'forward_headers', 0],
        message: 'Forwarded caller headers must start with "x-"',
      })
    })

    it('rejects stdio transport without command', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          upstream: { url: 'http://localhost:8080', transport: 'stdio' },
        }),
      )
      expect(result.success).toBe(false)
    })

    it('accepts stdio transport with command', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          upstream: {
            url: 'http://localhost:8080',
            transport: 'stdio',
            command: 'node',
            args: ['server.js'],
          },
        }),
      )
      expect(result.success).toBe(true)
    })

    it('accepts stdio transport with command and no url (issue #313)', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          upstream: {
            transport: 'stdio',
            command: 'node',
            args: ['server.js'],
          },
        }),
      )
      expect(result.success).toBe(true)
    })

    it('reports the missing command, not url, for a stdio upstream with neither (issue #313)', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({ upstream: { transport: 'stdio' } }),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.issues.map((i) => ({ path: i.path, message: i.message }))).toStrictEqual([
        {
          path: ['upstream', 'command'],
          message: '"command" is required when transport is "stdio"',
        },
      ])
    })

    it('reports sibling violations for a url-less stdio upstream (issue #313)', () => {
      // The operator is told about the real problem, never about a field the
      // stdio transport does not use.
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          upstream: {
            transport: 'stdio',
            command: 'node',
            forward_headers: ['nope'],
          },
        }),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.issues.map((i) => ({ path: i.path, message: i.message }))).toStrictEqual([
        {
          path: ['upstream', 'forward_headers', 0],
          message: 'Forwarded caller headers must start with "x-"',
        },
      ])
    })

    it('accepts allowlisted forwarded caller headers that start with x-', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          upstream: {
            url: 'http://localhost:8080',
            forward_headers: ['x-request-id', 'x-trace-id'],
          },
        }),
      )
      expect(result.success).toBe(true)
    })

    it('rejects forwarded caller headers that do not start with x-', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          upstream: {
            url: 'http://localhost:8080',
            forward_headers: ['authorization'],
          },
        }),
      )
      expect(result.success).toBe(false)
    })

    it('accepts a string-to-string headers map', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          upstream: {
            url: 'http://localhost:8080',
            headers: { Authorization: 'Bearer abc' },
          },
        }),
      )
      expect(result.success).toBe(true)
      if (!result.success) return
      expect(isSingularConfig(result.data)).toBe(true)
      if (!isSingularConfig(result.data)) return
      expect(result.data.upstream.headers).toEqual({ Authorization: 'Bearer abc' })
    })

    it('rejects non-string header values', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          upstream: {
            url: 'http://localhost:8080',
            headers: { 'X-Count': 3 },
          },
        }),
      )
      expect(result.success).toBe(false)
    })

    it('rejects reserved protocol headers (case-insensitive)', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          upstream: {
            url: 'http://localhost:8080',
            headers: { 'Mcp-Session-Id': 'bad', 'content-type': 'text/plain' },
          },
        }),
      )
      expect(result.success).toBe(false)
    })

    it.each(['mcp-method', 'Mcp-Name'])(
      'rejects reserved modern transport header %s (case-insensitive)',
      (name) => {
        const result = helioConfigSchema.safeParse(
          minimalConfig({
            upstream: {
              url: 'http://localhost:8080',
              headers: { [name]: 'x' },
            },
          }),
        )
        expect(result.success).toBe(false)
        if (result.success) return
        const reservedIssue = result.error.issues.find((issue) => /reserved/i.test(issue.message))
        expect(reservedIssue).toBeDefined()
      },
    )

    it.each(['accept', 'Accept'])(
      'rejects reserved header %s (issue #304, case-insensitive)',
      (name) => {
        const result = helioConfigSchema.safeParse(
          minimalConfig({
            upstream: {
              url: 'http://localhost:8080',
              headers: { [name]: 'application/xml' },
            },
          }),
        )
        expect(result.success).toBe(false)
        if (result.success) return
        const reservedIssue = result.error.issues.find((issue) => /reserved/i.test(issue.message))
        expect(reservedIssue).toBeDefined()
        expect(reservedIssue?.path).toEqual(['upstream', 'headers', name])
      },
    )
  })

  // -------------------------------------------------------------------------
  // Upstream protocol version pin (issue #219)
  // -------------------------------------------------------------------------

  describe('upstream.protocol_version (issue #219)', () => {
    it('defaults to auto when omitted', () => {
      const result = helioConfigSchema.safeParse(minimalConfig())
      expect(result.success).toBe(true)
      if (!result.success) return
      expect(isSingularConfig(result.data)).toBe(true)
      if (!isSingularConfig(result.data)) return
      expect(result.data.upstream.protocol_version).toBe('auto')
    })

    it.each(['auto', '2025-06-18', '2026-07-28'])('accepts "%s" on streamable-http', (version) => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          upstream: { url: 'http://localhost:8080', protocol_version: version },
        }),
      )
      expect(result.success).toBe(true)
      if (!result.success) return
      expect(isSingularConfig(result.data)).toBe(true)
      if (!isSingularConfig(result.data)) return
      expect(result.data.upstream.protocol_version).toBe(version)
    })

    it.each(['2024-11-05', 'latest', 'modern', ''])('rejects unknown value "%s"', (version) => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          upstream: { url: 'http://localhost:8080', protocol_version: version },
        }),
      )
      expect(result.success).toBe(false)
    })

    it('rejects 2026-07-28 with transport sse', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          upstream: {
            url: 'http://localhost:8080',
            transport: 'sse',
            protocol_version: '2026-07-28',
          },
        }),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      const issue = result.error.issues.find((candidate) =>
        candidate.path.join('.').includes('protocol_version'),
      )
      expect(issue).toBeDefined()
    })

    it('rejects 2026-07-28 with transport stdio, pointing at #256', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          upstream: {
            url: 'http://localhost:8080',
            transport: 'stdio',
            command: 'node',
            protocol_version: '2026-07-28',
          },
        }),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      const issue = result.error.issues.find((candidate) =>
        candidate.path.join('.').includes('protocol_version'),
      )
      expect(issue).toBeDefined()
      expect(issue?.message).toContain('#256')
    })

    it.each([
      { transport: 'streamable-http' },
      { transport: 'sse' },
      { transport: 'stdio', command: 'node' },
    ])('accepts 2025-06-18 with transport $transport', (upstreamExtras) => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          upstream: {
            url: 'http://localhost:8080',
            protocol_version: '2025-06-18',
            ...upstreamExtras,
          },
        }),
      )
      expect(result.success).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // Port validation
  // -------------------------------------------------------------------------

  describe('port validation', () => {
    it('rejects port 0', () => {
      const result = helioConfigSchema.safeParse(minimalConfig({ listen: { port: 0 } }))
      expect(result.success).toBe(false)
    })

    it('rejects port 65536', () => {
      const result = helioConfigSchema.safeParse(minimalConfig({ listen: { port: 65536 } }))
      expect(result.success).toBe(false)
    })

    it('accepts port 3000', () => {
      const result = helioConfigSchema.safeParse(minimalConfig({ listen: { port: 3000 } }))
      expect(result.success).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // listen.allowed_origins (issue #213)
  // -------------------------------------------------------------------------

  describe('listen.allowed_origins', () => {
    it('defaults to an empty list', () => {
      const result = helioConfigSchema.safeParse(minimalConfig())
      expect(result.success).toBe(true)
      if (!result.success) return
      expect(result.data.listen.allowed_origins).toEqual([])
    })

    it('accepts a list of serialized http(s) origins', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          listen: {
            allowed_origins: ['http://localhost:5173', 'http://[::1]:3000', 'https://app.example'],
          },
        }),
      )
      expect(result.success).toBe(true)
      if (!result.success) return
      expect(result.data.listen.allowed_origins).toEqual([
        'http://localhost:5173',
        'http://[::1]:3000',
        'https://app.example',
      ])
    })

    it('rejects a non-array value', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({ listen: { allowed_origins: 'http://localhost:5173' } }),
      )
      expect(result.success).toBe(false)
    })

    it('rejects an array containing a non-string', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({ listen: { allowed_origins: [5173] } }),
      )
      expect(result.success).toBe(false)
    })

    it('still rejects an unknown key under listen', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({ listen: { allowed_origin: ['http://localhost:5173'] } }),
      )
      expect(result.success).toBe(false)
    })

    it.each([
      ['http://localhost:5173/', 'http://localhost:5173'],
      ['http://LocalHost:5173', 'http://localhost:5173'],
      ['http://localhost:80', 'http://localhost'],
      ['https://app.example:443', 'https://app.example'],
    ])('rejects "%s" naming the normalized form "%s"', (entry, normalized) => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({ listen: { allowed_origins: [entry] } }),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      const issue = result.error.issues[0]
      expect(issue?.path).toEqual(['listen', 'allowed_origins', 0])
      expect(issue?.message).toContain(normalized)
    })

    it.each(['ws://app.example', 'wss://app.example', 'ftp://files.example'])(
      'rejects the non-http(s) scheme "%s"',
      (entry) => {
        // These have tuple origins, so `new URL(entry).origin === entry` alone
        // accepts them — yet no browser ever sends such an Origin, making the
        // entry silently unmatchable.
        const result = helioConfigSchema.safeParse(
          minimalConfig({ listen: { allowed_origins: [entry] } }),
        )
        expect(result.success).toBe(false)
        if (result.success) return
        expect(result.error.issues[0]?.path).toEqual(['listen', 'allowed_origins', 0])
        expect(result.error.issues[0]?.message).toContain('http(s)')
      },
    )

    it('rejects "file://" without allowlisting the opaque origin', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({ listen: { allowed_origins: ['file://'] } }),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.issues[0]?.path).toEqual(['listen', 'allowed_origins', 0])
      expect(result.error.issues[0]?.message).toContain('http(s)')
    })

    it('rejects the literal "null"', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({ listen: { allowed_origins: ['null'] } }),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.issues[0]?.path).toEqual(['listen', 'allowed_origins', 0])
    })

    it('rejects the literal "*"', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({ listen: { allowed_origins: ['*'] } }),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.issues[0]?.path).toEqual(['listen', 'allowed_origins', 0])
    })
  })

  // -------------------------------------------------------------------------
  // Dashboard — SSE heartbeat interval
  // -------------------------------------------------------------------------

  describe('dashboard.sse_heartbeat_interval', () => {
    it('accepts a custom interval', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          dashboard: { enabled: true, api_secret: 'test-secret', sse_heartbeat_interval: '10s' },
        }),
      )
      expect(result.success).toBe(true)
      if (!result.success) return
      expect(result.data.dashboard.sse_heartbeat_interval).toBe('10s')
    })

    it('rejects an invalid duration', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          dashboard: { enabled: true, api_secret: 'test-secret', sse_heartbeat_interval: 'fast' },
        }),
      )
      expect(result.success).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // Policies — dry_run
  // -------------------------------------------------------------------------

  describe('policies.dry_run', () => {
    it('defaults to false', () => {
      const result = helioConfigSchema.safeParse(minimalConfig())
      expect(result.success).toBe(true)
      if (!result.success) return
      expect(result.data.policies.dry_run).toBe(false)
    })

    it('accepts true', () => {
      const result = helioConfigSchema.safeParse(minimalConfig({ policies: { dry_run: true } }))
      expect(result.success).toBe(true)
      if (!result.success) return
      expect(result.data.policies.dry_run).toBe(true)
    })

    it('rejects non-boolean value', () => {
      const result = helioConfigSchema.safeParse(minimalConfig({ policies: { dry_run: 'yes' } }))
      expect(result.success).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // Policy rules
  // -------------------------------------------------------------------------

  describe('policy rules', () => {
    it('accepts a minimal rule', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          policies: {
            rules: [{ match: { tool: '*' }, action: 'allow' }],
          },
        }),
      )
      expect(result.success).toBe(true)
    })

    it('accepts a full rule with all fields including escalation_after', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          environment: 'production',
          dashboard: { api_secret: 'test-secret' },
          approval: {
            channels: [
              {
                type: 'slack',
                name: 'slack',
                bot_token: 'xoxb-123',
                signing_secret: 'secret',
                channel: '#approvals',
              },
              { type: 'webhook', name: 'webhook-fallback', url: 'https://example.com/hook' },
            ],
          },
          policies: {
            default: 'deny',
            flag_destructive: 'require_approval',
            rules: [
              {
                name: 'approve-writes',
                match: {
                  tool: 'send_*',
                  annotations: { destructiveHint: true },
                  input: { '$.amount': { gt: 1000 } },
                  environment: 'production',
                },
                action: 'require_approval',
                approval: {
                  channel: 'slack',
                  timeout: '300s',
                  delegates: ['webhook-fallback'],
                  escalation_after: '120s',
                },
                evidence: { requires: ['orders.lookup'] },
                requires: ['customer.verify'],
                limits: {
                  max_calls: 100,
                  window: '1h',
                  key: 'agent',
                  max_spend: {
                    field: 'input.amount',
                    limit: 5000,
                    currency: 'GBP',
                    window: '24h',
                  },
                },
                feedback: { message: 'Requires payments team approval.' },
              },
            ],
          },
        }),
      )
      expect(result.success).toBe(true)
    })

    it('rejects an invalid action', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          policies: {
            rules: [{ match: { tool: '*' }, action: 'invalid_action' }],
          },
        }),
      )
      expect(result.success).toBe(false)
    })

    it('rejects input condition with no operators', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          policies: {
            rules: [{ match: { tool: '*', input: { '$.x': {} } }, action: 'deny' }],
          },
        }),
      )
      expect(result.success).toBe(false)
    })

    it('rejects match.environment when top-level environment is unset', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          policies: {
            rules: [
              {
                name: 'prod-only-rule',
                match: { tool: 'create_payment', environment: 'production' },
                action: 'deny',
              },
            ],
          },
        }),
      )

      expect(result.success).toBe(false)
      if (result.success) return
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths).toContain('policies.rules.0.match.environment')
    })

    it('accepts match.environment when top-level environment is set', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          environment: 'production',
          policies: {
            rules: [
              {
                name: 'prod-only-rule',
                match: { tool: 'create_payment', environment: 'production' },
                action: 'deny',
              },
            ],
          },
        }),
      )

      expect(result.success).toBe(true)
    })

    it('accepts approval config without escalation_after (backwards compatible)', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          dashboard: { api_secret: 'test-secret' },
          approval: {
            channels: [
              {
                type: 'slack',
                name: 'slack',
                bot_token: 'xoxb-123',
                signing_secret: 'secret',
                channel: '#approvals',
              },
            ],
          },
          policies: {
            rules: [
              {
                match: { tool: '*' },
                action: 'require_approval',
                approval: { channel: 'slack', timeout: '300s' },
              },
            ],
          },
        }),
      )
      expect(result.success).toBe(true)
    })

    it('rejects rate_limit rules without limits.max_calls', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          policies: {
            rules: [{ match: { tool: '*' }, action: 'rate_limit', limits: { window: '1m' } }],
          },
        }),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths).toContain('policies.rules.0.limits.max_calls')
    })

    it('rejects rate_limit rules without limits.window', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          policies: {
            rules: [{ match: { tool: '*' }, action: 'rate_limit', limits: { max_calls: 5 } }],
          },
        }),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths).toContain('policies.rules.0.limits.window')
    })

    it('rejects spend_limit rules without limits.max_spend', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          policies: {
            rules: [{ match: { tool: '*' }, action: 'spend_limit', limits: {} }],
          },
        }),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths).toContain('policies.rules.0.limits.max_spend')
    })

    it('rejects unknown annotation keys', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          policies: {
            rules: [
              {
                match: { tool: '*', annotations: { unknownHint: true } },
                action: 'deny',
              },
            ],
          },
        }),
      )
      expect(result.success).toBe(false)
    })

    it('rejects unknown keys in match blocks', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          policies: {
            rules: [
              {
                match: { tool: '*', typo_field: true },
                action: 'deny',
              },
            ],
          },
        }),
      )
      expect(result.success).toBe(false)
    })

    it('rejects unknown keys in policy rule blocks', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          policies: {
            rules: [
              {
                match: { tool: '*' },
                action: 'deny',
                typo_field: true,
              },
            ],
          },
        }),
      )
      expect(result.success).toBe(false)
    })

    it('rejects unknown keys in policies block', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          policies: {
            default: 'allow',
            rules: [{ match: { tool: '*' }, action: 'allow' }],
            typo_field: true,
          },
        }),
      )
      expect(result.success).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // Approval channels
  // -------------------------------------------------------------------------

  describe('approval channels', () => {
    it('accepts a slack channel', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          approval: {
            channels: [
              {
                type: 'slack',
                bot_token: 'xoxb-123',
                signing_secret: 'abc123',
                channel: '#approvals',
              },
            ],
          },
        }),
      )
      expect(result.success).toBe(true)
    })

    it('accepts a webhook channel', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          dashboard: { enabled: true, api_secret: 'unit-test-secret' },
          approval: {
            channels: [{ type: 'webhook', url: 'https://example.com/hook' }],
          },
        }),
      )
      expect(result.success).toBe(true)
    })

    it('rejects webhook channel when dashboard is disabled', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          dashboard: { enabled: false },
          approval: {
            channels: [{ type: 'webhook', url: 'https://example.com/hook' }],
          },
        }),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths).toContain('dashboard.enabled')
    })

    it('accepts a dashboard channel', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          approval: { channels: [{ type: 'dashboard' }] },
        }),
      )
      expect(result.success).toBe(true)
    })

    it('rejects an unknown channel type', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          approval: { channels: [{ type: 'email' }] },
        }),
      )
      expect(result.success).toBe(false)
    })

    it('rejects slack channel missing bot_token', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          approval: {
            channels: [{ type: 'slack', channel: '#approvals' }],
          },
        }),
      )
      expect(result.success).toBe(false)
    })

    it('rejects policy rule approval channel references that are not configured', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          dashboard: { api_secret: 'unit-test-secret' },
          policies: {
            rules: [
              {
                match: { tool: 'write_*' },
                action: 'require_approval',
                approval: { channel: 'missing-channel' },
              },
            ],
          },
        }),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths).toContain('policies.rules.0.approval.channel')
    })

    it('rejects delegate references that are not configured channel names', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          dashboard: { api_secret: 'unit-test-secret' },
          approval: {
            channels: [
              {
                type: 'slack',
                name: 'primary',
                bot_token: 'xoxb-123',
                signing_secret: 'secret',
                channel: '#ops',
              },
              { type: 'webhook', name: 'fallback', url: 'https://example.com/hook' },
            ],
          },
          policies: {
            rules: [
              {
                match: { tool: 'write_*' },
                action: 'require_approval',
                approval: {
                  channel: 'primary',
                  delegates: ['unknown'],
                },
              },
            ],
          },
        }),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths).toContain('policies.rules.0.approval.delegates.0')
    })

    it('accepts approval channel and delegates that reference configured names', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          dashboard: { api_secret: 'unit-test-secret' },
          approval: {
            channels: [
              {
                type: 'slack',
                name: 'primary',
                bot_token: 'xoxb-123',
                signing_secret: 'secret',
                channel: '#ops',
              },
              { type: 'webhook', name: 'fallback', url: 'https://example.com/hook' },
            ],
          },
          policies: {
            rules: [
              {
                match: { tool: 'write_*' },
                action: 'require_approval',
                approval: {
                  channel: 'primary',
                  delegates: ['fallback'],
                },
              },
            ],
          },
        }),
      )
      expect(result.success).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // Full complex config
  // -------------------------------------------------------------------------

  describe('full complex config', () => {
    it('parses a complete configuration', () => {
      const config = {
        version: '1',
        upstream: { url: 'http://localhost:8080/mcp', transport: 'sse' },
        listen: { port: 4000, host: '0.0.0.0' },
        dashboard: {
          enabled: true,
          port: 4100,
          sse_heartbeat_interval: '10s',
          api_secret: 'test-secret',
        },
        policies: {
          default: 'deny',
          flag_destructive: 'log',
          rules: [
            { match: { tool: 'read_*' }, action: 'allow' },
            {
              match: { tool: 'write_*', annotations: { readOnlyHint: false } },
              action: 'require_approval',
              approval: { channel: 'slack' },
            },
          ],
        },
        approval: {
          timeout: '600s',
          default_on_timeout: 'deny',
          channels: [
            { type: 'slack', bot_token: 'xoxb-tok', signing_secret: 'sec123', channel: '#ops' },
            { type: 'webhook', url: 'https://hook.example.com', secret: 's3cret' },
            { type: 'dashboard' },
          ],
        },
        audit: {
          storage: 'sqlite',
          path: '/data/helio.db',
          retention: '365d',
          include_responses: false,
        },
        sdk: { enabled: true, port: 4200, host: '127.0.0.1' },
      }

      const result = helioConfigSchema.safeParse(config)
      expect(result.success).toBe(true)
      if (!result.success) return

      expect(result.data.listen.port).toBe(4000)
      expect(result.data.policies.rules).toHaveLength(2)
      expect(result.data.approval.channels).toHaveLength(3)
      expect(result.data.audit.retention).toBe('365d')
      expect(result.data.sdk.enabled).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // superRefine rejects require_approval without api_secret
  // -------------------------------------------------------------------------

  describe('api_secret enforcement', () => {
    it('rejects require_approval rule with no api_secret and paths to dashboard.api_secret', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          policies: {
            rules: [
              {
                match: { tool: 'write_*' },
                action: 'require_approval',
                approval: { channel: 'dashboard' },
              },
            ],
          },
        }),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths).toContain('dashboard.api_secret')
    })

    it('rejects flag_destructive: require_approval with no api_secret', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({ policies: { flag_destructive: 'require_approval' } }),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths).toContain('dashboard.api_secret')
    })

    it('accepts require_approval rule when dashboard.api_secret is set', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          dashboard: { api_secret: 'unit-test-secret' },
          policies: {
            rules: [
              {
                match: { tool: '*' },
                action: 'require_approval',
                approval: { channel: 'dashboard' },
              },
            ],
          },
        }),
      )
      expect(result.success).toBe(true)
    })

    it('rejects approval.api_secret — the legacy alias was removed', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          approval: { api_secret: 'should-be-rejected' },
          policies: {
            rules: [
              {
                match: { tool: '*' },
                action: 'require_approval',
                approval: { channel: 'dashboard' },
              },
            ],
          },
        }),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      // Strict approval rejects the removed #144 alias BY NAME — a better
      // error than the pre-#182 shape, where the lax schema dropped the
      // alias and the cross-validator then demanded the dashboard secret.
      expect(result.error.issues).toHaveLength(1)
      expect(result.error.issues[0]?.code).toBe('unrecognized_keys')
      expect(result.error.issues[0]?.path).toEqual(['approval'])
      expect(result.error.issues[0]?.message).toBe('Unrecognized key: "api_secret"')
    })

    it('rejects empty-string dashboard.api_secret when require_approval is used', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          dashboard: { api_secret: '' },
          policies: { flag_destructive: 'require_approval' },
        }),
      )
      expect(result.success).toBe(false)
    })

    it('does not fire when no approval features are used', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          policies: { rules: [{ match: { tool: '*' }, action: 'allow' }] },
        }),
      )
      expect(result.success).toBe(true)
    })

    it('error message points at helio secret', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({ policies: { flag_destructive: 'require_approval' } }),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      const msg = result.error.issues.find(
        (i) => i.path.join('.') === 'dashboard.api_secret',
      )?.message
      expect(msg).toContain('helio secret')
    })
  })

  // -------------------------------------------------------------------------
  // Policies — on_tool_drift
  // -------------------------------------------------------------------------

  describe('policies.on_tool_drift', () => {
    it.each(['block', 'log'] as const)('accepts %s', (mode) => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({ policies: { on_tool_drift: mode } }),
      )
      expect(result.success).toBe(true)
    })

    it('accepts require_approval when dashboard.api_secret is set', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          policies: { on_tool_drift: 'require_approval' },
          dashboard: { api_secret: 'a'.repeat(64) },
        }),
      )
      expect(result.success).toBe(true)
    })

    it('rejects require_approval without dashboard.api_secret', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({ policies: { on_tool_drift: 'require_approval' } }),
      )
      expect(result.success).toBe(false)
    })

    it('rejects unknown values', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({ policies: { on_tool_drift: 'ignore' } }),
      )
      expect(result.success).toBe(false)
    })

    it('is optional', () => {
      const result = helioConfigSchema.safeParse(minimalConfig())
      expect(result.success).toBe(true)
      if (result.success) expect(result.data.policies.on_tool_drift).toBeUndefined()
    })
  })

  // -------------------------------------------------------------------------
  // Policies — tool_revalidation (issue #221)
  // -------------------------------------------------------------------------

  describe('policies.tool_revalidation', () => {
    it('applies defaults when the section is present and empty', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({ policies: { tool_revalidation: {} } }),
      )
      expect(result.success).toBe(true)
      if (!result.success) return
      expect(result.data.policies.tool_revalidation).toEqual({ enabled: true, interval: '5m' })
    })

    it('is undefined when omitted (defaults applied at compile time)', () => {
      const result = helioConfigSchema.safeParse(minimalConfig())
      expect(result.success).toBe(true)
      if (!result.success) return
      expect(result.data.policies.tool_revalidation).toBeUndefined()
    })

    it('rejects an interval below 10s', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({ policies: { tool_revalidation: { interval: '5s' } } }),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.issues[0]?.message).toMatch(/at least 10s/)
    })

    it('rejects unknown keys and bad durations', () => {
      const unknownKeyResult = helioConfigSchema.safeParse(
        minimalConfig({ policies: { tool_revalidation: { intervall: '5m' } } }),
      )
      expect(unknownKeyResult.success).toBe(false)

      const badDurationResult = helioConfigSchema.safeParse(
        minimalConfig({ policies: { tool_revalidation: { max_advertised_ttl: 'soon' } } }),
      )
      expect(badDurationResult.success).toBe(false)
      if (badDurationResult.success) return
      expect(badDurationResult.error.issues[0]?.message).toMatch(/Duration/)
    })
  })

  describe('dashboard open mode enforcement', () => {
    it('rejects dashboard enabled without api_secret unless allow_open_mode is true', () => {
      const result = helioConfigSchema.safeParse({
        version: '1',
        upstream: { url: 'http://localhost:8080' },
      })
      expect(result.success).toBe(false)
      if (result.success) return
      const issue = result.error.issues.find((i) => i.path.join('.') === 'dashboard.api_secret')
      expect(issue?.message).toContain('dashboard.allow_open_mode')
    })

    it.each(['127.0.0.1', 'localhost', '::1'])(
      'accepts explicit open mode on loopback host %s',
      (host) => {
        const result = helioConfigSchema.safeParse(
          minimalConfig({
            dashboard: { enabled: true, host, allow_open_mode: true },
          }),
        )
        expect(result.success).toBe(true)
      },
    )

    it('rejects explicit open mode on non-loopback host', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          dashboard: { enabled: true, host: '0.0.0.0', allow_open_mode: true },
        }),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths).toContain('dashboard.host')
    })

    it('accepts dashboard enabled without allow_open_mode when api_secret is set', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          dashboard: { enabled: true, api_secret: 'test-secret' },
        }),
      )
      expect(result.success).toBe(true)
    })
  })

  describe('approval channel registry hygiene (issue #14 riders)', () => {
    const slackChannel = (overrides: Record<string, unknown> = {}) => ({
      type: 'slack',
      bot_token: 'xoxb-123',
      signing_secret: 'abc123',
      channel: '#approvals',
      ...overrides,
    })

    it('rejects a non-dashboard channel that takes the reserved dashboard key', () => {
      // createChannels seeds the built-in dashboard fallback first; a slack
      // channel named "dashboard" would silently replace it.
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          approval: { channels: [slackChannel({ name: 'dashboard' })] },
        }),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths).toContain('approval.channels.0.name')
    })

    it('accepts a dashboard-type channel named dashboard (harmless re-registration)', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          approval: { channels: [{ type: 'dashboard', name: 'dashboard' }] },
        }),
      )
      expect(result.success).toBe(true)
    })

    it('rejects duplicate effective channel keys (last-write-wins is silent)', () => {
      const named = helioConfigSchema.safeParse(
        minimalConfig({
          approval: {
            channels: [
              slackChannel({ name: 'oncall' }),
              { type: 'webhook', name: 'oncall', url: 'https://example.com/hook' },
            ],
          },
          dashboard: { enabled: true, api_secret: 'unit-test-secret' },
        }),
      )
      expect(named.success).toBe(false)

      const unnamedPair = helioConfigSchema.safeParse(
        minimalConfig({
          approval: { channels: [slackChannel(), slackChannel({ channel: '#other' })] },
        }),
      )
      expect(unnamedPair.success).toBe(false)
    })

    it('rejects empty channel names and empty approval references', () => {
      const emptyName = helioConfigSchema.safeParse(
        minimalConfig({ approval: { channels: [slackChannel({ name: '' })] } }),
      )
      expect(emptyName.success).toBe(false)

      const emptyReference = helioConfigSchema.safeParse(
        minimalConfig({
          dashboard: { enabled: true, api_secret: 'unit-test-secret' },
          policies: {
            rules: [
              { match: { tool: '*' }, action: 'require_approval', approval: { channel: '' } },
            ],
          },
        }),
      )
      expect(emptyReference.success).toBe(false)

      const emptyDelegate = helioConfigSchema.safeParse(
        minimalConfig({
          dashboard: { enabled: true, api_secret: 'unit-test-secret' },
          policies: {
            rules: [
              {
                match: { tool: '*' },
                action: 'require_approval',
                approval: { channel: 'dashboard', delegates: [''], escalation_after: '60s' },
              },
            ],
          },
        }),
      )
      expect(emptyDelegate.success).toBe(false)
    })
  })

  describe('rule approval routing needs the dashboard server (issue #152)', () => {
    // Dashboard-routed rule tickets resolve ONLY through the dashboard
    // approvals API — mirror of the break-glass suite above, rule side.
    const noDashboard = { enabled: false, api_secret: 'unit-test-secret' }
    const slackChannel = {
      type: 'slack',
      bot_token: 'xoxb-123',
      signing_secret: 'abc123',
      channel: '#approvals',
    }
    const approveRule = (approval?: Record<string, unknown>) => ({
      match: { tool: 'transfer_*' },
      action: 'require_approval',
      ...(approval !== undefined && { approval }),
    })
    const parse = (policies: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      helioConfigSchema.safeParse(minimalConfig({ dashboard: noDashboard, policies, ...extra }))
    const issuePaths = (result: ReturnType<typeof helioConfigSchema.safeParse>) =>
      result.success ? [] : result.error.issues.map((i) => i.path.join('.'))

    it('rejects the dashboard fallback when the dashboard server is disabled', () => {
      const result = parse({ rules: [approveRule()] })
      expect(result.success).toBe(false)
      expect(issuePaths(result)).toContain('policies.rules.0.action')
    })

    it('rejects an explicit dashboard channel when the dashboard is disabled', () => {
      const result = parse({ rules: [approveRule({ channel: 'dashboard' })] })
      expect(result.success).toBe(false)
      expect(issuePaths(result)).toContain('policies.rules.0.approval.channel')
    })

    it('rejects a named dashboard-type channel when the dashboard is disabled', () => {
      const result = parse(
        { rules: [approveRule({ channel: 'ops' })] },
        { approval: { channels: [{ type: 'dashboard', name: 'ops' }] } },
      )
      expect(result.success).toBe(false)
      expect(issuePaths(result)).toContain('policies.rules.0.approval.channel')
    })

    it('accepts a slack-routed rule with the dashboard disabled', () => {
      const result = parse(
        { rules: [approveRule({ channel: 'slack' })] },
        { approval: { channels: [slackChannel] } },
      )
      expect(result.success).toBe(true)
    })

    it('rejects a viable dashboard escalation delegate', () => {
      const result = parse(
        {
          rules: [
            approveRule({ channel: 'slack', delegates: ['dashboard'], escalation_after: '60s' }),
          ],
        },
        { approval: { channels: [slackChannel] } },
      )
      expect(result.success).toBe(false)
      expect(issuePaths(result)).toContain('policies.rules.0.approval.delegates.0')
    })

    it('a dashboard delegate with no escalation timer is inert, not rejected', () => {
      const result = parse(
        { rules: [approveRule({ channel: 'slack', delegates: ['dashboard'] })] },
        { approval: { channels: [slackChannel] } },
      )
      expect(result.success).toBe(true)
    })

    it('non-viable escalation timers make dashboard delegates inert (router parity)', () => {
      const channels = { approval: { channels: [slackChannel] } }
      // 0s never fires.
      const zero = parse(
        {
          rules: [
            approveRule({ channel: 'slack', delegates: ['dashboard'], escalation_after: '0s' }),
          ],
        },
        channels,
      )
      expect(zero.success).toBe(true)
      // 600s ≥ the 300s default approval.timeout never fires.
      const tooLate = parse(
        {
          rules: [
            approveRule({ channel: 'slack', delegates: ['dashboard'], escalation_after: '600s' }),
          ],
        },
        channels,
      )
      expect(tooLate.success).toBe(true)
      // A rule-level timeout raises the bound: the same 600s escalation fires
      // under a 900s ticket, so the dashboard delegate is live again — reject.
      const ruleTimeout = parse(
        {
          rules: [
            approveRule({
              channel: 'slack',
              delegates: ['dashboard'],
              escalation_after: '600s',
              timeout: '900s',
            }),
          ],
        },
        channels,
      )
      expect(ruleTimeout.success).toBe(false)
      expect(issuePaths(ruleTimeout)).toContain('policies.rules.0.approval.delegates.0')
    })

    it('skips metadata-gated (sideband-only) rules', () => {
      // match.metadata never matches on the MCP path and sideband tickets are
      // native (adapter-resolved) — no channel-routed ticket can exist.
      const result = parse({
        rules: [{ match: { metadata: { channel_id: 'C123' } }, action: 'require_approval' }],
      })
      expect(result.success).toBe(true)
    })

    it('rejects flag_destructive: require_approval when the dashboard is disabled', () => {
      const result = parse({ flag_destructive: 'require_approval', rules: [] })
      expect(result.success).toBe(false)
      expect(issuePaths(result)).toContain('policies.flag_destructive')

      const log = parse({ flag_destructive: 'log', rules: [] })
      expect(log.success).toBe(true)
    })

    it('rejects on_tool_drift: require_approval when the dashboard is disabled', () => {
      const result = parse({ on_tool_drift: 'require_approval', rules: [] })
      expect(result.success).toBe(false)
      expect(issuePaths(result)).toContain('policies.on_tool_drift')

      const block = parse({ on_tool_drift: 'block', rules: [] })
      expect(block.success).toBe(true)
    })

    it('accepts every rejected shape once the dashboard is enabled', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          dashboard: { enabled: true, api_secret: 'unit-test-secret' },
          policies: {
            flag_destructive: 'require_approval',
            on_tool_drift: 'require_approval',
            rules: [approveRule(), approveRule({ channel: 'dashboard' })],
          },
        }),
      )
      expect(result.success).toBe(true)
    })
  })

  describe('budgets (issue #14)', () => {
    const validBudget = {
      name: 'daily-cap',
      limit: 50,
      currency: 'USD',
      window: '24h',
      contributors: [{ match: { tool: 'stripe_*' }, field: '$.amount' }],
    }

    function withBudgets(budgets: unknown[], extra: Record<string, unknown> = {}) {
      return minimalConfig({ budgets, ...extra })
    }

    it('defaults to an empty list when absent', () => {
      const result = helioConfigSchema.safeParse(minimalConfig())
      expect(result.success).toBe(true)
      if (!result.success) return
      expect(result.data.budgets).toEqual([])
    })

    it('parses a duration-window budget and applies defaults', () => {
      const result = helioConfigSchema.safeParse(withBudgets([validBudget]))
      expect(result.success).toBe(true)
      if (!result.success) return
      const budget = result.data.budgets[0]
      expect(budget?.key).toBe('global')
      expect(budget?.on_exceed).toBe('deny')
    })

    it('accepts window: session with key: session', () => {
      const result = helioConfigSchema.safeParse(
        withBudgets([{ ...validBudget, window: 'session', key: 'session' }]),
      )
      expect(result.success).toBe(true)
    })

    it('accepts window: session with key: sender_id when the sideband is enabled', () => {
      const result = helioConfigSchema.safeParse(
        withBudgets([{ ...validBudget, window: 'session', key: 'sender_id' }], {
          sdk: { enabled: true },
        }),
      )
      expect(result.success).toBe(true)
    })

    it('rejects window: session with key: global (explicit)', () => {
      const result = helioConfigSchema.safeParse(
        withBudgets([{ ...validBudget, window: 'session', key: 'global' }]),
      )
      expect(result.success).toBe(false)
    })

    it('rejects window: session with the default key', () => {
      const result = helioConfigSchema.safeParse(
        withBudgets([{ ...validBudget, window: 'session' }]),
      )
      expect(result.success).toBe(false)
    })

    it('accepts idle_ttl on session windows', () => {
      const result = helioConfigSchema.safeParse(
        withBudgets([{ ...validBudget, window: 'session', key: 'session', idle_ttl: '12h' }]),
      )
      expect(result.success).toBe(true)
    })

    it('rejects idle_ttl on duration windows', () => {
      const result = helioConfigSchema.safeParse(withBudgets([{ ...validBudget, idle_ttl: '12h' }]))
      expect(result.success).toBe(false)
    })

    it('rejects key: sender_id when the sideband is disabled', () => {
      const result = helioConfigSchema.safeParse(
        withBudgets([{ ...validBudget, key: 'sender_id' }]),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths).toContain('budgets.0.key')
    })

    it('rejects duplicate budget names', () => {
      const result = helioConfigSchema.safeParse(
        withBudgets([validBudget, { ...validBudget, window: '1h' }]),
      )
      expect(result.success).toBe(false)
    })

    it('rejects an empty contributors list', () => {
      const result = helioConfigSchema.safeParse(
        withBudgets([{ ...validBudget, contributors: [] }]),
      )
      expect(result.success).toBe(false)
    })

    it('rejects unknown budget fields (strict)', () => {
      const result = helioConfigSchema.safeParse(withBudgets([{ ...validBudget, surprise: true }]))
      expect(result.success).toBe(false)
    })

    it('rejects unknown contributor fields (strict)', () => {
      const result = helioConfigSchema.safeParse(
        withBudgets([
          {
            ...validBudget,
            contributors: [{ match: { tool: 'a_*' }, field: '$.x', currency: 'USD' }],
          },
        ]),
      )
      expect(result.success).toBe(false)
    })

    it('accepts the match-nested contributor shape', () => {
      const result = helioConfigSchema.safeParse(
        withBudgets([
          { ...validBudget, contributors: [{ match: { tool: 'stripe_*' }, field: '$.amount' }] },
        ]),
      )
      expect(result.success).toBe(true)
    })

    it('accepts contributor input conditions with the rule operator set', () => {
      const result = helioConfigSchema.safeParse(
        withBudgets([
          {
            ...validBudget,
            contributors: [
              {
                match: {
                  tool: 'stripe_*',
                  input: { '$.category': { eq: 'content_distribution' } },
                },
                field: '$.amount',
              },
            ],
          },
        ]),
      )
      expect(result.success).toBe(true)
    })

    it('rejects a contributor input condition with no operators', () => {
      const result = helioConfigSchema.safeParse(
        withBudgets([
          {
            ...validBudget,
            contributors: [
              { match: { tool: 'stripe_*', input: { '$.category': {} } }, field: '$.a' },
            ],
          },
        ]),
      )
      expect(result.success).toBe(false)
      const messages = result.success ? [] : result.error.issues.map((issue) => issue.message)
      expect(messages).toContain('At least one condition operator is required')
    })

    it('rejects unknown keys under contributor match (strict)', () => {
      const result = helioConfigSchema.safeParse(
        withBudgets([
          {
            ...validBudget,
            contributors: [{ match: { tool: 'stripe_*', environment: 'prod' }, field: '$.a' }],
          },
        ]),
      )
      expect(result.success).toBe(false)
      const messages = result.success ? [] : result.error.issues.map((issue) => issue.message)
      expect(messages.some((m) => m.includes('environment'))).toBe(true)
    })

    it('rejects the legacy flat contributor shape with a migration message', () => {
      const result = helioConfigSchema.safeParse(
        withBudgets([{ ...validBudget, contributors: [{ tool: 'stripe_*', field: '$.amount' }] }]),
      )
      expect(result.success).toBe(false)
      const messages = result.success ? [] : result.error.issues.map((issue) => issue.message)
      expect(messages.some((m) => m.includes('moved under "match"'))).toBe(true)
    })

    it('rejects a half-migrated contributor (tool alongside match) with the migration message', () => {
      const result = helioConfigSchema.safeParse(
        withBudgets([
          {
            ...validBudget,
            contributors: [{ tool: 'stripe_*', match: { tool: 'stripe_*' }, field: '$.amount' }],
          },
        ]),
      )
      expect(result.success).toBe(false)
      const messages = result.success ? [] : result.error.issues.map((issue) => issue.message)
      expect(messages.some((m) => m.includes('moved under "match"'))).toBe(true)
    })

    it('accepts on_exceed: deny explicitly', () => {
      const result = helioConfigSchema.safeParse(
        withBudgets([{ ...validBudget, on_exceed: 'deny' }]),
      )
      expect(result.success).toBe(true)
    })

    it('rejects an approval block (only meaningful with require_approval)', () => {
      const result = helioConfigSchema.safeParse(
        withBudgets([{ ...validBudget, approval: { channel: 'dashboard' } }]),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths).toContain('budgets.0.approval')
    })

    describe('break-glass (on_exceed: require_approval)', () => {
      // Dashboard-routed budget tickets need the dashboard SERVER, not just
      // the secret — its approvals API is the only resolution surface.
      const secured = { dashboard: { enabled: true, api_secret: 'unit-test-secret' } }
      const breakGlassBudget = { ...validBudget, on_exceed: 'require_approval' }

      it('accepts require_approval with dashboard.api_secret set', () => {
        const result = helioConfigSchema.safeParse(withBudgets([breakGlassBudget], secured))
        expect(result.success).toBe(true)
      })

      it('rejects require_approval without dashboard.api_secret (requiresSecret join)', () => {
        const result = helioConfigSchema.safeParse(withBudgets([breakGlassBudget]))
        expect(result.success).toBe(false)
        if (result.success) return
        const paths = result.error.issues.map((i) => i.path.join('.'))
        expect(paths).toContain('dashboard.api_secret')
      })

      it('accepts require_approval without an approval block (dashboard fallback)', () => {
        const result = helioConfigSchema.safeParse(withBudgets([breakGlassBudget], secured))
        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.data.budgets[0]?.approval).toBeUndefined()
      })

      it('accepts an approval block referencing the built-in dashboard channel', () => {
        const result = helioConfigSchema.safeParse(
          withBudgets(
            [{ ...breakGlassBudget, approval: { channel: 'dashboard', timeout: '120s' } }],
            secured,
          ),
        )
        expect(result.success).toBe(true)
      })

      it('accepts an approval block referencing a configured named channel', () => {
        const result = helioConfigSchema.safeParse(
          withBudgets([{ ...breakGlassBudget, approval: { channel: 'oncall' } }], {
            ...secured,
            approval: {
              channels: [
                {
                  type: 'slack',
                  name: 'oncall',
                  bot_token: 'xoxb-123',
                  signing_secret: 'abc123',
                  channel: '#approvals',
                },
              ],
            },
          }),
        )
        expect(result.success).toBe(true)
      })

      it('rejects an approval channel that references no configured channel', () => {
        const result = helioConfigSchema.safeParse(
          withBudgets([{ ...breakGlassBudget, approval: { channel: 'nowhere' } }], secured),
        )
        expect(result.success).toBe(false)
        if (result.success) return
        const paths = result.error.issues.map((i) => i.path.join('.'))
        expect(paths).toContain('budgets.0.approval.channel')
      })

      it('rejects a delegate that references no configured channel', () => {
        const result = helioConfigSchema.safeParse(
          withBudgets(
            [
              {
                ...breakGlassBudget,
                approval: {
                  channel: 'dashboard',
                  delegates: ['nowhere'],
                  escalation_after: '60s',
                },
              },
            ],
            secured,
          ),
        )
        expect(result.success).toBe(false)
        if (result.success) return
        const paths = result.error.issues.map((i) => i.path.join('.'))
        expect(paths).toContain('budgets.0.approval.delegates.0')
      })

      it('rejects unknown approval fields (strict, same schema as rules)', () => {
        const result = helioConfigSchema.safeParse(
          withBudgets(
            [{ ...breakGlassBudget, approval: { channel: 'dashboard', surprise: true } }],
            secured,
          ),
        )
        expect(result.success).toBe(false)
      })

      it('rejects a bare-type reference to a NAMED channel (runtime registers name only)', () => {
        // createChannels keys slack/webhook channels by `name ?? type`: a
        // named Slack channel is NOT reachable as "slack", so validating the
        // type would accept a channel that never gets a notification.
        const namedSlack = {
          approval: {
            channels: [
              {
                type: 'slack',
                name: 'oncall',
                bot_token: 'xoxb-123',
                signing_secret: 'abc123',
                channel: '#approvals',
              },
            ],
          },
        }
        const budget = helioConfigSchema.safeParse(
          withBudgets([{ ...breakGlassBudget, approval: { channel: 'slack' } }], {
            ...secured,
            ...namedSlack,
          }),
        )
        expect(budget.success).toBe(false)
        if (budget.success) return
        expect(budget.error.issues.map((i) => i.path.join('.'))).toContain(
          'budgets.0.approval.channel',
        )

        const rule = helioConfigSchema.safeParse(
          minimalConfig({
            ...secured,
            ...namedSlack,
            policies: {
              rules: [
                {
                  match: { tool: '*' },
                  action: 'require_approval',
                  approval: { channel: 'slack' },
                },
              ],
            },
          }),
        )
        expect(rule.success).toBe(false)
        if (rule.success) return
        expect(rule.error.issues.map((i) => i.path.join('.'))).toContain(
          'policies.rules.0.approval.channel',
        )
      })

      it('still accepts a bare-type reference to an UNNAMED channel', () => {
        const result = helioConfigSchema.safeParse(
          withBudgets([{ ...breakGlassBudget, approval: { channel: 'slack' } }], {
            dashboard: { enabled: false, api_secret: 'unit-test-secret' },
            approval: {
              channels: [
                {
                  type: 'slack',
                  bot_token: 'xoxb-123',
                  signing_secret: 'abc123',
                  channel: '#approvals',
                },
              ],
            },
          }),
        )
        expect(result.success).toBe(true)
      })

      it('a named dashboard-type channel stays reachable under both keys', () => {
        const result = helioConfigSchema.safeParse(
          withBudgets([{ ...breakGlassBudget, approval: { channel: 'ops' } }], {
            ...secured,
            approval: { channels: [{ type: 'dashboard', name: 'ops' }] },
          }),
        )
        expect(result.success).toBe(true)
      })

      it('rejects the dashboard fallback when the dashboard server is disabled', () => {
        // No approval block → channel defaults to dashboard; with the
        // dashboard disabled the ticket would have no resolution surface and
        // always time out (fail closed — dead config).
        const result = helioConfigSchema.safeParse(
          withBudgets([breakGlassBudget], {
            dashboard: { enabled: false, api_secret: 'unit-test-secret' },
          }),
        )
        expect(result.success).toBe(false)
        if (result.success) return
        const paths = result.error.issues.map((i) => i.path.join('.'))
        expect(paths).toContain('budgets.0.on_exceed')
      })

      it('rejects an explicit dashboard channel or delegate when the dashboard is disabled', () => {
        const noDashboard = { dashboard: { enabled: false, api_secret: 'unit-test-secret' } }
        const explicit = helioConfigSchema.safeParse(
          withBudgets([{ ...breakGlassBudget, approval: { channel: 'dashboard' } }], noDashboard),
        )
        expect(explicit.success).toBe(false)

        const viaDelegate = helioConfigSchema.safeParse(
          withBudgets(
            [
              {
                ...breakGlassBudget,
                approval: {
                  channel: 'slack',
                  delegates: ['dashboard'],
                  escalation_after: '60s',
                },
              },
            ],
            {
              ...noDashboard,
              approval: {
                channels: [
                  {
                    type: 'slack',
                    bot_token: 'xoxb-123',
                    signing_secret: 'abc123',
                    channel: '#approvals',
                  },
                ],
              },
            },
          ),
        )
        expect(viaDelegate.success).toBe(false)
      })

      it('a dashboard delegate with no escalation timer is inert, not rejected', () => {
        // Without escalation_after the delegate list never fires at runtime,
        // so the dashboard-availability guard must not reject it.
        const result = helioConfigSchema.safeParse(
          withBudgets(
            [{ ...breakGlassBudget, approval: { channel: 'slack', delegates: ['dashboard'] } }],
            {
              dashboard: { enabled: false, api_secret: 'unit-test-secret' },
              approval: {
                channels: [
                  {
                    type: 'slack',
                    bot_token: 'xoxb-123',
                    signing_secret: 'abc123',
                    channel: '#approvals',
                  },
                ],
              },
            },
          ),
        )
        expect(result.success).toBe(true)
      })

      it('non-viable escalation timers make dashboard delegates inert (router parity)', () => {
        // The router escalates only when 0 < escalation_after < the
        // effective timeout; a timer that can never fire must not trip the
        // dashboard-availability guard.
        const base = {
          dashboard: { enabled: false, api_secret: 'unit-test-secret' },
          approval: {
            timeout: '300s',
            channels: [
              {
                type: 'slack',
                bot_token: 'xoxb-123',
                signing_secret: 'abc123',
                channel: '#approvals',
              },
            ],
          },
        }
        const zero = helioConfigSchema.safeParse(
          withBudgets(
            [
              {
                ...breakGlassBudget,
                approval: { channel: 'slack', delegates: ['dashboard'], escalation_after: '0s' },
              },
            ],
            base,
          ),
        )
        expect(zero.success).toBe(true)

        const tooLate = helioConfigSchema.safeParse(
          withBudgets(
            [
              {
                ...breakGlassBudget,
                approval: {
                  channel: 'slack',
                  timeout: '60s',
                  delegates: ['dashboard'],
                  escalation_after: '60s',
                },
              },
            ],
            base,
          ),
        )
        expect(tooLate.success).toBe(true)

        // Past the GLOBAL default timeout when the budget sets none.
        const pastGlobal = helioConfigSchema.safeParse(
          withBudgets(
            [
              {
                ...breakGlassBudget,
                approval: {
                  channel: 'slack',
                  delegates: ['dashboard'],
                  escalation_after: '600s',
                },
              },
            ],
            base,
          ),
        )
        expect(pastGlobal.success).toBe(true)
      })

      it('accepts a slack-routed budget with the dashboard disabled', () => {
        // Slack tickets resolve through the Slack action callbacks on the
        // main proxy server; no dashboard needed.
        const result = helioConfigSchema.safeParse(
          withBudgets([{ ...breakGlassBudget, approval: { channel: 'slack' } }], {
            dashboard: { enabled: false, api_secret: 'unit-test-secret' },
            approval: {
              channels: [
                {
                  type: 'slack',
                  bot_token: 'xoxb-123',
                  signing_secret: 'abc123',
                  channel: '#approvals',
                },
              ],
            },
          }),
        )
        expect(result.success).toBe(true)
      })
    })

    it('rejects a non-positive limit', () => {
      const zero = helioConfigSchema.safeParse(withBudgets([{ ...validBudget, limit: 0 }]))
      const negative = helioConfigSchema.safeParse(withBudgets([{ ...validBudget, limit: -5 }]))
      expect(zero.success).toBe(false)
      expect(negative.success).toBe(false)
    })

    it('rejects a window that is neither a duration nor "session"', () => {
      const result = helioConfigSchema.safeParse(
        withBudgets([{ ...validBudget, window: 'monthly' }]),
      )
      expect(result.success).toBe(false)
    })

    it('rejects an empty budget name', () => {
      const result = helioConfigSchema.safeParse(withBudgets([{ ...validBudget, name: '' }]))
      expect(result.success).toBe(false)
    })

    it('rejects budget names with delimiter characters', () => {
      // Names are embedded in bucket keys; a ":" could forge scope segments.
      const result = helioConfigSchema.safeParse(
        withBudgets([{ ...validBudget, name: 'evil:sender:x' }]),
      )
      expect(result.success).toBe(false)
    })
  })

  describe('unknown top-level keys (issue #167)', () => {
    it('rejects a top-level rules: key, naming it', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({ rules: [{ match: { tool: 'delete_*' }, action: 'deny' }] }),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.issues).toHaveLength(1)
      expect(result.error.issues[0]?.code).toBe('unrecognized_keys')
      expect(result.error.issues[0]?.path).toEqual([])
      expect(result.error.issues[0]?.message).toBe('Unrecognized key: "rules"')
    })

    it('rejects policy: (singular typo for policies:)', () => {
      const result = helioConfigSchema.safeParse(minimalConfig({ policy: { default: 'allow' } }))
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.issues[0]?.message).toBe('Unrecognized key: "policy"')
    })

    it('rejects budget: (singular typo for budgets:)', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          budget: [
            {
              name: 'openai-daily',
              limit: 25,
              currency: 'USD',
              window: '1d',
              contributors: [{ match: { tool: 'openai_*' }, field: '$.usage.total_cost' }],
            },
          ],
        }),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.issues[0]?.message).toBe('Unrecognized key: "budget"')
    })

    it('names every unknown key in a single issue', () => {
      const result = helioConfigSchema.safeParse(minimalConfig({ rules: [], budget: [] }))
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.issues).toHaveLength(1)
      expect(result.error.issues[0]?.message).toBe('Unrecognized keys: "rules", "budget"')
    })

    it('allows top-level x- extension keys as anchor holders and drops them', () => {
      const result = helioConfigSchema.safeParse(minimalConfig({ 'x-defaults': { window: '1h' } }))
      expect(result.success).toBe(true)
      if (!result.success) return
      expect('x-defaults' in result.data).toBe(false)
    })

    it('does not strip x- keys inside sections (root-only escape hatch)', () => {
      // policies is a strict subtree, so the un-stripped key is rejected
      // there. Every section is strict since #182, so an un-stripped x-
      // key is always rejected — the pin here is that the strip never
      // descends past the root.
      const result = helioConfigSchema.safeParse(minimalConfig({ policies: { 'x-shared': true } }))
      expect(result.success).toBe(false)
    })

    it('still rejects unknown keys one level down with the section path', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({ policies: { default_action: 'allow' } }),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.issues[0]?.code).toBe('unrecognized_keys')
      expect(result.error.issues[0]?.path).toEqual(['policies'])
      expect(result.error.issues[0]?.message).toBe('Unrecognized key: "default_action"')
    })
  })

  describe('unknown keys in nested sections (issue #182)', () => {
    it('rejects an unknown key in upstream, naming it under the section path', () => {
      // Repro r1: the typo'd timeout silently kept the 30s default. Also
      // proves .strict() composes on the object stage of upstream's
      // .refine().superRefine() chain.
      const result = helioConfigSchema.safeParse(
        minimalConfig({ upstream: { url: 'http://localhost:8080', request_timout: '5s' } }),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.issues).toHaveLength(1)
      expect(result.error.issues[0]?.code).toBe('unrecognized_keys')
      expect(result.error.issues[0]?.path).toEqual(['upstream'])
      expect(result.error.issues[0]?.message).toBe('Unrecognized key: "request_timout"')
    })

    it('rejects an unknown key in listen', () => {
      const result = helioConfigSchema.safeParse(minimalConfig({ listen: { prt: 3000 } }))
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.issues[0]?.path).toEqual(['listen'])
      expect(result.error.issues[0]?.message).toBe('Unrecognized key: "prt"')
    })

    it('rejects dashboard.api_secrett with allow_open_mode (the silent open-dashboard repro)', () => {
      // Repro r4a: pre-#182 this VALIDATED and ran the dashboard open.
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          dashboard: { api_secrett: 'unit-test-secret', allow_open_mode: true },
        }),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.issues).toHaveLength(1)
      expect(result.error.issues[0]?.path).toEqual(['dashboard'])
      expect(result.error.issues[0]?.message).toBe('Unrecognized key: "api_secrett"')
    })

    it('names dashboard.api_secrett instead of demanding the secret the operator believes is set', () => {
      // Repro r4b: pre-#182 this failed, but with the MISLEADING
      // cross-validator message ("dashboard.api_secret is required…").
      // The nested strict failure suppresses the cross-validators, so the
      // single issue names the actual typo.
      const result = helioConfigSchema.safeParse(
        minimalConfig({ dashboard: { api_secrett: 'unit-test-secret' } }),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.issues).toHaveLength(1)
      expect(result.error.issues[0]?.path).toEqual(['dashboard'])
      expect(result.error.issues[0]?.message).toBe('Unrecognized key: "api_secrett"')
    })

    it('rejects approval.channel — the typo that silently dropped every channel', () => {
      // Repro r2. No require_approval rules, so the #152 routing check
      // could not have fired pre-#182 either; the config was "valid".
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          approval: {
            channel: [{ type: 'slack', bot_token: 'xoxb-x', signing_secret: 's', channel: '#a' }],
          },
        }),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.issues[0]?.path).toEqual(['approval'])
      expect(result.error.issues[0]?.message).toBe('Unrecognized key: "channel"')
    })

    it('rejects an unknown key in a slack channel entry', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          approval: {
            channels: [
              {
                type: 'slack',
                bot_token: 'xoxb-x',
                signing_secret: 's',
                channel: '#a',
                signing_secrt: 'oops',
              },
            ],
          },
        }),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.issues[0]?.code).toBe('unrecognized_keys')
      expect(result.error.issues[0]?.path).toEqual(['approval', 'channels', 0])
      expect(result.error.issues[0]?.message).toBe('Unrecognized key: "signing_secrt"')
    })

    it('rejects a webhook channel with a misspelled secret (the unsigned-webhook repro)', () => {
      // Repro r3, in the coherent shape: dashboard enabled with a secret,
      // so pre-#182 no cross-validator masked the typo and the config
      // VALIDATED — shipping an unsigned webhook.
      const result = helioConfigSchema.safeParse(
        minimalConfig({
          approval: {
            channels: [
              { type: 'webhook', name: 'hook', url: 'https://example.invalid/hook', secrt: 'h' },
            ],
          },
          dashboard: { api_secret: 'unit-test-secret' },
        }),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.issues[0]?.path).toEqual(['approval', 'channels', 0])
      expect(result.error.issues[0]?.message).toBe('Unrecognized key: "secrt"')
    })

    it('rejects an unknown key in a dashboard channel entry', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({ approval: { channels: [{ type: 'dashboard', channel: '#ops' }] } }),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.issues[0]?.path).toEqual(['approval', 'channels', 0])
      expect(result.error.issues[0]?.message).toBe('Unrecognized key: "channel"')
    })

    it('rejects an unknown key in audit', () => {
      const result = helioConfigSchema.safeParse(minimalConfig({ audit: { retentoin: '90d' } }))
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.issues[0]?.path).toEqual(['audit'])
      expect(result.error.issues[0]?.message).toBe('Unrecognized key: "retentoin"')
    })

    it('rejects an unknown key in sdk', () => {
      const result = helioConfigSchema.safeParse(minimalConfig({ sdk: { enable: true } }))
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.issues[0]?.path).toEqual(['sdk'])
      expect(result.error.issues[0]?.message).toBe('Unrecognized key: "enable"')
    })

    it('rejects an x- key inside a previously lax section', () => {
      // Behavior change the CHANGELOG states: pre-#182 the nine lax
      // sections silently DROPPED nested x- keys; the strict subtrees
      // already rejected them. Now every section rejects them — the
      // escape hatch is root-only, as documented.
      const result = helioConfigSchema.safeParse(
        minimalConfig({ audit: { 'x-defaults': { retention: '90d' } } }),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.issues[0]?.path).toEqual(['audit'])
      expect(result.error.issues[0]?.message).toBe('Unrecognized key: "x-defaults"')
    })

    it('reports one issue per section when several sections carry unknown keys', () => {
      const result = helioConfigSchema.safeParse(
        minimalConfig({ audit: { retentoin: '90d' }, sdk: { enable: true } }),
      )
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.issues).toHaveLength(2)
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths).toContain('audit')
      expect(paths).toContain('sdk')
    })
  })
})
