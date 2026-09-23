import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import yaml from 'js-yaml'
import {
  BACKUP_SUFFIX,
  MANIFEST_FILE,
  TEMP_SUFFIX,
  adoptClaudeString,
  adoptServers,
  adoptVendorString,
  classifyClientPath,
  detectClientConfigs,
  isCredentialHeaderName,
  parseClientConfig,
  readManifest,
  renderUpstreamBlock,
  restoreBackups,
  sanitizeUpstreamName,
  scanJsonText,
  serializeJson,
  writeFileAtomic,
  writeManifest,
} from './client-adopt.js'
import type { AdoptOptions, ClientSource, JsonStyle } from './client-adopt.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Helio's loader on one string: `${NAME}` becomes the value, an unset name a marker. */
const BARE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g
function loader(s: string, env: Record<string, string | undefined>): string {
  return s.replace(BARE, (_m, n: string) => env[n] ?? `<UNSET:${n}>`)
}

function source(
  display: string,
  format: 'claude' | 'cursor' | 'vscode',
  text: string,
  path = `/proj/${display}`,
): ClientSource {
  return { path, display, format, text }
}

const OPTIONS: AdoptOptions = {
  port: 3000,
  host: '127.0.0.1',
  env: {},
  cwd: '/proj',
  home: '/home/u',
  pathSeparator: '/',
  force: false,
  outputName: 'helio.yaml',
}

function claudeFile(servers: Record<string, unknown>, display = '.mcp.json'): ClientSource {
  return source(display, 'claude', JSON.stringify({ mcpServers: servers }, null, 2) + '\n')
}
function cursorFile(servers: Record<string, unknown>): ClientSource {
  return source(
    '.cursor/mcp.json',
    'cursor',
    JSON.stringify({ mcpServers: servers }, null, 2) + '\n',
  )
}
function vscodeFile(servers: Record<string, unknown>): ClientSource {
  return source(
    '.vscode/mcp.json',
    'vscode',
    JSON.stringify({ servers, inputs: [] }, null, 2) + '\n',
  )
}

function adoptOk(files: ClientSource[], overrides: Partial<AdoptOptions> = {}) {
  const plan = adoptServers(files, { ...OPTIONS, ...overrides })
  if (!plan.ok) throw new Error(`expected an adoption, got: ${plan.error}`)
  return plan
}
function adoptErr(files: ClientSource[], overrides: Partial<AdoptOptions> = {}): string {
  const plan = adoptServers(files, { ...OPTIONS, ...overrides })
  if (plan.ok) throw new Error('expected a refusal, got an adoption')
  return plan.error
}

// ---------------------------------------------------------------------------
// The JSON scanner
// ---------------------------------------------------------------------------

describe('scanJsonText', () => {
  it('parses plain JSON and reports the style of a two-space LF file with a trailing newline', () => {
    const r = scanJsonText('{\n  "a": 1\n}\n')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toEqual({ a: 1 })
    expect(r.comments).toBe(false)
    expect(r.style).toEqual({ indent: '  ', eol: '\n', trailingNewline: true })
  })

  it('strips line and block comments outside strings and reports them', () => {
    const text =
      '{\n  // MCP server using HTTP or SSE - runs on a server\n  "a": "http://x/y", /* c */ "b": "/* not a comment */ // nor this"\n}\n'
    const r = scanJsonText(text)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toEqual({ a: 'http://x/y', b: '/* not a comment */ // nor this' })
    expect(r.comments).toBe(true)
  })

  it('accepts trailing commas before } and ]', () => {
    const r = scanJsonText('{"a": [1, 2,], "b": {"c": 3,},}')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toEqual({ a: [1, 2], b: { c: 3 } })
  })

  it('detects a tab indent, CRLF line endings, and a missing trailing newline', () => {
    const r = scanJsonText('{\r\n\t"a": 1\r\n}')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.style).toEqual({ indent: '\t', eol: '\r\n', trailingNewline: false })
  })

  it('uses two spaces when the file has newlines but no indented line, and compact when it has none', () => {
    const multi = scanJsonText('{\n"a": 1\n}\n')
    expect(multi.ok && multi.style.indent).toBe('  ')
    const compact = scanJsonText('{"a":1}')
    expect(compact.ok && compact.style.indent).toBe('')
  })

  it('names a byte-order mark', () => {
    const r = scanJsonText('﻿{"a": 1}')
    expect(r).toEqual({ ok: false, kind: 'bom' })
  })

  it('refuses an unterminated block comment instead of adopting the prefix', () => {
    expect(scanJsonText('{"a": 1} /* {"b": 2}')).toEqual({
      ok: false,
      kind: 'parse',
      message: 'unterminated block comment',
    })
  })

  it('reports a parse failure with the parser message', () => {
    const r = scanJsonText('{"a": }')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.kind).toBe('parse')
    expect(r.kind === 'parse' && r.message.length > 0).toBe(true)
  })

  it.each([
    ['9007199254740993', 'an integer beyond 2^53 precision'],
    ['-9007199254740993', 'an integer beyond 2^53 precision'],
    ['12345678901234567890', 'an integer beyond 2^53 precision'],
    ['-0', 'a negative zero'],
    ['-0.0', 'a negative zero'],
    ['1e309', 'a non-finite value'],
  ])('refuses the numeric token %s as %s', (token) => {
    const r = scanJsonText(`{"n": ${token}}`)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.kind).toBe('number')
    if (r.kind !== 'number') return
    expect(r.token).toBe(token)
    expect(r.path).toBe('n')
  })

  it.each(['9007199254740991', '1.0000000000000002', '1e21', '1E2', '0.0', '0', '-1', '1e21'])(
    'accepts the numeric token %s (a spelling change is not a value change)',
    (token) => {
      expect(scanJsonText(`{"n": ${token}}`).ok).toBe(true)
    },
  )

  it('does not read a 16-digit number inside a string as a numeric token', () => {
    const r = scanJsonText('{"s": "9007199254740993"}')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toEqual({ s: '9007199254740993' })
  })

  it('refuses an object whose integer-index keys JSON.parse would hoist out of textual order', () => {
    const r = scanJsonText('{"top": {"9": 1, "c": 2, "3": 3}}')
    expect(r).toEqual({ ok: false, kind: 'reorder', path: 'top' })
  })

  it('accepts a sorted integer-key prefix, and treats "01" and "4294967295" as ordinary keys', () => {
    expect(scanJsonText('{"1": 1, "5": 2, "c": 3}').ok).toBe(true)
    expect(scanJsonText('{"c": 3, "01": 1, "4294967295": 2}').ok).toBe(true)
    expect(scanJsonText('{"c": 3, "4294967294": 2}').ok).toEqual(false)
  })

  it('judges every nested object on its own, naming the top level as (top level)', () => {
    expect(scanJsonText('{"b": 1, "2": 2}')).toEqual({
      ok: false,
      kind: 'reorder',
      path: '(top level)',
    })
    expect(scanJsonText('{"a": {"x": {"1": 1, "y": 2}}, "b": [{"2": 1, "1": 2}]}')).toEqual({
      ok: false,
      kind: 'reorder',
      path: 'b.0',
    })
  })

  it('passes the ~/.claude.json shape: integer keys already first in their object', () => {
    const text = JSON.stringify(
      {
        mcpServers: { helio: { type: 'http', url: 'http://127.0.0.1:3000/mcp' } },
        cachedGrowthBookFeatures: { '0': 'a', '1': 'b', other: 'c' },
      },
      null,
      2,
    )
    expect(scanJsonText(text).ok).toBe(true)
  })
})

describe('serializeJson', () => {
  const value = { a: [1, { b: 'x' }] }
  it.each<[JsonStyle, string]>([
    [
      { indent: '  ', eol: '\n', trailingNewline: true },
      '{\n  "a": [\n    1,\n    {\n      "b": "x"\n    }\n  ]\n}\n',
    ],
    [
      { indent: '\t', eol: '\r\n', trailingNewline: false },
      '{\r\n\t"a": [\r\n\t\t1,\r\n\t\t{\r\n\t\t\t"b": "x"\r\n\t\t}\r\n\t]\r\n}',
    ],
    [{ indent: '', eol: '\n', trailingNewline: false }, '{"a":[1,{"b":"x"}]}'],
  ])('re-serializes with the detected style %j', (style, expected) => {
    expect(serializeJson(value, style)).toBe(expected)
  })
})

// ---------------------------------------------------------------------------
// Paths and detection
// ---------------------------------------------------------------------------

describe('classifyClientPath', () => {
  it.each([
    ['.mcp.json', 'claude'],
    ['/x/y/.mcp.json', 'claude'],
    ['.cursor/mcp.json', 'cursor'],
    ['/home/u/.cursor/mcp.json', 'cursor'],
    ['.vscode/mcp.json', 'vscode'],
    ['/home/u/.claude.json', 'claude'],
    ['./-weird/.mcp.json', 'claude'],
  ])('accepts %s as %s', (path, format) => {
    expect(classifyClientPath(path)).toEqual({ ok: true, format })
  })

  it('refuses the Claude Desktop file by name', () => {
    expect(
      classifyClientPath('/Library/Application Support/Claude/claude_desktop_config.json'),
    ).toEqual({
      ok: false,
      kind: 'desktop',
    })
  })

  it.each(['', '-', 'mcp.json', 'other/mcp.json', 'helio.yaml', '.copilot/mcp-config.json'])(
    'refuses %j as unaccepted',
    (path) => {
      expect(classifyClientPath(path)).toEqual({ ok: false, kind: 'unaccepted' })
    },
  )
})

