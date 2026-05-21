import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import type { ServerType } from '@hono/node-server'
import type { Socket } from 'node:net'
import { createStreamableHttpRoute } from './transport/streamable-http.js'
import { createSseRoute } from './transport/sse.js'
import type { HelioConfig } from './config/index.js'
import type { McpForwarder } from './mcp/types.js'

/** Handle returned by `startServer` for lifecycle management. */
export interface ServerHandle {
  server: ServerType
  close: () => Promise<void>
}

interface NodeServerWithConnectionControls {
  close: (callback: (err?: Error) => void) => void
  on: (event: 'connection', listener: (socket: Socket) => void) => void
  closeIdleConnections?: () => void
  closeAllConnections?: () => void
}

const FORCE_CONNECTION_CLOSE_GRACE_MS = 1_500

function normalizeError(error: unknown): Error {
  if (error instanceof Error) return error
  return new Error(String(error))
}

function createServerHandle(server: ServerType): ServerHandle {
  const sockets = new Set<Socket>()
  const nodeServer = server as unknown as NodeServerWithConnectionControls

  nodeServer.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => {
      sockets.delete(socket)
    })
  })

  const forceCloseConnections = () => {
    try {
      nodeServer.closeIdleConnections?.()
    } catch {
      // Ignore best-effort idle close failures.
    }

    if (nodeServer.closeAllConnections) {
      try {
        nodeServer.closeAllConnections()
      } catch {
        // Ignore best-effort force close failures.
      }
      return
    }

    for (const socket of sockets) {
      socket.destroy()
    }
  }

  return {
    server,
    close: () =>
      new Promise<void>((resolve, reject) => {
        let settled = false
        let forceTimer: ReturnType<typeof setTimeout> | undefined

        const settle = (err?: Error) => {
          if (settled) return
          settled = true
          if (forceTimer) {
            clearTimeout(forceTimer)
            forceTimer = undefined
          }
          if (err) {
            reject(err)
            return
          }
          resolve()
        }

        try {
          nodeServer.close((err) => {
            if (err) {
              settle(err)
              return
            }
            settle()
          })
        } catch (error) {
          settle(normalizeError(error))
          return
        }

        // Ask Node to close keep-alive sockets immediately.
        try {
          nodeServer.closeIdleConnections?.()
        } catch {
          // Ignore best-effort idle close failures.
        }

        // If active long-lived streams keep sockets open, force-close them
        // after a short grace period so shutdown remains bounded.
        forceTimer = setTimeout(() => {
          forceCloseConnections()
        }, FORCE_CONNECTION_CLOSE_GRACE_MS)
        forceTimer.unref()
      }),
  }
}

/**
 * Optional sub-apps to mount on the main proxy server.
 *
 * The main MCP port is the agent-facing edge and must stay minimal. Operator
 * read APIs (approval REST, rate/spend limit status) deliberately live on
 * the dashboard sideband instead, so that an agent speaking `/mcp` cannot
 * enumerate budget state to time attacks or self-approve its own pending
 * tickets on the same origin. Only Slack interactive action callbacks
 * belong here — they are public inbound webhooks from Slack's servers, not
 * operator read endpoints.
 */
export interface CreateAppOptions {
  /** Slack interactive action handler (mounted at /slack/actions). */
  slackActionApp?: Hono
}

/**
 * Create a Hono app configured with the MCP proxy routes.
 *
 * @param _config - The validated Helio configuration.
 * @param forwarder - The MCP forwarder to delegate requests to.
 * @param options - Optional sub-apps to mount.
 */
export function createApp(
  config: HelioConfig,
  forwarder: McpForwarder,
  options?: CreateAppOptions,
): Hono {
  const app = new Hono()
  const forwardHeadersAllowlist = config.upstream.forward_headers

  // Health check
  app.get('/healthz', (c) => c.json({ status: 'ok' }))

  // MCP Streamable HTTP transport
  app.route('/mcp', createStreamableHttpRoute(forwarder, { forwardHeadersAllowlist }))

  // MCP SSE transport (for older clients)
  app.route('/sse', createSseRoute(forwarder, { forwardHeadersAllowlist }))

  // Slack interactive action handler
  if (options?.slackActionApp) {
    app.route('/slack/actions', options.slackActionApp)
  }

  return app
}

/**
 * Start the HTTP server on the configured host and port.
 *
 * @param app - The Hono app to serve.
 * @param config - The validated Helio configuration (uses `listen.port` and `listen.host`).
 * @returns A handle with the underlying server and a `close()` method for graceful shutdown.
 */
export function startServer(app: Hono, config: HelioConfig): ServerHandle {
  const server = serve({
    fetch: app.fetch,
    port: config.listen.port,
    hostname: config.listen.host,
  })

  return createServerHandle(server)
}

/**
 * Start the sideband HTTP server for the SDK API.
 *
 * Binds to 127.0.0.1 by default (local-only) on the configured SDK port.
 */
export function startSidebandServer(
  app: Hono,
  port: number,
  host: string = '127.0.0.1',
): ServerHandle {
  const server = serve({
    fetch: app.fetch,
    port,
    hostname: host,
  })

  return createServerHandle(server)
}
