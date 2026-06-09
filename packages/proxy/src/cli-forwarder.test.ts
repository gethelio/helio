import { describe, it, expect, vi, beforeEach } from 'vitest'

const upstreamCtor = vi.fn()
const sseCtor = vi.fn()

vi.mock('./upstream/index.js', () => ({
  UpstreamForwarder: upstreamCtor,
  SseUpstreamForwarder: class {
    connect = vi.fn().mockResolvedValue(undefined)
    close = vi.fn().mockResolvedValue(undefined)
    constructor(opts: unknown) {
      sseCtor(opts)
    }
  },
}))

const { createForwarderFromConfig } = await import('./cli-forwarder.js')
const { makeConfig } = await import('./__tests__/helpers/test-utils.js')

describe('createForwarderFromConfig', () => {
  beforeEach(() => {
    upstreamCtor.mockClear()
    sseCtor.mockClear()
  })

  it('passes upstream.headers to the streamable-http forwarder', async () => {
    const config = makeConfig({
      upstream: {
        url: 'http://upstream/mcp',
        transport: 'streamable-http',
        request_timeout: '30s',
        headers: { Authorization: 'Bearer t' },
      },
    })

    await createForwarderFromConfig(config)

    expect(upstreamCtor).toHaveBeenCalledWith(
      expect.objectContaining({ headers: { Authorization: 'Bearer t' } }),
    )
  })

  it('passes upstream.headers to the sse forwarder', async () => {
    const config = makeConfig({
      upstream: {
        url: 'http://upstream/mcp',
        transport: 'sse',
        connect_timeout: '10s',
        request_timeout: '30s',
        headers: { Authorization: 'Bearer t' },
      },
    })

    await createForwarderFromConfig(config)

    expect(sseCtor).toHaveBeenCalledWith(
      expect.objectContaining({ headers: { Authorization: 'Bearer t' } }),
    )
  })
})
