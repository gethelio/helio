# Policy Guide

Helio's policy engine evaluates every `tools/call` request against an ordered list of rules before deciding whether to forward, block, or escalate the call. Policies are defined in `helio.yaml` and hot-reload without restarting the proxy — rate and spend limit buckets survive a benign reload as long as the underlying rule config is unchanged (see [Hot Reload](./configuration.md#hot-reload)). Operators who want zero live-state movement on config writes can pin the policy with `helio start --no-hot-reload` or `policies.hot_reload: false`.

## How Policies Work

1. When a `tools/call` request arrives, the proxy builds a context from the tool name, MCP annotations, input arguments, and configured environment.
2. Rules are evaluated **in order**. The first rule whose match conditions are satisfied determines the action.
3. If no rule matches, the `policies.default` action applies (`allow` or `deny`).

This is a **first-match-wins** model. Rule order matters — put more specific rules before general ones.

Policy evaluation is synchronous and typically completes in under 1ms.

## Rule Structure

Each rule in the `policies.rules` array has this structure:

```yaml
rules:
  - name: rule-name # Optional label for audit and error messages
    match: # Conditions (all must be true)
      tool: 'send_*' # Glob pattern on tool name
      annotations: # MCP annotation hints
        destructiveHint: true
      input: # Conditions on tool arguments
        '$.amount':
          gt: 1000
      environment: production # Match environment label
    action: deny # What to do: allow | deny | require_approval | rate_limit | spend_limit | dry_run
    approval: # Optional; if omitted, falls back to dashboard + global timeout
      channel: slack
      timeout: '600s'
    evidence: # Require evidence before allowing
      requires: ['order_lookup']
    requires: ['verify_customer'] # Require prior tool calls
    limits: # Rate or spend limit config
      max_calls: 100
      window: '1h'
    feedback: # Custom message for blocked and gated actions
      message: 'This action is blocked.'
      suggestion: 'Try a different approach.'
```

## Match Conditions

