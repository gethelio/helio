// ---------------------------------------------------------------------------
// Operator log tag, shared by every module that emits per-upstream `[helio]`
// lifecycle lines.
//
// Leaf module: the single format authority for the upstream qualifier
// (issue #295), so the tag cannot drift between the era, prime-loop, and
// future per-upstream lines.
// ---------------------------------------------------------------------------

/**
 * Compose the operator log tag: `[helio][<name>]` when an upstream name is
 * set, the plain `[helio]` otherwise. Every line keeps its universal
 * `[helio]` anchor (operators filter on it); the name reads as a qualifier
 * of that tag.
 */
export function helioLogTag(upstreamName?: string): string {
  return upstreamName ? `[helio][${upstreamName}]` : '[helio]'
}
