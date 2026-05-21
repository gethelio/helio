# @gethelio/proxy

The core governance proxy package. Intercepts MCP `tools/call` requests, evaluates policy rules, records audit trails, and forwards to upstream MCP servers.

## Package Layout

```
src/
├── cli.ts                   → CLI entry point (helio start/init/validate/export)
├── server.ts                → Hono app factory + HTTP server lifecycle
├── index.ts                 → Public API surface (re-exports from all modules)
├── version.ts               → VERSION constant (read from package.json)
├── crash-drain.ts           → Crash-drain registry: flush buffered state (audit writer) before process.exit
├── startup-warnings.ts      → Operator-visible boot warnings (e.g. webhook channel unreachable on a loopback sideband)
├── auth/
│   └── bearer.ts            → Constant-time `Bearer <secret>` verification (shared by all bearer-protected sideband APIs)
├── config/
│   ├── schema.ts            → Zod schemas + inferred types for helio.yaml
│   ├── loader.ts            → YAML file loading + validation
│   ├── watcher.ts           → chokidar hot-reload (re-parse + atomic policy swap)
│   ├── reload-boundary.ts   → Diff two validated configs; report changed paths that require a process restart
│   └── index.ts             → Re-exports
├── transport/
│   ├── streamable-http.ts   → Streamable HTTP MCP transport (primary)
│   ├── sse.ts               → SSE MCP transport (legacy compat)
│   ├── stdio-wrapper.ts     → Stdio transport for local MCP servers
│   ├── forward-headers.ts   → Allowlist for headers crossing the proxy to upstream (authorization + `x-*` allowlist)
│   └── response-normalizer.ts → Normalize an upstream forwarding outcome (success/error) into a JSON-RPC response
├── upstream/
│   ├── forwarder.ts         → HTTP upstream forwarder (Streamable HTTP)
│   ├── sse-forwarder.ts     → SSE upstream forwarder
│   ├── response.ts          → Response parsing/capture utilities
│   ├── response-summary.ts  → Response summarization utilities
│   └── index.ts             → Re-exports
├── mcp/
│   ├── types.ts             → JSON-RPC 2.0 + MCP request/response types
│   ├── validation.ts        → Request validation
│   └── pending-requests.ts  → In-flight request tracking
├── policy/
│   ├── types.ts             → Compiled policy types (ToolMatcher, CompiledPolicyRule, MatchContext, etc.)
│   ├── parser.ts            → YAML config → compiled policy (pre-builds matchers, regexes, durations)
│   ├── matchers.ts          → Rule matching: tool glob, annotations, input conditions, environment
│   ├── engine.ts            → First-match-wins policy evaluator
│   ├── annotation-cache.ts  → Caches tools/list annotations per upstream
│   ├── governed-forwarder.ts → McpForwarder wrapper that applies policy before forwarding
│   ├── rate-limiter.ts      → Sliding window rate limiter with injectable clock
│   ├── spend-limiter.ts     → Sliding window spend limiter (field extraction happens in governed-forwarder via `resolvePath`)
│   ├── errors.ts            → PolicyParseError
│   └── index.ts             → Re-exports
├── evidence/
│   ├── store.ts             → In-memory per-session evidence cache with TTL
│   ├── grounding.ts         → Evidence requirement + dependency chain checks
│   ├── api.ts               → Sideband HTTP API (Hono app on SDK port, bearer-protected)
│   ├── types.ts             → EvidenceEntry, SessionState, etc.
│   └── index.ts             → Re-exports
├── feedback/
│   ├── self-repair.ts       → Structured block feedback builders (discriminated union)
│   └── index.ts             → Re-exports
├── approval/
│   ├── types.ts             → ApprovalTicket, ApprovalOutcome, ApprovalStatus, ApprovalChannel interface
│   ├── queue.ts             → In-memory approval queue (Map, injectable clock, cleanup)
│   ├── router.ts            → Promise-based hold: submit/approve/deny/close with timeout
│   ├── channels.ts          → QueueChannel + createChannels factory (name-based keying)
│   ├── webhook.ts           → WebhookChannel: POST ticket to configured URL on approval request
│   ├── slack.ts             → SlackChannel: send interactive Approve/Deny messages via @slack/web-api
│   ├── slack-actions.ts     → Slack action handler for interactive button callbacks
│   ├── api.ts               → REST API (Hono sub-app mounted at /api/approvals on the dashboard sideband, bearer-protected)
│   └── index.ts             → Re-exports
├── audit/
│   ├── types.ts             → AuditRecord, query/pagination/aggregate types
│   ├── store.ts             → AuditStore: SQLite backend (prepared stmts, retention cleanup)
│   ├── writer.ts            → AuditWriter: async buffered writer (batch flush to SQLite)
│   ├── csv.ts               → CSV serialization for audit export
│   └── index.ts             → Re-exports
├── dashboard/
│   ├── api.ts               → createDashboardApp() factory: REST + SSE API on dashboard port
│   ├── session.ts           → Dashboard auth sessions: secret login, CSRF token issue/verify, TTL cleanup
│   ├── event-bus.ts         → DashboardEventBus: typed EventEmitter for real-time events
│   └── index.ts             → Re-exports
├── util/
│   ├── clamp.ts             → Numeric clamp + clamped query-int parsing for pagination
│   └── format-zod-errors.ts → Flatten ZodError issues into `{ path, message }` for CLI/validation output
└── __tests__/
    ├── helpers/
    │   ├── mcp-test-server.ts   → Mock MCP server (Hono app with canned JSON-RPC)
    │   ├── mcp-test-server.test.ts → Tests for the mock server helper
    │   ├── test-utils.ts        → makeConfig(), sendMcpRequest(), startOnDynamicPort()
    │   └── e2e_sdk_script.py    → Python SDK E2E helper (invoked as subprocess)
    ├── integration-http.test.ts
    ├── integration-sse.test.ts
    ├── integration-stdio.test.ts
    ├── integration-governance.test.ts
    ├── integration-sideband.test.ts
    ├── e2e-full.test.ts
    └── e2e-python-sdk-sideband.test.ts
```

