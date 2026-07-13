# Changelog

All notable changes to Helio are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and Helio follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). The
proxy (`@gethelio/proxy`), Python SDK (`helio` on PyPI), and Docker image
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

### Added

- **Named budgets: cumulative cross-tool spend enforcement (#14).** A new
  top-level `budgets:` section defines depleting spend pots independent of
  policy rules: each budget aggregates spend across every tool its
  `contributors` match (e.g. Stripe and PayPal into one cap, each with its own
  amount field), scoped `global`, per `session`, or per adapter `sender_id`.
  Windows are sliding durations or `session` (a pot that never replenishes on
  a timer; idle pots are collected after `idle_ttl`, default 24h). The gate is
  all-or-nothing on both doors: every matching budget is peeked before the
  call proceeds, one breach denies it, and a denied call records nothing on
  any budget — nor on rule-level rate/spend counters, which now also commit
  only when the call actually forwards. Denials return structured feedback
  with `reason: budget_exceeded` and a per-budget breakdown; the sideband
  `/evaluate` gains the `budget_exceeded` decision (terminal, fail-closed for
  adapters that treat unknown decisions as deny — now a normative adapter
  requirement) and a `limits.budgets` block, with charges committed at
  `/audit` only when the call executed. Budgets hot-reload by name identity:
  contributor edits preserve accrued spend; `limit`/`currency`/`window`
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
  `evidence_chain.budgets`, and only then does the call proceed; a denial,
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
- **Sideband API + Python SDK.** `helio` on PyPI — a thin client (under 500 lines)
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

[Unreleased]: https://github.com/gethelio/helio/compare/v0.9.0...HEAD
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
