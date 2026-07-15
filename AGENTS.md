# Helio

Helio is an open-source MCP governance proxy. It sits between AI agents and external tools, applying policies, enforcing limits, requiring evidence, routing approvals, and recording an audit trail without modifying the agent or the tools.

**GitHub org:** `gethelio` · **npm scope:** `@gethelio` · **PyPI:** `helio` · **Config file:** `helio.yaml`

## Architecture

Hybrid model: MCP proxy (core) + thin client SDKs (Python first, TypeScript planned).

```
Agent → Helio Proxy (policies, audit, limits, approvals) → Upstream MCP Server → External Tools
              ↑ optional sideband
         Python SDK (evidence context, dependency annotations)
```

- The proxy intercepts `tools/call` JSON-RPC methods. All other MCP methods pass through untouched.
- The SDK communicates with the proxy via sideband HTTP. It NEVER makes governance decisions.
- SDK constraint: must stay under 500 lines per language. Governance logic belongs in the proxy.

## Monorepo Structure

pnpm workspaces. Three packages:

```
packages/proxy/         → @gethelio/proxy (Node.js, Hono, TypeScript)
packages/dashboard/     → @gethelio/dashboard (React 19 + Vite + Tailwind CSS, internal workspace package bundled into proxy dist; not published)
packages/python-sdk/    → helio on PyPI (Python, <500 lines)
```

Supporting directories: `examples/`, `docs/`, `docker/`, `scripts/`, `.github/`

## Tech Stack

- **Runtime:** Node.js 22+, TypeScript 5.x (strict mode), pnpm 10 workspaces
- **HTTP:** Hono (`@hono/node-server`)
- **Validation:** Zod v4 (single source of truth for helio.yaml schema)
- **YAML:** js-yaml
- **Input matchers:** custom dot-path (`$.field`) conditions with `eq`/`neq`/`gt`/`gte`/`lt`/`lte`/`contains`/`regex` operators — no JSONPath library
- **Globbing:** picomatch (tool-name patterns); safe-regex2 (validates operator-supplied `regex` conditions to reject catastrophic backtracking)
- **Database:** better-sqlite3 (SQLite)
- **File watching:** chokidar
- **CLI:** Commander.js
- **Dashboard:** React 19, React Router 7, Vite, Tailwind CSS 4, Recharts 3
- **Slack:** @slack/web-api
- **Testing:** Vitest (JS), pytest (Python SDK)
- **Linting:** ESLint + Prettier
- **Build:** tsup (proxy), Vite (dashboard)
- **CI:** GitHub Actions; Husky pre-commit hooks (secret scan + lint/format/typecheck + docs-drift check)

## Commands

```bash
pnpm install          # Install all workspace dependencies
pnpm dev              # Start proxy (tsup --watch) + dashboard (vite) in parallel
pnpm build            # Build proxy release artifact (includes dashboard asset bundling)
pnpm test             # Run all tests — Vitest (JS, all packages) + pytest (Python SDK)
pnpm test:js          # Vitest only (proxy + dashboard)
pnpm lint             # ESLint across all packages
pnpm format:check     # Prettier format check (runs in CI)
pnpm typecheck        # tsc --noEmit across all packages
pnpm secrets:scan     # gitleaks-based full repository secret scan
```

Package-specific (run from package directory or use `--filter`):

```bash
pnpm --filter @gethelio/proxy test
pnpm --filter @gethelio/proxy build
pnpm --filter @gethelio/dashboard dev
```

## Security Standards

Helio sits in the critical path between AI agents and external systems. A vulnerability in the proxy is a vulnerability in every downstream tool it governs. Security is not optional — it is the product.

### Input Validation

- **Validate all external data with Zod.** Config files, HTTP request bodies, SDK payloads, query parameters, JSON-RPC messages — every external boundary uses Zod schemas. Never trust unvalidated input.
- **Never pass raw user input to shell commands, SQL queries, or file paths.** All audit queries use prepared statements. Config file paths are resolved and validated before access.
- **Sanitize log output.** Never log raw request bodies that may contain secrets, credentials, or PII. Log tool names, decisions, and metadata — not tool arguments or downstream responses unless explicitly configured via `audit.include_responses`.

