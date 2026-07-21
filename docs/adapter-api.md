# Adapter Governance API (sideband)

> **Status: experimental.** These four endpoints are how hook-based agent frameworks (OpenClaw first) drive Helio's policy engine without an MCP transport to interpose on. The contract may change in a breaking way until a second adapter validates its neutrality. Pin your adapter to a Helio minor version.

The governance API lives on the **SDK sideband** — the local server on `127.0.0.1:3200` (configurable via `sdk.*`), the same server the Python SDK uses for evidence/context. It is **not** the dashboard sideband (`:3100`, documented in [Sideband API Reference](./sideband-api.md)); the two are different servers with different jobs. Endpoints here:

| Route                        | Purpose                                                                                        |
| ---------------------------- | ---------------------------------------------------------------------------------------------- |
| `POST /evaluate`             | Decide a tool call. **Side-effect-free** on rate/spend counters.                               |
| `POST /audit`                | Record the outcome of an evaluated call; **consumes** counters. Idempotent.                    |
| `POST /install-scan`         | Evaluate a package/skill install against `policies.install` (observational when none defined). |
| `POST /approval/:id/resolve` | Record the resolution of a natively-handled approval.                                          |

## Why this exists, and what it does not promise

Helio's headline guarantee is **structural** enforcement: an agent speaking MCP physically cannot reach a tool except through the proxy. Hook-based frameworks run their tools in-process, so there is nothing to proxy — the framework's hook dispatcher is the enforcement point, and Helio supplies the decision. This is the standard policy-decision-point / policy-enforcement-point split.

