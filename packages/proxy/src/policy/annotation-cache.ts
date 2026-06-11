import type { ToolAnnotationHints } from './types.js'

/** Aspects of a tool definition reported in drift events. */
export type ToolDriftAspect =
  | 'annotations'
  | 'inputSchema'
  | 'description'
  | 'outputSchema'
  | 'title'
  | 'other'

/** Tool definition fields diffed individually for drift reporting. */
const ASPECT_FIELDS = [
  'annotations',
  'inputSchema',
  'description',
  'outputSchema',
  'title',
] as const

/** A single changed aspect of a tool definition relative to its baseline. */
export interface ToolDriftChange {
  readonly aspect: ToolDriftAspect
  readonly baseline: unknown
  readonly current: unknown
}

/** Drift detected for one tool between its baseline and the latest tools/list. */
export interface ToolDriftEvent {
  readonly toolName: string
  readonly changes: readonly ToolDriftChange[]
}

/** Result of updating the cache from a tools/list response body. */
export interface ToolCacheUpdateResult {
  /** True when the body was a valid tools/list response and state was updated. */
  readonly updated: boolean
  /** Tools seen for the first time in this update (baselined, not drift). */
  readonly baselined: readonly string[]
  /** Newly detected (or newly changed) drift events from this update. */
  readonly drifted: readonly ToolDriftEvent[]
  /** Previously drifted tools whose definition returned to baseline. */
  readonly reverted: readonly string[]
}

interface BaselineEntry {
  /** The full tool definition object as first seen. */
  readonly definition: Record<string, unknown>
  /** Canonical JSON fingerprint of the full definition. */
  readonly definitionKey: string
  /** Annotations extracted from the baseline definition. */
  readonly annotations: ToolAnnotationHints | undefined
}

/**
 * Baseline-and-diff cache for tool definitions from MCP tools/list responses.
 *
 * Each tool's entire definition is fingerprinted on first sight and diffed on
 * every subsequent tools/list. A definition that changes after baseline is
 * marked as drifted; policy evaluation sees the baseline annotations (the
 * ones the operator reviewed), and the GovernedForwarder gates calls to
 * drifted tools per policies.on_tool_drift. Baselines survive tool removal so
 * a remove/re-add cycle cannot reset them; they reset only on process restart
 * (re-prime).
 */
export class ToolAnnotationCache {
  private baselines = new Map<string, BaselineEntry>()
  private present = new Set<string>()
  private currentAnnotations = new Map<string, ToolAnnotationHints | undefined>()
  private driftedTools = new Map<string, ToolDriftEvent>()

  /** Number of tools present in the most recent tools/list. */
  get size(): number {
    return this.present.size
  }

  /** Diff a tools/list JSON-RPC response body against the baselines. */
  update(responseBody: unknown): ToolCacheUpdateResult {
    const tools = extractTools(responseBody)
    if (!tools) return { updated: false, baselined: [], drifted: [], reverted: [] }

    const baselined: string[] = []
    const drifted: ToolDriftEvent[] = []
    const reverted: string[] = []
    const present = new Set<string>()
    const currentAnnotations = new Map<string, ToolAnnotationHints | undefined>()

    for (const tool of tools) {
      if (typeof tool !== 'object' || tool === null) continue
      const t = tool as Record<string, unknown>
      const name = t['name']
      if (typeof name !== 'string') continue
      present.add(name)

      const annotations = extractAnnotations(t)
      currentAnnotations.set(name, annotations)
      const definitionKey = canonicalize(t)

      const baseline = this.baselines.get(name)
      if (!baseline) {
        this.baselines.set(name, { definition: t, definitionKey, annotations })
        baselined.push(name)
        continue
      }

      if (definitionKey === baseline.definitionKey) {
        if (this.driftedTools.has(name)) {
          this.driftedTools.delete(name)
          reverted.push(name)
        }
        continue
      }

      const changes: ToolDriftChange[] = []
      for (const field of ASPECT_FIELDS) {
        const baselineValue = baseline.definition[field]
        const currentValue = t[field]
        if (canonicalize(baselineValue) !== canonicalize(currentValue)) {
          changes.push({ aspect: field, baseline: baselineValue, current: currentValue })
        }
      }
      // The fingerprint changed but no known field did — report the whole
      // definitions so the audit trail still captures what moved.
      if (changes.length === 0) {
        changes.push({ aspect: 'other', baseline: baseline.definition, current: t })
      }

      const event: ToolDriftEvent = { toolName: name, changes }
      const existing = this.driftedTools.get(name)
      const isNewDrift = !existing || canonicalize(existing.changes) !== canonicalize(changes)
      this.driftedTools.set(name, event)
      if (isNewDrift) drifted.push(event)
    }

    this.present = present
    this.currentAnnotations = currentAnnotations
    return { updated: true, baselined, drifted, reverted }
  }

  /**
   * Get the **baseline** annotations for a tool — the definition first seen,
   * not the latest upstream claim. Returns `undefined` if the tool has no
   * annotations or was never seen.
   */
  get(toolName: string): ToolAnnotationHints | undefined {
    return this.baselines.get(toolName)?.annotations
  }

  /**
   * Get the annotations from the most recent tools/list. Used for the
   * stricter-of-both evaluation of drifted tools in on_tool_drift: log mode.
   * Returns `undefined` for tools absent from the latest list.
   */
  getCurrent(toolName: string): ToolAnnotationHints | undefined {
    return this.currentAnnotations.get(toolName)
  }

  /** Whether the tool was present in the most recent tools/list. */
  has(toolName: string): boolean {
    return this.present.has(toolName)
  }

  /** Whether the tool's current definition differs from its baseline. */
  isDrifted(toolName: string): boolean {
    return this.driftedTools.has(toolName)
  }

  /** The active drift event for a tool, if any. */
  getDrift(toolName: string): ToolDriftEvent | undefined {
    return this.driftedTools.get(toolName)
  }
}

/** Extract the annotations object from a raw tool definition. */
function extractAnnotations(tool: Record<string, unknown>): ToolAnnotationHints | undefined {
  const annotations = tool['annotations']
  return annotations && typeof annotations === 'object'
    ? (annotations as ToolAnnotationHints)
    : undefined
}

/** Deterministic JSON encoding with recursively sorted object keys. */
function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value))
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) {
      out[key] = sortKeysDeep(source[key])
    }
    return out
  }
  return value
}

/**
 * Extract the tools array from a JSON-RPC response body.
 *
 * Expected shape: `{ result: { tools: [...] } }`
 * Returns null if the shape doesn't match.
 */
function extractTools(body: unknown): unknown[] | null {
  if (typeof body !== 'object' || body === null) return null
  const b = body as Record<string, unknown>
  const result = b['result']
  if (typeof result !== 'object' || result === null) return null
  const r = result as Record<string, unknown>
  const tools = r['tools']
  if (!Array.isArray(tools)) return null
  return tools as unknown[]
}
