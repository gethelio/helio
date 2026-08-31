import { describe, it, expect } from 'vitest'
import net from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import type { ServerType } from '@hono/node-server'
import { createDashboardAppWithLifecycle } from '../dashboard/api.js'
import type { DashboardAppLifecycle } from '../dashboard/api.js'
import { DashboardEventBus } from '../dashboard/event-bus.js'
import { AuditStore } from '../audit/store.js'
import { ApprovalQueue } from '../approval/queue.js'
import { ApprovalRouter } from '../approval/router.js'
import { QueueChannel } from '../approval/channels.js'
import { RateLimiter } from '../policy/rate-limiter.js'
import { SpendLimiter } from '../policy/spend-limiter.js'
import { EvidenceStore } from '../evidence/store.js'
import { startOnDynamicPort } from './helpers/test-utils.js'

// ---------------------------------------------------------------------------
// GET /api/events write liveness over the REAL transport (issue #327).
//
// The in-process dashboard suite cannot observe the transport half of the
// sweeper's job: an app.request fixture has no server socket, so severing
// (or failing to sever) a dead connection is invisible there. These tests
// run the dashboard app under @hono/node-server with raw net.Socket
// clients, where the server-side connection count and the bytes on the
// wire are the observables.
// ---------------------------------------------------------------------------

// The chunked-encoding last-chunk: how a gracefully completed HTTP body
// ends on the wire under Transfer-Encoding: chunked.
const LAST_CHUNK = Buffer.from('0\r\n\r\n', 'latin1')

interface LiveDashboard {
  eventBus: DashboardEventBus
  lifecycle: DashboardAppLifecycle
  server: ServerType
  port: number
  closeAll: () => Promise<void>
}

function makeLiveDashboard(options: {
  sseHeartbeatMs: number
  maxSseConnections?: number
  sweepIntervalMs?: number
}): LiveDashboard {
  const auditStore = new AuditStore({
    path: ':memory:',
    retention: '90d',
    includeResponses: true,
    cleanupIntervalMs: 0,
  })
  const approvalQueue = new ApprovalQueue({ cleanupIntervalMs: 0 })
  const channels = new Map([['dashboard', new QueueChannel()]])
  const approvalRouter = new ApprovalRouter({
    defaultTimeoutMs: 300_000,
    defaultOnTimeout: 'deny',
    channels,
    queue: approvalQueue,
  })
  const rateLimiter = new RateLimiter({ cleanupIntervalMs: 0 })
  const spendLimiter = new SpendLimiter({ cleanupIntervalMs: 0 })
  const evidenceStore = new EvidenceStore({ cleanupIntervalMs: 0 })
  const eventBus = new DashboardEventBus()
  const lifecycle = createDashboardAppWithLifecycle(
    {
      auditStore,
      approvalRouter,
      approvalQueue,
      rateLimiter,
      spendLimiter,
      evidenceStore,
      eventBus,
    },
    options,
  )
  const managed = startOnDynamicPort(lifecycle.app)
  const closeAll = async (): Promise<void> => {
    lifecycle.close()
    await managed.close()
    auditStore.close()
    approvalQueue.close()
    rateLimiter.close()
    spendLimiter.close()
    evidenceStore.close()
    eventBus.close()
  }
  return { eventBus, lifecycle, server: managed.server, port: managed.port, closeAll }
}

/**
 * Raw SSE client over a bare socket. Accumulates every received byte and
 * records socket-level lifecycle events; `admitted` resolves once the
 * initial heartbeat frame has arrived (the handler is past its
 * abort-cleanup registration from then on).
 */
function openRawSseClient(port: number): {
  socket: net.Socket
  admitted: Promise<void>
  state: () => {
    endsWithLastChunk: boolean
    ended: boolean
    closed: boolean
    errored: string | null
    totalBytes: number
  }
} {
  const socket = net.connect(port, '127.0.0.1')
  const chunks: Buffer[] = []
  let ended = false
  let closed = false
  let errored: string | null = null
  socket.on('data', (chunk: Buffer) => chunks.push(chunk))
  socket.on('end', () => {
    ended = true
  })
  socket.on('close', () => {
    closed = true
  })
  socket.on('error', (e) => {
    errored = String(e)
  })
  const admitted = new Promise<void>((resolve) => {
    socket.on('data', () => {
      if (Buffer.concat(chunks).toString('latin1').includes('event: heartbeat')) resolve()
    })
  })
  socket.on('connect', () => {
    socket.write('GET /api/events HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept: text/event-stream\r\n\r\n')
  })
  const state = () => {
    const all = Buffer.concat(chunks)
    const tail = all.subarray(Math.max(0, all.length - LAST_CHUNK.length))
    return {
      endsWithLastChunk: tail.equals(LAST_CHUNK),
      ended,
      closed,
      errored,
      totalBytes: all.length,
    }
  }
  return { socket, admitted, state }
}

