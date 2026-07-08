# Audit Trail

Every `tools/call` request that passes through Helio is recorded in an audit trail — including the tool name, arguments, policy decision, approval outcome, upstream response, and timing. A `tools/call` that carries no usable tool name (missing, non-string, or empty `params.name`) is rejected at the proxy with a JSON-RPC invalid-params error and recorded as a `rejected` decision under the `<nameless>` sentinel, rather than forwarded — see [Nameless Call Rejections](#nameless-call-rejections). Audit records are written asynchronously so they never slow down the request path.

## What's Recorded

Each audit record contains the following fields:

| Field                  | Type           | Description                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                   | string         | Unique record identifier (UUID v4).                                                                                                                                                                                                                                                                                                                                        |
| `timestamp`            | string         | ISO 8601 timestamp of when the proxy received the tool call.                                                                                                                                                                                                                                                                                                               |
| `session_id`           | string \| null | MCP session ID from the `Mcp-Session-Id` header, or the adapter-supplied session identifier on sideband records.                                                                                                                                                                                                                                                           |
| `agent_id`             | string \| null | Agent identifier, if available.                                                                                                                                                                                                                                                                                                                                            |
| `environment`          | string \| null | Runtime environment label configured at proxy startup.                                                                                                                                                                                                                                                                                                                     |
| `tool_name`            | string         | The name of the tool that was called.                                                                                                                                                                                                                                                                                                                                      |
| `tool_input`           | object         | The full arguments passed to the tool call.                                                                                                                                                                                                                                                                                                                                |
| `policy_decision`      | string         | The policy engine's decision: `allow`, `deny`, `require_approval`, `rate_limit`, `spend_limit`, or `dry_run`. A nameless `tools/call` is recorded as `rejected` (see [Nameless Call Rejections](#nameless-call-rejections)). Drift records store `tool_drift` or `tool_drift_reverted` here instead (see [Tool Definition Drift Records](#tool-definition-drift-records)). |
| `block_reason`         | string \| null | Structured deny/block reason — see [Block Reasons](#block-reasons) for the full vocabulary. Null when not blocked.                                                                                                                                                                                                                                                         |
| `matched_rule`         | string \| null | Name of the policy rule that matched, or null if the default action applied.                                                                                                                                                                                                                                                                                               |
| `matched_rule_index`   | number \| null | Rule index in config order that matched, or null when no rule matched.                                                                                                                                                                                                                                                                                                     |
| `evidence_chain`       | object \| null | Evidence and dependency state from the evidence grounding system, plus decision-context sub-objects when present (`approval`, `break_glass`, `rate_limit`, `spend_limit`, `tool_drift`, `sideband`).                                                                                                                                                                       |
| `approval_status`      | string \| null | Approval outcome: `approved`, `denied`, `timeout`, `break_glass`, `client_disconnected`, or `shutdown_cancelled`; tickets resolved through the sideband can also record `cancelled`. Null if no approval was required.                                                                                                                                                     |
| `approved_by`          | string \| null | Identity of the human who resolved approval (`approved`, `denied`, or `break_glass`), when applicable.                                                                                                                                                                                                                                                                     |
| `upstream_response`    | any \| null    | The upstream MCP server's response. Null for denied calls (no upstream request was made).                                                                                                                                                                                                                                                                                  |
| `upstream_error`       | string \| null | Error message from the upstream server, if the call failed.                                                                                                                                                                                                                                                                                                                |
| `upstream_http_status` | number \| null | Upstream HTTP status code when an upstream response was received. Null on denied or connection-level forwarding failures.                                                                                                                                                                                                                                                  |
| `upstream_latency_ms`  | number \| null | Time in milliseconds the upstream request took. Null for denied calls.                                                                                                                                                                                                                                                                                                     |
| `total_duration_ms`    | number         | End-to-end duration from request receipt to final response.                                                                                                                                                                                                                                                                                                                |
| `approval_wait_ms`     | number         | Time spent waiting in the approval queue/timer. Zero when no approval hold occurred.                                                                                                                                                                                                                                                                                       |
| `proxy_compute_ms`     | number         | Proxy compute time excluding approval wait and upstream processing.                                                                                                                                                                                                                                                                                                        |
| `flagged_destructive`  | boolean        | Whether the tool was flagged as potentially destructive (`destructiveHint: true`).                                                                                                                                                                                                                                                                                         |
| `dry_run`              | boolean        | Whether this record was produced in dry-run mode.                                                                                                                                                                                                                                                                                                                          |
| `record_kind`          | string         | Record category: `tool_call` (default), `drift_event`, `install_scan`, or `evaluation_expired` (see [Expired Sideband Evaluations](#expired-sideband-evaluations)).                                                                                                                                                                                                        |
| `origin`               | string         | Enforcement origin: `mcp` for the proxy path, or an adapter origin string (e.g. `openclaw`) for [sideband-governed](./adapter-api.md) calls.                                                                                                                                                                                                                               |
| `metadata`             | object \| null | Adapter-supplied context (reserved keys `channel_id`, `sender_id`, `sender_name`, `conversation_id`). Null for MCP-origin records.                                                                                                                                                                                                                                         |
| `created_at`           | string         | ISO 8601 timestamp of when the record was persisted to the database.                                                                                                                                                                                                                                                                                                       |

### Block Reasons

`block_reason` is the column to alert on: it is non-null exactly when Helio blocked the call. The vocabulary:

| Reason                  | Set when                                                                                                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `policy_denied`         | A `deny` rule (or the default deny) matched, or a session-required evidence gate had no session.                                                                       |
| `evidence_missing`      | A required evidence key was never stored for the session.                                                                                                              |
| `evidence_expired`      | A required evidence key was stored but its TTL lapsed.                                                                                                                 |
| `dependency_missing`    | A `requires` / `requires_success` dependency was not satisfied.                                                                                                        |
| `approval_denied`       | An approver denied the call.                                                                                                                                           |
| `approval_timeout`      | The approval window elapsed (with `default_on_timeout: deny`).                                                                                                         |
| `client_disconnected`   | The MCP client disconnected before request completion (while awaiting approval, or after approval resolved but before completion).                                     |
| `shutdown_cancelled`    | Proxy shutdown cancelled a pending approval.                                                                                                                           |
| `cancelled`             | A sideband-resolved ticket was cancelled by the adapter.                                                                                                               |
| `rate_limited`          | A `rate_limit` rule's window was exhausted.                                                                                                                            |
| `spend_limited`         | A `spend_limit` rule's window budget was exhausted (or the amount was invalid).                                                                                        |
| `tool_definition_drift` | The call hit a drifted tool under `on_tool_drift: block`.                                                                                                              |
| `install_denied`        | An install scan matched a `deny_install` rule.                                                                                                                         |
| `missing_tool_name`     | A `tools/call` carried no usable tool name (missing, non-string, or empty `params.name`) and was rejected (see [Nameless Call Rejections](#nameless-call-rejections)). |

`evaluation_expired` records keep `block_reason` null: an expired evaluation is a reporting failure, not an enforcement block. One caveat for library embedders: when Helio's forwarder is embedded without an approval router or rate/spend limiter, a rule requiring the missing handler blocks with the free-text policy reason instead of a fixed value. This cannot happen under `helio start`, which always wires all three.

### Approval Context

When a `require_approval` decision resolves with context worth keeping — a denial reason or an escalation — the record's `evidence_chain.approval` carries it:

- `ticket_id` — the approval ticket this record corresponds to.
- `denial_reason` — present when the denier supplied a reason (Slack denials never carry one).
- `escalated_at` / `escalated_to` — present when the escalation timer fired before resolution.

The `approval` block is omitted when neither applies, so a plain approved call records no approval context at all — its `evidence_chain` stays null unless other context (evidence grounding, rate or spend limit state) populates it. Break-glass reasons are recorded separately under `evidence_chain.break_glass` (`reason`, `invoked_by`).

### Expired Sideband Evaluations

When a [sideband-governed](./adapter-api.md) call is decided via `/evaluate` but the adapter's `/audit` report never arrives within `sdk.evaluation_ttl` (default 10 minutes), Helio finalizes the evaluation as a `record_kind: evaluation_expired` record. This is a bypass/tamper signal — the adapter was told the decision but never reported the outcome — not an enforcement block, so `block_reason` stays null and the record does not count toward blocked totals. The record carries `evidence_chain.sideband.unreported: true` and is placed on the priority flush queue. Treat a nonzero count of these as an adapter reliability problem or something worse; the Expired chip in the dashboard surfaces them.

## Tool Definition Drift Records

In addition to tool-call records, Helio writes immediate audit records when a tool's definition changes after its baseline was captured at startup. These records describe changes to the upstream definition, not tool calls.

**`policy_decision: tool_drift`** — A tool's definition changed after baseline. `evidence_chain.tool_drift.changes` is an array of per-aspect before/after diffs: each entry has `aspect` (e.g. `annotations`, `inputSchema`, `description`), `baseline`, and `current`. Because no tool call occurred, `tool_input` is empty and all upstream fields (`upstream_response`, `upstream_error`, `upstream_http_status`, `upstream_latency_ms`) are null.

**`policy_decision: tool_drift_reverted`** — A previously drifted tool's definition returned to its baseline. `evidence_chain` is null; `tool_input` is empty and upstream fields are null.

Both record types are written via `pushImmediate` so they appear in the audit trail before any subsequent tool call that may be gated on the drift state.

Drift events are excluded from the dashboard's allowed-call totals and top-tools rankings; they remain visible in the feed, overall totals, and the by-decision breakdown. Nameless-call rejections (`policy_decision: rejected`, below) are excluded from top-tools rankings for the same reason — they carry the `<nameless>` sentinel and name no real tool — while still counting toward blocked totals and the by-decision breakdown.

> **Note:** Baselines are per-process. Restarting Helio re-baselines all tool definitions. Review any outstanding `tool_drift` records before restarting to ensure you understand what changed.

## Nameless Call Rejections

A `tools/call` must carry a string `params.name`. When it does not — the field is missing, non-string, or an empty string — Helio rejects the request at the proxy with a JSON-RPC invalid-params error (code `-32602`) instead of forwarding it, and writes an immediate audit record so the trail stays complete. This closes a bypass: a lenient or colluding upstream could otherwise act on a nameless call (keying behavior off `params.arguments` or a custom field) with no rule able to match and no record written.

**`policy_decision: rejected`** — The record uses `block_reason: missing_tool_name` and the reserved `tool_name: <nameless>` sentinel, so it is distinguishable from a rule-matched `deny`. The raw `params` are preserved losslessly under `tool_input.raw_params` — whatever their JSON type (object, array, scalar, or null) — so you can see exactly what a lenient upstream could have keyed off, with no ambiguity between a wrapped scalar and an object that happens to contain a `raw_params` key. `matched_rule` is null and all upstream fields are null — nothing was forwarded. The record is written via `pushImmediate` (enforcement priority) and counts toward blocked totals. In the dashboard it renders as its own **Rejected** outcome, separate from **Deny**, and is filterable by that outcome or by the `missing_tool_name` reason.

> Note: on the notification path (a `tools/call` with no JSON-RPC `id`), the rejection response is not delivered — notifications receive no response per JSON-RPC — but the audit record is still written.

## Storage Backend

Audit records are stored in a local SQLite database using WAL (Write-Ahead Logging) mode for optimal concurrent read/write performance.

**Database configuration:**

```yaml
audit:
  storage: sqlite
  path: ./helio-audit.db # Default path
  retention: 90d # Auto-delete after 90 days
  include_responses: true # Store full upstream responses
```

**Indexes** are created on `created_at`, `tool_name`, `policy_decision`, `block_reason`, `session_id`, `record_kind`, and `origin` for fast queries, plus a composite `(upstream_http_status, created_at)` index for upstream status rollups and status-over-time alert queries.

### Local Schema Resets (Pre-1.0)

Helio currently uses a clean-break local schema policy for the audit SQLite file. If startup reports an audit schema mismatch (for example after pulling a new build that introduces a required column), reset local audit files and restart:

```bash
rm helio-audit.db helio-audit.db-wal helio-audit.db-shm
```

If your `audit.path` points elsewhere, delete that path and its `-wal` / `-shm` sidecars instead.

## Response Recording

The `include_responses` setting controls how much of the upstream response is stored:

- **`true` (default)** — The full JSON-RPC response body is stored. This gives you complete visibility into what the upstream server returned.
- **`false`** — Only a summary is stored (success/error status and content types). Use this for privacy-sensitive deployments or to reduce database size.

Denied calls always have a null `upstream_response` since no upstream request was made.

## Dashboard

The dashboard provides two views for audit data:

- **Feed tab** — A real-time stream of tool calls as they happen, powered by Server-Sent Events. Each action card shows the tool name, policy decision, timing, and matched rule. An **Origin** badge (MCP or the adapter slug) identifies where the call originated. For non-`tool_call` records, a **record-kind chip** (Install Scan, Drift, or Expired) appears alongside the badge. Adapter-origin cards also surface context such as `channel_id` and `sender_id` from the record's metadata.
- **Audit tab** — A searchable, filterable, paginated log of all recorded actions. An **Origin** column shows the enforcement origin (MCP or adapter) with a record-kind chip for non-`tool_call` entries. **Channel ID** and **Sender ID** columns show adapter metadata and are visible at wider viewports. Click any record to see full details including tool arguments, upstream response, and evidence chain.

![Dashboard Audit](./images/dashboard-audit.png)

**Available filters in the Audit tab:**

- Tool name (substring match)
- Outcome (Allow, Deny, Rejected, Approval Denied, Approval Timeout, Client Disconnected, Shutdown Cancelled, Rate Limited, Spend Limited, Dry Run)
- Block reason (`policy_denied`, `evidence_missing`, etc. — see [Block Reasons](#block-reasons))
- Origin (`mcp`, `openclaw`, or any adapter slug)
- Record kind (`tool_call`, `install_scan`, `drift_event`, `evaluation_expired`)
- Time range (presets or a custom from/to)
- Session ID
- Channel ID (`metadata.channel_id`)
- Sender ID (`metadata.sender_id`)
- Upstream HTTP status range (min/max)

The outcome pills filter by what actually happened to the call, not the raw `policy_decision` value — an approved `require_approval` call shows under Allow. Filtering by agent ID or the destructive flag is not exposed in the UI; both are available as `/api/audit` query parameters (`agent`, `destructive`).

## CLI Export

Export audit records from the command line using `helio export`:

```bash
helio export
```

**Options:**

| Flag                    | Type   | Default      | Description                                            |
| ----------------------- | ------ | ------------ | ------------------------------------------------------ |
| `-c, --config <path>`   | string | `helio.yaml` | Path to the config file (used to locate the database). |
| `-f, --format <format>` | string | `json`       | Output format: `json` or `csv`.                        |
| `--tool <name>`         | string | —            | Filter by tool name.                                   |
| `--decision <decision>` | string | —            | Filter by policy decision.                             |
| `--reason <reason>`     | string | —            | Filter by block reason.                                |
| `--session <id>`        | string | —            | Filter by session ID.                                  |
| `--from <iso>`          | string | —            | Start time (ISO 8601).                                 |
| `--to <iso>`            | string | —            | End time (ISO 8601).                                   |
| `--limit <n>`           | number | `1000`       | Maximum number of records to export (up to 10,000).    |

**Examples:**

```bash
# Export all records as JSON
helio export

# Export denied actions as CSV
helio export -f csv --decision deny

# Export the last hour for a specific tool
helio export --tool create_payment --from "2026-04-09T11:00:00Z" --to "2026-04-09T12:00:00Z"

# Export to a file
helio export -f csv > audit-report.csv
```

Audit data is written to stdout; status messages go to stderr. This means you can pipe or redirect the output without capturing log messages.

## Dashboard API Export

The dashboard API provides a bulk export endpoint:

```
GET /api/audit/export
```

**Query parameters:**

| Parameter             | Default | Description                                        |
| --------------------- | ------- | -------------------------------------------------- |
| `format`              | `json`  | Output format: `json` or `csv`.                    |
| `limit`               | `10000` | Maximum records (up to 10,000).                    |
| `tool`                | —       | Filter by tool name.                               |
| `decision`            | —       | Filter by policy decision.                         |
| `reason`              | —       | Filter by block reason.                            |
| `session`             | —       | Filter by session ID.                              |
| `agent`               | —       | Filter by agent ID.                                |
| `from`                | —       | Start time (ISO 8601).                             |
| `to`                  | —       | End time (ISO 8601).                               |
| `upstream_status_min` | —       | Minimum upstream HTTP status (inclusive).          |
| `upstream_status_max` | —       | Maximum upstream HTTP status (inclusive).          |
| `blocked`             | —       | Filter by blocked vs. allowed (`true`/`false`).    |
| `dry_run`             | —       | Filter by dry-run mode (`true`/`false`).           |
| `origin`              | —       | Filter by enforcement origin (substring match).    |
| `record_kind`         | —       | Filter by record kind (exact match).               |
| `channel_id`          | —       | Filter by `metadata.channel_id` (substring match). |
| `sender_id`           | —       | Filter by `metadata.sender_id` (substring match).  |

**Examples:**

```bash
# Export as JSON via the dashboard API
curl -s -H "Authorization: Bearer $HELIO_DASHBOARD_SECRET" \
  http://localhost:3100/api/audit/export > audit.json

# Export as CSV with filters
curl -s -H "Authorization: Bearer $HELIO_DASHBOARD_SECRET" \
  "http://localhost:3100/api/audit/export?format=csv&decision=deny&limit=500" > denied.csv
```

With `dashboard.api_secret` enabled, browser dashboard sessions authenticate via
`POST /api/auth/session` + HttpOnly cookie. Non-browser clients may continue to
use `Authorization: Bearer <api_secret>` for protected `/api/*` calls (everything
except `/api/health`, `/api/auth/session`, and `/api/auth/logout`).
The export response includes a `Content-Disposition` header for browser downloads.

## CSV Format

CSV exports include all 27 of the record's fields:

`id`, `timestamp`, `session_id`, `agent_id`, `tool_name`, `tool_input`, `policy_decision`, `block_reason`, `matched_rule`, `evidence_chain`, `approval_status`, `approved_by`, `upstream_response`, `upstream_error`, `upstream_http_status`, `upstream_latency_ms`, `total_duration_ms`, `approval_wait_ms`, `proxy_compute_ms`, `flagged_destructive`, `dry_run`, `created_at`, `environment`, `matched_rule_index`, `record_kind`, `origin`, `metadata`

Dashboard API CSV exports (`GET /api/audit/export?format=csv`) serialize object fields (`tool_input`, `evidence_chain`, `upstream_response`, `metadata`) as JSON strings. Fields containing commas, newlines, or quotes are properly escaped per RFC 4180. Boolean values are exported as `true` or `false`. Null values are exported as empty strings.

`helio export -f csv` currently uses a lightweight serializer: it prints the same CSV headers and scalar fields, including `record_kind` and `origin`, but leaves the object-valued fields (`tool_input`, `evidence_chain`, `upstream_response`, `metadata`) empty. Use the dashboard API export if you need `metadata` in CSV.

**Formula injection defense.** Any cell that would otherwise begin with `=`, `+`, `-`, `@`, a tab, or a carriage return is prefixed with a single quote (`'`) before being quoted. This prevents CSV-opened spreadsheet applications from interpreting audit data as a formula (CWE-1236).

## Retention

Audit records are automatically cleaned up based on the `audit.retention` setting:

```yaml
audit:
  retention: 90d # Default: 90 days
```

- Records older than the retention period are permanently deleted.
- Cleanup runs automatically every 24 hours and at proxy startup.
- Set a larger value (e.g. `365d`) if you need longer retention.

> **Note:** Retention cleanup is irreversible. If you need permanent audit records, export them before they expire or set retention to a very large value.

## Performance

The audit system is designed to add zero latency to the request path:

- **Async buffered writes** — Records are pushed to an in-memory buffer immediately (non-blocking). The buffer is flushed to SQLite in batches. Enforcement records (deny/approval/rate/spend blocks) are scheduled for a prioritized next-tick flush, while process crash handlers still synchronously drain buffered records before exit. Dashboard `action` SSE events are emitted on successful persistence, so live views do not race ahead of durable storage.
- **Flush triggers** — a flush is scheduled once 50 records are buffered, or every 100ms, whichever comes first; each flush writes everything buffered in one batch.
- **Single-transaction batches** — Each flush uses a single SQLite transaction, so WAL mode syncs once per batch rather than once per record.
- **Throughput and overhead** — Validate on your hardware with the benchmark script: `pnpm --filter @gethelio/proxy benchmark`. The script generates a local report at `docs/benchmark-results.md` with environment-specific numbers.
- **Read-after-write window** — Because writes are batched, a query against `/api/audit?limit=1` fired immediately after a request can briefly see the previous "latest" row instead of the just-completed one. Allow records take up to 100ms to materialize; enforcement records (denies, approvals, rate/spend blocks) take roughly one event-loop tick. Live debugging tools should pause ~200ms between a request and an audit query that expects to see it, or use the SSE `action` feed (which is emitted on persistence, not on push).

For detailed numbers, run the benchmark script and inspect the generated local report at `docs/benchmark-results.md`.

## See Also

- [Sideband API Reference](./sideband-api.md) — Complete reference for every `/api/*` endpoint, including `/api/feed`, `/api/audit`, `/api/audit/:id`, and `/api/audit/export`
- [Configuration Reference](./configuration.md#audit) — Audit config fields and defaults
- [Policy Guide](./policies.md) — What generates audit records
- [Approval Workflows](./approvals.md) — How approval decisions appear in the audit trail
- `pnpm --filter @gethelio/proxy benchmark` — Generates local performance report at `docs/benchmark-results.md`