### Dependency Security

- **Pin all npm dependencies to exact versions** (no `^` or `~`). The `.npmrc` enforces `save-exact=true`. This prevents supply chain attacks via malicious patch releases.
- **Every dependency must be justified** in `DEPENDENCIES.md` with a clear rationale. If you add a dependency, document why it's necessary and why alternatives were rejected.
- **Minimize the dependency surface.** Prefer standard library functionality over third-party packages. Every new dependency is an attack vector. The bar for adding a production dependency is high.
- **Run `pnpm audit --audit-level=high`** in CI. PRs with known high-severity vulnerabilities in dependencies must not merge.
- **Dependabot is configured** for weekly version bump PRs. Review these for breaking changes before merging.

### Transport & Network Security

- **The sideband SDK API (port 3200) defaults to 127.0.0.1 and requires a per-boot Bearer token.** The sideband binds to `sdk.host` (default `127.0.0.1`); non-loopback binds are allowed but emit a startup warning and should be protected with strict network controls. The proxy generates `HELIO_SDK_TOKEN` as 32 random bytes on every `helio start` (unless the operator pre-set the env var, in which case it is respected) and prints it to stderr. Every sideband request except `GET /healthz` must carry `Authorization: Bearer <token>`. The sideband also rejects any request carrying a non-null `Origin` header and blocks `OPTIONS` preflights, which defends against a malicious local HTML file POSTing to sideband through a browser. This is the v0.1.0 trust model — no rotation, no revocation, no key management; a restart gives you a new token.
- **The dashboard API (port 3100) binds to 127.0.0.1 by default.** When `dashboard.api_secret` is set the API is gated: the secret logs in (issuing a cookie session + CSRF token), or is accepted directly as an `Authorization: Bearer` token. For mutating routes (approve/deny/break-glass), `x-helio-csrf` is required when authentication is via cookie session; bearer-authenticated requests do not require CSRF. `dashboard.api_secret` is mandatory whenever any rule uses `require_approval` (or the dashboard is enabled at all) unless `dashboard.allow_open_mode: true` is set explicitly — and open mode is only permitted on a loopback `dashboard.host`. Production deployments behind a reverse proxy should keep the 127.0.0.1 bind.
- **No telemetry, no phone-home, no analytics.** Helio never transmits data to external services beyond explicitly configured upstream MCP servers and approval channels.
- **MCP session IDs are opaque.** Never derive session IDs from user-controllable input. Generate them server-side or pass through the upstream `Mcp-Session-Id` header.

### Audit Trail Integrity

- **Audit records are append-only.** There is no API to modify or delete individual audit records. Retention-based cleanup is the only deletion path.
- **Audit writes must never block the request path.** The `AuditWriter` buffers and flushes asynchronously. A failure to write an audit record must never cause a tool call to fail.
- **Audit data stays local.** SQLite database on disk. No cloud sync, no external reporting unless the operator exports explicitly via CLI.

### Policy Engine Security

- **Policy evaluation is pure and deterministic.** Given the same compiled policy and match context, the result must always be the same. No side effects during evaluation.
- **Invalid config must never crash the proxy.** Hot-reload validation failures keep the previous valid policy set and log the error. The proxy must remain operational.
- **Default-deny is the recommended production posture.** The default `policies.default: allow` is for development convenience. Documentation and examples should make clear that production deployments should use `default: deny`.

### Secrets Handling

- **Never commit secrets.** `.gitignore` covers `.env`, `*.pem`, `*.key`, and other sensitive file patterns. CI and pre-commit checks run gitleaks-based scans for accidental secret commits.
- **Slack tokens and webhook URLs are config-only.** They appear in `helio.yaml` which is operator-controlled and should not be committed to version control. Documentation warns about this explicitly.
- **Never log secrets.** Slack tokens, webhook URLs, and API keys must never appear in log output, error messages, or audit records.

## Code Standards

### TypeScript (proxy + dashboard)

