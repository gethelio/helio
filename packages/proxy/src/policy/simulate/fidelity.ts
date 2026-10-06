// ---------------------------------------------------------------------------
// Fidelity (issue #488): what the replay could not verify, in the words of
// docs/policy-fidelity.md. The pin that ties a consumed row to the config
// that decided it, the historical limiter cross-check, the per-row marks'
// vocabulary (rule label, subject) and their aggregation into warnings.
// ---------------------------------------------------------------------------

import yaml from 'js-yaml'
import type { AuditRecord } from '../../audit/types.js'
import { ENV_VAR_PATTERN } from '../../config/loader.js'
import type { ConfigSource } from '../../config/loader.js'
import { ruleBucketKey, toolLimitKey } from '../bucket-key.js'
import { resolvePath } from '../matchers.js'
import type { RateLimiter } from '../rate-limiter.js'
import type { SpendLimiter } from '../spend-limiter.js'
import type { CompiledPolicyRule } from '../types.js'
import type { FidelityMark, FidelityWarning } from './types.js'

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** The `<rule>` of the first frozen sentence: the name, `rule[<index>]` when unnamed, `default` when none matched. */
export function ruleLabel(rule: CompiledPolicyRule | undefined): string {
  if (rule === undefined) return 'default'
  return rule.name ?? `rule[${String(rule.index)}]`
}

/** The `<subject>` of the first frozen sentence: the tool and its door or origin. */
export function subjectOf(tool: string, upstream: string | null, origin: string): string {
  if (origin !== 'mcp') return `tool "${tool}" on origin "${origin}"`
  if (upstream !== null) return `tool "${tool}" on door "${upstream}"`
  return `tool "${tool}"`
}

// ---------------------------------------------------------------------------
// The pin
// ---------------------------------------------------------------------------

/** The limiter key type `limits.key` and `max_spend.key` take, `tool` when absent. */
export type LimitKeyType = 'tool' | 'agent' | 'session' | 'sender_id'

const LIMIT_KEY_TYPES: readonly LimitKeyType[] = ['tool', 'agent', 'session', 'sender_id']

/** What the pin reads off the committing rule in the config that decided the row. */
export interface PinnedLimit {
  readonly keyType: LimitKeyType
  /** The literal `max_spend.field`; absent on a rate pin. */
  readonly field?: string
}

