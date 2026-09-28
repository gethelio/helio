import type { ToolAnnotationHints } from './types.js'
import type { SurfaceTool } from './surface.js'
import { canonicalize } from '../util/canonical-json.js'
import { snapshotValue } from '../util/snapshot.js'

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
  /**
   * Present, unique tools whose definition equals the baseline in this
   * update (issue #60): the persistence hook confirms these without a
   * second pass over the list.
   */
  readonly confirmed: readonly string[]
}

interface BaselineEntry {
  /** The full tool definition object as first seen. */
  readonly definition: Record<string, unknown>
  /** Canonical JSON fingerprint of the full definition. */
  readonly definitionKey: string
  /** Annotations extracted from the baseline definition. */
  readonly annotations: ToolAnnotationHints | undefined
  /** True when the entry came from a persisted baseline, not a live list. */
  readonly restored: boolean
  /**
   * True until a live list names the tool. A pending entry is inert: it is
   * only a compare set, so `get()` answers undefined and the pipeline keeps
   * judging the tool on MCP defaults, exactly as on a door that never primed.
   */
  readonly pending: boolean
}

/**
 * One baseline as {@link ToolAnnotationCache.snapshotBaselines} reports it
 * (issue #60, `helio baseline list`): the flags the cache holds beside the
 * canonical JSON of the definition. Fresh objects; nothing aliases the cache.
 */
export interface BaselineSnapshot {
  readonly name: string
  /** The canonical JSON of the baseline definition. */
  readonly fingerprint: string
  /** Reloaded from disk and not since accepted. */
  readonly restored: boolean
  /** Restored and not yet named by a live list. */
  readonly pending: boolean
  /** Named by the most recent tools/list. */
  readonly present: boolean
  /** The current definition differs from the baseline. */
  readonly drifted: boolean
}

/** Why {@link ToolAnnotationCache.accept} refused. */
export type BaselineAcceptRefusal = 'unknown_tool' | 'not_drifted' | 'ambiguous_definition'

/** The outcome of {@link ToolAnnotationCache.accept}. */
export type BaselineAcceptResult =
  | { readonly ok: false; readonly reason: BaselineAcceptRefusal }
  | {
      readonly ok: true
      readonly previousFingerprint: string
      readonly fingerprint: string
      readonly changes: readonly ToolDriftChange[]
    }

/**
 * Baseline-and-diff cache for tool definitions from MCP tools/list responses.
 *
 * Each tool's entire definition is fingerprinted on first sight and diffed on
 * every subsequent tools/list. A definition that changes after baseline is
 * marked as drifted; policy evaluation sees the baseline annotations (the
 * ones the operator reviewed), and the GovernedForwarder gates calls to
 * drifted tools per policies.on_tool_drift. Baselines survive tool removal so
 * a remove/re-add cycle cannot reset them, and they persist across restarts
 * when a baseline store is attached (issue #60): {@link restore} reloads them
 * at boot, and a restored entry is inert until a live list names it. An
 * operator replaces a drifted baseline through {@link accept}.
 */
export class ToolAnnotationCache {
  private baselines = new Map<string, BaselineEntry>()
  private present = new Set<string>()
  private currentAnnotations = new Map<string, ToolAnnotationHints | undefined>()
  private currentDefinitions = new Map<string, Record<string, unknown>>()
  private driftedTools = new Map<string, ToolDriftEvent>()

  /** Number of tools present in the most recent tools/list. */
  get size(): number {
    return this.present.size
  }

  /** Diff a tools/list JSON-RPC response body against the baselines. */
  update(responseBody: unknown): ToolCacheUpdateResult {
    const tools = extractTools(responseBody)
    if (!tools) return EMPTY_UPDATE

    const baselined: string[] = []
    const drifted: ToolDriftEvent[] = []
    const reverted: string[] = []
    const confirmed: string[] = []
    const present = new Set<string>()
    const currentAnnotations = new Map<string, ToolAnnotationHints | undefined>()
    const currentDefinitions = new Map<string, Record<string, unknown>>()

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
        this.settlePending(name)
        continue
      }

      present.add(name)

      const annotations = extractAnnotations(t)
      currentAnnotations.set(name, annotations)
      currentDefinitions.set(name, t)
      const definitionKey = canonicalize(t)

      const baseline = this.baselines.get(name)
      if (!baseline) {
        this.baselines.set(name, {
          definition: t,
          definitionKey,
          annotations,
          restored: false,
          pending: false,
        })
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
        confirmed.push(name)
        this.settlePending(name)
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
      // The fingerprint changed but no known field did: report the whole
      // definitions so the audit trail still captures what moved.
      if (changes.length === 0) {
        changes.push({ aspect: 'other', baseline: baseline.definition, current: t })
      }

      const event: ToolDriftEvent = { toolName: name, changes }
      const existing = this.driftedTools.get(name)
      const isNewDrift = !existing || canonicalize(existing.changes) !== canonicalize(changes)
      this.driftedTools.set(name, event)
      if (isNewDrift) drifted.push(event)
      this.settlePending(name)
    }

