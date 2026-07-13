# Configuration Reference

Helio is configured through a single `helio.yaml` file. The proxy validates this file on startup using a strict schema — any invalid fields, missing required values, or type mismatches produce clear error messages with paths to the problem.

## Minimal Configuration

The smallest valid configuration requires `version`, `upstream.url`, and an explicit dashboard posture:

```yaml
version: '1'

upstream:
  url: 'http://localhost:8080/mcp'

dashboard:
  enabled: false
```

Everything else uses sensible defaults: the proxy listens on port 3000, all tool calls are allowed, and audit records are written to `./helio-audit.db`.

## Full Annotated Example

```yaml
version: '1'

upstream:
  url: 'http://localhost:8080/mcp' # URL of the upstream MCP server
  transport: streamable-http # streamable-http | sse | stdio
  connect_timeout: '10s' # SSE connect timeout
  request_timeout: '30s' # Upstream request timeout
  forward_headers: [] # Caller x-* headers allowed upstream (default: none)
  # headers:
  #   Authorization: 'Bearer ${UPSTREAM_TOKEN}' # Static upstream auth (HTTP transports)

listen:
  port: 3000 # Proxy listening port
  host: '127.0.0.1' # Bind address

environment: 'production' # Label for policy matching

policies:
  default: allow # Default when no rule matches: allow | deny
  flag_destructive: log # Auto-flag destructive tools: log | require_approval
  dry_run: false # Simulate without forwarding
  hot_reload: true # Watch helio.yaml for changes — set false to pin policy
  rules:
    - name: block-destructive
      match:
        annotations:
          destructiveHint: true
      action: deny
      feedback:
        message: 'Destructive operations are blocked.'
        suggestion: 'Use a non-destructive alternative.'

budgets:
  - name: daily-cap # Named cross-tool spend budget (see below)
    limit: 50
    currency: USD
    window: 24h # Sliding duration, or "session"
    on_exceed: deny # deny | require_approval (break-glass)
    contributors:
      - tool: 'stripe_*' # Tool glob feeding this budget
        field: '$.amount' # Argument field carrying the amount

approval:
  timeout: '300s' # Max wait for approval decision
  default_on_timeout: deny # What to do on timeout: deny | allow
  channels:
    - type: dashboard # Always available, zero config
    - type: webhook
      url: 'https://example.com/helio-webhook'
      secret: 'hmac-signing-secret' # Optional HMAC-SHA256 signing
    - type: slack
      bot_token: '${HELIO_SLACK_BOT_TOKEN}'
      signing_secret: '${HELIO_SLACK_SIGNING_SECRET}'
      channel: '${HELIO_SLACK_CHANNEL}'

audit:
  storage: sqlite # Only option for MVP
  path: ./helio-audit.db # SQLite database file
  retention: '90d' # Auto-delete records older than this
  include_responses: true # Store full upstream responses

dashboard:
  enabled: true # Serve the dashboard UI
  port: 3100 # Dashboard API port
  host: '127.0.0.1' # Dashboard bind address
  api_secret: 'your-secret' # Manual dashboard login secret + optional Bearer auth for API clients
  allow_open_mode: false # Explicit local-only opt-in for running without api_secret
  sse_heartbeat_interval: '30s' # SSE keepalive interval

sdk:
  enabled: false # Enable the Python SDK sideband API
  port: 3200 # SDK sideband port
  host: '127.0.0.1' # SDK sideband bind address
```

## Configuration Sections

### version

| Field     | Type   | Required | Default | Description                                   |
| --------- | ------ | -------- | ------- | --------------------------------------------- |
| `version` | string | Yes      | —       | Must be `"1"`. Required in every config file. |

### upstream

Connection to the MCP server that Helio proxies.

> **v0.1 proxies exactly one upstream MCP server.** `upstream` is a single
> object, not a list — multiple/named upstreams and routing are not yet
> supported.

