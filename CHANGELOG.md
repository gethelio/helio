# Changelog

All notable changes to Helio are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and Helio follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). The
proxy (`@gethelio/proxy`), Python SDK (`helio-client` on PyPI), and Docker image
(`ghcr.io/gethelio/helio`) are released together under a single version — the git tag.
The dashboard workspace package (`@gethelio/dashboard`) is bundled into the proxy and
not published separately.

Maintainer notes:

- Keep all not-yet-released changes under `Unreleased`.
- When cutting `vX.Y.Z`, move the relevant entries into a new
  `## [X.Y.Z] - YYYY-MM-DD` section and reset `Unreleased`.
- Keep entries user-visible and operator-relevant (new behavior, defaults,
  security posture, and breaking changes).

## [Unreleased]

### Breaking changes

- **BREAKING: `upstream.headers` may no longer set `Accept` (#304).**
  The value joins the reserved transport headers Helio owns on the
  wire: on the HTTP upstream legs it advertises Helio's own response
  parsing, so an operator-set value could only misadvertise it, never
  extend it. Such an override can break the SSE connect outright
  (HTTP 406 from a config that validated cleanly) and can make the
  era probe's reply unparseable or non-classifiable, driving a
  wrong-era legacy handshake attempt against a modern upstream. A
  config that sets it now fails validation at startup with the
  existing reserved-header message; the migration is deleting the
  line.

### Fixed

- The Streamable HTTP forwarder no longer forwards a caller-supplied
  `mcp-session-id` on its request sends. Merge residue from caller
  headers and constructor static headers alike is now cleared on every
  send, relayed and internal, before the wire value is stamped, so the
  id those sends carry comes only from the transport relay field
  (relayed traffic) or the session id the upstream minted for Helio's
  managed session (internal traffic). No network path could plant the
  header; the gap was reachable only through direct library use of the
  forwarder.
- Both HTTP upstream forwarders now keep the `Content-Type` on their
  sends truthful: the Streamable HTTP forwarder on its request sends
  and the SSE forwarder on the message POSTs re-stamp
  `application/json` after the header merge, so a caller-supplied or
  constructor-static value can no longer mislabel the JSON body Helio
  itself serialized. A caller-supplied `Content-Length` is dropped on
  the same sends so the computed wire length is truthful (previously
  such a request never transmitted and stalled until the request
  timeout). No network path could plant either header; the gap was
  reachable only through direct library use of the forwarders.
- Two `rate_limit` rules sharing a key scope (for example, two
  session-keyed rules) no longer pool their calls into one bucket with
  last-write-wins config: rate bucket keys now carry a `:rule:<index>`
  suffix naming the owning rule, exactly as spend bucket keys have since
  0.10.0. The suffixed keys are what `GET /api/limits`, `limit_warning`
  events, and rate-limit deny messages now show. Rate state is
  in-memory, so the relabel is automatic on upgrade — the restart
  starts fresh buckets under the new keys. Operator note: a sender that
  exercises several sender-keyed rate rules now occupies one slot in
  the 50,000-key sender registry per exercised rule bucket rather than
  one slot total.
- A caller-supplied or constructor-static `Accept` no longer reaches
  the wire on any HTTP upstream leg. The Streamable HTTP request
  sends, the era probe, and the legacy
  `initialize`/`notifications/initialized` POSTs re-stamp
  `application/json, text/event-stream` (the two response framings
  Helio parses), the SSE connect GET re-stamps `text/event-stream`,
  and the SSE message POSTs drop the supplied value — Helio asserts
  no `Accept` there, and the runtime's own default (`*/*`) remains on
  the wire. This covers the constructor and caller vectors reachable
  through direct library use; yaml config is rejected at validation
  per the breaking entry above.

## [0.12.0] - 2026-08-17

### Breaking changes

- **BREAKING: unresolved session identity now fails closed (#218).**
  Under the default `session.on_unresolved: deny`, a request that
  engages a session-keyed rate limit, spend limit, or budget — or an
  evidence/dependency rule — without resolvable identity is denied
  with the new `block_reason: session_unresolved` (evidence rules keep
  `policy_denied`) instead of silently pooling into a shared `unknown`
  bucket. Requests governed only by `key: tool`/`global` controls are
  unaffected, and dry-run reports a named `session_unresolved: true`
  marker instead of denying. One-line restore of the pre-0.12 pooling:
  `session.on_unresolved: anonymous` (evidence/dependency rules still
  require identity under both modes). The same policy applies to the
  adapter sideband's `session_id`. Bucket continuity is preserved for
  well-formed ids (non-empty after trimming, at most 256 chars): legacy
  ids key the same buckets byte-for-byte, so persisted budget pots
  carry over, while over-long, empty, or whitespace-only ids — which
  previously keyed buckets literally — now resolve as unresolved. The
  evidence/dependency deny message changed to name the configured
  identity strategies, and the SDK sideband's evidence and context
  writes reject whitespace-only session ids with 400 (such a write
  could never be read back).
- **BREAKING: pre-0.12 local audit databases fail fast at startup
  (#218).** The audit schema gains a `session_source` column through
  the documented pre-1.0 clean-break mechanism: Helio refuses to start
  on an old local DB and prints the delete-these-files instructions.
- **BREAKING: TypeScript API changes for direct embedders (#218).**
  `McpRequest.sessionId` splits into `session` (the proxy-resolved
  identity with its source) and `transportSessionId` (the verbatim
  wire `Mcp-Session-Id`, relayed upstream unchanged — a proxy-resolved
  id is never sent upstream, which session-enforcing upstreams would
  reject). `BudgetEngine.peekAll`/`recordAll` now accept only
  gate-branded charges obtained via `gateBudgetCharges`; runtime
  behavior is unchanged. On `/sse`, the minted stream id is no longer
  sent upstream as `Mcp-Session-Id`, and an explicit identity header
  on the POST leg now overrides the stream identity.
- **BREAKING: the supported Node.js floor is now 24 (#241).** The
  `engines` field moves from `>=22` to `>=24` across the workspace.
  Installs on Node 22 or older now surface an engine mismatch: npm and
  pnpm print an unsupported-engine warning and continue, while Yarn
  and `engine-strict` setups refuse outright. Either way, Node 22 is
  no longer tested or supported. Node 22 entered Maintenance LTS in
  October 2025 and receives security fixes only; Node 24 has been
  Active LTS since the same month. The toolchain moves with the floor:
  CI, the Docker image (now built on `node:24-slim`), and the build
  target all run Node 24, so the supported floor is the tested floor.
  Upgrade the host runtime to Node 24 before taking this release; no
  configuration or API changes are required.
- **BREAKING: `upstream.headers` may no longer set `Mcp-Method` or
  `Mcp-Name` (#216).** Both join the reserved transport headers Helio
  owns on the wire for every Streamable HTTP request it sends —
  internal and relayed alike. Static `upstream.headers` take precedence
  over Helio's own headers, so an operator-set value would have
  silently corrupted that traffic and drawn a guaranteed `-32020` from
  a strict server. A config that sets either now fails validation at
  startup with the existing reserved-header message.

### Added

- **Proxy-owned session identity (#218, closes #214/#215).** A new
  top-level `session:` config section declares how Helio resolves the
  governance identity that keys `key: session` limits and budgets,
  scopes evidence/dependency rules, and attributes audit records. The
  default chain reads the new `x-helio-session-id` caller header, then
  the legacy `Mcp-Session-Id` (kept for the MCP spec's deprecation
  window); an optional `meta` source derives an agent-level id from the
  `io.modelcontextprotocol/clientInfo` `_meta` claim, and on `/sse` the
  minted per-stream id remains an implicit final fallback. The section
  is optional — an absent `session:` validates and uses the defaults —
  and is restart-required at the hot-reload boundary. Audit records,
  the CSV export (appended), and the dashboard's new Session detail
  section carry `session_source`, the strategy that produced each
  record's id.
- **Proxy-scheduled tool definition revalidation (#221).** A new
  `policies.tool_revalidation` config section (`enabled` default
  `true`, `interval` default `5m`, 10s floor) runs Helio's own
  `tools/list` against the upstream on that cadence once the first
  annotation-cache prime succeeds, so a definition change is still
  caught even when no client re-issues `tools/list` and the upstream
  advertises a long cache lifetime. The same section clamps a
  forwarded `tools/list` response's numeric `ttlMs` down to
  `max_advertised_ttl` (default: `interval`) before it reaches the
  caller — a value at or below the cap passes through untouched, and a
  response carrying no `ttlMs` never gains one. `tool_revalidation`
  reconfigures live on hot reload: enabling, disabling, or retiming
  the cadence takes effect on the next tick without a restart.
- **MCP protocol version negotiation for relayed traffic (#219).** The
  relay leg now speaks the upstream's detected MCP era instead of
  always the legacy revision. Against a modern (`2026-07-28`) upstream,
  relayed requests carry the modern version header and the
  spec-required `_meta` mirror (a modern client's own
  `clientCapabilities`/`clientInfo` declarations pass through), the
  wire `Mcp-Session-Id` is never sent upstream, and the retired
  `initialize` handshake is bridged: Helio synthesizes the legacy
  result locally from the upstream's own `server/discover` answer and
  swallows the confirmation notification, so legacy clients keep
  working unchanged — sessionless, as the legacy spec permits. Against
  a legacy upstream the relay leg is byte-for-byte what it was. A new
  `upstream.protocol_version` setting (`auto` | `2025-06-18` |
  `2026-07-28`, default `auto`) pins the era for deployments the probe
  cannot classify, such as a modern-only upstream gated behind
  per-client credentials. The audit trail gains a nullable
  `protocol_version` column recording each inbound request's verbatim
  `MCP-Protocol-Version` claim — appended to the CSV export as the new
  trailing column, and covered by the same pre-0.12 clean break as
  `session_source`: Helio refuses to start on a local audit DB missing
  it and prints the delete-these-files instructions.

### Changed

- **Default posture:** the proxy now issues its own `tools/list` to
  the upstream every 5 minutes and clamps a forwarded `tools/list`
  response's numeric `ttlMs` down to `max_advertised_ttl` by default.
  Restore the pre-0.12 behavior — no proxy-initiated revalidation, no
  clamping — with `policies.tool_revalidation.enabled: false`.

### Fixed

- **Annotation priming and drift baselining now work against
  `2026-07-28`-only upstreams (#216).** Before its first internal
  request, Helio probes the upstream once with `server/discover` to
  learn which MCP revision it speaks. Previously, Helio's internal
  path spoke only the pre-`2026-07-28` `initialize` handshake: against
  an upstream that had already dropped it, the spec-mandated `404` +
  `-32601` was indistinguishable from a dead server, so the annotation
  cache never primed and the drift baseline was never established —
  every tool call then evaluated against the built-in annotation
  defaults (`destructiveHint: true`), so deny rules matched every tool
  and read-only allow rules matched none. The era is cached per
  upstream and re-probed after a session drop, so an in-place upstream
  upgrade is picked up with no restart. This closed the internal path
  first; relay version negotiation (#219, under Added) extends the
  same era conclusion to relayed client traffic in this release.
- **Upstream forwards of relayed client traffic now carry the spec's
  standard request headers (#217).** Every Streamable HTTP POST Helio
  sends upstream carries `Mcp-Method` mirroring the JSON-RPC method,
  aside from Helio's own legacy `initialize`/`notifications/initialized`
  handshake (performed against a legacy upstream and deliberately left
  unstamped), and `tools/call`, `prompts/get`, and `resources/read`
  requests also carry `Mcp-Name`, sentinel-encoded when the value needs
  it. Both header values are always derived from the request body Helio
  actually forwards, never from caller-supplied headers. `Mcp-Name` is
  omitted above an 8 KB best-effort cap, and `Mcp-Method` is omitted for
  method strings that cannot travel safely as a header value, rather
  than send a value that no longer matches the body. This restores
  truthful header routing for gateways and observability tooling sitting
  between Helio and the upstream. With relay version negotiation (#219,
  under Added), relays against a modern upstream carry the modern
  protocol version too, and on that leg the two omission fallbacks
  become proxy-side refusals with a clear error — against a `2026-07-28`
  upstream a missing header is a guaranteed rejection, no longer a
  harmless fallback.
- **Transport ingress rejections no longer emit `id: null` (#234).**
  Pre-parse rejections on `/mcp` and `/sse` — wrong `Content-Type`,
  malformed JSON, and a missing or unknown SSE session — and
  envelope-invalid bodies with no usable request id now omit the
  JSON-RPC `id` member entirely, matching the shape the Origin guard
  and the header/body agreement door already emit. An invalid envelope
  that does carry a usable `string` or `number` id still has it echoed.
  No MCP revision ever permitted a null id; the `2026-07-28` error
  shape sanctions omission as the no-id form, so validators built on it
  now accept these 4xx bodies. HTTP statuses, error codes, and messages
  are unchanged.
- **The synthesized dry-run result now carries `resultType` (#227).**
  MCP `2026-07-28` requires every result to declare a `resultType`,
  and the dry-run response is the one result Helio manufactures
  without an upstream round-trip. When the client's validated
  `MCP-Protocol-Version` claim is `2026-07-28`, that result now
  carries `resultType: "complete"`. Clients on `2025-06-18`, and
  clients on transports that predate the header (SSE, stdio), receive
  the same result without the field, byte-for-byte as before.
- **The deprecated SSE upstream forwarder no longer forwards
  caller-supplied `mcp-method`/`mcp-name` headers (#264).** The message
  POST sends neither header (both postdate the transport), and a
  caller-supplied `mcp-session-id` never reaches the wire — that header
  is sent only from the transport relay field. No network path could
  plant these headers; the gap was reachable only through direct
  library use of the forwarder.

### Security

- **The legacy `/sse` transport now caps concurrent sessions (#232).**
  A `GET /sse` past the fixed global cap (1024 concurrent sessions) is
  refused with HTTP `503` and a plain JSON body and mints nothing, so
  an Origin-less `GET` flood (the residual the `Origin` guard cannot
  gate) can no longer grow the session map without bound. The cap
  refuses new streams only and never drops an established stream;
  slots free when a client disconnects or an idle session is swept.
  Refusal logging is time-bounded to one line per window regardless of
  flood rate. There is no configuration surface: no realistic
  single-proxy legacy deployment runs more than 1024 concurrent SSE
  streams, and a knob that raises or disables the cap would silently
  disable a governance control.
- **The streamable-http inbound door now enforces MCP 2026-07-28
  header/body agreement (#226).** A `POST /mcp` whose standard request
  headers disagree with the JSON-RPC body is refused with HTTP 400 and
  JSON-RPC `-32020` before any policy evaluation, and every rejection
  is written to the audit trail as `policy_decision: rejected` with
  `block_reason: header_mismatch`, preserving the lying header values
  verbatim. Two request classes that Helio previously accepted are
  rejected after upgrading: (1) a request claiming
  `MCP-Protocol-Version: 2026-07-28` WITHOUT the required `Mcp-Method`
  header and `params._meta` protocol-version mirror — the bare-claim
  shape Helio itself accepted and forwarded until now; a client in this
  class should send a legacy `MCP-Protocol-Version` value or a fully
  conformant modern request, since Helio's governance reads the body
  either way; and (2) a request carrying an `Mcp-Method` or `Mcp-Name`
  header that DISAGREES with the body — rejected even with no version
  claim at all, so a client, test rig, or intermediary that already
  stamps those headers wrongly breaks regardless of version. Fully
  conformant modern clients and legacy clients (which send neither
  header) are unaffected, as are chained Helio deployments: the
  `_meta` mirror is examined only under a modern version claim, so the
  legacy relay leg's stamp-over-verbatim-body shape passes untouched.
  There is no configuration surface — the spec assigns the check as a
  MUST to whoever processes the body, and a knob that turns it off
  would silently disable a governance control.
- **The MCP transports now validate the `Origin` header (#213).** Any
  request to `/mcp` or `/sse` carrying an `Origin` not listed in the new
  `listen.allowed_origins` setting is refused with `403` and a JSON-RPC
  error before it reaches the transport. The default is an empty list,
  which refuses every `Origin`: MCP clients are non-browser processes
  and never send one, so no shipped client, adapter, or workflow is
  affected. The Streamable HTTP specification makes this validation a
  MUST, and it closes the DNS-rebinding path on both transports' message
  endpoints — a rebound page keeps the attacker's own hostname in its
  origin while that name resolves to the proxy, so the browser sees a
  same-origin request, but its POSTs carry an `Origin` regardless and
  its value still names the attacker. Stream establishment on `GET /sse`
  stays uncovered where the browser sends no `Origin` at all, which is
  the same-origin and no-cors cases; a cross-origin `EventSource` or
  cors-mode `fetch` does send one and is refused.
  This is defense-in-depth alongside the `Content-Type` essence check
  shipped in 0.11.1. Rejections are logged server-side, deduplicated and
  capped so a rotating attacker-chosen origin cannot flood the log.
  Allowlist entries must be exact serialized `http(s)` origins
  (validated at startup, with typos like a trailing slash rejected and
  the intended form suggested); the list is not CORS support — Helio
  emits no CORS response headers — and exists for deployments where a
  fronting proxy or embedding host injects an `Origin` the operator
  needs to name. Changing it requires a restart, like the rest of
  `listen`.

## [0.11.1] - 2026-08-03

### Security

- **The MCP transports now match the `Content-Type` essence rather than
  searching the header for a substring (GHSA-qm2p-4gh2-q6pm).** `/mcp` and
  `/sse` required `application/json` by testing whether the raw header
  contained that string, so a value such as
  `text/plain;x=application/json` satisfied the check. Media types in that
  family are CORS-safelisted, meaning a browser sends them cross-site with
  no preflight and no cooperation from the proxy, so a web page an operator
  visited could reach the MCP endpoint and invoke any tool their policy
  permitted. Policy evaluation was never bypassed: deny rules, budgets, and
  approvals applied to these calls exactly as to any other, and the
  responses were not readable cross-origin. Both transports now compare the
  media type essence (the part before `;`, case insensitively, per RFC
  9110), which also makes an uppercase `APPLICATION/JSON` acceptable as the
  RFC requires. Clients sending a correct `Content-Type` are unaffected;
  any client relying on a non-JSON media type now receives the 415 it
  should always have received. All releases through 0.11.0 are affected;
  upgrading is recommended.

## [0.11.0] - 2026-07-27

### Added

- **CSV export for the budget spend ledger (#155).** One budget's spend
  history is now exportable everywhere the audit trail is:
  `GET /api/budgets/:name/events/export?format=csv|json` downloads the
  ledger as an attachment (`helio-budget-<name>-events.csv`), the
  dashboard's Budgets view gains per-pot CSV/JSON export buttons, and
  `helio export --budgets <name>` produces the same artifact offline from
  the database file — with the proxy stopped or the dashboard disabled.
  Exports are capped at 10,000 rows and run newest-first (the listing's
  own order: with no time filters, a capped export keeps the most recent
  spend reachable), span config resets like the listing, and carry the
  listing's wire columns verbatim with the audit exporter's CSV escaping
  and formula-injection defense. Direct embedders of the dashboard app:
  the `budgets` dependency gains a required `listEventsForExport` method.

### Changed

- **BREAKING: budget contributors are now `{ match: { tool, input? }, field }`
  (#177).** The 0.10.0 flat shape `{ tool, field }` fails validation with a
  migration message. Everything under `match:` decides participation —
  `tool` (unchanged glob) plus optional `input` conditions with the same
  operators as rule `match.input`, so one tool's spend can be split into
  category pots ("$50/week on content distribution"). A call that matches
  the glob but not the conditions does not feed the budget; see the
  configuration guide for the trust caveat and hardening patterns.
  Migration: a contributor whose `tool` key sat beside `field` now nests that
  `tool` key inside a `match` block, with `field` left where it is.
  Contributor edits, including input conditions, still preserve accrued spend
  on hot reload.
- **Unknown top-level keys in `helio.yaml` are now hard errors (#167).** The
  top level of the config silently dropped unknown keys: a misplaced or
  misspelled section — `rules:` at the top level, `policy:`, `budget:` — was
  discarded without a word, so the proxy started healthy while enforcing none
  of it. A typo'd `budgets:` key silently disabled spend enforcement; that
  fail-open is what this closes. Now `helio validate` fails with an error
  naming the key, `helio start` refuses to boot, and a hot reload that
  introduces such a key is rejected while the proxy keeps its current
  configuration. If your proxy refuses to start after upgrading, read the
  error: fix the named key's spelling or nesting (`rules:` belongs under
  `policies:`), or delete it. Top-level keys beginning with `x-` remain
  available as holders for YAML anchors. `helio validate` now also reports
  the budgets count alongside the policy rule count, and config failures on
  every CLI surface (start, validate, export, hot reload) name the offending
  paths on schema errors.
- **Unknown keys inside `helio.yaml` sections are now hard errors
  (#182).** #167 made the top level strict; the nine section schemas it
  left lenient (`upstream`, `listen`, `dashboard`, the approval channel
  entries, `approval`, `audit`, `sdk`) still dropped unknown keys
  silently and applied defaults in their place: `upstream.request_timout`
  silently kept the 30-second default, a typo'd `approval.channel:`
  silently dropped every approval channel, a webhook channel with a
  misspelled `secret:` silently shipped unsigned, and
  `dashboard.api_secrett` with `allow_open_mode: true` silently ran the
  dashboard open. Now every section rejects unknown keys with an error
  naming the key and its path (`upstream: Unrecognized key: "request_timout"`)
  on every CLI surface — validate, start, export, and
  hot reload (which keeps the running configuration). If your config
  refuses to load after upgrading, read the error and fix or delete the
  named key. Keys beginning with `x-` remain available as YAML anchor
  holders at the top level only; an `x-` key inside a section is now
  rejected like any other unknown key (inside these nine sections it was
  silently dropped before). The policies and budgets subtrees were
  already strict and are unchanged.
- The `Watching <config> for policy changes` startup line now prints
  once the config watcher is actually armed (chokidar's `ready`), not
  merely after watching was requested — a script that waits for the
  line can trust a subsequent config edit to be observed. Same text,
  same position, still within milliseconds on startup.

### Removed

- **MCP self-repair feedback no longer emits `ruleIndex` (#144).** v0.10.0
  renamed the field to `rule_index` (#109) and kept `ruleIndex` as a
  deprecated alias carrying the same value for that one release. The window
  is closed: `error.data` on blocked calls now carries `rule_index` only.
  Agent self-repair handlers still reading `ruleIndex` must switch to
  `rule_index`. No other wire surface changes — audit records and
  `/evaluate` keep `matched_rule_index`, approval tickets keep `rule_index`,
  neither ever carried the alias.

### Fixed

- **Sideband expiry no longer discards the committed limits chain
  (#149).** When a sideband `/audit` committed its counters and budget
  ledger rows but failed post-commit (a 500 the adapter may retry), an
  evaluation that then expired unretried was finalized under a fresh
  random audit id with no limits chain: the `budget_events.audit_record_id`
  written at commit pointed at a record that never landed, and the
  committed rate/spend/budget evidence was missing from the trail even
  though the money state was correct. The `evaluation_expired` record now
  reuses the pre-allocated audit id (ledger rows always resolve), carries
  the committed `evidence_chain.budgets` blocks, and marks
  `evidence_chain.sideband.committed: true` to distinguish a lost
  finalization from a call that was never reported.
- **Dashboard-routed rule approvals now require the dashboard server
  (#152).** A rule with `action: require_approval` routed to the dashboard
  channel (explicitly, via a viable escalation delegate, or by the
  no-`approval`-block default) validated and started with
  `dashboard.enabled: false`, even though the dashboard approvals API is
  the only surface that can resolve such tickets — every one could only
  time out, or forward ungoverned under `default_on_timeout: allow`. The
  hot-reload guard already rejected these routes, so a config could boot
  into a state every reload refused. Startup validation now rejects the
  shape the same way it rejects dashboard-routed budget break-glass, and
  also covers `policies.flag_destructive: require_approval` and
  `policies.on_tool_drift: require_approval`, whose escalation tickets
  always use the dashboard channel. Previously-accepted configs in this
  shape fail validation until the dashboard is enabled or the approval is
  routed to a Slack channel; rules matching only on sideband
  `match.metadata` are exempt (their tickets are adapter-resolved).
- **Sideband dry-run now simulates rule rate and spend limits (#146).** Global
  dry-run on `POST /evaluate` skipped the matched rule's `rate_limit` /
  `spend_limit` entirely: `would_forward` came back `false` even with
  headroom, `limits_ok` reflected budgets only, and the response carried no
  `limits.rate` / `limits.spend` snapshot, so adapters could not distinguish
  a would-block from a would-pass. The sideband now peeks the same limiter
  path enforcement uses — consuming nothing and reserving nothing — and an
  unreadable spend amount simulates as a block with `reason: invalid_amount`.
  The MCP door's dry-run gains the matching alignment: a spend field that
  does not resolve to a number now reports `limits_ok: false` with the same
  operator warning enforcement logs (enforcement already denied that case as
  `invalid_amount`).

### Security

- **js-yaml `4.1.1` → `4.3.0`** (GHSA-52cp-r559-cp3m — YAML merge-key chains
  can force quadratic CPU consumption). js-yaml parses `helio.yaml`, which is
  operator-authored, so there is no remote input path; the parser of a
  governance proxy is upgraded regardless. The patch ships on the maintained
  v4 line, so no API changes.
- **axios `1.17.0` → `1.18.1`** (GHSA-gcfj-64vw-6mp9 — the Node HTTP adapter
  can use an inherited proxy after interceptor config cloning), transitive
  under `@slack/web-api` (Slack approvals); the workspace override pinning
  axios moved to the patched version.
- **brace-expansion `1.1.13`/`5.0.5` → `1.1.16`/`5.0.7`**
  (GHSA-3jxr-9vmj-r5cp — exponential-time expansion DoS), dev/build-tooling
  transitives; the workspace overrides now map the advisories' full
  vulnerable ranges to the patched versions.
- **postcss `8.5.12` → `8.5.18`** (GHSA-r28c-9q8g-f849 — path traversal in
  previous-source-map auto-loading can disclose arbitrary `.map` files),
  build-tooling transitive under vite; the workspace override pinning
  postcss moved to the patched version.
- **brace-expansion `5.0.7` → `5.0.8`** (GHSA-mh99-v99m-4gvg — memory
  exhaustion via unbounded expansion length). The 1.x line under eslint's
  `minimatch@3` has no patched release, only ever expands our own lint
  globs, and cannot take the 5.x API; it is a tracked audit ignore (#205).
- **react-router advisory GHSA-qwww-vcr4-c8h2 acknowledged** as unreachable:
  the CSRF bypass lives in the unstable RSC code paths, and the dashboard
  is a client-side SPA importing no `unstable_*`/RSC API. Tracked audit
  ignore until the react-router 8 upgrade (#204).

## [0.10.0] - 2026-07-14

### Added

- **Named budgets: cumulative cross-tool spend enforcement (#14).** A new
  top-level `budgets:` section defines depleting spend pots independent of
  policy rules: each budget aggregates spend across every tool its
  `contributors` match (e.g. Stripe and PayPal into one cap, each with its own
  amount field), scoped `global`, per `session`, or per adapter `sender_id`.
  Windows are sliding durations or `session` (a pot that never replenishes on
  a timer; idle pots are collected after `idle_ttl`, default 24h). The gate is
  all-or-nothing on both doors: every matching budget is peeked before the
  call proceeds, and one breach gates the call — denying it, or holding it
  for a break-glass approval, per that budget's `on_exceed`. A blocked call
  records nothing on any budget — nor on rule-level rate/spend counters,
  which now also commit only when the call actually forwards. Denials return structured feedback
  with `reason: budget_exceeded` and a per-budget breakdown; the sideband
  `/evaluate` gains the `budget_exceeded` decision (terminal, fail-closed for
  adapters that treat unknown decisions as deny — now a normative adapter
  requirement) and a `limits.budgets` block, with charges committed at
  `/audit` only when the call executed. Budgets hot-reload by name identity:
  contributor edits preserve accrued spend; `limit`/`currency`/`window`/`key`
  changes reset it. Breach modes are `on_exceed: deny` and
  `on_exceed: require_approval` (break-glass, below).
- **Break-glass approvals for budget overages (#14).** A budget with
  `on_exceed: require_approval` turns a breach into a human decision instead
  of a denial. One call raises one composite ticket listing every breached
  budget under a new `breached_budgets` field, rendered on the dashboard,
  webhook payloads, and Slack messages. Budget-only tickets route by the
  breached budget's own `approval` block (first breached budget wins when
  configs differ; dashboard channel and the global timeout when omitted) —
  never by the matched rule's. Channel, delegates, and escalation apply on
  the MCP door; sideband tickets are adapter-native and inherit only the
  selected timeout. On approval the overage records as
  `kind: approved_overage` on the ledger and in the audit record's
  `evidence_chain.budgets` — committed before the call forwards on the MCP
  door, and at `/audit` after the host executed it on the sideband; a denial,
  timeout, or disconnect records nothing (on the sideband, when the adapter
  honors it). Budget tickets always fail closed
  on timeout — `approval.default_on_timeout: allow` does not apply to money
  gates. A simultaneous `on_exceed: deny` breach wins outright and raises no
  ticket. Per door: the MCP proxy keeps a rule approval and a budget breach
  as two sequential decisions (the budget ticket attributed under
  `evidence_chain.budget_approval`), while the sideband merges both gates
  into the call's single native ticket in the standard `approval` block —
  a deliberate, documented interpretation of the execution order for the
  one-round-trip `/evaluate` contract, with no second approval block ever
  on the wire (verified compatible with `@gethelio/helio-openclaw` 0.1.0).
  Executed-despite-denied reports stay truthful: the spend commits as plain
  `spend` with the denied `approval_status` on the audit record. Budget
  approvals are scope-once by definition (`scope: "always"` is inert on
  budget-context tickets — issue #127), and any budget using
  `on_exceed: require_approval` now requires `dashboard.api_secret`, like
  approval rules.
- **Budget spend persists across restarts (#14).** Every budget charge is
  written to a ledger in the audit database — synchronously, in one
  transaction per call, at record time — and replayed at startup: duration
  windows resume mid-window exactly where they left off, and `session` pots
  still within their `idle_ttl` come back with their full accrued spend.
  Config identity extends across restarts: a
  `limit`/`currency`/`window`/`key` change while the proxy was down resets
  the pot instead of replaying, matching hot-reload semantics, and a removal
  the proxy observes (live, or at a startup without the budget) retires the
  spend so a later re-add starts fresh. Ledger writes fail closed per door:
  the MCP door blocks the call before forwarding, with
  `failure_class: budget_ledger_write_failed` in the error feedback and the
  same value as the audit record's `block_reason`, consuming no counters;
  the sideband door fails the `/audit` report and keeps the evaluation
  pending, so nothing is counted unless the adapter's idempotent retry
  lands the write. Ledger rows follow `audit.retention` on the audit
  store's existing sweep, and a budget window longer than the retention
  draws a startup warning. Rule-level rate/spend limit buckets remain
  in-memory and still reset on restart.
- **Budgets dashboard view and API (#14).** The dashboard gains a Budgets
  tab showing every configured pot with per-bucket depletion bars, reset
  countdowns for duration windows, and an expandable per-budget spend
  ledger where approved overages carry a distinct badge. Two new sideband
  endpoints back it: `GET /api/budgets` (every configured budget with live
  bucket states — configured pots appear at full headroom even before any
  spend) and `GET /api/budgets/:name/events` (the budget's ledger rows,
  newest first, paginated and clamped like the other list endpoints;
  history spans config resets and follows `audit.retention`). The SSE
  stream gains two events: `budget_update` fires per budget on every
  committed charge with post-record numbers and the commit `kind` (an
  approved overage is visible live; the sole exception is a charge
  committing under a stale config generation after a pot-resetting
  reload, which is ledgered without an event), and `budget_breached`
  fires once per genuinely breached budget when a peek denies a call or
  raises the break-glass ticket — dry-run simulations stay silent, and
  an invalid-amount failure emits no event of its own, though genuine
  breaches denied alongside one still do. There is no separate budget
  warning event; `budget_update.utilization` drives dashboard
  thresholds.
- **Budgets guide, runnable example, and demo (#14).** The docs gain a full
  budget guide: semantics, atomicity, and the per-door enforcement claim in
  the policy guide; the complete `budgets:` reference with hot-reload
  identity rules in the configuration reference; a consolidated budget
  section with the wire shapes in the adapter API doc; and the ledger
  narrative in the audit doc. A new `examples/budgets/` walks the whole
  flow against local demo tools — one session pot across `stripe_*` and
  `paypal_*`, live depletion in the dashboard, a break-glass approval, the
  approved overage in the ledger, and a restart that replays the spend.
  The Docker quickstart's echo server gains the same payment tools and its
  config a `demo-payments` budget, so the containerized demo covers the
  breach-and-approve flow too.

### Fixed

- **Approval channel references now validate against the runtime registry
  (#14 rider).** A channel that sets `name` is registered only under that
  name, but validation also accepted its bare `type` — so
  `approval.channel: slack` with a named Slack channel passed `helio
validate` and then never delivered a notification. Rule and budget channel
  (and delegate) references now resolve exactly the way the runtime does;
  previously-accepted configs with dangling type references are rejected at
  startup. Relatedly, a budget routing break-glass tickets to the dashboard
  channel (explicitly, via a delegate, or by fallback) now requires
  `dashboard.enabled: true` — with the dashboard off such a ticket had no
  resolution surface and could only time out.
- **Nameless `tools/call` requests are rejected and audited instead of
  forwarded unrecorded (#132).** A `tools/call` that carries no usable tool
  name (missing, non-string, or empty `params.name`) previously bypassed both
  policy evaluation and the audit trail — it was forwarded to the upstream
  untouched. Helio now rejects it at the proxy with a JSON-RPC invalid-params
  error (`-32602`) and writes a `policy_decision: rejected` audit record under
  the `<nameless>` sentinel, with `block_reason: missing_tool_name` and the raw
  `params` preserved in `tool_input`. The record is distinguishable from a
  rule-matched deny and renders as its own Rejected outcome in the dashboard.
  This restores the audit trail's completeness guarantee for every
  `tools/call`.
- **Sideband `/evaluate` returns configured rule feedback on gating decisions
  (#78).** A `require_approval` or `dry_run` decision now carries the matched
  rule's `feedback` block (`message`, optional `suggestion`) when the rule
  configures one, so adapter-built approval prompts and shadow-mode reports
  can show the operator's rationale instead of the internal rule-match
  reason. Blocking decisions are unchanged and still always include
  `feedback`; gating decisions without configured feedback omit it, and a
  plain `allow` rule's feedback is never surfaced (a global dry-run that
  shadows an allowed call stays feedback-free).
- **Each `spend_limit` rule now tracks its own bucket (#14 groundwork).**
  Spend bucket keys carry a `:rule:<index>` suffix (for example
  `session:abc:rule:2`), fixing a silent collision where two spend rules
  sharing a scope — such as two session-keyed rules — pooled their spend in
  one bucket with last-write-wins config and no currency guard. Hot-reload
  reconciliation matches suffixed buckets at their own rule index, so a
  config edit that shifts a spend rule's position evicts its bucket and the
  rule starts a fresh window rather than stranding accrued spend under a
  label no rule reads. Operator notes: bucket labels change in
  `GET /api/limits`, `limit_warning` events, and denial messages; accrued
  spend resets whenever a spend rule's position in the rules list changes;
  and the sideband's sender-key registry counts distinct live
  sender-scoped KEYS (capped at 50,000), so a sender that exercises several
  sender-keyed spend rules occupies one slot per exercised rule bucket
  rather than one slot total. Rate bucket keys are unchanged.

### Changed

- **MCP self-repair feedback renames `ruleIndex` to `rule_index` (#109).**
  The `error.data` field carrying the matched rule's index now uses
  `rule_index`, aligning the last camelCase holdout with the snake_case wire
  convention used everywhere else (`matched_rule_index` on audit records and
  `/evaluate`, `rule_index` on approval tickets). `ruleIndex` is still
  emitted as a deprecated alias for this release and will be removed in the
  next; migrate any agent self-repair handlers that read it.

## [0.9.0] - 2026-07-05

### Security

- **Operator-provided sideband tokens are no longer echoed to stderr (#128).**
  When `HELIO_SDK_TOKEN` or `HELIO_ADAPTER_TOKEN` is pre-set in the
  environment, `helio start` now acknowledges the source without printing the
  value, so long-lived secrets stay out of process logs. Generated per-boot
  tokens are still printed; stderr is their only handoff.

### Added

- **Adapter liveness on the dashboard: `GET /api/adapters` (#126).** The SDK
  sideband now records, per adapter origin, when it was first and last seen
  and the `adapter_version` it most recently reported on `POST /evaluate` —
  the per-origin liveness the field was designed for. The dashboard sideband
  serves it at `GET /api/adapters` (empty list when the SDK sideband is
  disabled). State is in-memory, bounded by the existing 32-origin budget,
  and version changes are logged to stderr escaped and capped per origin.

### Fixed

- **Bulk audit exports honor the documented 10,000-record cap (#131).** The
  dashboard export endpoint (`GET /api/audit/export`) and `helio export`
  previously returned at most 1,000 records regardless of the requested
  limit, because the bulk path shared the dashboard's page-query cap.
  Exports now use a dedicated read path capped at 10,000 records,
  oldest-first with a deterministic tiebreak for records sharing a
  timestamp; the paginated `/api/audit` keeps its 1,000-row page cap.
  `helio export --limit` accepts integers up to 10,000 and rejects
  malformed values with an error instead of exporting a truncated result.
- **CSV audit exports include every record field, matching JSON (#66).** CSV
  exports gain `record_kind`, `origin`, and `metadata` columns, appended
  after the existing columns so positions stay stable for consumers that
  parse by index. Dashboard API exports serialize `metadata` as a JSON
  string, like the other object-valued fields; `helio export -f csv` keeps
  its lightweight serializer and leaves object-valued fields empty.

## [0.8.0] - 2026-07-03

### Added

- **Audit records keep denial reasons and escalation history (#110).** Approval
  resolutions with context worth keeping now write an `evidence_chain.approval`
  block onto the call's audit record: `ticket_id`, `denial_reason` when the
  denier supplied one, and `escalated_at` / `escalated_to` when the approval
  escalated before resolution. Previously this context lived only on the
  in-memory ticket and was lost an hour after resolution. Applies to both the
  MCP path and sideband-governed calls; the dashboard's audit detail panel
  renders the new block. Plain approvals are unchanged (`evidence_chain` stays
  null).

### Changed

- **Sidecar deployment guide clarified and corrected (#105).** Reframed
  `docs/deployment-sidecar.md` around its purpose (a deployment pattern, not a
  tutorial), aligned the sample config with the canonical section order, and
  removed a dead `flag_destructive` setting that implied an approval flow the
  policy never triggered.
- **Dashboard login prompt is deployment-neutral (#94).** The lock screen no
  longer assumes the dashboard secret is a literal in `helio.yaml`. It now points
  to the `dashboard.api_secret` value in your Helio config and explains the
  `${HELIO_DASHBOARD_SECRET}` env-placeholder case used by the Docker quickstart
  and hand-authored configs.
- **Docker quickstart hardened (#93).** The `docker/README.md` walkthrough now
  covers cloning and `cd docker`, writing the dashboard secret into `.env`, and
  states up front that the stack is a self-contained demo, with a pointer to the
  sidecar guide for governing your own server. Added an "Exercise it" section
  with allow and deny tool-call examples and a "Reset the demo" note, and aligned
  `helio.docker.yaml` with the canonical config section order.

### Fixed

- **Sideband servers return JSON for unhandled errors (#115).** Dashboard
  sideband and SDK sideband routes used to fall through to a `text/plain` 500
  for unhandled server exceptions. Both servers now normalize unhandled
  `Error` exceptions to `500 {"error": "Internal server error"}` and log the
  underlying error to stderr; the error message itself is never sent to the
  client.
- **Docker demo approvals now fire (#104).** The demo config configured an
  approval channel but nothing ever reached it — `flag_destructive` was dead
  because the `block-destructive` rule matched first. `send_email` now requires
  approval, so calling it populates the dashboard Approvals page as the README
  promised; the "Exercise it" section walks through it.

### Security

- **Harden dashboard CORS origin validation (GHSA-2c3r-q7gv-hp2m).** The dashboard
  sideband's private-network origin allowlist matched request origins by
  hostname prefix, so a public DNS name beginning with a private-range label
  (for example `192.168.attacker.com`) was admitted. When the dashboard ran in
  open mode (`dashboard.allow_open_mode: true`, no `dashboard.api_secret`), a
  browser page on such an origin could read the sideband cross-origin. Origins
  are now validated as real private IPv4 literals, so hostnames no longer match.
  Secure mode (`dashboard.api_secret` set) was not affected: cross-origin reads
  still require a credential the attacker page cannot supply. Affects versions
  through 0.7.0.

## [0.7.0] - 2026-06-30

### Added

- **Audit-only default surfaced at startup and in the docs (#80, #81).** When
  Helio starts with zero policy rules and `default: allow`, it now prints a
  startup line noting that it is recording a full audit trail but not blocking
  anything, so the audit-only posture is not missed. The line is suppressed when
  at least one rule is loaded, when `default: deny`, or in dry-run. The README
  and getting-started guides now also state that `helio init` scaffolds the
  `policies` section commented out (audit-only) until you add rules.

### Changed

- **Quick-start onboarding hardened (#82, #83, #84, #85).** Reconciled the config
  sample order across the README, getting-started, the `init` scaffold, and the
  Configuration Reference into one request-lifecycle order; added a
  zero-dependency echo server and an agent-free Step 4 (MCP Inspector plus a
  copy-paste curl) so npm-only users can complete the quick start without a repo
  clone or an existing agent; and clarified the dashboard login and SDK-token
  notes.

## [0.6.0] - 2026-06-19

### Added

- **Optional `evidence` payload on `POST /audit` (#11).** Hook-based adapters can
  now populate evidence-grounding facts on their single adapter-scoped token by
  attaching an optional `evidence` array to `/audit`, instead of the SDK-scoped
  `POST /evidence`. Writes are **success-only** and **first-finalize-only**, bound
  to the pending evaluation's own `session_id` / `tool_name` (an adapter cannot
  target another session), and still gated by the `evidence.requires` policy
  allowlist. Every per-entry failure is **soft** — over-cap (`too_many` past 16,
  `too_large` over 64 KiB), a disallowed key, or a shutting-down store are
  reported per entry and never fail the audit, so the record for a call that
  already ran is preserved. Part of the experimental adapter contract (#11); see
  `docs/adapter-api.md`.

### Security

- **hono `4.12.14` → `4.12.26`** (GHSA-88fw-hqm2-52qc — CORS middleware reflects
  any `Origin` with credentials on the wildcard default). Helio's sideband rejects
  `Origin` headers and does not use the permissive default, so it was not
  exploitable in practice, but the dependency is upgraded regardless.
- **undici** dev-only advisory (GHSA-vmh5-mc38-953g) acknowledged as a test-only
  transitive (`dashboard > jsdom`), not present in the published artifacts; no
  patched version is compatible with `jsdom@29`'s internal layout, so it is scoped
  to the dev-only audit ignore list.

## [0.5.0] - 2026-06-16

### Added

- **Sideband governance API for hook-based adapters (#12).** A new
  bearer-protected sideband lets a non-MCP host (e.g. a chat adapter) run the
  same policy engine as the MCP path: `POST /evaluate` (peek-only decision),
  `POST /audit` (idempotent record-on-consume), `POST /install-scan`
  (observational install evaluation), and `POST /approval/:id/resolve`. Governed
  calls are recorded with new `record_kind` / `origin` / `metadata` audit
  columns, and a sideband evaluation whose `/audit` never arrives is recorded as
  `evaluation_expired` (a bypass/tamper signal). **The adapter contract is
  experimental** — it may change in a breaking way until a second adapter
  validates its neutrality (the OpenClaw adapter, #11, is the first). Pin
  adapters to a Helio minor version. See `docs/adapter-api.md`.
- **Context-aware policy primitives (#13).** Policies can now match on
  adapter-supplied context: `match.metadata.*` (plus a virtual `agent_id` key,
  inert on the MCP path), an install-time `deny_install` action under
  `policies.install`, and per-sender rate/spend scoping via
  `scope: { by: sender_id }`.
- **Dashboard renders adapter-origin tool calls (#16).** The Feed and Audit
  pages show an **Origin** column (MCP / adapter, e.g. OpenClaw) and a
  record-kind chip (Install Scan / Drift / Expired) shown alongside — and
  distinct from — the allow/deny decision. The Audit page adds
  `metadata.channel_id` / `metadata.sender_id` as columns and filters (with
  Origin and Record Kind controls and an "Install Denied" block-reason filter),
  and feed cards gain an Adapter Context detail section. Free-text filters
  (tool, origin, channel, sender) match by substring.

### Security

- **Patched `form-data` to >= 4.0.6 (GHSA-hmw2-7cc7-3qxx).** The vulnerable
  version (CRLF injection via unescaped multipart field names) reached the
  runtime transitively through `@slack/web-api`; forced to the patched release
  via a pnpm override.

## [0.4.0] - 2026-06-11

### Added

- **Tool definition drift detection (#25).** Every tool's full definition
  (annotations, input/output schema, description, title) is baselined on first
  sight and diffed on every `tools/list`. Drift is audited (`tool_drift` /
  `tool_drift_reverted` records) and calls to drifted tools are gated by the
  new `policies.on_tool_drift` option (`block` | `require_approval` | `log`).

### Changed

- **Conservative default:** `on_tool_drift` defaults to `block` — a tool whose
  definition changes mid-session is denied until the proxy restarts or the
  upstream reverts. Set `policies.on_tool_drift: log` for observe-mode, which
  still evaluates rules against both the baseline and current annotations and
  applies the stricter decision. Policy evaluation now uses baseline annotations
  rather than the most recent `tools/list` claim.
- Dashboard aggregates (`allowed_total`, `top_tools`) exclude drift-event
  records so they keep representing tool-call outcomes.

## [0.3.0] - 2026-06-10

### Deprecated

- **`UpstreamForwarder` is deprecated.** It is now a compatibility alias of
  `StreamableHttpForwarder` and behaves identically (including SSE response
  parsing and managed internal session support), so older imports keep
  working with the fixed behavior. Library consumers should construct
  `StreamableHttpForwarder` directly; the alias will be removed in a future
  release.

### Fixed

- **`streamable-http` upstream is now a real session-aware MCP client.**
  Previously the proxy forwarded upstream requests as stateless JSON-RPC POSTs,
  so spec-compliant session-enforcing servers (e.g. stock FastMCP, the official
  MCP SDK servers) rejected Helio's startup prime with HTTP 400 and the proxy
  looped fail-closed; upstream `text/event-stream` responses were also rejected
  outright. The proxy now forwards each downstream client's `initialize`
  handshake and session id transparently, establishes its own managed upstream
  session for Helio-internal traffic (the startup annotation prime), sends
  `MCP-Protocol-Version` on upstream requests, and parses both
  `application/json` and `text/event-stream` POST responses. No upstream server
  configuration changes are required.
- **Annotation-prime failures are now classified.** Startup prime retry logs
  distinguish upstream HTTP errors, JSON-RPC error payloads, non-JSON bodies,
  and missing `result.tools`, instead of always reporting "unexpected shape".
- **`streamable-http` handshake and parser behavior are hardened.** Helio now
  validates JSON-RPC envelopes for internal `initialize` and
  `notifications/initialized` handshakes (including HTTP 200 responses) and
  fails closed on JSON-RPC errors instead of caching a poisoned internal
  session. The managed internal session now uses the upstream-negotiated
  protocol version, and direct forwarder/library usage preserves an
  already-present `mcp-protocol-version` request header. SSE parsing now
  accepts field lines with and without a space after `:` (for example
  `data:<json>` and `data: <json>`).
- **Internal handshake SSE error scanning now streams with guardrails.**
  `notifications/initialized` SSE responses are scanned incrementally instead
  of buffering whole bodies, with an explicit read timeout and byte cap. This
  prevents pathological never-closing/oversized streams from stalling startup
  handshake error classification.

## [0.2.0] - 2026-06-09

### Added

- **Static upstream headers.** A new `upstream.headers` map attaches
  operator-defined static headers (e.g.
  `Authorization: Bearer ${UPSTREAM_TOKEN}`) to every upstream request, so Helio
  can front an authenticated MCP server without the caller supplying
  credentials. Values support `${VAR}` interpolation, keeping secrets out of
  `helio.yaml`. Applies to the HTTP transports (`streamable-http`, `sse`);
  `stdio` has no request headers. Header names are matched case-insensitively.

### Security

- Configured `upstream.headers` take precedence over any caller-supplied header
  on a name conflict, so a downstream caller cannot override an operator-provided
  credential such as `Authorization`. Reserved transport/protocol headers (`mcp-session-id`, `mcp-protocol-version`,
  `content-type`, `content-length`, `host`) are rejected by config validation.

## [0.1.1] - 2026-06-04

### Changed

- **Clearer upstream-unreachable errors.** When the upstream MCP server cannot
  be reached (connection refused, DNS failure, or timeout), Helio now returns a
  diagnostic message naming the likely cause and remediation instead of an
  opaque fetch error.

## [0.1.0] - 2026-05-19

Helio's first public release.

### Added

- **Governance proxy.** Sits transparently in front of an MCP server: intercepts
  the `tools/call` method for policy evaluation and passes every other JSON-RPC
  method through unchanged. Streamable HTTP, SSE, and stdio upstream transports.
  Forwarding failures and non-JSON-RPC upstream payloads are normalized to a
  proper JSON-RPC error envelope; only ingress-level errors (bad JSON, wrong
  `Content-Type`) surface as transport HTTP errors.
- **Policy engine.** First-match-wins rules over tool-name globs, MCP annotations
  (`destructiveHint`, `readOnlyHint`, `idempotentHint`, `openWorldHint`), input
  conditions (`$.field` with `eq` / `neq` / `gt` / `gte` / `lt` / `lte` /
  `contains` / `regex`), and an environment label. Actions: `allow`, `deny`,
  `require_approval`, `rate_limit`, `spend_limit`, `dry_run`, plus a global
  `flag_destructive` mode (`log` or `require_approval`). Config hot-reloads
  atomically (a failed reload keeps the previous policy); reload can be disabled
  with `--no-hot-reload`.
- **Approvals.** In-memory queue with a Promise-based hold and configurable
  timeout (default-deny on timeout), break-glass override (reason recorded in the
  audit trail and surfaced as a distinct decision), and delegate + escalation
  support. Channels: dashboard, webhook (POST the ticket to a URL), and Slack
  (interactive Approve / Deny buttons). Timed-out, client-disconnected, and
  shutdown-cancelled approvals are recorded as distinct outcomes.
- **Evidence grounding.** Per-session, TTL'd evidence cache. Rules can require
  evidence keys (`evidence.requires`) or prior tool calls (`requires`, with
  optional `requires_success`).
- **Rate & spend limits.** Sliding-window rate limiting, and spend limiting with
  the amount extracted from a configurable tool-input field — each keyed by tool,
  agent, or session. Current limit state is readable from the dashboard sideband
  (`GET /api/limits`), not the MCP port.
- **Audit trail.** Append-only SQLite store written by an async buffered writer
  (batched flushes; zero added latency on the request path), with retention-based
  cleanup and JSON/CSV export via `helio export` or the dashboard. Each record
  captures the tool call, policy decision, evidence, approval, upstream response
  (full body or a summary, per `audit.include_responses`), and a latency
  breakdown.
- **Self-repair feedback.** Blocked calls return a structured
  `{ blocked, reason, rule, suggestion, … }` payload (discriminated on `reason`:
  `policy_denied`, `evidence_missing` / `evidence_expired`, `dependency_missing`,
  `rate_limited` / `spend_limited`, `approval_denied` / `approval_timeout`,
  `client_disconnected`, `shutdown_cancelled`) so agents can recover instead of
  failing blind.
- **Dashboard.** React SPA bundled into the proxy and served from it: live action
  feed (Server-Sent Events), approvals queue with live countdowns, a
  searchable / filterable / paginated audit log, rate & spend limit gauges, and
  analytics charts.
- **Sideband API + Python SDK.** `helio-client` on PyPI — a thin client (under 500 lines)
  that reports evidence and context to the proxy over a localhost-only,
  bearer-protected sideband. The SDK never makes governance decisions.
- **CLI.** `helio init` (scaffold a commented `helio.yaml`), `helio start`,
  `helio validate`, and `helio export`.
- **Examples & container image.** Runnable `basic`, `slack-approvals`, and
  `spend-limits` examples, plus a published GHCR Docker image.

### Changed

- **Repository safety checks.** Added gitleaks-based secret scanning in both
  local and CI workflows: staged-file blocking in Husky pre-commit
  (`pnpm secrets:scan:staged`) and full repository blocking in CI
  (`pnpm secrets:scan`, job `Secret Scan`).
- **Contributor workflow docs.** Updated maintainer/contributor docs and PR
  checklist so required checks match the enforced CI gate.

### Security

- The sideband (SDK) API binds to `127.0.0.1` and requires a per-boot
  `HELIO_SDK_TOKEN` bearer token (32 random bytes, printed to stderr on
  `helio start`, or operator-supplied via the environment); it rejects any
  request carrying an `Origin` header and blocks `OPTIONS` preflights, defending
  against browser-driven access to the loopback port. `GET /healthz` stays open.
- The dashboard and approvals APIs bind to `127.0.0.1` by default. When
  `dashboard.api_secret` is set they require a session (a cookie plus an
  `x-helio-csrf` header on mutating routes) or the secret as a bearer token.
  `dashboard.api_secret` is mandatory whenever any rule uses `require_approval`
  (or the dashboard is enabled) unless `dashboard.allow_open_mode: true` is set
  explicitly — and open mode is permitted only on a loopback `dashboard.host`.
- All configuration and HTTP input is validated with Zod; all SQLite access uses
  prepared statements; audit database files are created with `0600` permissions.
- Caller headers are forwarded to the upstream server only via an explicit
  allowlist (`upstream.forward_headers`, restricted to `x-*` names); the
  `Authorization` header is always forwarded.
- No telemetry, no phone-home, no analytics; audit data stays on local disk.
- Secret scanning is now part of the default quality gate (pre-commit + CI),
  designed to prevent accidental credential commits before merge.

[Unreleased]: https://github.com/gethelio/helio/compare/v0.12.0...HEAD
[0.12.0]: https://github.com/gethelio/helio/compare/v0.11.1...v0.12.0
[0.11.1]: https://github.com/gethelio/helio/compare/v0.11.0...v0.11.1
[0.11.0]: https://github.com/gethelio/helio/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/gethelio/helio/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/gethelio/helio/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/gethelio/helio/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/gethelio/helio/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/gethelio/helio/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/gethelio/helio/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/gethelio/helio/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/gethelio/helio/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/gethelio/helio/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/gethelio/helio/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/gethelio/helio/releases/tag/v0.1.0
