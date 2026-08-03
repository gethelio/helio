/**
 * Whether a `Content-Type` header names JSON.
 *
 * Compares the media type essence — everything before the first `;`, case
 * insensitively, per RFC 9110 — rather than searching the raw header for a
 * substring.
 *
 * The distinction is load bearing on the agent edge. `text/plain`,
 * `multipart/form-data`, and `application/x-www-form-urlencoded` are
 * CORS-safelisted, so a browser sends them cross-site with no preflight and
 * no cooperation from this server, while `application/json` is not and always
 * triggers one. A substring match is satisfied by hiding the token in a
 * parameter (`text/plain;x=application/json`), which passes the JSON
 * requirement while keeping the request preflight-free — putting the MCP
 * endpoint within reach of any web page the operator happens to visit.
 */
export function isJsonContentType(header: string | undefined): boolean {
  const [essence = ''] = (header ?? '').split(';')
  return essence.trim().toLowerCase() === 'application/json'
}
