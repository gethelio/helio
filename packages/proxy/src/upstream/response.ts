import type { McpResponse } from '../mcp/types.js'

/**
 * Parse a native fetch Response into an McpResponse.
 *
 * Reads the full body as JSON when the content-type indicates JSON,
 * otherwise falls back to plain text. Captures all response headers
 * and preserves the full body for later audit capture.
 */
export async function parseUpstreamResponse(res: Response): Promise<McpResponse> {
  const headers: Record<string, string> = {}
  res.headers.forEach((value, key) => {
    headers[key] = value
  })

  const contentType = res.headers.get('content-type') ?? ''
  let body: unknown
  if (contentType.includes('application/json')) {
    const text = await res.text()
    try {
      body = JSON.parse(text)
    } catch {
      // Upstream claimed JSON but sent invalid body — fall back to raw text
      body = text
    }
  } else {
    body = await res.text()
  }

  return { status: res.status, headers, body }
}
