import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  EXECUTE_SHAPED_SEGMENTS,
  NAME_DESTROY,
  NAME_EXEC,
  NAME_READ,
  NAME_WRITE,
  classifyDefinition,
  definitionFromListed,
  firstToken,
  inputKeyPaths,
} from './classify.js'
import type { ClassifiedDefinition, GenerationDefinition } from './classify.js'
import type { ToolAnnotationHints } from '../policy/types.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function definition(overrides: Partial<GenerationDefinition> = {}): GenerationDefinition {
  return {
    name: 'get_customer',
    description: 'Returns the customer record.',
    annotations: { readOnlyHint: true, destructiveHint: false },
    input_keys: ['$.id'],
    ...overrides,
  }
}

function outcome(def: GenerationDefinition): { class: string; reason: string } {
  const classified = classifyDefinition(def)
  return { class: classified.class, reason: classified.reason }
}

const READ = { class: 'confident_read', reason: 'name, hint and description agree' }

// ---------------------------------------------------------------------------
// firstToken
// ---------------------------------------------------------------------------

describe('firstToken', () => {
  it('strips one mcp__<server>__ prefix and the literal namespace prefixes, in order', () => {
    expect(firstToken('github.get_file')).toBe('get')
    expect(firstToken('browser_click')).toBe('click')
    expect(firstToken('mcp__playwright__browser_snapshot')).toBe('snapshot')
    expect(firstToken('mcp__chrome-devtools__list_pages')).toBe('list')
  })

  it('strips the prefixes as a loop: github. then browser_, each when the remainder starts with it', () => {
    expect(firstToken('github.browser_get_file')).toBe('get')
    expect(firstToken('browser_github.get_file')).toBe('github')
  })

  it('splits camelCase and on underscore, hyphen and dot, lowercased', () => {
    expect(firstToken('deleteEverything')).toBe('delete')
    expect(firstToken('Read-File')).toBe('read')
    expect(firstToken('query.customers')).toBe('query')
    expect(firstToken('')).toBe('')
  })
})

// ---------------------------------------------------------------------------
// inputKeyPaths
// ---------------------------------------------------------------------------

