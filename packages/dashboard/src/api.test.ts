import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  ApiError,
  apiFetch,
  qs,
  authHeaders,
  setCsrfToken,
  setUnauthorizedHandler,
  fetchAuthSession,
  loginDashboard,
  logoutDashboard,
  fetchHealth,
  fetchFeed,
  fetchAudit,
  fetchAuditRecord,
  fetchApprovals,
  fetchLimits,
  fetchAnalytics,
  fetchEvidence,
  approveTicket,
  denyTicket,
  breakGlassTicket,
} from './api'

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

let mockFetch: ReturnType<typeof vi.fn>

beforeEach(() => {
  mockFetch = vi.fn()
  vi.stubGlobal('fetch', mockFetch)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function okJson(data: unknown) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  } as Response)
}

function errResponse(status: number, body: string) {
  return Promise.resolve({
    ok: false,
    status,
    statusText: 'Error',
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(body),
  } as Response)
}

/** Extract the first call URL from the mock — throws if not called. */
function calledUrl(): string {
  const call = mockFetch.mock.calls[0]
  if (!call) throw new Error('fetch was not called')
  return call[0] as string
}

/** Extract the first call init from the mock. */
function calledInit(): RequestInit {
  const call = mockFetch.mock.calls[0]
  if (!call) throw new Error('fetch was not called')
  return call[1] as RequestInit
}

// ---------------------------------------------------------------------------
// qs()
// ---------------------------------------------------------------------------

