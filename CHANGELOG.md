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

_Nothing yet._

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

[Unreleased]: https://github.com/gethelio/helio/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/gethelio/helio/releases/tag/v0.1.0
