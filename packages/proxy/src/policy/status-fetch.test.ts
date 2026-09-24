import { describe, it, expect, afterEach } from 'vitest'
import { fetchPolicyStatus } from './status-fetch.js'
import { secretDigest } from '../auth/bearer.js'

type FetchArgs = { url: string; headers: Record<string, string> }

/** A hand-rolled fetch stub: records every call, answers as told. */
function stubFetch(answer: () => Response | Promise<Response>): FetchArgs[] {
  const calls: FetchArgs[] = []
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push({ url, headers })
    return Promise.resolve(answer())
  }) as typeof fetch
  return calls
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const REPORT = { schema_version: 1, window: '7d', surface: { pairs: 2 } }

describe('fetchPolicyStatus (issue #400)', () => {
  const realFetch = globalThis.fetch
  const realEnv = process.env['HELIO_DASHBOARD_SECRET']
  const config = (
    overrides: Partial<{ enabled: boolean; host: string; api_secret: string }> = {},
  ) => ({
    dashboard: { enabled: true, host: '127.0.0.1', port: 47201, ...overrides },
  })

  afterEach(() => {
    globalThis.fetch = realFetch
    if (realEnv === undefined) delete process.env['HELIO_DASHBOARD_SECRET']
    else process.env['HELIO_DASHBOARD_SECRET'] = realEnv
  })

  it('makes one GET to the configured loopback URL with the bearer header and returns the body', async () => {
    delete process.env['HELIO_DASHBOARD_SECRET']
    const calls = stubFetch(() => jsonResponse(200, REPORT))
    const result = await fetchPolicyStatus(
      config({ api_secret: 'plain-secret' }),
      'helio.yaml',
      '7d',
    )
    expect(calls).toEqual([
      {
        url: 'http://127.0.0.1:47201/api/policy/status?window=7d',
        headers: { authorization: 'Bearer plain-secret' },
      },
    ])
    expect(result).toEqual({ ok: true, report: REPORT })
  })

  it('prefers HELIO_DASHBOARD_SECRET over the file and names the source only in detail', async () => {
    process.env['HELIO_DASHBOARD_SECRET'] = 'from-env'
    const calls = stubFetch(() => jsonResponse(401, { error: 'unauthorized' }))
    const result = await fetchPolicyStatus(
      config({ api_secret: 'from-file' }),
      '/x/helio.yaml',
      '4h',
    )
    expect(calls[0]?.headers).toEqual({ authorization: 'Bearer from-env' })
    expect(result).toEqual({
      ok: false,
      code: 'secret_refused',
      detail: {
        base: 'http://127.0.0.1:47201',
        source: 'HELIO_DASHBOARD_SECRET',
        configPath: '/x/helio.yaml',
      },
    })
  })

  it('sends no header in open mode and brackets an IPv6 host', async () => {
    delete process.env['HELIO_DASHBOARD_SECRET']
    const calls = stubFetch(() => jsonResponse(200, REPORT))
    await fetchPolicyStatus(config({ host: '::1' }), 'helio.yaml', '7d')
    expect(calls).toEqual([{ url: 'http://[::1]:47201/api/policy/status?window=7d', headers: {} }])
  })

  it('refuses a disabled dashboard with zero requests', async () => {
    const calls = stubFetch(() => jsonResponse(200, REPORT))
    const result = await fetchPolicyStatus(config({ enabled: false }), 'helio.yaml', '7d')
    expect(calls).toHaveLength(0)
    expect(result).toMatchObject({ ok: false, code: 'dashboard_disabled' })
  })

  it('refuses a digest secret from either source with zero requests', async () => {
    const digest = secretDigest('the-real-secret')
    const calls = stubFetch(() => jsonResponse(200, REPORT))
    process.env['HELIO_DASHBOARD_SECRET'] = digest
    const fromEnv = await fetchPolicyStatus(config(), 'helio.yaml', '7d')
    expect(fromEnv).toEqual({
      ok: false,
      code: 'secret_is_digest',
      detail: {
        base: 'http://127.0.0.1:47201',
        source: 'HELIO_DASHBOARD_SECRET',
        configPath: 'helio.yaml',
      },
    })
    delete process.env['HELIO_DASHBOARD_SECRET']
    const fromFile = await fetchPolicyStatus(config({ api_secret: digest }), '/y/helio.yaml', '7d')
    expect(fromFile).toMatchObject({
      ok: false,
      code: 'secret_is_digest',
      detail: { source: 'dashboard.api_secret in /y/helio.yaml' },
    })
    expect(calls).toHaveLength(0)
  })

  it('maps a thrown fetch to no_proxy_answered', async () => {
    delete process.env['HELIO_DASHBOARD_SECRET']
    stubFetch(() => {
      throw new TypeError('fetch failed')
    })
    const result = await fetchPolicyStatus(config(), 'helio.yaml', '7d')
    expect(result).toEqual({
      ok: false,
      code: 'no_proxy_answered',
      detail: { base: 'http://127.0.0.1:47201', source: undefined, configPath: 'helio.yaml' },
    })
  })

  it('maps a 503 to status_unavailable and any other error to api_error with the body message', async () => {
    delete process.env['HELIO_DASHBOARD_SECRET']
    stubFetch(() => jsonResponse(503, { error: 'policy status is not available in this process' }))
    expect(await fetchPolicyStatus(config(), 'helio.yaml', '7d')).toMatchObject({
      ok: false,
      code: 'status_unavailable',
      detail: { message: 'policy status is not available in this process' },
    })
    stubFetch(() => jsonResponse(500, { error: 'boom' }))
    expect(await fetchPolicyStatus(config(), 'helio.yaml', '7d')).toMatchObject({
      ok: false,
      code: 'api_error',
      detail: { message: 'boom' },
    })
    stubFetch(() => new Response('not json', { status: 500 }))
    expect(await fetchPolicyStatus(config(), 'helio.yaml', '7d')).toMatchObject({
      ok: false,
      code: 'api_error',
      detail: { message: 'HTTP 500' },
    })
  })
})
