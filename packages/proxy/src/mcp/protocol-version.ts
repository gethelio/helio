/**
 * The two MCP revisions Helio speaks, plus the pinned tokenizer for a
 * client's raw `MCP-Protocol-Version` claim. A leaf module by design:
 * transport, upstream, and policy all need this vocabulary, and none of
 * them should have to import another layer's machinery to get it.
 */

/** The legacy leg's protocol offer — one of the two revisions Helio speaks. */
export const HELIO_MCP_LEGACY_PROTOCOL_VERSION = '2025-06-18'
/** MCP revision Helio speaks to a modern upstream (no initialize handshake). */
export const HELIO_MCP_MODERN_PROTOCOL_VERSION = '2026-07-28'

/**
 * True iff the raw `MCP-Protocol-Version` value is the modern claim, under
 * the pinned tier tokenizer: split on `,`, trim each token with
 * `String.prototype.trim` — deliberately NOT an RFC-OWS `[ \t]` trim, so
 * exotic Unicode padding (NBSP and friends) cannot dodge the presence
 * profile — drop empty tokens, and require at least one remaining token
 * with every one exactly `2026-07-28`. Duplicated headers arrive
 * comma-joined, so an all-modern duplicate is still the modern claim while
 * a mixed duplicate is not.
 */
export function isModernProtocolClaim(rawValue: string | undefined): boolean {
  if (rawValue === undefined) return false
  const tokens = rawValue
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
  return tokens.length > 0 && tokens.every((token) => token === HELIO_MCP_MODERN_PROTOCOL_VERSION)
}