describe('qs', () => {
  it('returns empty string for empty params', () => {
    expect(qs({})).toBe('')
  })

  it('returns empty string when all values are undefined', () => {
    expect(qs({ a: undefined, b: undefined })).toBe('')
  })

  it('builds query string from mixed params', () => {
    const result = qs({ tool: 'test', offset: 0, active: true, missing: undefined })
    expect(result).toContain('tool=test')
    expect(result).toContain('offset=0')
    expect(result).toContain('active=true')
    expect(result).not.toContain('missing')
    expect(result.startsWith('?')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// authHeaders()
// ---------------------------------------------------------------------------

describe('authHeaders', () => {
  it('returns only content-type without token', () => {
    expect(authHeaders()).toEqual({ 'content-type': 'application/json' })
  })

  it('returns content-type and csrf header when token exists', () => {
    expect(authHeaders('csrf-token')).toEqual({
      'content-type': 'application/json',
      'x-helio-csrf': 'csrf-token',
    })
  })
})

// ---------------------------------------------------------------------------
// apiFetch()
// ---------------------------------------------------------------------------

describe('apiFetch', () => {
  beforeEach(() => {
    setCsrfToken(undefined)
    setUnauthorizedHandler(undefined)
  })

  it('returns parsed JSON on success', async () => {
    mockFetch.mockReturnValue(okJson({ foo: 'bar' }))
    const result = await apiFetch('/test')
    expect(result).toEqual({ foo: 'bar' })
    expect(mockFetch).toHaveBeenCalledWith('/test', { credentials: 'same-origin' })
  })

  it('throws ApiError on non-ok response', async () => {
    mockFetch.mockReturnValue(errResponse(500, 'Server Error'))
    await expect(apiFetch('/fail')).rejects.toThrow(ApiError)
    try {
      await apiFetch('/fail')
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError)
      expect((e as ApiError).status).toBe(500)
      expect((e as ApiError).message).toBe('Server Error')
    }
  })

  it('notifies unauthorized handler on 401 responses', async () => {
    const onUnauthorized = vi.fn()
    setUnauthorizedHandler(onUnauthorized)
    mockFetch.mockReturnValue(errResponse(401, 'Unauthorized'))
    await expect(apiFetch('/fail')).rejects.toThrow(ApiError)
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// Auth session endpoints
// ---------------------------------------------------------------------------

describe('auth session endpoints', () => {
  it('fetchAuthSession calls /api/auth/session', async () => {
    mockFetch.mockReturnValue(okJson({ auth_required: true, authenticated: false }))
    await fetchAuthSession()
    expect(mockFetch).toHaveBeenCalledWith('/api/auth/session', { credentials: 'same-origin' })
  })

  it('loginDashboard sends POST body to /api/auth/session', async () => {
    mockFetch.mockReturnValue(okJson({ authenticated: true }))
    await loginDashboard('test-secret')
    expect(calledUrl()).toBe('/api/auth/session')
    const init = calledInit()
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ secret: 'test-secret' })
  })

  it('logoutDashboard sends POST to /api/auth/logout', async () => {
    mockFetch.mockReturnValue(okJson({ ok: true }))
    await logoutDashboard()
    expect(calledUrl()).toBe('/api/auth/logout')
    expect(calledInit().method).toBe('POST')
  })
})

// ---------------------------------------------------------------------------
// Read-only endpoints
// ---------------------------------------------------------------------------

describe('read endpoints', () => {
  it('fetchHealth calls /api/health', async () => {
    mockFetch.mockReturnValue(okJson({ status: 'ok', version: '0.0.0', uptime: 100 }))
    const result = await fetchHealth()
    expect(mockFetch).toHaveBeenCalledWith('/api/health', { credentials: 'same-origin' })
    expect(result.status).toBe('ok')
  })

  it('fetchFeed passes limit and offset', async () => {
    mockFetch.mockReturnValue(okJson({ data: [], total: 0, limit: 10, offset: 0 }))
    await fetchFeed({ limit: 10, offset: 5 })
    expect(calledUrl()).toContain('/api/feed')
    expect(calledUrl()).toContain('limit=10')
    expect(calledUrl()).toContain('offset=5')
  })

  it('fetchAudit builds all filter params and returns the normalized envelope', async () => {
    mockFetch.mockReturnValue(okJson({ data: [], total: 0, limit: 25, offset: 0 }))
    const res = await fetchAudit({
      tool: 'test',
      decision: 'deny',
      upstream_status_min: 500,
      upstream_status_max: 599,
      offset: 50,
      limit: 50,
    })
    const url = calledUrl()
    expect(url).toContain('/api/audit')
    expect(url).toContain('tool=test')
    expect(url).toContain('decision=deny')
    expect(url).toContain('upstream_status_min=500')
    expect(url).toContain('upstream_status_max=599')
    expect(url).toContain('offset=50')
    expect(url).toContain('limit=50')
    // The server does not echo `page` in the response — clients compute it
    // from offset/limit. Guard against regressions by asserting the envelope
    // shape returned by fetchAudit matches the normalized three-shape model.
    expect(res).toEqual({ data: [], total: 0, limit: 25, offset: 0 })
    expect('page' in res).toBe(false)
  })

  it('fetchAuditRecord encodes ID', async () => {
    mockFetch.mockReturnValue(okJson({ data: { id: 'abc' } }))
    await fetchAuditRecord('abc/def')
    const url = calledUrl()
    expect(url).toContain('/api/audit/abc%2Fdef')
  })

  it('fetchApprovals passes status and pins limit to the server ceiling', async () => {
    mockFetch.mockReturnValue(okJson({ data: [], total: 0, limit: 1000, offset: 0 }))
    await fetchApprovals('pending')
    const url = calledUrl()
    expect(url).toContain('status=pending')
    // Must stay pinned to 1000 until the dashboard grows pagination UI —
    // the server defaults to limit=50 which would silently truncate the
    // Resolved tab for operators with >50 tickets in the retention window.
    expect(url).toContain('limit=1000')
  })

  it('fetchLimits calls /api/limits', async () => {
    mockFetch.mockReturnValue(okJson({ rate_limits: [], spend_limits: [] }))
    await fetchLimits()
    expect(mockFetch).toHaveBeenCalledWith('/api/limits', { credentials: 'same-origin' })
  })

  it('fetchAnalytics passes from and to', async () => {
    mockFetch.mockReturnValue(
      okJson({ total: 0, by_decision: [], top_tools: [], approval_rate: null, per_hour: [] }),
    )
    await fetchAnalytics('2024-01-01T00:00:00Z', '2024-01-02T00:00:00Z')
    const url = calledUrl()
    expect(url).toContain('from=')
    expect(url).toContain('to=')
  })

  it('fetchEvidence encodes session ID', async () => {
    mockFetch.mockReturnValue(okJson({ data: null }))
    await fetchEvidence('sess/123')
    const url = calledUrl()
    expect(url).toContain('/api/evidence/sess%2F123')
  })
})

// ---------------------------------------------------------------------------
// Mutating endpoints
// ---------------------------------------------------------------------------

describe('mutating endpoints', () => {
  beforeEach(() => {
    setCsrfToken(undefined)
  })

  it('approveTicket sends POST with CSRF header', async () => {
    setCsrfToken('csrf-1')
    mockFetch.mockReturnValue(okJson({}))
    await approveTicket('t1', 'admin')
    const [url, init] = [calledUrl(), calledInit()]
    expect(url).toContain('/api/approvals/t1/approve')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['x-helio-csrf']).toBe('csrf-1')
    expect(JSON.parse(init.body as string)).toEqual({ approved_by: 'admin' })
  })

  it('approveTicket sends POST with JSON body', async () => {
    mockFetch.mockReturnValue(okJson({}))
    await approveTicket('t1', 'admin')
    const [url, init] = [calledUrl(), calledInit()]
    expect(url).toContain('/api/approvals/t1/approve')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).authorization).toBeUndefined()
    expect(JSON.parse(init.body as string)).toEqual({ approved_by: 'admin' })
  })

  it('denyTicket sends POST with body', async () => {
    mockFetch.mockReturnValue(okJson({}))
    await denyTicket('t2', 'admin', 'bad request')
    const [url, init] = [calledUrl(), calledInit()]
    expect(url).toContain('/api/approvals/t2/deny')
    expect(JSON.parse(init.body as string)).toEqual({
      denied_by: 'admin',
      reason: 'bad request',
    })
  })

  it('breakGlassTicket sends POST with reason', async () => {
    mockFetch.mockReturnValue(okJson({}))
    await breakGlassTicket('t3', 'admin', 'emergency')
    const [url, init] = [calledUrl(), calledInit()]
    expect(url).toContain('/api/approvals/t3/break-glass')
    expect(JSON.parse(init.body as string)).toEqual({
      approved_by: 'admin',
      reason: 'emergency',
    })
  })

  it('mutating endpoint without csrf token omits csrf header', async () => {
    mockFetch.mockReturnValue(okJson({}))
    await approveTicket('t1', 'admin')
    const init = calledInit()
    expect((init.headers as Record<string, string>)['x-helio-csrf']).toBeUndefined()
  })
})
