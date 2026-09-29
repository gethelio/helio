import { extractAnnotations, extractTools, pickHints } from '../policy/tool-definitions.js'
import type { SurfaceTool } from '../policy/surface.js'

// ---------------------------------------------------------------------------
// From a raw tools/list body to the surface tools of one scanned door
// ---------------------------------------------------------------------------

/** A name the list repeats; its annotations are read as unset, as the cache reads them. */
export interface DuplicateTool {
  readonly name: string
  readonly count: number
}

export interface SurfaceToolsFromList {
  /** One entry per distinct name, in list order, never drifted (scan has no baseline). */
  readonly tools: ReadonlyArray<SurfaceTool>
  /** The first occurrence's raw definition per name, for the argument-candidate walk. */
  readonly definitions: ReadonlyMap<string, Record<string, unknown>>
  readonly duplicates: ReadonlyArray<DuplicateTool>
  /** Entries that were not an object with a string `name`. */
  readonly skipped: number
}

/**
 * Read a `tools/list` body the way the annotation cache reads it (the same
 * extractors), without a cache: a duplicate name is kept once with unset
 * annotations rather than minted as drift, and every entry is `drifted: false`.
 * Returns null when the body is not a tools/list result.
 */
export function surfaceToolsFromList(body: unknown): SurfaceToolsFromList | null {
  const entries = extractTools(body)
  if (entries === null) return null

  const definitions = new Map<string, Record<string, unknown>>()
  const counts = new Map<string, number>()
  let skipped = 0
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) {
      skipped += 1
      continue
    }
    const definition = entry as Record<string, unknown>
    const name = definition['name']
    if (typeof name !== 'string') {
      skipped += 1
      continue
    }
    counts.set(name, (counts.get(name) ?? 0) + 1)
    if (!definitions.has(name)) definitions.set(name, definition)
  }

  const tools: SurfaceTool[] = []
  const duplicates: DuplicateTool[] = []
  for (const [name, definition] of definitions) {
    const count = counts.get(name) ?? 1
    // A repeated name has no single definition: its hints are read as unset,
    // the fail-closed reading the governed path applies too.
    const annotations = count > 1 ? undefined : pickHints(extractAnnotations(definition))
    if (count > 1) duplicates.push({ name, count })
    tools.push({ name, annotations, current_annotations: annotations, drifted: false })
  }
  return { tools, definitions, duplicates, skipped }
}