(`cli.ts` and most behavior-bearing modules have colocated `*.test.ts` unit tests next to them; type-only/barrel files may not. Cross-cutting integration/e2e suites live in `__tests__/`.)

## Build & Entry Points

Two tsup entry points, both ESM targeting Node 22:

- `src/index.ts` → `dist/index.js` (library, with `.d.ts`)
- `src/cli.ts` → `dist/cli.js` (CLI binary, with `#!/usr/bin/env node` banner; no `.d.ts`)

`better-sqlite3` (native addon) is marked external. Dashboard UI assets are bundled into `dist/dashboard-assets/` during proxy build and shipped inside the proxy package.

## Key Interfaces

**`McpForwarder`** (`mcp/types.ts`) — the core abstraction. Everything that handles MCP requests implements this:

```typescript
interface McpForwarder {
  forward(request: McpRequest): Promise<ForwardResult>
}
```

Implementations: `UpstreamForwarder`, `SseUpstreamForwarder`, `StdioForwarder`, `GovernedForwarder` (decorator).

**`CompiledPolicy`** (`policy/types.ts`) — engine-ready policy with pre-built matchers:

```typescript
interface CompiledPolicy {
  readonly defaultAction: 'allow' | 'deny'
  readonly flagDestructive?: 'log' | 'require_approval'
  readonly dryRun?: boolean
  readonly rules: readonly CompiledPolicyRule[]
}
```

**`MatchContext`** (`policy/types.ts`) — what the engine evaluates rules against:

```typescript
interface MatchContext {
  readonly toolName?: string
  readonly annotations?: ToolAnnotationHints
  readonly toolArguments?: Readonly<Record<string, unknown>>
  readonly environment?: string
}
```

