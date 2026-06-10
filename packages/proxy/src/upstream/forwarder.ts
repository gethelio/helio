import {
  StreamableHttpForwarder,
  type StreamableHttpForwarderOptions,
} from './streamable-http-forwarder.js'

/** Options for constructing an UpstreamForwarder. */
export type UpstreamForwarderOptions = StreamableHttpForwarderOptions

/**
 * @deprecated Use `StreamableHttpForwarder` directly for new code.
 *
 * Backward-compatible alias for older integrations that imported
 * `UpstreamForwarder`. Kept to avoid a breaking API change.
 *
 * Behavior matches `StreamableHttpForwarder` (including Streamable HTTP SSE
 * response parsing and managed internal session support).
 */
export class UpstreamForwarder extends StreamableHttpForwarder {}
