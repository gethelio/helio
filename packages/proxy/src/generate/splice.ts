import { isDeepStrictEqual } from 'node:util'
import yaml from 'js-yaml'

// ---------------------------------------------------------------------------
// The text-level section splice (issue #522): append generated rules to the
// `policies.rules` block sequence of a config file's RAW text, copying every
// other byte through. The loader interpolates `${VAR}` at load and drops
// comments, so the parsed object is never re-serialized: the raw text is the
// only copy of the operator's bytes. Pure: no I/O.
// ---------------------------------------------------------------------------

/** Why a splice wrote nothing. Every reason is a shape the line model will not touch. */
export type SpliceRefusal =
  | 'line_endings_unsupported'
  | 'yaml_unparsable'
  | 'root_not_mapping'
  | 'multiple_documents'
  | 'policies_key_unlocatable'
  | 'policies_not_block_mapping'
  | 'rules_not_block_sequence'
  | 'merge_key_in_policies'
  | 'anchor_used_outside_policies'
  | 'splice_unverified'

export type SpliceResult = { readonly text: string } | { readonly refused: SpliceRefusal }

/** A root section's span: the key line through the last line of its value, as line indices and character offsets. */
export interface RootSection {
  /** Index of the `key:` line. */
  readonly keyLine: number
  /** Exclusive index of the first line after the section (the next key's preamble starts there). */
  readonly endLine: number
  /** Character offset of the key line's start. */
  readonly start: number
  /** Character offset where the section ends (exclusive). */
  readonly end: number
}

/** The root keys a missing `policies:` block is inserted ahead of, in the canonical section order. */
const LATER_ROOT_KEYS = ['budgets', 'approval', 'audit', 'dashboard', 'sdk'] as const

const ROOT_KEY = /^([A-Za-z_][A-Za-z0-9_-]*):(?:\s|$)/
const BOM = '\uFEFF'

// ---------------------------------------------------------------------------
// The line model
// ---------------------------------------------------------------------------

interface LineModel {
  /** Lines without their EOL; a CRLF file's lines keep no `\r`. */
  readonly lines: readonly string[]
  readonly eol: '\n' | '\r\n'
  readonly bom: boolean
}

function splitLines(raw: string): LineModel | null {
  if (/\r(?!\n)/.test(raw)) return null
  const bom = raw.startsWith(BOM)
  const body = bom ? raw.slice(BOM.length) : raw
  const eol = body.includes('\r\n') ? '\r\n' : '\n'
  return { lines: body.split(eol), eol, bom }
}