**`AuditRecord`** (`audit/types.ts`) — full audit trail entry with 24 fields covering tool call, policy decision, evidence, approval, upstream response, and latency breakdown (`total_duration_ms` / `approval_wait_ms` / `proxy_compute_ms`).

**`AuditWriter`** (`audit/writer.ts`) — async buffered writer. `push()` is fire-and-forget; records flush to SQLite in batched transactions (every 100ms or 50 records). Used by GovernedForwarder to write audit records without blocking the request path.

## Type System

- All config types are Zod-inferred from `config/schema.ts` (`z.infer<typeof schema>`)
- Compiled/runtime types are separate interfaces in each module's `types.ts`
- Config types use snake_case (YAML convention); compiled types use camelCase
- Use Zod v4 — note `.prefault()` for optional objects with defaults (not `.default()`)

## Security Standards

The proxy is the single enforcement point for all governance decisions. Security flaws here compromise every downstream system.

### Input Boundaries

- **Every HTTP endpoint validates input with Zod** before processing. This includes JSON-RPC request bodies, query parameters, approval action payloads, and SDK sideband requests.
- **JSON-RPC validation** rejects malformed requests before they reach the policy engine. Invalid method names, missing required fields, and type mismatches must return proper JSON-RPC error responses — never crash.
- **Config validation happens at load time.** Runtime code trusts validated types. Never re-validate config in hot paths.

### SQL Safety

- **All SQLite queries use prepared statements.** The `AuditStore` pre-compiles statements in the constructor. Never concatenate user input into SQL strings.
- **Query parameters from the dashboard API** (tool name filters, session ID filters, date ranges) are passed as bound parameters, never interpolated.
- **The audit database path is resolved and validated** at startup. It must not be user-controllable at runtime.

### Network Boundaries

- **Sideband API (SDK port 3200):** Binds to `sdk.host` (default `127.0.0.1`). Accepts evidence submissions and context from the Python SDK. When started via `helio start`, the CLI provisions a per-boot `HELIO_SDK_TOKEN` and the sideband enforces `Authorization: Bearer <token>` for all routes except `GET /healthz` (constant-time check via `auth/bearer.ts`). Non-loopback binds are allowed but emit startup warnings and should be tightly network-restricted.
- **Dashboard API (port 3100):** Binds to `127.0.0.1` by default. Serves the React SPA and the REST/SSE API for the dashboard. When `dashboard.api_secret` is set, the API supports either cookie-session auth (secret login via `dashboard/session.ts`, CSRF token issued) or direct `Authorization: Bearer` auth. For mutating routes (approve/deny/break-glass), `x-helio-csrf` is required when authenticating via cookie session; bearer-authenticated callers are not CSRF-gated. `dashboard.api_secret` is mandatory whenever any rule uses `require_approval` (or the dashboard is enabled), unless `dashboard.allow_open_mode` is explicitly set.
- **Approvals API:** Mounted under `/api/approvals` on the dashboard sideband; bearer/session-protected the same way. Webhook approval callbacks must be able to reach `/api/approvals/:id/approve`, so a loopback-only sideband + webhook channel triggers a startup warning (`startup-warnings.ts`).
- **Proxy listener (port 3000):** The MCP proxy endpoint. May be exposed to the network in production, but only behind a reverse proxy with TLS termination. Header forwarding to upstream is allowlist-gated (`transport/forward-headers.ts`): `authorization` always passes; other custom headers must be `x-*` and explicitly allowlisted in config.
- **Upstream connections:** The proxy connects to upstream MCP servers. Upstream URLs from config are trusted, but responses are validated before being returned to the agent.

### Approval Security

