import { describe, it, expect } from 'vitest'
import {
  buildPolicyDeniedFeedback,
  buildEvidenceMissingFeedback,
  buildEvidenceExpiredFeedback,
  buildDependencyMissingFeedback,
  buildApprovalDeniedFeedback,
  buildApprovalTimeoutFeedback,
  buildClientDisconnectedFeedback,
  buildShutdownCancelledFeedback,
  buildRateLimitedFeedback,
  buildSpendLimitedFeedback,
  buildToolDriftFeedback,
  buildBudgetExceededFeedback,
  buildBudgetApprovalDeniedFeedback,
  buildBudgetApprovalTimeoutFeedback,
} from './self-repair.js'
import type { PolicyDecision } from '../policy/engine.js'
import type { EvidenceCheckResult, DependencyCheckResult } from '../evidence/index.js'
import type { CompiledPolicyRule } from '../policy/types.js'
import type { ToolDriftEvent } from '../policy/annotation-cache.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal compiled rule for testing. */
function makeRule(overrides?: Partial<CompiledPolicyRule>): CompiledPolicyRule {
  return {
    index: 0,
    match: {},
    action: 'deny',
    ...overrides,
  }
}

/** Build a deny decision with a matched rule. */
function denyDecision(rule?: Partial<CompiledPolicyRule>): PolicyDecision {
  return {
    action: 'deny',
    matchedRule: makeRule(rule),
    reason: 'Matched "block-rule" -> deny',
  }
}

/** Build a deny decision from default policy (no matched rule). */
function defaultDenyDecision(): PolicyDecision {
  return {
    action: 'deny',
    matchedRule: undefined,
    reason: 'No matching rule; applied default policy: deny',
  }
}

/** Build a require_approval decision with a matched rule. */
function approvalDecision(rule?: Partial<CompiledPolicyRule>): PolicyDecision {
  return {
    action: 'require_approval',
    matchedRule: makeRule({ action: 'require_approval', ...rule }),
    reason: 'Matched "approve-payments" -> require_approval',
  }
}

const SATISFIED_EVIDENCE: EvidenceCheckResult = {
  satisfied: true,
  missing: [],
  expired: [],
  found: ['key-a'],
}

const SATISFIED_DEPS: DependencyCheckResult = {
  satisfied: true,
  missing: [],
}

// ---------------------------------------------------------------------------
// buildPolicyDeniedFeedback
// ---------------------------------------------------------------------------

describe('buildPolicyDeniedFeedback', () => {
  it('builds feedback with rule name and auto-generated suggestion', () => {
    const feedback = buildPolicyDeniedFeedback(denyDecision({ name: 'block-destructive' }))

    expect(feedback.blocked).toBe(true)
    expect(feedback.reason).toBe('policy_denied')
    expect(feedback.action).toBe('deny')
    expect(feedback.rule).toBe('block-destructive')
    expect(feedback.rule_index).toBe(0)
    expect(feedback.retry_allowed).toBe(false)
    expect(feedback.suggestion).toContain('block-destructive')
    expect(feedback.suggestion).toContain('denied by policy')
  })

  it('builds feedback without rule name (default policy)', () => {
    const feedback = buildPolicyDeniedFeedback(defaultDenyDecision())

    expect(feedback.rule).toBeNull()
    expect(feedback.rule_index).toBeNull()
    expect(feedback.suggestion).toContain('denied by policy')
    expect(feedback.suggestion).not.toContain('(rule:')
  })

  it('uses feedback.suggestion as suggestion when present', () => {
    const feedback = buildPolicyDeniedFeedback(
      denyDecision({
        feedback: {
          message: 'Blocked by admin',
          suggestion: 'Contact #finance-approvals in Slack for override.',
        },
      }),
    )

    expect(feedback.suggestion).toBe('Contact #finance-approvals in Slack for override.')
  })

  it('falls back to feedback.message as suggestion when no suggestion field', () => {
    const feedback = buildPolicyDeniedFeedback(
      denyDecision({
        feedback: { message: 'Refunds over £500 require finance team approval.' },
      }),
    )

    expect(feedback.suggestion).toBe('Refunds over £500 require finance team approval.')
  })

  it('auto-generates suggestion when neither suggestion nor message present', () => {
    const feedback = buildPolicyDeniedFeedback(denyDecision({ name: 'no-feedback-rule' }))

    expect(feedback.suggestion).toContain('denied by policy')
    expect(feedback.suggestion).toContain('no-feedback-rule')
  })

  it('sets retry_allowed to false', () => {
    const feedback = buildPolicyDeniedFeedback(denyDecision())
    expect(feedback.retry_allowed).toBe(false)
  })

  it('sets reason to policy_denied', () => {
    const feedback = buildPolicyDeniedFeedback(denyDecision())
    expect(feedback.reason).toBe('policy_denied')
  })

  it('includes policy_reason from decision.reason', () => {
    const decision: PolicyDecision = {
      action: 'deny',
      matchedRule: makeRule(),
      reason: 'Matched "block-all" -> deny',
    }
    const feedback = buildPolicyDeniedFeedback(decision)
    expect(feedback.policy_reason).toBe('Matched "block-all" -> deny')
  })
})

