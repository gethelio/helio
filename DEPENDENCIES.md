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

These packages are **bundled** into dashboard static files at build time (`dist/assets/*.js`) and then copied into `@gethelio/proxy` (`dist/dashboard-assets/`) during proxy build. They stay listed as `dependencies` (not `devDependencies`) because their code ships in the release artifact. The `sbom.json` attached to each GitHub Release inventories the proxy's production dependency tree as `pnpm-lock.yaml` pins it (`scripts/generate-sbom.sh`), type-definition packages included where a runtime dependency declares them (`@types/node` and `@types/retry` through `@slack/web-api`, `undici-types` through `@types/node`); the bundled frontend tree is in a second asset, `sbom-dashboard.json`, written by the same script for `@gethelio/dashboard` at the tag's version: the four packages above, their transitive dependencies, and the type-definition packages those declare (`@types/d3-*` through `recharts`, `@types/react` and `@types/use-sync-external-store` through `react-redux`), none of whose code is in the bundle. The Docker image holds that same tree and no other package: its `prod-deps` stage installs the proxy's production dependencies alone into an empty modules directory, and `scripts/check-image-inventory.sh` asserts in CI that the image's package directories equal the SBOM's components. The image index also carries an SPDX SBOM attestation per platform, written by BuildKit's syft scanner from the image's filesystem (base image packages included); `scripts/check-image-sbom.sh` asserts in CI and at release that the proxy's tree in it equals that same set.

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

The `pnpm-workspace.yaml` file includes overrides to patch known vulnerabilities in transitive dependencies: when upstream packages haven't released fixes yet, when a fix is released but a lockfile refresh leaves an edge on the old version, and when an exact parent pin holds the tree below the fix.

Current security-patch overrides include `axios` pinned at `1.20.0` for seven advisories inherited via `@slack/web-api` (`GHSA-c29m-xwm3-cm6r`, `GHSA-mghh-pgcx-3jjj`, `GHSA-x97p-jq2g-jp4f`, `GHSA-3pq3-5fj3-cg6v`, `GHSA-542g-h47m-68v8`, `GHSA-m8m8-qj5v-23w3` and `GHSA-r4gj-5m52-g5wh`, all patched in `1.20.0`, on top of the Node-adapter advisories the earlier `1.18.1` pin covered; the Slack SDK's HTTP transport is the one path, used only under a configured Slack channel), `fast-uri` lifted to `3.1.7` through a ranged override (`fast-uri@<3.1.7`) for four host-confusion and SSRF advisories patched in `3.1.6` and two more (port authority injection in `serialize()`, IP-literal bracket confusion) patched in `3.1.7`, on top of the three the earlier `3.1.5` pin covered, and `ip-address` at `10.3.1` for `GHSA-mwp4-54f8-5fhr` (needed because `express-rate-limit`, inherited via `@modelcontextprotocol/sdk`, depends on an exact `10.1.0`, so no range resolution reaches the fix).

`brace-expansion` is lifted to `1.1.20` and `5.0.11`, which clears `GHSA-mh99-v99m-4gvg`, `GHSA-rgw5-rvv9-x895` (a bypass of the former's mitigation), `GHSA-6j4f-fj2g-mc7p` and `GHSA-qhr7-859c-m2p7` (stack exhaustion through uncontrolled recursion, patched `1.1.19` / `5.0.10` and `1.1.20` / `5.0.11`). Every path is dev-only through `minimatch` under `eslint` and `typescript-eslint`. The 1.x line gained a patched release (`1.1.17`, then `1.1.18`) after the original override was written, so `GHSA-mh99-v99m-4gvg` is no longer an audit ignore.

`undici` is lifted to `7.29.1` through a ranged override (`undici@>=7.0.0 <7.29.1`) for `GHSA-rfgv-xxqx-mfg5` (denial of service via an unrequested WebSocket subprotocol) and `GHSA-w293-vg96-wgc3` (TLS certificate validation bypass via dropped connect options in `BalancedPool`). Its only path is `jsdom` under the dashboard's tests, whose `^7.24.5` already admits the fix; the range self-retires once natural resolution reaches `7.29.1` or later.

`nanoid` is lifted to `3.3.18` for `GHSA-2v37-7h3g-55p8` (custom generators can loop indefinitely when size is zero), reached only through `postcss` on dev-tooling paths (`tsup`, `vite`, `vitest`). `postcss`'s `^3.3.17` range does permit the fix; a ranged override (`nanoid@<3.3.18`) carries the lift. The range self-retires: once natural resolution reaches `3.3.18` or later, the override matches nothing.

`source-map-js` is lifted to `1.2.2` for `GHSA-68fv-2mgg-jv7q` (event-loop denial of service while parsing a crafted source map), reached only on dev-tooling paths: `@tailwindcss/node` under the dashboard's `@tailwindcss/vite`, `css-tree` under `jsdom` (both packages' `vitest`), and `postcss` under `vite` (dashboard) and `tsup` (proxy). Every parent range (`^1.2.1`) permits the fix, and a named `pnpm update -r --lockfile-only <pkg>` does move `@tailwindcss/node` and `css-tree`, but the installed `postcss@8.5.26` keeps its dependency `source-map-js: ^1.2.1` resolved at `1.2.1`, so a ranged override (`source-map-js@<1.2.2`) finishes the lift. The range self-retires: `postcss@8.5.29` already wants `^1.2.2`, so once natural resolution reaches `1.2.2` or later the override matches nothing.

`proxy-addr` moved from `2.0.7` to `2.0.8` for `GHSA-jqcg-44mw-7w3h` (IP spoofing through IPv4-mapped IPv6 subnets; dev-only under `express` via `@modelcontextprotocol/sdk`) by a lockfile refresh alone, since `express`'s `^2.0.7` range reached the fix with no override.

When the declared range permits the fix, try a lockfile refresh first (`pnpm update -r --lockfile-only <pkg>`): `proxy-addr` 2.0.8 reached the tree that way with no override. An edge the refresh leaves on the old version still takes an override, in the ranged, self-retiring shape (`postcss@8.5.26`'s dependency edge on `source-map-js`, which no later install finishes). An exact parent pin always does (`express-rate-limit` holding `ip-address` at `10.1.0`). An override ages like any pin: `postcss` had its `8.5.18` pin removed once every consumer range reached the patched line (resolved to `8.5.26`), because the pin had gone stale against `GHSA-fxqj-rqcc-2cmp` and was also holding its `nanoid` dependency below the patched `3.3.17`, which is what let both advisories through.

Vitest is pinned at `4.1.8` across JS workspaces to stay above the `GHSA-5xrq-8626-4rwp` floor, and dashboard `react-router` is pinned at `7.18.2` to stay above both the `GHSA-chx6-hx7r-mcp5` fix and the `GHSA-qwww-vcr4-c8h2` (unstable-RSC-only) fix, so that advisory is no longer an audit ignore. The v8 upgrade remains tracked as a modernization in #204, no longer audit-driven.
