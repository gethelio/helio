import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import type { ServerType } from '@hono/node-server'
import type { Socket } from 'node:net'
import { createStreamableHttpRoute } from './transport/streamable-http.js'
import { createSseRoute } from './transport/sse.js'
import { compileSessionIdentity } from './mcp/session-resolver.js'
import { isNamedConfig } from './config/index.js'
import type { HelioConfig, NamedHelioConfig } from './config/index.js'
import { INVALID_REQUEST, makeJsonRpcErrorWithoutId } from './mcp/types.js'
import type { HeaderMismatchRejection, McpForwarder } from './mcp/types.js'

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
  /**
   * Recorder for inbound header/body agreement rejections (issue #226) on
   * the streamable-http route. Enforcement does not depend on it — with no
   * recorder the request is still rejected and no record is written (the
   * library-embedding posture `missing_tool_name` also takes).
   */
  onHeaderMismatch?: (rejection: HeaderMismatchRejection) => void
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
  if (isNamedConfig(config)) {
    // One app serves one upstream; silently mounting a single door for a
    // named config would drop every other declared upstream.
    throw new Error(
      'createApp serves a single-upstream (upstream:) config only. Named multi-upstream ' +
        'configs are composed by createMultiApp.',
    )
  }
  const app = new Hono()
  const forwardHeadersAllowlist = config.upstream.forward_headers
  const allowedOrigins = config.listen.allowed_origins
  // Compiled once at startup, like the listener itself — the session section
  // is restart-required at the reload boundary (issue #218).
  const session = compileSessionIdentity(config.session)

  // Health check
  app.get('/healthz', (c) => c.json({ status: 'ok' }))

  // MCP Streamable HTTP transport
  app.route(
    '/mcp',
    createStreamableHttpRoute(forwarder, {
      forwardHeadersAllowlist,
      allowedOrigins,
      session,
      onHeaderMismatch: options?.onHeaderMismatch,
    }),
  )

  // MCP SSE transport (for older clients)
  app.route('/sse', createSseRoute(forwarder, { forwardHeadersAllowlist, allowedOrigins, session }))

  // Slack interactive action handler
  if (options?.slackActionApp) {
    app.route('/slack/actions', options.slackActionApp)
  }

  return app
}

/**
 * Optional sub-apps and callbacks for the multi-upstream composition.
 * The main-port posture is `createApp`'s (see CreateAppOptions): only the
 * Slack webhook callback belongs beside the MCP doors.
 */
export interface CreateMultiAppOptions {
  /** Slack interactive action handler (mounted at /slack/actions, global). */
  slackActionApp?: Hono
  /**
   * Recorder for inbound header/body agreement rejections (issue #226),
   * called with the name of the door that rejected so the audit record can
   * attribute it. Enforcement does not depend on it.
   */
  onHeaderMismatch?: (rejection: HeaderMismatchRejection, upstreamName: string) => void
}

/**
 * Create a Hono app serving every named upstream at its own pair of mounts,
 * `/mcp/<name>` and `/sse/<name>`, each a fresh route stack wrapping that
 * entry's forwarder. `/healthz` and `/slack/actions` stay global. There is
 * NO bare-path default: bare `/mcp`, `/sse`, and unknown names get an
 * explicit 404 catch-all whose JSON-RPC envelope states the path shape and
 * never enumerates configured names.
 *
 * @param config - The validated named-mode Helio configuration.
 * @param forwarders - One forwarder per configured entry, keyed by name.
 *   Must cover the configured names exactly; missing or extra keys throw
 *   (a missing key would silently mount a dead door, an extra one means the
 *   record drifted from the config — fail at composition, not per request).
 * @param options - Optional sub-apps and callbacks.
 */
export function createMultiApp(
  config: HelioConfig,
  forwarders: Record<string, McpForwarder>,
  options?: CreateMultiAppOptions,
): Hono {
  if (!isNamedConfig(config)) {
    throw new Error(
      'createMultiApp composes a named multi-upstream (upstreams:) config only. ' +
        'Singular configs are served by createApp.',
    )
  }

  const doors: Array<{
    entry: NamedHelioConfig['upstreams'][number]
    forwarder: McpForwarder
  }> = []
  const missing: string[] = []
  for (const entry of config.upstreams) {
    const forwarder = forwarders[entry.name]
    if (forwarder === undefined) missing.push(entry.name)
    else doors.push({ entry, forwarder })
  }
  const configured = new Set(config.upstreams.map((entry) => entry.name))
  const unexpected = Object.keys(forwarders).filter((name) => !configured.has(name))
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      'createMultiApp forwarders must match the configured upstream names exactly — ' +
        `missing: [${missing.join(', ')}], unexpected: [${unexpected.join(', ')}].`,
    )
  }

  const app = new Hono()
  const allowedOrigins = config.listen.allowed_origins
  // Compiled ONCE and shared by every door — the session section is global
  // (one listener, one identity posture) and restart-required at the reload
  // boundary (issue #218).
  const session = compileSessionIdentity(config.session)

  app.get('/healthz', (c) => c.json({ status: 'ok' }))

  for (const { entry, forwarder } of doors) {
    const name = entry.name
    app.route(
      `/mcp/${name}`,
      createStreamableHttpRoute(forwarder, {
        forwardHeadersAllowlist: entry.forward_headers,
        allowedOrigins,
        session,
        onHeaderMismatch: options?.onHeaderMismatch
          ? (rejection) => options.onHeaderMismatch?.(rejection, name)
          : undefined,
      }),
    )
    app.route(
      `/sse/${name}`,
      createSseRoute(forwarder, {
        forwardHeadersAllowlist: entry.forward_headers,
        allowedOrigins,
        session,
        routeLabel: `/sse/${name}`,
      }),
    )
  }

  if (options?.slackActionApp) {
    app.route('/slack/actions', options.slackActionApp)
  }

  // Registered AFTER every mount — a catch-all registered first would shadow
  // every door. The `*` pattern also matches the bare prefix, so bare /mcp
  // and /sse need no separate registration. The bodies use the id-omitting
  // helper only (no body parsing — this must not become another id-echo
  // site) and never enumerate configured names.
  app.all('/mcp/*', (c) =>
    c.json(
      makeJsonRpcErrorWithoutId(
        INVALID_REQUEST,
        'No MCP endpoint answers this request: this Helio serves named upstreams at /mcp/<name>.',
      ),
      404,
    ),
  )
  app.all('/sse/*', (c) =>
    c.json(
      makeJsonRpcErrorWithoutId(
        INVALID_REQUEST,
        'No MCP endpoint answers this request: this Helio serves named upstreams at /sse/<name>.',
      ),
      404,
    ),
  )

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