describe('inputKeyPaths', () => {
  it('walks objects to depth 3 and descends on a union type that includes object', () => {
    const schema = {
      type: 'object',
      properties: {
        q: { type: ['object', 'null'], properties: { sql: { type: 'string' } } },
      },
    }
    expect(inputKeyPaths(schema)).toEqual(['$.q', '$.q.sql'])
  })

  it('skips a property that is not an object, never walks arrays, and stops at depth 3', () => {
    const schema = {
      type: 'object',
      properties: {
        bad: 'string',
        items: { type: 'array', items: { type: 'object', properties: { command: {} } } },
        a: {
          type: 'object',
          properties: {
            b: {
              type: 'object',
              properties: {
                c: { type: 'object', properties: { command: { type: 'string' } } },
              },
            },
          },
        },
      },
    }
    expect(inputKeyPaths(schema)).toEqual(['$.items', '$.a', '$.a.b', '$.a.b.c'])
  })

  it('yields nothing for a missing or non-object schema', () => {
    expect(inputKeyPaths(undefined)).toEqual([])
    expect(inputKeyPaths('object')).toEqual([])
    expect(inputKeyPaths({ type: 'object' })).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// definitionFromListed
// ---------------------------------------------------------------------------

describe('definitionFromListed', () => {
  it('reads name, a string description, the raw annotations and the walked input keys', () => {
    expect(
      definitionFromListed({
        name: 'read_file',
        description: 'Read the complete contents of a file',
        annotations: { readOnlyHint: true, extra: 1 },
        inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      }),
    ).toEqual({
      name: 'read_file',
      description: 'Read the complete contents of a file',
      annotations: { readOnlyHint: true, extra: 1 },
      input_keys: ['$.path'],
    })
  })

  it('leaves description and annotations undefined when absent or not of their type', () => {
    expect(definitionFromListed({ name: 'x', description: 42, annotations: 'none' })).toEqual({
      name: 'x',
      description: undefined,
      annotations: undefined,
      input_keys: [],
    })
    expect(definitionFromListed({}).name).toBe('')
  })
})

// ---------------------------------------------------------------------------
// classifyDefinition: the predicate, case by case
// ---------------------------------------------------------------------------

describe('classifyDefinition', () => {
  it('exports the four frozen name lists and the execute-shaped segments', () => {
    expect(NAME_READ).toEqual([
      'get',
      'list',
      'read',
      'search',
      'find',
      'query',
      'describe',
      'show',
      'view',
      'count',
      'check',
      'lookup',
    ])
    expect(NAME_WRITE).toHaveLength(16)
    expect(NAME_DESTROY).toEqual([
      'delete',
      'remove',
      'drop',
      'destroy',
      'purge',
      'clear',
      'reset',
      'truncate',
    ])
    expect(NAME_EXEC).toEqual([
      'run',
      'execute',
      'exec',
      'eval',
      'invoke',
      'call',
      'shell',
      'command',
    ])
    expect(EXECUTE_SHAPED_SEGMENTS).toEqual([
      'command',
      'shell',
      'script',
      'sql',
      'statement',
      'raw_query',
      'code',
      'expression',
    ])
  })

  it('is confident read when name, hint and description agree', () => {
    expect(outcome(definition())).toEqual(READ)
    const read = classifyDefinition(
      definition({ name: 'read_file', description: 'Read the complete contents of a file' }),
    )
    expect(read.class).toBe('confident_read')
    expect(read.signals).toEqual({
      first_token: 'read',
      name_class: 'read',
      annotation_class: 'read',
      description_class: 'read',
      open_world: false,
      execute_shaped: false,
      demoted: false,
    })
  })

  it('reads a sentence-initial READ verb and a READ marker as a read description', () => {
    expect(outcome(definition({ description: 'Read the complete contents' }))).toEqual(READ)
    expect(outcome(definition({ description: 'This tool is read-only.' }))).toEqual(READ)
    expect(outcome(definition({ description: 'It does not modify anything' }))).toEqual(READ)
  })

  it('matches lexicon words whole: clear inside clearly is no hit, and type is skipped', () => {
    expect(outcome(definition({ description: 'Returns a clearly labeled record' }))).toEqual(READ)
    expect(outcome(definition({ description: 'Returns the type of the record' }))).toEqual(READ)
    expect(outcome(definition({ description: 'Returns the record; call it often' }))).toEqual(READ)
  })

  it('restricts on destructiveHint: true before any other signal', () => {
    expect(
      outcome(definition({ annotations: { readOnlyHint: true, destructiveHint: true } })),
    ).toEqual({ class: 'confident_restrict', reason: 'destructiveHint: true' })
  })

  it('restricts on a destroy-class or execute-class first token', () => {
    expect(outcome(definition({ name: 'deleteEverything' }))).toEqual({
      class: 'confident_restrict',
      reason: 'destroy-class name',
    })
    expect(outcome(definition({ name: 'run_query' }))).toEqual({
      class: 'confident_restrict',
      reason: 'execute-class name',
    })
  })

  it('restricts on a destroy, execute or irreversibility word in the description', () => {
    expect(outcome(definition({ description: 'Returns data; this cannot be undone.' }))).toEqual({
      class: 'confident_restrict',
      reason: 'destructive description',
    })
    expect(outcome(definition({ description: 'Will overwrite the file' }))).toEqual({
      class: 'confident_restrict',
      reason: 'destructive description',
    })
    expect(outcome(definition({ description: 'Runs a shell on the host' }))).toEqual({
      class: 'confident_restrict',
      reason: 'destructive description',
    })
  })

  it('demotes a read tool with an execute-shaped argument, by the last path segment', () => {
    expect(outcome(definition({ input_keys: ['$.query.sql'] }))).toEqual({
      class: 'needs_decision',
      reason: 'execute-shaped argument',
    })
    expect(outcome(definition({ input_keys: ['$.sql.limit'] }))).toEqual(READ)
    const walked = inputKeyPaths({
      type: 'object',
      properties: {
        q: { type: ['object', 'null'], properties: { sql: { type: 'string' } } },
      },
    })
    expect(outcome(definition({ input_keys: walked }))).toEqual({
      class: 'needs_decision',
      reason: 'execute-shaped argument',
    })
  })

  it('names description disagrees when a whole write word sits on a read name', () => {
    expect(outcome(definition({ description: 'Create a customer and return it' }))).toEqual({
      class: 'needs_decision',
      reason: 'description disagrees',
    })
    // An inflected form is not the lexicon word: whole words only, as the oracle reads them.
    expect(outcome(definition({ description: 'Creates nothing; returns the record' }))).toEqual(
      READ,
    )
  })

  it('names open-world read on a read name and write-class name on a write name', () => {
    expect(
      outcome(definition({ annotations: { readOnlyHint: true, openWorldHint: true } })),
    ).toEqual({ class: 'needs_decision', reason: 'open-world read' })
    expect(
      outcome(
        definition({
          name: 'update_customer',
          annotations: { readOnlyHint: true, openWorldHint: true },
        }),
      ),
    ).toEqual({ class: 'needs_decision', reason: 'write-class name' })
  })

  it('names unknown name, hints absent, annotation not read-only and description silent in that order', () => {
    expect(outcome(definition({ name: 'export_customers' }))).toEqual({
      class: 'needs_decision',
      reason: 'unknown name',
    })
    expect(outcome(definition({ annotations: undefined }))).toEqual({
      class: 'needs_decision',
      reason: 'hints absent',
    })
    expect(outcome(definition({ annotations: {} }))).toEqual({
      class: 'needs_decision',
      reason: 'hints absent',
    })
    expect(outcome(definition({ annotations: { readOnlyHint: false } }))).toEqual({
      class: 'needs_decision',
      reason: 'annotation not read-only',
    })
    expect(outcome(definition({ description: 'Fetches a customer by id' }))).toEqual({
      class: 'needs_decision',
      reason: 'description silent',
    })
    expect(outcome(definition({ description: undefined }))).toEqual({
      class: 'needs_decision',
      reason: 'description silent',
    })
  })

  it('reads a non-boolean hint as absent-for-that-key: readOnlyHint "yes" is not read-only', () => {
    const annotations = { readOnlyHint: 'yes' } as unknown as ToolAnnotationHints
    expect(outcome(definition({ annotations }))).toEqual({
      class: 'needs_decision',
      reason: 'annotation not read-only',
    })
  })

  it('never reads an MCP default: an omitted destructiveHint is not a restrict signal', () => {
    expect(outcome(definition({ annotations: { readOnlyHint: true } }))).toEqual(READ)
  })

  it('demotes a drifted read tool ahead of the execute-shaped argument', () => {
    const drifted = definition({
      input_keys: ['$.sql'],
      baseline: { drifted: true, restored: false, present: true },
    })
    const classified = classifyDefinition(drifted)
    expect(classified.class).toBe('needs_decision')
    expect(classified.reason).toBe('baseline demoted')
    expect(classified.signals.demoted).toBe(true)
    expect(classified.signals.execute_shaped).toBe(true)
  })

  it('keeps a drifted restrict tool restrict, with demoted on the signals', () => {
    const classified = classifyDefinition(
      definition({
        name: 'delete_customer',
        annotations: { destructiveHint: true },
        baseline: { drifted: true, restored: false, present: true },
      }),
    )
    expect(classified.class).toBe('confident_restrict')
    expect(classified.reason).toBe('destructiveHint: true')
    expect(classified.signals.demoted).toBe(true)
  })

  it('demotes a restored tool unless its baseline is present', () => {
    expect(
      outcome(definition({ baseline: { drifted: false, restored: true, present: false } })),
    ).toEqual({ class: 'needs_decision', reason: 'baseline demoted' })
    expect(
      outcome(definition({ baseline: { drifted: false, restored: true, present: true } })),
    ).toEqual(READ)
    expect(
      outcome(definition({ baseline: { drifted: false, restored: false, present: false } })),
    ).toEqual(READ)
  })

  it('keeps accented letters as word characters on both sides of a lexicon word', () => {
    // Regression pins, not a difference from the oracle: U+00E9 is a letter in both engines.
    expect(outcome(definition({ description: 'Returns the déclear value' }))).toEqual(READ)
    expect(outcome(definition({ description: 'Übersicht; returns rows' }))).toEqual(READ)
  })
})

// ---------------------------------------------------------------------------
// The 73-definition oracle agreement (issue #487's measurement)
// ---------------------------------------------------------------------------

interface FixtureTool {
  readonly name: string
  readonly description: string
  readonly annotations: ToolAnnotationHints | undefined
  readonly input_keys: readonly string[]
  readonly expected: { readonly class: ClassifiedDefinition['class']; readonly reason: string }
}

interface Fixture {
  readonly oracle: string
  readonly servers: ReadonlyArray<{
    readonly file: string
    readonly server: string
    readonly tools: readonly FixtureTool[]
  }>
}

describe('classifyDefinition against the oracle fixture', () => {
  const fixture = JSON.parse(
    readFileSync(join(import.meta.dirname, '__fixtures__/g01-definitions.json'), 'utf-8'),
  ) as Fixture

  it('agrees with the oracle on every one of the 73 definitions, class and primary reason', () => {
    let count = 0
    for (const server of fixture.servers) {
      for (const tool of server.tools) {
        count += 1
        const got = classifyDefinition({
          name: tool.name,
          description: tool.description,
          annotations: tool.annotations,
          input_keys: tool.input_keys,
        })
        expect
          .soft({ class: got.class, reason: got.reason }, `${server.file} ${tool.name}`)
          .toEqual(tool.expected)
      }
    }
    expect(count).toBe(73)
  })

  it('reproduces the per-server M7 totals: 12, 1, 18, 0, 4', () => {
    const totals = fixture.servers.map(
      (server) =>
        server.tools.filter((tool) => {
          const got = classifyDefinition({
            name: tool.name,
            description: tool.description,
            annotations: tool.annotations,
            input_keys: tool.input_keys,
          })
          return got.class !== 'needs_decision'
        }).length,
    )
    expect(totals).toEqual([12, 1, 18, 0, 4])
  })
})
