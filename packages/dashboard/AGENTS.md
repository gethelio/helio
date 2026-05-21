# @gethelio/dashboard

Real-time governance dashboard for the Helio proxy. React SPA that displays live action feeds, approval workflows, audit logs, rate/spend limits, and analytics. Bundled into the proxy at build time and served as static files.

## Package Layout

```
src/
├── main.tsx                  → React entry point (StrictMode, mount to #root)
├── App.tsx                   → Auth gate (booting/locked/authenticating/ready) + secret-login form + ErrorBoundary + BrowserRouter + EventSourceProvider + Routes
├── Layout.tsx                → Shell layout (Header + Sidebar + Outlet + disconnected banner, optional onLogout)
├── app.css                   → Tailwind imports + focus ring styling
├── types.ts                  → API type contracts (mirrors proxy API shape)
├── api.ts                    → REST client (apiFetch, qs, authHeaders, ApiError, CSRF token + auth/session helpers)
├── constants.ts              → Decision/outcome filters, chart color map, MS_PER_* + time-range presets
├── outcome.ts                → DisplayOutcome union + helpers that derive/filter audit & feed outcomes
├── utils.ts                  → Formatting helpers (timeAgo, formatLabel, etc.)
├── EventSourceContext.tsx    → SSE context provider (forwards onSessionExpired)
├── useEventSource.ts         → SSE hook (typed subscribe/unsubscribe)
├── useAuditQuery.ts          → Audit filtering + pagination hook
├── components/
│   ├── Header.tsx            → Top bar with sidebar toggle + StatusIndicator
│   ├── Sidebar.tsx           → Left nav (Feed/Approvals/Audit/Limits/Analytics)
│   ├── ErrorBoundary.tsx     → Top-level React error boundary
│   ├── PageError.tsx         → Inline per-page error state
│   ├── ActionCard.tsx        → Collapsible tool action record card
│   ├── PolicyBadge.tsx       → Color-coded decision badge
│   ├── ApprovalStatusBadge.tsx → Approval status indicator
│   ├── ApprovalActions.tsx   → Approve/Deny/BreakGlass modal
│   ├── StatusIndicator.tsx   → Connection status + version + uptime
│   ├── DetailSection.tsx     → Collapsible detail pane wrapper
│   ├── EvidenceChain.tsx     → Visual renderer for evidence_chain JSON
│   ├── AuditFilterBar.tsx    → Audit filter controls + JSON/CSV export
│   ├── AuditTable.tsx        → Audit log table + pagination
│   ├── AuditDetailPanel.tsx  → Expanded audit record detail pane
│   ├── TimeSeriesChart.tsx   → Recharts line chart (decisions per hour)
│   ├── DecisionPieChart.tsx  → Recharts pie chart (decision distribution)
│   └── TopToolsChart.tsx     → Recharts bar chart (top tools by call count)
└── pages/
    ├── FeedPage.tsx          → Live action stream (SSE + buffer, capped at 500)
    ├── ApprovalsPage.tsx     → Pending + resolved tabs, real-time countdown
    ├── AuditPage.tsx         → Audit log (composes AuditFilterBar + AuditTable + AuditDetailPanel)
    ├── LimitsPage.tsx        → Rate + spend limit gauges (5s polling + SSE)
    └── AnalyticsPage.tsx     → Charts + aggregate stats (1h/24h/7d presets)
```

## Build & Entry Points

Vite SPA build:

- `vite build` → `dist/index.html` + `dist/assets/` (bundled JS + CSS with content hashes)

The proxy build runs this dashboard build first, then copies `packages/dashboard/dist/` into `packages/proxy/dist/dashboard-assets/`. Runtime serving uses the bundled proxy copy, not a runtime import from `@gethelio/dashboard`.

## Tech Stack

- **React** 19 (hooks-based; the one exception is `ErrorBoundary`, a class component since `getDerivedStateFromError`/`componentDidCatch` require it)
- **React Router** 7 (client-side routing, 5 routes)
- **Vite** 6 (dev server + bundler)
- **Tailwind CSS** 4 (@tailwindcss/vite plugin)
- **Recharts** 3 (charts: line, pie, bar)
- **TypeScript** 5 (strict mode, `ES2023` lib; target inherited from the repo base config)
- **Vitest** + **@testing-library/react** (unit + component tests, jsdom)
- **Node** ≥ 22 (`engines.node` in package.json)

