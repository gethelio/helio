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
 * function: they feed the same limiter instances, so key-format agreement is
 * load-bearing (issue #14 groundwork).
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
