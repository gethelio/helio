// ---------------------------------------------------------------------------
// Rule-discriminated bucket keys, shared by RateLimiter and SpendLimiter.
//
// Leaf module: both limiters and both doors (governed forwarder, sideband
// governance service) depend on it, so the key format cannot drift between
// them.
// ---------------------------------------------------------------------------

/**
 * Compose a limit bucket key discriminated by the matched rule's index.
 *
 * Two limit rules sharing a key scope (e.g. two session-keyed rate rules)
 * must not share a bucket: a shared bucket pools their counters under
 * whichever rule is checking and stores last-write-wins config. The suffix —
 * not a prefix — keeps the sideband's `sender:`-prefixed cardinality
 * accounting working. Both doors MUST build rate and spend keys through this
 * module's functions (`toolLimitKey` for the tool-scope base, this one for
 * the rule suffix): they feed the same limiter instances, so key-format
 * agreement is load-bearing (issue #14 groundwork).
 */
export function ruleBucketKey(baseKey: string, ruleIndex: number): string {
  return `${baseKey}:rule:${String(ruleIndex)}`
}

/** Matches the suffix appended by {@link ruleBucketKey}. */
const RULE_SUFFIX_RE = /:rule:(\d+)$/

/**
 * Parse the rule index out of a key built by {@link ruleBucketKey}.
 * Returns undefined for keys without the suffix.
 */
export function parseRuleIndex(key: string): number | undefined {
  const match = RULE_SUFFIX_RE.exec(key)
  return match ? Number(match[1]) : undefined
}

/**
 * Compose the tool-scope limit base key, partitioned by the configured
 * upstream name when one is set (issue #295): `upstream:<name>:tool:<tool>`.
 * With no name the output is byte-identical to today's `tool:<tool>` literal
 * (singular mode). Session keys deliberately never carry the prefix: session
 * identity is proxy-owned, and per-upstream session limits are expressed as
 * scoped rules discriminated by {@link ruleBucketKey}.
 */
export function toolLimitKey(toolName: string, upstreamName?: string): string {
  return upstreamName ? `upstream:${upstreamName}:tool:${toolName}` : `tool:${toolName}`
}
