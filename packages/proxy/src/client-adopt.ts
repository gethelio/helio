// ---------------------------------------------------------------------------
// `helio init --client` (issue #398): adopt an existing MCP client
// configuration. Pure planning lives here; the CLI does the file I/O in the
// nine-step order the plan fixes (backups first, then the manifest, then the
// output, then the client files). Nothing here probes a server or spawns a
// child.
// ---------------------------------------------------------------------------

import { copyFile, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import yaml from 'js-yaml'

// ---------------------------------------------------------------------------
// Constants and types
// ---------------------------------------------------------------------------

/** The client formats day one adopts, decided by the path. */
export type ClientFormat = 'claude' | 'cursor' | 'vscode'

/** Suffix of the per-file backup that holds the original bytes. */
export const BACKUP_SUFFIX = '.helio-backup'
/** Suffix of the temp sibling every write goes through before `rename`. */
export const TEMP_SUFFIX = '.helio-tmp'
/** The manifest undo reads, written in the directory the command ran in. */
export const MANIFEST_FILE = '.helio-init-client.json'

/** The three project files, by fixed path under the working directory. */
export const PROJECT_CLIENT_FILES: ReadonlyArray<{
  readonly display: string
  readonly format: ClientFormat
}> = [
  { display: '.mcp.json', format: 'claude' },
  { display: '.cursor/mcp.json', format: 'cursor' },
  { display: '.vscode/mcp.json', format: 'vscode' },
]

/** A client file as read: where it is, how it is shown, which rules apply, its text. */
export interface ClientSource {
  readonly path: string
  readonly display: string
  readonly format: ClientFormat
  readonly text: string
}

/** What the rewrite must reproduce of the original file's formatting. */
export interface JsonStyle {
  /** `'\t'`, a run of spaces, or `''` for a file with no newline (compact). */
  readonly indent: string
  readonly eol: '\n' | '\r\n'
  readonly trailingNewline: boolean
}

export type ScanResult =
  | {
      readonly ok: true
      readonly value: unknown
      readonly comments: boolean
      readonly style: JsonStyle
    }
  | { readonly ok: false; readonly kind: 'bom' }
  | { readonly ok: false; readonly kind: 'parse'; readonly message: string }
  | { readonly ok: false; readonly kind: 'reorder'; readonly path: string }
  | { readonly ok: false; readonly kind: 'number'; readonly path: string; readonly token: string }

/** One adopted server, as it will be rendered into `upstreams:`. */
export interface AdoptedUpstream {
  readonly name: string
  /** The client key the name came from. */
  readonly key: string
  readonly transport: 'streamable-http' | 'sse' | 'stdio'
  readonly url?: string
  readonly command?: string
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  readonly headers?: Readonly<Record<string, string>>
}

/** A client file with its rewritten text. */
export interface RewrittenClientFile {
  readonly path: string
  readonly display: string
  readonly format: ClientFormat
  readonly text: string
  /** The client keys rewritten to a door, in file order. */
  readonly adopted: readonly string[]
  /** Lines that are true once this file has been rewritten (its comments were not kept). */
  readonly notes: readonly string[]
}

export interface AdoptOptions {
  readonly port: number
  readonly host: string
  /** The adopting shell's environment (the Claude Code rule reads it). */
  readonly env: Readonly<Record<string, string | undefined>>
  /** The working directory the command runs in. */
  readonly cwd: string
  readonly home: string
  readonly pathSeparator: string
  /** Pass the door-URL marker; never the manifest or backup markers. */
  readonly force: boolean
  /** The output file as the user names it (`helio.yaml` or the `-o` value), for the printed lines. */
  readonly outputName: string
}

export type AdoptPlan =
  | {
      readonly ok: true
      readonly entries: readonly AdoptedUpstream[]
      /** Every line about what was read and decided, in order: the Found block, then per-entry lines. */
      readonly lines: readonly string[]
      /** Lines that are true once the config has been written (what it now holds). */
      readonly outputLines: readonly string[]
      /** `${VAR}` names the loader will need, sorted, unique. */
      readonly variables: readonly string[]
      readonly files: readonly RewrittenClientFile[]
      readonly upstreamBlock: string
      /** A Claude Code project file (`.mcp.json`) was adopted: the approval step applies. */
      readonly claudeProjectFile: boolean
      /** A Claude Code user file (`.claude.json`) was adopted: no approval step. */
      readonly claudeUserFile: boolean
    }
  | { readonly ok: false; readonly error: string; readonly lines: readonly string[] }

/** The manifest shape. */
export interface Manifest {
  readonly version: 1
  readonly output: string
  readonly output_backup: string | null
  readonly clients: ReadonlyArray<{ readonly path: string; readonly backup: string }>
  readonly created_at: string
}

// ---------------------------------------------------------------------------
// The JSON scanner
// ---------------------------------------------------------------------------

/** Integer-index keys: canonical decimals in 0..4294967294, which JSON.parse hoists. */
function isIntegerIndexKey(key: string): boolean {
  if (!/^(0|[1-9][0-9]*)$/.test(key)) return false
  return Number(key) <= 4294967294
}

/** True when a round trip would change the token's value (a token check, never a digit count). */
function numericTokenChanges(token: string): boolean {
  const n = Number(token)
  if (!Number.isFinite(n)) return true
  if (Object.is(n, -0)) return true
  if (/^-?(0|[1-9][0-9]*)$/.test(token)) {
    return BigInt(token) !== BigInt(JSON.stringify(n))
  }
  return false
}

interface Frame {
  readonly kind: 'object' | 'array'
  readonly path: string
  readonly keys: string[]
  expectKey: boolean
  index: number
  currentKey: string | null
}

/**
 * Read a client file's text: strip `//` and `/* *\/` comments and trailing
 * commas outside strings, refuse a numeric token a round trip would change
 * and an object whose integer-index keys JSON.parse would hoist out of the
 * order the text has them, and detect the indent, line ending and trailing
 * newline the rewrite must reproduce.
 */
export function scanJsonText(text: string): ScanResult {
  if (text.startsWith('﻿')) return { ok: false, kind: 'bom' }
  let out = ''
  let comments = false
  const stack: Frame[] = []
  const pathOf = (): string => {
    const top = stack[stack.length - 1]
    if (!top) return '(top level)'
    const parent = top.path
    const leaf = top.kind === 'object' ? (top.currentKey ?? '') : String(top.index)
    return parent === '(top level)' ? leaf : `${parent}.${leaf}`
  }
  const checkOrder = (frame: Frame): string | null => {
    const indexKeys = frame.keys.filter(isIntegerIndexKey)
    for (let i = 0; i < indexKeys.length; i++) {
      const key = frame.keys[i]
      if (key !== indexKeys[i]) return frame.path
      if (i > 0 && Number(indexKeys[i - 1]) >= Number(indexKeys[i])) return frame.path
    }
    return null
  }
  let i = 0
  const n = text.length
  while (i < n) {
    const c = text[i] as string
    if (c === '"') {
      let j = i + 1
      let s = '"'
      while (j < n) {
        const d = text[j] as string
        s += d
        if (d === '\\') {
          s += text[j + 1] ?? ''
          j += 2
          continue
        }
        j += 1
        if (d === '"') break
      }
      const top = stack[stack.length - 1]
      if (top && top.kind === 'object' && top.expectKey) {
        let key: string
        try {
          key = JSON.parse(s) as string
        } catch {
          key = s
        }
        top.keys.push(key)
        top.currentKey = key
        top.expectKey = false
      }
      out += s
      i = j
      continue
    }
    if (c === '/' && text[i + 1] === '/') {
      comments = true
      while (i < n && text[i] !== '\n' && text[i] !== '\r') i += 1
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      comments = true
      const end = text.indexOf('*/', i + 2)
      if (end === -1) return { ok: false, kind: 'parse', message: 'unterminated block comment' }
      i = end + 2
      continue
    }
    if (c === '{' || c === '[') {
      stack.push({
        kind: c === '{' ? 'object' : 'array',
        path: pathOf(),
        keys: [],
        expectKey: c === '{',
        index: 0,
        currentKey: null,
      })
      out += c
      i += 1
      continue
    }
    if (c === '}' || c === ']') {
      // A trailing comma before the closer is dropped from the output.
      out = out.replace(/,(\s*)$/, '$1')
      const frame = stack.pop()
      if (frame && frame.kind === 'object') {
        const reordered = checkOrder(frame)
        if (reordered !== null) return { ok: false, kind: 'reorder', path: reordered }
      }
      out += c
      i += 1
      continue
    }
    if (c === ',') {
      const top = stack[stack.length - 1]
      if (top) {
        if (top.kind === 'object') top.expectKey = true
        else top.index += 1
      }
      out += c
      i += 1
      continue
    }
    if (c === '-' || (c >= '0' && c <= '9')) {
      const m = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(i))
      if (m && numericTokenChanges(m[0])) {
        return { ok: false, kind: 'number', path: pathOf(), token: m[0] }
      }
      const token = m ? m[0] : c
      out += token
      i += token.length
      continue
    }
    out += c
    i += 1
  }
  let value: unknown
  try {
    value = JSON.parse(out)
  } catch (err) {
    return { ok: false, kind: 'parse', message: err instanceof Error ? err.message : String(err) }
  }
  return { ok: true, value, comments, style: detectStyle(text) }
}