No state management library. All state is React hooks (useState, useEffect, useCallback, useMemo, memo).

## API Integration

The dashboard talks to the proxy's sideband API (default port 3100):

| Method                                | Path                                                                   | Purpose |
| ------------------------------------- | ---------------------------------------------------------------------- | ------- |
| `GET /api/health`                     | Proxy health, version, uptime (unauthenticated)                        |
| `GET /api/auth/session`               | Current session state (`auth_required`, `authenticated`, `csrf_token`) |
| `POST /api/auth/session`              | Log in with the dashboard secret                                       |
| `POST /api/auth/logout`               | Log out / clear the session                                            |
| `GET /api/feed`                       | Recent action records (limit/offset)                                   |
| `GET /api/audit`                      | Paginated audit log (tool/decision/session/date filters)               |
| `GET /api/audit/:id`                  | Single audit record detail                                             |
| `GET /api/approvals`                  | Approval tickets (filter by status)                                    |
| `POST /api/approvals/:id/approve`     | Approve a pending ticket                                               |
| `POST /api/approvals/:id/deny`        | Deny a pending ticket                                                  |
| `POST /api/approvals/:id/break-glass` | Break-glass override (reason required)                                 |
| `GET /api/limits`                     | Rate + spend limit states                                              |
| `GET /api/analytics`                  | Aggregated stats (from/to range)                                       |
| `GET /api/evidence/:session_id`       | Session evidence chain                                                 |

Mutating approval requests (approve/deny/break-glass) carry the CSRF token from the session response as an `x-helio-csrf` header; `api.ts` stores the token via `setCsrfToken()` and attaches it through `authHeaders()`. A 401 from any call triggers the registered unauthorized handler (`setUnauthorizedHandler`), which sends the UI back to the locked state.

**Dev proxy:** Vite proxies `/api/*` to `http://127.0.0.1:3100` during development.

**Dev-mode auth gotcha:** when the target proxy is started with `dashboard.api_secret` set, the dashboard starts in a locked state and requires manual secret login (`POST /api/auth/session`) before API calls succeed. Keep the secret handy from `helio.yaml` when iterating locally.

**SSE:** EventSource connects to `/api/events`. Five event types: `action`, `approval_requested`, `approval_resolved`, `approval_notification_failed`, `limit_warning`.

## Type System

Types are defined in `src/types.ts` (not imported from the proxy package). This keeps the packages decoupled at the API boundary. Key types:

- `AuditRecord` — full audit trail entry (24 fields)
- `ApprovalTicket` — approval request state (18 fields, including escalation + notification-failure data)
- `RateLimitKeyState`, `SpendLimitKeyState` — limit gauge data
- `AnalyticsResponse` — aggregated stats + time series + top tools
- `AuthSessionResponse` — session state (`auth_required`, `authenticated`, `csrf_token`)
- `DisplayOutcome` (in `outcome.ts`) — derived outcome union used for badges and filters
- `DashboardEventType` / `DashboardEventMap` — typed SSE event union (action, approval_requested, approval_resolved, approval_notification_failed, limit_warning)

## Security Standards

The dashboard displays sensitive governance data — tool call details, policy decisions, approval workflows, and audit trails. Security is critical even though it runs on localhost by default.

### XSS Prevention

- **Never render raw HTML from API data.** All data from the API is rendered through React's built-in JSX escaping. Tool names, arguments, evidence data, and approval reasons all pass through React's text content rendering — never raw HTML insertion.
- **User-provided filter inputs** (tool name, session ID, date ranges) are URL-encoded via the `qs()` helper before being sent as query parameters. Never interpolate filter values into URLs directly.
- **JSON display in detail panels** (tool arguments, evidence chains, upstream responses) uses `JSON.stringify()` with React text rendering. Never render raw JSON as HTML.

### API Communication

- **All API calls go through `apiFetch()`** which sets `credentials: 'same-origin'`, parses JSON, and normalizes errors into `ApiError`. Never use raw `fetch()` for API endpoints.
- **Auth state lives in `api.ts`, not in storage.** The CSRF token from the session response is held in a module variable (`setCsrfToken`) and attached to mutating approval calls via the `x-helio-csrf` header; a 401 invokes the unauthorized handler so the UI re-locks. The token is never persisted.
- **API errors are handled gracefully.** Network failures, 4xx responses, and malformed JSON all result in user-visible error states (`PageError`, `ErrorBoundary`), never unhandled exceptions or blank screens.
- **SSE reconnection** is handled by the browser's native EventSource, which reconnects automatically on connection loss. The dashboard shows connection status in the header and a stale-data banner in the layout.

