import { compileToolMatcher } from './parser.js'

// ---------------------------------------------------------------------------
// The exact-name rule text shared by the helio scan scaffold (issue #299) and
// policy generation (issue #522): how an upstream-chosen tool name becomes a
// match.tool pattern that names it and nothing else, the gate that says
// whether the policy compiler will carry that pattern, and the two rule
// shapes written from it.
// ---------------------------------------------------------------------------

/**
 * A scalar the upstream chose (a tool name, a dot-path), written as a JSON
 * string: a valid YAML double-quoted scalar on one line, whatever the value
 * carries (a newline, a quote, a `#`, YAML structure). Never interpolate an
 * upstream-controlled string into a template any other way.
 */
export function quoted(value: string): string {
  return JSON.stringify(value)
}

/** An upstream-chosen string inside a `#` comment: escaped so it stays on its line. */
export function commentSafe(value: string): string {
  return JSON.stringify(value).slice(1, -1)
}

/**
 * A tool name as a `match.tool` pattern. The policy compiles that field as a
 * picomatch glob, so every ASCII character outside `[A-Za-z0-9_]` is escaped
 * with a backslash, and a backslash itself is written as the bracket class
 * `[\\]`, the one form picomatch reads as a literal backslash. The pattern
 * then matches that one name and nothing else, whatever the upstream chose
 * (exact over every one- and two-character ASCII name).
 */
export function exactPattern(name: string): string {
  return name.replaceAll(/[^A-Za-z0-9_\u0080-￿]/g, (char) =>
    char === '\\' ? '[\\\\]' : `\\${char}`,
  )
}

/** The `match.tool` value for a tool name, as a one-line YAML scalar. */
export function globLiteral(name: string): string {
  return quoted(exactPattern(name))
}

/**
 * Whether the policy compiler will accept the exact pattern for this name
 * and evaluate it: the pattern is compiled with the compiler's own builder
 * and tested against the name here, because the glob engine refuses a
 * pattern above 65,536 characters at compile time and one at exactly that
 * length compiles and then throws when evaluated. An empty name has no
 * pattern at all.
 */
export function exactlyMatchable(name: string): boolean {
  if (name === '') return false
  try {
    const matcher = compileToolMatcher(exactPattern(name), 0)
    return matcher.test(name) && !matcher.test(`${name}_`)
  } catch {
    return false
  }
}

/** The comment written in place of a rule for a tool no pattern can name. */
export function unmatchableNote(name: string, prefix: string): string {
  if (name === '') {
    return `${prefix}# a tool with an empty name was skipped: match.tool cannot name it\n`
  }
  const excerpt = name.length > 60 ? `${name.slice(0, 60)}...` : name
  return (
    `${prefix}# ${commentSafe(excerpt)} (${String(name.length)} characters) cannot be named ` +
    `by a match.tool pattern: the glob engine refuses it; write its rule by hand\n`
  )
}

/**
 * The name of a generated rule: the action's prefix and the tool name with
 * every `$` written as `_`. The config loader interpolates `${IDENT}` in
 * every string it loads, the rule's name included, so a tool whose name is
 * shaped like a placeholder would make the written file fail to load when
 * the variable is unset and load under another name when it is set. The
 * `match.tool` beside it stays the exact tool name, escaped as a glob.
 */
export function ruleLabel(prefix: 'allow' | 'approve', name: string): string {
  return `${prefix}-${name.replaceAll('$', '_')}`
}

/** The door a generated rule is pinned to in multi-upstream mode (issue #522). */
export interface RuleScope {
  readonly upstream: string
}

function matchBlock(name: string, prefix: string, scope: RuleScope | undefined): string {
  return (
    `${prefix}  match:\n` +
    `${prefix}    tool: ${globLiteral(name)}\n` +
    (scope === undefined ? '' : `${prefix}    upstreams: [${quoted(scope.upstream)}]\n`)
  )
}

/** A `require_approval` rule on the exact name, routed to the dashboard channel. */
export function approvalRule(name: string, prefix: string, scope?: RuleScope): string {
  return (
    `${prefix}- name: ${quoted(ruleLabel('approve', name))}\n` +
    matchBlock(name, prefix, scope) +
    `${prefix}  action: require_approval\n` +
    `${prefix}  approval:\n` +
    `${prefix}    channel: dashboard\n`
  )
}

/** An `allow` rule on the exact name. */
export function allowRule(name: string, prefix: string, scope?: RuleScope): string {
  return (
    `${prefix}- name: ${quoted(ruleLabel('allow', name))}\n` +
    matchBlock(name, prefix, scope) +
    `${prefix}  action: allow\n`
  )
}
