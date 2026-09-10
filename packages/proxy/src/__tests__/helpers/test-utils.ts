import type { Hono } from 'hono'
import { serve } from '@hono/node-server'
import type { ServerType } from '@hono/node-server'
import type { HelioConfig, SingularHelioConfig } from '../../config/index.js'

/** A running server with its port and a close method. */
export interface ManagedServer {
  server: ServerType
  port: number
  close: () => Promise<void>
}

/**
 * Start a Hono app on a dynamic port (port 0), bound to 127.0.0.1 so the
 * kernel never hands it a port another process already holds on that
 * address (issue #271: an IPv6-wildcard bind(0) is handed such ports on
 * macOS, and the other process then answers the fixture's traffic).
 * Binding a named host resolves asynchronously, so the port is known
 * only once the server is listening.
 */
export function startOnDynamicPort(app: Hono): Promise<ManagedServer> {
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
      resolve({
        server,
        port: info.port,
        close: () =>
          new Promise<void>((done, fail) => {
            server.close((err) => {
              if (err) fail(err)
              else done()
            })
          }),
      })
    })
    // Port 0 on 127.0.0.1 cannot collide, but a listen failure must
    // reject rather than hang the caller to its test timeout.
    server.once('error', reject)
  })
}

/** Promisified server.close(). */
export function closeServer(server: ServerType): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}

/**
 * Build a valid HelioConfig with sensible test defaults.
 * Pass partial overrides to customize specific fields.
 */
export function makeConfig(
  overrides: {
    upstream?: Partial<SingularHelioConfig['upstream']>
    listen?: Partial<HelioConfig['listen']>
    dashboard?: Partial<HelioConfig['dashboard']>
    policies?: Partial<HelioConfig['policies']>
    approval?: Partial<HelioConfig['approval']>
    audit?: Partial<HelioConfig['audit']>
    environment?: string
    session?: Partial<HelioConfig['session']>
    sdk?: Partial<HelioConfig['sdk']>
  } = {},
): SingularHelioConfig {
  return {
    version: '1',
    upstream: {
      url: 'http://unused',
      transport: 'streamable-http',
      ...overrides.upstream,
    },
    listen: { port: 0, host: '127.0.0.1', ...overrides.listen },
    dashboard: {
      enabled: false,
      port: 3100,
      host: '127.0.0.1',
      allow_open_mode: false,
      sse_heartbeat_interval: '30s',
      ...overrides.dashboard,
    },
    environment: overrides.environment,
    session: {
      identity: [{ source: 'header', name: 'x-helio-session-id' }, { source: 'legacy_header' }],
      on_unresolved: 'deny',
      ...overrides.session,
    },
    policies: { default: 'allow', dry_run: false, rules: [], ...overrides.policies },
    approval: { timeout: '300s', default_on_timeout: 'deny', channels: [], ...overrides.approval },
    audit: {
      storage: 'sqlite',
      path: './helio-audit.db',
      retention: '90d',
      include_responses: true,
      ...overrides.audit,
    },
    sdk: { enabled: false, port: 3200, host: '127.0.0.1', ...overrides.sdk },
  } as SingularHelioConfig
}

/**
 * Build a valid named-mode (upstreams:) HelioConfig for the given entry
 * names. Pass per-entry URLs and section overrides to customize, the same
 * way makeConfig does for singular configs; without a `urls` entry a name
 * gets a placeholder URL (fine for routing tests that never dial out).
 */
export function makeNamedConfig(
  names: string[],
  overrides: {
    /** Real per-entry URL by name — two-upstream suites point these at live fixtures. */
    urls?: Record<string, string>
    listen?: Partial<HelioConfig['listen']>
    environment?: string
    session?: Partial<HelioConfig['session']>
    policies?: Partial<HelioConfig['policies']>
    budgets?: HelioConfig['budgets']
  } = {},
): HelioConfig {
  return {
    version: '1',
    upstreams: names.map((name) => ({
      name,
      url: overrides.urls?.[name] ?? `http://localhost:8081/${name}`,
      transport: 'streamable-http',
      protocol_version: 'auto',
      connect_timeout: '10s',
      request_timeout: '30s',
      forward_headers: [],
      headers: {},
    })),
    listen: { port: 3000, host: '127.0.0.1', allowed_origins: [], ...overrides.listen },
    dashboard: {
      enabled: false,
      port: 3100,
      host: '127.0.0.1',
      allow_open_mode: false,
      sse_heartbeat_interval: '30s',
    },
    environment: overrides.environment,
    session: {
      identity: [{ source: 'header', name: 'x-helio-session-id' }, { source: 'legacy_header' }],
      on_unresolved: 'deny',
      ...overrides.session,
    },
    policies: { default: 'allow', dry_run: false, rules: [], ...overrides.policies },
    approval: { timeout: '300s', default_on_timeout: 'deny', channels: [] },
    audit: {
      storage: 'sqlite',
      path: './helio-audit.db',
      retention: '90d',
      include_responses: true,
    },
    sdk: { enabled: false, port: 3200, host: '127.0.0.1', evaluation_ttl: '10m' },
    budgets: overrides.budgets ?? [],
  } as HelioConfig
}

/**
 * Send a JSON-RPC request to a proxy/server URL.
 * Returns the HTTP status and parsed JSON body.
 */
export async function sendMcpRequest(
  baseUrl: string,
  method: string,
  params?: unknown,
  id: number | string = 1,
  options?: {
    /** Sets the legacy Mcp-Session-Id wire header (deprecation window). */
    sessionId?: string
    /** Sets the canonical x-helio-session-id identity header (issue #218). */
    helioSessionId?: string
  },
): Promise<{ status: number; headers: Headers; body: Record<string, unknown> }> {
  const payload: Record<string, unknown> = {
    jsonrpc: '2.0',
    id,
    method,
  }
  if (params !== undefined) {
    payload['params'] = params
  }

  const reqHeaders: Record<string, string> = { 'content-type': 'application/json' }
  if (options?.sessionId) {
    reqHeaders['mcp-session-id'] = options.sessionId
  }
  if (options?.helioSessionId) {
    reqHeaders['x-helio-session-id'] = options.helioSessionId
  }

  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: reqHeaders,
    body: JSON.stringify(payload),
  })

  const body = (await res.json()) as Record<string, unknown>
  return { status: res.status, headers: res.headers, body }
}
