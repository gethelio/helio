import { describe, it, expect, afterEach } from 'vitest'
import { postBaselineAccept } from './client.js'
import { secretDigest } from '../auth/bearer.js'

type FetchArgs = { url: string; method: string; headers: Record<string, string>; body: string }

/** A hand-rolled fetch stub: records every call, answers as told. */
function stubFetch(answer: () => Response | Promise<Response>): FetchArgs[] {
  const calls: FetchArgs[] = []
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const body = typeof init?.body === 'string' ? init.body : ''
    calls.push({ url, method: init?.method ?? 'GET', headers, body })
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

const ACCEPTED = {
  accepted: true,
  tool: 'send_email',
  upstream: null,
  previous_fingerprint: 'aaaa',
  fingerprint: 'bbbb',
  persisted: true,
  audit_record_id: 'rec-1',
}

describe('postBaselineAccept (issue #60)', () => {
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

  it('POSTs the tool, the upstream and the actor with the bearer and returns the acceptance', async () => {
    delete process.env['HELIO_DASHBOARD_SECRET']
    const calls = stubFetch(() => jsonResponse(200, ACCEPTED))
    const result = await postBaselineAccept(config({ api_secret: 'plain-secret' }), 'helio.yaml', {
      tool: 'send_email',
      upstream: 'mail',
      actor: 'oli',
    })
    expect(calls).toEqual([
      {
        url: 'http://127.0.0.1:47201/api/baselines/accept',
        method: 'POST',
        headers: { authorization: 'Bearer plain-secret', 'content-type': 'application/json' },
        body: JSON.stringify({ tool: 'send_email', upstream: 'mail', actor: 'oli' }),
      },
    ])
    expect(result).toEqual({
      ok: true,
      accepted: {
        tool: 'send_email',
        upstream: null,
        previous_fingerprint: 'aaaa',
        fingerprint: 'bbbb',
        persisted: true,
        audit_record_id: 'rec-1',
      },
    })
  })

  it('omits an undefined upstream from the body', async () => {
    delete process.env['HELIO_DASHBOARD_SECRET']
    const calls = stubFetch(() => jsonResponse(200, ACCEPTED))
    await postBaselineAccept(config({ api_secret: 's' }), 'helio.yaml', {
      tool: 'send_email',
      actor: 'oli',
    })
    expect(calls[0]?.body).toBe(JSON.stringify({ tool: 'send_email', actor: 'oli' }))
  })

  it('refuses without a socket when the dashboard is disabled', async () => {
    const calls = stubFetch(() => jsonResponse(200, ACCEPTED))
    const result = await postBaselineAccept(config({ enabled: false }), '/x/helio.yaml', {
      tool: 'send_email',
      actor: 'oli',
    })
    expect(calls).toEqual([])
    expect(result).toEqual({
      ok: false,
      code: 'dashboard_disabled',
      detail: { base: 'http://127.0.0.1:47201', source: undefined, configPath: '/x/helio.yaml' },
    })
  })

  it('refuses without a socket when the resolved secret is a digest', async () => {
    delete process.env['HELIO_DASHBOARD_SECRET']
    const calls = stubFetch(() => jsonResponse(200, ACCEPTED))
    const result = await postBaselineAccept(
      config({ api_secret: secretDigest('plain') }),
      'helio.yaml',
      { tool: 'send_email', actor: 'oli' },
    )
    expect(calls).toEqual([])
    expect(result).toMatchObject({ ok: false, code: 'secret_is_digest' })
  })

  it('reports no_proxy_answered when the socket fails', async () => {
    delete process.env['HELIO_DASHBOARD_SECRET']
    stubFetch(() => {
      throw new TypeError('fetch failed')
    })
    const result = await postBaselineAccept(config({ api_secret: 's' }), 'helio.yaml', {
      tool: 'send_email',
      actor: 'oli',
    })
    expect(result).toMatchObject({ ok: false, code: 'no_proxy_answered' })
  })

  it('reports secret_refused on 401', async () => {
    process.env['HELIO_DASHBOARD_SECRET'] = 'wrong'
    stubFetch(() => jsonResponse(401, { error: 'unauthorized' }))
    const result = await postBaselineAccept(config(), 'helio.yaml', {
      tool: 'send_email',
      actor: 'oli',
    })
    expect(result).toMatchObject({
      ok: false,
      code: 'secret_refused',
      detail: { source: 'HELIO_DASHBOARD_SECRET' },
    })
  })

  it.each([
    [403, 'baseline_accept_requires_secret'],
    [404, 'unknown_upstream'],
    [404, 'unknown_tool'],
    [409, 'door_not_primed'],
    [409, 'not_drifted'],
    [409, 'ambiguous_definition'],
  ] as const)(
    'passes the route refusal %i %s through with its suggestion',
    async (status, code) => {
      delete process.env['HELIO_DASHBOARD_SECRET']
      stubFetch(() => jsonResponse(status, { error: code, suggestion: 'do the thing' }))
      const result = await postBaselineAccept(config({ api_secret: 's' }), 'helio.yaml', {
        tool: 'send_email',
        actor: 'oli',
      })
      expect(result).toEqual({
        ok: false,
        code,
        status,
        suggestion: 'do the thing',
        detail: {
          base: 'http://127.0.0.1:47201',
          source: 'dashboard.api_secret in helio.yaml',
          configPath: 'helio.yaml',
        },
      })
    },
  )

  it('reports api_error with the message on any other failure', async () => {
    delete process.env['HELIO_DASHBOARD_SECRET']
    stubFetch(() => jsonResponse(503, { error: 'baselines are not available in this process' }))
    const result = await postBaselineAccept(config({ api_secret: 's' }), 'helio.yaml', {
      tool: 'send_email',
      actor: 'oli',
    })
    expect(result).toMatchObject({
      ok: false,
      code: 'api_error',
      detail: { message: 'baselines are not available in this process' },
    })
    stubFetch(() => new Response('<html>', { status: 502 }))
    const gateway = await postBaselineAccept(config({ api_secret: 's' }), 'helio.yaml', {
      tool: 'send_email',
      actor: 'oli',
    })
    expect(gateway).toMatchObject({ ok: false, code: 'api_error', detail: { message: 'HTTP 502' } })
  })
})
