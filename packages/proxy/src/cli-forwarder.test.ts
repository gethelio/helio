import { describe, it, expect, vi, beforeEach } from 'vitest'

const upstreamCtor = vi.fn()
const sseCtor = vi.fn()
const streamableCtor = vi.fn()

vi.mock('./upstream/index.js', () => ({
  UpstreamForwarder: upstreamCtor,
  SseUpstreamForwarder: class {
    connect = vi.fn().mockResolvedValue(undefined)
    close = vi.fn().mockResolvedValue(undefined)
    constructor(opts: unknown) {
      sseCtor(opts)
    }
  },
  StreamableHttpForwarder: class {
    connect = vi.fn().mockResolvedValue(undefined)
    close = vi.fn().mockResolvedValue(undefined)
    constructor(opts: unknown) {
      streamableCtor(opts)
    }
  },
}))

const { createForwarderFromConfig } = await import('./cli-forwarder.js')
const { makeConfig } = await import('./__tests__/helpers/test-utils.js')

describe('createForwarderFromConfig', () => {
  beforeEach(() => {
    upstreamCtor.mockClear()
    sseCtor.mockClear()
    streamableCtor.mockClear()
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

    expect(streamableCtor).toHaveBeenCalledWith(
      expect.objectContaining({ headers: { Authorization: 'Bearer t' } }),
    )
  })

  it('constructs a lifecycle-managed streamable-http forwarder', async () => {
    const url = 'http://upstream/mcp'
    const headers = { Authorization: 'Bearer t' }
    const config = makeConfig({
      upstream: {
        url,
        transport: 'streamable-http',
        request_timeout: '30s',
        headers,
      },
    })

    const built = await createForwarderFromConfig(config)

    expect(streamableCtor).toHaveBeenCalledWith(expect.objectContaining({ url, headers }))
    expect(upstreamCtor).not.toHaveBeenCalled()

    // connect must have been awaited during construction
    const instance = built.forwarder as unknown as {
      connect: ReturnType<typeof vi.fn>
      close: ReturnType<typeof vi.fn>
    }
    expect(instance.connect).toHaveBeenCalledOnce()

    // close on the returned handle must delegate to the instance's close
    expect(built.close).toBeDefined()
    await built.close?.()
    expect(instance.close).toHaveBeenCalledOnce()
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