| Field             | Type     | Required    | Default           | Description                                                                                                                                      |
| ----------------- | -------- | ----------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `url`             | string   | Yes         | —                 | URL of the upstream MCP server (e.g. `http://localhost:8080/mcp`).                                                                               |
| `transport`       | string   | No          | `streamable-http` | Transport protocol: `streamable-http`, `sse`, or `stdio`.                                                                                        |
| `command`         | string   | Conditional | —                 | Command to spawn the MCP server. **Required** when `transport` is `stdio`.                                                                       |
| `args`            | string[] | No          | —                 | Arguments passed to the `command` (stdio only).                                                                                                  |
| `connect_timeout` | duration | No          | `10s`             | Timeout for establishing SSE upstream connections.                                                                                               |
| `request_timeout` | duration | No          | `30s`             | Timeout for upstream HTTP/SSE POST requests.                                                                                                     |
| `forward_headers` | string[] | No          | `[]`              | Explicit allowlist of caller `x-*` headers to forward upstream.                                                                                  |
| `headers`         | object   | No          | `{}`              | Static headers sent on every upstream request (HTTP transports). Values support `${VAR}` interpolation. Reserved transport headers are rejected. |

**Transport options:**

- **`streamable-http`** (default) — MCP Streamable HTTP: the server exposes an HTTP endpoint, and Helio acts as a full session-aware MCP client. It forwards each downstream client's `initialize` handshake and session id transparently, and sends `MCP-Protocol-Version` on upstream requests. Responses may be `application/json` or `text/event-stream` (SSE); Helio accepts both, tolerating SSE field lines with or without a space after `:`. For internal session traffic the protocol version comes from the upstream-negotiated `initialize` result; in direct forwarder or library usage, Helio preserves an already-present `mcp-protocol-version` request header. Session-enforcing servers (e.g. FastMCP, the official MCP SDKs) work with no server-side configuration changes.
- **`sse`** — Server-Sent Events transport for older MCP clients. Uses GET for the event stream and POST for messages.
- **`stdio`** — Spawns the MCP server as a child process and communicates over stdin/stdout. Useful for local servers that don't expose an HTTP endpoint.

> **Note on `202 Accepted` empty-body responses.** Both HTTP transports reply with `HTTP 202 Accepted` and an empty body for fire-and-forget messages: `streamable-http` for JSON-RPC `notifications/*` requests (per JSON-RPC 2.0 §4.1), and `sse` for every POSTed message (the actual response arrives on the separate event stream). Permissive HTTP/JSON-RPC clients, the common case, ignore it. If a specific MCP client refuses the empty-body shape, please file an issue.

```yaml
# Stdio example — Helio spawns the server process
upstream:
  transport: stdio
  command: npx
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp']
  url: 'stdio://'
```

> **Note:** The `url` field is required by the schema but ignored when `transport` is `stdio`. Any value (e.g. `stdio://`) works as a placeholder.

#### Static request headers

Attach static headers to every upstream request with `upstream.headers` — for example an operator-provided API credential. Values support `${VAR}` interpolation, so secrets stay out of the file:

```yaml
upstream:
  url: 'https://api.example.com/mcp'
  transport: streamable-http
  headers:
    Authorization: 'Bearer ${UPSTREAM_TOKEN}'
```

Applies to the HTTP transports (`streamable-http`, `sse`); `stdio` has no request headers, so the field is ignored there. The reserved transport/protocol headers `mcp-session-id`, `mcp-protocol-version`, `content-type`, `content-length`, and `host` are rejected — Helio owns those.

On a name conflict, static `upstream.headers` take precedence over caller-forwarded headers (`forward_headers`), matched case-insensitively. This is deliberate: a downstream caller cannot override an operator-provided credential such as `Authorization`.

#### Startup annotation cache priming

