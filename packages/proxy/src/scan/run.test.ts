import { describe, it, expect, vi } from 'vitest'
import { runScan } from './run.js'
import type { RunScanOptions, ScanSignalSource } from './run.js'
import type { ScanTarget } from './target.js'
import type { BuiltForwarder } from '../cli-forwarder.js'
import { upstreamSchema } from '../config/schema.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TARGET: ScanTarget = {
  upstream: upstreamSchema.parse({ url: 'http://127.0.0.1:1/mcp' }),
  upstreamName: undefined,
  transport: 'streamable-http',
  label: 'http://127.0.0.1:1/mcp',
  source: 'argument',
  configPath: undefined,
  credentialDropped: false,
  rawUpstream: undefined,
}

const CONFIG_TARGET: ScanTarget = {
  ...TARGET,
  label: 'http://host/mcp?key=${API_KEY}',
  source: 'config',
  configPath: 'helio.yaml',
}

/** A signal source the test fires by hand, in place of `process`. */
function fakeSignals(): ScanSignalSource & { fire(signal: 'SIGINT' | 'SIGTERM'): void } {
  const handlers = new Map<string, () => void>()
  return {
    on(signal, handler) {
      handlers.set(signal, handler)
    },
    off(signal) {
      handlers.delete(signal)
    },
    fire(signal) {
      handlers.get(signal)?.()
    },
  }
}

function toolsListForwarder(
  tools: unknown[],
): BuiltForwarder & { close: ReturnType<typeof vi.fn> } {
  return {
    forwarder: {
      forward: () =>
        Promise.resolve({
          response: {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: { jsonrpc: '2.0', id: 1, result: { tools } },
          },
          durationMs: 1,
        }),
    },
    close: vi.fn().mockResolvedValue(undefined),
  }
}

function harness(overrides: Partial<RunScanOptions> = {}) {
  const stdout: string[] = []
  const stderr: string[] = []
  const exit = vi.fn()
  const signals = fakeSignals()
  const options: RunScanOptions = {
    target: TARGET,
    format: 'text',
    config: undefined,
    connect: () => Promise.reject(new Error('connect not stubbed')),
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
    exit,
    signals,
    now: () => new Date('2026-09-29T12:50:00.000Z'),
    ...overrides,
  }
  return { options, stdout, stderr, exit, signals }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runScan', () => {
  it('lists, prints the text report, closes the forwarder and returns 0', async () => {
    const built = toolsListForwarder([{ name: 'a', annotations: { readOnlyHint: true } }])
    const h = harness({ connect: () => Promise.resolve(built) })
    const code = await runScan(h.options)
    expect(code).toBe(0)
    expect(h.stdout.join('\n')).toContain(
      'Scan of http://127.0.0.1:1/mcp (streamable-http), 2026-09-29 12:50 UTC',
    )
    expect(h.stdout.join('\n')).toContain(
      'Summary: 1 tool exposed, 1 destructive (1 by MCP default), 0 governed',
    )
    expect(built.close).toHaveBeenCalledOnce()
    expect(h.exit).not.toHaveBeenCalled()
  })

  it('prints the JSON document with surface.unavailable and returns 1 when the list throws', async () => {
    const built = {
      forwarder: {
        forward: () =>
          Promise.reject(Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' })),
      },
      close: vi.fn().mockResolvedValue(undefined),
    }
    const h = harness({
      format: 'json',
      target: CONFIG_TARGET,
      connect: () => Promise.resolve(built),
    })
    const code = await runScan(h.options)
    expect(code).toBe(1)
    const doc = JSON.parse(h.stdout.join('\n')) as {
      surface: { unavailable: { reason: string }[] }
      tools: unknown[]
    }
    expect(doc.surface.unavailable[0]?.reason).toBe(
      'Error: cannot list tools on http://host/mcp?key=${API_KEY} (ECONNREFUSED)',
    )
    expect(doc.tools).toEqual([])
    expect(h.stderr).toEqual([])
    expect(built.close).toHaveBeenCalledOnce()
  })

  it('prints the bare-URL line with the transport message when the connect rejects', async () => {
    const h = harness({
      connect: () => Promise.reject(new Error('upstream initialize failed: HTTP 400')),
    })
    const code = await runScan(h.options)
    expect(code).toBe(1)
    expect(h.stdout.join('\n').split('\n').at(-1)).toBe(
      'Error: cannot list tools on http://127.0.0.1:1/mcp: upstream initialize failed: HTTP 400',
    )
  })

  it('aborts a pending connect on SIGINT, prints nothing and returns 130', async () => {
    let seen: AbortSignal | undefined
    const connect = (signal: AbortSignal) =>
      new Promise<BuiltForwarder>((_resolve, reject) => {
        seen = signal
        signal.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'))
        })
      })
    const h = harness({ connect })
    const run = runScan(h.options)
    await vi.waitFor(() => {
      expect(seen).toBeDefined()
    })
    h.signals.fire('SIGINT')
    const code = await run
    expect(code).toBe(130)
    expect(h.stdout).toEqual([])
    expect(h.stderr).toEqual([])
    expect(h.exit).not.toHaveBeenCalled()
  })

  it('closes the built forwarder and exits 143 on SIGTERM during the list', async () => {
    let rejectList: (err: Error) => void = () => {}
    const close = vi.fn(() => {
      rejectList(new Error('forwarder closing'))
      return Promise.resolve()
    })
    const built: BuiltForwarder = {
      forwarder: {
        forward: () =>
          new Promise((_resolve, reject) => {
            rejectList = reject
          }),
      },
      close,
    }
    const h = harness({ connect: () => Promise.resolve(built) })
    const run = runScan(h.options)
    await vi.waitFor(() => {
      expect(close).not.toHaveBeenCalled()
      expect(rejectList.name).not.toBe('')
    })
    h.signals.fire('SIGTERM')
    const code = await run
    expect(code).toBe(143)
    expect(h.stdout).toEqual([])
    await vi.waitFor(() => {
      expect(h.exit).toHaveBeenCalledWith(143)
    })
    expect(close).toHaveBeenCalled()
  })

  it('removes its signal handlers when the run ends', async () => {
    const built = toolsListForwarder([])
    const h = harness({ connect: () => Promise.resolve(built) })
    const off = vi.spyOn(h.signals, 'off')
    await runScan(h.options)
    expect(off).toHaveBeenCalledWith('SIGINT', expect.any(Function))
    expect(off).toHaveBeenCalledWith('SIGTERM', expect.any(Function))
  })
})