/** Resolves the live rule's key type and spend field for a consumed row, or nothing. */
export interface LimitPin {
  resolve(row: AuditRecord, kind: 'rate' | 'spend'): PinnedLimit | null
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function isLimitKeyType(value: unknown): value is LimitKeyType {
  return typeof value === 'string' && (LIMIT_KEY_TYPES as readonly string[]).includes(value)
}

/**
 * The pin over the config files handed to the run. A row pins when its
 * `config_sha256` equals a source's hash, that source loads as YAML (never
 * through the interpolating loader), and `policies.rules[matched_rule_index].limits`
 * yields the key type and, for a spend rule, a `max_spend.field` that is a
 * string the loader's `${NAME}` pattern does not match. A load that throws
 * pins nothing: "no list" is never read as "absent".
 */
export function createLimitPin(sources: readonly ConfigSource[]): LimitPin {
  const bySha = new Map(sources.map((source) => [source.sha256, source]))
  const loaded = new Map<string, unknown>()
  const documentOf = (sha256: string): unknown => {
    if (loaded.has(sha256)) return loaded.get(sha256)
    const source = bySha.get(sha256)
    let document: unknown = null
    if (source !== undefined) {
      try {
        document = yaml.load(source.raw)
      } catch {
        document = null
      }
    }
    loaded.set(sha256, document)
    return document
  }
  return {
    resolve(row, kind) {
      if (row.config_sha256 === null || row.matched_rule_index === null) return null
      const policies = asObject(asObject(documentOf(row.config_sha256))?.['policies'])
      const rules = policies?.['rules']
      if (!Array.isArray(rules)) return null
      const limits = asObject(asObject(rules[row.matched_rule_index])?.['limits'])
      if (limits === undefined) return null
      if (kind === 'rate') {
        const key = limits['key'] ?? 'tool'
        return isLimitKeyType(key) ? { keyType: key } : null
      }
      const maxSpend = asObject(limits['max_spend'])
      if (maxSpend === undefined) return null
      const field = maxSpend['field']
      if (typeof field !== 'string' || field.search(ENV_VAR_PATTERN) !== -1) return null
      const key = maxSpend['key'] ?? 'tool'
      return isLimitKeyType(key) ? { keyType: key, field } : null
    },
  }
}

// ---------------------------------------------------------------------------
// The historical limiter cross-check
// ---------------------------------------------------------------------------

/** The base key the live door built for a consumed row, per the fidelity page's table. */
function liveBaseKey(row: AuditRecord, keyType: LimitKeyType): string {
  if (keyType === 'session') return `session:${row.session_id ?? 'unknown'}`
  if (row.origin === 'mcp') return toolLimitKey(row.tool_name, row.upstream ?? undefined)
  if (keyType === 'sender_id') {
    const sender = row.metadata?.['sender_id']
    return `sender:${typeof sender === 'string' ? sender : 'unknown'}`
  }
  return toolLimitKey(row.tool_name)
}

function near(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-9
}

/**
 * The historical limiter track: every consumed row is recorded under the
 * LIVE parameters (the window and limit from the row's snapshot, the key
 * type and spend field from the pin, the rule index from the row), and the
 * post-append count or spend is compared to the snapshot the door kept. A
 * mismatch, a failed pin or an amount that does not resolve names the row
 * under `rate window` or `spend amount`, never with a cause.
 */
export class HistoricalTracker {
  constructor(
    private readonly rate: RateLimiter,
    private readonly spend: SpendLimiter,
    private readonly pin: LimitPin,
  ) {}

  /** Record one consumed row; the mark when the rebuild does not meet the snapshot. */
  record(row: AuditRecord, kind: 'rate' | 'spend', rule: string): FidelityMark | null {
    const mark: FidelityMark = {
      rule,
      dimension: kind === 'rate' ? 'rate window' : 'spend amount',
      subject: subjectOf(row.tool_name, row.upstream, row.origin),
    }
    const block = asObject(
      (row.evidence_chain ?? {})[kind === 'rate' ? 'rate_limit' : 'spend_limit'],
    )
    const windowMs = block?.['window_ms']
    const limit = block?.['limit']
    if (
      block === undefined ||
      typeof windowMs !== 'number' ||
      typeof limit !== 'number' ||
      row.matched_rule_index === null
    ) {
      return mark
    }
    const pinned = this.pin.resolve(row, kind)
    if (pinned === null) return mark
    const key = ruleBucketKey(liveBaseKey(row, pinned.keyType), row.matched_rule_index)
    if (kind === 'rate') {
      const result = this.rate.record({ key, maxCalls: limit, windowMs })
      return result.current === block['current'] ? null : mark
    }
    const amount =
      pinned.field === undefined ? undefined : resolvePath(pinned.field, row.tool_input)
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) return mark
    const result = this.spend.record({ key, amount, limit, windowMs })
    const stored = block['current_spend']
    return typeof stored === 'number' && near(result.currentSpend, stored) ? null : mark
  }
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/** One mark at one instant, before aggregation. */
export interface MarkedInstant {
  readonly mark: FidelityMark
  readonly instant: string
}

/** Aggregate marks by `(rule, dimension, subject)` in first-seen order, counting calls and keeping instants. */
export function aggregateWarnings(marks: Iterable<MarkedInstant>): readonly FidelityWarning[] {
  const groups = new Map<string, { readonly mark: FidelityMark; instants: string[] }>()
  for (const { mark, instant } of marks) {
    const key = `${mark.rule}\u0000${mark.dimension}\u0000${mark.subject}`
    const group = groups.get(key)
    if (group) group.instants.push(instant)
    else groups.set(key, { mark, instants: [instant] })
  }
  return [...groups.values()].map(({ mark, instants }) => ({
    ...mark,
    calls: instants.length,
    instants,
  }))
}