function detectStyle(text: string): JsonStyle {
  const eol: '\n' | '\r\n' = text.includes('\r\n') ? '\r\n' : '\n'
  const hasNewline = text.includes('\n')
  let indent = hasNewline ? '  ' : ''
  if (hasNewline) {
    const m = /(?:^|\n)([ \t]+)\S/.exec(text)
    if (m) indent = m[1]?.startsWith('\t') ? '\t' : (m[1] ?? '  ')
  }
  return { indent, eol, trailingNewline: text.endsWith('\n') }
}

/** `JSON.stringify` with the detected indent, line ending and trailing-newline state. */
export function serializeJson(value: unknown, style: JsonStyle): string {
  let text = style.indent === '' ? JSON.stringify(value) : JSON.stringify(value, null, style.indent)
  if (style.eol === '\r\n') text = text.replace(/\n/g, '\r\n')
  return style.trailingNewline ? text + style.eol : text
}

// ---------------------------------------------------------------------------
// Paths and detection
// ---------------------------------------------------------------------------

/** Decide a `--client <path>` format by its basename and parent, or refuse it. */
export function classifyClientPath(
  path: string,
):
  | { readonly ok: true; readonly format: ClientFormat }
  | { readonly ok: false; readonly kind: 'desktop' | 'unaccepted' } {
  if (path === '' || path === '-') return { ok: false, kind: 'unaccepted' }
  const base = basename(path)
  if (base === 'claude_desktop_config.json') return { ok: false, kind: 'desktop' }
  if (base === '.mcp.json' || base === '.claude.json') return { ok: true, format: 'claude' }
  if (base === 'mcp.json') {
    const parent = basename(dirname(path))
    if (parent === '.cursor') return { ok: true, format: 'cursor' }
    if (parent === '.vscode') return { ok: true, format: 'vscode' }
  }
  return { ok: false, kind: 'unaccepted' }
}

/** The project files that exist under `dir`, in the documented order. */
export function detectClientConfigs(
  dir: string,
): Array<{ readonly path: string; readonly display: string; readonly format: ClientFormat }> {
  const found: Array<{ path: string; display: string; format: ClientFormat }> = []
  for (const file of PROJECT_CLIENT_FILES) {
    const path = join(dir, ...file.display.split('/'))
    if (existsSync(path)) found.push({ path, display: file.display, format: file.format })
  }
  return found
}

// ---------------------------------------------------------------------------
// Parsing per format: the servers-in-.mcp.json exception, the both-keys rule
// ---------------------------------------------------------------------------

export type ParsedClientConfig =
  | {
      readonly ok: true
      readonly format: ClientFormat
      readonly doc: Record<string, unknown>
      readonly servers: Record<string, unknown>
      readonly serversKey: 'mcpServers' | 'servers'
      readonly droppedServers: boolean
      readonly comments: boolean
      readonly style: JsonStyle
    }
  | { readonly ok: false; readonly error: string }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const REWRITE_NUMBER_CASES =
  'an integer beyond 2^53 precision, a negative zero, or a non-finite value such as 1e309'

