import { describe, it, expect } from 'vitest'
import { helioConfigSchema } from '../config/schema.js'
import type { HelioConfig } from '../config/schema.js'
import { StartupError } from '../startup-error.js'
import {
  classifyUpstreamArgument,
  resolveScanTarget,
  scanNeedsConfig,
  stripUserinfoTextually,
} from './target.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SHAPE_LINE = (value: string): string =>
  `Error: "${value}" is not an http(s) URL or an upstream name. A URL needs a scheme, for example http://localhost:8080/mcp.`

function loaded(raw: Record<string, unknown>): HelioConfig {
  return helioConfigSchema.parse({ version: '1', dashboard: { enabled: false }, ...raw })
}

function configOf(raw: Record<string, unknown>, path = 'helio.yaml') {
  return { path, loaded: loaded(raw), raw: { version: '1', dashboard: { enabled: false }, ...raw } }
}

const NAMED = {
  upstreams: [
    { name: 'crm', url: 'http://127.0.0.1:1/crm' },
    { name: 'files', transport: 'stdio', command: 'node', args: ['files.js'] },
  ],
}

function refusal(fn: () => unknown): string {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(StartupError)
    return (err as Error).message
  }
  throw new Error('expected a StartupError')
}

// ---------------------------------------------------------------------------
// classifyUpstreamArgument
// ---------------------------------------------------------------------------

describe('classifyUpstreamArgument', () => {
  it('reads an http(s) URL with a scheme as a URL target', () => {
    expect(classifyUpstreamArgument('http://localhost:8080/mcp')).toMatchObject({ kind: 'url' })
    expect(classifyUpstreamArgument('https://crm.example/mcp')).toMatchObject({ kind: 'url' })
    expect(classifyUpstreamArgument('HTTP://X/mcp')).toMatchObject({ kind: 'url' })
  })

  it('reads a value matching the upstream name charset as an entry name', () => {
    expect(classifyUpstreamArgument('crm')).toEqual({ kind: 'name', name: 'crm' })
    expect(classifyUpstreamArgument('my_crm-2')).toEqual({ kind: 'name', name: 'my_crm-2' })
    // Throws in `new URL`, matches the name regex: a name.
    expect(classifyUpstreamArgument('http-tools')).toEqual({ kind: 'name', name: 'http-tools' })
  })

  it('refuses a scheme-less or non-http(s) value with the scheme sentence', () => {
    for (const value of [
      'localhost:8080/mcp',
      '127.0.0.1:8080/mcp',
      'https:crm',
      'stdio://x',
      'ftp://host/mcp',
      'http:localhost',
      'crm/mcp',
    ]) {
      expect(classifyUpstreamArgument(value)).toEqual({
        kind: 'invalid',
        message: SHAPE_LINE(value),
      })
    }
  })
})

// ---------------------------------------------------------------------------
// scanNeedsConfig
// ---------------------------------------------------------------------------