At startup, Helio sends a synthetic upstream `tools/list` request to warm the tool-annotation cache before serving traffic. This avoids first-request false denials in flows that call `tools/call` before any client-issued `tools/list`, and establishes the per-tool definition baselines used for [drift detection](./policies.md#tool-definition-drift).

If priming succeeds quickly, startup logs:

```
[helio] Annotation cache primed: <n> tool definitions baselined for drift detection (baselines are per-process; a restart re-baselines — review tool_drift audit records before restarting)
```

If upstream is unavailable or slow, Helio continues boot, logs a fail-closed warning, and retries priming in the background with backoff:

```
[helio] Annotation cache priming failed: ...
[helio] Annotation cache prime retry 1 scheduled in ...
```

While cache data is unknown, policy annotation matching still uses MCP defaults (`destructiveHint: true`, etc.), preserving fail-closed behavior.

### listen

Where the proxy listens for incoming MCP requests.

| Field  | Type    | Required | Default     | Description             |
| ------ | ------- | -------- | ----------- | ----------------------- |
| `port` | integer | No       | `3000`      | Port number (1–65535).  |
| `host` | string  | No       | `127.0.0.1` | Hostname or IP to bind. |

### environment

| Field         | Type   | Required | Default | Description                                                                                                                                                                            |
| ------------- | ------ | -------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `environment` | string | No       | —       | A label (e.g. `production`, `staging`) used in policy rule matching. Required whenever any rule uses `match.environment`. See [Policy Guide — Environment](./policies.md#environment). |

If a rule sets `match.environment` but top-level `environment` is missing, config validation fails (startup, `helio validate`, and hot-reload).

### policies

Governance rules for tool calls. See [Policy Guide](./policies.md) for full documentation, including install-time rules (`policies.install` with `deny_install`) and the [adapter governance API](./adapter-api.md).

| Field              | Type    | Required | Default | Description                                                                                                                                                                                                     |
| ------------------ | ------- | -------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `default`          | string  | No       | `allow` | Action when no rule matches: `allow` or `deny`.                                                                                                                                                                 |
| `flag_destructive` | string  | No       | —       | Auto-flag unmatched destructive tools: `log` (audit flag only) or `require_approval` (escalate to approval).                                                                                                    |
| `on_tool_drift`    | string  | No       | `block` | Response when a tool's definition changes after baseline: `block` (deny until restart), `require_approval` (escalate), or `log` (audit only). See [Tool definition drift](./policies.md#tool-definition-drift). |
| `dry_run`          | boolean | No       | `false` | Enable global dry-run mode. No requests are forwarded to upstream.                                                                                                                                              |
| `hot_reload`       | boolean | No       | `true`  | Watch the config file for changes and reconcile policy live. Set to `false` to pin the policy (see below).                                                                                                      |
| `rules`            | array   | No       | `[]`    | Ordered list of policy rules. First matching rule wins.                                                                                                                                                         |

Each rule in the `rules` array has the following structure:

| Field              | Type     | Required | Description                                                                                                                                                                                      |
| ------------------ | -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`             | string   | No       | Human-readable label for audit and error messages.                                                                                                                                               |
| `match`            | object   | Yes      | Conditions that must all be true for this rule to match. See [Match Conditions](./policies.md#match-conditions).                                                                                 |
| `action`           | string   | Yes      | What to do: `allow`, `deny`, `require_approval`, `rate_limit`, `spend_limit`, or `dry_run`.                                                                                                      |
| `approval`         | object   | No       | Per-rule approval override (`channel`, optional `timeout` / escalation fields). When omitted on `require_approval`, runtime falls back to channel `dashboard` and the global `approval.timeout`. |
| `evidence`         | object   | No       | Evidence keys that must be present before allowing the action.                                                                                                                                   |
| `requires`         | string[] | No       | Tool names that must have been called first in this session.                                                                                                                                     |
| `requires_success` | boolean  | No       | Whether prerequisite tools in `requires` must have succeeded, not just been called. Defaults to `true`; set `false` to accept any prior call.                                                    |
| `limits`           | object   | No       | Rate or spend limit configuration.                                                                                                                                                               |
| `feedback`         | object   | No       | Custom message and suggestion returned when the action is blocked, and on sideband `require_approval`/`dry_run` decisions. See [Feedback Messages](./policies.md#feedback-messages).             |

`action: require_approval` without a rule-level `approval:` block is valid. Helio emits a config warning and uses runtime defaults (`channel: dashboard`, timeout from top-level `approval.timeout`).

When a rule specifies `approval.channel` or `approval.delegates`, every referenced value must map to a configured channel's effective registry key — its `name` when one is set, its `type` otherwise (a named channel is NOT reachable by its bare type) — or the built-in `dashboard` channel. Unknown references are startup-fatal validation errors.

Limiter actions are startup-fatal when incomplete:

- `action: rate_limit` must include both `limits.max_calls` and `limits.window`.
- `action: spend_limit` must include `limits.max_spend`.

### budgets

Named cross-tool spend budgets — a first-class layer independent of policy rules. One call depletes every budget whose contributors match, all-or-nothing: the call proceeds only if every matching budget allows it, a breach denies it (or raises a [break-glass approval](./approvals.md#budget-break-glass-tickets) when `on_exceed: require_approval`), and rejected calls never consume budget anywhere. Budgets are enforced deterministically at the MCP gate; on the host-enforced adapter tier they inherit the documented [TOCTOU caveat](./adapter-api.md#the-crash-ttl-and-toctou-caveats).

```yaml
budgets:
  - name: daily-cap # unique; letters, digits, "_", "-" only
    limit: 50
    currency: USD # single currency per budget, the operator's assertion
    window: 24h # a duration, or "session" (a depleting pot per session key)
    key: global # global | session | sender_id (default: global)
    on_exceed: deny # deny | require_approval (break-glass)
    # approval: # on_exceed: require_approval only — ticket routing, same
    #   channel: oncall # shape as rule-level approval; defaults to the
    #   timeout: 120s # dashboard channel and the global approval.timeout
    contributors:
      - tool: 'stripe_*' # picomatch glob, same engine as match.tool
        field: '$.amount' # dot-path into the tool arguments
      - tool: 'paypal_*'
        field: '$.total'
```

| Field          | Type     | Required | Default  | Description                                                                                                                                                                                                                                 |
| -------------- | -------- | -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`         | string   | Yes      | —        | Unique budget identity; preserves accrued spend across config edits. Charset: `[A-Za-z0-9_-]`, ≤64.                                                                                                                                         |
| `limit`        | number   | Yes      | —        | Maximum cumulative spend within the window. Must be positive.                                                                                                                                                                               |
| `currency`     | string   | Yes      | —        | Display/validation currency. Whether tools actually charge in it is the operator's assertion.                                                                                                                                               |
| `window`       | string   | Yes      | —        | A [duration](#duration-strings) (sliding window) or `session` (never replenishes on a timer).                                                                                                                                               |
| `key`          | string   | No       | `global` | Bucket scope: one shared pot (`global`), per session, or per adapter-supplied sender.                                                                                                                                                       |
| `on_exceed`    | string   | No       | `deny`   | What a breach does: `deny` blocks the call; `require_approval` raises one composite break-glass ticket per call. See [Budget break-glass tickets](./approvals.md#budget-break-glass-tickets).                                               |
| `approval`     | object   | No       | —        | Break-glass ticket routing (`channel`, optional `timeout` / escalation fields — same shape as rule-level `approval`). Only valid with `on_exceed: require_approval`; omitted means the dashboard channel and the global `approval.timeout`. |
| `idle_ttl`     | duration | No       | `24h`    | Session windows only: idle time before an inactive session pot is collected.                                                                                                                                                                |
| `contributors` | list     | Yes      | —        | Non-empty. Which tools feed the budget and which argument field carries the amount (first match wins).                                                                                                                                      |

Validation: budget names must be unique; `window: session` requires `key: session` or `key: sender_id`; `idle_ttl` is only valid with `window: session`; `key: sender_id` requires `sdk.enabled: true`; `approval` is only valid with `on_exceed: require_approval`, and its `channel`/`delegates` must reference configured approval channels. Any budget with `on_exceed: require_approval` requires `dashboard.api_secret`, exactly like a `require_approval` rule. A matched contributor whose amount field is missing, non-numeric, negative, or non-finite fails closed — the call is denied regardless of `on_exceed`.

Budget state lives in buckets keyed `budget:<name>:<scope>` — visible in audit records' `evidence_chain.budgets`. Budgets hot-reload by name identity: edits to `contributors` preserve accrued spend (they do not change what was already spent), while a change to `limit`, `currency`, `window`, or `key` resets the budget's buckets (a different pool or scope structure).

Budget spend **persists across restarts**: every charge is written to a ledger in the audit database (see [Budget Ledger Tables](./audit.md#budget-ledger-tables)) synchronously at record time, and startup replays it — duration windows resume mid-window exactly where they left off, and `session` pots whose last activity is within `idle_ttl` come back with their full accrued spend. The reset rules above extend across restarts: if the `limit`/`currency`/`window`/`key` tuple in the config differs from what the ledger last saw, the pot starts fresh instead of replaying, and a removal the proxy observes — live via hot-reload, or discovered at a startup without the budget — retires the accrued spend, so re-adding the budget later starts fresh even with an identical tuple. Ledger rows follow `audit.retention` on the audit store's sweep schedule; configuring a budget window (or session `idle_ttl`) longer than the retention draws a startup warning, because the sweep would forget in-window spend across restarts. Unlike budgets, rule-level rate/spend limit buckets remain in-memory and reset on restart.

### approval

Configuration for human-in-the-loop approval workflows. See [Approval Workflows](./approvals.md) for full documentation.

| Field                | Type     | Required | Default | Description                                    |
| -------------------- | -------- | -------- | ------- | ---------------------------------------------- |
| `timeout`            | duration | No       | `300s`  | Maximum time to wait for an approval decision. |
| `default_on_timeout` | string   | No       | `deny`  | Action when timeout fires: `deny` or `allow`.  |
| `channels`           | array    | No       | `[]`    | Approval channel configurations.               |

#### Channel: dashboard

| Field  | Type   | Required | Description                     |
| ------ | ------ | -------- | ------------------------------- |
| `type` | string | Yes      | Must be `dashboard`.            |
| `name` | string | No       | Optional label for the channel. |

The dashboard channel requires no additional configuration. Approval tickets appear in the dashboard Approvals tab and can be resolved via the UI or REST API.

#### Channel: webhook

| Field    | Type   | Required | Description                                                                                       |
| -------- | ------ | -------- | ------------------------------------------------------------------------------------------------- |
| `type`   | string | Yes      | Must be `webhook`.                                                                                |
| `name`   | string | No       | Optional label for the channel.                                                                   |
| `url`    | string | Yes      | HTTP endpoint to POST approval notifications to.                                                  |
| `secret` | string | No       | HMAC-SHA256 secret for request signing. When set, requests include an `x-helio-signature` header. |

Webhook channels require `dashboard.enabled: true` because callbacks resolve tickets via the dashboard sideband approval API. Configurations that enable webhook channels while disabling the dashboard are rejected at startup.

#### Channel: slack

| Field            | Type   | Required | Description                                             |
| ---------------- | ------ | -------- | ------------------------------------------------------- |
| `type`           | string | Yes      | Must be `slack`.                                        |
| `name`           | string | No       | Optional label for the channel.                         |
| `bot_token`      | string | Yes      | Slack Bot User OAuth Token (`xoxb-...`).                |
| `signing_secret` | string | Yes      | Slack app signing secret (from Basic Information page). |
| `channel`        | string | Yes      | Slack channel ID (starts with `C`) or channel name.     |

See [Approval Workflows — Slack App Setup](./approvals.md#slack-app-setup) for a step-by-step guide.

### audit

Audit trail configuration. See [Audit Trail](./audit.md) for what's recorded and how to export.

| Field               | Type     | Required | Default            | Description                                                                     |
| ------------------- | -------- | -------- | ------------------ | ------------------------------------------------------------------------------- |
| `storage`           | string   | No       | `sqlite`           | Storage backend. Only `sqlite` is supported.                                    |
| `path`              | string   | No       | `./helio-audit.db` | Path to the SQLite database file.                                               |
| `retention`         | duration | No       | `90d`              | Records older than this are automatically deleted.                              |
| `include_responses` | boolean  | No       | `true`             | Store full upstream JSON-RPC responses. Set to `false` to store only a summary. |

Audit rows also include:

- `environment` — runtime environment label captured at decision time (nullable if unset)
- `matched_rule_index` — zero-based rule index when a rule matched; `null` when default policy applied

### dashboard

Configuration for the built-in web dashboard.

When `dashboard.enabled: true`, Helio requires bundled dashboard assets to be present in the proxy package. If assets are missing, `helio start` and `helio validate` fail fast with an explicit error.

> **Security — open dashboard mode:** with `dashboard.enabled: true`, you must either set a non-empty `dashboard.api_secret` or explicitly opt in to local open mode with `dashboard.allow_open_mode: true`. Open mode is allowed only on loopback hosts (`127.0.0.1`, `localhost`, `::1`) and should never be exposed via shared or non-local deployments. If you use `api_secret: '${VAR}'`, a missing `${VAR}` fails config loading; only an explicitly empty value (or omitted secret with open-mode opt-in) runs unauthenticated.
>
> `helio init` generates a secure `dashboard.api_secret` by default. Do not remove it unless you intentionally want local open mode.

| Field                    | Type     | Required    | Default     | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------ | -------- | ----------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`                | boolean  | No          | `true`      | Enable the dashboard UI and sideband API server.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `port`                   | integer  | No          | `3100`      | Dashboard sideband API port (1–65535).                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `host`                   | string   | No          | `127.0.0.1` | Dashboard sideband bind address.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `api_secret`             | string   | Conditional | —           | Shared dashboard secret. Required when `dashboard.enabled: true` unless `dashboard.allow_open_mode: true`. Also required whenever any rule uses `action: require_approval`, any budget uses `on_exceed: require_approval`, or `policies.flag_destructive` or `policies.on_tool_drift` is set to `require_approval`. Browser operators enter it once on the dashboard login card to mint an HttpOnly session cookie; machine clients may send `Authorization: Bearer <token>`. |
| `allow_open_mode`        | boolean  | No          | `false`     | Explicit opt-in to run the dashboard sideband without `api_secret`. Only valid on loopback hosts and intended for trusted local development only.                                                                                                                                                                                                                                                                                                                             |
| `sse_heartbeat_interval` | duration | No          | `30s`       | Interval between SSE keepalive messages.                                                                                                                                                                                                                                                                                                                                                                                                                                      |

### sdk

Configuration for the SDK sideband API, used for evidence grounding (Python SDK) and the [adapter governance API](./adapter-api.md) (hook-based adapters such as OpenClaw).

| Field            | Type     | Required | Default     | Description                                                                                                       |
| ---------------- | -------- | -------- | ----------- | ----------------------------------------------------------------------------------------------------------------- |
| `enabled`        | boolean  | No       | `false`     | Enable the SDK sideband HTTP server.                                                                              |
| `port`           | integer  | No       | `3200`      | Sideband server port (1–65535).                                                                                   |
| `host`           | string   | No       | `127.0.0.1` | Sideband server bind address.                                                                                     |
| `evaluation_ttl` | duration | No       | `10m`       | How long a governance `/evaluate` decision waits for its `/audit` before being finalized as `evaluation_expired`. |

#### Sideband authentication

When `sdk.enabled` is `true`, Helio generates two fresh 32-byte hex Bearer tokens on every `helio start` (unless set in the environment). Generated tokens are printed to stderr — that is their only handoff:

```
SDK sideband listening on http://127.0.0.1:3200
SDK token (generated per-boot HELIO_SDK_TOKEN; pass as HELIO_SDK_TOKEN env var to your SDK clients):
  <hex>
Adapter token (generated per-boot HELIO_ADAPTER_TOKEN; governance routes; pass as HELIO_ADAPTER_TOKEN to your adapter):
  <hex>
```

An environment-provided token is acknowledged without its value (`SDK token: reusing HELIO_SDK_TOKEN from environment (value not shown)`), so pre-set secrets never land in process logs.

The tokens are scoped: `HELIO_SDK_TOKEN` authorizes the evidence/context routes, and `HELIO_ADAPTER_TOKEN` authorizes the governance routes (`/evaluate`, `/audit`, `/install-scan`, `/approval/:id/resolve`). An SDK client cannot drive policy decisions, and an adapter cannot write evidence. Both are written into `process.env` so child processes inherit them. Every sideband request except `GET /healthz` must carry the matching `Authorization: Bearer <token>`; mismatches return `401`. The sideband rejects any request carrying an `Origin` header (including `Origin: null`), blocks `OPTIONS` preflights with `403`, and rejects request bodies over 1 MiB with `413`.

Operators who need a stable token across restarts can set `HELIO_SDK_TOKEN` explicitly in the proxy's environment — the proxy respects a pre-set value instead of generating one, and does not echo it to stderr. Rotation, revocation, and key management are not part of the v0.1.0 trust model; a restart with a new token is the rotation primitive.

## Duration Strings

Several fields accept duration strings in the format `<number><unit>`:

| Unit | Meaning | Example            |
| ---- | ------- | ------------------ |
| `s`  | Seconds | `300s` = 5 minutes |
| `m`  | Minutes | `5m` = 5 minutes   |
| `h`  | Hours   | `1h` = 1 hour      |
| `d`  | Days    | `90d` = 90 days    |

Duration strings are used for `approval.timeout`, `audit.retention`, `dashboard.sse_heartbeat_interval`, `upstream.connect_timeout`, `upstream.request_timeout`, rate limit `window`, spend limit `window`, budget `window` and `idle_ttl`, `sdk.evaluation_ttl`, and `escalation_after`.

## Environment Variable Interpolation

Use `${VAR_NAME}` syntax to inject environment variables into any string value in `helio.yaml`. Variables are resolved recursively through strings, arrays, and nested objects.

```yaml
approval:
  channels:
    - type: slack
      bot_token: '${HELIO_SLACK_BOT_TOKEN}'
      signing_secret: '${HELIO_SLACK_SIGNING_SECRET}'
      channel: '${HELIO_SLACK_CHANNEL}'
```

If a referenced variable is not set, the proxy exits with an error:

```
Error: Environment variable "HELIO_SLACK_BOT_TOKEN" is not set
```

> **Note:** Variable names must match `[A-Za-z_][A-Za-z0-9_]*`. Only the `${VAR}` syntax is supported — `$VAR` without braces is not interpolated.

## Validation

Validate your configuration without starting the proxy:

```bash
helio validate
```

The `validate` command runs the full pipeline: YAML parsing, environment variable interpolation, schema validation, and policy rule and budget compilation (catches invalid glob patterns and regex syntax).

When the dashboard is enabled, validation also confirms that bundled dashboard assets are present.

```bash
# Validate a specific config file
helio validate -c production.yaml
```

On success:

```
Config is valid: helio.yaml (3 policy rules)
```

On failure, Helio reports the exact path and error:

```
Invalid config: Invalid configuration (1 error)
  upstream.url: Invalid input: expected string, received undefined
```

## Hot Reload

Helio watches your configuration file for changes and automatically reloads policy rules without restarting the proxy. The file watcher uses a 200ms debounce to batch rapid saves.

On successful reload:

```
[helio] Policy reloaded: 5 rules (default: allow)
```

If the new configuration is invalid — or its budget epoch changes cannot be durably recorded — Helio rejects the reload as a whole, keeps the complete current configuration (policy rules and budgets alike), and logs the error:

```
[helio] Config reload failed (keeping current configuration): YAML parse error in helio.yaml: ...
```

### Limit reconciliation

Rate and spend limit buckets survive a hot-reload as long as their underlying rule config is unchanged. A benign rewrite of `helio.yaml` (for example, `vim :w` with no real edits, or adding a comment) preserves live counters and elapsed-window progress — operators don't zero their budget mid-window. Reconciliation compares each bucket's config tuple (rate uses `max_calls` plus `window`; spend uses `limit`, `currency`, and `window`), not rule identity. A bucket survives as long as its tuple still appears in some rule after the reload, and is evicted (then lazily re-created on the next request) only when no remaining rule carries that tuple. So a rule whose limit config changes, or a rule removed entirely, drops its old bucket unless another rule still uses the same tuple.

Spend bucket keys carry a `:rule:<index>` suffix (for example `session:abc:rule:2`), so two `spend_limit` rules that share a scope — say, two session-keyed rules — track their spend in separate buckets instead of silently sharing one with last-write-wins config. The suffixed keys are what you see in `GET /api/limits`, `limit_warning` events, and denial messages. Rate bucket keys are unchanged. For suffixed keys, reconciliation matches the tuple at the bucket's own rule index: an edit that shifts a spend rule's position (inserting or removing a rule above it, or reordering) evicts its bucket and the rule starts a fresh window — accrued spend does not follow a rule to its new position. Two caveats: swapping two spend rules with identical `limit`/`currency`/`window` keeps each bucket at its position, so the rules exchange accrued spend; and a sideband call evaluated before a reload commits its spend (at `/audit`) into the bucket keyed at evaluation time, which may be a just-evicted label.

> **Note:** Rule-level limit state is reconciled, not persisted — restarting the proxy clears rate/spend rule buckets. Named budgets are different: their spend persists across restarts via the budget ledger (see [budgets](#budgets)).

### Disabling hot reload

For production deployments that want zero live-state movement on config writes, disable hot reload with either of:

```bash
helio start --no-hot-reload
```

or in `helio.yaml`:

```yaml
policies:
  hot_reload: false
```

The CLI flag takes precedence over the config file. When disabled, Helio logs:

```
[helio] Hot-reload disabled — config changes to helio.yaml will require a restart
```

### Reload boundary

Compiled policy behavior and named budgets are hot-reloadable. Startup-bound sections still require restart.

| Config path                 | Reloads on save? | Notes                                                                                     |
| --------------------------- | ---------------- | ----------------------------------------------------------------------------------------- |
| `policies.rules`            | Yes              | Recompiled and swapped atomically.                                                        |
| `budgets`                   | Yes              | Reconciled by name identity — see [budgets](#budgets) for what survives an edit.          |
| `policies.default`          | Yes              | Takes effect immediately on the next request.                                             |
| `policies.flag_destructive` | Yes              | Takes effect immediately on the next request.                                             |
| `policies.on_tool_drift`    | Yes              | Takes effect immediately on the next request.                                             |
| `policies.dry_run`          | Yes              | Takes effect immediately on the next request.                                             |
| `policies.hot_reload`       | No               | Controls watcher startup behavior; changing it on a running process requires restart.     |
| `environment`               | No               | Runtime deployment identity for matching/audit attribution; changing it requires restart. |
| `upstream.*`                | No               | Upstream transport/client initialized at startup.                                         |
| `listen.*`                  | No               | Proxy listener socket bound at startup.                                                   |
| `dashboard.*`               | No               | Dashboard server/session settings initialized at startup.                                 |
| `approval.*`                | No               | Router/channels/timeouts initialized at startup.                                          |
| `audit.*`                   | No               | SQLite store path/settings initialized at startup.                                        |
| `sdk.*`                     | No               | Sideband listener/token behavior initialized at startup.                                  |

When non-reloadable fields change on save, Helio logs an explicit restart-required warning and keeps using startup values for those fields.

The reloadable and startup-bound halves cannot contradict each other: a reload whose policies or budgets reference approval routing that only exists in the NEW file — a channel added to `approval.channels` in the same edit, or dashboard-routed break-glass while the running process has no dashboard server — is rejected as a whole (`Config reload failed (keeping current configuration)`), because the running approval registry is startup-bound and the referenced channel could never notify or resolve a ticket. Apply such changes with a restart.