- **Strict mode**: no `any` types. Use Zod inference (`z.infer<typeof schema>`) for config types. If you must use `any`, add a comment explaining why and open an issue to remove it.
- **Named exports by default in product code.** Runtime/source modules should prefer named exports; default exports are acceptable in tooling/config files where ecosystem conventions expect them (for example Vite/Vitest/ESLint/tsup configs).
- **JSDoc on public runtime APIs**: exported functions, classes, and externally-consumed types should be documented, especially in the proxy package. For internal UI-only types, keep naming/section structure clear and add JSDoc where behavior is non-obvious.
- **2-space indentation**, single quotes, trailing commas, no semicolons (configured in Prettier).
- **Error handling**: return structured errors, never throw unhandled. Blocked actions return self-repair feedback JSON — a discriminated union keyed on `reason` (`policy_denied`, `evidence_missing`, `evidence_expired`, `dependency_missing`, `rate_limited`, `spend_limited`, `approval_denied`, `approval_timeout`, `client_disconnected`, `shutdown_cancelled`) with a common base `{ blocked: true, reason, rule, rule_index, suggestion, retry_allowed }` (every builder takes `rule` and `rule_index` from the shared `ruleInfo` helper) plus reason-specific fields (e.g. `missing_evidence`, `policy_reason`, `denial_reason`). Builders live in `packages/proxy/src/feedback/self-repair.ts`.
- **Async audit writes**: audit records are buffered and flushed in batches. NEVER block the request path for audit writes.
- **`readonly` on all interface fields and array types.** Mutability must be explicit and justified.
- **Prefer `const` over `let`.** Never use `var`.
- **No dead code.** Remove unused imports, functions, and variables. Do not comment out code — delete it and let git history preserve it.
- **Section separators**: `// ---...` comment blocks between logical sections in files.

### Python (SDK)

- Python 3.10+ with `from __future__ import annotations`.
- Frozen dataclasses for all types (`@dataclass(frozen=True)`).
- Type hints on all public APIs. Google-style docstrings.
- Explicit `__all__` in `__init__.py` — no implicit exports.
- snake_case field names in Python types **and** in the JSON wire payloads — the sideband API speaks snake_case both directions, so there's no camelCase translation layer (the same wire convention applies to the proxy's REST/SSE/webhook/audit DTOs).
- **Hard line limit: 500 lines total** across hand-written SDK modules (`__init__.py`, `types.py`, `client.py`, `context.py` — `_version.py` is hatch-vcs-generated and excluded). Governance logic belongs in the proxy, not the SDK.

### Conventional Commits

