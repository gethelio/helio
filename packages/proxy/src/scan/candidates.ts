// ---------------------------------------------------------------------------
// Argument candidates (issue #299): deterministic name-and-type rules over a
// tool's inputSchema naming the arguments a `budgets` contributor, a
// `spend_limit` or an `input` matcher could read. Candidates, never
// certainties: the docs table says so, and the scaffold writes them commented.
// ---------------------------------------------------------------------------

export type CandidateKind = 'amount' | 'path' | 'url' | 'sql'

export interface ArgumentCandidate {
  readonly kind: CandidateKind
  /** The `$.a.b` dot-path the `input` matcher resolves. */
  readonly path: string
  /** Which door admitted it: the name-and-type rule, `format: uri|url`, or a `query` described as SQL. */
  readonly by: 'name' | 'format' | 'description'
}

const KINDS: readonly CandidateKind[] = ['amount', 'path', 'url', 'sql']

/** Whole words, `_`-delimited, case-insensitive. */
const NAMES: Readonly<Record<CandidateKind, RegExp>> = {
  amount:
    /(^|_)(amount|amt|total|subtotal|price|cost|fee|fees|sum|budget|quantity|qty|cents)(_|$)/i,
  path: /(^|_)(path|paths|file|files|filename|filepath|dir|directory|folder|cwd|source|destination)(_|$)/i,
  url: /(^|_)(url|urls|uri|href|endpoint|link|webhook|callback)(_|$)/i,
  sql: /(^|_)(sql|statement|raw_query)(_|$)/i,
}

const TYPES: Readonly<Record<CandidateKind, readonly string[]>> = {
  amount: ['number', 'integer'],
  path: ['string'],
  url: ['string'],
  sql: ['string'],
}

const MAX_DEPTH = 3

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** The schema's `type` as a list: a string, a list of strings, or nothing. */
function typesOf(schema: Record<string, unknown>): readonly string[] {
  const type = schema['type']
  if (typeof type === 'string') return [type]
  if (Array.isArray(type)) return type.filter((t): t is string => typeof t === 'string')
  return []
}

function typeQualifies(kind: CandidateKind, property: Record<string, unknown>): boolean {
  const types = typesOf(property)
  if (types.some((t) => TYPES[kind].includes(t))) return true
  // An array of strings under a path name is itself the path argument
  // (the filesystem server's `paths`); elements are never walked.
  if (kind === 'path' && types.includes('array')) {
    const items = asRecord(property['items'])
    return items !== undefined && typesOf(items).includes('string')
  }
  return false
}

function walk(schema: unknown, prefix: string, depth: number, out: ArgumentCandidate[]): void {
  if (depth > MAX_DEPTH) return
  const properties = asRecord(asRecord(schema)?.['properties'])
  if (properties === undefined) return
  for (const [name, raw] of Object.entries(properties)) {
    const property = asRecord(raw)
    if (property === undefined) continue
    const path = `${prefix}.${name}`
    const format = property['format']
    const description = property['description']
    for (const kind of KINDS) {
      if (NAMES[kind].test(name) && typeQualifies(kind, property)) {
        out.push({ kind, path, by: 'name' })
      } else if (
        kind === 'url' &&
        (format === 'uri' || format === 'url') &&
        typesOf(property).includes('string')
      ) {
        out.push({ kind, path, by: 'format' })
      } else if (
        kind === 'sql' &&
        name === 'query' &&
        typesOf(property).includes('string') &&
        typeof description === 'string' &&
        /\bsql\b/i.test(description)
      ) {
        out.push({ kind, path, by: 'description' })
      }
    }
    if (typesOf(property).includes('object')) walk(property, path, depth + 1, out)
  }
}

/**
 * The argument candidates of one tool's `inputSchema`, in property order,
 * kinds in the order amount, path, URL, SQL. Objects are walked three levels
 * deep as `$.a.b`; array elements are never walked, so an array of objects
 * (GitHub's `push_files`) yields nothing. A missing or non-object schema
 * yields nothing.
 */
export function candidatesOf(inputSchema: unknown): ArgumentCandidate[] {
  const out: ArgumentCandidate[] = []
  walk(inputSchema, '$', 1, out)
  return out
}
