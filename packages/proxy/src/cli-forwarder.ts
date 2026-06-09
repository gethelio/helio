import { parseDuration } from './config/schema.js'
import { UpstreamForwarder, SseUpstreamForwarder } from './upstream/index.js'
import { StdioForwarder } from './transport/stdio-wrapper.js'
import type { HelioConfig } from './config/index.js'
import type { McpForwarder } from './mcp/types.js'

export interface BuiltForwarder {
  readonly forwarder: McpForwarder
  readonly close?: () => Promise<void>
}

/**
 * Construct the upstream forwarder for the configured transport. Static
 * `upstream.headers` are passed to the HTTP transports (`streamable-http`,
 * `sse`); `stdio` is a child process with no request headers.
 */
export async function createForwarderFromConfig(config: HelioConfig): Promise<BuiltForwarder> {
  switch (config.upstream.transport) {
    case 'streamable-http': {
      return {
        forwarder: new UpstreamForwarder({
          url: config.upstream.url,
          headers: config.upstream.headers,
          requestTimeoutMs: parseDuration(config.upstream.request_timeout),
        }),
      }
    }
    case 'sse': {
      const sse = new SseUpstreamForwarder({
        url: config.upstream.url,
        headers: config.upstream.headers,
        connectTimeoutMs: parseDuration(config.upstream.connect_timeout),
        requestTimeoutMs: parseDuration(config.upstream.request_timeout),
      })
      await sse.connect()
      return { forwarder: sse, close: () => sse.close() }
    }
    case 'stdio': {
      const stdio = new StdioForwarder({
        command: config.upstream.command as string,
        args: config.upstream.args,
        requestTimeoutMs: parseDuration(config.upstream.request_timeout),
      })
      await stdio.start()
      return { forwarder: stdio, close: () => stdio.close() }
    }
  }
}