describe('detectClientConfigs', () => {
  it('finds the three project files by fixed path, in the documented order, and nothing else', () => {
    const dir = mkdtempSync(join(tmpdir(), 'helio-adopt-detect-'))
    try {
      mkdirSync(join(dir, '.cursor'))
      mkdirSync(join(dir, '.vscode'))
      writeFileSync(join(dir, '.vscode', 'mcp.json'), '{}')
      writeFileSync(join(dir, '.mcp.json'), '{}')
      writeFileSync(join(dir, 'mcp.json'), '{}')
      expect(detectClientConfigs(dir)).toEqual([
        { path: join(dir, '.mcp.json'), display: '.mcp.json', format: 'claude' },
        { path: join(dir, '.vscode', 'mcp.json'), display: '.vscode/mcp.json', format: 'vscode' },
      ])
      expect(detectClientConfigs(join(dir, 'nowhere'))).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// Parsing per format: the servers-in-.mcp.json exception, the both-keys rule
// ---------------------------------------------------------------------------

describe('parseClientConfig', () => {
  it('reads a Claude Code .mcp.json under mcpServers', () => {
    const r = parseClientConfig(claudeFile({ files: { command: 'node' } }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.format).toBe('claude')
    expect(r.serversKey).toBe('mcpServers')
    expect(r.servers).toEqual({ files: { command: 'node' } })
    expect(r.droppedServers).toBe(false)
  })

  it('reads a .mcp.json that carries only servers as VS Code portable file', () => {
    const r = parseClientConfig(
      source('.mcp.json', 'claude', '{"servers": {"s": {"command": "node"}}}'),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.format).toBe('vscode')
    expect(r.serversKey).toBe('servers')
  })

  it('reads a .mcp.json with both keys as Claude Code and reports the dropped servers object', () => {
    const r = parseClientConfig(
      source(
        '.mcp.json',
        'claude',
        '{"mcpServers": {"a": {"command": "x"}}, "servers": {"b": {"command": "y"}}}',
      ),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.format).toBe('claude')
    expect(r.droppedServers).toBe(true)
    expect(Object.keys(r.servers)).toEqual(['a'])
  })

  it('does not apply the servers exception to .claude.json', () => {
    const r = parseClientConfig(
      source('.claude.json', 'claude', '{"servers": {}}', '/home/u/.claude.json'),
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toBe(
      'Error: .claude.json has no mcpServers object at the top level. Nothing changed.',
    )
  })

  it.each([
    ['cursor', '{"servers": {}}', 'mcpServers'],
    ['vscode', '{"mcpServers": {}}', 'servers'],
  ] as const)(
    'refuses the wrong top-level key for %s naming the expected one',
    (format, text, expected) => {
      const display = format === 'cursor' ? '.cursor/mcp.json' : '.vscode/mcp.json'
      const r = parseClientConfig(source(display, format, text))
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.error).toBe(
        `Error: ${display} has no ${expected} object at the top level. Nothing changed.`,
      )
    },
  )

  it('refuses a file that is not JSON after comment removal, and a BOM, with the plan lines', () => {
    const bad = parseClientConfig(source('.vscode/mcp.json', 'vscode', '{"servers": }'))
    expect(bad.ok).toBe(false)
    if (bad.ok) return
    expect(bad.error).toMatch(
      /^Error: \.vscode\/mcp\.json is not JSON after comment removal: .+\. Nothing changed\.$/,
    )
    const bom = parseClientConfig(source('.mcp.json', 'claude', '﻿{"mcpServers": {}}'))
    expect(bom.ok).toBe(false)
    if (bom.ok) return
    expect(bom.error).toBe('Error: .mcp.json starts with a byte-order mark. Nothing changed.')
  })

  it('refuses a file a rewrite would corrupt, naming the case', () => {
    const reorder = parseClientConfig(
      source(
        '.mcp.json',
        'claude',
        '{"mcpServers": {"9": {"command": "x"}, "a": {"command": "y"}, "3": {"command": "z"}}}',
      ),
    )
    expect(reorder.ok).toBe(false)
    if (reorder.ok) return
    expect(reorder.error).toBe(
      'Error: .mcp.json would not survive a rewrite: mcpServers has integer-like keys out of JSON order. Edit it by hand. Nothing changed.',
    )
    const num = parseClientConfig(
      source('.mcp.json', 'claude', '{"mcpServers": {}, "n": {"k": 9007199254740993}}'),
    )
    expect(num.ok).toBe(false)
    if (num.ok) return
    expect(num.error).toBe(
      'Error: .mcp.json would not survive a rewrite: n.k holds a number a rewrite would change: an integer beyond 2^53 precision, a negative zero, or a non-finite value such as 1e309. Edit it by hand. Nothing changed.',
    )
  })

  it('refuses a servers value that is not an object', () => {
    const r = parseClientConfig(source('.mcp.json', 'claude', '{"mcpServers": []}'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toBe(
      'Error: .mcp.json has no mcpServers object at the top level. Nothing changed.',
    )
  })
})

// ---------------------------------------------------------------------------
// The Claude Code substitution rule, as captured from Claude Code 2.1.278
// ---------------------------------------------------------------------------

const B = { BAR: 'not-a-secret', PROBE_TOKEN: 'not-a-secret' }
const R8 = {
  BAR: '${MISSING}',
  MISSING: 'from-missing',
  DEEP: '${A:-${B:-from-value}}',
  DEF: '${MISSING2:-should-not}',
}
const R9 = { ...R8, HOLD: '${ANTHROPIC_API_KEY}', HOLDX: '${ANTHROPIC_API_KEY:-x}', PLAIN: 'hello' }
const R10 = { PLAIN: 'hello', HOST: '127.0.0.1' }
const R11 = { HOST: '127.0.0.1', PORT: '3471', USER: 'alice' }
const R12 = {
  WHOLE: 'http://127.0.0.1:3471/all',
  SCHEME: 'http',
  PLAIN: 'hello',
  FRAG: 'part',
  PORT: '3471',
  PASS: 'pw',
}
const R13 = {
  WHOLE: 'nope',
  SCHEME: 'http://127.0.0.1:3471',
  REST: '/adj',
  BASE: 'http://127.0.0.1:3471',
  HOLDURL: 'http://${ANTHROPIC_API_KEY}@127.0.0.1:3471/z',
}
const R14 = { BASE: 'http://127.0.0.1:3471/' }
const R15 = {
  ANTHROPIC_BASE_URL: 'http://alice:pw@127.0.0.1:3471/',
  BASE2: 'http://carol:pw3@127.0.0.1:3471/',
}
const R16 = {
  END: 'http://127.0.0.1:3471//',
  ANTHROPIC_BASE_URL: 'http://alice@127.0.0.1:3471/useronly',
  BASE3: 'http://alice:pw@127.0.0.1:3471/',
}

type Kind = 'header' | 'url' | 'stdio'
/**
 * [string, environment of the adopting shell, kind, what Claude Code 2.1.278 sent
 * (the wire value after Helio's loader must equal it; REFUSE when the client sent a
 * placeholder the loader would substitute; SKIP when it made no request; ADOPT-UNSET
 * when the client requested the placeholder and the loader sends as text), the capture's label]
 */
const CAPTURED: Array<[string, Record<string, string>, Kind, string, string]> = [
  [
    'http://bob:pw2@127.0.0.1:3471/lit3',
    R16,
    'url',
    'http://bob:pw2@127.0.0.1:3471/lit3',
    '(requested /lit3; adopted and printed)',
  ],
  ['http://127.0.0.1:3471///x', R16, 'url', 'http://127.0.0.1:3471/x', '(leading run of three)'],
  ['http://127.0.0.1:3471//a//b', R16, 'url', 'http://127.0.0.1:3471/a//b', '(leading run only)'],
  ['${END}/p', R16, 'url', 'http://127.0.0.1:3471/p', '(value ending in //)'],
  ['${ANTHROPIC_BASE_URL}', R16, 'url', 'SKIP', '(username only; no request)'],
  [
    '${BASE3}b3',
    R16,
    'url',
    'http://alice:pw@127.0.0.1:3471/b3',
    '(requested /b3; token kept, no collapse needed)',
  ],
  [
    'http://127.0.0.1:3471/a//b',
    R15,
    'url',
    'http://127.0.0.1:3471/a//b',
    'u_mid (sent as written)',
  ],
  [
    'http://127.0.0.1:3471/td//',
    R15,
    'url',
    'http://127.0.0.1:3471/td//',
    'u_trail_d (sent as written)',
  ],
  [
    'http://127.0.0.1:3471//lead',
    R15,
    'url',
    'http://127.0.0.1:3471/lead',
    'u_lead (leading collapse)',
  ],
  [
    '${ANTHROPIC_BASE_URL}/cred',
    R15,
    'url',
    'SKIP',
    'u_cred_provider (not a valid url; no request)',
  ],
  [
    '${BASE2}/cred2',
    R15,
    'url',
    'REFUSE',
    'u_cred_plain (the collapsed literal would inline carol:pw3)',
  ],
  [
    'http://bob:pw2@127.0.0.1:3471/cred3',
    R15,
    'url',
    'http://bob:pw2@127.0.0.1:3471/cred3',
    'u_cred_literal (requested /cred3)',
  ],
  ['http://${UHOST}:3471/uh', R14, 'url', 'SKIP', 'u_unset_host (ENOTFOUND, no request)'],
  [
    'http://127.0.0.1:${UPORT}/up',
    R14,
    'url',
    'SKIP',
    'u_unset_port (not a valid url, no request)',
  ],
  [
    'http://127.0.0.1:3471/${UPATH}',
    R14,
    'url',
    'ADOPT-UNSET',
    'u_unset_path (requested /${UPATH}; the loader refuses at start)',
  ],
  ['${UWHOLE}', R14, 'url', 'SKIP', 'u_unset_whole (not a valid url, no request)'],
  ['${BASE}/p', R14, 'url', 'http://127.0.0.1:3471/p', 'u_base_slash (requested /p)'],
  [
    'http://127.0.0.1:3471//lit',
    R14,
    'url',
    'http://127.0.0.1:3471/lit',
    'u_literal_dslash (no token; requested /lit)',
  ],
  ['${BASE}//dd', R14, 'url', 'http://127.0.0.1:3471/dd', 'u_base_dslash (requested /dd)'],
  ['${BASE}nj', R14, 'url', 'http://127.0.0.1:3471/nj', 'u_base_nojoin (requested /nj)'],
  [
    'http://127.0.0.1:3471/a/../dot',
    R14,
    'url',
    'http://127.0.0.1:3471/dot',
    'u_literal_dot (requested /dot; both sides resolve the dot segment)',
  ],
  ['${WHOLE}', R13, 'url', 'SKIP', 'u_whole_nope (not a valid URL; no request)'],
  ['${SCHEME}${REST}', R13, 'url', 'http://127.0.0.1:3471/adj', 'u_adjacent (requested /adj)'],
  ['${BASE}/p', R13, 'url', 'http://127.0.0.1:3471/p', 'u_base_path (requested /p)'],
  [
    '${HOLDURL}',
    R13,
    'url',
    'REFUSE',
    'u_holdurl (no request; the one pass splices a value holding a blanked name)',
  ],
  ['${WHOLE}', R12, 'url', 'http://127.0.0.1:3471/all', 'u_whole (requested /all)'],
  ['${SCHEME}://127.0.0.1:3471/s', R12, 'url', 'http://127.0.0.1:3471/s', 'u_scheme'],
  ['http://127.0.0.1:3471/q?k=${PLAIN}', R12, 'url', 'http://127.0.0.1:3471/q?k=hello', 'u_query'],
  [
    'http://127.0.0.1:3471/g#${FRAG}',
    R12,
    'url',
    'http://127.0.0.1:3471/g#part',
    'u_frag (requested /g)',
  ],
  [
    'http://127.0.0.1:${PORT}?x',
    R12,
    'url',
    'http://127.0.0.1:3471?x',
    'u_port_query (requested /?x)',
  ],
  [
    'http://alice:${PASS}@127.0.0.1:3471/w',
    R12,
    'url',
    'http://alice:pw@127.0.0.1:3471/w',
    'u_pass (requested /w)',
  ],
  ['http://${HOST}:${PORT}/p', R11, 'url', 'http://127.0.0.1:3471/p', 'u_host_port (requested /p)'],
  [
    'http://127.0.0.1:${PORT}/o',
    R11,
    'url',
    'http://127.0.0.1:3471/o',
    'u_port_only (requested /o)',
  ],
  [
    'http://${A:-${HOST}}:3471/f',
    R11,
    'url',
    'SKIP',
    'u_host_formed (ENOTFOUND, no request; the pass forms bare ${HOST} in the host, sent as text)',
  ],
  [
    'http://${USER}:x@127.0.0.1:3471/u',
    R11,
    'url',
    'http://alice:x@127.0.0.1:3471/u',
    'u_userinfo (requested /u)',
  ],
  ['http://${HOST}:3471/h', R10, 'url', 'http://127.0.0.1:3471/h', 'u_host_plain (requested /h)'],
  ['http://127.0.0.1:3471/${PLAIN}', R10, 'url', 'http://127.0.0.1:3471/hello', 'u_path_plain'],
  [
    'http://127.0.0.1:3471/${A:-${PLAIN}}',
    R10,
    'url',
    'REFUSE',
    'u_path_formed (requested /${PLAIN})',
  ],
  ['Bearer ${A:-${B:-${PLAIN}}}', R10, 'header', 'REFUSE', 'h_formed (arrived as Bearer ${PLAIN})'],
  ['Bearer ${env:FOO:-${PLAIN}}', R10, 'header', 'Bearer ${env:FOO:-hello}', 'h_carried'],
  ['${PLAIN}', R10, 'stdio', 'hello', 'V1'],
  ['${A:-${PLAIN}}', R10, 'stdio', 'REFUSE', 'V2 (child saw ${PLAIN})'],
  ['Bearer ${A:-${BAR}}', R9, 'header', 'REFUSE', 'h1 (arrived as Bearer ${MISSING}, characters)'],
  ['Bearer ${env:FOO:-${BAR}}', R9, 'header', 'Bearer ${env:FOO:-from-missing}', 'h2'],
  ['Bearer ${A:-${HOLD}}', R9, 'header', 'REFUSE', 'h3 (arrived as Bearer ${ANTHROPIC_API_KEY})'],
  ['Bearer ${A:-${HOLDX}}', R9, 'header', 'Bearer ${ANTHROPIC_API_KEY:-x}', 'h4'],
  [
    'http://127.0.0.1:3471/${A:-${ANTHROPIC_API_KEY}}',
    R9,
    'url',
    'REFUSE',
    'path (requested /${ANTHROPIC_API_KEY})',
  ],
  ['http://${A:-${ANTHROPIC_API_KEY}}:3471/hb', R9, 'url', 'SKIP', 'host (ENOTFOUND, no request)'],
  ['${BAR}', R9, 'stdio', 'REFUSE', 'V1 (child saw ${MISSING})'],
  ['${A:-${BAR}}', R9, 'stdio', 'REFUSE', 'V2 (child saw ${BAR})'],
  ['${env:FOO:-${BAR}}', R9, 'stdio', 'REFUSE', 'V3 (child saw ${env:FOO:-${MISSING}})'],
  ['${DEEP}', R9, 'stdio', '${A:-${B:-from-value}}', 'V4'],
  ['${A:-${B:-${C:-lit}}}', R9, 'stdio', '${B:-${C:-lit}}', 'V5'],
  ['${A:-${A:-x}}', R9, 'stdio', '${A:-x}', 'V6'],
  ['${PLAIN}', R9, 'stdio', 'hello', 'V7'],
  [
    'Bearer ${A:-${B:-${ANTHROPIC_API_KEY}}}',
    {},
    'header',
    'REFUSE',
    'f1 (arrived as the placeholder Bearer ${ANTHROPIC_API_KEY})',
  ],
  ['Bearer ${BAR}', R8, 'header', 'Bearer from-missing', 'f2a'],
  ['Bearer ${DEEP}', R8, 'header', 'Bearer ${B:-from-value}', 'f2b'],
  ['Bearer ${DEF}', R8, 'header', 'Bearer should-not', 'f2c'],
  ['http://${A:-127.0.0.1}:3471/one', {}, 'url', 'http://127.0.0.1:3471/one', 'f3 host one'],
  [
    'http://${A:-${B:-127.0.0.1}}:3471/two',
    {},
    'url',
    'SKIP',
    'f3 host two (no request; rejected as not a valid URL)',
  ],
  ['http://127.0.0.1:3471/${A:-pthone}', {}, 'url', 'http://127.0.0.1:3471/pthone', 'f3 path one'],
  [
    'http://127.0.0.1:3471/${A:-${B:-pth}}',
    {},
    'url',
    'http://127.0.0.1:3471/${B:-pth}',
    'f3 path two',
  ],
  ['Bearer ${A:-${B:-${C:-${D:-lit}}}}', {}, 'header', 'Bearer ${C:-${D:-lit}}', 'four deep'],
  ['Bearer ${A:-${A:-x}}', {}, 'header', 'Bearer x', 'self'],
  ['Bearer ${A:-price$5}', {}, 'header', 'Bearer price$5', 'dollar'],
  ['${env:FOO:-${BAR:-${ANTHROPIC_API_KEY}}}', B, 'header', '${env:FOO:-not-a-secret}}', '/a'],
  ['${env:FOO:-${ANTHROPIC_API_KEY:-${BAR}}}', B, 'header', '${env:FOO:-}}', '/b'],
  ['${env:FOO:-${MISSING:-${ANTHROPIC_API_KEY}}}', B, 'header', '${env:FOO:-}', '/c'],
  ['${A:-${B:-x}y}', B, 'header', 'xy', '/d'],
  ['${A:-${BAR:-x}y}', B, 'header', 'not-a-secret', '/e'],
  ['${A:-${BAR:-${C:-lit}}}', B, 'header', 'not-a-secret}', '/f'],
  ['${A:-${B:-${C:-lit}}}', B, 'header', '${C:-lit}', '/g'],
  ['${BAR:-${MISSING}}tail', B, 'header', 'not-a-secret}tail', '/h'],
  ['Bearer ${env:PROBE_TOKEN:-fallback}', B, 'header', 'Bearer ${env:PROBE_TOKEN:-fallback}', '/a'],
  ['Bearer ${env:FOO:-${PROBE_TOKEN}}', B, 'header', 'Bearer ${env:FOO:-not-a-secret}', '/b'],
  ['Bearer ${env:FOO:-${ANTHROPIC_API_KEY}}', B, 'header', 'Bearer ${env:FOO:-}', '/c'],
  [
    'Bearer ${env:FOO:-${ANTHROPIC_API_KEY:-x}}',
    B,
    'header',
    'Bearer ${env:FOO:-}',
    'review fixture',
  ],
  [
    'Bearer ${env:FOO:-${env:ANTHROPIC_API_KEY}}',
    B,
    'header',
    'Bearer ${env:FOO:-${env:ANTHROPIC_API_KEY}}',
    'review fixture',
  ],
  ['Bearer ${ANTHROPIC_API_KEY}', B, 'header', 'Bearer ', '/r'],
  ['Bearer ${PROBE_TOKEN}', B, 'header', 'Bearer not-a-secret', '/s set'],
  [
    'http://127.0.0.1:9/${FOO:-bar}baz}',
    B,
    'url',
    'http://127.0.0.1:9/barbaz}',
    '(listed as ${FOO}baz})',
  ],
  [
    '${MISSING:-${ANTHROPIC_API_KEY}}',
    B,
    'stdio',
    'REFUSE',
    'stdio (child saw the placeholder ${ANTHROPIC_API_KEY}, formed by the only pass)',
  ],
  ['${env:SOME_TOKEN:-${PROBE_TOKEN}}', B, 'stdio', '${env:SOME_TOKEN:-not-a-secret}', 'stdio'],
  ['${env:FOO:-${ANTHROPIC_API_KEY:-x}}', B, 'stdio', '${env:FOO:-x}', 'stdio'],
  // A token FORMED by the only pass is sent as text whatever the shell holds for it.
  [
    'http://127.0.0.1:9/${A:-${BASE}}',
    { BASE: '//admin' },
    'url',
    'REFUSE',
    'formed ${BASE} in the path; its value would make a leading // but is never inlined',
  ],
  [
    'http://127.0.0.1:9/${A:-${ANTHROPIC_BASE_URL}}',
    { ANTHROPIC_BASE_URL: 'http://alice:pw@h/' },
    'url',
    'REFUSE',
    'formed ${ANTHROPIC_BASE_URL} in the path; the provider skip is for a carried name only',
  ],
]

describe('adoptClaudeString: the captured Claude Code 2.1.278 rule (85 captured arrivals)', () => {
  it('holds 85 captured cases and two review strings', () => {
    expect(CAPTURED).toHaveLength(87)
  })

  it('never inlines a token the last pass formed, even when its value would collapse a leading //', () => {
    for (const env of [{ BASE: '//admin' }, { BASE: 'ok' }, {}]) {
      const r = adoptClaudeString('http://127.0.0.1:9/${A:-${BASE}}', 'url', env, 'github.url')
      expect(r.outcome, JSON.stringify(env)).toBe('refused')
      if (r.outcome !== 'refused') return
      expect(r.reason).toContain('would still hold ${BASE} as text')
    }
    const carried = adoptClaudeString(
      '${BASE}//dd',
      'url',
      { BASE: 'http://127.0.0.1:3471/' },
      'github.url',
    )
    expect(carried.outcome === 'adopted' && carried.value).toBe('http://127.0.0.1:3471/dd')
  })

  it.each(CAPTURED)('%s with %j as %s arrives as %s [%s]', (s, env, kind, sent) => {
    const r = adoptClaudeString(s, kind, env, 'x.field')
    if (sent === 'REFUSE') {
      expect(r.outcome).toBe('refused')
      return
    }
    if (sent === 'SKIP') {
      expect(r.outcome).toBe('skipped')
      return
    }
    expect(r.outcome).toBe('adopted')
    if (r.outcome !== 'adopted') return
    const wire = loader(r.value, env)
    if (sent === 'ADOPT-UNSET') {
      expect(wire).toMatch(/<UNSET:/)
      return
    }
    if (kind === 'url') {
      const norm = (x: string) => {
        try {
          return new URL(x).href
        } catch {
          return x
        }
      }
      expect(norm(wire)).toBe(norm(sent))
    } else {
      expect(wire).toBe(sent)
    }
  })

  it('prints the Dropped line for a blanked name in both forms, the default not expanded', () => {
    const bare = adoptClaudeString(
      'Bearer ${ANTHROPIC_API_KEY}',
      'header',
      {},
      'github.headers.Authorization',
    )
    expect(bare.outcome).toBe('adopted')
    if (bare.outcome !== 'adopted') return
    expect(bare.value).toBe('Bearer ')
    expect(bare.lines).toContain(
      'Dropped ${ANTHROPIC_API_KEY} from github.headers.Authorization: Claude Code sends that name empty, and Helio would send your credential.',
    )
    const withDefault = adoptClaudeString(
      '${ANTHROPIC_API_KEY:-default}',
      'header',
      {},
      'github.headers.X',
    )
    expect(withDefault.outcome === 'adopted' && withDefault.value).toBe('')
    expect(withDefault.outcome === 'adopted' && withDefault.lines[0]).toBe(
      'Dropped ${ANTHROPIC_API_KEY:-default} from github.headers.X: Claude Code sends that name empty, and Helio would send your credential.',
    )
  })

  it.each(['ANTHROPIC_AUTH_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK', 'HTTPS_PROXY', 'NPM_TOKEN'])(
    'blanks %s on a remote string and leaves it for the loader on a stdio value',
    (name) => {
      const remote = adoptClaudeString('x ${' + name + '}', 'url', {}, 'f')
      expect(
        remote.outcome === 'skipped' ||
          (remote.outcome === 'adopted' && !remote.value.includes(name)),
      ).toBe(true)
      const header = adoptClaudeString('Bearer ${' + name + '}', 'header', {}, 'f')
      expect(header.outcome === 'adopted' && header.value).toBe('Bearer ')
      const stdio = adoptClaudeString('${' + name + '}', 'stdio', {}, 'f')
      expect(stdio.outcome === 'adopted' && stdio.value).toBe('${' + name + '}')
    },
  )

  it('quotes a kept env: token to its balanced brace when a nested token was spliced', () => {
    const r = adoptClaudeString(
      'Bearer ${env:FOO:-${BAR}}',
      'header',
      R9,
      'h2.headers.Authorization',
    )
    expect(r.outcome === 'adopted' && r.value).toBe('Bearer ${env:FOO:-${MISSING}}')
    expect(r.outcome === 'adopted' && r.lines).toContain(
      'Kept "${env:FOO:-${MISSING}}" in h2.headers.Authorization as written: Claude Code sends that text with ${MISSING} expanded, and so will Helio.',
    )
  })

  it('names the output the run would write in the collapse refusal', () => {
    const r = adoptClaudeString(
      'http://bob:pw@127.0.0.1:3471/${BASE}',
      'url',
      { BASE: '/foo' },
      'github.url',
      'other.yaml',
    )
    expect(r.outcome === 'refused' && r.reason).toBe(
      'its url already carries a username and password, and Claude Code would collapse its leading //; writing that collapsed url into other.yaml would copy the credential. Fix the url by hand.',
    )
  })

  it('says which inner names are expanded and which stay text when a kept token holds both', () => {
    const r = adoptClaudeString(
      'Bearer ${env:FOO:-${YES}${NOPE}}',
      'header',
      { YES: 'hi' },
      'h.headers.Authorization',
    )
    expect(r.outcome === 'adopted' && r.lines).toEqual([
      'Kept "${env:FOO:-${YES}${NOPE}}" in h.headers.Authorization as written: Claude Code sends that text with ${YES} expanded and ${NOPE} left as it is (NOPE is unset); Helio refuses to start until NOPE is set.',
    ])
  })

  it('uses plural wording when several inner names are unset or set', () => {
    const twoUnset = adoptClaudeString(
      'Bearer ${env:FOO:-${YES}${A}${B}}',
      'header',
      { YES: 'hi' },
      'h.headers.Authorization',
    )
    expect(twoUnset.outcome === 'adopted' && twoUnset.lines).toEqual([
      'Kept "${env:FOO:-${YES}${A}${B}}" in h.headers.Authorization as written: Claude Code sends that text with ${YES} expanded and ${A} and ${B} left as they are (A and B are unset); Helio refuses to start until A and B are set.',
    ])
    const twoSet = adoptClaudeString(
      'Bearer ${env:FOO:-${A}${B}${NOPE}}',
      'header',
      { A: 'x', B: 'y' },
      'h.headers.Authorization',
    )
    expect(twoSet.outcome === 'adopted' && twoSet.lines).toEqual([
      'Kept "${env:FOO:-${A}${B}${NOPE}}" in h.headers.Authorization as written: Claude Code sends that text with ${A} and ${B} expanded and ${NOPE} left as it is (NOPE is unset); Helio refuses to start until NOPE is set.',
    ])
  })

  it('says an unset inner name stays a placeholder that Helio refuses at start', () => {
    const r = adoptClaudeString(
      'Bearer ${env:FOO:-${NOPE}}',
      'header',
      {},
      'h.headers.Authorization',
    )
    expect(r.outcome === 'adopted' && r.value).toBe('Bearer ${env:FOO:-${NOPE}}')
    expect(r.outcome === 'adopted' && r.lines).toEqual([
      'Kept "${env:FOO:-${NOPE}}" in h.headers.Authorization as written: Claude Code sends that text with ${NOPE} left as it is (NOPE is unset); Helio refuses to start until NOPE is set.',
    ])
  })

  it('keeps the env: form as written with the Kept line, set or unset', () => {
    for (const env of [{}, { PROBE_TOKEN: 'v', ANTHROPIC_API_KEY: 'k' }]) {
      const r = adoptClaudeString(
        'Bearer ${env:ANTHROPIC_API_KEY}',
        'header',
        env,
        'github.headers.Authorization',
      )
      expect(r.outcome === 'adopted' && r.value).toBe('Bearer ${env:ANTHROPIC_API_KEY}')
      expect(r.outcome === 'adopted' && r.lines).toContain(
        'Kept "${env:ANTHROPIC_API_KEY}" in github.headers.Authorization as written: Claude Code sends those characters, and so will Helio.',
      )
    }
  })

  it('prints the Spliced line only when a later pass exists', () => {
    const header = adoptClaudeString('Bearer ${BAR}', 'header', R8, 'github.headers.Authorization')
    expect(header.outcome === 'adopted' && header.lines).toContain(
      "Spliced the value of ${BAR} into github.headers.Authorization (it holds ${...}, which Claude Code's next pass scans)",
    )
    const stdio = adoptClaudeString('${DEEP}', 'stdio', R9, 'files.env.X')
    expect(stdio.outcome === 'adopted' && stdio.lines.some((l) => l.startsWith('Spliced'))).toBe(
      false,
    )
  })

  it('prints a Rewrote line for a default Claude Code expands', () => {
    const r = adoptClaudeString(
      '${API_BASE_URL:-https://api.example.com}/mcp',
      'url',
      {},
      'api.url',
    )
    expect(r.outcome === 'adopted' && r.value).toBe('https://api.example.com/mcp')
    expect(r.outcome === 'adopted' && r.lines).toContain(
      'Rewrote api.url as "https://api.example.com/mcp" (API_BASE_URL is unset, so Claude Code uses its default)',
    )
  })

  it('quotes the text that remains after the last pass when a default was spliced and rescanned', () => {
    const r = adoptClaudeString(
      'Bearer ${A:-${HOLDX}}',
      'header',
      { HOLDX: '${ANTHROPIC_API_KEY:-x}' },
      'h4.headers.Authorization',
    )
    expect(r.outcome === 'adopted' && r.value).toBe('Bearer ${ANTHROPIC_API_KEY:-x}')
    expect(r.outcome === 'adopted' && r.lines).toEqual([
      'Rewrote h4.headers.Authorization as "Bearer ${ANTHROPIC_API_KEY:-x}" (A is unset, so Claude Code uses its default)',
    ])
  })

  it('names the placeholder and the field in the refusal reason', () => {
    const r = adoptClaudeString('Bearer ${A:-${BAR}}', 'header', R9, 'github.headers.Authorization')
    expect(r.outcome).toBe('refused')
    if (r.outcome !== 'refused') return
    expect(r.reason).toBe(
      "after Claude Code's expansion its Authorization header would still hold ${MISSING} as text (Claude Code sends those characters; Helio would substitute the variable at start, or refuse if it is unset). Fix the header by hand.",
    )
    const url = adoptClaudeString('http://127.0.0.1:3471/${A:-${PLAIN}}', 'url', R10, 'x.url')
    expect(url.outcome === 'refused' && url.reason).toBe(
      "after Claude Code's expansion its url would still hold ${PLAIN} as text (Claude Code sends those characters; Helio would substitute the variable at start, or refuse if it is unset). Fix the url by hand.",
    )
    const stdio = adoptClaudeString('${A:-${PLAIN}}', 'stdio', R10, 'files.env.KEY')
    expect(stdio.outcome === 'refused' && stdio.reason).toBe(
      "after Claude Code's expansion its env value KEY would still hold ${PLAIN} as text (Claude Code sends those characters; Helio would substitute the variable at start, or refuse if it is unset). Fix the env value by hand.",
    )
  })

  it('names the url skip reasons as the client behaves', () => {
    const invalid = adoptClaudeString('http://${A:-${B:-127.0.0.1}}:3471/two', 'url', {}, 'x.url')
    expect(invalid.outcome === 'skipped' && invalid.reason).toBe(
      "its url is not valid after Claude Code's expansion (http://${B:-127.0.0.1}:3471/two); this client does not connect to it.",
    )
    const host = adoptClaudeString('http://${A:-${ANTHROPIC_API_KEY}}:3471/hb', 'url', {}, 'x.url')
    expect(host.outcome === 'skipped' && host.reason).toBe(
      'its host would still hold ${ANTHROPIC_API_KEY}; this client fails the lookup and does not connect.',
    )
    const unsetHost = adoptClaudeString('http://${UHOST}:3471/uh', 'url', {}, 'x.url')
    expect(unsetHost.outcome === 'skipped' && unsetHost.reason).toBe(
      'its host would still hold ${UHOST}; this client fails the lookup and does not connect.',
    )
    const provider = adoptClaudeString('${ANTHROPIC_BASE_URL}/cred', 'url', R15, 'x.url')
    expect(provider.outcome === 'skipped' && provider.reason).toBe(
      'its url uses ${ANTHROPIC_BASE_URL}, whose value carries a username and password; Claude Code does not use that URL and does not connect.',
    )
  })

  it('writes the collapsed literal with the inlined value named, and refuses one that would carry a credential', () => {
    const r = adoptClaudeString('${BASE}//dd', 'url', R14, 'github.url')
    expect(r.outcome === 'adopted' && r.value).toBe('http://127.0.0.1:3471/dd')
    expect(r.outcome === 'adopted' && r.lines).toContain(
      'Wrote github.url as http://127.0.0.1:3471/dd (the value of ${BASE} inlined and the leading empty path segment collapsed, as Claude Code requests it; Helio would otherwise send ///dd)',
    )
    const literal = adoptClaudeString('http://127.0.0.1:3471//lit', 'url', {}, 'github.url')
    expect(literal.outcome === 'adopted' && literal.lines).toContain(
      'Wrote github.url as http://127.0.0.1:3471/lit (the leading empty path segment collapsed, as Claude Code requests it; Helio would otherwise send //lit)',
    )
    const cred = adoptClaudeString('${BASE2}/cred2', 'url', R15, 'github.url')
    expect(cred.outcome === 'refused' && cred.reason).toBe(
      'its url needs the value of ${BASE2} written in (a leading // to collapse), and that value carries a username and password. Fix the url by hand.',
    )
    for (const base of ['/foo', '//x']) {
      const pathVar = adoptClaudeString(
        'http://bob:pw@127.0.0.1:3471/${BASE}',
        'url',
        { BASE: base },
        'github.url',
      )
      expect(pathVar.outcome === 'refused' && pathVar.reason, base).toBe(
        'its url already carries a username and password, and Claude Code would collapse its leading //; writing that collapsed url into helio.yaml would copy the credential. Fix the url by hand.',
      )
    }
    const userinfoValue = adoptClaudeString(
      'http://${U}@h/${BASE}',
      'url',
      { U: 'bob:pw', BASE: '/z' },
      'github.url',
    )
    expect(userinfoValue.outcome === 'refused' && userinfoValue.reason).toBe(
      'its url needs the value of ${U} written in (a leading // to collapse), and that value carries a username and password. Fix the url by hand.',
    )
    const passwordValue = adoptClaudeString(
      'http://user:${PASS}@h/${BASE}',
      'url',
      { PASS: 'secret', BASE: '/v1' },
      'github.url',
    )
    expect(passwordValue.outcome === 'refused' && passwordValue.reason).toBe(
      'its url needs the value of ${PASS} written in (a leading // to collapse), and that value carries a username and password. Fix the url by hand.',
    )
    // A value that is the host, a delimiter, or the joining character holds no credential.
    const literalSentence =
      'its url already carries a username and password, and Claude Code would collapse its leading //; writing that collapsed url into helio.yaml would copy the credential. Fix the url by hand.'
    for (const [url, env] of [
      ['http://user:token@${HOST}/${API_PATH}', { HOST: 'h', API_PATH: '/v1' }],
      ['http://user:token@${HOST}/${API_PATH}', { HOST: '127.0.0.1', API_PATH: '/v1' }],
      ['http://bob${SEP}pw@host/${API_PATH}', { SEP: ':', API_PATH: '/z' }],
    ] as const) {
      const r = adoptClaudeString(url, 'url', env, 'github.url')
      expect(r.outcome === 'refused' && r.reason, url).toBe(literalSentence)
    }
    // Where the value lands decides, not what it looks like: a host or a path that equals
    // or contains the credential stays on the literal sentence; a value that supplies part
    // of the username or password is named, encoded or not.
    for (const [url, env] of [
      ['http://user:token@${HOST}/${API_PATH}', { HOST: 'token', API_PATH: '/v1' }],
      ['http://bob:pw@${HOST}/${API_PATH}', { HOST: 'bob', API_PATH: '/v1' }],
      ['http://bob:pw@h/${NOTE}', { NOTE: '/notbob:pw' }],
      ['http://bob:pw@h/${NOTE}', { NOTE: '/bob:pwEXTRA' }],
      ['http://user:%41@${HOST}/${API_PATH}', { HOST: 'A', API_PATH: '/v1' }],
    ] as const) {
      const r = adoptClaudeString(url, 'url', env, 'github.url')
      expect(r.outcome === 'refused' && r.reason, url).toBe(literalSentence)
    }
    for (const [url, env, name] of [
      ['http://user:sec${TAIL}@h/${P}', { TAIL: 'ret', P: '/z' }, '${TAIL}'],
      ['http://${USER}:pw@h/${API_PATH}', { USER: 'bob%20x', API_PATH: '/v1' }, '${USER}'],
      ['http://${USER}:pw@h/${API_PATH}', { USER: 'bob x', API_PATH: '/v1' }, '${USER}'],
    ] as const) {
      const r = adoptClaudeString(url, 'url', env, 'github.url')
      expect(r.outcome === 'refused' && r.reason, url).toBe(
        `its url needs the value of ${name} written in (a leading // to collapse), and that value carries a username and password. Fix the url by hand.`,
      )
    }
    // The joining @ is a delimiter, and that url has a username and no password.
    const at = adoptClaudeString(
      'http://user${AT}host/${API_PATH}',
      'url',
      { AT: '@', API_PATH: '/z' },
      'github.url',
    )
    expect(at.outcome === 'refused' && at.reason).toBe(
      'its url already carries a username, and Claude Code would collapse its leading //; writing that collapsed url into helio.yaml would copy the credential. Fix the url by hand.',
    )
    const usernameOnly = adoptClaudeString(
      'http://bob@h/${API_PATH}',
      'url',
      { API_PATH: '/z' },
      'github.url',
    )
    expect(usernameOnly.outcome === 'refused' && usernameOnly.reason).toBe(
      'its url already carries a username, and Claude Code would collapse its leading //; writing that collapsed url into helio.yaml would copy the credential. Fix the url by hand.',
    )
    const usernameValue = adoptClaudeString(
      'http://${USER}@h/${API_PATH}',
      'url',
      { USER: 'bob', API_PATH: '/z' },
      'github.url',
    )
    expect(usernameValue.outcome === 'refused' && usernameValue.reason).toBe(
      'its url needs the value of ${USER} written in (a leading // to collapse), and that value carries a username. Fix the url by hand.',
    )
    // The parser drops tabs and newlines and strips leading and trailing spaces
    // before it parses; the ranges are found on that text and mapped back.
    for (const url of [
      ' http://${U}@h/${API_PATH}',
      '\thttp://${U}@h/${API_PATH}',
      'http:/\t/${U}@h/${API_PATH}',
      'ht\ttp://${U}@h/${API_PATH}',
      'http://${U}@h\n/${API_PATH}',
      'http://${U}@h/${API_PATH} ',
    ]) {
      const r = adoptClaudeString(url, 'url', { U: 'bob:pw', API_PATH: '/z' }, 'github.url')
      expect(r.outcome === 'refused' && r.reason, JSON.stringify(url)).toBe(
        'its url needs the value of ${U} written in (a leading // to collapse), and that value carries a username and password. Fix the url by hand.',
      )
    }
    const sameNameTwice = adoptClaudeString(
      'http://${A}:${A}@h/${P}',
      'url',
      { A: 'bob', P: '/z' },
      'github.url',
    )
    expect(sameNameTwice.outcome === 'refused' && sameNameTwice.reason).toBe(
      'its url needs the value of ${A} written in (a leading // to collapse), and that value carries a username and password. Fix the url by hand.',
    )
    const twoCarriers = adoptClaudeString(
      'http://${U}:${PASS}@h/${BASE}',
      'url',
      { U: 'bob', PASS: 'secret', BASE: '/z' },
      'github.url',
    )
    expect(twoCarriers.outcome === 'refused' && twoCarriers.reason).toBe(
      'its url needs the values of ${U} and ${PASS} written in (a leading // to collapse), and those values carry a username and password. Fix the url by hand.',
    )
    const literalCred = adoptClaudeString(
      'http://bob:pw@127.0.0.1:3471//lit',
      'url',
      {},
      'github.url',
    )
    expect(literalCred.outcome === 'refused' && literalCred.reason).toBe(
      'its url already carries a username and password, and Claude Code would collapse its leading //; writing that collapsed url into helio.yaml would copy the credential. Fix the url by hand.',
    )
  })

  it('prints the ANTHROPIC_BASE_URL line when that name is kept for the loader', () => {
    const r = adoptClaudeString(
      '${ANTHROPIC_BASE_URL}/mcp',
      'url',
      { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1' },
      'api.url',
    )
    expect(r.outcome === 'adopted' && r.value).toBe('${ANTHROPIC_BASE_URL}/mcp')
    expect(r.outcome === 'adopted' && r.lines).toContain(
      'Kept ${ANTHROPIC_BASE_URL} in api.url: Claude Code does not use the URL when that value carries a username and password; Helio will send it.',
    )
  })
})

// ---------------------------------------------------------------------------
// The Cursor and VS Code vocabulary
// ---------------------------------------------------------------------------

describe('adoptVendorString', () => {
  const ctx = { dir: '/proj/app', home: '/home/u', pathSeparator: '/' }

  it.each([
    ['${env:API_KEY}', '${API_KEY}'],
    ['Bearer ${env:ANTHROPIC_API_KEY}', 'Bearer ${ANTHROPIC_API_KEY}'],
    ['${workspaceFolder}/srv', '/proj/app/srv'],
    ['${workspaceFolderBasename}', 'app'],
    ['${userHome}/.x', '/home/u/.x'],
    ['a${pathSeparator}b${/}c', 'a/b/c'],
    ['${API_KEY}', '${API_KEY}'],
    ['no token', 'no token'],
  ])('rewrites %s to %s', (input, expected) => {
    const r = adoptVendorString(input, ctx, 'f')
    expect(r.outcome === 'adopted' && r.value).toBe(expected)
  })

  it('prints the before and after of every rewrite', () => {
    const r = adoptVendorString('${env:API_KEY}', ctx, 'github.headers.Authorization')
    expect(r.outcome === 'adopted' && r.lines).toEqual([
      'Rewrote "${env:API_KEY}" in github.headers.Authorization as "${API_KEY}"',
    ])
  })

  it('keeps ${VAR:-default} as written with the Kept line (Q11)', () => {
    const r = adoptVendorString('${API_BASE:-http://x}/m', ctx, 'api.url')
    expect(r.outcome === 'adopted' && r.value).toBe('${API_BASE:-http://x}/m')
    expect(r.outcome === 'adopted' && r.lines).toEqual([
      'Kept "${API_BASE:-http://x}" in api.url as written: neither Cursor nor VS Code documents a default, and Helio sends it as written.',
    ])
  })

  it('skips an entry that uses ${input:...}', () => {
    const r = adoptVendorString('${input:token}', ctx, 'f')
    expect(r).toEqual({
      outcome: 'skipped',
      reason: 'uses ${input:...}, a prompt Helio cannot answer',
    })
  })
})

// ---------------------------------------------------------------------------
// Names and the credential net
// ---------------------------------------------------------------------------

describe('sanitizeUpstreamName', () => {
  it.each([
    ['files', 'files'],
    ['---', '---'],
    ['a b', 'a-b'],
    ['@scope/server', 'scope-server'],
    ['café', 'caf'],
    ['!!!', ''],
    ['...', ''],
    ['A'.repeat(70), 'A'.repeat(64)],
  ])('%s becomes %s', (key, name) => {
    expect(sanitizeUpstreamName(key)).toBe(name)
  })
})

describe('isCredentialHeaderName', () => {
  it.each([
    'Authorization',
    'proxy-authorization',
    'Cookie',
    'X-Api-Key',
    'Password',
    'X-Password',
    'X-Credential',
    'X-Auth-Token',
    'Api_Key',
    'ApiKey',
    'X-Amz-Security-Token',
    'PRIVATE-TOKEN',
    'X-Goog-Api-Key',
    'X-CSRF-Token',
  ])('prints for %s', (name) => {
    expect(isCredentialHeaderName(name)).toBe(true)
  })
  it.each([
    'X-Request-Key',
    'Idempotency-Key',
    'Content-Auth-Version',
    'X-Author',
    'WWW-Authenticate',
    'Accept',
    'Sec-WebSocket-Key',
  ])('stays quiet for %s', (name) => {
    expect(isCredentialHeaderName(name)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// adoptServers: formats, type rules, skips, renames, merge
// ---------------------------------------------------------------------------

describe('adoptServers', () => {
  it('adopts the three formats into one upstreams list with the Found block', () => {
    const plan = adoptOk([
      claudeFile({
        files: { command: 'node', args: ['/f.cjs', 'files_ping'], env: { FILES_ROOT: '/tmp' } },
        github: {
          type: 'http',
          url: 'http://127.0.0.1:8087/mcp',
          headers: { Authorization: 'Bearer ${GITHUB_TOKEN}' },
        },
      }),
      cursorFile({ payments: { command: 'node', args: ['/f.cjs', 'payments_ping'] } }),
      vscodeFile({ search: { type: 'stdio', command: 'node', args: ['/f.cjs', 'search_ping'] } }),
    ])
    expect(plan.entries.map((e) => [e.name, e.transport])).toEqual([
      ['files', 'stdio'],
      ['github', 'streamable-http'],
      ['payments', 'stdio'],
      ['search', 'stdio'],
    ])
    expect(plan.lines.slice(0, 4)).toEqual([
      'Found 4 servers in 3 client configs:',
      '  .mcp.json: files (stdio), github (http)',
      '  .cursor/mcp.json: payments (stdio)',
      '  .vscode/mcp.json: search (stdio)',
    ])
    expect(plan.variables).toEqual(['GITHUB_TOKEN'])
    expect(plan.entries[0]?.env).toEqual({ FILES_ROOT: '/tmp', CLAUDE_PROJECT_DIR: '/proj' })
    expect(plan.outputLines).toContain(
      'Set CLAUDE_PROJECT_DIR=/proj for files in helio.yaml (Claude Code sets it for stdio servers; update it if the project moves)',
    )
    expect(plan.outputLines).toContain(
      'Copied env for files into helio.yaml (FILES_ROOT); the file now holds those values',
    )
    expect(plan.lines.some((l) => l.includes('helio.yaml'))).toBe(false)
    expect(plan.entries[2]?.env).toBeUndefined()
    const files = plan.files.map((f) => [f.display, f.adopted])
    expect(files).toEqual([
      ['.mcp.json', ['files', 'github']],
      ['.cursor/mcp.json', ['payments']],
      ['.vscode/mcp.json', ['search']],
    ])
  })

  it('rewrites every adopted entry to its door in the format the client documents, keeping every other key', () => {
    const plan = adoptOk(
      [
        claudeFile({
          files: { command: 'node', args: [], extra: 1 },
          keep: { type: 'ws', url: 'ws://x' },
        }),
        cursorFile({ payments: { command: 'node' } }),
        vscodeFile({ search: { type: 'stdio', command: 'node' } }),
      ],
      { port: 3457 },
    )
    const [claude, cursor, vscode] = plan.files.map(
      (f) => JSON.parse(f.text) as Record<string, unknown>,
    )
    expect(claude).toEqual({
      mcpServers: {
        files: { type: 'http', url: 'http://127.0.0.1:3457/mcp/files' },
        keep: { type: 'ws', url: 'ws://x' },
      },
    })
    expect(cursor).toEqual({
      mcpServers: { payments: { url: 'http://127.0.0.1:3457/mcp/payments' } },
    })
    expect(vscode).toEqual({
      servers: { search: { type: 'http', url: 'http://127.0.0.1:3457/mcp/search' } },
      inputs: [],
    })
    expect(plan.files[0]?.text.endsWith('}\n')).toBe(true)
  })

  it('re-serializes with the detected indent, line ending and trailing-newline state, and prints the comments line', () => {
    const text =
      '{\r\n\t// comment\r\n\t"mcpServers": {\r\n\t\t"a": {"command": "node"}\r\n\t}\r\n}'
    const plan = adoptOk([source('.cursor/mcp.json', 'cursor', text)])
    expect(plan.files[0]?.text).toBe(
      '{\r\n\t"mcpServers": {\r\n\t\t"a": {\r\n\t\t\t"url": "http://127.0.0.1:3000/mcp/a"\r\n\t\t}\r\n\t}\r\n}',
    )
    expect(plan.files[0]?.notes).toEqual([
      'Comments in .cursor/mcp.json were not kept (the backup has them).',
    ])
  })

  describe('the one case-sensitive type rule', () => {
    it.each([
      ['http', 'streamable-http'],
      ['streamable-http', 'streamable-http'],
      ['sse', 'sse'],
    ])('adopts type %s as %s on every format', (type, transport) => {
      for (const file of [
        claudeFile({ s: { type, url: 'http://h/m' } }),
        cursorFile({ s: { type, url: 'http://h/m' } }),
        vscodeFile({ s: { type, url: 'http://h/m' } }),
      ]) {
        const plan = adoptOk([file])
        expect(plan.entries[0]?.transport).toBe(transport)
        expect(plan.entries[0]?.url).toBe('http://h/m')
      }
    })

    it.each(['ws', 'HTTP', 'Sse', 'stdio-ish'])(
      'skips type %s on every format with the transport line',
      (type) => {
        for (const [file, display] of [
          [claudeFile({ s: { type, url: 'http://h/m' }, ok: { command: 'node' } }), '.mcp.json'],
          [
            cursorFile({ s: { type, url: 'http://h/m' }, ok: { command: 'node' } }),
            '.cursor/mcp.json',
          ],
          [
            vscodeFile({ s: { type, url: 'http://h/m' }, ok: { command: 'node' } }),
            '.vscode/mcp.json',
          ],
        ] as const) {
          const plan = adoptOk([file])
          expect(plan.entries.map((e) => e.name)).toEqual(['ok'])
          expect(plan.lines).toContain(
            `Skipped "s" in ${display}: type "${type}" has no Helio transport; it stays direct.`,
          )
        }
      },
    )

    it('skips a typeless url in a Claude Code file with the vendor sentence, adopts it in a Cursor file, skips it in a VS Code file', () => {
      const claude = adoptOk([claudeFile({ s: { url: 'http://h/m' }, ok: { command: 'node' } })])
      expect(claude.entries.map((e) => e.name)).toEqual(['ok'])
      expect(claude.lines).toContain(
        'Skipped "s" in .mcp.json: has a "url" but no "type"; add "type": "http" (or "sse" / "ws") to this entry.',
      )
      const cursor = adoptOk([cursorFile({ s: { url: 'http://h/m' } })])
      expect(cursor.entries[0]?.transport).toBe('streamable-http')
      expect(cursor.lines[1]).toBe('  .cursor/mcp.json: s (http)')
      const vscode = adoptOk([vscodeFile({ s: { url: 'http://h/m' }, ok: { command: 'node' } })])
      expect(vscode.entries.map((e) => e.name)).toEqual(['ok'])
      expect(vscode.lines).toContain(
        'Skipped "s" in .vscode/mcp.json: has a "url" but no "type"; VS Code requires "type": "http" or "sse" on a remote entry.',
      )
    })
  })

  it('skips headersHelper, ${input:...}, and an entry with neither url nor command', () => {
    const plan = adoptOk([
      claudeFile({
        helper: { type: 'http', url: 'http://h/m', headersHelper: 'get-token' },
        empty: { args: ['x'] },
        ok: { command: 'node' },
      }),
      vscodeFile({
        prompt: {
          type: 'http',
          url: 'http://h/m',
          headers: { Authorization: 'Bearer ${input:token}' },
        },
      }),
    ])
    expect(plan.entries.map((e) => e.name)).toEqual(['ok'])
    expect(plan.lines).toContain(
      'Skipped "helper" in .mcp.json: uses headersHelper, which Helio cannot run; it stays direct.',
    )
    expect(plan.lines).toContain(
      'Skipped "empty" in .mcp.json: has neither url nor command; it stays direct.',
    )
    expect(plan.lines).toContain(
      'Skipped "prompt" in .vscode/mcp.json: uses ${input:...}, a prompt Helio cannot answer; it stays direct.',
    )
  })

  it('leaves a file out of the rewrite set when every entry in it was skipped', () => {
    const plan = adoptOk([
      claudeFile({ w: { type: 'ws', url: 'ws://x' }, t: { url: 'http://x/m' } }),
      cursorFile({ payments: { command: 'node' } }),
    ])
    expect(plan.entries.map((e) => e.name)).toEqual(['payments'])
    expect(plan.files.map((f) => f.display)).toEqual(['.cursor/mcp.json'])
    expect(plan.lines[0]).toBe('Found 3 servers in 2 client configs:')
  })

  it('refuses the run when every entry was skipped', () => {
    expect(adoptErr([claudeFile({ s: { type: 'ws', url: 'ws://x' } })])).toBe(
      'Error: no server in .mcp.json can be adopted (1 skipped, see above). Nothing changed.',
    )
  })

  it('skips cwd and envFile with a line naming the key and still adopts the entry', () => {
    const plan = adoptOk([
      vscodeFile({ s: { type: 'stdio', command: 'node', cwd: '/x', envFile: '.env' } }),
      cursorFile({ c: { command: 'node', envFile: '.env' } }),
    ])
    expect(plan.entries.map((e) => e.name)).toEqual(['s', 'c'])
    expect(plan.lines).toContain(
      "Skipped cwd for s in .vscode/mcp.json: Helio has no cwd field; the child inherits the proxy's working directory.",
    )
    expect(plan.lines).toContain(
      "Skipped envFile for s in .vscode/mcp.json: Helio has no envFile field; set the variables in env or in the proxy's environment.",
    )
    expect(plan.lines).toContain(
      "Skipped envFile for c in .cursor/mcp.json: Helio has no envFile field; set the variables in env or in the proxy's environment.",
    )
  })

  it('stringifies a numeric env value silently and skips a null one with a line', () => {
    const plan = adoptOk([
      vscodeFile({
        s: { type: 'stdio', command: 'node', env: { PORT: 8080, API_TIMEOUT: null, ON: true } },
      }),
    ])
    expect(plan.entries[0]?.env).toEqual({ PORT: '8080' })
    expect(plan.lines).toContain('Skipped env key API_TIMEOUT for s: its value is null')
    expect(plan.lines).toContain('Skipped env key ON for s: its value is a boolean')
    expect(plan.outputLines).toContain(
      'Copied env for s into helio.yaml (PORT); the file now holds those values',
    )
  })

  it('does not set CLAUDE_PROJECT_DIR when the file sets it, or on a Cursor or VS Code entry', () => {
    const plan = adoptOk([
      claudeFile({ a: { command: 'node', env: { CLAUDE_PROJECT_DIR: '/elsewhere' } } }),
      cursorFile({ b: { command: 'node' } }),
    ])
    expect(plan.entries[0]?.env).toEqual({ CLAUDE_PROJECT_DIR: '/elsewhere' })
    expect(plan.entries[1]?.env).toBeUndefined()
    expect(plan.outputLines.some((l) => l.startsWith('Set CLAUDE_PROJECT_DIR'))).toBe(false)
  })

  it('sets CLAUDE_PROJECT_DIR to the directory the file was found in', () => {
    const plan = adoptOk([
      source(
        '.mcp.json',
        'claude',
        '{"mcpServers": {"a": {"command": "node"}}}',
        '/elsewhere/app/.mcp.json',
      ),
    ])
    expect(plan.entries[0]?.env).toEqual({ CLAUDE_PROJECT_DIR: '/elsewhere/app' })
  })

  it('prints the dropped servers line for a .mcp.json with both keys and keeps the object in the rewritten file', () => {
    const plan = adoptOk([
      source(
        '.mcp.json',
        'claude',
        '{"mcpServers": {"a": {"command": "x"}}, "servers": {"b": {"command": "y"}}}',
      ),
    ])
    expect(plan.lines).toContain(
      "Dropped the servers object in .mcp.json: the file also has mcpServers, so it was read as Claude Code's.",
    )
    expect(JSON.parse(plan.files[0]?.text ?? '')).toEqual({
      mcpServers: { a: { type: 'http', url: 'http://127.0.0.1:3000/mcp/a' } },
      servers: { b: { command: 'y' } },
    })
  })

  describe('names', () => {
    it('renames a key outside the charset and prints it', () => {
      const plan = adoptOk([claudeFile({ '@scope/server': { command: 'node' } })])
      expect(plan.entries[0]?.name).toBe('scope-server')
      expect(plan.lines).toContain(
        'Renamed "@scope/server" to "scope-server" (upstream names allow letters, digits, _ and -)',
      )
      expect(JSON.parse(plan.files[0]?.text ?? '')).toEqual({
        mcpServers: {
          '@scope/server': { type: 'http', url: 'http://127.0.0.1:3000/mcp/scope-server' },
        },
      })
    })

    it('leaves the legal --- alone', () => {
      const plan = adoptOk([claudeFile({ '---': { command: 'node' } })])
      expect(plan.entries[0]?.name).toBe('---')
      expect(plan.lines.some((l) => l.startsWith('Renamed'))).toBe(false)
    })

    it('refuses an empty sanitized name', () => {
      expect(adoptErr([claudeFile({ '!!!': { command: 'node' } })])).toBe(
        'Error: the name "!!!" in .mcp.json has no letters or digits to make an upstream name from. Rename it and rerun. Nothing changed.',
      )
    })

    it('refuses a collision after sanitization', () => {
      expect(
        adoptErr([claudeFile({ 'a b': { command: 'node' }, 'a-b': { command: 'node' } })]),
      ).toBe(
        'Error: "a b" and "a-b" in .mcp.json both become the upstream name "a-b". Rename one and rerun. Nothing changed.',
      )
    })

    it('refuses the same key defined differently in two files', () => {
      expect(
        adoptErr([
          claudeFile({ github: { command: 'node', args: ['a'] } }),
          cursorFile({ github: { command: 'node', args: ['b'] } }),
        ]),
      ).toBe(
        'Error: "github" is defined differently in .mcp.json and .cursor/mcp.json. Adopt one file: helio init --client .mcp.json',
      )
    })

    it('adopts an identical definition once and rewrites both files, comparing env and headers as sorted pairs', () => {
      const plan = adoptOk([
        claudeFile({ github: { type: 'http', url: 'http://h/m', headers: { A: '1', B: '2' } } }),
        cursorFile({ github: { url: 'http://h/m', headers: { B: '2', A: '1' } } }),
      ])
      expect(plan.entries.map((e) => e.name)).toEqual(['github'])
      expect(plan.files.map((f) => f.adopted)).toEqual([['github'], ['github']])
      expect(plan.lines[0]).toBe('Found 2 servers in 2 client configs:')
    })
  })

  describe('the door marker', () => {
    it.each([
      'http://127.0.0.1:3000/mcp/github',
      'http://localhost:9999/mcp/github/',
      'http://[::1]:3000/mcp/github',
    ])('refuses %s as a Helio door without --force', (url) => {
      expect(adoptErr([claudeFile({ github: { type: 'http', url } })])).toBe(
        `Error: "github" in .mcp.json already looks like a Helio door (${url}). Pass --force if it is not. Nothing changed.`,
      )
    })

    it.each([
      'http://127.0.0.1:3000/mcp/other',
      'http://127.0.0.1:3000/mcp',
      'http://example.com/mcp/github',
    ])('adopts %s', (url) => {
      expect(adoptOk([claudeFile({ github: { type: 'http', url } })]).entries[0]?.url).toBe(url)
    })

    it('passes the marker under --force', () => {
      const plan = adoptOk(
        [claudeFile({ github: { type: 'http', url: 'http://127.0.0.1:3000/mcp/github' } })],
        { force: true },
      )
      expect(plan.entries[0]?.url).toBe('http://127.0.0.1:3000/mcp/github')
    })
  })

  describe('substitutions inside entries', () => {
    it('runs the Claude Code rule on url, headers and stdio env, and the vocabulary on Cursor and VS Code strings', () => {
      const plan = adoptOk(
        [
          claudeFile({
            api: {
              type: 'http',
              url: '${API_BASE_URL:-https://api.example.com}/mcp',
              headers: {
                Authorization: 'Bearer ${ANTHROPIC_API_KEY}',
                'X-Plain': '${env:SOME_TOKEN}',
              },
            },
            child: {
              command: 'node',
              env: {
                A_VAL: '${env:SOME_TOKEN}',
                B_VAL: '${ANTHROPIC_API_KEY}',
                C_VAL: '${SOME_TOKEN}',
              },
            },
          }),
          cursorFile({
            c: {
              url: 'http://h/m',
              headers: { Authorization: 'Bearer ${env:ANTHROPIC_API_KEY}' },
              command: undefined,
            },
          }),
          vscodeFile({
            v: {
              type: 'stdio',
              command: '${workspaceFolder}/bin/x',
              env: { P: '${pathSeparator}' },
            },
          }),
        ],
        { env: { SOME_TOKEN: 'set' } },
      )
      const byName = Object.fromEntries(plan.entries.map((e) => [e.name, e]))
      expect(byName['api']?.url).toBe('https://api.example.com/mcp')
      expect(byName['api']?.headers).toEqual({
        Authorization: 'Bearer ',
        'X-Plain': '${env:SOME_TOKEN}',
      })
      expect(byName['child']?.env).toEqual({
        A_VAL: '${env:SOME_TOKEN}',
        B_VAL: '${ANTHROPIC_API_KEY}',
        C_VAL: '${SOME_TOKEN}',
        CLAUDE_PROJECT_DIR: '/proj',
      })
      expect(byName['c']?.headers).toEqual({ Authorization: 'Bearer ${ANTHROPIC_API_KEY}' })
      expect(byName['v']?.command).toBe('/proj/bin/x')
      expect(byName['v']?.env).toEqual({ P: '/' })
      expect(plan.variables).toEqual(['ANTHROPIC_API_KEY', 'SOME_TOKEN'])
    })

    it('refuses the run on a Claude Code string the last pass leaves a bare placeholder in', () => {
      expect(
        adoptErr([
          claudeFile({
            github: {
              type: 'http',
              url: 'http://h/m',
              headers: { Authorization: 'Bearer ${A:-${B:-${ANTHROPIC_API_KEY}}}' },
            },
          }),
        ]),
      ).toBe(
        'Error: "github" in .mcp.json: after Claude Code\'s expansion its Authorization header would still hold ${ANTHROPIC_API_KEY} as text (Claude Code sends those characters; Helio would substitute the variable at start, or refuse if it is unset). Fix the header by hand. Nothing changed.',
      )
    })

    it('skips a Claude Code entry whose url the client never requests', () => {
      const plan = adoptOk([
        claudeFile({
          two: { type: 'http', url: 'http://${A:-${B:-127.0.0.1}}:3471/two' },
          ok: { command: 'node' },
        }),
      ])
      expect(plan.entries.map((e) => e.name)).toEqual(['ok'])
      expect(plan.lines).toContain(
        'Skipped "two" in .mcp.json: its url is not valid after Claude Code\'s expansion (http://${B:-127.0.0.1}:3471/two); this client does not connect to it.',
      )
    })

    it('does not run the Claude Code rule on a Cursor string: nothing is blanked and a default is kept', () => {
      const plan = adoptOk([
        cursorFile({
          c: { url: 'http://h/${X:-m}', headers: { Authorization: 'Bearer ${ANTHROPIC_API_KEY}' } },
        }),
      ])
      expect(plan.entries[0]?.url).toBe('http://h/${X:-m}')
      expect(plan.entries[0]?.headers).toEqual({ Authorization: 'Bearer ${ANTHROPIC_API_KEY}' })
      expect(plan.variables).toEqual(['ANTHROPIC_API_KEY'])
    })
  })

  describe('the copied-credential pass', () => {
    it('prints a userinfo url on every format and a literal credential header, never the value', () => {
      const plan = adoptOk([
        claudeFile({
          a: {
            type: 'http',
            url: 'http://bob:pw2@127.0.0.1:3471/cred3',
            headers: { Authorization: 'Bearer abc123' },
          },
        }),
        cursorFile({
          b: { url: 'http://user:pass@host/path', headers: { 'X-Api-Key': 'k-secret' } },
        }),
        vscodeFile({
          c: {
            type: 'http',
            url: 'http://user:pass@host/path',
            headers: { Accept: 'application/json', Authorization: 'Bearer ${TOKEN}' },
          },
        }),
      ])
      expect(plan.outputLines).toContain(
        'Kept a.url as written: it carries a username and password in .mcp.json; they are now in helio.yaml too.',
      )
      expect(plan.outputLines).toContain(
        'Kept a.headers.Authorization as written: its value is a credential in .mcp.json; it is now in helio.yaml too.',
      )
      expect(plan.outputLines).toContain(
        'Kept b.url as written: it carries a username and password in .cursor/mcp.json; they are now in helio.yaml too.',
      )
      expect(plan.outputLines).toContain(
        'Kept b.headers.X-Api-Key as written: its value is a credential in .cursor/mcp.json; it is now in helio.yaml too.',
      )
      expect(plan.outputLines).toContain(
        'Kept c.url as written: it carries a username and password in .vscode/mcp.json; they are now in helio.yaml too.',
      )
      expect(plan.outputLines.some((l) => l.includes('c.headers'))).toBe(false)
      expect(plan.lines.join('\n')).not.toContain('abc123')
      expect(plan.lines.join('\n')).not.toContain('k-secret')
    })

    it('names the fields a userinfo url carries: a username alone is not a username and password', () => {
      const plan = adoptOk([
        claudeFile({
          a: { type: 'http', url: 'http://bob@h/m' },
          b: { type: 'http', url: 'http://:pw@h/m' },
        }),
      ])
      expect(plan.outputLines).toEqual([
        'Kept a.url as written: it carries a username in .mcp.json; it is now in helio.yaml too.',
        'Kept b.url as written: it carries a password in .mcp.json; it is now in helio.yaml too.',
      ])
    })

    it('judges the client file value, so a blanked or rewritten reference never prints as a credential', () => {
      const plan = adoptOk([
        claudeFile({
          a: {
            type: 'http',
            url: 'http://h/m',
            headers: { Authorization: 'Bearer ${ANTHROPIC_API_KEY}' },
          },
        }),
        cursorFile({ b: { url: 'http://h/m', headers: { Authorization: 'Bearer ${env:TOKEN}' } } }),
      ])
      expect(plan.entries[0]?.headers).toEqual({ Authorization: 'Bearer ' })
      expect(plan.outputLines.some((l) => l.startsWith('Kept a.headers'))).toBe(false)
      expect(plan.outputLines.some((l) => l.startsWith('Kept b.headers'))).toBe(false)
    })
  })

  describe('the upstream block and the variables', () => {
    it('renders every entry through js-yaml with double quotes and no line wrap, and round-trips awkward arguments', () => {
      const plan = adoptOk([
        claudeFile({
          odd: {
            command: 'npx',
            args: ['-y', '@scope/pkg', '--flag=a: b', 'yes', '1.0', 'null', '', 'x'.repeat(200)],
            env: { K: 'v' },
          },
          github: { type: 'sse', url: 'http://h/m', headers: { Authorization: 'Bearer ${T}' } },
        }),
      ])
      const block = plan.upstreamBlock
      expect(
        block.startsWith(
          'upstreams:\n  - name: "odd"\n    transport: "stdio"\n    command: "npx"\n',
        ),
      ).toBe(true)
      expect(block).toContain('      - "--flag=a: b"\n')
      expect(block.split('\n').every((l) => l.length <= 240)).toBe(true)
      const parsed = yaml.load(block) as { upstreams: unknown[] }
      expect(parsed.upstreams).toEqual([
        {
          name: 'odd',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@scope/pkg', '--flag=a: b', 'yes', '1.0', 'null', '', 'x'.repeat(200)],
          env: { K: 'v', CLAUDE_PROJECT_DIR: '/proj' },
        },
        {
          name: 'github',
          transport: 'sse',
          url: 'http://h/m',
          headers: { Authorization: 'Bearer ${T}' },
        },
      ])
      expect(plan.variables).toEqual(['T'])
    })

    it('scans every string of the block for variables: command, args, env, url and headers', () => {
      const plan = adoptOk([
        cursorFile({
          a: { command: '${env:CMD}', args: ['${ARG}'], env: { E: '${env:EV}' } },
          b: { url: 'http://${URLV}/m', headers: { H: '${HV}' } },
        }),
      ])
      expect(plan.variables).toEqual(['ARG', 'CMD', 'EV', 'HV', 'URLV'])
      expect(renderUpstreamBlock(plan.entries)).toBe(plan.upstreamBlock)
    })
  })

  it('names the output file the run writes in every line that says where the values now are', () => {
    const plan = adoptOk(
      [
        claudeFile({
          files: { command: 'node', env: { K: 'v' } },
          api: {
            type: 'http',
            url: 'http://u:p@h/m',
            headers: { Authorization: 'Bearer literal' },
          },
        }),
      ],
      { outputName: 'other.yaml' },
    )
    expect(plan.outputLines).toEqual([
      'Copied env for files into other.yaml (K); the file now holds those values',
      'Set CLAUDE_PROJECT_DIR=/proj for files in other.yaml (Claude Code sets it for stdio servers; update it if the project moves)',
      'Kept api.url as written: it carries a username and password in .mcp.json; they are now in other.yaml too.',
      'Kept api.headers.Authorization as written: its value is a credential in .mcp.json; it is now in other.yaml too.',
    ])
    expect(plan.outputLines.join('\n')).not.toContain('helio.yaml')
  })

  it('warns when a .claude.json holds fewer than two servers and counts only the top-level mcpServers', () => {
    const plan = adoptOk([
      source(
        '/home/u/.claude.json',
        'claude',
        JSON.stringify({
          mcpServers: { helio: { type: 'http', url: 'http://h/m' } },
          projects: { '/p': { mcpServers: { x: { command: 'node' } } } },
          other: 1,
        }),
        '/home/u/.claude.json',
      ),
    ])
    expect(plan.entries.map((e) => e.name)).toEqual(['helio'])
    expect(plan.lines).toContain(
      'Warning: /home/u/.claude.json holds 1 server under mcpServers (per-project servers under projects.<dir>.mcpServers were not counted or adopted). Claude Code plugins and claude.ai connectors are not in this file and cannot be routed through Helio.',
    )
    expect(JSON.parse(plan.files[0]?.text ?? '')).toEqual({
      mcpServers: { helio: { type: 'http', url: 'http://127.0.0.1:3000/mcp/helio' } },
      projects: { '/p': { mcpServers: { x: { command: 'node' } } } },
      other: 1,
    })
    expect(plan.claudeUserFile).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Manifest, atomic writes and restore
// ---------------------------------------------------------------------------

describe('manifest and restore', () => {
  it('names the suffixes and the manifest file', () => {
    expect(BACKUP_SUFFIX).toBe('.helio-backup')
    expect(TEMP_SUFFIX).toBe('.helio-tmp')
    expect(MANIFEST_FILE).toBe('.helio-init-client.json')
  })

  it('round-trips the manifest and reports null when absent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'helio-adopt-manifest-'))
    try {
      const path = join(dir, MANIFEST_FILE)
      expect(await readManifest(path)).toBeNull()
      const manifest = {
        version: 1 as const,
        output: join(dir, 'helio.yaml'),
        output_backup: null,
        clients: [{ path: join(dir, '.mcp.json'), backup: join(dir, '.mcp.json.helio-backup') }],
        created_at: '2026-09-22T00:00:00.000Z',
      }
      await writeManifest(path, manifest)
      expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual(manifest)
      expect(await readManifest(path)).toEqual(manifest)
      writeFileSync(path, '{"version": 2}')
      await expect(readManifest(path)).rejects.toThrow('not a manifest this version reads')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('writes through a temp sibling and rename, and unlinks the temp on failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'helio-adopt-atomic-'))
    try {
      const target = join(dir, 'a.json')
      await writeFileAtomic(target, 'x')
      expect(readFileSync(target, 'utf-8')).toBe('x')
      expect(existsSync(target + TEMP_SUFFIX)).toBe(false)
      const missingDir = join(dir, 'missing', 'b.json')
      await expect(writeFileAtomic(missingDir, 'y')).rejects.toThrow()
      expect(existsSync(missingDir + TEMP_SUFFIX)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('restores each backup byte for byte, removes it, and reports the byte count', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'helio-adopt-restore-'))
    try {
      const original = Buffer.from('{\r\n  "original": true\r\n}')
      const path = join(dir, '.mcp.json')
      const backup = path + BACKUP_SUFFIX
      writeFileSync(backup, original)
      writeFileSync(path, 'rewritten')
      const missing = join(dir, 'gone.json')
      const restored = await restoreBackups([
        { path, backup },
        { path: missing, backup: missing + BACKUP_SUFFIX },
      ])
      expect(restored).toEqual([{ path, backup, bytes: original.length }])
      expect(readFileSync(path)).toEqual(original)
      expect(existsSync(backup)).toBe(false)
      expect(existsSync(missing)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