/** Raw GET returning just the response status and the open socket. */
function rawGetStatus(port: number): Promise<{ status: number; socket: net.Socket }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1')
    let head = ''
    let resolved = false
    socket.on('error', (e) => {
      if (!resolved) reject(e instanceof Error ? e : new Error(String(e)))
    })
    socket.on('data', (chunk: Buffer) => {
      if (resolved) return
      head += chunk.toString('latin1')
      const match = /^HTTP\/1\.1 (\d{3})/.exec(head)
      if (match) {
        resolved = true
        resolve({ status: Number(match[1]), socket })
      }
    })
    socket.on('connect', () => {
      socket.write(
        'GET /api/events HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept: text/event-stream\r\n\r\n',
      )
    })
  })
}

function countConnections(server: ServerType): Promise<number> {
  return new Promise((resolve, reject) => {
    server.getConnections((err, count) => {
      if (err) reject(err)
      else resolve(count)
    })
  })
}

async function pollUntil(
  check: () => Promise<boolean>,
  timeoutMs: number,
  stepMs = 250,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await check()) return true
    if (Date.now() >= deadline) return false
    await sleep(stepMs)
  }
}

describe('GET /api/events — sweeper sever over the real transport (issue #327)', () => {
  it('severs a dead-but-unaborted connection at sweep: server-side socket destroyed', async () => {
    const fx = makeLiveDashboard({
      sseHeartbeatMs: 1000,
      maxSseConnections: 1,
      sweepIntervalMs: 1000,
    })
    const client = openRawSseClient(fx.port)
    const openedSockets: net.Socket[] = []
    try {
      // Dead-but-unaborted: admitted, then the read side pauses. The
      // socket stays open — no FIN, no RST — so the abort path never
      // fires; only the sweeper can reclaim this connection.
      await client.admitted
      client.socket.pause()

      // Baseline: the paused client is the ONLY server-side connection.
      expect(await pollUntil(async () => (await countConnections(fx.server)) === 1, 5000)).toBe(
        true,
      )

      // The slot is genuinely held. The probe socket is destroyed and the
      // count re-confirmed at 1 BEFORE the pump, so the sever window
      // below contains no test-owned sockets besides the paused client.
      const preProbe = await rawGetStatus(fx.port)
      expect(preProbe.status).toBe(503)
      preProbe.socket.destroy()
      expect(await pollUntil(async () => (await countConnections(fx.server)) === 1, 5000)).toBe(
        true,
      )

      // Fill the transport buffers well past any plausible CI loopback
      // capacity (4096 x ~8 KB ≈ 32 MB) so writes PEND and lastWrite
      // goes stale. The precise buffering capacity is OS-dependent and
      // deliberately not encoded here.
      const filler = 'x'.repeat(8192)
      for (let i = 0; i < 4096; i++) {
        fx.eventBus.emit('budget_update', {
          name: filler,
          bucket_key: 'budget:liveness',
          kind: 'spend',
          amount: 1,
          spent: 1,
          remaining: 0,
          limit: 1,
          currency: 'USD',
          utilization: 1,
          upstream: null,
        })
        if (i % 8 === 0) await sleep(1)
      }

      // The sweeper severs the dead connection: the server-side socket is
      // destroyed and the connection count drops to zero. No other
      // requests are made during this window.
      await pollUntil(async () => (await countConnections(fx.server)) === 0, 15_000)
      expect(await countConnections(fx.server)).toBe(0)

      // Slot-reclaim pin (the pend -> stale -> sweep story): a fresh
      // connection is admitted into the freed slot.
      const readmitted = await rawGetStatus(fx.port)
      openedSockets.push(readmitted.socket)
      expect(readmitted.status).toBe(200)
    } finally {
      client.socket.destroy()
      for (const socket of openedSockets) socket.destroy()
      await fx.closeAll()
    }
  }, 40_000)

  it('shutdown drain still ends streams gracefully: body completes, TCP stays open', async () => {
    // Drain-boundary pin: sever is SWEEP-ONLY. The shutdown drain must
    // keep its graceful-end contract — the in-process drain test cannot
    // see a sever (no server socket there), so the boundary is pinned
    // here, on the wire.
    const fx = makeLiveDashboard({ sseHeartbeatMs: 5000 })
    const client = openRawSseClient(fx.port)
    try {
      // A healthy READING client (never paused) is admitted, then the
      // dashboard lifecycle drain runs — the production shutdown order.
      await client.admitted
      fx.lifecycle.close()
      await sleep(1500)

      const state = client.state()
      // Graceful end: the chunked HTTP body completed with the last-chunk.
      expect(state.endsWithLastChunk).toBe(true)
      // Keep-alive leaves the TCP socket open after a graceful drain: no
      // socket-level teardown events. (A sever wired into shared cleanup
      // inverts BOTH asserts — the last-chunk never arrives and
      // 'end'/'close' fire. It destroys cleanly on loopback, so an
      // 'error' assertion would discriminate nothing.)
      expect(state.ended).toBe(false)
      expect(state.closed).toBe(false)
      expect(state.errored).toBeNull()
    } finally {
      client.socket.destroy()
      await fx.closeAll()
    }
  }, 15_000)
})