function joinLines(model: LineModel, lines: readonly string[]): string {
  return `${model.bom ? BOM : ''}${lines.join(model.eol)}`
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

function isBlankOrComment(line: string): boolean {
  const trimmed = line.trim()
  return trimmed === '' || trimmed.startsWith('#')
}

function isMarkerOrDirective(line: string): boolean {
  return line === '---' || line.startsWith('--- ') || line === '...' || line.startsWith('%')
}

function rootKeyOf(line: string): string | null {
  return ROOT_KEY.exec(line)?.[1] ?? null
}

function rootKeyLines(lines: readonly string[]): ReadonlyArray<{ key: string; line: number }> {
  const found: Array<{ key: string; line: number }> = []
  for (const [i, line] of lines.entries()) {
    const key = rootKeyOf(line)
    if (key !== null) found.push({ key, line: i })
  }
  return found
}

/** The first line of the blank-and-comment preamble that directly precedes `line`. */
function preambleStart(lines: readonly string[], line: number): number {
  let start = line
  while (start > 0 && isBlankOrComment(lines[start - 1] ?? '')) start -= 1
  return start
}

function offsetOfLine(model: LineModel, line: number): number {
  let offset = model.bom ? BOM.length : 0
  for (let i = 0; i < line; i++) offset += (model.lines[i] ?? '').length + model.eol.length
  return offset
}

function sectionOf(model: LineModel, keyLine: number): RootSection {
  const keys = rootKeyLines(model.lines)
  const next = keys.find((k) => k.line > keyLine)
  const endLine = next === undefined ? model.lines.length : preambleStart(model.lines, next.line)
  const end =
    next === undefined ? joinLines(model, model.lines).length : offsetOfLine(model, endLine)
  return { keyLine, endLine, start: offsetOfLine(model, keyLine), end }
}

/**
 * Locate a root section by its column-0 key line: the span runs from the
 * key line to the last line before the next root key, excluding the blank
 * and comment lines that directly precede that next key (they describe what
 * follows). Null when no line is that key.
 */
export function locateRootSection(raw: string, key: string): RootSection | null {
  const model = splitLines(raw)
  if (model === null) return null
  const found = rootKeyLines(model.lines).find((k) => k.key === key)
  return found === undefined ? null : sectionOf(model, found.line)
}

// ---------------------------------------------------------------------------
// Anchors, aliases and merge keys (text reads; the self-check is the backstop)
// ---------------------------------------------------------------------------

function stripComment(line: string): string {
  const at = line.search(/(^|\s)#/)
  return at === -1 ? line : line.slice(0, at)
}

function anchorsIn(lines: readonly string[]): ReadonlySet<string> {
  const names = new Set<string>()
  for (const line of lines) {
    for (const m of stripComment(line).matchAll(/(?:^|[\s:-])&([^\s,[\]{}]+)/g)) {
      if (m[1] !== undefined) names.add(m[1])
    }
  }
  return names
}

function aliasesIn(lines: readonly string[]): ReadonlySet<string> {
  const names = new Set<string>()
  for (const line of lines) {
    for (const m of stripComment(line).matchAll(/(?:^|[\s:-])\*([^\s,[\]{}]+)/g)) {
      if (m[1] !== undefined) names.add(m[1])
    }
  }
  return names
}

// ---------------------------------------------------------------------------
// The splice
// ---------------------------------------------------------------------------

function indentFragment(fragment: string, indent: number): readonly string[] {
  const pad = ' '.repeat(indent)
  const lines = fragment.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines.map((line) => (line === '' ? '' : `${pad}${line}`))
}

function isSecondDocument(lines: readonly string[]): boolean {
  let content = false
  for (const line of lines) {
    if (line === '---' || line.startsWith('--- ')) {
      if (content) return true
      continue
    }
    if (!isBlankOrComment(line) && !isMarkerOrDirective(line)) content = true
  }
  return false
}

/**
 * Append generated rules (the rule text with no indentation, as the rule
 * renderers write it with an empty prefix) to the `policies.rules` block
 * sequence of `raw`, copying every other byte through: comments, blank lines,
 * `${VAR}` placeholders, the line ending and a byte-order mark. The output
 * is loaded back and compared with the source before it is returned.
 */
export function appendRules(raw: string, rules: string): SpliceResult {
  const model = splitLines(raw)
  if (model === null) return { refused: 'line_endings_unsupported' }
  if (isSecondDocument(model.lines)) return { refused: 'multiple_documents' }
  let parsed: unknown
  try {
    parsed = yaml.load(model.bom ? raw.slice(BOM.length) : raw)
  } catch {
    return { refused: 'yaml_unparsable' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { refused: 'root_not_mapping' }
  }
  const root = parsed as Record<string, unknown>
  const keys = rootKeyLines(model.lines)
  const policiesKey = keys.find((k) => k.key === 'policies')

  const spliced =
    policiesKey === undefined
      ? 'policies' in root
        ? { refused: 'policies_key_unlocatable' as const }
        : insertPoliciesBlock(model, keys, rules)
      : appendInsideSection(model, policiesKey.line, root['policies'], rules)
  if ('refused' in spliced) return spliced
  const text = joinLines(model, spliced.lines)
  return verifySplice(raw, text, rules) ? { text } : { refused: 'splice_unverified' }
}

function insertPoliciesBlock(
  model: LineModel,
  keys: ReadonlyArray<{ key: string; line: number }>,
  rules: string,
): { lines: string[] } {
  const block = ['', 'policies:', '  rules:', ...indentFragment(rules, 4)]
  const later = keys.find((k) => (LATER_ROOT_KEYS as readonly string[]).includes(k.key))
  const lines = [...model.lines]
  if (later === undefined) {
    // At the end: after the last content line, keeping the file's trailing newline as it was.
    let last = lines.length - 1
    while (last >= 0 && (lines[last] ?? '').trim() === '') last -= 1
    lines.splice(last + 1, 0, ...block)
    return { lines }
  }
  lines.splice(preambleStart(lines, later.line), 0, ...block)
  return { lines }
}

function appendInsideSection(
  model: LineModel,
  keyLine: number,
  policies: unknown,
  rules: string,
): { lines: string[] } | { refused: SpliceRefusal } {
  const section = sectionOf(model, keyLine)
  const lines = [...model.lines]
  const keyRest = stripComment((lines[keyLine] ?? '').replace(ROOT_KEY, '')).trim()
  if (
    keyRest !== '' ||
    typeof policies !== 'object' ||
    policies === null ||
    Array.isArray(policies)
  ) {
    return { refused: 'policies_not_block_mapping' }
  }
  const span = lines.slice(keyLine + 1, section.endLine)
  if (span.some((line) => /^\s*<<\s*:/.test(stripComment(line)))) {
    return { refused: 'merge_key_in_policies' }
  }
  const outside = [...lines.slice(0, keyLine), ...lines.slice(section.endLine)]
  const inside = anchorsIn(span)
  for (const alias of aliasesIn(outside)) {
    if (inside.has(alias)) return { refused: 'anchor_used_outside_policies' }
  }
  // The child indentation: the first content line under the key.
  const firstChild = span.findIndex((line) => !isBlankOrComment(line))
  if (firstChild === -1) return { refused: 'policies_not_block_mapping' }
  const childIndent = indentOf(span[firstChild] ?? '')
  const lastContent = (): number => {
    let i = section.endLine - 1
    while (i > keyLine && isBlankOrComment(lines[i] ?? '')) i -= 1
    return i
  }
  const rulesAt = span.findIndex(
    (line) => indentOf(line) === childIndent && /^rules:(?:\s|$)/.test(line.trimStart()),
  )
  if (rulesAt === -1) {
    const at = lastContent()
    lines.splice(
      at + 1,
      0,
      `${' '.repeat(childIndent)}rules:`,
      ...indentFragment(rules, childIndent + 2),
    )
    return { lines }
  }
  const rulesLine = keyLine + 1 + rulesAt
  const rulesText = lines[rulesLine] ?? ''
  const afterKey = rulesText.trimStart().slice('rules:'.length)
  const value = stripComment(afterKey).trim()
  if (value === '[]') {
    const comment = afterKey.slice(afterKey.indexOf(value) + value.length)
    lines[rulesLine] = `${' '.repeat(childIndent)}rules:${comment.trimEnd()}`
    lines.splice(rulesLine + 1, 0, ...indentFragment(rules, childIndent + 2))
    return { lines }
  }
  if (value !== '') return { refused: 'rules_not_block_sequence' }
  // The items: `- ` lines at the first item's indentation; the sequence ends at the first later
  // content line that is shallower, or as shallow and not an item.
  let first = rulesLine + 1
  while (first < section.endLine && isBlankOrComment(lines[first] ?? '')) first += 1
  const firstLine = lines[first] ?? ''
  const itemIndent = indentOf(firstLine)
  if (
    first >= section.endLine ||
    itemIndent < childIndent ||
    !firstLine.trimStart().startsWith('- ')
  ) {
    if (first < section.endLine && itemIndent > childIndent) {
      return { refused: 'rules_not_block_sequence' }
    }
    // `rules:` with no items: the appended items are the whole sequence.
    lines.splice(rulesLine + 1, 0, ...indentFragment(rules, childIndent + 2))
    return { lines }
  }
  let end = first + 1
  while (end < section.endLine) {
    const line = lines[end] ?? ''
    if (!isBlankOrComment(line)) {
      const indent = indentOf(line)
      if (indent < itemIndent || (indent === itemIndent && !line.trimStart().startsWith('- ')))
        break
    }
    end += 1
  }
  let last = end - 1
  while (last > first && isBlankOrComment(lines[last] ?? '')) last -= 1
  lines.splice(last + 1, 0, ...indentFragment(rules, itemIndent))
  return { lines }
}

// ---------------------------------------------------------------------------
// The self-check
// ---------------------------------------------------------------------------

function loadRoot(text: string): Record<string, unknown> | null {
  try {
    const parsed = yaml.load(text.startsWith(BOM) ? text.slice(BOM.length) : text)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function asMapping(value: unknown): Record<string, unknown> | null {
  if (value === undefined || value === null) return {}
  return typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asList(value: unknown): readonly unknown[] | null {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : null
}

/**
 * Load the candidate and the source without interpolation or validation
 * and compare them: the same root keys in the same order (`policies` added
 * where it was missing), every other root value deep-equal, `policies`
 * deep-equal but for `rules`, and `rules` equal to the source's list (a
 * missing list is empty) followed by exactly the appended items, read from
 * the fragment on its own. A `${VAR}` placeholder compares as the literal it
 * is; no secret is read.
 */
export function verifySplice(source: string, candidate: string, fragment: string): boolean {
  const before = loadRoot(source)
  const after = loadRoot(candidate)
  const appended = asList(yaml.load(fragment))
  if (before === null || after === null || appended === null) return false
  const beforeKeys = Object.keys(before)
  const afterKeys = Object.keys(after).filter((key) => key !== 'policies' || key in before)
  if (!isDeepStrictEqual(beforeKeys, afterKeys)) return false
  if (!('policies' in after)) return false
  for (const key of beforeKeys) {
    if (key === 'policies') continue
    if (!isDeepStrictEqual(before[key], after[key])) return false
  }
  const policiesBefore = asMapping(before['policies'])
  const policiesAfter = asMapping(after['policies'])
  if (policiesBefore === null || policiesAfter === null) return false
  const { rules: rulesBefore, ...restBefore } = policiesBefore
  const { rules: rulesAfter, ...restAfter } = policiesAfter
  if (!isDeepStrictEqual(restBefore, restAfter)) return false
  const listBefore = asList(rulesBefore)
  const listAfter = asList(rulesAfter)
  if (listBefore === null || listAfter === null) return false
  return isDeepStrictEqual(listAfter, [...listBefore, ...appended])
}