Helio classifies every governed call by **enforcement grade**. The audit `origin` column separates host-enforced calls (the adapter's origin string) from proxy-path calls (`mcp`); whether an `mcp` record was structural or network is a property of the deployment's upstream transport, not something the record captures:

| Grade           | Path                     | Guarantee                                                          |
| --------------- | ------------------------ | ------------------------------------------------------------------ |
| `structural`    | stdio MCP                | Helio owns the only path to the tool.                              |
| `network`       | HTTP MCP                 | Structural given the operator controls egress.                     |
| `host-enforced` | hook adapters (this API) | Enforcement by the host framework's hook gate; decisions by Helio. |

The host-enforced grade is **cooperative**: it works only if the adapter faithfully calls `/evaluate`, honors the decision, and reports `/audit`. A malicious in-process skill that bypasses the hook is outside what this API can prevent (`/install-scan` exists to gate exactly that vector). Helio does not market the hook path as proxy-grade, and neither should you.

### Normative adapter requirements

An adapter built on this API **MUST**:

1. **Fail closed.** If `/evaluate` is unreachable, times out, or returns 5xx, **block** the tool call. Never proceed on a failed decision — this is the property that couples tool execution to Helio's liveness.
2. **Resolve before auditing.** For a `require_approval` decision, call `/approval/:id/resolve` before `/audit` (see [Approvals](#approvals)).
3. **Carry tool definitions where it can** (`tool.input_schema`, `tool.annotations`, …) so adapter-origin tools get the same rug-pull / drift guard as MCP tools.
4. **Authenticate** with the adapter-scope bearer token (`HELIO_ADAPTER_TOKEN`), never the SDK token.
5. **Treat any `decision` value you do not recognize as `deny`.** The decision vocabulary grows (this release adds `budget_exceeded`); an adapter that falls through an unknown value to "proceed" turns every future vocabulary addition into a governance bypass. Parsing the response against a closed enum and blocking on parse failure satisfies this.

## Authentication

The governance routes require `Authorization: Bearer <HELIO_ADAPTER_TOKEN>`. This is a **separate token** from the SDK's `HELIO_SDK_TOKEN`: an SDK client cannot drive policy decisions, and an adapter cannot call the SDK's `POST /evidence`/`/context` routes. The adapter's evidence access is deliberately narrow: it may attach evidence to a call it is auditing, via the optional `evidence` field on `POST /audit` (success-only, bound to that evaluation's own session/tool, subject to the policy allowlist — see [Populating evidence](#populating-evidence)); it cannot write arbitrary evidence to arbitrary sessions. Both tokens are generated per boot unless set in the environment; a generated token is printed to stderr on start, while an environment-provided one is acknowledged without its value. Requests carrying an `Origin` header are refused (browser-forgery guard), and bodies over 1 MiB are rejected with 413.

If you embed `GovernanceService` directly (instead of running `helio start`), wire an `ApprovalRouter` whenever the policy can emit `require_approval` (explicit rules, `flag_destructive: require_approval`, or `on_tool_drift: require_approval`), otherwise construction and hot-reload fail closed by throwing `GovernanceConfigError` (exported from `@gethelio/proxy`).

## `POST /evaluate`

```jsonc
// Request
{
  "origin": "openclaw",                  // optional; default "sideband"; ^[a-z0-9_-]{1,64}$
  "adapter_version": "0.1.0",            // optional, ≤64 chars; per-origin liveness (dashboard GET /api/adapters)
  "agent_id": "main",                    // optional, ≤128 chars
  "session_id": "oc-session-1",          // optional, ≤256 chars; required for evidence/dependency rules
  "tool": {
    "name": "send_message",              // required, ≤256 chars
    "description": "…",                  // optional ┐ full definition enables the drift guard
    "input_schema": { },                 // optional ┤
    "annotations": { "destructiveHint": false } // optional ┘
  },
  "arguments": { "channel": "#general", "text": "hi" }, // optional (≤64 KiB)
  "metadata": { "channel_id": "C1", "sender_id": "U7" } // optional (≤4 KiB)
}

// Response 200
{
  "evaluation_id": "5f2…",               // correlate with /audit; present even for terminal decisions
  "decision": "allow",                   // allow | deny | require_approval | rate_limited | spend_limited | budget_exceeded | dry_run
  "reason": "Matched \"allow-chat\" → allow",
  "matched_rule": "allow-chat",          // null when the default policy applied
  "matched_rule_index": 2,
  "feedback": { "message": "…" },        // always on blocking decisions; on require_approval / dry_run when the gating rule configures feedback
  "approval": { "id": "…", "timeout_ms": 300000, "resolve_path": "/approval/…/resolve" }, // require_approval only
  "limits": { "rate": { } },             // present when a limiter-backed limit rule or a budget matched (rate | spend | budgets)
  "dry_run": { "would_forward": true, "evidence_satisfied": true, "limits_ok": true }, // dry_run only — limits_ok covers the matched rule limit AND budgets
  "tool_drift": { "changes": [ ] }       // present when the drift gate fired
}
```

The `decision` is an **outcome**, not Helio's internal rule action: a `rate_limit` rule that still has headroom returns `"allow"` with a `limits.rate` block; only when the bucket is exhausted does it return `"rate_limited"`. There is no `modify` decision — argument rewriting has no engine support today. Under dry-run the same resolution happens as a pure simulation: a matched `rate_limit`/`spend_limit` rule that clears evidence is peeked — never consumed, never reserving sender-key capacity — its snapshot appears in `limits.rate` / `limits.spend`, and `dry_run.would_forward` / `limits_ok` combine the rule limit with the budget peeks (an unreadable spend amount simulates as `limits.spend.reason: "invalid_amount"`). Both paths report `limits` only when the proxy's rate and spend limiters are wired: `helio start` always wires them, so the qualification bites only a direct embedder that constructs `GovernanceService` without one — there, a matched limit rule resolves as an allow (or a would-forward simulation) carrying no snapshot.

**Errors:** `400` validation / invalid JSON, `401` wrong-or-missing adapter token, `403` Origin header, `413` oversized `metadata`/`tool_input`/body, `400 reserved_metadata_key` (a reserved column key — currently `agent_id` — was passed inside `metadata`; use the top-level field), `400 origin_limit_exceeded` / `400 tool_baseline_limit` / `503 evaluation_backlog_full` / `503 limit_capacity_exhausted` (memory/cardinality budgets — see below), `503 governance_unavailable` (sideband running without the service). Unhandled server faults return `500 { "error": "Internal server error" }`; adapters must fail closed on any 5xx.

`match.metadata.*` rules and `sender_id`-scoped limits read the `metadata` object you supply here (well-known keys `channel_id`, `sender_id`, `sender_name`, `conversation_id`; the virtual `agent_id` comes from the top-level field). See the [Policy Guide](./policies.md#metadata).

### Cross-tool spend budgets on this API

When the call's tool matches a configured [budget](./policies.md#cross-tool-spend-budgets)'s contributors, the response carries a `limits.budgets` array — one block per matching budget:

```jsonc
"limits": {
  "budgets": [
    {
      "name": "demo-payments",
      "limit": 50,
      "spent": 40,
      "remaining": 10,
      "attempted_amount": 20,        // null when the amount could not be read
      "currency": "USD",
      "window": "1h",                // raw config string: "1h" | "session"
      "on_exceed": "deny",
      "allowed": false,
      "reset_at_ms": 1783947600000   // epoch ms; null for session windows, which never replenish
    }
  ]
}
```

(The MCP door's self-repair feedback spells the reset field as ISO-8601 `reset_at`; the sideband and `GET /api/budgets` use epoch `reset_at_ms`. Each door keeps its established reset-field idiom — a deliberate per-surface split, not drift.)

A breach of an `on_exceed: deny` budget returns `decision: "budget_exceeded"` — **terminal at `/evaluate`**, like the other blocking decisions: the audit record is written immediately and nothing is recorded on any budget. A budget whose contributor cannot read a valid amount from the arguments fails closed the same way, with `reason: "invalid_amount"` inside its block, regardless of its `on_exceed`. A breach of an `on_exceed: require_approval` budget instead returns `decision: "require_approval"` with the standard `approval` block — the break-glass ticket; see [Approvals](#approvals) for how it merges with a rule-level approval. When budgets alone triggered the approval, `feedback` explains the breach so the host dialog can show why. On an allowed call the budget charges commit at `/audit`, only when the call actually executed; `actual_amount`, when supplied, overrides every budget charge (a call has one true realized cost) as well as the spend-rule amount. Budget enforcement on this tier is subject to [the TOCTOU caveat](#the-crash-ttl-and-toctou-caveats) below, like every other counter this API consumes at `/audit`.

## `POST /audit`

```jsonc
// Request
{
  "evaluation_id": "5f2…",
  "status": "success" | "error" | "not_executed",
  "error": "…",            // optional, when status == "error"
  "duration_ms": 412,      // optional
  "result": { },           // optional outcome summary
  "actual_amount": 0.42,   // optional, finite ≥0 — true post-execution spend; overrides the arg-derived amount
  "evidence": [            // optional — see "Populating evidence" below
    { "evidence_key": "recipient", "evidence_data": { "to": "a@b.com" }, "ttl_seconds": 300 }
  ]
}

// Response 201 (fresh) — replays return 200
{
  "ok": true,
  "audit_record_id": "…",
  "evidence": [            // present only when the request carried evidence
    { "evidence_key": "recipient", "stored": true }
  ]
}
```

Counters are consumed here (not at `/evaluate`), and only when the call actually ran (`success`/`error`, not `not_executed`). `/audit` is **idempotent on `evaluation_id`**: an identical replay returns `200 { already_finalized: true }` with no double-consumption, so a network retry after a lost response is safe. Finalized ids are remembered for one `sdk.evaluation_ttl` after finalization; past that window a replay gets `404 evaluation_unknown`. A different payload under the same id is an adapter bug → `409 evaluation_conflict`.

**Decision finalization.** `deny`, `rate_limited`, `spend_limited`, `budget_exceeded`, and `dry_run` are **terminal at `/evaluate`** — their audit record is written immediately, so completeness never depends on the adapter calling `/audit`. A later `/audit` for such an evaluation returns `200 { finalized_by: "evaluate" }` and accepts any payload, so adapters may audit unconditionally (within the same one-TTL window).

`actual_amount` must be finite and `>= 0` (`400 invalid_actual_amount` otherwise) and only applies to evaluations that track money — a spend rule or one or more matched budgets (`400 no_spend_rule` if sent for any other evaluation). It is the call's one true realized cost: it overrides the spend-rule amount AND every matched budget's charge.

### Populating evidence

The optional `evidence` array lets an adapter ground a call's outcome — e.g. recording the recipient a `send` tool actually resolved — so a later [evidence-grounded rule](./policies.md) (`evidence.requires`) can enforce on it. This is the **only** way the adapter token writes evidence; the SDK-scoped `POST /evidence` route is not available to it (see [Authentication](#authentication)). Each entry is `{ evidence_key, evidence_data, ttl_seconds? }`. The proxy binds the write to the **pending evaluation's own** `session_id` and `tool_name` — an adapter cannot target another session — and stores it via the same evidence store the SDK path uses.

Rules:

- **Success-only.** Evidence is written only when `status: "success"`. On `error`/`not_executed` it is ignored (a failed tool must not ground later calls).
- **First-finalize-only.** Evidence is written once, on the first `/audit`; idempotent replays never re-write (no TTL reset).
- **Every per-entry failure is soft — never request-fatal.** The audit always finalizes `201`; per-entry outcomes are reported in the response `evidence` array as `{ evidence_key, stored, reason? }`. Reasons: `key_not_in_policy_allowlist` (the key is not named by any `evidence.requires` rule), `too_large` (`evidence_data` over 64 KiB), `too_many` (more than 16 entries — the excess is dropped), `no_session` (the evaluation had no `session_id`), `evidence_unavailable` (this deployment runs governance without an evidence store), `closed` (the store is shutting down). **A rejected key still finalizes the audit with `201`** — the only signal is the per-entry outcome — and its evidence is not stored, so a later grounded `/evaluate` will fail closed. Make sure every key you populate is named by an `evidence.requires` rule.
- **Idempotency.** Evidence is part of the `/audit` idempotency hash (order-independent): an identical retry replays cleanly, but the same `evaluation_id` with divergent evidence is `409 evaluation_conflict`.

**Other responses:** `404 evaluation_unknown`, `404 evaluation_expired` (the decision aged out — see below), `409 approval_unresolved` (resolve the approval first; **retryable** with short backoff).

### The crash-TTL and TOCTOU caveats

- An evaluation that is never audited expires after `sdk.evaluation_ttl` (default `10m`) into an audit record with `record_kind: "evaluation_expired"`. This is a **bypass/tamper signal**, not a normal block — surface it in monitoring.
- Because decision and execution are separate calls, two concurrent `/evaluate`s can both peek the last limit slot and both execute. Counters stay truthful after the fact (both `/audit`s record), but the host-enforced tier cannot close this window from the proxy side.

### Memory and cardinality budgets

A token-bearing adapter is in the threat model, so several caller-controlled growth vectors are bounded. Breaches fail closed (the call is refused, never silently dropped):

| Budget                          | Limit           | On breach                                                                 |
| ------------------------------- | --------------- | ------------------------------------------------------------------------- |
| Distinct origins                | 32              | `400 origin_limit_exceeded`                                               |
| Baselined tools per origin      | 1,024           | `400 tool_baseline_limit` (first-seen only; existing tools keep updating) |
| `tool_input` (serialized)       | 64 KiB          | `413`                                                                     |
| `metadata` (serialized)         | 4 KiB           | `413`                                                                     |
| Pending evaluations             | 10,000 / 64 MiB | `503 evaluation_backlog_full`                                             |
| Distinct `sender_id` limit keys | 50,000          | `503 limit_capacity_exhausted`                                            |

The `sender_id` budget is a **reservation registry**: because `sender_id` is caller-minted, a new sender key is reserved at `/evaluate` (pre-execution, so it can fail closed) and released once its limiter or budget bucket empties. It is scoped to sender-derived keys only — `sender:*` rule-limit keys and `budget:<name>:sender:*` budget buckets — so a flood of sender ids can never starve the structural MCP path's `tool`/`session` limits. A sender that exercises several sender-keyed rules or budgets holds one slot per exercised bucket.

## `POST /install-scan`

Evaluates a package/skill install against the operator's `policies.install` rules (see the [Policy Guide](./policies.md#install-time-policy-deny_install)). When **no** `policies.install` block is configured it stays observational — always `decision: "allow"` with `reason: "no install-time rules defined"`. With rules, a matching `deny_install` returns `decision: "deny"` and writes an audit record with `record_kind: "install_scan"` and `block_reason: "install_denied"`. Either way the call is terminal — no `/audit` follow-up is expected.

```jsonc
// Request
{ "origin": "openclaw", "package": { "name": "left-pad", "version": "1.3.0", "source": "npm" }, "metadata": { "sender_id": "U7" } }
// Response 200 (allowed)
{ "evaluation_id": "…", "decision": "allow", "reason": "no install-time rules defined", "matched_rule": null, "matched_rule_index": null }
// Response 200 (denied by a deny_install rule)
{ "evaluation_id": "…", "decision": "deny", "reason": "Matched \"block-evil\" → deny_install", "matched_rule": "block-evil", "matched_rule_index": 0, "feedback": { "message": "…" } }
```

Install rules can match on the package `name` (glob), `source`, and `metadata.*` context (the same well-known keys). `metadata.agent_id` is rejected here too (see `/evaluate`).

## Approvals

A `require_approval` decision creates a **native ticket** (`channel_name: native:<origin>`): Helio does not block, start timeout timers, or notify a channel, because the adapter runs the approval in its own UI (e.g. a Telegram dialog). The dashboard shows the ticket but its approve/deny buttons return `409 native_ticket` — only the adapter can resolve it, via:

```jsonc
// POST /approval/:id/resolve
{ "resolution": "approved" | "denied" | "timeout" | "cancelled",
  "resolved_by": "telegram:@oli",   // required for approved/denied
  "reason": "…",                    // recorded for denials only (the audit record's denial reason)
  "scope": "once" | "always" }      // reserved; accepted but currently ignored
// Response 200
{ "ok": true }
```

The resolution does **not** write the audit record; the subsequent `/audit` does, copying the approval status. A native ticket times out at `min(rule timeout, evaluation TTL)`; deadlines are enforced on access, so a late resolve deterministically returns `409 already_resolved`.

### Budget break-glass rides the same ticket

When one or more `on_exceed: require_approval` budgets breach (issue #14), the sideband raises **exactly one merged native ticket per call, always in the standard `approval` block** — the response never contains a second approval block, and there is no separate budget-approval wire shape. The one resolution decides everything the call gated:

- **Merged ticket** (a `require_approval` rule AND breached budgets): one ticket carries both contexts — the rule fields plus `breached_budgets` (visible on the dashboard and the approvals REST API; native tickets never notify channels, so no webhook fires. The block is not part of the `/evaluate` response). Its timeout comes from the RULE's approval config. Approving resolves both gates; denying resolves both as denied.
- **Budget-only ticket** (the rule allowed; only the money gate objected): the ticket's timeout comes from the first breached budget's `approval` config (config order), falling back to the global `approval.timeout`.

This merged single-decision contract is the sideband's deliberate interpretation of the execution order: the one-round-trip `/evaluate` contract cannot sequence the rule gate and the money gate as separate pre-execution phases (the host, not Helio, is the enforcement point and executes after the single resolution), so merging is the only single-round-trip semantics that keeps the budget gate enforced. The MCP door, which can sequence gates in time, keeps two sequential human decisions instead. This asymmetry is intentional and regression-tested. If a future adapter needs separate approvers for the policy gate vs the money gate, that ships as an additive capability-declared extension, never as a change to this default.

Commit semantics at `/audit` (on top of the [decision-finalization rules](#post-audit)): `/audit` still returns `409 approval_unresolved` until the one ticket resolves. An **approved** ticket followed by `status: success | error` commits each breached budget's charge as `kind: "approved_overage"` (unbreached budgets the call also matched commit as plain `spend`, in the same atomic batch). `approved` + `not_executed` commits nothing. A **denied or timed-out** ticket followed by a reported `success` commits as plain `spend` with the denied/timeout `approval_status` on the audit record — the counters stay truthful about money that actually moved, and the record carries the evidence (this is the documented host-misbehavior/TOCTOU window). A ticket timeout the adapter honors (`not_executed`, or no `/audit` at all → `evaluation_expired`) commits nothing. A `not_executed` report still keeps the money-gate evidence: the audit record's `evidence_chain.budgets` carries the peeked per-budget context (no `kind` — nothing was committed), and when a BUDGET-ONLY ticket was denied or timed out and honored, the record's `block_reason` is `budget_exceeded` — the same value the MCP door records for that event, so dashboard budget filters see both doors (a denied MERGED ticket keeps `approval_denied`: the rule gate is first in the settled order). `scope: "always"` on a resolve is inert for any ticket carrying `breached_budgets` — budget approvals are scope-once by definition (issue #127), so an identical next call breaches again.

**Errors:** `404 ticket_not_found`, `409 not_a_native_ticket` (an MCP-path ticket — resolve those from their approval channel), `409 already_resolved` (normally includes the ticket's terminal `status`; deadline-crossed resolves return this error, and a rare concurrent-resolve race may omit `status`), `400` when `resolved_by` is missing for `approved`/`denied`, `503 governance_unavailable`. The request-level errors from `/evaluate` (`400` validation / invalid JSON, `401`, `403`, `413`) apply here as everywhere on this server.

## Audit record additions

Sideband activity shares the audit schema with the MCP path, plus three columns (also used by the dashboard):

- `record_kind` — `tool_call` | `drift_event` | `install_scan` | `evaluation_expired`.
- `origin` — `mcp` for the proxy path, or the adapter origin string.
- `metadata` — the adapter-supplied context object, stored as sent (well-known match keys: `channel_id`, `sender_id`, `sender_name`, `conversation_id`). `agent_id` is **not** carried here — it has its own column and is rejected if placed in `metadata`.

An install denied by a `deny_install` rule is recorded with `record_kind: install_scan`, `policy_decision: deny`, and `block_reason: install_denied`.

See [Audit Trail](./audit.md) for the full record reference.

## See also

- [Sideband API Reference](./sideband-api.md) — the dashboard sideband (`:3100`), a different server.
- [Configuration](./configuration.md) — the `sdk.*` block (`enabled`, `port`, `host`, `evaluation_ttl`).
- [Policy Guide](./policies.md) — the rules these endpoints evaluate.
