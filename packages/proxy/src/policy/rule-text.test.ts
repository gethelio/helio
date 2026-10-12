import { describe, it, expect } from 'vitest'
import {
  allowRule,
  approvalRule,
  commentSafe,
  exactPattern,
  exactlyMatchable,
  globLiteral,
  quoted,
  ruleLabel,
  unmatchableNote,
} from './rule-text.js'
import { compileToolMatcher } from './parser.js'
import { ENV_VAR_PATTERN } from '../config/loader.js'

// ---------------------------------------------------------------------------
// The exact-name pattern
// ---------------------------------------------------------------------------

describe('exactPattern', () => {
  it('leaves word characters alone and escapes every other ASCII character', () => {
    expect(exactPattern('get_weather')).toBe('get_weather')
    expect(exactPattern('a.b')).toBe('a\\.b')
    expect(exactPattern('x*y?')).toBe('x\\*y\\?')
    expect(exactPattern('a{1,2}')).toBe('a\\{1\\,2\\}')
    expect(exactPattern('[!a]')).toBe('\\[\\!a\\]')
    expect(exactPattern('a b')).toBe('a\\ b')
  })

  it('writes a backslash as the bracket class picomatch reads as a literal', () => {
    expect(exactPattern('back\\slash')).toBe('back[\\\\]slash')
    expect(exactPattern('\\')).toBe('[\\\\]')
  })

  it('keeps non-ASCII characters as they are', () => {
    expect(exactPattern('Hello, 世界')).toBe('Hello\\,\\ 世界')
  })

  it('matches exactly that name and nothing beside it for every ASCII punctuation character', () => {
    const punctuation = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~ '.split('')
    for (const char of punctuation) {
      const name = `x${char}y`
      const matcher = compileToolMatcher(exactPattern(name), 0)
      expect(matcher.test(name), JSON.stringify(name)).toBe(true)
      expect(matcher.test('xy'), JSON.stringify(name)).toBe(false)
      expect(matcher.test(`${name}z`), JSON.stringify(name)).toBe(false)
      expect(matcher.test(`x${char}${char}y`), JSON.stringify(name)).toBe(false)
    }
  })
})

describe('globLiteral and quoted', () => {
  it('writes the pattern as a JSON-quoted one-line scalar', () => {
    expect(globLiteral('a.b')).toBe('"a\\\\.b"')
    expect(globLiteral('back\\slash')).toBe('"back[\\\\\\\\]slash"')
    expect(quoted('x\ny')).toBe('"x\\ny"')
    expect(quoted('say "hi"')).toBe('"say \\"hi\\""')
  })

  it('keeps an upstream string on one comment line', () => {
    expect(commentSafe('x\ny')).toBe('x\\ny')
    expect(commentSafe('plain')).toBe('plain')
  })
})

describe('exactlyMatchable', () => {
  it('refuses an empty name', () => {
    expect(exactlyMatchable('')).toBe(false)
  })

  it('accepts a 30,000-character name and refuses one the glob engine cannot carry', () => {
    expect(exactlyMatchable('a'.repeat(30000))).toBe(true)
    expect(exactlyMatchable('a'.repeat(65537))).toBe(false)
    expect(exactlyMatchable('\\'.repeat(16384))).toBe(false)
  })

  it('accepts a backslash name and a glob-syntax name', () => {
    expect(exactlyMatchable('back\\slash')).toBe(true)
    expect(exactlyMatchable('**')).toBe(true)
  })
})

describe('unmatchableNote', () => {
  it('names an empty name and a long name on one comment line each', () => {
    expect(unmatchableNote('', '    ')).toBe(
      '    # a tool with an empty name was skipped: match.tool cannot name it\n',
    )
    const long = 'a'.repeat(65537)
    expect(unmatchableNote(long, '  ')).toBe(
      `  # ${'a'.repeat(60)}... (65537 characters) cannot be named by a match.tool pattern: the glob engine refuses it; write its rule by hand\n`,
    )
  })
})

// ---------------------------------------------------------------------------
// The rule label
// ---------------------------------------------------------------------------

describe('ruleLabel', () => {
  it('prefixes the tool name and leaves a name without a dollar sign as it is', () => {
    expect(ruleLabel('allow', 'read_file')).toBe('allow-read_file')
    expect(ruleLabel('approve', 'delete_record')).toBe('approve-delete_record')
    expect(ruleLabel('allow', 'a: b #c')).toBe('allow-a: b #c')
  })

  it('writes every dollar sign as an underscore so the loader never reads the name as a placeholder', () => {
    expect(ruleLabel('allow', 'read_${HELIO_R2_UNSET_ZZZ}')).toBe(
      'allow-read__{HELIO_R2_UNSET_ZZZ}',
    )
    expect(ruleLabel('approve', 'delete_${PATH}')).toBe('approve-delete__{PATH}')
    expect(ruleLabel('allow', 'get_$$amount')).toBe('allow-get___amount')
    for (const name of ['read_${X}', 'x${A}${B}y', '${_}']) {
      expect(ruleLabel('allow', name).search(ENV_VAR_PATTERN)).toBe(-1)
    }
  })
})

// ---------------------------------------------------------------------------
// The two rule renderers
// ---------------------------------------------------------------------------

describe('allowRule and approvalRule', () => {
  it('render the scaffold text without a scope', () => {
    expect(allowRule('get_weather', '    ')).toBe(
      '    - name: "allow-get_weather"\n' +
        '      match:\n' +
        '        tool: "get_weather"\n' +
        '      action: allow\n',
    )
    expect(approvalRule('delete_record', '    ')).toBe(
      '    - name: "approve-delete_record"\n' +
        '      match:\n' +
        '        tool: "delete_record"\n' +
        '      action: require_approval\n' +
        '      approval:\n' +
        '        channel: dashboard\n',
    )
  })

  it('add the upstreams line under match when scoped to a door', () => {
    expect(allowRule('read_file', '', { upstream: 'files' })).toBe(
      '- name: "allow-read_file"\n' +
        '  match:\n' +
        '    tool: "read_file"\n' +
        '    upstreams: ["files"]\n' +
        '  action: allow\n',
    )
    expect(approvalRule('rm', '  ', { upstream: 'a "b"' })).toBe(
      '  - name: "approve-rm"\n' +
        '    match:\n' +
        '      tool: "rm"\n' +
        '      upstreams: ["a \\"b\\""]\n' +
        '    action: require_approval\n' +
        '    approval:\n' +
        '      channel: dashboard\n',
    )
  })

  it('write a placeholder-shaped name under a label the loader will not interpolate, with the exact tool', () => {
    const text = allowRule('read_${HELIO_R2_UNSET_ZZZ}', '')
    expect(text).toBe(
      '- name: "allow-read__{HELIO_R2_UNSET_ZZZ}"\n' +
        '  match:\n' +
        '    tool: "read_\\\\$\\\\{HELIO_R2_UNSET_ZZZ\\\\}"\n' +
        '  action: allow\n',
    )
    expect(text.search(ENV_VAR_PATTERN)).toBe(-1)
    expect(approvalRule('delete_${PATH}', '')).toContain('- name: "approve-delete__{PATH}"\n')
  })

  it('quote a name that carries YAML structure', () => {
    expect(allowRule('a: b #c', '')).toContain('- name: "allow-a: b #c"\n')
    expect(allowRule('a: b #c', '')).toContain('    tool: "a\\\\:\\\\ b\\\\ \\\\#c"\n')
  })
})