// ---------------------------------------------------------------------------
// buildEvidenceMissingFeedback
// ---------------------------------------------------------------------------

describe('buildEvidenceMissingFeedback', () => {
  it('lists missing evidence keys', () => {
    const evidence: EvidenceCheckResult = {
      satisfied: false,
      missing: ['orders.lookup'],
      expired: [],
      found: [],
    }
    const feedback = buildEvidenceMissingFeedback(denyDecision(), evidence, SATISFIED_DEPS)

    expect(feedback.reason).toBe('evidence_missing')
    expect(feedback.missing_evidence).toEqual(['orders.lookup'])
    expect(feedback.action).toBe('deny')
  })

  it('generates singular suggestion for 1 missing key', () => {
    const evidence: EvidenceCheckResult = {
      satisfied: false,
      missing: ['orders.lookup'],
      expired: [],
      found: [],
    }
    const feedback = buildEvidenceMissingFeedback(denyDecision(), evidence, SATISFIED_DEPS)

    expect(feedback.suggestion).toBe(
      'Call the orders.lookup tool first to provide the required evidence, then retry this action.',
    )
  })

  it('generates plural suggestion for multiple missing keys', () => {
    const evidence: EvidenceCheckResult = {
      satisfied: false,
      missing: ['orders.lookup', 'customer.verify'],
      expired: [],
      found: [],
    }
    const feedback = buildEvidenceMissingFeedback(denyDecision(), evidence, SATISFIED_DEPS)

    expect(feedback.suggestion).toContain('orders.lookup, customer.verify')
    expect(feedback.suggestion).toContain('Call the following tools first')
  })

  it('sets retry_allowed to true', () => {
    const evidence: EvidenceCheckResult = {
      satisfied: false,
      missing: ['key'],
      expired: [],
      found: [],
    }
    const feedback = buildEvidenceMissingFeedback(denyDecision(), evidence, SATISFIED_DEPS)
    expect(feedback.retry_allowed).toBe(true)
  })

  it('preserves expired and dependency arrays', () => {
    const evidence: EvidenceCheckResult = {
      satisfied: false,
      missing: ['a'],
      expired: ['b'],
      found: [],
    }
    const deps: DependencyCheckResult = { satisfied: false, missing: ['tool_x'] }
    const feedback = buildEvidenceMissingFeedback(denyDecision(), evidence, deps)

    expect(feedback.expired_evidence).toEqual(['b'])
    expect(feedback.missing_dependencies).toEqual(['tool_x'])
  })
})

// ---------------------------------------------------------------------------
// buildEvidenceExpiredFeedback
// ---------------------------------------------------------------------------

