# Approval Workflows

When a policy rule has `action: require_approval`, Helio holds the HTTP request open and waits for a human to approve or deny the tool call. This gives you a human-in-the-loop checkpoint for sensitive operations.

Rule-level `approval` config is optional. If a `require_approval` rule omits it, Helio falls back to channel `dashboard` and the global timeout from top-level `approval.timeout`.

## How Approvals Work

1. A `tools/call` request matches a rule with `action: require_approval`.
2. The proxy creates an **approval ticket** containing the tool name, arguments, matched rule, and session ID.
3. The ticket is sent to the configured **approval channel** (dashboard, webhook, or Slack).
4. The HTTP request is held open while waiting for a decision.
5. A human approves, denies, the timeout fires, the client disconnects, or the proxy shuts down.
6. The proxy either forwards the request upstream (approved, break-glass, or timed out with `default_on_timeout: allow`) or returns a structured error (`denied`, `timeout` with `default_on_timeout: deny`, `client_disconnected`, or `shutdown_cancelled`).

The payload on the ticket is the payload that runs. The proxy freezes
`tools/call` params with a deep copy at entry, so a caller that rewrites
its arguments while a ticket is pending changes nothing: the call the
approver sees is the call that was evaluated, the call that forwards on
approval, and the call the audit record preserves. Params that cannot be
deep-copied are rejected outright with an invalid-params error whose
message reads `tools/call params must be JSON-serializable`.

The resolution is recorded in the [audit trail](./audit.md) on the tool call's audit record (`approval_status`, `approved_by`, `approval_wait_ms`, and — when there is a denial reason or an escalation — an `evidence_chain.approval` block with those details). The ticket itself is held in memory only — it stays queryable through the approvals REST API and dashboard for an hour after resolution, then it is cleaned up.

## Channels

Helio supports three approval channel types. You can configure multiple channels — each rule specifies which channel to use via the `approval.channel` field. A channel can also set an optional `name`; `approval.channel` (and escalation `delegates`) reference a channel by its `name` when one is set, or by its `type` otherwise — which is what lets two channels of the same type coexist. A channel that sets `name` is reachable ONLY by that name (referencing its bare type is rejected at validation, since no channel would answer to it at runtime).

### Dashboard

The dashboard channel requires no additional configuration. Approval tickets appear in the dashboard's Approvals tab and can be resolved via the UI or REST API.

```yaml
approval:
  channels:
    - type: dashboard
```

The dashboard channel is always available as a fallback, even if other channels are configured.

Because the dashboard's approvals API is the only surface that can resolve
dashboard-routed tickets, dashboard-routed approvals require the dashboard
server. Startup validation rejects `dashboard.enabled: false` combined with
any dashboard-routed rule or budget approval — explicit
`approval.channel`, a viable escalation delegate, or the
no-`approval`-block fallback — and with
`policies.flag_destructive: require_approval` or
`policies.on_tool_drift: require_approval`, whose escalation tickets always
use the dashboard channel. Route the approval to a Slack channel to run
without the dashboard. Rules matching only on sideband `match.metadata` are
exempt: their tickets are adapter-resolved and never notify a channel.

### Webhook

The webhook channel sends an HTTP POST notification to an external URL when an approval is requested. The external system is expected to call back to the proxy's REST API to resolve the ticket.

```yaml
approval:
  channels:
    - type: webhook
      url: 'https://your-system.example.com/helio-approvals'
      secret: 'your-hmac-secret' # Optional
```

**Notification payload:**

```json
{
  "event": "approval_requested",
  "ticket": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "tool_name": "delete_record",
    "tool_input": { "id": "123" },
    "matched_rule": "approve-deletes",
    "rule_index": 0,
    "channel_name": "webhook",
    "session_id": "session-abc",
    "requested_at": "2026-04-09T12:00:00.000Z",
    "timeout_at": "2026-04-09T12:05:00.000Z",
    "timeout_ms": 300000,
    "status": "pending",
    "notification_failures": []
  }
}
```

**HMAC signing:** When `secret` is configured, the request includes an `x-helio-signature` header with the format `sha256=<hex_digest>`. The signature is computed as HMAC-SHA256 over the JSON request body using the configured secret.

**Callback:** The external system resolves the ticket by calling the proxy's REST API on the dashboard sideband port (default `127.0.0.1:3100`), with an `Authorization: Bearer <api_secret>` header:

- `POST /api/approvals/:id/approve` with `{ "approved_by": "alice" }`
- `POST /api/approvals/:id/deny` with `{ "denied_by": "bob", "reason": "Too risky" }`

