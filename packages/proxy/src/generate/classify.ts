import { extractAnnotations, HINT_KEYS, pickHints } from '../policy/tool-definitions.js'
import type { ToolAnnotationHints } from '../policy/types.js'

// ---------------------------------------------------------------------------
// The G-01 predicate (issue #487, shipped by issue #522): a tool definition's
// class from its name, its description, the hints it PRESENTS and the shape of
// its arguments. Frequency never enters; no MCP default is ever read; the
// result is eligibility for a candidate a person confirms, never an action.
// Pure: no I/O, no clock.
// ---------------------------------------------------------------------------

/** First-token READ lexicon (frozen before the sample was read). */
export const NAME_READ = [
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
] as const

/** First-token WRITE lexicon. */
export const NAME_WRITE = [
  'create',
  'add',
  'insert',
  'update',
  'set',
  'write',
  'edit',
  'put',
  'post',
  'send',
  'push',
  'upload',
  'move',
  'rename',
  'merge',
  'publish',
] as const

/** First-token DESTROY lexicon. */
export const NAME_DESTROY = [
  'delete',
  'remove',
  'drop',
  'destroy',
  'purge',
  'clear',
  'reset',
  'truncate',
] as const

/** First-token EXEC lexicon. */
export const NAME_EXEC = [
  'run',
  'execute',
  'exec',
  'eval',
  'invoke',
  'call',
  'shell',
  'command',
] as const

/** Lexicon words that are ordinary English inside a sentence and so never read from a description. */
export const DESCRIPTION_SKIP = ['type', 'call', 'set'] as const

/** Description phrases that restrict on their own. */
export const IRREVERSIBILITY_MARKERS = [
  'overwrite',
  'permanent',
  'irreversible',
  'cannot be undone',
] as const

/** Description phrases that read as a read-only promise. */
export const READ_MARKERS = ['read-only', 'does not modify', 'returns'] as const

/** The last path segment of an argument that carries code or a statement. */
export const EXECUTE_SHAPED_SEGMENTS = [
  'command',
  'shell',
  'script',
  'sql',
  'statement',
  'raw_query',
  'code',
  'expression',
] as const

/** Literal namespace prefixes stripped from a name, in this order, each when the remainder starts with it. */
export const NAMESPACE_PREFIXES = ['github.', 'browser_'] as const

/** The `mcp__<server>__` prefix some clients prepend to a tool name. */
export const MCP_SERVER_PREFIX = /^mcp__[^_]+(?:_[^_]+)*__/

/** The nine needs-decision reasons, in the order the first that holds is reported. */
export const NEEDS_DECISION_REASONS = [
  'baseline demoted',
  'execute-shaped argument',
  'description disagrees',
  'open-world read',
  'write-class name',
  'unknown name',
  'hints absent',
  'annotation not read-only',
  'description silent',
] as const

/** The one primary reason a classified definition carries; every printed reason is one of these. */
export type GenerationReason =
  | (typeof NEEDS_DECISION_REASONS)[number]
  | 'destructiveHint: true'
  | 'destroy-class name'
  | 'execute-class name'
  | 'destructive description'
  | 'name, hint and description agree'

/** The running proxy's baseline state for a pair; absent when the caller has none. */
export interface GenerationBaseline {
  readonly drifted: boolean
  readonly restored: boolean
  readonly present: boolean
}

/** A listed tool definition as the classifier reads it. */
export interface GenerationDefinition {
  readonly name: string
  readonly description: string | undefined
  /** The raw annotations object as listed, or undefined; read through pickHints(), never a default. */
  readonly annotations: ToolAnnotationHints | undefined
  /** Property paths of inputSchema (objects to depth 3, arrays not walked), as `$.a.b`. */
  readonly input_keys: readonly string[]
  readonly baseline?: GenerationBaseline
}

export type GenerationClass = 'confident_read' | 'confident_restrict' | 'needs_decision'

/** The four signals and their reads, carried beside the class for the report's JSON. */
export interface GenerationSignals {
  readonly first_token: string
  readonly name_class: 'read' | 'write' | 'destroy' | 'exec' | 'unknown'
  readonly annotation_class: 'read' | 'restrict' | 'none'
  readonly description_class: 'read' | 'write' | 'restrict' | 'none'
  readonly open_world: boolean
  readonly execute_shaped: boolean
  readonly demoted: boolean
}

export interface ClassifiedDefinition {
  readonly class: GenerationClass
  readonly reason: GenerationReason
  readonly signals: GenerationSignals
}

// ---------------------------------------------------------------------------
// The reads
// ---------------------------------------------------------------------------

/**
 * The first token of a tool name: one `mcp__<server>__` prefix stripped,
 * then each literal namespace prefix in order, camelCase split, the first
 * piece before `_`, `-` or `.`, lowercased.
 */