All commits follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(proxy): add time-of-day condition to policy engine
fix(dashboard): correct timezone display in audit log
docs: update policy matching examples
test(proxy): add rate limiter edge case coverage
chore: update CI Node.js version
refactor(proxy): extract policy compilation step
```

Scope with the package name when the change is package-specific. Omit scope for cross-cutting changes.

### Formatting & Linting

The Husky pre-commit hook runs `pnpm secrets:scan:staged && scripts/check-docs-drift.sh && pnpm lint && pnpm format:check && pnpm typecheck` — all must pass:

```bash
pnpm lint
pnpm format:check
pnpm typecheck
```

CI runs the same checks, plus a full repository secret scan (`pnpm secrets:scan`) and `scripts/check-docs-drift-ci.sh`. PRs that fail any check must not merge. The docs-drift check aborts a commit that touches a drift-prone source file (CLI, config schema/loader, dashboard/evidence/approval/audit/policy/transport/upstream code, Docker assets, SDK modules) without also staging a user-facing doc (`docs/*.md`, a `README.md`, `SECURITY.md`, `DEPENDENCIES.md`, …); bypass with `git commit --no-verify` only when the change is demonstrably non-user-visible.

## Key Design Decisions

1. **First-match-wins policy evaluation.** Rules are evaluated in YAML definition order. First matching rule determines the action. If no rule matches, `policies.default` applies.
2. **Hot-reload without restart.** Config watcher re-parses and atomically swaps rules on file change. Invalid config keeps the old rules and logs the error — never crash.
3. **Evidence grounding is per-session.** Evidence cache is keyed by MCP session ID. Evidence expires when the session ends.
4. **Approval timeout defaults to deny.** Configurable, but the safe default is to block on timeout.
5. **Performance is a hard requirement.** Policy evaluation < 1ms. Total proxy overhead < 5ms p99. Benchmark on every release.

## File Patterns

- `packages/proxy/src/policy/` All policy engine code: parser, matchers, engine, annotation cache, governed-forwarder decorator, rate-limiter, spend-limiter. Rate/spend limit read APIs live on the dashboard sideband at `/api/limits`, not on the main MCP port.
- `packages/proxy/src/evidence/` Evidence store, grounding enforcement, SDK sideband API (bearer-protected).
- `packages/proxy/src/feedback/` Self-repair feedback builders (policy denied, evidence missing/expired, dependency missing, rate/spend limited, approval denied/timeout, client disconnected, shutdown canceled).
- `packages/proxy/src/approval/` Approval types, in-memory queue, router (Promise-based hold), channel abstraction, REST API, webhook channel, Slack channel + actions.
- `packages/proxy/src/audit/` Async writer, SQLite backend (store.ts), CSV export, types.
- `packages/proxy/src/transport/` Streamable HTTP, SSE, stdio wrapper adapters; upstream header allowlist (forward-headers.ts); JSON-RPC response normalizer.
- `packages/proxy/src/config/` YAML loader, Zod schema, chokidar watcher, reload-boundary diff (which config paths need a restart).
- `packages/proxy/src/upstream/` MCP request forwarder, response capture + summarization.
- `packages/proxy/src/auth/` Constant-time `Bearer <secret>` verification shared by the sideband/dashboard/approvals APIs.
- `packages/proxy/src/dashboard/` `createDashboardApp()` REST + SSE API, auth session store (secret login, CSRF), typed event bus. (The React UI lives in `packages/dashboard/`, bundled into the proxy's `dist/`.)
- `packages/proxy/src/util/` Small shared helpers (numeric clamp / clamped query-int parsing, Zod error formatting).
- `packages/proxy/src/` (top level) `cli.ts`, `server.ts`, `version.ts`, `crash-drain.ts` (flush buffered state before `process.exit`), `startup-warnings.ts`.

## Testing Standards

- Unit tests live alongside source files as `*.test.ts`.
- Integration tests in `packages/proxy/src/__tests__/` — spin up mock MCP servers using `@modelcontextprotocol/sdk`.
- Test naming: `describe('PolicyEngine')` → `it('denies when destructiveHint is true and no explicit allow rule')`.
- Mock MCP server pattern: Hono app returning canned JSON-RPC responses for `tools/list` and `tools/call`.
- Always assert audit records are written correctly after each test scenario.
- Benchmark tests: measure p99 latency over 100+ sequential `tools/call` requests.
- **Every new feature needs tests.** Every bug fix needs a regression test.
- **No mocking libraries.** Use real implementations or simple test stubs. This keeps tests honest.
- **Test security-relevant paths explicitly.** Policy denials, evidence validation failures, approval timeouts, malformed input rejection — these are not edge cases, they are core functionality.

## helio.yaml Schema Overview

```yaml
version: '1'
upstream:
  url: 'http://localhost:8080/mcp' # required
  transport: 'streamable-http' # streamable-http | sse | stdio
  command: 'node' # required when transport is stdio
  args: ['server.js'] # stdio only
  connect_timeout: '10s'
  request_timeout: '30s'
  forward_headers: ['x-tenant-id'] # caller headers to pass upstream; must be x-* (authorization is always forwarded)
listen:
  port: 3000
  host: '127.0.0.1'
environment: 'production' # optional label, recorded on every audit record
policies:
  default: allow # allow | deny  (use deny in production)
  flag_destructive: require_approval # optional: log | require_approval — applies to tools with destructiveHint
  dry_run: false # global: evaluate + audit but never block
  hot_reload: true # watch helio.yaml and reconcile policy on save (also: --no-hot-reload CLI flag)
  rules:
    - name: 'rule-name'
      match: # all present conditions must match (AND)
        tool: 'glob_pattern*' # picomatch glob
        annotations: { destructiveHint: true } # readOnlyHint | destructiveHint | idempotentHint | openWorldHint
        input: { '$.field': { gt: 1000 } } # operators: eq, neq, gt, gte, lt, lte, contains, regex
        environment: 'production'
      action: allow # allow | deny | require_approval | rate_limit | spend_limit | dry_run
      approval: # for action: require_approval
        channel: 'sec-team' # channel type or name from approval.channels
        timeout: '300s'
        delegates: ['oncall']
        escalation_after: '120s'
      evidence:
        requires: ['some.tool'] # evidence keys that must exist for this session
      requires: ['other.tool'] # tools that must have been called this session (dependency)
      requires_success: true # require those dependency calls to have succeeded upstream
      limits: # for action: rate_limit / spend_limit
        max_calls: 100
        window: '1h'
        key: tool # tool | agent | session
        max_spend:
          field: '$.amount'
          limit: 500
          currency: 'USD'
          window: '1h'
          key: tool
      feedback: # overrides the default self-repair message when this rule blocks
        message: 'Blocked by policy.'
        suggestion: 'Request approval via #sec-team.'
budgets: # cross-tool spend pots, independent of rules; gate after the policy decision
  - name: 'agent-payments' # identity: spend follows the name across reloads and restarts
    limit: 50
    currency: 'USD'
    window: session # duration ('24h') = sliding window | session = never replenishes on a timer
    key: session # global | session | sender_id  (window: session requires session or sender_id)
    idle_ttl: '24h' # session windows only: collect a pot after this long with no activity
    on_exceed: require_approval # deny | require_approval (break-glass; requires dashboard.api_secret)
    approval: # only with on_exceed: require_approval; omit it entirely for deny
      channel: 'dashboard'
      timeout: '300s'
    contributors: # every matching tool draws down the SAME pot
      - tool: 'stripe_*' # picomatch glob, same engine as match.tool
        field: '$.amount' # path to the amount in the call's arguments
      - tool: 'paypal_*'
        field: '$.total'
approval:
  timeout: '300s'
  default_on_timeout: deny # deny | allow
  channels:
    - type: dashboard # dashboard | webhook | slack
      name: 'sec-team' # optional — allows multiple channels of same type; a named channel is referenced by NAME, not by type
    - type: dashboard
      name: 'oncall' # referenced above as a delegate
    # - { type: webhook, url: 'https://…', secret: '…' }
    # - { type: slack, bot_token: '…', signing_secret: '…', channel: '#approvals' }
audit:
  storage: sqlite
  path: './helio-audit.db'
  retention: '90d'
  include_responses: true # false → store a response summary instead of full upstream bodies
dashboard:
  enabled: true
  port: 3100
  host: '127.0.0.1'
  api_secret: '${HELIO_DASHBOARD_SECRET}' # required when any rule uses require_approval, any budget uses on_exceed: require_approval, or the dashboard is enabled — unless allow_open_mode
  allow_open_mode: false # run the dashboard unauthenticated (loopback host only)
  sse_heartbeat_interval: '30s'
sdk:
  enabled: false
  port: 3200
  host: '127.0.0.1'
```

## Git Workflow

- Branch from `main`. Branch names: `feat/short-description`, `fix/short-description`.
- PRs require passing CI (secret scan, lint, typecheck, format:check, test, build).
- Squash merge to `main`. Release tags (`v0.1.0`) trigger automated publish.
- Commit messages follow Conventional Commits.

## Useful Context

- `better-sqlite3` (and `esbuild`) native builds are approved via `onlyBuiltDependencies` in `pnpm-workspace.yaml` — no manual rebuild needed. `pnpm-workspace.yaml` also pins a few transitive `overrides`.
- CI runs on the Node version in `.nvmrc` and Python 3.12; the E2E Python SDK test does `pip install ./packages/python-sdk`.
- The proxy depends on the official `@modelcontextprotocol/sdk` pinned to an exact version (`devDependencies` in `packages/proxy`) — monitor it for breaking changes.
- MCP session tracking via `Mcp-Session-Id` header — pass through transparently and use as the key for evidence/dependency state.
- The name "Helio" comes from Helios, the Greek Titan god of the Sun.

## Post-v1 Roadmap

The following are planned for future releases and should not be built into the current codebase:

- TypeScript SDK
- PostgreSQL or S3 audit backends
- Email approval channel
- SSO / SCIM / multi-user auth
- Rollback or compensating actions
- Compliance report generation
- SIEM export (Datadog, Splunk)
- Any ML/AI-powered features
- Hosted/cloud version
