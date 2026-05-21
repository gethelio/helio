# @gethelio/dashboard

The operator UI for the [Helio MCP governance proxy](https://github.com/gethelio/helio). A React 19 + Vite single-page app that renders the live tool-call feed, audit search, policy decision analytics, rate/spend limit state, and the approval queue.

This package is consumed by `@gethelio/proxy` — when you run `helio start` with `dashboard.enabled: true`, the proxy serves the dashboard's static assets directly. This workspace package is internal and is not published separately.

## Role in the Helio stack

```
┌───────────────┐        ┌────────────────────┐
│  Operator     │        │  @gethelio/proxy   │
│  (browser)    │◀─HTTP──│  dashboard sideband │
│               │        │  port 3100          │
└───────────────┘        └─────────┬──────────┘
         ▲                          │ serves bundled dist/dashboard-assets/
         │                          │
         │        ┌─────────────────▼──────────────┐
         └────────│  @gethelio/dashboard (this pkg)│
          static  │  React SPA, built by Vite      │
          assets  └────────────────────────────────┘
```

During `@gethelio/proxy` build, this package is built first and its static output is copied into `packages/proxy/dist/dashboard-assets/`. At runtime the proxy serves that bundled copy (not this workspace path directly). All data is fetched via the sideband API on port `3100` under `/api/*`.

## How authentication flows to the SPA

When `dashboard.api_secret` is configured, the dashboard sideband enforces auth on all `/api/*` routes except `/api/health`, `/api/auth/session`, and `/api/auth/logout`.

Browser flow:

1. The SPA checks session state via `GET /api/auth/session`.
2. If locked, user submits the secret via `POST /api/auth/session`.
3. The proxy validates the secret, sets an HTTP-only session cookie, and returns the authenticated session envelope (`auth_required`, `authenticated`, `expires_at`, `csrf_token`).
4. The SPA keeps the CSRF token in memory and sends it as `x-helio-csrf` on mutating requests.

Machine clients can still authenticate with `Authorization: Bearer <dashboard.api_secret>` directly.

See `packages/proxy/src/dashboard/api.ts` for the auth/session middleware and `packages/dashboard/src/api.ts` for the client-side session + CSRF handling.

## Detail panel truncation + history safety

Dashboard detail views can receive arbitrarily large payloads from upstream tools and approval inputs. The UI now applies consistent 4 KB preview caps via `stringifyForDisplay()` / `truncateForDisplay()` in `src/utils.ts`:

- `AuditDetailPanel` truncates `tool_input`, `upstream_response`, and `upstream_error`.
- `ApprovalsPage` truncates `tool_input` in both pending and resolved detail rows.

This protects the browser from expensive mega-string renders while keeping operators aware that the preview is truncated. The full audit record remains available through CLI/API export paths (`helio export`, `GET /api/audit/export`).

Approvals history loading is additionally safety-capped at 5,000 rows in the current implementation. When that cap is reached, the page renders an explicit warning banner so older entries are never silently omitted.

This package does not ship any runtime JavaScript module exports. Proxy runtime serving uses bundled static assets copied into `@gethelio/proxy` during build.

## Standalone development

The dashboard ships with a Vite dev server for iterative work, but it is **not** a full app on its own — every API call it makes goes to a running Helio proxy on `http://localhost:3100`.

```bash
# From the monorepo root, in one terminal:
pnpm --filter @gethelio/proxy dev

# In another terminal:
pnpm --filter @gethelio/dashboard dev
```

Open the Vite URL (default `http://localhost:5173`). If your proxy has `dashboard.api_secret` set, the app shows the lock screen first; enter the secret and the proxy establishes a cookie session automatically. If your proxy has no `api_secret` configured, the app goes straight to the dashboard.

## Scripts

| Script           | Purpose                      |
| ---------------- | ---------------------------- |
| `pnpm dev`       | Vite dev server with HMR     |
| `pnpm build`     | Vite production build        |
| `pnpm preview`   | Preview the production build |
| `pnpm typecheck` | `tsc --noEmit`               |
| `pnpm test`      | Vitest run                   |

## Links

- **[Helio monorepo](https://github.com/gethelio/helio)** — top-level project README, contribution guide, and issue tracker
- **[Proxy package](https://github.com/gethelio/helio/tree/main/packages/proxy)** — the server that actually serves this SPA
- **[Getting Started](https://github.com/gethelio/helio/blob/main/docs/getting-started.md)** — end-to-end setup including dashboard
- **[Audit trail docs](https://github.com/gethelio/helio/blob/main/docs/audit.md)** — what the audit tab shows and how to export it

## License

Apache 2.0