All conditions within a `match` block are **AND-combined** — every specified condition must be true for the rule to match. Omitted conditions are ignored (they don't constrain the match).

### tool

Match by tool name using glob patterns (powered by [picomatch](https://github.com/micromatch/picomatch)):

```yaml
match:
  tool: 'send_email' # Exact match
```

```yaml
match:
  tool: 'send_*' # Wildcard suffix
```

```yaml
match:
  tool: 'stripe.*' # Dot-separated namespace
```

```yaml
match:
  tool: '*' # Match any tool
```

### annotations

Match by [MCP tool annotations](https://spec.modelcontextprotocol.io/specification/2025-03-26/server/tools/#annotations) — metadata hints that describe a tool's behavior:

```yaml
match:
  annotations:
    destructiveHint: true
```

Four annotation hints are available:

| Hint              | Description                              | MCP Default |
| ----------------- | ---------------------------------------- | ----------- |
| `readOnlyHint`    | Tool only reads data, no side effects    | `false`     |
| `destructiveHint` | Tool can destructively modify state      | **`true`**  |
| `idempotentHint`  | Safe to call repeatedly with same args   | `false`     |
| `openWorldHint`   | Tool can affect systems beyond its scope | `true`      |

> **Important:** The MCP spec defaults `destructiveHint` to `true` when a tool does not explicitly set it. This means a rule matching `destructiveHint: true` will match _most_ tools unless they explicitly opt out with `destructiveHint: false`. Always set annotations explicitly on your MCP server tools.
>
> Helio startup now auto-primes annotations with a synthetic upstream `tools/list`. If upstream is temporarily unavailable, Helio retries priming in the background. Until priming succeeds, annotation checks intentionally remain fail-closed using these MCP defaults.

Only specify the annotations you want to match on. Omitted annotations are not checked:

```yaml
# Matches tools that are read-only, regardless of other annotations
match:
  annotations:
    readOnlyHint: true
```

### input

Match on tool call arguments using dot-path notation and comparison operators:

```yaml
match:
  input:
    '$.amount':
      gt: 1000
```

**Path syntax:** Use `$.field` or just `field` to reference top-level arguments. Nested paths work with dots: `$.user.name`, `$.payment.currency`.

**Operators:**

| Operator   | Type   | Description              | Example                    |
| ---------- | ------ | ------------------------ | -------------------------- |
| `eq`       | any    | Strict equality          | `eq: "GBP"`                |
| `neq`      | any    | Strict inequality        | `neq: "internal"`          |
| `gt`       | number | Greater than             | `gt: 1000`                 |
| `gte`      | number | Greater than or equal    | `gte: 0`                   |
| `lt`       | number | Less than                | `lt: 10000`                |
| `lte`      | number | Less than or equal       | `lte: 500`                 |
| `contains` | string | Substring match          | `contains: "@example.com"` |
| `regex`    | string | Regular expression match | `regex: "^admin_"`         |

A `neq` condition matches only when the field is present; an absent field does not satisfy `neq`.

Multiple conditions on the same or different fields are AND-combined:

```yaml
# Amount between 100 and 10,000 (inclusive) in GBP
match:
  input:
    '$.amount':
      gte: 100
      lte: 10000
    '$.currency':
      eq: 'GBP'
```

### environment

Match against the `environment` label set in the top-level config. This is an exact, case-sensitive string match:

```yaml
# Only match in production
environment: production

policies:
  rules:
    - name: prod-deny-destructive
      match:
        annotations:
          destructiveHint: true
        environment: production
      action: deny
```

`match.environment` is only valid when top-level `environment` is configured. If you define env-scoped rules without setting top-level `environment`, Helio rejects the config at startup, on `helio validate`, and during hot-reload.

Changing top-level `environment` on a running process is restart-required. Hot-reload keeps the startup environment label and logs a restart warning.

### metadata

Match against the adapter-supplied **context** of a call — who sent it, in which channel, and so on. This is populated only on the **host-enforced (sideband) path** (see the [Adapter Governance API](./adapter-api.md)); MCP requests carry no metadata, so a rule with `match.metadata` is **inert on the MCP path** (it never matches there, and is skipped — not denied).

Well-known keys: `channel_id`, `sender_id`, `sender_name`, `conversation_id`, and the virtual `agent_id` (read from the request's `agent_id` field, not the metadata object). Any other adapter-supplied key can be matched too.

Each key takes either a bare string (exact match) or an operator object using the string operators `eq`, `neq`, `contains`, `regex`:

```yaml
policies:
  rules:
    # Block one Slack channel outright
    - name: no-prod-channel
      match:
        metadata:
          channel_id: 'C_PROD'
      action: deny

    # Require approval for a specific sender pattern, agent-scoped
    - name: external-senders
      match:
        metadata:
          sender_id: { regex: '^EXT-' }
          agent_id: 'support-bot'
      action: require_approval
      approval:
        channel: slack
```

All metadata conditions are AND-combined with each other and with the rest of the `match` block. A `regex` is validated for catastrophic backtracking at load time, exactly like `match.input` regexes. Because metadata is absent on the MCP path, prefer pairing a metadata `deny` rule with a separate MCP-path control if you need both doors covered.

## Actions

| Action             | Description                                                                                          |
| ------------------ | ---------------------------------------------------------------------------------------------------- |
| `allow`            | Forward the request to the upstream MCP server and record in audit.                                  |
| `deny`             | Block the request and return structured feedback. No upstream request is made.                       |
| `require_approval` | Hold the request and wait for human approval. See [Approval Workflows](./approvals.md).              |
| `rate_limit`       | Allow until the call limit is exceeded, then block. Requires `limits.max_calls` and `limits.window`. |
| `spend_limit`      | Track cumulative monetary spend and block when the budget is exceeded. Requires `limits.max_spend`.  |
| `dry_run`          | Simulate the full pipeline without forwarding to upstream. Returns what _would_ have happened.       |

### allow

The request is forwarded to the upstream MCP server. The response is passed back to the client. An audit record is created with the policy decision, latency, and response.

### deny

The request is blocked immediately. No upstream request is made. The response is a JSON-RPC error with structured self-repair feedback:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32001,
    "message": "Destructive operations are blocked by policy.",
    "data": {
      "blocked": true,
      "reason": "policy_denied",
      "rule": "block-destructive",
      "action": "deny",
      "suggestion": "Use a non-destructive alternative.",
      "retry_allowed": false
    }
  }
}
```

The `data` object also carries `rule_index` and `policy_reason`; the fields shown above are the ones an agent typically acts on. (`ruleIndex` is still emitted as a deprecated alias of `rule_index` for this release and will be removed in the next.)

### require_approval

The proxy holds the HTTP connection open and creates an approval ticket. The ticket is sent to the configured approval channel (dashboard, webhook, or Slack). The request waits until a human approves, denies, the timeout fires, or the client disconnects (`client_disconnected`).

Rule-level `approval` is optional. If omitted, Helio falls back to channel `dashboard` and the global timeout from top-level `approval.timeout`:

```yaml
- name: approve-writes
  match:
    annotations:
      readOnlyHint: false
  action: require_approval
  approval:
    channel: slack
    timeout: '600s'
```

See [Approval Workflows](./approvals.md) for full documentation.

### rate_limit

Allows requests up to a configured call limit within a sliding window, then blocks:

```yaml
- name: rate-limit-search
  match:
    tool: 'search_*'
  action: rate_limit
  limits:
    max_calls: 100
    window: '1h'
    key: tool
```

See [Rate Limits](#rate-limits) below.

`rate_limit` rules without `limits.max_calls` or `limits.window` are rejected at config-validate/startup time.

### spend_limit

Tracks cumulative monetary amounts extracted from tool arguments and blocks when the budget is exceeded:

```yaml
- name: payment-budget
  match:
    tool: 'create_payment'
  action: spend_limit
  limits:
    max_spend:
      field: '$.amount'
      limit: 500
      currency: USD
      window: '1h'
      key: tool
```

See [Spend Limits](#spend-limits) below.

`spend_limit` rules without `limits.max_spend` are rejected at config-validate/startup time.

### dry_run

Runs the full policy evaluation pipeline — including evidence checks, rate limit checks, and spend limit checks — but does not forward the request to the upstream server and does not consume any rate or spend limit budget.

Returns a synthetic response showing what would have happened:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "{\"dry_run\":true,\"would_forward\":true,\"policy_decision\":\"allow\",\"matched_rule\":null,\"evidence_satisfied\":true,\"limits_ok\":true}"
      }
    ]
  }
}
```

## Install-Time Policy (`deny_install`)

Hook-based adapters can scan a package/skill **before it is installed** via the sideband [`POST /install-scan`](./adapter-api.md) endpoint. Install-time rules live in their own `policies.install` block — separate from `policies.rules`, because a package has no tool name, annotations, or arguments to match on:

```yaml
policies:
  install:
    default: allow # or deny — applied when no rule matches
    rules:
      - name: block-unverified-npm
        match:
          name: 'evil-*' # glob on the package name (same engine as match.tool)
          source: npm # exact ecosystem match (npm | pip | …)
        action: deny_install
        feedback:
          message: 'This package is blocked by policy.'
      - name: gate-by-sender
        match:
          metadata: # install rules support match.metadata too
            sender_id: { regex: '^EXT-' }
        action: deny_install
```

- Rules are first-match-wins; if none match, `install.default` applies (defaults to `allow`).
- `action` is `deny_install` or `allow`. A `deny_install` outcome returns `decision: "deny"` to the adapter and records an audit row with `record_kind: install_scan` and `block_reason: install_denied`.
- When no `policies.install` block is configured, `/install-scan` stays **observational** (always allows) so adapters can call it safely before any rules exist.
- Install-time policy is only reachable through the sideband; it has no effect on the MCP path.

## Rate Limits

Rate limits use a **sliding window** algorithm to track calls per key. Configure them with the `limits` block on a `rate_limit` rule:

| Field       | Type     | Required | Description                                                                                                         |
| ----------- | -------- | -------- | ------------------------------------------------------------------------------------------------------------------- |
| `max_calls` | integer  | Yes      | Maximum number of calls allowed in the window.                                                                      |
| `window`    | duration | Yes      | Sliding window size (e.g. `1h`, `5m`, `30s`).                                                                       |
| `key`       | string   | No       | Aggregation scope: `tool` (default), `session`, `sender_id`, or `agent` (unsupported on MCP; falls back to `tool`). |

**Key scoping:**

- `tool` (default) — One shared limit per tool name, across all sessions.
- `session` — Each MCP session has its own independent limit.
- `sender_id` — One limit per adapter-supplied `sender_id` (host-enforced path). Requires the SDK sideband (`sdk.enabled: true`) — Helio **rejects** the config otherwise, since a sender-keyed limit is meaningless without a sender. On the MCP path (which has no sender) it falls back to `tool` with a one-time warning.
- `agent` — Currently unsupported on MCP requests; Helio logs a warning and falls back to `tool`.

**Important behaviors:**

- Blocked calls **do not consume** a rate limit slot. Any call that passes the limiter check consumes a slot, even if the later upstream call fails.
- Rate limit state is **in-memory** and resets when the proxy restarts.
- The sliding window is continuous, not calendar-aligned.

```yaml
- name: rate-limit-expensive-tool
  match:
    tool: 'run_query'
  action: rate_limit
  limits:
    max_calls: 10
    window: '1m'
    key: session
  feedback:
    message: 'Query rate limit exceeded.'
    suggestion: 'Wait a moment before retrying.'
```

## Spend Limits

Spend limits track cumulative monetary amounts extracted from tool call arguments. Configure them with `limits.max_spend`:

| Field      | Type     | Required | Description                                                                                                         |
| ---------- | -------- | -------- | ------------------------------------------------------------------------------------------------------------------- |
| `field`    | string   | Yes      | JSONPath-style dot path to the amount field in tool arguments (e.g. `$.amount`).                                    |
| `limit`    | number   | Yes      | Maximum cumulative spend in the window.                                                                             |
| `currency` | string   | Yes      | Currency label for display (e.g. `USD`, `EUR`).                                                                     |
| `window`   | duration | Yes      | Sliding window size.                                                                                                |
| `key`      | string   | No       | Aggregation scope: `tool` (default), `session`, `sender_id`, or `agent` (unsupported on MCP; falls back to `tool`). |

`key: sender_id` keys the budget per adapter-supplied sender (host-enforced path) and, like rate limits, requires `sdk.enabled: true` or the config is rejected.

**Important behaviors:**

- Rejected calls **do not consume** budget. Any call that passes the limiter check and is forwarded consumes budget, even if the later upstream call fails.
- If the configured amount field is missing or non-numeric, the call is denied with structured feedback (`reason: spend_limited`) and no budget is consumed.
- Spend limit state is **in-memory** and resets when the proxy restarts.

```yaml
- name: refund-budget
  match:
    tool: 'create_refund'
  action: spend_limit
  limits:
    max_spend:
      field: '$.amount'
      limit: 200
      currency: USD
      window: '1h'
      key: session
  feedback:
    message: 'Refund budget exceeded for this session.'
    suggestion: 'Wait for the current window to reset or escalate to a human.'
```

## Named Budgets (cross-tool)

`spend_limit` rules cap what one rule's matched tools spend. **Named budgets** are the cross-tool layer: a first-class `budgets:` section, independent of rules, where one depleting pot aggregates spend across every tool its contributors match — Stripe and PayPal into one cap, each exposing the amount under its own field name.

```yaml
budgets:
  - name: daily-cap
    limit: 50
    currency: USD
    window: 24h
    contributors:
      - tool: 'stripe_*'
        field: '$.amount'
      - tool: 'paypal_*'
        field: '$.total'
```

The ordering differs per door because only one of them can sequence gates in time. On the **MCP door** a call flows: policy decision → approval resolution (rule-level, if required) → budget gate → forward — a human can approve a call that the budget gate then checks with fresh numbers. The **sideband door** decides everything in one `/evaluate` round-trip, so budgets are checked at evaluate time: an `on_exceed: deny` breach is terminal there and preempts any approval ticket (the money gate forbids what the approver would have been asked to allow), while an allowed call's budget charges commit at `/audit` once the call actually executed. On both doors a deny rule denies before budgets are consulted, and dry-run peeks budgets without ever recording. The budget gate is all-or-nothing: every matching budget is peeked first, the call forwards only if all allow, and a denied call records nothing on any budget — including the rule-level rate/spend counters, which are only consumed when the call actually forwards. A denial returns structured feedback with `reason: budget_exceeded` and a `budgets` array listing every breached budget (name, `spent`, `remaining`, `reset_at`).

**Break-glass overages** (`on_exceed: require_approval`): a breach raises one composite approval ticket per call listing every breached budget, and the call proceeds only on an explicit approval — the overage is then recorded as `approved_overage` on the ledger and the audit trail. A denial or timeout records nothing (on the MCP door unconditionally; on the sideband when the adapter honors it — an executed-anyway report commits plain `spend` with the denied status on the record), and budget tickets always fail closed on timeout, even under `approval.default_on_timeout: allow`. When one call breaches a mix of `deny` and `require_approval` budgets, deny wins and no ticket is raised. On the MCP door a rule-level approval and a budget breach are two sequential human decisions (rule ticket first); the sideband merges both gates into its single native ticket. See [Budget break-glass tickets](./approvals.md#budget-break-glass-tickets) for the ticket mechanics.

`window: session` makes the pot deplete for the lifetime of a session key and never replenish on a timer; idle pots are collected after `idle_ttl` (default 24h), because neither door has an authoritative session-end signal. See the [configuration reference](./configuration.md#budgets) for the full schema and validation rules.

`action: spend_limit` keeps working as the per-rule quick path; budgets are the cross-tool layer on top.

## Evidence Requirements

Evidence grounding lets you require that certain information has been gathered before a tool call is allowed. Evidence is submitted by the [Python SDK](../packages/python-sdk/) via the sideband API.

```yaml
- name: require-order-before-refund
  match:
    tool: 'process_refund'
  action: allow
  evidence:
    requires:
      - order_lookup
```

When evidence is missing, the proxy returns self-repair feedback telling the agent what it needs to do:

```json
{
  "error": {
    "code": -32001,
    "message": "Missing required evidence: order_lookup",
    "data": {
      "blocked": true,
      "reason": "evidence_missing",
      "missing_evidence": ["order_lookup"],
      "suggestion": "Call the order_lookup tool first to provide the required evidence, then retry this action.",
      "retry_allowed": true
    }
  }
}
```

The `data` object also carries `rule`, `rule_index` (plus its deprecated alias `ruleIndex`), `action`, `expired_evidence`, and `missing_dependencies`.

Evidence entries have a configurable TTL (default: 300 seconds). If evidence has expired, the response includes `"reason": "evidence_expired"` with a suggestion to refresh it.

Rules using `evidence.requires` or `requires` are session-bound. If `Mcp-Session-Id` is missing on a matching request, Helio denies the call fail-closed.

SDK evidence keys are validated against policy: `POST /evidence` accepts keys that appear in at least one rule's `evidence.requires` list. If an SDK client sends an unknown key, the sideband returns `400` with `code: "evidence_key_not_in_policy_allowlist"` plus a capped preview of configured keys so operators can quickly align policy and SDK call sites.

## Dependency Chains

A lighter-weight alternative to evidence: require that specific tools have been called **and succeeded** in the current session before a gated tool is allowed:

```yaml
- name: verify-before-delete
  match:
    tool: 'delete_account'
  action: allow
  requires:
    - verify_customer
    - get_account_details
```

Both `verify_customer` and `get_account_details` must have been called and returned a successful upstream response in the same session before `delete_account` is allowed. An upstream error does not satisfy the dependency — otherwise an agent could invoke the dependency with a deliberately bad argument, let the upstream fail, and proceed to the gated tool without real evidence.

If you explicitly want the legacy "any attempted call satisfies the dependency" behavior (rare — most deployments want the outcome check), set `requires_success: false` on the rule:

```yaml
- name: any-prior-lookup-ok
  match:
    tool: 'process_refund'
  action: allow
  requires: ['orders.lookup']
  requires_success: false # attempted calls count even if upstream errored
```

## Feedback Messages

When a tool call is blocked, the proxy returns structured feedback as a JSON-RPC error. You can customize the message and suggestion per rule:

```yaml
- name: block-production-writes
  match:
    tool: 'db_write'
    environment: production
  action: deny
  feedback:
    message: 'Direct database writes are not allowed in production.'
    suggestion: 'Submit a migration request through the change management system.'
```

The `feedback.message` appears as the error message. The `feedback.suggestion` is included in the error `data` for agents to use for self-correction. If no feedback is configured, the proxy generates a default message based on the block reason.

On the [sideband adapter API](./adapter-api.md), `feedback` also accompanies `require_approval` and `dry_run` decisions when the gating rule configures it, so adapter-built approval prompts and shadow-mode reports can show the operator's rationale. Feedback on a plain `allow` rule is never surfaced.

## Flag Destructive

The `flag_destructive` option provides a safety net for tools that don't match any explicit rule but have `destructiveHint: true` in their MCP annotations:

```yaml
policies:
  default: allow
  flag_destructive: log # or: require_approval
```

- **`log`** — The call is allowed but flagged in the audit trail as `flagged_destructive: true`.
- **`require_approval`** — The call is automatically escalated to the approval workflow, even though no explicit rule matched.

> **Note:** Remember that the MCP spec defaults `destructiveHint` to `true` for tools that don't set it. With `flag_destructive: require_approval`, any tool that hasn't explicitly set `destructiveHint: false` will trigger an approval request.

## Dry-Run Mode

Dry-run mode lets you test policy rules without affecting the upstream server or consuming rate/spend budgets.

**Global dry-run** — all rules simulate:

```yaml
policies:
  dry_run: true
  rules:
    - name: block-destructive
      match:
        annotations:
          destructiveHint: true
      action: deny
```

**Per-rule dry-run** — only specific rules simulate:

```yaml
- name: test-new-rate-limit
  match:
    tool: 'search_*'
  action: dry_run
```

In dry-run mode:

- No requests are forwarded to the upstream server
- Rate limit slots are not consumed (uses `peek` instead of `check`)
- Spend limit budget is not consumed
- Tool calls are not recorded for dependency chain tracking
- Audit records are created with `dry_run: true`

## Rule Ordering

Since Helio uses first-match-wins, the order of rules determines behavior. Consider this example:

```yaml
rules:
  # Rule 1: Deny destructive tools
  - name: block-destructive
    match:
      annotations:
        destructiveHint: true
    action: deny

  # Rule 2: Allow all tools
  - name: allow-all
    match:
      tool: '*'
    action: allow
```

A destructive tool like `delete_record` matches **Rule 1** first and is denied. A non-destructive tool like `send_email` does not match Rule 1, falls through to **Rule 2**, and is allowed.

If you reversed the order, `allow-all` would match everything first and no tool would ever be denied. **Put specific rules before general ones.**

## Common Patterns

### Block destructive, allow reads

```yaml
policies:
  default: allow
  rules:
    - name: block-destructive
      match:
        annotations:
          destructiveHint: true
      action: deny

    - name: allow-reads
      match:
        annotations:
          readOnlyHint: true
      action: allow
```

### Default deny with explicit allows

```yaml
policies:
  default: deny
  rules:
    - name: allow-weather
      match:
        tool: 'get_weather'
      action: allow

    - name: allow-search
      match:
        tool: 'search_*'
      action: allow
```

### Approve writes via Slack

```yaml
policies:
  default: allow
  rules:
    - name: block-destructive
      match:
        annotations:
          destructiveHint: true
      action: deny

    - name: approve-writes
      match:
        annotations:
          readOnlyHint: false
      action: require_approval
      approval:
        channel: slack
        timeout: '300s'
```

### Rate limit expensive tools

```yaml
- name: rate-limit-queries
  match:
    tool: 'run_*_query'
  action: rate_limit
  limits:
    max_calls: 50
    window: '1h'
    key: session
```

### Spend limit payment tools

```yaml
- name: payment-budget
  match:
    tool: 'create_payment'
  action: spend_limit
  limits:
    max_spend:
      field: '$.amount'
      limit: 500
      currency: USD
      window: '1h'
      key: tool

- name: refund-budget
  match:
    tool: 'create_refund'
  action: spend_limit
  limits:
    max_spend:
      field: '$.amount'
      limit: 200
      currency: USD
      window: '1h'
      key: session
```

### Environment-specific rules

```yaml
environment: production

policies:
  rules:
    - name: prod-no-destructive
      match:
        annotations:
          destructiveHint: true
        environment: production
      action: deny

    - name: prod-approve-writes
      match:
        annotations:
          readOnlyHint: false
        environment: production
      action: require_approval
      approval:
        channel: slack
```

## Tool definition drift

Helio baselines every tool's definition — annotations, input/output schema,
description, title — the first time it sees it (at startup priming or the
first `tools/list`). The fingerprint covers the entire tool definition object, including non-standard fields. If a later `tools/list` reports a different definition
for the same tool — for example a tool that was `readOnlyHint: true` when you
wrote your policy turning destructive, or a description gaining injected
instructions — Helio marks the tool as **drifted**, writes an audit record
(`policy_decision: tool_drift`), and gates subsequent calls to it:

```yaml
policies:
  on_tool_drift: block # block (default) | require_approval | log
```

- `block` (default): calls to a drifted tool are denied with
  `tool_definition_drift` feedback until the proxy is restarted (which
  re-baselines) or the upstream reverts the change.
- `require_approval`: each call to a drifted tool is escalated through the
  approval channel.
- `log`: drift is audited and calls proceed, but policy rules are evaluated
  against **both** the baseline annotations (the definition you reviewed) and
  the current upstream claim — the stricter decision wins, so a drifted tool
  can never weaken enforcement in either direction. When stricter-of-both
  compares actions, `dry_run` outranks the limit actions (`rate_limit`,
  `spend_limit`) because it never forwards, and a conflict between `rate_limit`
  and `spend_limit` resolves to `spend_limit`. Logged calls carry the
  drift detail in the audit record's `evidence_chain.tool_drift` field (the
  active `mode` plus the per-aspect `changes`). The recorded `mode` is
  snapshotted when the call is gated, so it reflects the mode that was active
  at gate time even if the policy is hot-reloaded before the audit record is
  written.

Policy rules always see the baseline annotations for non-drifted tools.
Reverting the upstream definition to its baseline clears the drift state
(audited as `tool_drift_reverted`).

**Precedence:** drift gating overrides explicit `allow` rules and per-rule
`action: dry_run`. Global `policies.dry_run: true` still simulates everything
— a drifted call in global dry-run is reported with `would_forward: false`
and never forwarded.

**Duplicate names:** a `tools/list` that repeats a tool name is treated as
drift for that tool (aspect `duplicate`) — the definition is ambiguous, so
Helio fails closed until the upstream returns a unique definition. Without
this, a payload that lists the same name twice (one malicious entry, one
matching the baseline) could otherwise suppress drift detection while clients
bind to the malicious duplicate.

This closes the MCP "rug-pull" class of attack, where a tool definition
changes _after_ review so a one-time approval gives no lasting protection.

**Limitation:** baselines are per-process. A restart re-baselines from
whatever the upstream currently reports, so review drift audit records before
restarting.

## See Also

- [Configuration Reference](./configuration.md) — Full `helio.yaml` schema
- [Approval Workflows](./approvals.md) — `require_approval` action details
- [Audit Trail](./audit.md) — How policy decisions are recorded
- [Examples](../examples/) — Runnable configurations demonstrating these patterns
