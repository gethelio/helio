# Dependency Rationale

This document records the purpose and justification for every direct production dependency in the Helio project. Helio sits in the critical path of every agent action — a compromised dependency is a compromised enterprise. Every dependency must earn its place.

## @gethelio/proxy

### Production Dependencies

| Package             | Purpose                                                    | Why this package?                                                                     |
| ------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `@hono/node-server` | Node.js HTTP adapter for Hono                              | Required by Hono for Node.js runtime; maintained by the Hono team                     |
| `@slack/web-api`    | Slack API client for approval notifications                | Official Slack SDK; sends interactive messages with Approve/Deny buttons              |
| `better-sqlite3`    | SQLite driver for audit log storage                        | Fastest synchronous SQLite binding for Node.js; native addon (requires C++ toolchain) |
| `chokidar`          | File system watcher for config hot-reload                  | Industry standard cross-platform file watching; used to detect `helio.yaml` changes   |
| `commander`         | CLI argument parsing (`helio start`, `helio init`, etc.)   | Most widely used Node.js CLI framework; stable, well-maintained                       |
| `hono`              | HTTP framework for the proxy and dashboard API servers     | Lightweight, fast, web-standard Request/Response API; supports SSE natively           |
| `js-yaml`           | YAML parser for `helio.yaml` configuration                 | Standard YAML parser; no native dependencies                                          |
| `picomatch`         | Glob pattern matching for policy rule tool name matchers   | Fast, well-tested glob matching; subset of micromatch with no dependencies            |
| `safe-regex2`       | Rejects ReDoS-prone regex patterns at policy load time     | Fastify-maintained static analyzer; blocks nested-quantifier patterns before compile  |
| `zod`               | Schema validation for config, policy rules, and API inputs | TypeScript-first schema validation; also required by the MCP SDK                      |

The dashboard source lives in the internal workspace package `packages/dashboard`, but that package is not published and is not a runtime dependency of `@gethelio/proxy`. Proxy build scripts bundle dashboard static assets into `packages/proxy/dist/dashboard-assets/` before publish.

### Dev Dependencies (not shipped to consumers)

| Package                     | Purpose                                                                  |
| --------------------------- | ------------------------------------------------------------------------ |
| `@modelcontextprotocol/sdk` | MCP protocol types and test server utilities                             |
| `@types/*`                  | TypeScript type definitions for better-sqlite3, js-yaml, node, picomatch |
| `tsup`                      | TypeScript bundler (produces dist/cli.js and dist/index.js)              |
| `tsx`                       | TypeScript execution for benchmark scripts                               |
| `vitest`                    | Test runner                                                              |

## @gethelio/dashboard

### Production Dependencies

| Package        | Purpose                                                   | Why this package?                                                |
| -------------- | --------------------------------------------------------- | ---------------------------------------------------------------- |
| `react`        | SPA rendering framework (bundled into `dist/assets/*.js`) | Industry-standard UI runtime                                     |
| `react-dom`    | DOM reconciler for `react`                                | Required peer of `react`                                         |
| `react-router` | Client-side routing for the 5 dashboard pages             | Declarative, data-router-compatible, no external state libraries |
| `recharts`     | Time-series, pie, and bar charts on the Analytics page    | Pure React, composable, no global theme context                  |

These packages are **bundled** into dashboard static files at build time (`dist/assets/*.js`) and then copied into `@gethelio/proxy` (`dist/dashboard-assets/`) during proxy build. They remain listed as `dependencies` (not `devDependencies`) in this workspace package so CycloneDX SBOM generation with `--omit=dev` still captures the shipped frontend dependency tree.

### Dev Dependencies (build-only)

`vite`, `@vitejs/plugin-react`, `typescript`, `tailwindcss`, `@tailwindcss/vite`, `@types/*`, `vitest`, `jsdom`, and `@testing-library/react` are used during the Vite build step and the test run. None of their code ships in `dist/`.

## helio (Python SDK)

| Package | Purpose                                             | Why this package?                                                                     |
| ------- | --------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `httpx` | HTTP client for SDK-to-proxy sideband communication | Modern async-capable HTTP client; lighter than requests; supports both sync and async |

All HTTP errors are wrapped in the SDK's `HelioError` exception class with actionable context (method, endpoint, status code). Raw `httpx` exceptions are never exposed to SDK consumers.

## Version Pinning Policy

### npm packages

All versions are pinned to exact versions (no `^` or `~` ranges). This prevents supply chain attacks via malicious patch releases. Dependabot is configured to propose weekly version bump PRs, which are reviewed before merging.

The `.npmrc` file sets `save-exact=true` so that future `pnpm add` commands automatically pin to exact versions.

### Python SDK

- **Runtime dependency** (`httpx>=0.27`): Uses `>=` lower bound per standard Python library convention. Pinning with `==` would cause pip resolver conflicts for consumers who need a different httpx version.
- **Dev dependencies** (`pytest`, `respx`): Pinned with `==` since they don't affect consumers.

### GitHub Actions

Action versions are pinned to major version tags (e.g., `@v4`). Dependabot proposes weekly updates for action version bumps.

### pnpm overrides

The `pnpm-workspace.yaml` file includes overrides to patch known vulnerabilities in transitive dependencies when upstream packages haven't released fixes yet.
