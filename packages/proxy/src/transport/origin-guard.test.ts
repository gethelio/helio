import { describe, it, expect, vi, afterEach } from 'vitest'
import { Hono } from 'hono'
import { createOriginGuard } from './origin-guard.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createGuardedApp(allowedOrigins: readonly string[]) {
  const app = new Hono()
  const handlerCalls: string[] = []
  app.use('*', createOriginGuard(allowedOrigins))
  app.post('/', (c) => {
    handlerCalls.push('post')
    return c.json({ ok: true })
  })
  return { app, handlerCalls }
}

function postWithOrigin(app: Hono, origin?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (origin !== undefined) headers.origin = origin
  return app.request('/', { method: 'POST', body: '{}', headers })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('origin guard', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('passes through a request with no Origin header', async () => {
    const { app, handlerCalls } = createGuardedApp([])

    const res = await postWithOrigin(app)

    expect(res.status).toBe(200)
    expect(handlerCalls).toHaveLength(1)
  })

  it('rejects any Origin when the allowlist is empty', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { app, handlerCalls } = createGuardedApp([])

    const res = await postWithOrigin(app, 'https://evil.example')

    expect(res.status).toBe(403)
    expect(handlerCalls).toHaveLength(0)
  })

  it('passes through an exactly allowlisted Origin', async () => {
    const { app, handlerCalls } = createGuardedApp(['http://localhost:5173'])

    const res = await postWithOrigin(app, 'http://localhost:5173')

    expect(res.status).toBe(200)
    expect(handlerCalls).toHaveLength(1)
  })

  it('rejects Origin: null even with a populated allowlist', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { app, handlerCalls } = createGuardedApp(['http://localhost:5173'])

    const res = await postWithOrigin(app, 'null')

    expect(res.status).toBe(403)
    expect(handlerCalls).toHaveLength(0)
  })

  it('rejects a suffix near-miss of an allowlisted origin', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { app, handlerCalls } = createGuardedApp(['http://localhost:5173'])

    const res = await postWithOrigin(app, 'http://localhost:5173.evil.example')

    expect(res.status).toBe(403)
    expect(handlerCalls).toHaveLength(0)
  })

  it('rejects a scheme mismatch against an allowlisted origin', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { app, handlerCalls } = createGuardedApp(['http://localhost:5173'])

    const res = await postWithOrigin(app, 'https://localhost:5173')

    expect(res.status).toBe(403)
    expect(handlerCalls).toHaveLength(0)
  })

  it('rejects duplicate Origin headers even when each is allowlisted', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { app, handlerCalls } = createGuardedApp(['http://localhost:5173'])

    const headers = new Headers({ 'content-type': 'application/json' })
    headers.append('origin', 'http://localhost:5173')
    headers.append('origin', 'http://localhost:5173')
    const res = await app.request('/', { method: 'POST', body: '{}', headers })

    expect(res.status).toBe(403)
    expect(handlerCalls).toHaveLength(0)
  })

  describe('rejection body (D4)', () => {
    it('is a JSON-RPC error with code -32600 and no id member', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const { app } = createGuardedApp([])

      const res = await postWithOrigin(app, 'https://evil.example')

      expect(res.status).toBe(403)
      const body: unknown = await res.json()
      expect(body).toEqual({
        jsonrpc: '2.0',
        error: { code: -32600, message: expect.any(String) as string },
      })
      expect(Object.keys(body as Record<string, unknown>)).not.toContain('id')
    })

    it('does not echo the submitted origin back', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const { app } = createGuardedApp([])

      const res = await postWithOrigin(app, 'https://reflected.example')

      expect(await res.text()).not.toContain('reflected.example')
    })
  })

  describe('rejection logging (D7)', () => {
    it('logs one line containing the rejected origin', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const { app } = createGuardedApp([])

      await postWithOrigin(app, 'https://evil.example')

      expect(errorSpy).toHaveBeenCalledTimes(1)
      expect(errorSpy.mock.calls[0]?.[0]).toContain('https://evil.example')
    })

    it('logs a repeated origin only once', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const { app } = createGuardedApp([])

      await postWithOrigin(app, 'https://evil.example')
      await postWithOrigin(app, 'https://evil.example')
      await postWithOrigin(app, 'https://evil.example')

      expect(errorSpy).toHaveBeenCalledTimes(1)
    })

    it('suppresses per-origin lines after the unique-origin cap', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const { app } = createGuardedApp([])

      for (let i = 0; i < 20; i++) {
        await postWithOrigin(app, `https://evil-${String(i)}.example`)
      }
      expect(errorSpy).toHaveBeenCalledTimes(20)

      await postWithOrigin(app, 'https://evil-overflow.example')

      expect(errorSpy).toHaveBeenCalledTimes(21)
      const lastLine = String(errorSpy.mock.calls[20]?.[0])
      expect(lastLine).not.toContain('evil-overflow.example')
      expect(lastLine).toContain('suppress')
    })

    it('counts repeats past the cap as suppressed rejections, not distinct origins', async () => {
      // Past the cap an origin is not recorded, so repeats of a single one keep
      // incrementing the counter. The summary must describe that honestly
      // rather than claim the tally counts distinct origins.
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const { app } = createGuardedApp([])

      for (let i = 0; i < 20; i++) {
        await postWithOrigin(app, `https://evil-${String(i)}.example`)
      }
      for (let i = 0; i < 50; i++) {
        await postWithOrigin(app, 'https://overflow.example')
      }

      const summaries = errorSpy.mock.calls.slice(20).map((call) => String(call[0]))
      expect(summaries).toHaveLength(2)
      for (const line of summaries) {
        expect(line).not.toContain('overflow.example')
        expect(line).toContain('suppressing the rest')
      }
      expect(summaries[1]).toContain('50 further rejections')
    })

    it('truncates an oversized origin in the log line', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const { app } = createGuardedApp([])

      const oversized = `https://${'a'.repeat(2000)}.example`
      await postWithOrigin(app, oversized)

      const line = String(errorSpy.mock.calls[0]?.[0])
      expect(line).not.toContain(oversized)
      expect(line.length).toBeLessThan(400)
    })
  })
})
