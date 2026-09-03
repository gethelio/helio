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
  protocol_version: auto # auto | 2025-06-18 | 2026-07-28 (a dated pin skips era probing)
  connect_timeout: '10s' # SSE connect timeout
  request_timeout: '30s' # Upstream request timeout
  forward_headers: [] # Caller x-* headers allowed upstream (default: none)
  # headers:
  #   Authorization: 'Bearer ${UPSTREAM_TOKEN}' # Static upstream auth (HTTP transports)

listen:
  port: 3000 # Proxy listening port
  host: '127.0.0.1' # Bind address
  allowed_origins: [] # Origins allowed on /mcp and /sse (default: refuse every Origin)

environment: 'production' # Label for policy matching

session:
  identity: # Ordered identity sources; first match wins
    - source: header
      name: x-helio-session-id # Caller-set identity header (default)
    - source: legacy_header # Verbatim Mcp-Session-Id (deprecation window)
  on_unresolved: deny # deny | anonymous

policies:
  default: allow # Default when no rule matches: allow | deny
  flag_destructive: log # Auto-flag destructive tools: log | require_approval
  tool_revalidation:
    enabled: true # Proxy-scheduled tools/list revalidation + downward ttlMs clamp
    interval: 5m # Revalidation cadence (10s minimum)
    max_advertised_ttl: 5m # Clamp cap on forwarded ttlMs (default: interval)
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
      - match:
          tool: 'stripe_*' # Tool glob feeding this budget
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
  api_secret: 'sha256:ef1ea5dd2b28d2c127ffb41c522ac19787f408c19195cc2bebb41e227f664e86' # Digest of the dashboard secret (this one is of 'your-secret'); run helio secret for a real pair
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

