/**
 * Inbound header/body agreement validation (issue #226, MCP 2026-07-28).
 *
 * The spec makes header/body agreement a MUST for any server that processes
 * the request body: `Mcp-Method`, `Mcp-Name`, and the `MCP-Protocol-Version`
 * header (with its `params._meta` mirror) must match the body, else the
 * request is rejected. Helio's own policy engine never trusted these headers
 * (it evaluates the parsed body); this check is spec conformance plus
 * defense-in-depth for header-routing components in front of Helio.
 *
 * Two tiers, selected by the client's normalized version claim:
 *
 * - **Modern claim (`2026-07-28`):** requests get the full presence profile
 *   (`mcp-method` required, `mcp-name` required iff the body carries a
 *   string name-bearing field, `_meta` mirror required); notifications get
 *   agreement-if-present only, since the revision leaves notification-POST
 *   header requirements undefined.
 * - **Tier 2 (absent, legacy, unknown, malformed, or mixed claims):** no
 *   presence requirements; a present `mcp-method`/`mcp-name` must still
 *   agree with the body. The `_meta` mirror is NEVER examined: Helio's own
 *   legacy relay leg legitimately forwards a modern client's mirror verbatim
 *   under a `2025-06-18` stamp, and rejecting that shape would feed a
 *   relayed `-32020` into the upstream era falsification machinery of the
 *   Helio in front (see the #226 plan, R1 F1).
 *
 * Every rejection in the class uses -32020, including a MISSING `_meta`
 * mirror on a modern-claim request — a stated deviation from the spec,
 * whose own code for a missing required `_meta` field is -32602 (see the
 * `HEADER_MISMATCH` JSDoc in `mcp/types.ts` for why).
 *
 * Pure functions only — no Hono types; the streamable-http route owns the
 * HTTP surface (400 + JSON-RPC -32020) and the audit recorder.
 */

import {
  HELIO_MCP_MODERN_PROTOCOL_VERSION,
  isModernProtocolClaim,
} from '../mcp/protocol-version.js'
import { decodeSentinelValue, nameBearingField } from '../upstream/standard-headers.js'
import { MCP_META_PROTOCOL_VERSION_KEY } from '../upstream/upstream-session-manager.js'

/** Everything the agreement check reads, already extracted from the wire. */
export interface HeaderBodyAgreementInput {
  /** The body's JSON-RPC method. */
  readonly method: string
  /**
   * The envelope id as parsed — undefined means the id member was ABSENT.
   * Presence classification follows the route's notification predicate:
   * only an absent id is a notification; `id: null` is a request and gets
   * the full modern presence profile (the response SHAPE for `id: null` is
   * the route's separate concern).
   */
  readonly id?: string | number | null
  /** The body's params, verbatim as parsed from JSON. */
  readonly params?: unknown
  /** Raw inbound marker header values; undefined = header absent. */
  readonly headers: {
    readonly 'mcp-method'?: string
    readonly 'mcp-name'?: string
    readonly 'mcp-protocol-version'?: string
  }
}

/** Evidence a rejection carries for the audit record. */
export interface HeaderMismatchEvidence {
  /** The marker headers that were present, verbatim as received. */
  readonly headers: Readonly<Record<string, string>>
  /** The body's name-bearing string field, when the method defines one. */
  readonly bodyName?: string
}

export type HeaderBodyAgreementResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string; readonly evidence: HeaderMismatchEvidence }

/** Longest echoed value in a rejection reason; the audit record carries the full truth. */
const DISPLAY_CAP_CHARS = 256

function displayCap(value: string): string {
  if (value.length <= DISPLAY_CAP_CHARS) return value
  return `${value.slice(0, DISPLAY_CAP_CHARS)}… (truncated)`
}

/**
 * Read an own field off parsed-JSON data. Inbound params come from
 * JSON.parse, so `{"__proto__": ...}` is an own property and field names
 * come from Helio's own tables, never attacker input — a plain
 * object/non-array/own-field check is the whole job (the outbound
 * `extractName`'s toJSON resolution exists for live objects headed into
 * JSON.stringify and is deliberately not reused here).
 */
