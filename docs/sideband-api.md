# Sideband API Reference

The dashboard sideband is a read/write REST + SSE surface served on a separate port from the MCP proxy itself (default `127.0.0.1:3100`). It is the canonical way for operators, custom dashboards, and monitoring tooling to inspect the proxy's in-memory and on-disk state.

> **Why a separate port?** The sideband is deliberately isolated from the `/mcp` port. This is what prevents an agent speaking `/mcp` from self-approving its own pending tickets — the approval REST API is mounted exclusively on this sideband, not on the MCP port.

> **Not the same as the SDK sideband.** This document covers the **dashboard sideband** (`:3100`), the operator read/write surface. There is a second, separate **SDK sideband** (`:3200`, `sdk.*`) that serves the Python SDK's evidence routes and the [adapter governance API](./adapter-api.md) (`/evaluate`, `/audit`, `/install-scan`, `/approval/:id/resolve`) for hook-based adapters like OpenClaw. Different server, different port, different token.

## Overview

- **Default port:** `127.0.0.1:3100` (configurable via `dashboard.port`).
- **Bind address:** localhost-only by default. Bind publicly only behind a TLS-terminating reverse proxy you control.
- **Auth:** By default, `dashboard.enabled: true` requires `dashboard.api_secret`. Browser clients unlock with `POST /api/auth/session` + HttpOnly cookie; non-browser clients can use `Authorization: Bearer <api_secret>`. Running without `api_secret` is only allowed with explicit `dashboard.allow_open_mode: true` on loopback hosts. See [Authentication](#authentication) below.
- **CORS:** Allows same-origin, `localhost` / `127.0.0.1` / `0.0.0.0`, and private network ranges (`10.x`, `172.16-31.x`, `192.168.x`) for Docker bridge and LAN access. All other origins are rejected.
- **Content type:** JSON for everything except `/api/audit/export` (JSON or CSV attachment) and `/api/events` (SSE stream).
- **Non-200 errors:** Always JSON in the shape `{ "error": "<message>" }`. Unknown `/api/*` paths return `404` with this shape (never HTML).

## Response shape conventions

The sideband uses three principled response shapes, chosen by endpoint category. Knowing which category an endpoint belongs to tells you exactly how to parse its response.

### 1. Resource singletons → `{ "data": <Resource> }`

Endpoints that return one resource by ID always wrap the resource in a `data` key, so clients can destructure `const { data } = await res.json()` without branching on field name.

Endpoints in this category: `GET /api/audit/:id`, `GET /api/approvals/:id`, `GET /api/evidence/:session_id`.

### 2. Paginated lists → `{ "data": [...], "total": N, "limit": N, "offset": N }`

Endpoints that return a filtered collection wrap the array in `data` and flatten pagination metadata at the top level.

- `data` — the current page of results.
- `total` — the full count **after filters are applied** but **before pagination**. Use it to drive "showing N of M" affordances.
- `limit` — the page size the server actually applied. May differ from what the client requested if clamping kicked in (all paginated endpoints clamp to endpoint-specific ranges).
- `offset` — the offset the server actually applied.

For pagination and boolean query fields, the sideband uses tolerant parsing at the boundary: empty or non-numeric `limit` / `offset` values fall back to endpoint defaults, and invalid boolean filter strings are treated as unset rather than causing a 400.

Endpoints in this category: `GET /api/feed`, `GET /api/audit`, `GET /api/approvals`.

Clients that need a page number compute it as `Math.floor(offset / limit) + 1`.

### 3. RPC / aggregate endpoints → raw object, unwrapped

Endpoints that return a computed view of in-memory state are not "resources" in the REST sense, and wrapping them in `{ data }` adds ceremony without signal. They return their computed view directly, with shapes specific to each endpoint.

Endpoints in this category: `GET /api/health`, `GET /api/analytics`, `GET /api/limits`.

Envelope category does not imply authentication policy: when dashboard auth is enabled, `GET /api/analytics` and `GET /api/limits` still require auth. `GET /api/health` remains the only intentionally unauthenticated probe endpoint.

`GET /api/health` in particular is preserved in this form so that container orchestrators (Kubernetes, Docker Compose, Nomad) can point healthcheck probes at it without a custom JSON parser: probes only evaluate the HTTP status code, and the flat `status`, `version`, and `uptime` keys stay easy to read for the humans and scripts that hit the same URL.

The auth endpoints (`/api/auth/*`) and the approval action POSTs sit outside these three categories: they return small purpose-built objects (`{ "ok": true }`, the session state) documented inline in their endpoint sections.

### Non-JSON responses

Two endpoints fall outside the envelope model entirely:

- `GET /api/audit/export` — binary download with `Content-Disposition: attachment` and a `text/csv` or `application/json` body. The body is a bare `AuditRecord[]` array (no envelope) or a CSV document, intended for `curl -o audit.json` and spreadsheet pipelines.
- `GET /api/events` — Server-Sent Events stream. Each frame is an `event: <name>\ndata: <json>\n\n` block. Not a single response body.

### Error shape

Every 4xx and 5xx response across every endpoint (with the two non-JSON exceptions above) returns:

```json
{ "error": "Human-readable error message" }
```

Some validation errors on POST endpoints additionally include a `details` array; see the individual endpoint sections for specifics.

### Field casing

Every type that crosses a JSON boundary — REST response bodies, webhook payloads, SSE event payloads, audit records — uses **snake_case** field names throughout, including inside its TypeScript `interface` definition. There is no camelCase/snake_case mapping layer: `JSON.stringify(obj)` on an internal DTO produces the wire exactly. POST request bodies follow the same convention (`approved_by`, `denied_by`, `reason`).

Strictly-internal TypeScript types (e.g. `ApprovalOutcome`, `RateLimitResult`, constructor option interfaces) remain idiomatic camelCase; they are not serialized. When an internal value needs to flow into a DTO field — for example, copying `outcome.resolvedBy` into an `AuditRecord.approved_by` column — that is a single-line value copy at the boundary, not a shape conversion.

---

## Authentication

When `dashboard.api_secret` is set in `helio.yaml` (default secure mode), authenticated access works in two modes:

1. **Browser dashboard flow (recommended for operators)**
   - `POST /api/auth/session` with `{ "secret": "<api_secret>" }`
   - Server returns an HttpOnly `helio_session` cookie and a CSRF token in JSON (sessions last 8 hours)
   - Browser then calls `/api/*` with cookie credentials (no secret exposed in JS runtime)
2. **Machine client flow (backward compatible)**
   - Send `Authorization: Bearer <api_secret>` on protected `/api/*` calls

Bearer verification still uses constant-time comparison (`verifyBearer` hashes both values with SHA-256 before `timingSafeEqual`), so header length does not change timing behavior.

Machine-client auth header:

```
Authorization: Bearer <api_secret>
```

Protected routes reject unauthenticated requests with `401`. Cookie-authenticated mutating routes additionally require `x-helio-csrf`; a missing or mismatched token gets `403` — `{ "error": "Invalid CSRF token" }`.

When `dashboard.api_secret` is unset and the dashboard is enabled, config validation requires `dashboard.allow_open_mode: true` and a loopback `dashboard.host` (`127.0.0.1`, `localhost`, or `::1`) — otherwise the proxy refuses to start. Open mode is also unavailable whenever the secret is mandatory: any rule using `require_approval`, or `policies.flag_destructive: require_approval` or `policies.on_tool_drift: require_approval`, requires `dashboard.api_secret` regardless of `allow_open_mode` (see [Approval Workflows](./approvals.md#authentication)). In the open-mode posture, middleware is a no-op and endpoints are unauthenticated. Do not run this mode behind any shared or non-local endpoint.

`helio init` generates a fresh 32-byte hex secret on first run and writes it into the scaffolded `helio.yaml`.
Keep that generated secret unless you are intentionally opting into local open mode.

If an operator loses the secret, recover by generating a new one (for example `openssl rand -hex 32`), updating `dashboard.api_secret` in `helio.yaml`, and restarting the proxy — `dashboard.*` changes are not applied by a hot reload. Existing sessions are invalidated and all browser clients must sign in again.

---

## Endpoints

### Health and diagnostics

#### GET /api/health

Liveness and version probe. **Does not require authentication** — it stays open (alongside the `/api/auth/*` login endpoints) so that container healthchecks can hit it without bearer plumbing.

**Response (200):**

```json
{
  "status": "ok",
  "version": "0.0.0",
  "uptime": 3601.42
}
```

- `status` — always `"ok"` when the process is responsive.
- `version` — the Helio proxy version string, read from `package.json` at runtime. Set automatically by the release workflow from the git tag.
- `uptime` — seconds since the proxy process started, as reported by `process.uptime()`.

**Raw-shape endpoint:** stays unwrapped for Kubernetes/Docker liveness probe compatibility.

#### GET /api/auth/session

Returns the current dashboard auth state for browser bootstrapping and session refresh checks.

**Response (200):**

```json
{
  "auth_required": true,
  "authenticated": true,
  "expires_at": "2026-04-20T12:34:56.000Z",
  "csrf_token": "optional-when-authenticated"
}
```

- `auth_required` — `true` when `dashboard.api_secret` is configured.
- `authenticated` — `true` when the current request is authenticated (session cookie or bearer).
- `expires_at` — present for authenticated cookie sessions.
- `csrf_token` — present for authenticated cookie sessions; include as `x-helio-csrf` on mutating cookie-auth calls.

#### POST /api/auth/session

Creates a browser session from the shared dashboard secret.

**Request body:**

```json
{ "secret": "<dashboard.api_secret>" }
```

**Behavior:**

- On success: sets `Set-Cookie: helio_session=...; HttpOnly; SameSite=Lax; Path=/; ...` and returns `{ auth_required: true, authenticated: true, expires_at, csrf_token }`.
- On invalid secret: returns `401 { "error": "Unauthorized" }`.
- On a malformed or invalid body: returns `400` — `{ "error": "Invalid JSON" }` or `{ "error": "Validation error", "details": [...] }`.

#### POST /api/auth/logout

Revokes the current session (if present), clears `helio_session`, and returns:

```json
{ "ok": true }
```

#### GET /api/analytics

Aggregated statistics for the dashboard charts. Computed from the audit store for the supplied time range.

**Query parameters:**

| Parameter | Default                | Description                                  |
| --------- | ---------------------- | -------------------------------------------- |
| `from`    | `now - 24h` (ISO 8601) | Start of the aggregation window (inclusive). |
| `to`      | `now` (ISO 8601)       | End of the aggregation window (inclusive).   |

**Response (200):**

```json
{
  "total": 1247,
  "allowed_total": 1100,
  "blocked_total": 147,
  "dry_run_total": 94,
  "applied_total": 1153,
  "by_decision": [
    { "decision": "allow", "count": 1100 },
    { "decision": "deny", "count": 89 },
    { "decision": "require_approval", "count": 58 }
  ],
  "by_block_reason": [
    { "reason": "policy_denied", "count": 89 },
    { "reason": "approval_denied", "count": 31 },
    { "reason": "approval_timeout", "count": 27 },
    { "reason": "client_disconnected", "count": 12 },
    { "reason": "shutdown_cancelled", "count": 4 }
  ],
  "top_tools": [
    { "tool_name": "get_weather", "count": 412 },
    { "tool_name": "send_email", "count": 301 }
  ],
  "approval_rate": 0.87,
  "per_hour": [
    { "bucket": "2026-04-15T10:00:00Z", "count": 52 },
    { "bucket": "2026-04-15T11:00:00Z", "count": 60 }
  ]
}
```

- `total` — total number of audit records in the window.
- `allowed_total` — records that resolved without a block (`block_reason IS NULL`), excluding drift events (`tool_drift` / `tool_drift_reverted` decisions). When drift events fall inside the window, `allowed_total + blocked_total` adds up to less than `total`.
- `blocked_total` — records that resolved with a block (`block_reason IS NOT NULL`).
- `dry_run_total` — records produced in dry-run mode (`dry_run = true`).
- `applied_total` — records produced in applied mode (`dry_run = false`).
- `by_decision` — counts grouped by `policy_decision`, sorted descending.
- `by_block_reason` — blocked counts grouped by `block_reason`, sorted descending.
- `client_disconnected` and `shutdown_cancelled` are counted in `blocked_total` and `by_block_reason`, and remain distinct from human denials (`approval_denied`) and natural timeouts (`approval_timeout`).
- `top_tools` — top 10 tools by call count, sorted descending. Drift events are excluded.
- `approval_rate` — `approved / total_require_approval` in the window, or `null` when no approvals were requested.
- `per_hour` — hourly buckets of record counts over the window.

**Raw-shape endpoint:** this is an RPC-style view, not a resource lookup.

#### GET /api/limits

Current state of every active rate-limit and spend-limit bucket. Returns empty arrays when no buckets exist yet.

**Response (200):**

```json
{
  "rate_limits": [
    {
      "key": "tool:send_email",
      "current": 12,
      "limit": 50,
      "window_ms": 60000,
      "reset_at_ms": 1744718400000
    }
  ],
  "spend_limits": [
    {
      "key": "session:abc-123",
      "current_spend": 4.75,
      "limit": 20.0,
      "currency": "USD",
      "window_ms": 86400000,
      "reset_at_ms": 1744804800000
    }
  ]
}
```

- `rate_limits[].current` — calls consumed in the current window.
- `rate_limits[].reset_at_ms` — epoch ms at which the oldest recorded call ages out of the sliding window and `current` drops. The bucket does not reset wholesale.
- `spend_limits[].current_spend` — total spend in the current window in `currency`.

**Raw-shape endpoint:** this is an RPC-style view.

---

### Audit

See [Audit Trail](./audit.md) for the full audit record field reference and CLI export documentation.

#### GET /api/feed

Most recent audit records, newest-first. Designed for a live "activity feed" view that does not need server-side filtering.

**Query parameters:**

| Parameter | Default | Range      | Description                   |
| --------- | ------- | ---------- | ----------------------------- |
| `limit`   | `50`    | `[1, 200]` | Maximum records per response. |
| `offset`  | `0`     | `[0, ∞)`   | Number of records to skip.    |

**Response (200):**

```json
{
  "data": [
    /* AuditRecord[] */
  ],
  "total": 1247,
  "limit": 50,
  "offset": 0
}
```

See [Audit Trail → What's Recorded](./audit.md#whats-recorded) for the full `AuditRecord` field list.

**Paginated-list envelope.**

#### GET /api/audit

Searchable, filtered, paginated audit log.

**Query parameters:**

| Parameter             | Default | Range          | Description                                                                                   |
| --------------------- | ------- | -------------- | --------------------------------------------------------------------------------------------- |
| `limit`               | `50`    | `[1, 1000]`    | Page size.                                                                                    |
| `offset`              | `0`     | `[0, ∞)`       | Number of records to skip.                                                                    |
| `tool`                | —       | —              | Tool name substring filter (`LIKE %tool%`).                                                   |
| `decision`            | —       | —              | Filter by `policy_decision`.                                                                  |
| `reason`              | —       | —              | Filter by `block_reason`.                                                                     |
| `blocked`             | —       | `true`/`false` | Filter by whether `block_reason` is non-null.                                                 |
| `session`             | —       | —              | Filter by session ID.                                                                         |
| `agent`               | —       | —              | Filter by agent ID.                                                                           |
| `from`                | —       | ISO 8601       | Lower bound on `created_at` (inclusive).                                                      |
| `to`                  | —       | ISO 8601       | Upper bound on `created_at` (inclusive).                                                      |
| `upstream_status_min` | —       | integer        | Minimum upstream HTTP status (inclusive).                                                     |
| `upstream_status_max` | —       | integer        | Maximum upstream HTTP status (inclusive).                                                     |
| `destructive`         | —       | `true`/`false` | Filter by the `flagged_destructive` column.                                                   |
| `dry_run`             | —       | `true`/`false` | Filter by the `dry_run` column.                                                               |
| `origin`              | —       | —              | Filter by enforcement origin (`mcp`, or an adapter slug like `openclaw`).                     |
| `record_kind`         | —       | —              | Filter by record category (`tool_call`, `drift_event`, `install_scan`, `evaluation_expired`). |
| `channel_id`          | —       | —              | Filter by `metadata.channel_id` (adapter-supplied).                                           |
| `sender_id`           | —       | —              | Filter by `metadata.sender_id` (adapter-supplied).                                            |

`tool`, `origin`, `channel_id`, and `sender_id` use substring matching (`LIKE %value%`). `decision`, `reason`, `session`, `agent`, and `record_kind` use exact equality matching.

**Response (200):**

```json
{
  "data": [
    /* AuditRecord[] */
  ],
  "total": 1247,
  "limit": 50,
  "offset": 0
}
```

**Paginated-list envelope.**

#### GET /api/audit/:id

Look up a single audit record by ID.

**Response (200):**

```json
{
  "data": {
    /* AuditRecord */
  }
}
```

**Error responses:**

- `404` — `{ "error": "Record not found" }`

**Resource-singleton envelope.**

#### GET /api/audit/export

Bulk export of audit records as a downloadable attachment. **Not a JSON envelope** — the body is a bare `AuditRecord[]` array (or a CSV document). Returned with `Content-Disposition: attachment; filename="helio-audit-export.<ext>"` so browsers trigger a download.

Records are exported oldest-first (ascending `created_at`) — the opposite of the newest-first list endpoints. Combined with the `limit` cap, an export whose filters match more than 10k records returns the oldest 10k.

**Query parameters:**

| Parameter             | Default | Description                                                                                   |
| --------------------- | ------- | --------------------------------------------------------------------------------------------- |
| `format`              | `json`  | `json` or `csv`.                                                                              |
| `limit`               | `10000` | Maximum records. Capped at 10k.                                                               |
| `tool`                | —       | Filter by tool name substring.                                                                |
| `decision`            | —       | Filter by policy decision.                                                                    |
| `reason`              | —       | Filter by block reason.                                                                       |
| `blocked`             | —       | Filter by whether `block_reason` is non-null.                                                 |
| `dry_run`             | —       | Filter by dry-run records (`true`/`false`).                                                   |
| `session`             | —       | Filter by session ID.                                                                         |
| `agent`               | —       | Filter by agent ID.                                                                           |
| `from`                | —       | Start time (ISO 8601).                                                                        |
| `to`                  | —       | End time (ISO 8601).                                                                          |
| `upstream_status_min` | —       | Minimum upstream HTTP status (inclusive).                                                     |
| `upstream_status_max` | —       | Maximum upstream HTTP status (inclusive).                                                     |
| `origin`              | —       | Filter by enforcement origin (`mcp`, or an adapter slug like `openclaw`).                     |
| `record_kind`         | —       | Filter by record category (`tool_call`, `drift_event`, `install_scan`, `evaluation_expired`). |
| `channel_id`          | —       | Filter by `metadata.channel_id` (adapter-supplied).                                           |
| `sender_id`           | —       | Filter by `metadata.sender_id` (adapter-supplied).                                            |

See [Audit Trail → Dashboard API Export](./audit.md#dashboard-api-export) for full context and examples.

**Non-JSON endpoint** — attachment download, no envelope.

---

### Approvals

See [Approval Workflows](./approvals.md) for the full approval model, channel configuration, timeout semantics, and break-glass policy.

#### GET /api/approvals

List approval tickets. Tickets are sorted newest-first by `requested_at` before pagination, so `offset=0` always points at the most recent page regardless of queue depth.

**Query parameters:**

| Parameter | Default | Range       | Description                                                                                                                           |
| --------- | ------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `status`  | —       | see below   | Filter by `pending` / `approved` / `denied` / `timeout` / `break_glass` / `client_disconnected` / `shutdown_cancelled` / `cancelled`. |
| `limit`   | `50`    | `[1, 1000]` | Page size.                                                                                                                            |
| `offset`  | `0`     | `[0, ∞)`    | Number of tickets to skip.                                                                                                            |

**Response (200):**

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

`total` reflects the full count **after** the `status` filter but **before** pagination.

**Paginated-list envelope.**

#### GET /api/approvals/:id

Look up a single approval ticket by ID.

**Response (200):**

```json
{
  "data": {
    "id": "ticket-abc",
    "tool_name": "delete_record",
    "tool_input": { "id": "rec-1" },
    "matched_rule": "rule-destructive",
    "rule_index": 0,
    "channel_name": "dashboard",
    "session_id": "session-abc",
    "requested_at": "2026-04-15T10:00:00.000Z",
    "timeout_at": "2026-04-15T10:05:00.000Z",
    "timeout_ms": 300000,
    "status": "pending",
    "notification_failures": []
  }
}
```

Resolved tickets additionally include `resolved_at`, plus — depending on resolution — `resolved_by`, `denial_reason`, or `break_glass_reason` (`resolved_by` appears only when a resolver identity was supplied; the proxy's own `timeout`, `client_disconnected`, and `shutdown_cancelled` resolutions never include one). Resolution statuses include `approved`, `denied`, `timeout`, `break_glass`, `client_disconnected`, `shutdown_cancelled`, and — for adapter-owned tickets — `cancelled`. Escalated tickets include `escalated_at` and `escalated_to`; `notification_failures` records failed notification deliveries. Tickets live in memory, and resolved tickets are dropped about an hour after resolution — see [Approval Workflows](./approvals.md) for the retention model.

**Error responses:**

- `404` — `{ "error": "Ticket not found" }`

**Resource-singleton envelope.**

#### POST /api/approvals/:id/approve

Approve a pending ticket.

**Request body:**

```json
{ "approved_by": "alice" }
```

**Response (200):**

```json
{ "ok": true }
```

**Error responses:**

- `400` — `{ "error": "Invalid JSON" }` or `{ "error": "Validation error", "details": [...] }`
- `404` — `{ "error": "Ticket not found" }`
- `409` — `{ "error": "Ticket already resolved", "status": "<current-status>" }`
- `409` — `{ "error": "native_ticket", "resolve_in": "<origin>" }` for adapter-owned tickets (`channel_name` of `native:<origin>`): their approval UI lives in the adapter, so the `/api/approvals/*` endpoints refuse to resolve them. See the [adapter governance API](./adapter-api.md).

#### POST /api/approvals/:id/deny

Deny a pending ticket.

**Request body:**

```json
{ "denied_by": "bob", "reason": "Suspicious activity" }
```

`reason` is optional.

**Response (200):**

```json
{ "ok": true }
```

**Error responses:** same as `/approve`.

#### POST /api/approvals/:id/break-glass

Emergency force-approval. Both `approved_by` and `reason` are required. The resolution is flagged in the audit trail.

**Request body:**

```json
{ "approved_by": "admin", "reason": "Emergency override needed" }
```

**Response (200):**

```json
{ "ok": true }
```

**Error responses:** same as `/approve`.

---

### Evidence

#### GET /api/evidence/:session_id

Get the full evidence + context + completed-tools state for a single MCP session. Unknown session IDs return an empty state (not a 404) so that dashboard pages can render cleanly on first load.

**Response (200):**

```json
{
  "data": {
    "session_id": "session-abc",
    "evidence": {
      "orders.lookup": {
        "evidence_key": "orders.lookup",
        "data": { "id": 123, "status": "shipped" },
        "tool_name": "lookup_order",
        "timestamp": "2026-04-15T10:00:00.000Z",
        "expires_at": 1744720800000
      }
    },
    "context": {},
    "completed_tools": [
      {
        "tool_name": "lookup_order",
        "timestamp": "2026-04-15T10:00:00.000Z",
        "succeeded": true
      }
    ]
  }
}
```

Expired evidence entries are omitted from the `evidence` map in this response. Helio may still keep session-level "seen key" metadata internally so evidence checks can distinguish `evidence_missing` from `evidence_expired` within the same session.

**Resource-singleton envelope.**

---

### Events (SSE)

#### GET /api/events

Server-Sent Events stream of dashboard events. The stream stays open indefinitely; the server sends a heartbeat every 30 seconds (configurable via `dashboard.sse_heartbeat_interval`) so network-level idle timers do not close the connection. A background sweeper evicts connections that have not received a successful write in three heartbeat intervals. On proxy shutdown, active `/api/events` connections are drained and closed before process exit.

**Authentication:** requires either a valid session cookie or `Authorization: Bearer <api_secret>`. Query-string token auth is intentionally not supported.

**Event types:**

| Event                          | Payload fields                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `heartbeat`                    | empty `data`. Sent on connect and every `dashboard.sse_heartbeat_interval`.                                                                                                                                                                                                                                                                                                                                   |
| `action`                       | `id`, `tool_name`, `policy_decision`, `block_reason`, `approval_status`, `session_id`, `agent_id`, `environment`, `timestamp`, `total_duration_ms`, `approval_wait_ms`, `proxy_compute_ms`, `flagged_destructive`, `dry_run`, `matched_rule`, `matched_rule_index`, `origin` (enforcement origin: `mcp` or adapter slug), `record_kind` (`tool_call` / `drift_event` / `install_scan` / `evaluation_expired`) |
| `approval_requested`           | `ticket_id`, `tool_name`, `channel`, `requested_at`                                                                                                                                                                                                                                                                                                                                                           |
| `approval_resolved`            | `ticket_id`, `status`, `resolved_by` (optional), `resolved_at`                                                                                                                                                                                                                                                                                                                                                |
| `approval_notification_failed` | `ticket_id`, `channel`, `phase` (`initial`/`escalation`), `error`                                                                                                                                                                                                                                                                                                                                             |
| `limit_warning`                | `key`, `type` (`rate`/`spend`), `current`, `limit`, `utilization`                                                                                                                                                                                                                                                                                                                                             |

For `approval_resolved`, `status` is one of `approved`, `denied`, `timeout`, `break_glass`, `client_disconnected`, `shutdown_cancelled`, or — for adapter-owned tickets — `cancelled`.

Every non-heartbeat event carries a unique `id:` line for client-side de-duplication and debugging. The SSE stream is **live-only** (no replay endpoint): reconnecting clients should backfill from REST endpoints (`/api/feed`, `/api/approvals`, `/api/limits`) before resuming live consumption.

**Non-JSON endpoint** — SSE stream, not a single response.

---

## Error responses

Every `4xx` and `5xx` JSON response follows this shape:

```json
{ "error": "Human-readable error message" }
```

Some POST validation errors include a `details` array of `{ path, message }` entries from Zod; some 409 responses include a `status` field with the current ticket status (the native-ticket 409 carries `resolve_in` instead). The `error` field is always present.

**Unknown `/api/*` paths** are caught by a dedicated 404 guard and return `{ "error": "Not found" }` with `404`. Unknown paths never fall through to the SPA catch-all (which would otherwise return HTML), so an API client probing the sideband always gets a parseable JSON error.

---

## See also

- [Approval Workflows](./approvals.md) — approval model, channels, timeouts, escalation, break-glass policy
- [Audit Trail](./audit.md) — audit record field reference, storage, CLI export, CSV format
- [Policy Guide](./policies.md) — how policy decisions drive `/api/feed`, `/api/audit`, and `/api/approvals` population
- [Getting Started → Production Checklist](./getting-started.md#production-checklist) — security-hardening checklist for running the sideband in production