Connection to the MCP server that Helio proxies. This is the singular form —
one `upstream` object, served at `/mcp` and `/sse` — and it stays fully
supported. To govern more than one MCP server from a single proxy, declare
the named [`upstreams`](#upstreams) list in its place: a config sets exactly
one of the two forms, and declaring both, or neither, fails validation (the
error text is quoted under [upstreams](#upstreams)). Tool sets are never
merged across upstreams — each named upstream is served at its own
`/mcp/<name>` door.

| Field              | Type     | Required    | Default           | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------ | -------- | ----------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`              | string   | Conditional | —                 | URL of the upstream MCP server (e.g. `http://localhost:8080/mcp`). **Required** when `transport` is `streamable-http` or `sse` (the default is `streamable-http`); optional and ignored for `stdio`; a present value draws a warning.                                                                                                                                                                                                                                                       |
| `transport`        | string   | No          | `streamable-http` | Transport protocol: `streamable-http`, `sse`, or `stdio`.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `protocol_version` | string   | No          | `auto`            | MCP revision spoken to the upstream: `auto` (probe and detect, see [era detection](#upstream-mcp-era-detection)), `2025-06-18` (pin legacy), or `2026-07-28` (pin modern; requires `transport: streamable-http`). A dated pin trusts the operator and skips era probing entirely — it exists for upstreams the probe cannot classify, such as a modern-only server gated behind per-client `Authorization` pass-through, where the probe is refused forever while relayed requests succeed. |
| `command`          | string   | Conditional | —                 | Command to spawn the MCP server. **Required** when `transport` is `stdio`.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `args`             | string[] | No          | —                 | Arguments passed to the `command` (stdio only).                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `connect_timeout`  | duration | No          | `10s`             | Timeout for establishing SSE upstream connections.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `request_timeout`  | duration | No          | `30s`             | Timeout for upstream HTTP/SSE POST requests.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `forward_headers`  | string[] | No          | `[]`              | Explicit allowlist of caller `x-*` headers to forward upstream.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `headers`          | object   | No          | `{}`              | Static headers sent on every upstream request (HTTP transports). Values support `${VAR}` interpolation. Reserved transport headers are rejected.                                                                                                                                                                                                                                                                                                                                            |

**Transport options:**

- **`streamable-http`** (default) — MCP Streamable HTTP: the server exposes an HTTP endpoint, and Helio acts as a full session-aware MCP client. Against a legacy upstream it forwards each downstream client's `initialize` handshake and wire `Mcp-Session-Id` transparently, in both directions, and sends `MCP-Protocol-Version` on upstream requests; against a modern (2026-07-28) upstream the relay leg takes the modern wire shape instead — see [era detection](#upstream-mcp-era-detection). Every upstream POST also carries `Mcp-Method` mirroring the request's JSON-RPC `method`, aside from Helio's own legacy `initialize` handshake (the internal `initialize`/`notifications/initialized` pair it performs against a legacy upstream, which is deliberately left unstamped), and `Mcp-Name` mirroring `params.name` (`tools/call`, `prompts/get`) or `params.uri` (`resources/read`), with values encoded per the spec when needed. The same headers are validated on the inbound boundary: a request claiming `MCP-Protocol-Version: 2026-07-28` must carry an agreeing `Mcp-Method` (plus `Mcp-Name` when the body has a name-bearing field) and the `params._meta` protocol-version mirror, and a present `Mcp-Method` or `Mcp-Name` must agree with the body under any version claim, with sentinel-encoded values decoded before comparison; a disagreement is rejected with HTTP 400 and JSON-RPC error `-32020` before any policy evaluation. The wire session id is a transport relay only — it is separate from Helio's [session identity](#session) resolution, and a proxy-resolved identity is never sent upstream as `Mcp-Session-Id` (a session-enforcing upstream would reject an id it did not mint). A caller-supplied `mcp-session-id` request header is never forwarded on either era — relayed legacy traffic carries only the transport relay field's value, and internal legacy traffic only the id the upstream minted for Helio's managed session (or none at all). The `Content-Type` on its request sends always describes the JSON body Helio serialized (a caller- or constructor-supplied value never overrides it), and a caller-supplied `Content-Length` is dropped so the computed length is truthful. The `Accept` on Helio's upstream POSTs (the request sends, the era probe, and the internal `initialize`/`notifications/initialized` pair) always advertises `application/json, text/event-stream`, the two response framings Helio parses; a caller- or constructor-supplied value never overrides it. Responses may be `application/json` or `text/event-stream` (SSE); Helio accepts both, tolerating SSE field lines with or without a space after `:`. For internal session traffic against a legacy upstream, the protocol version comes from the upstream-negotiated `initialize` result; against a modern upstream, internal requests skip the handshake entirely and are tagged `2026-07-28` directly. In direct forwarder or library usage on the legacy leg, Helio preserves an already-present `mcp-protocol-version` request header; on the modern leg the header is always Helio's own `2026-07-28`. Session-enforcing servers (e.g. FastMCP, the official MCP SDKs) work with no server-side configuration changes.
- **`sse`** — the deprecated HTTP+SSE transport. Helio connects as an SSE client: a GET opens the upstream's event stream, the POST endpoint for messages is learned from the server's `endpoint` event, and JSON-RPC responses are correlated over that stream. The message POST never carries `Mcp-Method` or `Mcp-Name` (both postdate this transport) and never sends a caller-supplied `Mcp-Session-Id` — the wire `Mcp-Session-Id` comes only from the transport relay field. On the message POSTs the `Content-Type` always describes the JSON body Helio serialized (a caller- or constructor-supplied value never overrides it), and a caller-supplied `Content-Length` is dropped so the computed length is truthful. The GET connect always advertises `Accept: text/event-stream`; Helio sets no `Accept` on the message POSTs — a caller- or constructor-supplied value is dropped, and the runtime's own default (`*/*`) is what reaches the wire.
- **`stdio`** — Spawns the MCP server as a child process and communicates over stdin/stdout. Useful for local servers that don't expose an HTTP endpoint.

> **Note on `202 Accepted` empty-body responses.** Both HTTP transports reply with `HTTP 202 Accepted` and an empty body for fire-and-forget messages: `streamable-http` for JSON-RPC `notifications/*` requests (per JSON-RPC 2.0 §4.1), and `sse` (Helio's downstream `/sse` listener, not `upstream.transport: sse`) for every POSTed message (the actual response arrives on the separate event stream). Permissive HTTP/JSON-RPC clients, the common case, ignore it. If a specific MCP client refuses the empty-body shape, please file an issue.

```yaml
# Stdio example — Helio spawns the server process
upstream:
  transport: stdio
  command: npx
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp']
```

> **Note:** The `url` field may be omitted when `transport` is `stdio`; a present value (e.g. a legacy `stdio://` placeholder) is accepted and ignored, and draws a warning naming the field — at `helio validate` and again at `helio start` — while the config stays valid and exit codes are unchanged:

```
[helio] Warning: upstream.url is ignored when transport is "stdio" (the stdio forwarder spawns "command"). Remove the field to silence this warning.
```

#### Static request headers

Attach static headers to every upstream request with `upstream.headers` — for example an operator-provided API credential. Values support `${VAR}` interpolation, so secrets stay out of the file:

```yaml
upstream:
  url: 'https://api.example.com/mcp'
  transport: streamable-http
  headers:
    Authorization: 'Bearer ${UPSTREAM_TOKEN}'
```

Applies to the HTTP transports (`streamable-http`, `sse`); `stdio` has no request headers, so the field is ignored there. The reserved transport/protocol headers `mcp-session-id`, `mcp-protocol-version`, `content-type`, `content-length`, `host`, `accept`, `mcp-method`, and `mcp-name` are rejected — Helio owns those.

On a name conflict, static `upstream.headers` take precedence over caller-forwarded headers (`forward_headers`), matched case-insensitively. This is deliberate: a downstream caller cannot override an operator-provided credential such as `Authorization`.

#### Upstream MCP era detection

Before its first upstream request in `auto` mode — Helio's own internal traffic and relayed client traffic alike — Helio probes the upstream once with a `server/discover` call to learn which MCP revision it speaks. The conclusion is logged, one line per probe:

```
[helio] Upstream MCP era detected: modern (2026-07-28, via server/discover)
[helio] Upstream MCP era detected: legacy (initialize handshake)
```

- **modern** — the upstream answered `server/discover` and lists `2026-07-28` among its supported versions. That revision removed the handshake, so Helio holds no upstream session for its own internal traffic and sends no `Mcp-Session-Id` on it.
- **legacy** — the upstream answered the probe with an ordinary JSON-RPC error (an unimplemented method, say), an empty body, or anything else that is not a modern discovery result. Helio establishes its internal session the way it always has, with `initialize` followed by `notifications/initialized`, and reuses the session id the upstream mints.

The answer is cached per upstream connection — with named [`upstreams`](#upstreams), each entry probes and caches its own era independently — and shared by both kinds of traffic to that upstream; concurrent callers join a single in-flight probe, whichever path asks first, so classification normally costs one extra round trip per era conclusion, not per request. With `tool_revalidation` on (the default), startup priming normally settles the era before any relayed request arrives. Dropping the internal session — an upstream restart, or a `404` telling Helio its managed session expired — clears the cached era as well, so a second era line later in the log means Helio re-established the session and re-probed. An upstream upgraded in place is picked up that way, with no restart and no configuration change.

A probe that concludes nothing — a network error, a timeout, or a `401`/`403`/`5xx` reply — caches no era. On the internal path it surfaces as an ordinary upstream failure and the next attempt probes again; a relayed request instead proceeds under a per-request legacy presumption and is never failed by the probe, with re-probing throttled for 30 seconds so a relay burst cannot turn into a probe storm. This is deliberate: an auth-gated or briefly unavailable modern upstream must never be recorded as legacy, and a deployment whose probe can never succeed (per-client credentials, below) must keep working exactly as it does today.

A modern refusal is not legacy either. If the upstream rejects the probe with the modern error codes `-32020` (header mismatch) or `-32021` (missing client capability), it has identified itself as a modern server, so Helio does not fall back to `initialize` and caches no era. It reports the refusal — the error text carries the upstream's own message — and probes again on the next attempt, rather than quietly downgrading a server that is newer than the handshake. A `-32022` (unsupported protocol version) response instead identifies a modern upstream that simply does not speak Helio's modern revision, so Helio salvages the session with one legacy `initialize` attempt, reporting both sides' supported versions if that attempt also fails.

A dated `protocol_version` pin removes this machinery entirely: the pinned era is a constant — never probed, never cached, never cleared — and Helio logs the pin once at startup instead of a detection line:

```
[helio] Upstream MCP protocol version pinned: 2026-07-28 (upstream.protocol_version)
```

Deployments the probe cannot classify should pin. The common case is a modern-only upstream gated behind per-client `Authorization` pass-through: the probe carries only `upstream.headers` and is refused forever, while relayed requests carry each client's own credentials and succeed.

Relayed client traffic is version-tagged by the same era conclusion. Against a legacy upstream the relay leg is exactly what it always was: requests forward verbatim, `mcp-protocol-version: 2025-06-18` is stamped when the client didn't send one, and the wire `Mcp-Session-Id` relays in both directions. Against a modern upstream the relay leg takes the 2026-07-28 wire shape: every relayed POST is stamped `mcp-protocol-version: 2026-07-28` — including over a value a library caller preset, a preservation that survives only on the legacy leg — and carries the spec-required `_meta` mirror, merged per key: the protocol version is always Helio's, while a modern client's own `clientCapabilities` and `clientInfo` declarations pass through untouched and Helio's identity fills them in for legacy clients. Modern servers neither mint nor honor session ids, so the wire `Mcp-Session-Id` is never sent upstream, and a non-conformant upstream's `mcp-session-id` response header is stripped before the response reaches the client.

The `initialize` handshake is bridged rather than forwarded: a modern-only server answers the retired handshake with `404`/`-32601`, so Helio synthesizes the legacy InitializeResult locally — `protocolVersion: '2025-06-18'`, the upstream's own `capabilities` and `instructions` as captured from its `server/discover` answer (falling back to `capabilities: { tools: {} }` when nothing was captured, e.g. under a pin), and Helio's own `serverInfo` — and swallows the client's `notifications/initialized` confirmation, which the modern upstream no longer expects. The bridge keeps the downstream sessionless, as the legacy spec permits: no `mcp-session-id` response header is minted, so a legacy client that requires a server-minted session id cannot be bridged to a modern upstream.

A missing `Mcp-Method` or `Mcp-Name` is a guaranteed rejection from a 2026-07-28 upstream, so the legacy leg's silent omission fallbacks become explicit refusals on the modern leg: a method outside the visible-ASCII token set, a `params.name`/`params.uri` whose encoded value exceeds the 8 KB header cap, or array/primitive `params` (which cannot carry the required `_meta` mirror) are refused proxy-side with an error starting `helio refused to forward:` and naming the reason — strictly clearer than the opaque upstream rejection that forwarding would guarantee.

In `auto` mode, a cached era conclusion that the upstream itself contradicts is dropped rather than kept. Two doors notice: the internal `initialize` handshake failing against an upstream Helio had concluded was legacy, and a relayed response only a modern server could give — a modern-only JSON-RPC error code (`-32020`/`-32021`/`-32022`) on any method, or a `404`/`-32601` answer to a relayed `initialize`. Either way the cached era is cleared and re-probing is throttled for 30 seconds, with one log line naming which door falsified the conclusion:

```
[helio] Upstream MCP era cleared: internal initialize failed against the cached legacy era; relays presume legacy and re-probing is throttled for 30s
[helio] Upstream MCP era cleared: a relayed initialize was answered with HTTP 404; relays presume legacy and re-probing is throttled for 30s
```

Relays inside that window presume legacy without waiting; the first relay after it re-probes, so a wrong legacy conclusion heals within the window. A cached **modern** conclusion is never cleared automatically — legacy servers' rejections carry no reserved signal to falsify it with — so after an upstream downgrade or replacement with a legacy-only server, recovery is operator action: pin `protocol_version: '2025-06-18'` or restart the proxy.

Mixed-era fleets behind a single origin — a load-balanced upstream midway through a rolling upgrade — are unsupported in `auto` mode: each probe's answer depends on which instance takes it, so the cached era oscillates (throttled to roughly one re-probe per 30-second window). Pin `protocol_version` for the duration of the rollout.

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

### upstreams

Named multi-upstream mode: a non-empty list of upstream entries, each the
full singular `upstream` shape plus a required, unique `name`. In the
canonical section order, `upstreams` occupies the same slot as `upstream`
(after `version`, before `listen`) — a config carries one form or the other
in that position, never both. Declaring both fails validation:

```
  upstreams: Set exactly one of "upstream:" (single upstream) or "upstreams:" (named multi-upstream list) — not both. To migrate, move the upstream: fields into an upstreams: entry and give it a name.
```

as does declaring neither:

```
  (top level): Missing upstream configuration: set exactly one of "upstream:" (single upstream) or "upstreams:" (named multi-upstream list).
```

Each entry accepts every field of the [`upstream`](#upstream) section with
identical semantics, defaults, and validation — the entry schema reuses the
singular schema and its refinements verbatim — plus `name`:

| Field              | Type     | Required    | Default           | Description                                                                                                                                                                                                                                    |
| ------------------ | -------- | ----------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`             | string   | Yes         | —                 | Unique entry name; becomes the door path (`/mcp/<name>`, `/sse/<name>`) and the limiter/audit attribution key. Letters, digits, `_` and `-` only; 1–64 characters.                                                                             |
| `url`              | string   | Conditional | —                 | URL of this entry's upstream MCP server (e.g. `http://localhost:8080/mcp`). **Required** when `transport` is `streamable-http` or `sse` (the default is `streamable-http`); optional and ignored for `stdio`; a present value draws a warning. |
| `transport`        | string   | No          | `streamable-http` | Transport protocol: `streamable-http`, `sse`, or `stdio` — identical to [`upstream.transport`](#upstream).                                                                                                                                     |
| `protocol_version` | string   | No          | `auto`            | MCP revision spoken to this entry's upstream — identical to [`upstream.protocol_version`](#upstream). Each entry probes, pins, and caches its own era (see [era detection](#upstream-mcp-era-detection)).                                      |
| `command`          | string   | Conditional | —                 | Command to spawn the MCP server. **Required** when `transport` is `stdio`.                                                                                                                                                                     |
| `args`             | string[] | No          | —                 | Arguments passed to the `command` (stdio only).                                                                                                                                                                                                |
| `connect_timeout`  | duration | No          | `10s`             | Timeout for establishing SSE upstream connections.                                                                                                                                                                                             |
| `request_timeout`  | duration | No          | `30s`             | Timeout for upstream HTTP/SSE POST requests.                                                                                                                                                                                                   |
| `forward_headers`  | string[] | No          | `[]`              | Explicit allowlist of caller `x-*` headers to forward to this entry's upstream.                                                                                                                                                                |
| `headers`          | object   | No          | `{}`              | Static headers sent on every request to this entry's upstream — same `${VAR}` interpolation and reserved-header rejections as [`upstream.headers`](#static-request-headers).                                                                   |

> **Note:** As in the singular form, a stdio entry may omit `url`; a present value is accepted and ignored, and draws the same warning naming the entry's dotted path (`upstreams.0.url`).

Names may only contain letters, digits, `_` and `-` (1–64 characters), must
be unique within the list, and the list itself must be non-empty. The
charset is deliberate: names embed in mount paths (`/mcp/<name>`),
rate/spend limiter keys (`upstream:<name>:tool:<t>`), and audit records'
`upstream` column, so they must stay URL-literal and delimiter-free.

```yaml
version: '1'

upstreams:
  - name: files
    url: 'http://localhost:8081/mcp'
  - name: payments
    url: 'http://localhost:8082/mcp'
    request_timeout: '45s'
    headers:
      Authorization: 'Bearer ${UPSTREAM_TOKEN}'

dashboard:
  enabled: false
```

#### Per-name doors

Each named upstream is served at its own pair of mounts: `/mcp/<name>` for
MCP Streamable HTTP and `/sse/<name>` for the deprecated HTTP+SSE listener.
Tool sets are never merged — a client connects to exactly one door and sees
exactly that upstream's tools. In named mode the bare `/mcp` and `/sse`
paths answer nothing: a request to either, or to a name that is not
configured, is refused with HTTP `404` and an id-omitting JSON-RPC `-32600`
envelope naming the expected shape:

```
{"jsonrpc":"2.0","error":{"code":-32600,"message":"No MCP endpoint answers this request: this Helio serves named upstreams at /mcp/<name>."}}
```

The `/sse` variant of the envelope names `/sse/<name>`.

**Mount permanence.** Door paths derive from entry names, so renaming an
entry moves that upstream's public URL: every client pointed at the old
door breaks, and rate/spend limiter buckets and audit attribution re-key
under the new name going forward. Treat a name as a permanent public
contract — see
[Migrating to Named Upstreams](#migrating-to-named-upstreams) for the
operational consequences.

#### Per-upstream runtime

[Era detection](#upstream-mcp-era-detection),
[annotation cache priming](#startup-annotation-cache-priming), and drift
baselines all run per upstream connection — one instance per entry, the
singular machinery multiplied. Startup and detection log lines carry the
entry name:

```
[helio][files] Upstream MCP era detected: legacy (initialize handshake)
[helio][payments] Upstream MCP era detected: legacy (initialize handshake)
```

Because each entry runs its own upstream connection or child process plus
an annotation prime loop, configuring more than 16 upstreams draws a
warning — at `helio validate` and again at `helio start` — while the config
stays valid:

```
[helio] Warning: 17 upstreams configured. Each upstream runs its own upstream connection or child process plus an annotation prime loop; consider whether one proxy should govern this many.
```

### listen

Where the proxy listens for incoming MCP requests.

| Field             | Type     | Required | Default     | Description                                                      |
| ----------------- | -------- | -------- | ----------- | ---------------------------------------------------------------- |
| `port`            | integer  | No       | `3000`      | Port number (1–65535).                                           |
| `host`            | string   | No       | `127.0.0.1` | Hostname or IP to bind.                                          |
| `allowed_origins` | string[] | No       | `[]`        | Origins allowed to send an `Origin` header to `/mcp` and `/sse`. |

Any request to `/mcp` or `/sse` that carries an `Origin` header not listed in
`allowed_origins` is refused with `403` before it reaches the transport. The
default (an empty list) refuses every `Origin`: MCP clients are non-browser
processes and never send one, so this blocks browser-originated traffic
without affecting any normal client. Rejections are logged server-side.

This also covers DNS-rebinding pages on the message endpoints (`POST /mcp`
and `POST /sse?sessionId=…`). A rebound page keeps the attacker's own
hostname in its origin while that hostname resolves to the proxy, so the
browser treats the request as same-origin. A `POST` carries an `Origin`
regardless, and its value is still the attacker's hostname, so the request
is refused. Stream establishment on
the SSE listener is the residual: a browser omits `Origin` on a same-origin
`GET` (including from a rebound page) and on a no-cors `GET` such as an
`<img>` load, so neither can be gated here. In singular mode that listener
is `GET /sse`; with named [`upstreams`](#upstreams) it is `GET /sse/<name>`,
because a bare `GET /sse` matches no door and is refused with `404`,
minting nothing. The session such a `GET` mints is bounded either way: each
SSE route caps its concurrent sessions at 1024 and refuses new streams with
`503` past the cap, never dropping a live stream, so the residual is
bounded stream establishment rather than unbounded minting. The cap is per
door — every named route has its own session map — so total capacity is the
number of doors × 1024. A cross-origin
`EventSource` or cors-mode `fetch` does send `Origin` and is refused.
Closing the Origin-less path completely still needs `Host` validation,
tracked in issue #231.

Entries are matched exactly and must be serialized `http(s)` origins in
`URL.origin` form: lowercase host, no trailing slash, no path, and no default
port (`http://localhost:5173`, not `http://localhost:5173/`). Wildcards, the
literal `null`, and non-`http(s)` schemes (such as browser-extension origins)
are rejected at validation time. This is **not** CORS support — Helio emits no
CORS response headers, so a browser still cannot read responses or complete a
preflight even for an allowlisted origin. The setting exists for deployments
where something in front of Helio (a reverse proxy, service mesh, or embedding
host) injects an `Origin` the operator needs to name. Like the rest of
`listen`, changing it requires a restart; it is not applied by hot reload.

#### Inbound header/body agreement

`POST /mcp` validates the MCP 2026-07-28 standard request headers against the
JSON-RPC body (issue #226). The check has two tiers, selected by the
`MCP-Protocol-Version` header:

- **Modern claim** — the header value normalizes to exactly `2026-07-28`
  (duplicated all-modern values count; a mixed or malformed value does not).
  Requests must carry an `Mcp-Method` equal to the body's `method`, an
  `Mcp-Name` matching the body's `params.name` (`tools/call`, `prompts/get`)
  or `params.uri` (`resources/read`) when that field is a string, and a
  `params._meta["io.modelcontextprotocol/protocolVersion"]` mirror equal to
  `2026-07-28`. Notifications (no JSON-RPC `id` member) have no presence
  requirements — the revision leaves notification-POST headers undefined —
  but any marker they do carry must agree.
- **Everything else** (no claim, a legacy claim, or an unrecognized value) —
  nothing is required to be present, but a present `Mcp-Method` or `Mcp-Name`
  must still agree with the body. The `_meta` mirror is deliberately not
  examined on this tier: a modern client's leftover mirror under a legacy
  header is exactly what a version-downgrading relay (including Helio's own
  legacy relay leg) legitimately produces.

So two request classes are rejected that were accepted before: a request
claiming `MCP-Protocol-Version: 2026-07-28` without the required headers and
mirror, and a request whose present `Mcp-Method` or `Mcp-Name` disagrees with
the body even with no version claim at all. Fully conformant modern clients
and legacy clients (which send neither header) are unaffected. A rejection is
HTTP 400 with JSON-RPC error `-32020` for the whole class — including a
MISSING mirror on a modern-claim request, a stated deviation from the spec's
own `-32602` for a missing required `_meta` field (`-32602` predates the
revision, so `-32020` is the unambiguous dual-era signal). Notifications and
`id: null` envelopes receive an error body with the `id` member omitted.
Sentinel-encoded (`=?base64?…?=`) `Mcp-Name` values are decoded before
comparison. Every rejection is recorded in the
[audit trail](./audit.md#header-mismatch-rejections) under
`block_reason: header_mismatch`.

For library embeddings, `createApp` accepts an `onHeaderMismatch` callback
(`CreateAppOptions`, exported from `@gethelio/proxy`) invoked once per
rejected request with the rejection evidence (`HeaderMismatchRejection`);
`helio start` composes it with `buildHeaderMismatchAuditRecord` (also
exported) and the audit writer's `pushImmediate` to produce the record shape
documented in the audit reference. Pass your configured `environment` label
as the builder's second argument — omitting it records `environment: null`
on mismatch rows while your governed records carry the label. Without the
callback the request is still rejected; no record is written.

There is no configuration surface for this check — the spec assigns it as a
MUST to whoever processes the body, and a knob that turns it off would
silently disable a governance control. A client that hard-codes the modern
version claim but cannot send the standard headers should send a legacy
`MCP-Protocol-Version` value or a fully conformant modern request; Helio's
governance evaluates the parsed body either way. The `/sse` transport
predates the standard request headers and is not validated.

### environment

| Field         | Type   | Required | Default | Description                                                                                                                                                                            |
| ------------- | ------ | -------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `environment` | string | No       | —       | A label (e.g. `production`, `staging`) used in policy rule matching. Required whenever any rule uses `match.environment`. See [Policy Guide — Environment](./policies.md#environment). |

If a rule sets `match.environment` but top-level `environment` is missing, config validation fails (startup, `helio validate`, and hot-reload).

### session

Proxy-owned session identity: how Helio resolves the governance identity that keys `key: session` rate limits, spend limits, and budgets, scopes evidence (`evidence.requires`) and prerequisite (`requires`) rules, and attributes audit records. The proxy resolves identity itself from the inputs named here — it is never taken from tool arguments, which the model can rewrite.

In the canonical section order, `session` sits after `environment` and before `policies` because it is a request-path input that policy evaluation consumes: `upstream`, `listen`, and `environment` say where and as what Helio runs, `session` says who is calling, and `policies` and `budgets` then govern those calls.

| Field           | Type   | Required | Default                                               | Description                                                                                                                                       |
| --------------- | ------ | -------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `identity`      | array  | No       | `header` (`x-helio-session-id`), then `legacy_header` | Ordered identity sources; the first source that yields a value wins. Cannot be explicitly empty — omit the field to use the default chain.        |
| `on_unresolved` | string | No       | `deny`                                                | What happens when no source resolves and the request engages a session-dependent control: `deny` (fail closed) or `anonymous` (pre-0.12 pooling). |

**Identity sources:**

- **`header`** — reads a caller-set HTTP header on each request. `name` defaults to `x-helio-session-id`, is matched case-insensitively, must start with `x-`, and must not be a reserved transport header; each `header` entry needs its own name. This is the recommended source: the agent harness sets the header once per run, outside the model's reach.
- **`meta`** — derives identity from `_meta["io.modelcontextprotocol/clientInfo"]`, as `clientinfo:<name>@<version>`. This is agent identity, not session identity: two concurrent runs of the same client share the key, so it is not recommended for `key: session` limits or budgets.
- **`legacy_header`** — the verbatim `Mcp-Session-Id` transport header, kept for the MCP spec's deprecation window. Ids resolving through it key the same buckets as before this section existed, so persisted budget pots carry over untouched.

On `/sse`, when no configured source matches, the per-stream id Helio mints for the transport serves as an implicit final fallback — SSE requests never become unresolved. Candidate values that are empty after trimming or longer than 256 characters are skipped with a one-time warning and the chain continues.

`on_unresolved` is engagement-scoped, not a door check: a request is denied only when its evaluation actually engages a session-dependent control — a `key: session` rate/spend limit or budget, or a rule with `evidence.requires`/`requires` — while identity is unresolved. Requests governed only by `key: tool`/`global` controls pass through either way. Under `anonymous`, session-keyed limits and budgets pool into the shared literal `unknown` bucket with a one-time warning — exactly the pre-0.12 behavior — but evidence and dependency rules still deny without identity under **both** modes: a shared anonymous evidence session would let any caller satisfy any other caller's gates. Set `session.on_unresolved: anonymous` to restore pre-0.12 pooling for session-keyed limits.

Like `listen`, the `session` section is compiled into the transports at startup: changing it requires a restart (hot reload logs a restart-required warning and keeps the startup values). Re-scoping identity resolution live would silently move bucket attribution mid-flight.

### policies

Governance rules for tool calls. See [Policy Guide](./policies.md) for full documentation, including install-time rules (`policies.install` with `deny_install`) and the [adapter governance API](./adapter-api.md).

| Field               | Type    | Required | Default               | Description                                                                                                                                                                                                     |
| ------------------- | ------- | -------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `default`           | string  | No       | `allow`               | Action when no rule matches: `allow` or `deny`.                                                                                                                                                                 |
| `flag_destructive`  | string  | No       | —                     | Auto-flag unmatched destructive tools: `log` (audit flag only) or `require_approval` (escalate to approval).                                                                                                    |
| `on_tool_drift`     | string  | No       | `block`               | Response when a tool's definition changes after baseline: `block` (deny until restart), `require_approval` (escalate), or `log` (audit only). See [Tool definition drift](./policies.md#tool-definition-drift). |
| `tool_revalidation` | object  | No       | enabled-with-defaults | Proxy-scheduled `tools/list` revalidation and downward-only `ttlMs` clamping. Omit to use defaults (enabled, 5m interval, 5m max TTL). See below.                                                               |
| `dry_run`           | boolean | No       | `false`               | Enable global dry-run mode. No requests are forwarded to upstream.                                                                                                                                              |
| `hot_reload`        | boolean | No       | `true`                | Watch the config file for changes and reconcile policy live. Set to `false` to pin the policy (see below).                                                                                                      |
| `rules`             | array   | No       | `[]`                  | Ordered list of policy rules. First matching rule wins.                                                                                                                                                         |

`tool_revalidation` fields:

| Field                | Type     | Required | Default    | Description                                                                                                                                                                                               |
| -------------------- | -------- | -------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`            | boolean  | No       | `true`     | Enable proxy-initiated `tools/list` revalidation and `ttlMs` clamping. Set `false` to restore pre-0.12 behavior (no timer, no clamping).                                                                  |
| `interval`           | duration | No       | `5m`       | Cadence of proxy-initiated `tools/list` revalidation after the first successful annotation-cache prime. Minimum `10s`; lower values are rejected at config load.                                          |
| `max_advertised_ttl` | duration | No       | `interval` | Downward-only clamp applied to `result.ttlMs` on `tools/list` responses forwarded downstream: lowers a value above the cap, never raises one, and adds nothing when the upstream response has no `ttlMs`. |

```yaml
policies:
  on_tool_drift: block
  tool_revalidation:
    enabled: true
    interval: 5m
    max_advertised_ttl: 5m
```

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
      - match:
          tool: 'stripe_*' # picomatch glob, same engine as match.tool
          # upstreams: [payments] # named upstreams mode only (see below)
        field: '$.amount' # dot-path into the tool arguments
      - match:
          tool: 'paypal_*'
        field: '$.total'
```

| Field          | Type     | Required | Default  | Description                                                                                                                                                                                                                                          |
| -------------- | -------- | -------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`         | string   | Yes      | —        | Unique budget identity; preserves accrued spend across config edits. Charset: `[A-Za-z0-9_-]`, ≤64.                                                                                                                                                  |
| `limit`        | number   | Yes      | —        | Maximum cumulative spend within the window. Must be positive.                                                                                                                                                                                        |
| `currency`     | string   | Yes      | —        | Display/validation currency. Whether tools actually charge in it is the operator's assertion.                                                                                                                                                        |
| `window`       | string   | Yes      | —        | A [duration](#duration-strings) (sliding window) or `session` (never replenishes on a timer).                                                                                                                                                        |
| `key`          | string   | No       | `global` | Bucket scope: one shared pot (`global`), per session, or per adapter-supplied sender. A `sender_id` budget needs at least one contributor without an `upstreams` scope — see [Scoping contributors by upstream](#scoping-contributors-by-upstream).  |
| `on_exceed`    | string   | No       | `deny`   | What a breach does: `deny` blocks the call; `require_approval` raises one composite break-glass ticket per call. See [Budget break-glass tickets](./approvals.md#budget-break-glass-tickets).                                                        |
| `approval`     | object   | No       | —        | Break-glass ticket routing (`channel`, optional `timeout` / escalation fields — same shape as rule-level `approval`). Only valid with `on_exceed: require_approval`; omitted means the dashboard channel and the global `approval.timeout`.          |
| `idle_ttl`     | duration | No       | `24h`    | Session windows only: idle time before an inactive session pot is collected.                                                                                                                                                                         |
| `contributors` | list     | Yes      | —        | Non-empty. Which tools feed the budget and which argument field carries the amount (first match wins). In named mode a contributor can also scope to specific upstreams — see [Scoping contributors by upstream](#scoping-contributors-by-upstream). |

Validation: budget names must be unique; `window: session` requires `key: session` or `key: sender_id`; `idle_ttl` is only valid with `window: session`; `key: sender_id` requires `sdk.enabled: true` and at least one contributor without an `upstreams` scope (see [Scoping contributors by upstream](#scoping-contributors-by-upstream)); `approval` is only valid with `on_exceed: require_approval`, and its `channel`/`delegates` must reference configured approval channels. Any budget with `on_exceed: require_approval` requires `dashboard.api_secret`, exactly like a `require_approval` rule. A matched contributor whose amount field is missing, non-numeric, negative, or non-finite fails closed — the call is denied regardless of `on_exceed`.

Budget state lives in buckets keyed `budget:<name>:<scope>` — visible in audit records' `evidence_chain.budgets`. Budgets hot-reload by name identity: edits to `contributors`, including their `input` conditions, preserve accrued spend (they do not change what was already spent), while a change to `limit`, `currency`, `window`, or `key` resets the budget's buckets (a different pool or scope structure).

Budget spend **persists across restarts**: every charge is written to a ledger in the audit database (see [Budget Ledger Tables](./audit.md#budget-ledger-tables)) synchronously at record time, and startup replays it — duration windows resume mid-window exactly where they left off, and `session` pots whose last activity is within `idle_ttl` come back with their full accrued spend. The reset rules above extend across restarts: if the `limit`/`currency`/`window`/`key` tuple in the config differs from what the ledger last saw, the pot starts fresh instead of replaying, and a removal the proxy observes — live via hot-reload, or discovered at a startup without the budget — retires the accrued spend, so re-adding the budget later starts fresh even with an identical tuple. Ledger rows follow `audit.retention` on the audit store's sweep schedule; configuring a budget window (or session `idle_ttl`) longer than the retention draws a startup warning, because the sweep would forget in-window spend across restarts. Unlike budgets, rule-level rate/spend limit buckets remain in-memory and reset on restart.

#### Scoping contributors by argument values

A contributor's `match` block accepts the same `input` conditions as a rule's `match.input` (see [policies](./policies.md#input)): dot-paths into the tool arguments with `eq`/`neq`/`gt`/`gte`/`lt`/`lte`/`contains`/`regex` operators, AND-combined. A contributor participates when its `tool` glob matches **and** every input condition holds; contributor selection stays first-match-wins in config order over the combined predicate, so a category-scoped contributor can sit above a general fallback for the same tool:

```yaml
budgets:
  - name: content-distribution
    limit: 50
    currency: USD
    window: 7d
    on_exceed: require_approval
    contributors:
      - match:
          tool: 'stripe_create_payment'
          input:
            '$.category':
              eq: 'content_distribution'
        field: '$.amount'
      - match:
          tool: 'ads_*'
        field: '$.budget'
```

**Input scoping trusts the field.** A call whose `$.category` is absent or set to something else simply does not feed this budget — that is not a breach, not a denial, just non-participation. The cap is therefore only as trustworthy as the field's causal link to the spend (the same class of assertion as `currency`). Two compositions harden it:

- **Umbrella budget.** One call feeds every budget whose contributors match, so put a coarse total cap (bare `tool` glob, no input conditions) alongside the category pot. An unlabeled call escapes the category pot but still charges the total.
- **Category allow-list.** Rules decide before budgets deplete. `allow` rules matching the known category values above a `deny` on the bare tool force every call to declare a valid category. Constraining the field itself is the access-control layer's job; budgets stay a money gate.

#### Scoping contributors by upstream

With named [`upstreams`](#upstreams), a contributor's `match` block also accepts `upstreams` — the same exact-name list as a rule's [`match.upstreams`](./policies.md#upstreams), with the same validation: named mode only, every name configured, and a non-empty list. A scoped contributor participates only for MCP calls routed through a listed door:

```yaml
upstreams:
  - name: files
    url: 'http://localhost:8081/mcp'
  - name: payments
    url: 'http://localhost:8082/mcp'

budgets:
  - name: payments-cap
    limit: 100
    currency: USD
    window: 24h
    contributors:
      - match:
          tool: 'charge_*'
          upstreams: [payments]
        field: '$.amount'
```

Sideband (adapter) calls carry no upstream and never match a scoped contributor. That is why a sender-keyed budget cannot be fed exclusively by upstream-scoped contributors: sideband calls — the only ones with real senders — would never feed the budget, while every MCP charge would land in the shared `unknown` pot. Validation rejects the combination, co-firing with the pre-existing rule that `sender_id` keys require the SDK sideband when that is also missing:

```
  budgets.0.key: budget key "sender_id" requires the SDK sideband (sdk.enabled: true) — sender_id is supplied by hook adapters and is absent on the MCP path.
  budgets.0.key: budget key "sender_id" requires at least one contributor without an "upstreams" scope — upstream-scoped contributors only match MCP calls, which never carry a sender, so every charge would land in the shared "unknown" pot while sideband calls (the only ones with real senders) never feed this budget.
```

### approval

Configuration for human-in-the-loop approval workflows. See [Approval Workflows](./approvals.md) for full documentation.

In the canonical section order, `approval` follows `policies` and `budgets` because it is not a third gate: it is the shared channel and timeout configuration that policy rules (`require_approval`) and budget break-glass approvals both delegate to when they need a human. A strict lifecycle reading could argue for `approval` between `policies` and `budgets`, since on the MCP door a rule's approval resolves before the budget gate runs. That reading is rejected: the top-level `approval:` block is shared configuration, not the gate itself, and ordering the config around one door's implementation detail would separate the two enforcement layers a reader most needs to compare.

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
> `helio init` generates a dashboard secret by default, prints it once, and stores only its digest; `helio secret` prints a new secret and digest pair. Do not remove the field unless you intentionally want local open mode.
>
> A plaintext value in the file is accepted and draws a startup warning that names the file; a value supplied through `${VAR}` interpolation does not, whichever form it resolves to.

| Field                    | Type     | Required    | Default     | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------ | -------- | ----------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`                | boolean  | No          | `true`      | Enable the dashboard UI and sideband API server.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `port`                   | integer  | No          | `3100`      | Dashboard sideband API port (1–65535).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `host`                   | string   | No          | `127.0.0.1` | Dashboard sideband bind address.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `api_secret`             | string   | Conditional | —           | Dashboard secret, stored as either the secret itself or its SHA-256 digest in the form `sha256:<64 hex>` (`helio init` writes the digest; `helio secret` prints a secret and digest pair; a `${VAR}` placeholder may resolve to either form). Required when `dashboard.enabled: true` unless `dashboard.allow_open_mode: true`. Also required whenever any rule uses `action: require_approval`, any budget uses `on_exceed: require_approval`, or `policies.flag_destructive` or `policies.on_tool_drift` is set to `require_approval`. Browser operators enter the secret itself once on the dashboard login card to mint an HttpOnly session cookie; machine clients send `Authorization: Bearer <secret>`. A value that itself has the digest shape is treated as a digest. Quote the digest in YAML (`'sha256:...'`): a space after `sha256:` breaks the YAML and the file fails to parse. A plaintext value in the file is accepted and warned about at startup. |
| `allow_open_mode`        | boolean  | No          | `false`     | Explicit opt-in to run the dashboard sideband without `api_secret`. Only valid on loopback hosts and intended for trusted local development only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `sse_heartbeat_interval` | duration | No          | `30s`       | Interval between SSE keepalive messages.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

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

## Migrating to Named Upstreams

The singular `upstream:` form stays fully supported — migrate when one
proxy should govern more than one MCP server. The switch is a
restart-shaped edit (both upstream forms are startup-bound — see
[Reload boundary](#reload-boundary)), and it carries three
operator-visible discontinuities. Plan for all three before flipping the
config.

### The client URLs move

In named mode nothing is served at bare `/mcp` or `/sse`: every upstream
gets its own doors, `/mcp/<name>` and `/sse/<name>`, and every client must
be repointed at its upstream's door. A client left on the old URL gets
HTTP `404` with an id-omitting JSON-RPC `-32600` envelope:

```
{"jsonrpc":"2.0","error":{"code":-32600,"message":"No MCP endpoint answers this request: this Helio serves named upstreams at /mcp/<name>."}}
```

The `/sse` variant names `/sse/<name>`. Seeing this envelope in a client's
error log after a migration means that client is still pointed at the bare
path.

### The MCP tool buckets split

Rate and spend limits with `key: tool` (the default) track buckets keyed
`tool:<t>` in singular mode. In named mode, MCP traffic charges
`upstream:<name>:tool:<t>` instead — one bucket per (upstream, tool) —
while sideband (adapter) traffic keeps the unprefixed `tool:<t>` key and
session-keyed buckets are unchanged (see
[Rate Limits](./policies.md#rate-limits)). Two consequences land at the
switch:

- A tool-scope pot previously shared by MCP and sideband callers splits
  into per-door pots alongside the sideband pot.
- In-window MCP counters effectively start fresh: accrued counts live
  under the old unprefixed keys, and the first post-migration MCP call
  charges a new, empty `upstream:<name>:tool:<t>` bucket.

### Evidence gates reject the default identity chain

If any rule uses `evidence.requires` or `requires`, a named config must
set an explicit `session.identity` chain without `legacy_header`. The
default chain ends in `legacy_header`, so a config that omits `session:`
entirely fails validation the moment named upstreams and evidence-gated
rules coexist — by design:

```
  session.identity.1: session.identity includes "legacy_header" while named upstreams and evidence-gated rules ("evidence"/"requires") are configured. On the legacy relay flow the Mcp-Session-Id a client echoes was minted by the upstream itself, so with multiple upstreams a hostile server could collide session identities across doors and pollute another door's evidence gates. Remove legacy_header from session.identity and use a caller-owned source such as the default "x-helio-session-id" header.
```

The remedy is in the message — declare the chain explicitly with a
caller-owned source:

```yaml
session:
  identity:
    - source: header
      name: x-helio-session-id
```

### The mechanical steps

The move itself is field-preserving: wrap the existing `upstream:` fields
in a single-entry list, give the entry a `name`, and repoint clients.
Leaving both forms in the file fails validation with the XOR message
quoted under [upstreams](#upstreams). Before:

```yaml
version: '1'

upstream:
  url: 'http://localhost:8080/mcp'
  request_timeout: '45s'

dashboard:
  enabled: false
```

After — the same fields, moved verbatim into a named entry:

```yaml
version: '1'

upstreams:
  - name: files
    url: 'http://localhost:8080/mcp'
    request_timeout: '45s'

dashboard:
  enabled: false
```

Both configs validate as-is with `helio validate`.

### A rename is a breaking change

Door paths derive from names (see
[Per-name doors](#per-name-doors)), so renaming an entry later repeats the
first two discontinuities for that upstream: its clients' URLs break, and
its limiter buckets and audit attribution re-key under the new name going
forward. Choose names as permanent public identifiers, not display labels.

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
Config is valid: helio.yaml (3 policy rules, 0 budgets)
```

On failure, Helio reports the exact path and error:

```
Invalid config: Invalid configuration (1 error)
  upstream.url: "url" is required when transport is "streamable-http"
```

The whole file is strict, at every level: an unknown or misplaced key — a `rules:` block at the top level instead of nested under `policies:`, a singular `policy:` or `budget:` typo, a misspelled field inside a section like `upstream.request_timout` or `dashboard.api_secrett`, or an unknown key inside an approval channel entry — is a hard error naming the key and its path, not a silently ignored no-op. `helio start` refuses to boot on such a config, and a hot reload that introduces one is rejected while the proxy keeps its current configuration (see [Hot Reload](#hot-reload)).

```
Invalid config: Invalid configuration (1 error)
  (top level): Unrecognized key: "rules"
```

```
Invalid config: Invalid configuration (1 error)
  upstream: Unrecognized key: "request_timout"
```

The one exception is top-level keys beginning with lowercase `x-`. They are reserved as extension keys — holders for reusable YAML anchors, in the docker-compose style — and are ignored by the schema:

```yaml
x-defaults: &deny-defaults
  action: deny

policies:
  rules:
    - <<: *deny-defaults
      name: block-delete
      match:
        tool: 'delete_*'
    - <<: *deny-defaults
      name: block-drop
      match:
        tool: 'drop_*'
```

`${VAR}` references inside an `x-` block are interpolated like everywhere else, so the variables must be set even though the block itself is ignored. The escape hatch is root-only: an `x-` key inside a section (`approval.x-shared:`, say) is rejected like any other unknown key — park anchor holders at the top level.

## Hot Reload

Helio watches your configuration file for changes and automatically reloads policy rules without restarting the proxy. The file watcher uses a 200ms debounce to batch rapid saves. At startup, the `Watching <config> for policy changes` line prints once the watcher is armed (the initial file scan is complete), not merely when watching was requested, so a script that waits for that line before editing the config can trust the edit to be observed.

On successful reload:

```
[helio] Budgets reloaded: 0 budgets
[helio] Policy reloaded: 5 rules (default: allow)
```

The budgets line always prints first, with the count from the reloaded file (`0 budgets` when no `budgets:` section is configured).

If the new configuration is invalid — or its budget epoch changes cannot be durably recorded — Helio rejects the reload as a whole, keeps the complete current configuration (policy rules and budgets alike), and logs the error:

```
[helio] Config reload failed (keeping current configuration): YAML parse error in helio.yaml: ...
```

Schema errors also print the offending paths, one per line:

```
[helio] Config reload failed (keeping current configuration): Invalid configuration (1 error)
[helio]   (top level): Unrecognized key: "rules"
```

### Limit reconciliation

Rate and spend limit buckets survive a hot-reload as long as their owning rule's config is unchanged. A benign rewrite of `helio.yaml` (for example, `vim :w` with no real edits, or adding a comment) preserves live counters and elapsed-window progress — operators don't zero their buckets mid-window. Reconciliation compares each bucket's config tuple (rate uses `max_calls` plus `window`; spend uses `limit`, `currency`, and `window`) at the bucket's own rule index. A bucket survives as long as the rule at its index still carries the same tuple after the reload, and is evicted (then lazily re-created on the next request) when the tuple at that index changed or the rule is gone.

Rate and spend bucket keys carry a `:rule:<index>` suffix (for example `session:abc:rule:2`), so two rules of the same kind that share a scope — say, two session-keyed `rate_limit` rules — track their calls in separate buckets instead of silently sharing one with last-write-wins config. The suffixed keys are what you see in `GET /api/limits`, `limit_warning` events, and denial messages. Because reconciliation matches the tuple at the bucket's own rule index, an edit that shifts a rule's position (inserting or removing a rule above it, or reordering) evicts its bucket and the rule starts a fresh window — accrued counts and spend do not follow a rule to its new position. Two caveats: swapping two same-kind rules with identical limit tuples keeps each bucket at its position, so the rules exchange accrued state; and a call whose counter commit is deferred — a sideband call between `/evaluate` and `/audit`, or an MCP call held by a budget break-glass approval — records into the key and config frozen at evaluation/peek time, which a reload during the wait may have just evicted. (On the sideband the frozen key lives on the stored pending plan until `/audit`, evaluation-TTL expiry, or proxy shutdown; on the MCP door it lives in the in-flight request only.)

> **Note:** Rule-level limit state is reconciled, not persisted — restarting the proxy clears rate/spend rule buckets. Budgets are different: their spend persists across restarts via the budget ledger (see [budgets](#budgets)).

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

The other reason to disable it is the process and filesystem boundary: while hot reload is on, any process that can write this file changes policy on the running proxy, and the proxy does not check who wrote it. Disabling hot reload moves the change to the next restart, which closes nothing for a process that can also restart the proxy. See [SECURITY.md](../SECURITY.md#process-and-filesystem-boundaries) for the deployments that close it.

### Reload boundary

Compiled policy behavior and budgets are hot-reloadable. Startup-bound sections still require restart.

| Config path                    | Reloads on save? | Notes                                                                                                                                  |
| ------------------------------ | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `policies.rules`               | Yes              | Recompiled and swapped atomically.                                                                                                     |
| `budgets`                      | Yes              | Reconciled by name identity — see [budgets](#budgets) for what survives an edit.                                                       |
| `policies.default`             | Yes              | Takes effect immediately on the next request.                                                                                          |
| `policies.flag_destructive`    | Yes              | Takes effect immediately on the next request.                                                                                          |
| `policies.on_tool_drift`       | Yes              | Takes effect immediately on the next request.                                                                                          |
| `policies.tool_revalidation.*` | Yes              | Takes effect on the next tick: the timer is retimed, started, or stopped live, and the `ttlMs` clamp applies to the next `tools/list`. |
| `policies.dry_run`             | Yes              | Takes effect immediately on the next request.                                                                                          |
| `policies.install`             | Yes              | Recompiled with the rules; applies to the next `/install-scan` on the SDK sideband.                                                    |
| `policies.hot_reload`          | No               | Controls watcher startup behavior; changing it on a running process requires restart.                                                  |
| `environment`                  | No               | Runtime deployment identity for matching/audit attribution; changing it requires restart.                                              |
| `session.*`                    | No               | Identity resolution is compiled into the transports at startup; changing it requires restart.                                          |
| `upstream.*`                   | No               | Upstream transport/client initialized at startup.                                                                                      |
| `upstreams.*`                  | No               | Per-entry upstream transports/clients and door mounts initialized at startup; any edit to the named list logs the warning below.       |
| `listen.*`                     | No               | Proxy listener socket bound at startup.                                                                                                |
| `dashboard.*`                  | No               | Dashboard server/session settings initialized at startup.                                                                              |
| `approval.*`                   | No               | Router/channels/timeouts initialized at startup.                                                                                       |
| `audit.*`                      | No               | SQLite store path/settings initialized at startup.                                                                                     |
| `sdk.*`                        | No               | Sideband listener/token behavior initialized at startup.                                                                               |

When non-reloadable fields change on save, Helio logs an explicit restart-required warning and keeps using startup values for those fields:

```
[helio] Restart required: non-reloadable fields changed (upstreams). The running process still uses startup values for these fields.
```

A mode switch between `upstream:` and `upstreams:` reports both labels in that warning (`upstream, upstreams`) — the edit removes one section and adds the other, and naming only one would misreport half the change.

The reloadable and startup-bound halves cannot contradict each other: a reload whose policies or budgets reference approval routing that only exists in the NEW file — a channel added to `approval.channels` in the same edit, or dashboard-routed break-glass while the running process has no dashboard server — is rejected as a whole (`Config reload failed (keeping current configuration)`), because the running approval registry is startup-bound and the referenced channel could never notify or resolve a ticket. Apply such changes with a restart. The reverse holds at startup: a config whose rules, budgets, or `require_approval` escalations route approvals to the dashboard while `dashboard.enabled` is false is rejected by `helio validate` and `helio start` — it can no longer boot into a state every reload would reject.