/** Read one client file: the scanner's refusals, then the top-level key rules. */
export function parseClientConfig(source: ClientSource): ParsedClientConfig {
  const scan = scanJsonText(source.text)
  if (!scan.ok) {
    if (scan.kind === 'bom') {
      return {
        ok: false,
        error: `Error: ${source.display} starts with a byte-order mark. Nothing changed.`,
      }
    }
    if (scan.kind === 'parse') {
      return {
        ok: false,
        error: `Error: ${source.display} is not JSON after comment removal: ${scan.message}. Nothing changed.`,
      }
    }
    if (scan.kind === 'reorder') {
      return {
        ok: false,
        error: `Error: ${source.display} would not survive a rewrite: ${scan.path} has integer-like keys out of JSON order. Edit it by hand. Nothing changed.`,
      }
    }
    return {
      ok: false,
      error: `Error: ${source.display} would not survive a rewrite: ${scan.path} holds a number a rewrite would change: ${REWRITE_NUMBER_CASES}. Edit it by hand. Nothing changed.`,
    }
  }
  const doc = scan.value
  const wrongShape = (expected: 'mcpServers' | 'servers'): ParsedClientConfig => ({
    ok: false,
    error: `Error: ${source.display} has no ${expected} object at the top level. Nothing changed.`,
  })
  if (!isPlainObject(doc)) return wrongShape(source.format === 'vscode' ? 'servers' : 'mcpServers')

  let format = source.format
  let serversKey: 'mcpServers' | 'servers' = format === 'vscode' ? 'servers' : 'mcpServers'
  let droppedServers = false
  if (format === 'claude' && basename(source.path) === '.mcp.json') {
    const hasMcp = isPlainObject(doc['mcpServers'])
    const hasServers = isPlainObject(doc['servers'])
    if (!hasMcp && hasServers) {
      format = 'vscode'
      serversKey = 'servers'
    } else if (hasMcp && hasServers) {
      droppedServers = true
    }
  }
  const servers = doc[serversKey]
  if (!isPlainObject(servers)) return wrongShape(serversKey)
  return {
    ok: true,
    format,
    doc,
    servers,
    serversKey,
    droppedServers,
    comments: scan.comments,
    style: scan.style,
  }
}

// ---------------------------------------------------------------------------
// The Claude Code substitution rule (the captured behavior of 2.1.278)
// ---------------------------------------------------------------------------

/** The five credential names Claude Code reads as empty on a remote url or headers string. */
const BLANKED = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
  'HTTPS_PROXY',
  'NPM_TOKEN',
])
/** The token as this client scans it: the default ends at the FIRST `}`. */
const TOKEN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g
const BARE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g
/** A name carried through the last pass for Helio's loader, marked (private-use U+E000) so a formed one is told apart. */
const SENT = /\uE000([A-Za-z_][A-Za-z0-9_]*)\uE000/g

/**
 * The `${env:...}` texts in a string, each shown to its balanced closing
 * brace so a nested token that was spliced in is quoted whole. Display only:
 * the rule itself never brace-matches.
 */
