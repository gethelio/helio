import picomatch from 'picomatch'
import { parseDuration } from '../config/schema.js'
import type { BudgetConfig, BudgetsConfig } from '../config/schema.js'
import { compileApproval } from '../policy/parser.js'
import type { CompiledBudget, CompiledBudgetContributor } from './types.js'

/** Default idle TTL for `window: session` pots when `idle_ttl` is omitted. */
const DEFAULT_IDLE_TTL_MS = 86_400_000 // 24h

/** A budget failed to compile (invalid contributor glob). */
export class BudgetParseError extends Error {
  readonly budgetName: string

  constructor(message: string, budgetName: string) {
    super(`Budget "${budgetName}": ${message}`)
    this.name = 'BudgetParseError'
    this.budgetName = budgetName
  }
}

/**
 * Compile validated budget configs into engine-ready form.
 *
 * Contributor globs use the same picomatch engine as `match.tool` so a
 * pattern behaves identically whether it gates a rule or feeds a budget.
 *
 * @throws {BudgetParseError} On an invalid contributor glob.
 */
export function compileBudgets(budgets: BudgetsConfig): CompiledBudget[] {
  return budgets.map((budget) => ({
    name: budget.name,
    limit: budget.limit,
    currency: budget.currency,
    window:
      budget.window === 'session'
        ? {
            kind: 'session' as const,
            idleTtlMs: budget.idle_ttl ? parseDuration(budget.idle_ttl) : DEFAULT_IDLE_TTL_MS,
          }
        : { kind: 'duration' as const, windowMs: parseDuration(budget.window) },
    windowRaw: budget.window,
    key: budget.key,
    onExceed: budget.on_exceed,
    ...(budget.approval !== undefined && { approval: compileApproval(budget.approval) }),
    contributors: budget.contributors.map((contributor) =>
      compileContributor(contributor, budget.name),
    ),
  }))
}

function compileContributor(
  contributor: BudgetConfig['contributors'][number],
  budgetName: string,
): CompiledBudgetContributor {
  try {
    const test = picomatch(contributor.match.tool, { dot: true })
    return {
      match: { tool: { pattern: contributor.match.tool, test } },
      field: contributor.field,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new BudgetParseError(
      `invalid contributor glob "${contributor.match.tool}": ${message}`,
      budgetName,
    )
  }
}