- **Approval timeout defaults to deny.** A timed-out approval blocks the action. This is the safe default.
- **Break-glass overrides require a reason string.** The reason is recorded in the audit trail. Break-glass actions are logged as a distinct decision type.
- **Webhook approval channels validate the response shape** before applying the decision. Malformed webhook responses default to deny.
- **Slack interactive actions use the Slack SDK's built-in verification.** Never process unverified Slack payloads.

### Policy Engine Integrity

- **Policy evaluation is pure.** No I/O, no side effects, no async operations during rule matching. The engine receives a compiled policy and a match context, and returns a decision synchronously.
- **Hot-reload is atomic.** The config watcher compiles the new policy set fully before swapping. If compilation fails, the old policy set remains active. There is never a window where no policy is loaded.
- **Rate limiter and spend limiter use injectable clocks** for testability. In production they use `Date.now()`. Never use `new Date()` in hot paths.

## Testing Standards

- **Unit tests** colocated as `*.test.ts` next to source
- **Integration tests** in `__tests__/` — spin up real servers on dynamic port 0
- **Vitest globals** enabled — `describe`, `it`, `expect` available without import (though explicit imports from `vitest` also work)
- **Test helpers** in `__tests__/helpers/`:
  - `makeConfig()` — builds valid `HelioConfig` with test defaults + partial overrides
  - `sendMcpRequest()` — sends JSON-RPC requests to a running proxy
  - `startOnDynamicPort()` — starts Hono app on port 0, returns port + close()
  - `McpTestServer` — mock upstream returning canned tools/list and tools/call responses
- **Policy tests** use inline `compilePolicies()` + `ctx()` helper for match context
- **AuditStore tests** use `:memory:` SQLite databases, `cleanupIntervalMs: 0`
- **No mocking libraries** — use real implementations or simple test stubs
- **Security-critical paths require explicit tests:** policy denials, evidence validation failures, approval timeouts, malformed JSON-RPC rejection, SQL injection prevention, rate limit enforcement at boundaries

## Commands

```bash
pnpm --filter @gethelio/proxy test        # Run all proxy tests (vitest run)
pnpm --filter @gethelio/proxy test:watch  # Vitest watch mode
pnpm --filter @gethelio/proxy typecheck   # tsc --noEmit
pnpm --filter @gethelio/proxy build       # Build library + CLI (tsup)
pnpm --filter @gethelio/proxy dev         # Dev mode with watch (tsup --watch)
pnpm --filter @gethelio/proxy benchmark   # Run performance benchmark (tsx scripts/benchmark.ts)
```

## Code Standards

- Named exports by default in runtime/source modules; default exports are acceptable in tooling/config files (e.g. Vitest/tsup configs)
- JSDoc on public runtime APIs (exported functions, classes, and externally-consumed types), with extra detail where behavior is non-obvious
- Section separators: `// ---...` comment blocks between logical sections
- Error types extend Error with structured data (e.g. `ConfigError.details`, `PolicyParseError`)
- Async operations return Promises; sync operations (policy eval, audit store queries) stay sync for performance
- `readonly` on all interface fields and array types
- Config validation happens once at load time; runtime code trusts validated types

## CLI Commands

| Command                                                                                                     | Description                                                                                        |
| ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `helio start [-c path] [--no-hot-reload]`                                                                   | Load config, compile policies, start proxy server (`--no-hot-reload` disables config-watch reload) |
| `helio init [-o path] [-f]`                                                                                 | Scaffold helio.yaml with commented defaults                                                        |
| `helio validate [-c path]`                                                                                  | Validate config + compile policies, report errors/warnings                                         |
| `helio export [-c path] [-f format] [--tool] [--decision] [--reason] [--session] [--from] [--to] [--limit]` | Export audit records as JSON or CSV                                                                |

## Performance Constraints

These are hard requirements — every change must preserve them:

- Policy evaluation: <1ms
- Total proxy overhead: <5ms p99
- Audit writes: 0ms impact on request path (must be async/non-blocking)
- Pass-through (non-tool methods): <0.5ms