function envFormTokens(s: string): string[] {
  const out: string[] = []
  let at = s.indexOf('${env:')
  while (at !== -1) {
    let depth = 0
    let end = -1
    for (let i = at + 1; i < s.length; i++) {
      if (s[i] === '{') depth += 1
      else if (s[i] === '}') {
        depth -= 1
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    if (end === -1) break
    out.push(s.slice(at, end + 1))
    at = s.indexOf('${env:', end + 1)
  }
  return out
}

/** Which string of a Claude Code entry: two passes on a header, one on a url and on a stdio value. */
export type ClaudeStringKind = 'header' | 'url' | 'stdio'

export type StringAdoption =
  | { readonly outcome: 'adopted'; readonly value: string; readonly lines: readonly string[] }
  | { readonly outcome: 'refused'; readonly reason: string }
  | { readonly outcome: 'skipped'; readonly reason: string }

function fieldNoun(
  field: string,
  kind: ClaudeStringKind,
): { readonly noun: string; readonly fix: string } {
  const last = field.slice(field.lastIndexOf('.') + 1)
  if (kind === 'header') return { noun: `${last} header`, fix: 'header' }
  if (kind === 'url') return { noun: 'url', fix: 'url' }
  if (field.includes('.env.')) return { noun: `env value ${last}`, fix: 'env value' }
  return { noun: last, fix: last }
}

function userinfoFieldsOf(url: string): string | null {
  try {
    return userinfoFields(new URL(url))
  } catch {
    return null
  }
}

/**
 * Emulate what Claude Code 2.1.278 does to one string, and adopt the text
 * Helio must hold so that the wire value after the loader equals what that
 * client sends. The rule reproduces 85 arrivals captured from Claude Code 2.1.278
 * behind a listener; the unit test holds every one.
 */
export function adoptClaudeString(
  value: string,
  kind: ClaudeStringKind,
  env: Readonly<Record<string, string | undefined>>,
  field: string,
  outputName = 'helio.yaml',
): StringAdoption {
  const blank = kind !== 'stdio'
  const passes = kind === 'header' ? 2 : 1
  const lines: string[] = []
  const defaultsUsed: string[] = []
  const { noun, fix } = fieldNoun(field, kind)
  let cur = value
  for (let pass = 1; pass <= passes; pass++) {
    const last = pass === passes
    const next = cur.replace(TOKEN, (m: string, name: string, def: string | undefined) => {
      if (blank && BLANKED.has(name)) {
        lines.push(
          `Dropped ${m} from ${field}: Claude Code sends that name empty, and Helio would send your credential.`,
        )
        return ''
      }
      const v = env[name]
      if (v !== undefined) {
        if (v.includes('${')) {
          if (!last) {
            lines.push(
              `Spliced the value of ${m} into ${field} (it holds \${...}, which Claude Code's next pass scans)`,
            )
          }
          return v
        }
        return last ? `\uE000${name}\uE000` : `\${${name}}`
      }
      if (def === undefined) return last ? `\uE000${name}\uE000` : m
      defaultsUsed.push(name)
      return def
    })
    if (!last) {
      cur = next
      continue
    }
    if (kind === 'url') {
      const urlResult = adoptClaudeUrl(next, env, field, lines, defaultsUsed, outputName)
      if (urlResult !== null) return urlResult
    }
    const formed = [...next.matchAll(BARE)].map((x) => x[0])
    if (formed.length > 0) {
      return {
        outcome: 'refused',
        reason:
          `after Claude Code's expansion its ${noun} would still hold ${formed.join(', ')} as text ` +
          `(Claude Code sends those characters; Helio would substitute the variable at start, or refuse if it is unset). ` +
          `Fix the ${fix} by hand.`,
      }
    }
    cur = next.replace(SENT, (_m, name: string) => `\${${name}}`)
  }
  if (defaultsUsed.length > 0) lines.push(rewroteLine(field, cur, defaultsUsed))
  for (const m of envFormTokens(cur)) {
    const inner = [...m.matchAll(BARE)].map((x) => x[1] as string)
    const unset = inner.filter((n) => env[n] === undefined)
    const set = inner.filter((n) => env[n] !== undefined)
    const tokens = (names: readonly string[]): string => joinNames(names.map((n) => `\${${n}}`))
    lines.push(
      inner.length === 0
        ? `Kept "${m}" in ${field} as written: Claude Code sends those characters, and so will Helio.`
        : unset.length === 0
          ? `Kept "${m}" in ${field} as written: Claude Code sends that text with ${tokens(inner)} expanded, and so will Helio.`
          : `Kept "${m}" in ${field} as written: Claude Code sends that text with ${set.length > 0 ? `${tokens(set)} expanded and ` : ''}${tokens(unset)} left as ${unset.length === 1 ? 'it is' : 'they are'} (${joinNames(unset)} ${unset.length === 1 ? 'is' : 'are'} unset); Helio refuses to start until ${joinNames(unset)} ${unset.length === 1 ? 'is' : 'are'} set.`,
    )
  }
  if (kind === 'url' && /\$\{ANTHROPIC_BASE_URL\}/.test(cur)) {
    lines.push(
      `Kept \${ANTHROPIC_BASE_URL} in ${field}: Claude Code does not use the URL when that value carries a username and password; Helio will send it.`,
    )
  }
  return { outcome: 'adopted', value: cur, lines }
}

/** The fields a url's userinfo carries, for the printed sentences; null when it carries none. */
function userinfoFields(u: URL): string | null {
  if (u.username !== '' && u.password !== '') return 'a username and password'
  if (u.username !== '') return 'a username'
  if (u.password !== '') return 'a password'
  return null
}

/**
 * The character ranges of the username and the password in a raw url text:
 * the authority runs from `://` to the first `/`, `?` or `#`, the userinfo is
 * the authority up to its last `@`, and the first `:` splits the two fields.
 */
function userinfoRanges(
  text: string,
): { readonly username: [number, number]; readonly password: [number, number] | null } | null {
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.exec(text)
  if (!scheme) return null
  const start = scheme[0].length
  const stop = text.slice(start).search(/[/?#]/)
  const authority = stop === -1 ? text.slice(start) : text.slice(start, start + stop)
  const at = authority.lastIndexOf('@')
  if (at === -1) return null
  const colon = authority.slice(0, at).indexOf(':')
  if (colon === -1) return { username: [start, start + at], password: null }
  return { username: [start, start + colon], password: [start + colon + 1, start + at] }
}

/**
 * The text the URL parser parses, and a map from every index of the raw text
 * to its index there: the parser removes every tab, line feed and carriage
 * return, then strips leading and trailing C0 controls and spaces.
 */
function parserView(raw: string): { readonly text: string; readonly map: readonly number[] } {
  const kept: boolean[] = []
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    kept.push(ch !== '\t' && ch !== '\n' && ch !== '\r')
  }
  let first = 0
  while (first < raw.length && (!kept[first] || raw.charCodeAt(first) <= 0x20)) {
    kept[first] = false
    first += 1
  }
  let last = raw.length - 1
  while (last >= first && (!kept[last] || raw.charCodeAt(last) <= 0x20)) {
    kept[last] = false
    last -= 1
  }
  const map: number[] = []
  let text = ''
  for (let i = 0; i < raw.length; i++) {
    map.push(text.length)
    if (kept[i]) text += raw[i] as string
  }
  map.push(text.length)
  return { text, map }
}

/** True when the span [from, to) shares at least one character with the range. */
function overlaps(from: number, to: number, range: readonly [number, number] | null): boolean {
  return range !== null && Math.max(from, range[0]) < Math.min(to, range[1])
}

/** The default-used line, quoting the text the field holds after the last pass. */
function rewroteLine(field: string, finalText: string, defaultsUsed: readonly string[]): string {
  const names = [...new Set(defaultsUsed)]
  const who = names.length === 1 ? `${names[0] ?? ''} is unset` : `${joinNames(names)} are unset`
  return `Rewrote ${field} as "${finalText}" (${who}, so Claude Code uses its default)`
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1] ?? ''}`
}

/**
 * The url is judged as the client judges it, before the refusal check: a
 * carried name stands in as its value when set and as its placeholder text
 * when unset (what the client sends), then a blanked placeholder in the
 * host or an unparsable result skips (no request is made), and a pathname
 * beginning with `//` is written as the collapsed literal the client
 * requests. Returns null when the ordinary path continues.
 */
function adoptClaudeUrl(
  next: string,
  env: Readonly<Record<string, string | undefined>>,
  field: string,
  lines: string[],
  defaultsUsed: readonly string[],
  outputName: string,
): StringAdoption | null {
  // A carried provider name (sentinel) whose value carries a credential is
  // never requested; a FORMED one is sent as text and takes the refusal below.
  const abu = env['ANTHROPIC_BASE_URL']
  if (
    /\uE000ANTHROPIC_BASE_URL\uE000/.test(next) &&
    abu !== undefined &&
    /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(abu)
  ) {
    return {
      outcome: 'skipped',
      reason:
        'its url uses ${ANTHROPIC_BASE_URL}, whose value carries a username and password; Claude Code does not use that URL and does not connect.',
    }
  }
  // A carried name stands in as its value when set and as its placeholder when
  // unset; a token the pass formed stays as the text the client sends.
  // Each inlined value is recorded with the characters it occupies in the
  // assembled text, so that the credential question is answered by position.
  const inlined: Array<{ name: string; value: string; from: number; to: number }> = []
  let valued = ''
  let cursor = 0
  for (const m of next.matchAll(SENT)) {
    const n = m[1] as string
    valued += next.slice(cursor, m.index)
    const v = env[n]
    const text = v === undefined ? `\${${n}}` : v
    if (v !== undefined)
      inlined.push({ name: n, value: v, from: valued.length, to: valued.length + text.length })
    valued += text
    cursor = m.index + m[0].length
  }
  valued += next.slice(cursor)
  const shown = valued.replace(SENT, (_m, n: string) => `\${${n}}`)
  let u: URL
  try {
    u = new URL(valued)
  } catch {
    return {
      outcome: 'skipped',
      reason: `its url is not valid after Claude Code's expansion (${shown}); this client does not connect to it.`,
    }
  }
  // The parser lowercases the host, so the token is named from the string as written.
  const host = decodeURIComponent(u.hostname)
  if (host.includes('${')) {
    const named =
      [...valued.matchAll(BARE)].map((m) => m[0]).find((t) => host.includes(t.toLowerCase())) ??
      '${...}'
    return {
      outcome: 'skipped',
      reason: `its host would still hold ${named}; this client fails the lookup and does not connect.`,
    }
  }
  // A bare token the pass formed is sent as text: the caller refuses it.
  if (BARE.test(next)) {
    BARE.lastIndex = 0
    return null
  }
  if (/^\/\//.test(u.pathname)) {
    if (u.username !== '' || u.password !== '') {
      // An inlined value is blamed only when the characters it supplied sit
      // inside the username or the password of the assembled text; a host, a
      // delimiter or a path value that merely looks like the credential is not.
      const view = parserView(valued)
      const ranges = userinfoRanges(view.text)
      const seen = new Set<string>()
      const carriers = inlined.filter((i) => {
        const from = view.map[i.from] ?? 0
        const to = view.map[i.to] ?? 0
        const hit =
          ranges !== null &&
          (overlaps(from, to, ranges.username) || overlaps(from, to, ranges.password))
        if (!hit || seen.has(i.name)) return false
        seen.add(i.name)
        return true
      })
      const fields = userinfoFields(u) ?? 'a username and password'
      return {
        outcome: 'refused',
        reason:
          carriers.length > 0
            ? `its url needs the value${carriers.length === 1 ? '' : 's'} of ${joinNames(carriers.map((i) => `\${${i.name}}`))} written in (a leading // to collapse), and ${carriers.length === 1 ? 'that value carries' : 'those values carry'} ${fields}. Fix the url by hand.`
            : `its url already carries ${fields}, and Claude Code would collapse its leading //; writing that collapsed url into ${outputName} would copy the credential. Fix the url by hand.`,
      }
    }
    const collapsed = new URL(valued)
    collapsed.pathname = u.pathname.replace(/^\/{2,}/, '/')
    const original = u.pathname
    const how =
      inlined.length > 0
        ? `the value of ${inlined.map((i) => `\${${i.name}}`).join(', ')} inlined and the leading empty path segment collapsed`
        : 'the leading empty path segment collapsed'
    if (defaultsUsed.length > 0) lines.push(rewroteLine(field, collapsed.href, defaultsUsed))
    lines.push(
      `Wrote ${field} as ${collapsed.href} (${how}, as Claude Code requests it; Helio would otherwise send ${original})`,
    )
    return { outcome: 'adopted', value: collapsed.href, lines }
  }
  return null
}

// ---------------------------------------------------------------------------
// The Cursor and VS Code vocabulary
// ---------------------------------------------------------------------------

export interface VendorContext {
  /** The directory the client file was found in (`${workspaceFolder}`). */
  readonly dir: string
  readonly home: string
  readonly pathSeparator: string
}

const VENDOR_TOKEN = /\$\{([^}]*)\}/g

/** Rewrite the documented Cursor and VS Code tokens to Helio's `${VAR}` form or a literal. */
export function adoptVendorString(
  value: string,
  ctx: VendorContext,
  field: string,
): StringAdoption {
  const lines: string[] = []
  const found: { skip: string | null } = { skip: null }
  const out = value.replace(VENDOR_TOKEN, (m: string, inner: string) => {
    if (inner.startsWith('input:')) {
      found.skip = 'uses ${input:...}, a prompt Helio cannot answer'
      return m
    }
    let replacement: string | null = null
    if (inner.startsWith('env:')) replacement = `\${${inner.slice(4)}}`
    else if (inner === 'workspaceFolder') replacement = ctx.dir
    else if (inner === 'workspaceFolderBasename') replacement = basename(ctx.dir)
    else if (inner === 'userHome') replacement = ctx.home
    else if (inner === 'pathSeparator' || inner === '/') replacement = ctx.pathSeparator
    else if (/^[A-Za-z_][A-Za-z0-9_]*:-/.test(inner)) {
      lines.push(
        `Kept "${m}" in ${field} as written: neither Cursor nor VS Code documents a default, and Helio sends it as written.`,
      )
      return m
    }
    if (replacement === null) return m
    lines.push(`Rewrote "${m}" in ${field} as "${replacement}"`)
    return replacement
  })
  if (found.skip !== null) return { outcome: 'skipped', reason: found.skip }
  return { outcome: 'adopted', value: out, lines }
}

// ---------------------------------------------------------------------------
// Names and the credential net
// ---------------------------------------------------------------------------

const NAME_OK = /^[a-zA-Z0-9_-]{1,64}$/

/** The client key as an upstream name: runs of other characters become one `-`. */
export function sanitizeUpstreamName(key: string): string {
  if (NAME_OK.test(key)) return key
  return key
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

const CREDENTIAL_SEGMENTS = new Set([
  'password',
  'credential',
  'credentials',
  'secret',
  'token',
  'apikey',
])

/** The segment-based header-name net: never the letters `auth` or `key` alone. */
export function isCredentialHeaderName(name: string): boolean {
  const n = name.toLowerCase()
  if (n === 'authorization' || n === 'proxy-authorization' || n === 'cookie') return true
  const segs = n.split(/[-_]/)
  if (segs.some((s) => CREDENTIAL_SEGMENTS.has(s))) return true
  for (let i = 0; i + 1 < segs.length; i++)
    if (segs[i] === 'api' && segs[i + 1] === 'key') return true
  return false
}

/** The third idempotency marker: `http` on a loopback host, any port, path `/mcp/<name>`. */
function looksLikeHelioDoor(url: string, names: readonly string[]): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.protocol !== 'http:') return false
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) return false
  const path = u.pathname.replace(/\/$/, '')
  return names.some((n) => path === `/mcp/${n}`)
}

