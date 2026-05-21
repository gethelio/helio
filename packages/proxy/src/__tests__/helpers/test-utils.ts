import type { AddressInfo } from 'node:net'
import type { Hono } from 'hono'
import { serve } from '@hono/node-server'
import type { ServerType } from '@hono/node-server'
import type { HelioConfig } from '../../config/index.js'

/** A running server with its port and a close method. */
export interface ManagedServer {
  server: ServerType
  port: number
  close: () => Promise<void>
}

/** Extract the assigned port from a running server. */
export function getPort(server: ServerType): number {
  const addr = server.address() as AddressInfo
  return addr.port
}

/** Start a Hono app on a dynamic port (port 0). */
export function startOnDynamicPort(app: Hono): ManagedServer {
  const server = serve({ fetch: app.fetch, port: 0 })
  const port = getPort(server)
  return {
    server,
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err)
          else resolve()
        })
      }),
  }
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
    upstream?: Partial<HelioConfig['upstream']>
    listen?: Partial<HelioConfig['listen']>
    dashboard?: Partial<HelioConfig['dashboard']>
    policies?: Partial<HelioConfig['policies']>
    approval?: Partial<HelioConfig['approval']>
    audit?: Partial<HelioConfig['audit']>
    environment?: string
    sdk?: Partial<HelioConfig['sdk']>
  } = {},
): HelioConfig {
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
  options?: { sessionId?: string },
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

  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: reqHeaders,
    body: JSON.stringify(payload),
  })

  const body = (await res.json()) as Record<string, unknown>
  return { status: res.status, headers: res.headers, body }
}
