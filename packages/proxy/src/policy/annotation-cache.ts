import type { ToolAnnotationHints } from './types.js'
import { canonicalize } from '../util/canonical-json.js'

/** Aspects of a tool definition reported in drift events. */
export type ToolDriftAspect =
  | 'annotations'
  | 'inputSchema'
  | 'description'
  | 'outputSchema'
  | 'title'
  | 'duplicate'
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

    // First pass: collect valid (name, definition) entries and count names so
    // duplicates can be handled per-NAME, not per-occurrence. Last-write-wins
    // per-occurrence processing lets a malicious entry's drift be cleared by a
    // benign duplicate in the same payload — a fail-open bypass.
    const entries: Array<{ name: string; definition: Record<string, unknown> }> = []
    const nameCounts = new Map<string, number>()
    for (const tool of tools) {
      if (typeof tool !== 'object' || tool === null) continue
      const t = tool as Record<string, unknown>
      const name = t['name']
      if (typeof name !== 'string') continue
      entries.push({ name, definition: t })
      nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1)
    }

    // Track names already resolved as duplicates so their per-occurrence
    // entries are skipped in the unique-name pass.
    const duplicateNames = new Set<string>()

    for (const { name, definition: t } of entries) {
      const isDuplicate = (nameCounts.get(name) ?? 0) > 1
      if (isDuplicate) {
        present.add(name)
        // Unknown annotations → forwarder's MCP fail-closed defaults apply.
        currentAnnotations.set(name, undefined)
        if (duplicateNames.has(name)) continue
        duplicateNames.add(name)

        const baseline = this.baselines.get(name)
        const allDefinitions = entries.filter((e) => e.name === name).map((e) => e.definition)
        const changes: ToolDriftChange[] = [
          {
            aspect: 'duplicate',
            baseline: baseline?.definition,
            current: allDefinitions,
          },
        ]
        const event: ToolDriftEvent = { toolName: name, changes }
        const existing = this.driftedTools.get(name)
        const isNewDrift = !existing || canonicalize(existing.changes) !== canonicalize(changes)
        this.driftedTools.set(name, event)
        if (isNewDrift) drifted.push(event)
        continue
      }

      present.add(name)

      const annotations = extractAnnotations(t)
      currentAnnotations.set(name, annotations)
      const definitionKey = canonicalize(t)

      const baseline = this.baselines.get(name)
      if (!baseline) {
        this.baselines.set(name, { definition: t, definitionKey, annotations })
        baselined.push(name)
        // A tool first seen via duplicates (drifted, never baselined) that now
        // arrives unique must not stay drifted forever — clear and report it.
        if (this.driftedTools.has(name)) {
          this.driftedTools.delete(name)
          reverted.push(name)
        }
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
   * Incrementally merge a single tool definition into the cache (issue #12, D6).
   *
   * Unlike {@link update}, this touches only the named tool: it adds to (never
   * rebuilds) the `present` set and `currentAnnotations` map. The sideband
   * governance path feeds adapter-origin tools one definition at a time (each
   * `/evaluate` carries at most one), so routing them through the whole-list
   * `update()` would wipe every other tool's current-annotation snapshot on
   * each call and silently degrade the stricter-of-both log-mode drift
   * evaluation. The MCP whole-list path is unaffected — it keeps calling
   * `update()`. Each origin owns its own cache instance, so the accumulate
   * semantics here never mix with update()'s replace semantics.
   *
   * `toolDefinition` must already be in MCP shape (`inputSchema`/`outputSchema`
   * camelCase); the governance service maps the wire `tool` object before
   * calling. Returns the same result shape as `update()` (for one tool).
   */
  updateSingle(toolDefinition: unknown): ToolCacheUpdateResult {
    if (typeof toolDefinition !== 'object' || toolDefinition === null) {
      return { updated: false, baselined: [], drifted: [], reverted: [] }
    }
    const t = toolDefinition as Record<string, unknown>
    const name = t['name']
    if (typeof name !== 'string') {
      return { updated: false, baselined: [], drifted: [], reverted: [] }
    }

    const baselined: string[] = []
    const drifted: ToolDriftEvent[] = []
    const reverted: string[] = []

    this.present.add(name)
    const annotations = extractAnnotations(t)
    this.currentAnnotations.set(name, annotations)
    const definitionKey = canonicalize(t)

    const baseline = this.baselines.get(name)
    if (!baseline) {
      this.baselines.set(name, { definition: t, definitionKey, annotations })
      baselined.push(name)
      if (this.driftedTools.has(name)) {
        this.driftedTools.delete(name)
        reverted.push(name)
      }
      return { updated: true, baselined, drifted, reverted }
    }

    if (definitionKey === baseline.definitionKey) {
      if (this.driftedTools.has(name)) {
        this.driftedTools.delete(name)
        reverted.push(name)
      }
      return { updated: true, baselined, drifted, reverted }
    }

    const changes: ToolDriftChange[] = []
    for (const field of ASPECT_FIELDS) {
      const baselineValue = baseline.definition[field]
      const currentValue = t[field]
      if (canonicalize(baselineValue) !== canonicalize(currentValue)) {
        changes.push({ aspect: field, baseline: baselineValue, current: currentValue })
      }
    }
    if (changes.length === 0) {
      changes.push({ aspect: 'other', baseline: baseline.definition, current: t })
    }

    const event: ToolDriftEvent = { toolName: name, changes }
    const existing = this.driftedTools.get(name)
    const isNewDrift = !existing || canonicalize(existing.changes) !== canonicalize(changes)
    this.driftedTools.set(name, event)
    if (isNewDrift) drifted.push(event)

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