> **Note:** Webhook notification errors are logged but never block the approval flow. The ticket remains resolvable via the REST API regardless of whether the webhook delivery succeeds.

> **Note:** The sideband binds to `127.0.0.1` by default, which an external system cannot reach. If the callback comes from another host, set `dashboard.host` to a reachable interface — Helio warns at startup when a webhook channel is configured against a loopback-bound sideband. The dashboard must also stay enabled while a webhook channel is configured (`dashboard.enabled: false` plus a webhook channel is a startup error).

### Slack

The Slack channel sends a Block Kit message with interactive Approve and Deny buttons to a Slack channel. When a user clicks a button, Helio resolves the ticket and updates the message with the result.

> **Slack deny does not capture a denial reason.** The router supports optional denial reasons (`denial_reason` in the JSON-RPC error response; a supplied reason is also stored on the ticket and in the audit record's `evidence_chain.approval`), but Slack button clicks have no free-text input, so Slack-resolved denials always return `denial_reason: null` to the caller. The dashboard's deny modal does capture a reason. A future Slack modal flow could capture reasons too — tracked as a follow-up.

```yaml
approval:
  channels:
    - type: slack
      bot_token: '${HELIO_SLACK_BOT_TOKEN}'
      signing_secret: '${HELIO_SLACK_SIGNING_SECRET}'
      channel: '${HELIO_SLACK_CHANNEL}'
```

See [Slack App Setup](#slack-app-setup) below for a step-by-step guide.

## Slack App Setup

### 1. Create the Slack App

Go to [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App** > **From scratch**.

- **App Name:** `Helio Approvals` (or any name you prefer)
- **Workspace:** Select the workspace where approvals should be routed

### 2. Configure Bot Permissions

Navigate to **OAuth & Permissions** and add these **Bot Token Scopes**:

| Scope        | Purpose                                                                          |
| ------------ | -------------------------------------------------------------------------------- |
| `chat:write` | Post approval messages and update them after approve/deny (covers `chat.update`) |

### 3. Install to Workspace

Click **Install to Workspace** and authorize the app. Copy the **Bot User OAuth Token** — it starts with `xoxb-`.

### 4. Get the Signing Secret

Go to **Basic Information** and copy the **Signing Secret**. This is used to verify that incoming action callbacks are genuinely from Slack.

### 5. Set Up the Approval Channel

1. Create a channel (e.g. `#agent-approvals`) or use an existing one.
2. Invite the bot: type `/invite @Helio Approvals` in the channel.
3. Get the channel ID: right-click the channel name > **View channel details** > copy the ID at the bottom (starts with `C`).

### 6. Enable Interactivity

Navigate to **Interactivity & Shortcuts** and toggle **Interactivity** on.

Set the **Request URL** to:

```
http://<your-host>:3000/slack/actions
```

This is the endpoint where Slack sends button click callbacks. The proxy verifies each callback using the signing secret and constant-time comparison to prevent timing attacks.

Security behavior on callback verification failures:

- Helio returns `401 { "error": "Unauthorized" }` for all failed Slack callback auth checks (missing headers, malformed timestamp, stale timestamp, or invalid signature).
- Helio logs an operator-facing warning line to stderr with normalized rejection metadata (`reason=...`, source hint, and timestamp/signature presence flags).
- The response body is intentionally opaque so external callers cannot distinguish which auth gate failed.

> **Note:** For local development, you need a tunnel to expose the proxy to Slack. Use [ngrok](https://ngrok.com) or a similar tool:
>
> ```bash
> ngrok http 3000
> # Use the https URL as the Request URL: https://abc123.ngrok.io/slack/actions
> ```

### 7. Configure helio.yaml

Add the Slack channel to your configuration using environment variables for secrets:

```yaml
approval:
  timeout: '300s'
  default_on_timeout: deny
  channels:
    - type: slack
      bot_token: '${HELIO_SLACK_BOT_TOKEN}'
      signing_secret: '${HELIO_SLACK_SIGNING_SECRET}'
      channel: '${HELIO_SLACK_CHANNEL}'
    - type: dashboard # Fallback
```

Set the environment variables before starting the proxy:

```bash
export HELIO_SLACK_BOT_TOKEN="xoxb-your-bot-token"
export HELIO_SLACK_SIGNING_SECRET="your-signing-secret"
export HELIO_SLACK_CHANNEL="C0123456789"
# Required because any `require_approval` rule also needs `dashboard.api_secret`.
# Generate fresh with `openssl rand -hex 32` and reference it from helio.yaml as
# `dashboard.api_secret: '${HELIO_DASHBOARD_SECRET}'`. See "Authentication" below.
export HELIO_DASHBOARD_SECRET="$(openssl rand -hex 32)"
```

Or use a `.env` file with your preferred env loading tool. The `examples/slack-approvals/` bundle is a complete, runnable reference for this layout — `.env.example` lists all four variables, `helio.yaml` interpolates each one, and `pnpm start` validates that they are set before launching.

## Timeout Behavior

Every approval request has a timeout. When the timeout fires naturally, the ticket status becomes `timeout`, and then `default_on_timeout` decides whether Helio forwards or blocks:

```yaml
approval:
  timeout: '300s' # 5 minutes (default)
  default_on_timeout: deny # deny (default) or allow
```

- `default_on_timeout: deny` returns `approval_timeout` self-repair feedback to the caller.
- `default_on_timeout: allow` forwards the original `tools/call` upstream after the timeout elapses.
- In both modes, the approval ticket status remains `timeout` (for audit/SSE consistency).
- Exception: [budget break-glass tickets](#budget-break-glass-tickets) always fail closed on timeout — `default_on_timeout: allow` never applies to money gates.

You can override the timeout per rule:

```yaml
- name: approve-payments
  match:
    tool: 'create_payment'
  action: require_approval
  approval:
    channel: slack
    timeout: '600s' # 10 minutes for payment approvals
```

When `default_on_timeout: deny`, the agent receives self-repair feedback:

```json
{
  "error": {
    "data": {
      "reason": "approval_timeout",
      "timeout_seconds": 300,
      "suggestion": "Approval request timed out after 300s. Try again or contact an approver directly.",
      "retry_allowed": true
    }
  }
}
```

The `data` object also carries `blocked`, `rule`, `rule_index`, and `action`; the fields above are the ones agents typically act on.

If the downstream client disconnects while a request is pending approval, Helio resolves the ticket as `client_disconnected` and does not forward the request upstream.

If the proxy receives SIGTERM while requests are still waiting for approval, Helio resolves those held requests as `shutdown_cancelled` with a deterministic blocked response:

```json
{
  "error": {
    "data": {
      "reason": "shutdown_cancelled",
      "suggestion": "The proxy was shut down while this request was awaiting approval (for example during deploy/restart). Retry once the proxy is healthy.",
      "retry_allowed": true
    }
  }
}
```

As with the timeout example, the `data` object also carries `blocked`, `rule`, `rule_index`, and `action`.

This shutdown path is intentionally fail-closed and does not use `default_on_timeout`.

## Escalation

If an approval hasn't been resolved within a specified time, Helio can escalate by re-notifying the channel or notifying additional channels:

```yaml
- name: approve-high-value
  match:
    tool: 'create_payment'
    input:
      '$.amount':
        gt: 1000
  action: require_approval
  approval:
    channel: slack
    timeout: '600s'
    escalation_after: '300s' # Escalate after 5 minutes
    delegates: ['webhook'] # Notify webhook channel on escalation
```

- `escalation_after` must be shorter than `timeout` to fire before the ticket times out.
- `delegates` is an array of channel names to notify on escalation. If omitted, the primary channel is re-notified.
- Delegate values must reference configured approval channel `name`s (or channel `type`s such as `webhook` / `slack` / `dashboard`). Unknown delegate references are startup-fatal validation errors.
- Escalation updates the ticket with `escalated_at` and `escalated_to` fields, visible in the dashboard and on `GET /api/approvals/:id` while the ticket is retained. Both fields are also recorded durably on the call's audit record under `evidence_chain.approval`.

Timeouts also emit the same `approval_resolved` dashboard SSE event path used by manual approve/deny/break-glass resolution, so operator dashboards stay state-consistent across all resolution outcomes.

## Break-Glass Override

For emergency situations, a break-glass override force-approves a ticket regardless of normal approval flow. This is designed for urgent production incidents where waiting for standard approval isn't feasible.

```bash
curl -s -X POST http://localhost:3100/api/approvals/<ticket-id>/break-glass \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <api_secret>' \
  -d '{"approved_by": "admin", "reason": "Emergency: production incident P1-2345"}' | jq
```

Break-glass overrides:

- Require a **reason** (mandatory, cannot be empty).
- Are prominently **flagged in the audit trail** with the reason.
- Are available via the REST API and the dashboard.

### Why Break-Glass Is Dashboard-Only

Break-glass is intentionally not exposed as a button on chat-channel approval messages (Slack, etc.). The omission is a deliberate trade-off, not an oversight:

- **Authentication boundary.** Dashboard break-glass requires the `dashboard.api_secret` bearer credential, which is held by operators. Chat-channel membership is granted casually (observers, contractors, on-call rotations), and Slack's HMAC signature only proves a callback came from Slack — not that the clicker is authorized to bypass approval flow. Putting break-glass behind an explicit operator credential keeps the privilege boundary aligned with credential issuance, not channel membership.
- **Friction-by-design for privileged actions.** Approve and Deny are many-eyes review actions where chat is the right surface. Break-glass _force-approves_ — bypassing the entire flow — and is meant to be a deliberate, visible act. Login → navigate → confirm modal → type reason is friction by design, not a UX flaw.
- **Reason quality.** Break-glass requires a substantive reason, which is the audit record's most valuable field. Forcing the reason through a dashboard form (rather than a chat-side modal under incident pressure) tends to produce more useful audit text.

This is a defensible default for early deployments, but it does have real cost during 24/7 incident workflows where the on-call engineer is in chat (often on mobile) rather than at a dashboard. A future Slack break-glass surface would need: an operator-allowlist of Slack user IDs, a forced reason modal, and a confirmation step before submission. None of that exists today; track this as a known trade-off, not a missing feature.

## Budget Break-Glass Tickets

A [budget](./policies.md#cross-tool-spend-budgets) with `on_exceed: require_approval` turns a breach into an approval instead of a denial. (This is a different mechanism from the break-glass _override_ above, which force-approves an existing ticket; a budget break-glass ticket is an ordinary ticket that happens to gate money.)

One call raises **one composite ticket** no matter how many budgets it breached. The ticket carries a `breached_budgets` array — one entry per breached budget with `name`, `limit`, `spent`, `attempted_amount`, `currency`, and `window` — which every surface shows: the dashboard and webhook payloads serialize it verbatim, and Slack messages render a "Breached budgets" section. Approving the ticket approves every listed overage at once; there is never a per-budget decision.

Ticket routing is deterministic:

- A **budget-only ticket** (the matched rule allowed the call; only the money gate objected) takes the breached budget's `approval` config. When several breached budgets carry different configs, the **first breached budget in config order** wins: one ticket means one channel. A budget without an `approval` block falls back to the dashboard channel and the global `approval.timeout`. The matched rule's `approval` config never applies to a budget ticket. Scope per door: on the MCP door the full config applies (channel, timeout, delegates, escalation); on the sideband the ticket is native (`channel_name: native:<origin>`, resolved by the adapter's own UI, never notified through Helio channels), so only the selected config's **timeout** takes effect there.
- On the **MCP door**, a rule-level approval plus a budget breach are **two sequential human decisions**: the rule ticket resolves first (per the execution order), and only then does the budget gate raise its own ticket. Both are attributed on the one audit record — the `approval_status`/`approved_by` columns keep their rule-gate meaning, and the budget decision is recorded unconditionally under `evidence_chain.budget_approval` (`ticket_id`, `status`, `resolved_by`, plus `denial_reason`/escalation fields when present). On a budget-only ticket the columns carry the budget decision itself.
- On the **sideband**, the two gates merge into the call's single native ticket — see [the adapter API](./adapter-api.md#approvals) for that contract; the merged ticket takes the RULE's approval timeout.

Semantics that deviate from rule approvals, by design:

- **Timeout always fails closed.** `approval.default_on_timeout: allow` never applies to a ticket carrying `breached_budgets` — a timeout-allow would forward an unapproved overage. Money gates do not fail open.
- **Scope-once.** Approval covers exactly this call's overage. No standing grant exists (`scope: "always"` on a sideband resolve is inert for budget-context tickets — the next identical call breaches again). This pins the issue #127 interaction.
- **Deny wins.** If one call simultaneously breaches an `on_exceed: deny` budget and a `require_approval` budget, the call is denied outright and no ticket is raised.

On approval, the overage is recorded on every breached budget as `kind: approved_overage` (ledger row and the audit record's `evidence_chain.budgets[].kind`) — unbreached budgets the same call matched record plain `spend` in the same atomic batch — and only then does the call forward. The approval is authoritative: nothing is re-checked after the human decides, so a rule-level rate/spend counter peeked before the wait also records unconditionally on approval — it can go past its limit for that one approved call (the counter stays truthful, and the next unapproved call is blocked by the exhausted counter). A denial, timeout, disconnect, or shutdown records nothing on any budget or rule counter — on the MCP door unconditionally, and on the sideband whenever the adapter honors the decision (`not_executed`); a sideband host that executes anyway commits the spend as plain `spend` with the denied/timeout status on the record (the documented TOCTOU caveat). The blocked response reuses the budget feedback shape: `reason: budget_exceeded` with a `budgets` array listing every breach, plus `denied_by`/`denial_reason` or `timeout_seconds`.

## REST API Reference

The approval REST API is served exclusively on the dashboard sideband
port (default `127.0.0.1:3100`). It is **not** mounted on the main MCP
port — that separation is what prevents an agent speaking `/mcp` from
self-approving its own pending tickets.

| Method | Endpoint                         | Description                          |
| ------ | -------------------------------- | ------------------------------------ |
| GET    | `/api/approvals`                 | List tickets. Paginated — see below. |
| GET    | `/api/approvals/:id`             | Get a single ticket.                 |
| POST   | `/api/approvals/:id/approve`     | Approve a ticket.                    |
| POST   | `/api/approvals/:id/deny`        | Deny a ticket.                       |
| POST   | `/api/approvals/:id/break-glass` | Force-approve with audit flag.       |

### GET /api/approvals

Query parameters (all optional):

- `status` — filter by `pending` / `approved` / `denied` / `timeout` / `break_glass` / `client_disconnected` / `shutdown_cancelled` / `cancelled`.
- `limit` — page size. Defaults to `50`. Clamped to `[1, 1000]`.
- `offset` — number of tickets to skip. Defaults to `0`.

Invalid `status` values are treated as unset (no status filter), not as a `400`.

Tickets are returned newest-first by `requested_at`, so `offset=0` always points at the most recent page regardless of queue depth. The response envelope is:

```json
{
  "data": [
    /* ApprovalTicket[] */
  ],
  "total": 42,
  "limit": 50,
  "offset": 0
}
```

`total` reflects the full count after the `status` filter is applied, before pagination — use it to drive "showing N of M" affordances in operator tooling. The `data` key is the canonical list envelope shared by every paginated sideband endpoint; see [Sideband API reference](./sideband-api.md) for the full convention.

### POST /api/approvals/:id/approve

```json
{ "approved_by": "alice" }
```

### POST /api/approvals/:id/deny

```json
{ "denied_by": "bob", "reason": "Suspicious activity" }
```

The `reason` field is optional.

### POST /api/approvals/:id/break-glass

```json
{ "approved_by": "admin", "reason": "Emergency override needed" }
```

Both `approved_by` and `reason` are required.

**Error responses:**

- `400` — Invalid JSON body or failed validation (for example a missing `approved_by`).
- `404` — Ticket not found.
- `409` — Ticket already resolved (returns current status).
- `409` — Adapter-owned ticket: `{ "error": "native_ticket", "resolve_in": "<origin>" }`.

Tickets created by a host adapter through the [sideband](./sideband-api.md) governance flow appear in the same listings with a `native:<origin>` channel name. The `/api/approvals/*` endpoints cannot resolve them — the decision belongs to the adapter's own approval UI, which reports it back through the sideband — so `approve` / `deny` / `break-glass` return the `native_ticket` error above, and a dismissed adapter dialog resolves the ticket as `cancelled`.

Unknown paths under `/api/*` (e.g. a typo in the endpoint name) return a JSON `404` with an `error` field — never HTML. A typo on the sideband always surfaces as a parseable error payload rather than an HTML blob that could trick a client into thinking the endpoint silently succeeded.

### Authentication

Helio requires an `api_secret` whenever any rule uses `require_approval`, or
`policies.flag_destructive: require_approval` or
`policies.on_tool_drift: require_approval` is set. The proxy refuses to start
(or hot-reload) if the secret is missing.

Generate a secret with:

```
openssl rand -hex 32
```

Then set it under `dashboard.api_secret` in your `helio.yaml`. The secret
supports two authenticated access modes on protected `/api/*` endpoints
(everything except `/api/health`, `/api/auth/session`, and `/api/auth/logout`):

- browser operator flow: unlock dashboard via `POST /api/auth/session`, then use HttpOnly session cookie auth
- machine/client flow: send `Authorization: Bearer <secret>`

Both modes cover approval mutations (`approve`, `deny`, `break-glass`) and
operator reads (list tickets, get ticket, audit feed, evidence state, limits, analytics).
Bearer example:

```
Authorization: Bearer <api_secret>
```

`helio init` generates a secret automatically on the first run and writes it
into the scaffolded `helio.yaml` (the value is also echoed to stderr so you
have a working credential immediately).

## See Also

- [Sideband API Reference](./sideband-api.md) — Complete reference for every `/api/*` endpoint exposed on the dashboard sideband, including the approval subset documented above
- [Slack Approvals Example](../examples/slack-approvals/) — Runnable example with Slack integration
- [Policy Guide](./policies.md) — `require_approval` action and rule configuration
- [Audit Trail](./audit.md) — How approval decisions are recorded
- [Configuration Reference](./configuration.md#approval) — Approval config fields and defaults