// ---------------------------------------------------------------------------
// adoptServers
// ---------------------------------------------------------------------------

type Transport = AdoptedUpstream['transport']

interface RawEntry {
  readonly key: string
  readonly file: ClientSource
  readonly value: Record<string, unknown>
  readonly seen: string
  readonly transport: Transport
}

/** Decide the transport of one entry, or the skip reason (the one case-sensitive `type` rule). */
function classifyEntry(
  value: Record<string, unknown>,
  format: ClientFormat,
): { readonly transport: Transport; readonly seen: string } | { readonly skip: string } {
  const url = value['url']
  const command = value['command']
  const type = value['type']
  if (typeof url === 'string') {
    if (value['headersHelper'] !== undefined) {
      return { skip: 'uses headersHelper, which Helio cannot run; it stays direct.' }
    }
    if (type === undefined) {
      // Claude Code skips this entry too (the vendor's own sentence); VS Code requires the type.
      if (format === 'claude') {
        return {
          skip: 'has a "url" but no "type"; add "type": "http" (or "sse" / "ws") to this entry.',
        }
      }
      if (format === 'vscode') {
        return {
          skip: 'has a "url" but no "type"; VS Code requires "type": "http" or "sse" on a remote entry.',
        }
      }
      return { transport: 'streamable-http', seen: 'http' }
    }
    if (type === 'http' || type === 'streamable-http')
      return { transport: 'streamable-http', seen: 'http' }
    if (type === 'sse') return { transport: 'sse', seen: 'sse' }
    return {
      skip: `type ${typeof type === 'string' ? `"${type}"` : JSON.stringify(type)} has no Helio transport; it stays direct.`,
    }
  }
  if (typeof command === 'string') return { transport: 'stdio', seen: 'stdio' }
  return { skip: 'has neither url nor command; it stays direct.' }
}