describe('buildEvidenceExpiredFeedback', () => {
  it('lists expired evidence keys', () => {
    const evidence: EvidenceCheckResult = {
      satisfied: false,
      missing: [],
      expired: ['orders.lookup'],
      found: [],
    }
    const feedback = buildEvidenceExpiredFeedback(denyDecision(), evidence, SATISFIED_DEPS)

    expect(feedback.reason).toBe('evidence_expired')
    expect(feedback.expired_evidence).toEqual(['orders.lookup'])
  })

  it('generates singular suggestion for 1 expired key', () => {
    const evidence: EvidenceCheckResult = {
      satisfied: false,
      missing: [],
      expired: ['orders.lookup'],
      found: [],
    }
    const feedback = buildEvidenceExpiredFeedback(denyDecision(), evidence, SATISFIED_DEPS)

    expect(feedback.suggestion).toBe(
      'Evidence from orders.lookup has expired. Call it again to refresh the evidence, then retry this action.',
    )
  })

  it('generates plural suggestion for multiple expired keys', () => {
    const evidence: EvidenceCheckResult = {
      satisfied: false,
      missing: [],
      expired: ['orders.lookup', 'customer.verify'],
      found: [],
    }
    const feedback = buildEvidenceExpiredFeedback(denyDecision(), evidence, SATISFIED_DEPS)

    expect(feedback.suggestion).toContain('orders.lookup, customer.verify')
    expect(feedback.suggestion).toContain('has expired')
  })

  it('sets retry_allowed to true', () => {
    const evidence: EvidenceCheckResult = {
      satisfied: false,
      missing: [],
      expired: ['key'],
      found: [],
    }
    const feedback = buildEvidenceExpiredFeedback(denyDecision(), evidence, SATISFIED_DEPS)
    expect(feedback.retry_allowed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// buildDependencyMissingFeedback
// ---------------------------------------------------------------------------

describe('buildDependencyMissingFeedback', () => {
  it('lists missing dependency tool names', () => {
    const deps: DependencyCheckResult = { satisfied: false, missing: ['orders.lookup'] }
    const feedback = buildDependencyMissingFeedback(denyDecision(), SATISFIED_EVIDENCE, deps)

    expect(feedback.reason).toBe('dependency_missing')
    expect(feedback.missing_dependencies).toEqual(['orders.lookup'])
  })

  it('generates singular suggestion for 1 missing dependency', () => {
    const deps: DependencyCheckResult = { satisfied: false, missing: ['orders.lookup'] }
    const feedback = buildDependencyMissingFeedback(denyDecision(), SATISFIED_EVIDENCE, deps)

    expect(feedback.suggestion).toBe(
      'Call the orders.lookup tool first before attempting this action.',
    )
  })

  it('generates plural suggestion for multiple missing dependencies', () => {
    const deps: DependencyCheckResult = {
      satisfied: false,
      missing: ['orders.lookup', 'verify_customer'],
    }
    const feedback = buildDependencyMissingFeedback(denyDecision(), SATISFIED_EVIDENCE, deps)

    expect(feedback.suggestion).toContain('orders.lookup, verify_customer')
    expect(feedback.suggestion).toContain('Call the following tools first')
  })

  it('sets retry_allowed to true', () => {
    const deps: DependencyCheckResult = { satisfied: false, missing: ['tool'] }
    const feedback = buildDependencyMissingFeedback(denyDecision(), SATISFIED_EVIDENCE, deps)
    expect(feedback.retry_allowed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// buildApprovalDeniedFeedback
// ---------------------------------------------------------------------------

describe('buildApprovalDeniedFeedback', () => {
  it('builds feedback with denied_by and denial_reason', () => {
    const feedback = buildApprovalDeniedFeedback(
      approvalDecision({ name: 'approve-payments' }),
      'alice',
      'Budget exceeded',
    )

    expect(feedback.blocked).toBe(true)
    expect(feedback.reason).toBe('approval_denied')
    expect(feedback.action).toBe('require_approval')
    expect(feedback.denied_by).toBe('alice')
    expect(feedback.denial_reason).toBe('Budget exceeded')
    expect(feedback.rule).toBe('approve-payments')
    expect(feedback.rule_index).toBe(0)
  })

  it('sets denial_reason to null when no reason provided', () => {
    const feedback = buildApprovalDeniedFeedback(approvalDecision(), 'bob')
    expect(feedback.denial_reason).toBeNull()
  })

  it('sets retry_allowed to false', () => {
    const feedback = buildApprovalDeniedFeedback(approvalDecision(), 'alice')
    expect(feedback.retry_allowed).toBe(false)
  })

  it('uses feedback.suggestion from rule when present', () => {
    const feedback = buildApprovalDeniedFeedback(
      approvalDecision({
        feedback: {
          message: 'Blocked by finance',
          suggestion: 'Submit a JIRA ticket for manual processing.',
        },
      }),
      'alice',
    )
    expect(feedback.suggestion).toBe('Submit a JIRA ticket for manual processing.')
  })

  it('falls back to feedback.message when no suggestion', () => {
    const feedback = buildApprovalDeniedFeedback(
      approvalDecision({ feedback: { message: 'Ask the payments team.' } }),
      'alice',
    )
    expect(feedback.suggestion).toBe('Ask the payments team.')
  })

  it('auto-generates suggestion with approver name and reason', () => {
    const feedback = buildApprovalDeniedFeedback(approvalDecision(), 'alice', 'Too risky')
    expect(feedback.suggestion).toContain('alice')
    expect(feedback.suggestion).toContain('Too risky')
  })

  it('auto-generates suggestion without reason when none given', () => {
    const feedback = buildApprovalDeniedFeedback(approvalDecision(), 'bob')
    expect(feedback.suggestion).toContain('bob')
    expect(feedback.suggestion).not.toContain('Reason:')
  })
})

// ---------------------------------------------------------------------------
// buildApprovalTimeoutFeedback
// ---------------------------------------------------------------------------

describe('buildApprovalTimeoutFeedback', () => {
  it('builds feedback with timeout_seconds', () => {
    const feedback = buildApprovalTimeoutFeedback(approvalDecision(), 300_000)

    expect(feedback.blocked).toBe(true)
    expect(feedback.reason).toBe('approval_timeout')
    expect(feedback.action).toBe('require_approval')
    expect(feedback.timeout_seconds).toBe(300)
  })

  it('sets retry_allowed to true', () => {
    const feedback = buildApprovalTimeoutFeedback(approvalDecision(), 60_000)
    expect(feedback.retry_allowed).toBe(true)
  })

  it('converts milliseconds to rounded seconds', () => {
    const feedback = buildApprovalTimeoutFeedback(approvalDecision(), 5_500)
    expect(feedback.timeout_seconds).toBe(6)
  })

  it('auto-generates suggestion with timeout duration', () => {
    const feedback = buildApprovalTimeoutFeedback(approvalDecision(), 120_000)
    expect(feedback.suggestion).toContain('120s')
    expect(feedback.suggestion).toContain('timed out')
  })

  it('uses feedback.suggestion from rule when present', () => {
    const feedback = buildApprovalTimeoutFeedback(
      approvalDecision({
        feedback: {
          message: 'Default timeout message',
          suggestion: 'Use the emergency override instead.',
        },
      }),
      300_000,
    )
    expect(feedback.suggestion).toBe('Use the emergency override instead.')
  })
})

// ---------------------------------------------------------------------------
// buildClientDisconnectedFeedback
// ---------------------------------------------------------------------------

describe('buildClientDisconnectedFeedback', () => {
  it('builds feedback with client_disconnected reason', () => {
    const feedback = buildClientDisconnectedFeedback(approvalDecision({ name: 'approve-payments' }))

    expect(feedback.blocked).toBe(true)
    expect(feedback.reason).toBe('client_disconnected')
    expect(feedback.action).toBe('require_approval')
    expect(feedback.rule).toBe('approve-payments')
    expect(feedback.rule_index).toBe(0)
    expect(feedback.retry_allowed).toBe(true)
  })

  it('uses fallback suggestion when no rule feedback is provided', () => {
    const feedback = buildClientDisconnectedFeedback(approvalDecision())
    expect(feedback.suggestion).toContain('client disconnected')
    expect(feedback.suggestion).toContain('Retry')
  })
})

// ---------------------------------------------------------------------------
// buildShutdownCancelledFeedback
// ---------------------------------------------------------------------------

describe('buildShutdownCancelledFeedback', () => {
  it('builds feedback with shutdown_cancelled reason', () => {
    const feedback = buildShutdownCancelledFeedback(approvalDecision({ name: 'approve-payments' }))

    expect(feedback.blocked).toBe(true)
    expect(feedback.reason).toBe('shutdown_cancelled')
    expect(feedback.action).toBe('require_approval')
    expect(feedback.rule).toBe('approve-payments')
    expect(feedback.rule_index).toBe(0)
    expect(feedback.retry_allowed).toBe(true)
  })

  it('uses fallback suggestion when no rule feedback is provided', () => {
    const feedback = buildShutdownCancelledFeedback(approvalDecision())
    expect(feedback.suggestion).toContain('proxy was shut down')
    expect(feedback.suggestion).toContain('Retry')
  })
})

// ---------------------------------------------------------------------------
// buildRateLimitedFeedback
// ---------------------------------------------------------------------------

/** Build a rate_limit decision with a matched rule. */
function rateLimitDecision(rule?: Partial<CompiledPolicyRule>): PolicyDecision {
  return {
    action: 'rate_limit',
    matchedRule: makeRule({ action: 'rate_limit', ...rule }),
    reason: 'Matched "rate-limit-api" -> rate_limit',
  }
}

describe('buildRateLimitedFeedback', () => {
  const blockedResult = {
    allowed: false,
    current: 5,
    limit: 5,
    windowMs: 60_000,
    resetAtMs: 1_000_000 + 60_000,
  }

  it('builds feedback with correct fields', () => {
    const feedback = buildRateLimitedFeedback(
      rateLimitDecision({ name: 'rate-limit-api' }),
      blockedResult,
    )

    expect(feedback.blocked).toBe(true)
    expect(feedback.reason).toBe('rate_limited')
    expect(feedback.action).toBe('rate_limit')
    expect(feedback.rule).toBe('rate-limit-api')
    expect(feedback.rule_index).toBe(0)
    expect(feedback.current_calls).toBe(5)
    expect(feedback.max_calls).toBe(5)
    expect(feedback.window_seconds).toBe(60)
  })

  it('sets retry_allowed to true', () => {
    const feedback = buildRateLimitedFeedback(rateLimitDecision(), blockedResult)
    expect(feedback.retry_allowed).toBe(true)
  })

  it('computes window_seconds from windowMs', () => {
    const feedback = buildRateLimitedFeedback(rateLimitDecision(), {
      ...blockedResult,
      windowMs: 3_600_000,
    })
    expect(feedback.window_seconds).toBe(3600)
  })

  it('formats reset_at as ISO 8601', () => {
    const feedback = buildRateLimitedFeedback(rateLimitDecision(), blockedResult)
    // Should be a valid ISO date string
    expect(new Date(feedback.reset_at).toISOString()).toBe(feedback.reset_at)
    expect(feedback.reset_at).toBe(new Date(blockedResult.resetAtMs).toISOString())
  })

  it('uses feedback.suggestion from rule when present', () => {
    const feedback = buildRateLimitedFeedback(
      rateLimitDecision({
        feedback: {
          message: 'Too many calls',
          suggestion: 'Batch your requests to reduce call volume.',
        },
      }),
      blockedResult,
    )
    expect(feedback.suggestion).toBe('Batch your requests to reduce call volume.')
  })

  it('falls back to auto-generated suggestion', () => {
    const feedback = buildRateLimitedFeedback(rateLimitDecision(), blockedResult)
    expect(feedback.suggestion).toContain('5/5 calls')
    expect(feedback.suggestion).toContain('60s window')
    expect(feedback.suggestion).toContain('Retry after')
  })
})

// ---------------------------------------------------------------------------
// buildSpendLimitedFeedback
// ---------------------------------------------------------------------------

/** Build a spend_limit decision with a matched rule. */
function spendLimitDecision(rule?: Partial<CompiledPolicyRule>): PolicyDecision {
  return {
    action: 'spend_limit',
    matchedRule: makeRule({ action: 'spend_limit', ...rule }),
    reason: 'Matched "spend-limit-payments" -> spend_limit',
  }
}

describe('buildSpendLimitedFeedback', () => {
  const blockedSpendResult = {
    allowed: false,
    currentSpend: 4500,
    limit: 5000,
    windowMs: 86_400_000,
    resetAtMs: 1_000_000 + 86_400_000,
  }

  it('builds feedback with correct fields', () => {
    const feedback = buildSpendLimitedFeedback(
      spendLimitDecision({ name: 'spend-limit-payments' }),
      blockedSpendResult,
      'GBP',
    )

    expect(feedback.blocked).toBe(true)
    expect(feedback.reason).toBe('spend_limited')
    expect(feedback.action).toBe('spend_limit')
    expect(feedback.rule).toBe('spend-limit-payments')
    expect(feedback.rule_index).toBe(0)
    expect(feedback.current_spend).toBe(4500)
    expect(feedback.max_spend).toBe(5000)
    expect(feedback.currency).toBe('GBP')
    expect(feedback.window_seconds).toBe(86400)
  })

  it('sets retry_allowed to true', () => {
    const feedback = buildSpendLimitedFeedback(spendLimitDecision(), blockedSpendResult, 'USD')
    expect(feedback.retry_allowed).toBe(true)
  })

  it('computes window_seconds from windowMs', () => {
    const feedback = buildSpendLimitedFeedback(
      spendLimitDecision(),
      { ...blockedSpendResult, windowMs: 3_600_000 },
      'EUR',
    )
    expect(feedback.window_seconds).toBe(3600)
  })

  it('formats reset_at as ISO 8601', () => {
    const feedback = buildSpendLimitedFeedback(spendLimitDecision(), blockedSpendResult, 'GBP')
    expect(new Date(feedback.reset_at).toISOString()).toBe(feedback.reset_at)
    expect(feedback.reset_at).toBe(new Date(blockedSpendResult.resetAtMs).toISOString())
  })

  it('uses feedback.suggestion from rule when present', () => {
    const feedback = buildSpendLimitedFeedback(
      spendLimitDecision({
        feedback: {
          message: 'Budget exceeded',
          suggestion: 'Request a budget increase from finance.',
        },
      }),
      blockedSpendResult,
      'GBP',
    )
    expect(feedback.suggestion).toBe('Request a budget increase from finance.')
  })

  it('falls back to auto-generated suggestion', () => {
    const feedback = buildSpendLimitedFeedback(spendLimitDecision(), blockedSpendResult, 'GBP')
    expect(feedback.suggestion).toContain('4500/5000 GBP')
    expect(feedback.suggestion).toContain('86400s window')
    expect(feedback.suggestion).toContain('Retry after')
  })

  describe('invalid amount', () => {
    const invalidAmountResult = {
      allowed: false as const,
      currentSpend: 0,
      limit: 5000,
      windowMs: 86_400_000,
      resetAtMs: 0,
      reason: 'invalid_amount' as const,
    }

    it('produces a non-epoch reset_at and a non-negative-finite suggestion', () => {
      const feedback = buildSpendLimitedFeedback(
        spendLimitDecision({
          name: 'spend-limit-payments',
          limits: {
            maxSpend: {
              field: '$.amount',
              limit: 5000,
              currency: 'GBP',
              windowMs: 86_400_000,
            },
          },
        }),
        invalidAmountResult,
        'GBP',
      )

      expect(feedback.blocked).toBe(true)
      expect(feedback.reason).toBe('spend_limited')
      expect(feedback.action).toBe('spend_limit')
      expect(feedback.retry_allowed).toBe(true)
      expect(feedback.suggestion).toContain('non-negative finite number')
      expect(feedback.suggestion).toContain('$.amount')
      // Regression guard for the 1970 epoch bug: reset_at must be the current
      // ISO timestamp, not new Date(0).toISOString()
      expect(feedback.suggestion).not.toContain('1970')
      expect(feedback.reset_at).not.toContain('1970')
    })

    it('uses feedback.suggestion override when present', () => {
      const feedback = buildSpendLimitedFeedback(
        spendLimitDecision({
          feedback: {
            message: 'Bad amount',
            suggestion: 'Submit a positive integer in pence.',
          },
          limits: {
            maxSpend: {
              field: '$.amount',
              limit: 100,
              currency: 'GBP',
              windowMs: 3_600_000,
            },
          },
        }),
        invalidAmountResult,
        'GBP',
      )
      expect(feedback.suggestion).toBe('Submit a positive integer in pence.')
    })
  })
})

// ---------------------------------------------------------------------------
// buildToolDriftFeedback
// ---------------------------------------------------------------------------

describe('buildToolDriftFeedback', () => {
  const drift: ToolDriftEvent = {
    toolName: 'send_email',
    changes: [
      {
        aspect: 'annotations',
        baseline: { destructiveHint: false },
        current: { destructiveHint: true },
      },
    ],
  }

  it('builds deny feedback with drifted aspects', () => {
    const feedback = buildToolDriftFeedback(drift, 'deny')
    expect(feedback.blocked).toBe(true)
    expect(feedback.reason).toBe('tool_definition_drift')
    expect(feedback.action).toBe('deny')
    expect(feedback.drifted_aspects).toEqual(['annotations'])
    expect(feedback.retry_allowed).toBe(false)
    expect(feedback.suggestion).toContain('send_email')
  })

  it('builds require_approval feedback', () => {
    const feedback = buildToolDriftFeedback(drift, 'require_approval')
    expect(feedback.action).toBe('require_approval')
  })
})

// ---------------------------------------------------------------------------
// rule_index emission (issue #109 rename; issue #144 removed the alias)
// ---------------------------------------------------------------------------

describe('rule_index emission (issue #144 removed the ruleIndex alias)', () => {
  const drift: ToolDriftEvent = {
    toolName: 'send_email',
    changes: [
      {
        aspect: 'annotations',
        baseline: { destructiveHint: false },
        current: { destructiveHint: true },
      },
    ],
  }

  const breached = {
    budget: {
      name: 'cap',
      limit: 100,
      currency: 'USD',
      window: { kind: 'duration' as const, windowMs: 60_000 },
      windowRaw: '1m',
      key: 'global' as const,
      onExceed: 'deny' as const,
      contributors: [],
    },
    bucketKey: 'budget:cap:global',
    amount: 5,
    allowed: false,
    spent: 100,
    remaining: 0,
    resetAtMs: 60_000,
  }

  // Break-glass builders only ever see budgets that raised a ticket.
  const breachedRequireApproval = {
    ...breached,
    budget: { ...breached.budget, onExceed: 'require_approval' as const },
  }

  const matchedRuleBuilders: ReadonlyArray<[name: string, build: () => Record<string, unknown>]> = [
    ['buildPolicyDeniedFeedback', () => ({ ...buildPolicyDeniedFeedback(denyDecision()) })],
    [
      'buildEvidenceMissingFeedback',
      () => ({
        ...buildEvidenceMissingFeedback(
          denyDecision(),
          { satisfied: false, missing: ['key-a'], expired: [], found: [] },
          undefined,
        ),
      }),
    ],
    [
      'buildEvidenceExpiredFeedback',
      () => ({
        ...buildEvidenceExpiredFeedback(
          denyDecision(),
          { satisfied: false, missing: [], expired: ['key-a'], found: [] },
          undefined,
        ),
      }),
    ],
    [
      'buildDependencyMissingFeedback',
      () => ({
        ...buildDependencyMissingFeedback(denyDecision(), SATISFIED_EVIDENCE, {
          satisfied: false,
          missing: ['validate_payment'],
        }),
      }),
    ],
    [
      'buildApprovalDeniedFeedback',
      () => ({ ...buildApprovalDeniedFeedback(approvalDecision(), 'alice', 'too risky') }),
    ],
    [
      'buildApprovalTimeoutFeedback',
      () => ({ ...buildApprovalTimeoutFeedback(approvalDecision(), 300_000) }),
    ],
    [
      'buildClientDisconnectedFeedback',
      () => ({ ...buildClientDisconnectedFeedback(approvalDecision()) }),
    ],
    [
      'buildShutdownCancelledFeedback',
      () => ({ ...buildShutdownCancelledFeedback(approvalDecision()) }),
    ],
    [
      'buildRateLimitedFeedback',
      () => ({
        ...buildRateLimitedFeedback(denyDecision({ action: 'rate_limit' }), {
          allowed: false,
          current: 5,
          limit: 5,
          windowMs: 60_000,
          resetAtMs: 1_060_000,
        }),
      }),
    ],
    [
      'buildSpendLimitedFeedback',
      () => ({
        ...buildSpendLimitedFeedback(
          denyDecision({ action: 'spend_limit' }),
          { allowed: false, currentSpend: 900, limit: 1000, windowMs: 3_600_000, resetAtMs: 1 },
          'USD',
        ),
      }),
    ],
    [
      'buildBudgetExceededFeedback',
      () => ({ ...buildBudgetExceededFeedback(denyDecision(), [breached], []) }),
    ],
    [
      'buildBudgetApprovalDeniedFeedback',
      () => ({
        ...buildBudgetApprovalDeniedFeedback(denyDecision(), [breachedRequireApproval], 'alice'),
      }),
    ],
    [
      'buildBudgetApprovalTimeoutFeedback',
      () => ({
        ...buildBudgetApprovalTimeoutFeedback(denyDecision(), [breachedRequireApproval], 120_000),
      }),
    ],
  ]

  it.each(matchedRuleBuilders)('%s emits rule_index and no ruleIndex alias', (_name, build) => {
    const feedback = build()
    expect(feedback).toHaveProperty('rule_index', 0)
    expect(feedback).not.toHaveProperty('ruleIndex')
  })

  it('buildSpendLimitedFeedback invalid-amount variant emits rule_index only', () => {
    const feedback = buildSpendLimitedFeedback(
      denyDecision({ action: 'spend_limit' }),
      {
        allowed: false,
        currentSpend: 0,
        limit: 1000,
        windowMs: 3_600_000,
        resetAtMs: 0,
        reason: 'invalid_amount',
      },
      'USD',
    )
    expect(feedback).toHaveProperty('rule_index', 0)
    expect(feedback).not.toHaveProperty('ruleIndex')
  })

  it('emits null rule_index and no alias when no rule matched', () => {
    const feedback = buildPolicyDeniedFeedback(defaultDenyDecision())
    expect(feedback).toHaveProperty('rule_index', null)
    expect(feedback).not.toHaveProperty('ruleIndex')
  })

  it('budget_exceeded is not retryable when a session breach rides with an invalid amount', () => {
    const sessionBudget = {
      name: 'sc',
      limit: 100,
      currency: 'USD',
      window: { kind: 'session' as const, idleTtlMs: 1 },
      windowRaw: 'session',
      key: 'session' as const,
      onExceed: 'deny' as const,
      contributors: [],
    }
    const invalidBudget = {
      ...sessionBudget,
      name: 'iv',
      window: { kind: 'duration' as const, windowMs: 1000 },
      windowRaw: '1s',
    }
    const feedback = buildBudgetExceededFeedback(
      denyDecision(),
      [
        {
          budget: sessionBudget,
          bucketKey: 'budget:sc:session:s1',
          amount: 5,
          allowed: false,
          spent: 100,
          remaining: 0,
          resetAtMs: null,
        },
      ],
      [
        {
          budget: invalidBudget,
          bucketKey: 'budget:iv:global',
          reason: 'invalid_amount',
          spent: 0,
          remaining: 100,
          resetAtMs: 1_000,
        },
      ],
    )
    // The session pot never replenishes: fixing the invalid amount cannot
    // make the breached call succeed, so the denial is not retryable.
    expect(feedback.retry_allowed).toBe(false)
  })

  it('buildToolDriftFeedback emits null rule_index and no alias', () => {
    const feedback = buildToolDriftFeedback(drift, 'deny')
    expect(feedback).toHaveProperty('rule_index', null)
    expect(feedback).not.toHaveProperty('ruleIndex')
  })
})

// ---------------------------------------------------------------------------
// Budget break-glass builders (issue #14, PR 3)
// ---------------------------------------------------------------------------

describe('budget break-glass feedback builders', () => {
  const breachedEntry = {
    budget: {
      name: 'daily-cap',
      limit: 50,
      currency: 'USD',
      window: { kind: 'duration' as const, windowMs: 3_600_000 },
      windowRaw: '1h',
      key: 'global' as const,
      onExceed: 'require_approval' as const,
      contributors: [],
    },
    bucketKey: 'budget:daily-cap:global',
    amount: 5,
    allowed: false,
    spent: 49,
    remaining: 1,
    resetAtMs: 4_600_000,
  }

  it('denied: carries approver identity plus every breached budget', () => {
    const feedback = buildBudgetApprovalDeniedFeedback(
      denyDecision({ action: 'allow' }),
      [breachedEntry],
      'alice',
      'Not this quarter',
    )
    expect(feedback.blocked).toBe(true)
    expect(feedback.reason).toBe('budget_exceeded')
    expect(feedback.action).toBe('budget')
    expect(feedback.denied_by).toBe('alice')
    expect(feedback.denial_reason).toBe('Not this quarter')
    expect(feedback.budgets).toHaveLength(1)
    expect(feedback.budgets[0]).toMatchObject({
      name: 'daily-cap',
      limit: 50,
      spent: 49,
      attempted_amount: 5,
      currency: 'USD',
      window: '1h',
      on_exceed: 'require_approval',
    })
    expect(feedback.retry_allowed).toBe(false)
    expect(feedback).toHaveProperty('rule_index', 0)
    expect(feedback).not.toHaveProperty('ruleIndex')
  })

  it('denied: null denial_reason when the approver gave none', () => {
    const feedback = buildBudgetApprovalDeniedFeedback(denyDecision(), [breachedEntry], 'bob')
    expect(feedback.denial_reason).toBeNull()
    expect(feedback.suggestion).toContain('bob')
  })

  it('timeout: fails closed and says so, but the agent may retry later', () => {
    const feedback = buildBudgetApprovalTimeoutFeedback(
      denyDecision({ action: 'allow' }),
      [breachedEntry],
      120_000,
    )
    expect(feedback.reason).toBe('budget_exceeded')
    expect(feedback.action).toBe('budget')
    expect(feedback.timeout_seconds).toBe(120)
    expect(feedback.budgets).toHaveLength(1)
    expect(feedback.retry_allowed).toBe(true)
  })
})