    this.present = present
    this.currentAnnotations = currentAnnotations
    this.currentDefinitions = currentDefinitions
    return { updated: true, baselined, drifted, reverted, confirmed }
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
   * The cache keeps a snapshot of `toolDefinition`, so a caller that reuses
   * and rewrites its object cannot move the baseline (issue #380).
   */
  updateSingle(toolDefinition: unknown): ToolCacheUpdateResult {
    if (typeof toolDefinition !== 'object' || toolDefinition === null) {
      return EMPTY_UPDATE
    }
    const t = snapshotValue(toolDefinition) as Record<string, unknown>
    const name = t['name']
    if (typeof name !== 'string') {
      return EMPTY_UPDATE
    }

    const baselined: string[] = []
    const drifted: ToolDriftEvent[] = []
    const reverted: string[] = []
    const confirmed: string[] = []

    this.present.add(name)
    const annotations = extractAnnotations(t)
    this.currentAnnotations.set(name, annotations)
    this.currentDefinitions.set(name, t)
    const definitionKey = canonicalize(t)

    const baseline = this.baselines.get(name)
    if (!baseline) {
      this.baselines.set(name, {
        definition: t,
        definitionKey,
        annotations,
        restored: false,
        pending: false,
      })
      baselined.push(name)
      if (this.driftedTools.has(name)) {
        this.driftedTools.delete(name)
        reverted.push(name)
      }
      return { updated: true, baselined, drifted, reverted, confirmed }
    }

    if (definitionKey === baseline.definitionKey) {
      if (this.driftedTools.has(name)) {
        this.driftedTools.delete(name)
        reverted.push(name)
      }
      confirmed.push(name)
      this.settlePending(name)
      return { updated: true, baselined, drifted, reverted, confirmed }
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
    this.settlePending(name)

    return { updated: true, baselined, drifted, reverted, confirmed }
  }

  /**
   * Add persisted baselines for tools not already baselined (issue #60).
   * Fills `baselines` only: `present`, the current annotations and the
   * drift state describe live lists and stay untouched, so nothing restored
   * prints as listed and drift is recomputed by the first live list through
   * the normal compare. Each entry is pending, and inert, until a list names
   * it. A live baseline is never overwritten. Returns the number added.
   */
  restore(
    entries: readonly { readonly name: string; readonly definition: Record<string, unknown> }[],
  ): number {
    let added = 0
    for (const { name, definition } of entries) {
      if (this.baselines.has(name)) continue
      this.baselines.set(name, {
        definition,
        definitionKey: canonicalize(definition),
        annotations: extractAnnotations(definition),
        restored: true,
        pending: true,
      })
      added += 1
    }
    return added
  }

  /** Whether the tool's baseline came from the persisted store rather than a live list. */
  isRestored(toolName: string): boolean {
    return this.baselines.get(toolName)?.restored === true
  }

  /**
   * Replace a drifted tool's baseline with its current definition (issue
   * #60, `helio baseline accept`). Refuses a tool absent from the latest
   * list, one that is not drifted, and one the list names more than once
   * (an ambiguous definition is never accepted). On success the drift state
   * is dropped, the promoted definition is a snapshot, and the returned
   * `changes` are the drift event's, for the audit record.
   */
  accept(toolName: string): BaselineAcceptResult {
    const check = this.peekAccept(toolName)
    if (!check.ok) return check
    const drift = this.driftedTools.get(toolName)
    const previous = this.baselines.get(toolName)
    // peekAccept answered ok, so both exist; the guard keeps the types
    // honest without a cast.
    if (drift === undefined || previous === undefined) {
      return { ok: false, reason: 'unknown_tool' }
    }
    const definition = snapshotValue(check.current)
    const definitionKey = canonicalize(definition)
    this.baselines.set(toolName, {
      definition,
      definitionKey,
      annotations: extractAnnotations(definition),
      restored: false,
      pending: false,
    })
    this.driftedTools.delete(toolName)
    return {
      ok: true,
      previousFingerprint: previous.definitionKey,
      fingerprint: definitionKey,
      changes: drift.changes,
    }
  }

  /**
   * The checks of {@link accept} without its effects, plus the current
   * definition that an acceptance would promote: the persistence layer
   * writes it before the cache moves.
   */
  peekAccept(
    toolName: string,
  ):
    | { readonly ok: false; readonly reason: BaselineAcceptRefusal }
    | { readonly ok: true; readonly current: Record<string, unknown> } {
    if (!this.present.has(toolName)) return { ok: false, reason: 'unknown_tool' }
    const drift = this.driftedTools.get(toolName)
    if (!drift) return { ok: false, reason: 'not_drifted' }
    if (drift.changes.some((change) => change.aspect === 'duplicate')) {
      return { ok: false, reason: 'ambiguous_definition' }
    }
    const current = this.currentDefinitions.get(toolName)
    if (current === undefined) return { ok: false, reason: 'unknown_tool' }
    return { ok: true, current }
  }

  /**
   * The baseline definition and fingerprint of each named tool that has one,
   * in the order given, as the persistence layer inserts them (issue #60).
   * Unknown names are skipped.
   */
  baselineRows(names: readonly string[]): readonly {
    readonly tool: string
    readonly definition: Record<string, unknown>
    readonly fingerprint: string
  }[] {
    const rows: { tool: string; definition: Record<string, unknown>; fingerprint: string }[] = []
    for (const name of names) {
      const entry = this.baselines.get(name)
      if (entry)
        rows.push({ tool: name, definition: entry.definition, fingerprint: entry.definitionKey })
    }
    return rows
  }

  /**
   * Drop baselines that could not be persisted (issue #60), so the next
   * list baselines them again and the persistence write is retried. The
   * names leave `present` and the current maps too, so the door stays
   * fail-closed on them until the write succeeds. Called only with the
   * names a failed first-sight insert covered; those carry no drift state.
   */
  forgetBaselines(names: readonly string[]): void {
    for (const name of names) {
      this.baselines.delete(name)
      this.present.delete(name)
      this.currentAnnotations.delete(name)
      this.currentDefinitions.delete(name)
    }
  }

  /** A live list named the tool: its baseline is no longer pending. */
  private settlePending(name: string): void {
    const entry = this.baselines.get(name)
    if (entry?.pending) this.baselines.set(name, { ...entry, pending: false })
  }

  /**
   * Get the **baseline** annotations for a tool: the definition first seen
   * (or restored and since named by a live list), not the latest upstream
   * claim. Returns `undefined` if the tool has no annotations, was never
   * seen, or was restored and no live list has named it yet.
   */
  get(toolName: string): ToolAnnotationHints | undefined {
    const entry = this.baselines.get(toolName)
    if (entry === undefined || entry.pending) return undefined
    return entry.annotations
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

  /**
   * The tools present in the most recent tools/list, as snapshots for the
   * authority surface (issue #396). Each entry's `annotations` (the baseline)
   * and `current_annotations` (the latest claim) are fresh objects carrying
   * the four MCP hints picked by key, so nothing returned references a
   * cache-held object (the #380 constraint); `get()` and `getCurrent()` are
   * unchanged. Every present key is copied whatever its value, so coverage
   * sees exactly what `matchAnnotations` sees. Not `snapshotValue`: its
   * last-resort branch returns the caller's reference.
   */
  snapshotTools(): readonly SurfaceTool[] {
    const tools: SurfaceTool[] = []
    for (const name of this.present) {
      tools.push({
        name,
        annotations: pickHints(this.baselines.get(name)?.annotations),
        current_annotations: pickHints(this.currentAnnotations.get(name)),
        drifted: this.driftedTools.has(name),
      })
    }
    return tools
  }

  /**
   * Every baseline the cache holds, sorted by name, with its flags (issue
   * #60, `helio baseline list`). Unlike {@link snapshotTools}, which walks
   * the most recent list, this walks the baselines: a restored entry no
   * live list has named yet, a tool the upstream removed, and a drifted
   * tool a later list omitted all appear. Each entry is a fresh object.
   */
  snapshotBaselines(): readonly BaselineSnapshot[] {
    const names = [...this.baselines.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    return names.map((name) => {
      // The map holds every sorted key; the guard keeps the type honest.
      const entry = this.baselines.get(name)
      return {
        name,
        fingerprint: entry?.definitionKey ?? '',
        restored: entry?.restored ?? false,
        pending: entry?.pending ?? false,
        present: this.present.has(name),
        drifted: this.driftedTools.has(name),
      }
    })
  }
}

/** The four MCP hint keys `matchAnnotations` reads. */
const HINT_KEYS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const

/** The result of an update whose body was not a tools/list response. */
const EMPTY_UPDATE: ToolCacheUpdateResult = {
  updated: false,
  baselined: [],
  drifted: [],
  reverted: [],
  confirmed: [],
}

/**
 * Pick the four hints onto a fresh object. A present key is copied whatever
 * its value (a nested object value is shared, a stated residual that
 * `matchAnnotations` never dereferences); an absent source stays undefined.
 */
function pickHints(source: ToolAnnotationHints | undefined): ToolAnnotationHints | undefined {
  if (source === undefined) return undefined
  const picked: Record<string, unknown> = {}
  for (const key of HINT_KEYS) {
    if (key in source) picked[key] = source[key]
  }
  return picked as ToolAnnotationHints
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