function sortedPairs(value: unknown): string {
  if (!isPlainObject(value)) return ''
  return JSON.stringify(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

/** Identical means the same transport, command, url, args in order, and env and headers as sorted pairs. */
function sameDefinition(a: RawEntry, b: RawEntry): boolean {
  return (
    a.transport === b.transport &&
    a.value['command'] === b.value['command'] &&
    a.value['url'] === b.value['url'] &&
    JSON.stringify(a.value['args'] ?? null) === JSON.stringify(b.value['args'] ?? null) &&
    sortedPairs(a.value['env']) === sortedPairs(b.value['env']) &&
    sortedPairs(a.value['headers']) === sortedPairs(b.value['headers'])
  )
}

function stringOf(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** The workspace a client file belongs to: the parent of a `.cursor` or `.vscode` directory, else the file's directory. */
function workspaceDir(path: string): string {
  const dir = dirname(path)
  const parent = basename(dir)
  return parent === '.cursor' || parent === '.vscode' ? dirname(dir) : dir
}

interface StringResult {
  readonly ok: boolean
  readonly value: string
  readonly refuse?: string
  readonly skip?: string
}

/** Compute the adoption plan for the parsed client files; nothing is written. */
export function adoptServers(sources: readonly ClientSource[], options: AdoptOptions): AdoptPlan {
  const lines: string[] = []
  const outputLines: string[] = []
  const refuse = (error: string): AdoptPlan => ({ ok: false, error, lines })
  const parsedFiles: Array<{
    source: ClientSource
    parsed: Extract<ParsedClientConfig, { ok: true }>
  }> = []
  for (const source of sources) {
    const parsed = parseClientConfig(source)
    if (!parsed.ok) return refuse(parsed.error)
    parsedFiles.push({ source, parsed })
  }

  // The Found block: every entry read, with the transport seen.
  const raw: RawEntry[] = []
  const skipped: Array<{ key: string; display: string; reason: string }> = []
  let total = 0
  const foundLines: string[] = []
  for (const { source, parsed } of parsedFiles) {
    const shown: string[] = []
    for (const [key, value] of Object.entries(parsed.servers)) {
      total += 1
      if (!isPlainObject(value)) {
        skipped.push({
          key,
          display: source.display,
          reason: 'is not an object; it stays as written.',
        })
        shown.push(`${key} (skipped)`)
        continue
      }
      const kind = classifyEntry(value, parsed.format)
      if ('skip' in kind) {
        skipped.push({ key, display: source.display, reason: kind.skip })
        shown.push(`${key} (skipped)`)
        continue
      }
      raw.push({
        key,
        file: { ...source, format: parsed.format },
        value,
        seen: kind.seen,
        transport: kind.transport,
      })
      shown.push(`${key} (${kind.seen})`)
    }
    foundLines.push(`  ${source.display}: ${shown.join(', ')}`)
  }
  lines.push(
    `Found ${String(total)} server${total === 1 ? '' : 's'} in ${String(parsedFiles.length)} client config${parsedFiles.length === 1 ? '' : 's'}:`,
    ...foundLines,
  )
  for (const s of skipped) lines.push(`Skipped "${s.key}" in ${s.display}: ${s.reason}`)
  for (const { source, parsed } of parsedFiles) {
    if (parsed.droppedServers) {
      lines.push(
        `Dropped the servers object in ${source.display}: the file also has mcpServers, so it was read as Claude Code's.`,
      )
    }
  }

  // Names, collisions and the merge.
  const byName = new Map<string, RawEntry[]>()
  const nameOf = new Map<RawEntry, string>()
  for (const entry of raw) {
    const name = sanitizeUpstreamName(entry.key)
    if (name === '') {
      return refuse(
        `Error: the name "${entry.key}" in ${entry.file.display} has no letters or digits to make an upstream name from. Rename it and rerun. Nothing changed.`,
      )
    }
    if (name !== entry.key && !byName.has(name)) {
      lines.push(
        `Renamed "${entry.key}" to "${name}" (upstream names allow letters, digits, _ and -)`,
      )
    }
    nameOf.set(entry, name)
    const group = byName.get(name) ?? []
    group.push(entry)
    byName.set(name, group)
  }
  const adopted: Array<{ name: string; first: RawEntry; all: RawEntry[] }> = []
  for (const [name, group] of byName) {
    const first = group[0] as RawEntry
    for (const other of group.slice(1)) {
      if (other.file.path === first.file.path) {
        return refuse(
          `Error: "${first.key}" and "${other.key}" in ${first.file.display} both become the upstream name "${name}". Rename one and rerun. Nothing changed.`,
        )
      }
      if (other.key !== first.key || !sameDefinition(first, other)) {
        return refuse(
          `Error: "${first.key}" is defined differently in ${first.file.display} and ${other.file.display}. Adopt one file: helio init --client ${first.file.display}`,
        )
      }
    }
    adopted.push({ name, first, all: group })
  }
  if (adopted.length === 0) {
    const where = parsedFiles.map((f) => f.source.display).join(', ')
    return refuse(
      `Error: no server in ${where} can be adopted (${String(skipped.length)} skipped, see above). Nothing changed.`,
    )
  }

  // The door marker.
  for (const { name, first } of adopted) {
    const url = stringOf(first.value['url'])
    if (url !== null && !options.force && looksLikeHelioDoor(url, [name, first.key])) {
      return refuse(
        `Error: "${first.key}" in ${first.file.display} already looks like a Helio door (${url}). Pass --force if it is not. Nothing changed.`,
      )
    }
  }

  // Substitutions and the entries.
  const entries: AdoptedUpstream[] = []
  const adoptedKeysByFile = new Map<string, string[]>()
  let claudeProjectFile = false
  let claudeUserFile = false
  const runString = (
    entry: RawEntry,
    value: string,
    kind: ClaudeStringKind,
    field: string,
  ): StringResult => {
    const claude = entry.file.format === 'claude'
    const result = claude
      ? adoptClaudeString(value, kind, options.env, field, options.outputName)
      : adoptVendorString(
          value,
          {
            dir: workspaceDir(entry.file.path),
            home: options.home,
            pathSeparator: options.pathSeparator,
          },
          field,
        )
    if (result.outcome === 'refused') {
      return {
        ok: false,
        value,
        refuse: `Error: "${entry.key}" in ${entry.file.display}: ${result.reason} Nothing changed.`,
      }
    }
    if (result.outcome === 'skipped') {
      const tail = result.reason.endsWith('.') ? '' : '; it stays direct.'
      return {
        ok: false,
        value,
        skip: `Skipped "${entry.key}" in ${entry.file.display}: ${result.reason}${tail}`,
      }
    }
    lines.push(...result.lines)
    return { ok: true, value: result.value }
  }
  for (const { name, first, all } of adopted) {
    const entry = first
    const isClaude = entry.file.format === 'claude'
    const state: { skip: string | null } = { skip: null }
    const fail = (r: StringResult): string | null => {
      if (r.refuse !== undefined) return r.refuse
      state.skip = r.skip ?? null
      return null
    }
    const built: {
      url?: string
      command?: string
      args?: string[]
      env?: Record<string, string>
      headers?: Record<string, string>
    } = {}
    if (entry.transport === 'stdio') {
      const command = stringOf(entry.value['command']) ?? ''
      const r = runString(entry, command, 'stdio', `${name}.command`)
      if (!r.ok) {
        const e = fail(r)
        if (e !== null) return refuse(e)
      } else built.command = r.value
      const rawArgs = entry.value['args']
      if (Array.isArray(rawArgs) && state.skip === null) {
        const args: string[] = []
        for (const [i, a] of rawArgs.entries()) {
          const r2 = runString(entry, String(a), 'stdio', `${name}.args[${String(i)}]`)
          if (!r2.ok) {
            const e = fail(r2)
            if (e !== null) return refuse(e)
            break
          }
          args.push(r2.value)
        }
        built.args = args
      }
      const rawEnv = entry.value['env']
      const env: Record<string, string> = {}
      const copied: string[] = []
      if (isPlainObject(rawEnv) && state.skip === null) {
        for (const [k, v] of Object.entries(rawEnv)) {
          if (v === null) {
            lines.push(`Skipped env key ${k} for ${name}: its value is null`)
            continue
          }
          if (typeof v === 'number') {
            env[k] = String(v)
            copied.push(k)
            continue
          }
          if (typeof v !== 'string') {
            lines.push(`Skipped env key ${k} for ${name}: its value is a ${typeof v}`)
            continue
          }
          const r3 = runString(entry, v, 'stdio', `${name}.env.${k}`)
          if (!r3.ok) {
            const e = fail(r3)
            if (e !== null) return refuse(e)
            break
          }
          env[k] = r3.value
          copied.push(k)
        }
      }
      if (state.skip === null) {
        if (copied.length > 0) {
          outputLines.push(
            `Copied env for ${name} into ${options.outputName} (${copied.join(', ')}); the file now holds those values`,
          )
        }
        if (isClaude && env['CLAUDE_PROJECT_DIR'] === undefined) {
          const projectDir =
            basename(entry.file.path) === '.claude.json' ? options.cwd : dirname(entry.file.path)
          env['CLAUDE_PROJECT_DIR'] = projectDir
          outputLines.push(
            `Set CLAUDE_PROJECT_DIR=${projectDir} for ${name} in ${options.outputName} (Claude Code sets it for stdio servers; update it if the project moves)`,
          )
        }
        if (Object.keys(env).length > 0) built.env = env
      }
      for (const key of ['cwd', 'envFile'] as const) {
        if (entry.value[key] !== undefined) {
          lines.push(
            key === 'cwd'
              ? `Skipped cwd for ${name} in ${entry.file.display}: Helio has no cwd field; the child inherits the proxy's working directory.`
              : `Skipped envFile for ${name} in ${entry.file.display}: Helio has no envFile field; set the variables in env or in the proxy's environment.`,
          )
        }
      }
    } else {
      const url = stringOf(entry.value['url']) ?? ''
      const r = runString(entry, url, 'url', `${name}.url`)
      if (!r.ok) {
        const e = fail(r)
        if (e !== null) return refuse(e)
      } else built.url = r.value
      const rawHeaders = entry.value['headers']
      if (isPlainObject(rawHeaders) && state.skip === null) {
        const headers: Record<string, string> = {}
        let complete = true
        for (const [h, v] of Object.entries(rawHeaders)) {
          const r2 = runString(entry, String(v), 'header', `${name}.headers.${h}`)
          if (!r2.ok) {
            const e = fail(r2)
            if (e !== null) return refuse(e)
            complete = false
            break
          }
          headers[h] = r2.value
        }
        if (complete) built.headers = headers
      }
    }
    if (state.skip !== null) {
      lines.push(state.skip)
      continue
    }
    // The copied-credential pass, format independent.
    const copiedFields = built.url === undefined ? null : userinfoFieldsOf(built.url)
    if (copiedFields !== null) {
      outputLines.push(
        `Kept ${name}.url as written: it carries ${copiedFields} in ${entry.file.display}; ${copiedFields === 'a username and password' ? 'they are' : 'it is'} now in ${options.outputName} too.`,
      )
    }
    // The value judged is the client file's own text: a reference that was
    // blanked or rewritten was never a literal credential there.
    const sourceHeaders = isPlainObject(entry.value['headers']) ? entry.value['headers'] : {}
    for (const h of Object.keys(built.headers ?? {})) {
      const v = String(sourceHeaders[h])
      if (isCredentialHeaderName(h) && !v.includes('${')) {
        outputLines.push(
          `Kept ${name}.headers.${h} as written: its value is a credential in ${entry.file.display}; it is now in ${options.outputName} too.`,
        )
      }
    }
    entries.push({ name, key: entry.key, transport: entry.transport, ...built })
    for (const e of all) {
      const keys = adoptedKeysByFile.get(e.file.path) ?? []
      keys.push(e.key)
      adoptedKeysByFile.set(e.file.path, keys)
      if (e.file.format === 'claude') {
        if (basename(e.file.path) === '.claude.json') claudeUserFile = true
        else claudeProjectFile = true
      }
    }
  }
  if (entries.length === 0) {
    const where = parsedFiles.map((f) => f.source.display).join(', ')
    return refuse(
      `Error: no server in ${where} can be adopted (${String(skipped.length + adopted.length)} skipped, see above). Nothing changed.`,
    )
  }

  // The rewritten files.
  const files: RewrittenClientFile[] = []
  for (const { source, parsed } of parsedFiles) {
    const keys = adoptedKeysByFile.get(source.path) ?? []
    // A file none of whose entries were adopted is not changed, so it is not
    // backed up, listed in the manifest, or rewritten.
    if (keys.length === 0) continue
    const servers = parsed.servers
    for (const key of keys) {
      const name = entries.find((e) => e.key === key)?.name ?? sanitizeUpstreamName(key)
      const door = `http://${options.host}:${String(options.port)}/mcp/${name}`
      servers[key] = parsed.format === 'cursor' ? { url: door } : { type: 'http', url: door }
    }
    const notes = parsed.comments
      ? [`Comments in ${source.display} were not kept (the backup has them).`]
      : []
    if (basename(source.path) === '.claude.json') {
      const count = Object.keys(servers).length
      if (count < 2) {
        lines.push(
          `Warning: ${source.display} holds ${String(count)} server${count === 1 ? '' : 's'} under mcpServers (per-project servers under projects.<dir>.mcpServers were not counted or adopted). Claude Code plugins and claude.ai connectors are not in this file and cannot be routed through Helio.`,
        )
      }
    }
    files.push({
      path: source.path,
      display: source.display,
      format: parsed.format,
      text: serializeJson(parsed.doc, parsed.style),
      adopted: keys,
      notes,
    })
  }

  return {
    ok: true,
    entries,
    lines,
    outputLines,
    variables: collectVariables(entries),
    files,
    upstreamBlock: renderUpstreamBlock(entries),
    claudeProjectFile,
    claudeUserFile,
  }
}

// ---------------------------------------------------------------------------
// The upstream block and the variables
// ---------------------------------------------------------------------------

/** Every `${VAR}` name in every string of the entries, sorted and unique. */
export function collectVariables(entries: readonly AdoptedUpstream[]): string[] {
  const names = new Set<string>()
  const scan = (s: string): void => {
    for (const m of s.matchAll(BARE)) names.add(m[1] as string)
  }
  for (const e of entries) {
    if (e.url !== undefined) scan(e.url)
    if (e.command !== undefined) scan(e.command)
    for (const a of e.args ?? []) scan(a)
    for (const v of Object.values(e.env ?? {})) scan(v)
    for (const v of Object.values(e.headers ?? {})) scan(v)
  }
  return [...names].sort()
}

/** The `upstreams:` list through js-yaml, double-quoted and unwrapped, one entry per server. */
export function renderUpstreamBlock(entries: readonly AdoptedUpstream[]): string {
  const upstreams = entries.map((e) => {
    const out: Record<string, unknown> = { name: e.name, transport: e.transport }
    if (e.url !== undefined) out['url'] = e.url
    if (e.command !== undefined) out['command'] = e.command
    if (e.args !== undefined) out['args'] = [...e.args]
    if (e.env !== undefined) out['env'] = { ...e.env }
    if (e.headers !== undefined) out['headers'] = { ...e.headers }
    return out
  })
  return yaml.dump(
    { upstreams },
    { quotingType: '"', forceQuotes: true, lineWidth: -1, noRefs: true },
  )
}

// ---------------------------------------------------------------------------
// Manifest, atomic writes, backups and restore
// ---------------------------------------------------------------------------

/** Write through a temp sibling and `rename`; on failure the temp is unlinked before the error propagates. */
export async function writeFileAtomic(path: string, data: string | Buffer): Promise<void> {
  const temp = path + TEMP_SUFFIX
  try {
    await writeFile(temp, data)
    await rename(temp, path)
  } catch (err) {
    try {
      await unlink(temp)
    } catch {
      // The caller names a surviving temp when this fails too.
    }
    throw err
  }
}

/** Copy the original bytes of `path` to its backup sibling. */
export async function backupFile(path: string): Promise<string> {
  const backup = path + BACKUP_SUFFIX
  await copyFile(path, backup)
  return backup
}

export async function writeManifest(path: string, manifest: Manifest): Promise<void> {
  await writeFileAtomic(path, JSON.stringify(manifest, null, 2) + '\n')
}

/** The manifest at `path`, null when absent; throws when the file is not a version-1 manifest. */
export async function readManifest(path: string): Promise<Manifest | null> {
  let text: string
  try {
    text = await readFile(path, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`${path} is not a manifest this version reads`)
  }
  if (
    !isPlainObject(parsed) ||
    parsed['version'] !== 1 ||
    typeof parsed['output'] !== 'string' ||
    !(parsed['output_backup'] === null || typeof parsed['output_backup'] === 'string') ||
    !Array.isArray(parsed['clients']) ||
    !parsed['clients'].every(
      (c: unknown) =>
        isPlainObject(c) && typeof c['path'] === 'string' && typeof c['backup'] === 'string',
    ) ||
    typeof parsed['created_at'] !== 'string'
  ) {
    throw new Error(`${path} is not a manifest this version reads`)
  }
  return parsed as unknown as Manifest
}

/**
 * Restore each backup that exists: its bytes written back at the path
 * through a temp sibling and `rename`, then the backup removed. A missing
 * backup is skipped; the caller reports what was restored.
 */
export async function restoreBackups(
  items: ReadonlyArray<{ readonly path: string; readonly backup: string }>,
): Promise<Array<{ readonly path: string; readonly backup: string; readonly bytes: number }>> {
  const restored: Array<{ path: string; backup: string; bytes: number }> = []
  for (const item of items) {
    let bytes: Buffer
    try {
      bytes = await readFile(item.backup)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw err
    }
    await writeFileAtomic(item.path, bytes)
    await unlink(item.backup)
    restored.push({ path: item.path, backup: item.backup, bytes: bytes.length })
  }
  return restored
}

/** Size of a file in bytes, or null when it does not exist. */
export async function fileSize(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size
  } catch {
    return null
  }
}