describe('scanNeedsConfig', () => {
  it('loads no config for a bare URL unless -c was passed explicitly', () => {
    const url = classifyUpstreamArgument('http://127.0.0.1:1/mcp')
    expect(scanNeedsConfig(url, false)).toBe(false)
    expect(scanNeedsConfig(url, true)).toBe(true)
  })

  it('loads the config for a name and for a run without --upstream', () => {
    expect(scanNeedsConfig(classifyUpstreamArgument('crm'), false)).toBe(true)
    expect(scanNeedsConfig(undefined, false)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// stripUserinfoTextually (the authority rule)
// ---------------------------------------------------------------------------

describe('stripUserinfoTextually', () => {
  it('removes userinfo through the last @ of the authority only', () => {
    expect(stripUserinfoTextually('http://user:sekrit@host/mcp')).toBe('http://host/mcp')
    expect(stripUserinfoTextually('http://user:sekrit@foo@host/mcp')).toBe('http://host/mcp')
  })

  it('leaves an @ in the path or the query alone', () => {
    expect(stripUserinfoTextually('http://host/mcp?to=a@b')).toBe('http://host/mcp?to=a@b')
    expect(stripUserinfoTextually('http://host/${TOKEN}@extra/mcp')).toBe(
      'http://host/${TOKEN}@extra/mcp',
    )
    expect(stripUserinfoTextually('http://host/${TOKEN}/mcp?k=${API_KEY}')).toBe(
      'http://host/${TOKEN}/mcp?k=${API_KEY}',
    )
    expect(stripUserinfoTextually('http://host#a@b')).toBe('http://host#a@b')
  })

  it('returns a string with no :// unchanged', () => {
    expect(stripUserinfoTextually('node')).toBe('node')
  })
})

// ---------------------------------------------------------------------------
// resolveScanTarget: the bare URL
// ---------------------------------------------------------------------------

describe('resolveScanTarget with a bare URL', () => {
  it('parses the target through the upstream schema with its defaults', () => {
    const target = resolveScanTarget({ upstream: 'http://127.0.0.1:8080/mcp' })
    expect(target.source).toBe('argument')
    expect(target.transport).toBe('streamable-http')
    expect(target.upstreamName).toBeUndefined()
    expect(target.configPath).toBeUndefined()
    expect(target.upstream.url).toBe('http://127.0.0.1:8080/mcp')
    expect(target.upstream.request_timeout).toBe('30s')
    expect(target.upstream.connect_timeout).toBe('10s')
    expect(target.upstream.protocol_version).toBe('auto')
    expect(target.label).toBe('http://127.0.0.1:8080/mcp')
    expect(target.credentialDropped).toBe(false)
  })

  it('honors --transport sse and refuses --transport stdio with a URL', () => {
    expect(resolveScanTarget({ upstream: 'http://h/mcp', transport: 'sse' }).transport).toBe('sse')
    expect(refusal(() => resolveScanTarget({ upstream: 'http://h/mcp', transport: 'stdio' }))).toBe(
      'Error: a stdio upstream needs a config: put command and args under upstream: in helio.yaml and run helio scan -c <config>',
    )
  })

  it('refuses an unknown --transport value', () => {
    expect(refusal(() => resolveScanTarget({ upstream: 'http://h/mcp', transport: 'grpc' }))).toBe(
      'Error: --transport must be streamable-http, sse or stdio (got "grpc")',
    )
  })

  it('connects, labels and stores the normalized href of a copy with userinfo removed', () => {
    const target = resolveScanTarget({ upstream: 'HTTP://user:sekrit@X:80/my path' })
    expect(target.upstream.url).toBe('http://x/my%20path')
    expect(target.label).toBe('http://x/my%20path')
    expect(target.credentialDropped).toBe(true)
    expect(JSON.stringify(target)).not.toContain('sekrit')
  })

  it('refuses a scheme-less value with the scheme sentence', () => {
    expect(refusal(() => resolveScanTarget({ upstream: 'localhost:8080/mcp' }))).toBe(
      SHAPE_LINE('localhost:8080/mcp'),
    )
  })

  it('scans the URL against a singular config when both are given', () => {
    const target = resolveScanTarget({
      upstream: 'http://127.0.0.1:9/mcp',
      config: configOf({ upstream: { url: 'http://127.0.0.1:1/other' } }),
    })
    expect(target.source).toBe('argument')
    expect(target.upstream.url).toBe('http://127.0.0.1:9/mcp')
    expect(target.configPath).toBe('helio.yaml')
  })

  it('refuses a URL against a named config with the entry sentence', () => {
    expect(
      refusal(() =>
        resolveScanTarget({ upstream: 'http://127.0.0.1:9/mcp', config: configOf(NAMED) }),
      ),
    ).toBe(
      'Error: "http://127.0.0.1:9/mcp" is not an entry in this config. Pass --upstream <name> (one of: crm, files).',
    )
  })
})

// ---------------------------------------------------------------------------
// resolveScanTarget: config targets
// ---------------------------------------------------------------------------

describe('resolveScanTarget with a config', () => {
  it('scans a singular upstream and labels it with the raw file string', () => {
    const target = resolveScanTarget({
      config: {
        path: 'cfg/helio.yaml',
        loaded: loaded({ upstream: { url: 'http://127.0.0.1:1/mcp?key=sekrit' } }),
        raw: { upstream: { url: 'http://127.0.0.1:1/mcp?key=${API_KEY}' } },
      },
    })
    expect(target.source).toBe('config')
    expect(target.configPath).toBe('cfg/helio.yaml')
    expect(target.transport).toBe('streamable-http')
    expect(target.upstream.url).toBe('http://127.0.0.1:1/mcp?key=sekrit')
    expect(target.label).toBe('http://127.0.0.1:1/mcp?key=${API_KEY}')
    expect(target.credentialDropped).toBe(false)
  })

  it('refuses a named config without --upstream with the accept verb sentence', () => {
    expect(refusal(() => resolveScanTarget({ config: configOf(NAMED) }))).toBe(
      'Error: this config names its upstreams; pass --upstream <name> (one of: crm, files)',
    )
  })

  it('refuses --upstream <name> on a singular config', () => {
    expect(
      refusal(() =>
        resolveScanTarget({
          upstream: 'crm',
          config: configOf({ upstream: { url: 'http://127.0.0.1:1/mcp' } }),
        }),
      ),
    ).toBe('Error: this config has a single upstream; drop --upstream')
  })

  it('refuses a name the config does not declare', () => {
    expect(refusal(() => resolveScanTarget({ upstream: 'nope', config: configOf(NAMED) }))).toBe(
      'Error: no upstream named "nope" in helio.yaml (one of: crm, files)',
    )
  })

  it('selects a named entry by name and keeps its door name', () => {
    const target = resolveScanTarget({ upstream: 'crm', config: configOf(NAMED) })
    expect(target.upstreamName).toBe('crm')
    expect(target.upstream.url).toBe('http://127.0.0.1:1/crm')
    expect(target.label).toBe('http://127.0.0.1:1/crm')
    expect(target.transport).toBe('streamable-http')
  })

  it('labels a stdio entry with its raw command and keeps the loaded entry for the spawn', () => {
    const target = resolveScanTarget({
      upstream: 'files',
      config: {
        path: 'helio.yaml',
        loaded: loaded({
          upstreams: [
            { name: 'crm', url: 'http://127.0.0.1:1/crm' },
            { name: 'files', transport: 'stdio', command: '/opt/bin/files', args: ['a'] },
          ],
        }),
        raw: {
          upstreams: [
            { name: 'crm', url: 'http://127.0.0.1:1/crm' },
            { name: 'files', transport: 'stdio', command: '${BIN}', args: ['a'] },
          ],
        },
      },
    })
    expect(target.transport).toBe('stdio')
    expect(target.label).toBe('${BIN}')
    expect(target.upstream.command).toBe('/opt/bin/files')
  })

  it('refuses --transport on a config target', () => {
    expect(
      refusal(() =>
        resolveScanTarget({
          transport: 'sse',
          config: configOf({ upstream: { url: 'http://127.0.0.1:1/mcp' } }),
        }),
      ),
    ).toBe('Error: --transport applies only with --upstream <url>')
  })

  it('strips userinfo from a config URL for the connect and the label, never the value', () => {
    const target = resolveScanTarget({
      config: {
        path: 'helio.yaml',
        loaded: loaded({
          upstream: { url: 'http://user:sekrit@127.0.0.1:1/mcp', transport: 'sse' },
        }),
        raw: { upstream: { url: 'http://user:${PASS}@127.0.0.1:1/mcp', transport: 'sse' } },
      },
    })
    expect(target.upstream.url).toBe('http://127.0.0.1:1/mcp')
    expect(target.label).toBe('http://127.0.0.1:1/mcp')
    expect(target.credentialDropped).toBe(true)
    expect(JSON.stringify(target)).not.toContain('sekrit')
  })

  it('refuses a config URL that does not parse or is not http(s), naming the field only', () => {
    const singular = refusal(() =>
      resolveScanTarget({ config: configOf({ upstream: { url: 'http://user:secret@' } }) }),
    )
    expect(singular).toBe('Error: upstream.url is not an http(s) URL')
    const named = refusal(() =>
      resolveScanTarget({
        upstream: 'legacy',
        config: configOf({
          upstreams: [{ name: 'legacy', url: 'stdio://user:secret@host', transport: 'sse' }],
        }),
      }),
    )
    expect(named).toBe('Error: upstreams[legacy].url is not an http(s) URL')
    expect(named).not.toContain('secret')
  })
})