export function firstToken(name: string): string {
  let rest = name.replace(MCP_SERVER_PREFIX, '')
  for (const prefix of NAMESPACE_PREFIXES) {
    if (rest.startsWith(prefix)) rest = rest.slice(prefix.length)
  }
  rest = rest.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
  return (rest.split(/[_\-.]/)[0] ?? '').toLowerCase()
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Whole-word, case-insensitive, Unicode-aware: the word bounded by anything but a letter, a digit or `_`. */
function hasWholeWord(description: string, word: string): boolean {
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(word)}(?![\\p{L}\\p{N}_])`, 'iu').test(
    description,
  )
}

function hasAnyWord(description: string, words: readonly string[]): boolean {
  return words.some((word) => hasWholeWord(description, word))
}

const DESCRIPTION_WRITE = NAME_WRITE.filter(
  (w) => !(DESCRIPTION_SKIP as readonly string[]).includes(w),
)
const DESCRIPTION_RESTRICT = [...NAME_DESTROY, ...NAME_EXEC].filter(
  (w) => !(DESCRIPTION_SKIP as readonly string[]).includes(w),
)

function nameClass(token: string): GenerationSignals['name_class'] {
  if ((NAME_READ as readonly string[]).includes(token)) return 'read'
  if ((NAME_WRITE as readonly string[]).includes(token)) return 'write'
  if ((NAME_DESTROY as readonly string[]).includes(token)) return 'destroy'
  if ((NAME_EXEC as readonly string[]).includes(token)) return 'exec'
  return 'unknown'
}

function descriptionClass(description: string): GenerationSignals['description_class'] {
  if (
    hasAnyWord(description, DESCRIPTION_RESTRICT) ||
    hasAnyWord(description, IRREVERSIBILITY_MARKERS)
  )
    return 'restrict'
  if (hasAnyWord(description, DESCRIPTION_WRITE)) return 'write'
  const initial = /^[\p{L}\p{N}_]+/u.exec(description)?.[0].toLowerCase()
  if (
    hasAnyWord(description, READ_MARKERS) ||
    (initial !== undefined && (NAME_READ as readonly string[]).includes(initial))
  )
    return 'read'
  return 'none'
}

function lastSegment(path: string): string {
  return path.slice(path.lastIndexOf('.') + 1)
}

// ---------------------------------------------------------------------------
// The input walker (the shape the #487 dumps recorded)
// ---------------------------------------------------------------------------

const MAX_DEPTH = 3

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function typesOf(schema: Record<string, unknown>): readonly string[] {
  const type = schema['type']
  if (typeof type === 'string') return [type]
  if (Array.isArray(type)) return type.filter((t): t is string => typeof t === 'string')
  return []
}

function walkKeys(schema: unknown, prefix: string, depth: number, out: string[]): void {
  if (depth > MAX_DEPTH) return
  const properties = asRecord(asRecord(schema)?.['properties'])
  if (properties === undefined) return
  for (const [name, raw] of Object.entries(properties)) {
    const property = asRecord(raw)
    if (property === undefined) continue
    const path = `${prefix}.${name}`
    out.push(path)
    if (typesOf(property).includes('object')) walkKeys(property, path, depth + 1, out)
  }
}

/**
 * The property paths of an `inputSchema`, as `$.a.b`: objects are walked to
 * depth 3 (a union `type` that includes `object` descends), arrays never, a
 * property that is not an object is skipped.
 */
export function inputKeyPaths(inputSchema: unknown): readonly string[] {
  const out: string[] = []
  walkKeys(inputSchema, '$', 1, out)
  return out
}

/** A listed MCP tool object (one entry of `tools/list`) as a definition the classifier reads. */
export function definitionFromListed(tool: Record<string, unknown>): GenerationDefinition {
  return {
    name: typeof tool['name'] === 'string' ? tool['name'] : '',
    description: typeof tool['description'] === 'string' ? tool['description'] : undefined,
    annotations: extractAnnotations(tool),
    input_keys: inputKeyPaths(tool['inputSchema']),
  }
}

// ---------------------------------------------------------------------------
// The predicate
// ---------------------------------------------------------------------------

/**
 * Classify one definition under the frozen lexicons. A restrict signal from
 * any one source restricts; a read candidate needs the name, the presented
 * hint and the description to agree with nothing demoting it; everything
 * else needs a decision, with the first reason that holds.
 */
export function classifyDefinition(def: GenerationDefinition): ClassifiedDefinition {
  const description = def.description ?? ''
  const hints = pickHints(def.annotations)
  const annotation: GenerationSignals['annotation_class'] =
    hints?.destructiveHint === true ? 'restrict' : hints?.readOnlyHint === true ? 'read' : 'none'
  const openWorld = hints?.openWorldHint === true
  const hintsAbsent = hints === undefined || !HINT_KEYS.some((key) => key in hints)
  const token = firstToken(def.name)
  const name = nameClass(token)
  const desc = descriptionClass(description)
  const executeShaped = def.input_keys.some((key) =>
    (EXECUTE_SHAPED_SEGMENTS as readonly string[]).includes(lastSegment(key)),
  )
  const baseline = def.baseline
  const demoted =
    baseline !== undefined && (baseline.drifted || (baseline.restored && !baseline.present))
  const signals: GenerationSignals = {
    first_token: token,
    name_class: name,
    annotation_class: annotation,
    description_class: desc,
    open_world: openWorld,
    execute_shaped: executeShaped,
    demoted,
  }
  if (annotation === 'restrict' || name === 'destroy' || name === 'exec' || desc === 'restrict') {
    const reason: GenerationReason =
      annotation === 'restrict'
        ? 'destructiveHint: true'
        : name === 'destroy'
          ? 'destroy-class name'
          : name === 'exec'
            ? 'execute-class name'
            : 'destructive description'
    return { class: 'confident_restrict', reason, signals }
  }
  if (
    annotation === 'read' &&
    name === 'read' &&
    desc === 'read' &&
    !executeShaped &&
    !openWorld &&
    !demoted
  ) {
    return { class: 'confident_read', reason: 'name, hint and description agree', signals }
  }
  const reason: GenerationReason = demoted
    ? 'baseline demoted'
    : executeShaped
      ? 'execute-shaped argument'
      : desc === 'write' && name === 'read'
        ? 'description disagrees'
        : openWorld && name === 'read'
          ? 'open-world read'
          : name === 'write'
            ? 'write-class name'
            : name === 'unknown'
              ? 'unknown name'
              : hintsAbsent
                ? 'hints absent'
                : annotation === 'none'
                  ? 'annotation not read-only'
                  : 'description silent'
  return { class: 'needs_decision', reason, signals }
}
