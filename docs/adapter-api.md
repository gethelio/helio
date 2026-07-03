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

Helio classifies every governed call by **enforcement grade**, surfaced via the audit `origin` column:

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

## Authentication

The governance routes require `Authorization: Bearer <HELIO_ADAPTER_TOKEN>`. This is a **separate token** from the SDK's `HELIO_SDK_TOKEN`: an SDK client cannot drive policy decisions, and an adapter cannot call the SDK's `POST /evidence`/`/context` routes. The adapter's evidence access is deliberately narrow: it may attach evidence to a call it is auditing, via the optional `evidence` field on `POST /audit` (success-only, bound to that evaluation's own session/tool, subject to the policy allowlist — see [Populating evidence](#populating-evidence)); it cannot write arbitrary evidence to arbitrary sessions. Both tokens are generated per boot (and printed to stderr) unless set in the environment. Requests carrying an `Origin` header are refused (browser-forgery guard), and bodies over 1 MiB are rejected with 413.

If you embed `GovernanceService` directly (instead of running `helio start`), wire an `ApprovalRouter` whenever the policy can emit `require_approval` (explicit rules, `flag_destructive: require_approval`, or `on_tool_drift: require_approval`), otherwise construction and hot-reload fail closed by throwing `GovernanceConfigError` (exported from `@gethelio/proxy`).

## `POST /evaluate`

```jsonc
// Request
{
  "origin": "openclaw",                  // optional; default "sideband"; ^[a-z0-9_-]{1,64}$
  "adapter_version": "0.1.0",            // optional, ≤64 chars (per-origin liveness)
  "agent_id": "main",                    // optional
  "session_id": "oc-session-1",          // optional; required for evidence/dependency rules
  "tool": {
    "name": "send_message",              // required
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
  "decision": "allow",                   // allow | deny | require_approval | rate_limited | spend_limited | dry_run
  "reason": "Matched \"allow-chat\" → allow",
  "matched_rule": "allow-chat",          // null when the default policy applied
  "matched_rule_index": 2,
  "feedback": { "message": "…" },        // present on blocking decisions
  "approval": { "id": "…", "timeout_ms": 300000, "resolve_path": "/approval/…/resolve" }, // require_approval only
  "limits": { "rate": { } },             // present when a limit rule matched
  "dry_run": { "would_forward": true },  // dry_run only
  "tool_drift": { "changes": [ ] }       // present when the drift gate fired
}
```

The `decision` is an **outcome**, not Helio's internal rule action: a `rate_limit` rule that still has headroom returns `"allow"` with a `limits.rate` block; only when the bucket is exhausted does it return `"rate_limited"`. There is no `modify` decision — argument rewriting has no engine support today.

**Errors:** `400` validation / invalid JSON, `401` wrong-or-missing adapter token, `403` Origin header, `413` oversized `metadata`/`tool_input`/body, `400 reserved_metadata_key` (a reserved column key — currently `agent_id` — was passed inside `metadata`; use the top-level field), `400 origin_limit_exceeded` / `400 tool_baseline_limit` / `503 evaluation_backlog_full` / `503 limit_capacity_exhausted` (memory/cardinality budgets — see below), `503 governance_unavailable` (sideband running without the service). Unhandled server faults return `500 { "error": "Internal server error" }`; adapters must fail closed on any 5xx.

`match.metadata.*` rules and `sender_id`-scoped limits read the `metadata` object you supply here (well-known keys `channel_id`, `sender_id`, `sender_name`, `conversation_id`; the virtual `agent_id` comes from the top-level field). See the [Policy Guide](./policies.md#metadata).

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

Counters are consumed here (not at `/evaluate`), and only when the call actually ran (`success`/`error`, not `not_executed`). `/audit` is **idempotent on `evaluation_id`**: an identical replay returns `200 { already_finalized: true }` with no double-consumption, so a network retry after a lost response is safe. A different payload under the same id is an adapter bug → `409 evaluation_conflict`.

**Decision finalization.** `deny`, `rate_limited`, `spend_limited`, and `dry_run` are **terminal at `/evaluate`** — their audit record is written immediately, so completeness never depends on the adapter calling `/audit`. A later `/audit` for such an evaluation returns `200 { finalized_by: "evaluate" }` and accepts any payload, so adapters may audit unconditionally.

`actual_amount` must be finite and `>= 0` (`400 invalid_actual_amount` otherwise) and only applies to evaluations whose decision carried a spend rule (`400 no_spend_rule` if sent for any other evaluation).

### Populating evidence

The optional `evidence` array lets an adapter ground a call's outcome — e.g. recording the recipient a `send` tool actually resolved — so a later [evidence-grounded rule](./policies.md) (`evidence.requires`) can enforce on it. This is the **only** way the adapter token writes evidence; the SDK-scoped `POST /evidence` route is not available to it (see [Authentication](#authentication)). Each entry is `{ evidence_key, evidence_data, ttl_seconds? }`. The proxy binds the write to the **pending evaluation's own** `session_id` and `tool_name` — an adapter cannot target another session — and stores it via the same evidence store the SDK path uses.

Rules:

- **Success-only.** Evidence is written only when `status: "success"`. On `error`/`not_executed` it is ignored (a failed tool must not ground later calls).
- **First-finalize-only.** Evidence is written once, on the first `/audit`; idempotent replays never re-write (no TTL reset).
- **Every per-entry failure is soft — never request-fatal.** The audit always finalizes `201`; per-entry outcomes are reported in the response `evidence` array as `{ evidence_key, stored, reason? }`. Reasons: `key_not_in_policy_allowlist` (the key is not named by any `evidence.requires` rule), `too_large` (`evidence_data` over 64 KiB), `too_many` (more than 16 entries — the excess is dropped), `no_session` (the evaluation had no `session_id`), `evidence_unavailable` (this deployment runs governance without an evidence store), `closed` (the store is shutting down). **A rejected key is silently not stored**, so a later grounded `/evaluate` will fail closed — make sure every key you populate is named by an `evidence.requires` rule.
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

The `sender_id` budget is a **reservation registry**: because `sender_id` is caller-minted, a new sender key is reserved at `/evaluate` (pre-execution, so it can fail closed) and released once its limiter bucket empties. It is scoped to `sender:*` keys only, so a flood of sender ids can never starve the structural MCP path's `tool`/`session` limits — the two doors share one limiter, but only the untrusted key family is capped.

## `POST /install-scan`

Evaluates a package/skill install against the operator's `policies.install` rules (see the [Policy Guide](./policies.md#install-time-policy-deny_install)). When **no** `policies.install` block is configured it stays observational — always `decision: "allow"` with `reason: "no install-time rules defined"`. With rules, a matching `deny_install` returns `decision: "deny"` and writes an audit record with `record_kind: "install_scan"` and `block_reason: "install_denied"`. Either way the call is terminal — no `/audit` follow-up is expected.

```jsonc
// Request
{ "origin": "openclaw", "package": { "name": "left-pad", "version": "1.3.0", "source": "npm" }, "metadata": { "sender_id": "U7" } }
// Response 200 (allowed)
{ "evaluation_id": "…", "decision": "allow", "reason": "no install-time rules defined", "matched_rule": null }
// Response 200 (denied by a deny_install rule)
{ "evaluation_id": "…", "decision": "deny", "reason": "Matched \"block-evil\" → deny_install", "matched_rule": "block-evil", "feedback": { "message": "…" } }
```

Install rules can match on the package `name` (glob), `source`, and `metadata.*` context (the same reserved keys). `metadata.agent_id` is rejected here too (see `/evaluate`).

## Approvals

A `require_approval` decision creates a **native ticket** (`channel_name: native:<origin>`): Helio does not block, start timeout timers, or notify a channel, because the adapter runs the approval in its own UI (e.g. a Telegram dialog). The dashboard shows the ticket but its approve/deny buttons return `409 native_ticket` — only the adapter can resolve it, via:

```jsonc
// POST /approval/:id/resolve
{ "resolution": "approved" | "denied" | "timeout" | "cancelled",
  "resolved_by": "telegram:@oli",   // required for approved/denied
  "reason": "…", "scope": "once" | "always" }
// Response 200
{ "ok": true }
```

The resolution does **not** write the audit record; the subsequent `/audit` does, copying the approval status. A native ticket times out at `min(rule timeout, evaluation TTL)`; deadlines are enforced on access, so a late resolve deterministically returns `409 already_resolved`.

## Audit record additions

Sideband activity shares the audit schema with the MCP path, plus three columns (also used by the dashboard):

- `record_kind` — `tool_call` | `drift_event` | `install_scan` | `evaluation_expired`.
- `origin` — `mcp` for the proxy path, or the adapter origin string.
- `metadata` — the adapter-supplied context object (reserved keys `channel_id`, `sender_id`, `sender_name`, `conversation_id`). `agent_id` is **not** carried here — it has its own column and is rejected if placed in `metadata`.

An install denied by a `deny_install` rule is recorded with `record_kind: install_scan`, `policy_decision: deny`, and `block_reason: install_denied`.

See [Audit Trail](./audit.md) for the full record reference.

## See also

- [Sideband API Reference](./sideband-api.md) — the dashboard sideband (`:3100`), a different server.
- [Configuration](./configuration.md) — the `sdk.*` block (`enabled`, `port`, `host`, `evaluation_ttl`).
- [Policy Guide](./policies.md) — the rules these endpoints evaluate.
