import { describe, it, expect } from 'vitest'
import { upstreamFromLimitKey } from './bucket-key.js'

describe('upstreamFromLimitKey (issue #292)', () => {
  it('parses the upstream name out of a partitioned tool key', () => {
    expect(upstreamFromLimitKey('upstream:github:tool:x:rule:0')).toBe('github')
  })

  it('returns null for every other key family', () => {
    // Singular tool keys, session keys, and sideband cardinality keys never
    // start with the `upstream:` prefix — only toolLimitKey WITH a name does.
    expect(upstreamFromLimitKey('tool:x:rule:0')).toBeNull()
    expect(upstreamFromLimitKey('session:abc:rule:1')).toBeNull()
    expect(upstreamFromLimitKey('sender:u1:tool:x')).toBeNull()
    // Client-influenced substrings only ever appear AFTER a fixed prefix: a
    // tool literally named `upstream:github:oddname` still parses to null.
    expect(upstreamFromLimitKey('tool:upstream:github:oddname')).toBeNull()
  })

  it('truncates a colon-bearing name at the first colon (embedder-facing)', () => {
    // Config names are charset-validated (#293), but
    // GovernedForwarderOptions.upstreamName is a public embedder surface and
    // deliberately stays an unconstrained string; this pins the parse
    // behavior for a name that embeds a colon rather than guessing rejection
    // semantics.
    expect(upstreamFromLimitKey('upstream:foo:bar:tool:x')).toBe('foo')
  })
})