function readOwnField(source: unknown, field: string): unknown {
  if (typeof source !== 'object' || source === null || Array.isArray(source)) return undefined
  if (!Object.prototype.hasOwnProperty.call(source, field)) return undefined
  return (source as Record<string, unknown>)[field]
}

/**
 * Validate header/body agreement for one inbound streamable-http POST.
 * Returns `{ ok: true }` when the request passes, or the rejection reason
 * plus the evidence the audit record needs.
 */
export function validateHeaderBodyAgreement(
  input: HeaderBodyAgreementInput,
): HeaderBodyAgreementResult {
  const { method, params } = input
  const headerMethod = input.headers['mcp-method']
  const headerName = input.headers['mcp-name']
  const rawVersionClaim = input.headers['mcp-protocol-version']

  const modern = isModernProtocolClaim(rawVersionClaim)
  // The route's notification predicate: only an ABSENT id member is a
  // notification. An `id: null` envelope is a request — reusing the
  // response-shape "no usable id" grouping here would let a modern-claim
  // `id: null` call skip the required headers entirely.
  const isNotification = input.id === undefined
  const requiresPresence = modern && !isNotification

  const field = nameBearingField(method)
  const rawFieldValue = field === undefined ? undefined : readOwnField(params, field)
  const bodyName = typeof rawFieldValue === 'string' ? rawFieldValue : undefined

  const presentHeaders: Record<string, string> = {}
  if (headerMethod !== undefined) presentHeaders['mcp-method'] = headerMethod
  if (headerName !== undefined) presentHeaders['mcp-name'] = headerName
  if (rawVersionClaim !== undefined) presentHeaders['mcp-protocol-version'] = rawVersionClaim

  const reject = (reason: string): HeaderBodyAgreementResult => ({
    ok: false,
    reason,
    evidence: {
      headers: presentHeaders,
      ...(bodyName !== undefined && { bodyName }),
    },
  })

  if (headerMethod === undefined) {
    if (requiresPresence) {
      return reject(`missing mcp-method header (expected ${displayCap(method)})`)
    }
  } else if (headerMethod !== method) {
    return reject(
      `mismatched mcp-method header (expected ${displayCap(method)}, got ${displayCap(headerMethod)})`,
    )
  }

  // A present mcp-name is only ever compared against a string name-bearing
  // body field; otherwise it is IGNORED, never rejected — the spec's
  // validation failures are missing-required / value-mismatch /
  // invalid-characters, with no "unexpected header" clause. A nameless
  // tools/call therefore passes here and stays missing_tool_name's job.
  if (bodyName !== undefined) {
    if (headerName === undefined) {
      if (requiresPresence) {
        return reject(`missing mcp-name header (expected ${displayCap(bodyName)})`)
      }
    } else {
      const decoded = decodeSentinelValue(headerName)
      if (decoded !== bodyName) {
        return reject(
          `mismatched mcp-name header (expected ${displayCap(bodyName)}, got ${displayCap(decoded)})`,
        )
      }
    }
  }

  // The `_meta` mirror is examined ONLY under a modern claim (tier 2 never
  // looks — see the module docstring). The comparison target is the
  // CONSTANT, never the raw or comma-joined header value.
  if (modern) {
    const mirror = readOwnField(readOwnField(params, '_meta'), MCP_META_PROTOCOL_VERSION_KEY)
    if (mirror === undefined) {
      if (!isNotification) {
        return reject(
          `missing params._meta["${MCP_META_PROTOCOL_VERSION_KEY}"] mirror ` +
            `(expected ${HELIO_MCP_MODERN_PROTOCOL_VERSION})`,
        )
      }
    } else if (mirror !== HELIO_MCP_MODERN_PROTOCOL_VERSION) {
      // JSON.stringify is total here: the mirror came out of parsed JSON.
      const display = typeof mirror === 'string' ? mirror : JSON.stringify(mirror)
      return reject(
        `mismatched params._meta["${MCP_META_PROTOCOL_VERSION_KEY}"] mirror ` +
          `(expected ${HELIO_MCP_MODERN_PROTOCOL_VERSION}, got ${displayCap(display)})`,
      )
    }
  }

  return { ok: true }
}