### Data Handling

- **The dashboard never caches sensitive data in localStorage or sessionStorage.** All state is in-memory React state that is cleared on page reload.
- **The FeedPage caps in-memory records at 500** to prevent memory exhaustion during long sessions.
- **Audit record detail is fetched lazily** (only when a card is expanded) to minimize the amount of sensitive data held in memory at any time.

### Approval Actions

- **Approve, deny, and break-glass actions require explicit user interaction** — button click with confirmation. Break-glass requires a reason string via modal before submission.
- **Approval action buttons are disabled while a request is in-flight** to prevent double-submission.
- **Break-glass actions are visually distinct** (warning color, separate modal) to prevent accidental override.

## Key Patterns

**Auth gate:** `App.tsx` runs a small state machine (`booting → locked/authenticating → ready`). On boot it calls `GET /api/auth/session`; if the proxy requires a secret and there's no session it renders the secret-login form instead of the app. A 401 on any later call (or an SSE auth probe failure) flips the UI back to `locked` via the unauthorized handler. Routes/`EventSourceProvider` only mount in the `ready` state.

**Error boundary:** the routed app is wrapped in `<ErrorBoundary>` (top-level render-error fallback); individual pages render `<PageError>` for fetch failures rather than blank screens.

**SSE real-time updates:** `useEventSource` hook wraps the browser EventSource API with typed subscribe/unsubscribe. `EventSourceContext` provides the connection to all pages. Each page subscribes to relevant event types and updates local state.

**Debounced filters:** Text inputs (tool name, session ID) debounce at 300ms before triggering API calls. Filter changes reset pagination to page 1.

**Lazy detail loading:** ActionCard and approval cards fetch the full record only when expanded, avoiding large initial payloads.

**Polling + SSE:** LimitsPage polls every 5s and also listens for SSE `limit_warning` events. Warning events trigger a 10s flash highlight effect.

**Record buffer cap:** FeedPage caps the in-memory record list at 500 entries to prevent memory growth during long sessions.

## Testing Standards

- **Vitest** with `jsdom` environment, globals enabled (`describe`/`it`/`expect` without imports)
- **@testing-library/react** for component rendering and assertions
- User interactions are tested with `fireEvent` from `@testing-library/react` and direct event dispatch where appropriate
- Test files colocated next to source: `ComponentName.test.tsx`, `hook.test.ts`
- Mock `fetch` with `vi.fn()` — no mocking libraries
- Helper functions: `okJson()`, `errResponse()`, `calledUrl()`, `calledInit()` for fetch assertions
- CSS parsing disabled in tests (`css: false` in vitest config)
- **Test approval workflows end-to-end:** approve, deny, and break-glass paths including loading states and error handling
- **Test SSE event handling:** verify that incoming events update component state correctly
- **Test error states:** network failures, API errors, and malformed responses should render gracefully

## Commands

```bash
pnpm --filter @gethelio/dashboard dev          # Vite dev server (proxies /api to :3100)
pnpm --filter @gethelio/dashboard build        # Vite build (dist/)
pnpm --filter @gethelio/dashboard test         # Vitest single run
pnpm --filter @gethelio/dashboard test:watch   # Vitest watch mode
pnpm --filter @gethelio/dashboard typecheck    # tsc --noEmit
```

## Code Standards

- Named exports by default in runtime/source modules; default exports are acceptable in tooling/config files (e.g. Vite/Vitest configs)
- JSDoc on public runtime APIs and non-obvious behavior paths; keep internal UI-only exports well-typed and clearly named
- `memo()` on expensive components (ActionCard, PolicyBadge, ApprovalStatusBadge)
- Tailwind-first styling (no CSS modules or styled-components), with a small global stylesheet in `app.css` for shared baseline affordances (cursor + focus-visible rings)
- Responsive design via Tailwind prefixes (`sm:`, `lg:`)
- Section separators: `// ---...` comment blocks between logical sections
- `readonly` on interface fields
- Components in `src/components/`, pages in `src/pages/`, hooks in `src/`
- No `any` types — use proper TypeScript generics and union types
- Prefer `const` assertions and discriminated unions for API response handling
