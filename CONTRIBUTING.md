# Contributing to Helio

Thanks for your interest in contributing to Helio! This document covers everything you need to get started.

Helio is an open-source MCP governance proxy - we're building the standard way to control what AI agents do to external systems. Every contribution matters, whether it's a bug fix, a new feature, improved docs, or a well-written issue.

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](./CODE_OF_CONDUCT.md). By participating, you agree to uphold it. Please report unacceptable behavior to [hey@helio.so](mailto:hey@helio.so).

## Getting Started

### Prerequisites

- **Node.js** 22 or later
- **pnpm** 10 or later (`npm install -g pnpm`)
- **Python** 3.10 or later (`python3 --version`)
- **Git**
- **gitleaks** (recommended) or **Docker** (used as fallback by secret scan scripts)

### Setting Up the Dev Environment

1. Fork the repository and clone your fork:

```bash
git clone https://github.com/<your-username>/helio.git
cd helio
```

2. Install dependencies:

```bash
pnpm install
```

3. Build the proxy release artifact (this also builds and bundles dashboard assets):

```bash
pnpm build
```

4. Run the test suite to verify everything works:

```bash
pnpm test
```

The proxy test suite includes Python SDK sideband E2E coverage, so `python3` must be available for the root `pnpm test` path.

5. Start the proxy in development mode (with hot reload):

```bash
pnpm dev
```

### Repository Structure

```
helio/
├── packages/
│   ├── proxy/          # Core MCP governance proxy (npm: @gethelio/proxy)
│   ├── dashboard/      # React dashboard (bundled with proxy)
│   └── python-sdk/     # Python SDK (pip: helio)
├── examples/           # Example configurations
├── docs/               # Documentation
└── docker/             # Docker build files
```

Each Node.js/TypeScript workspace package has its own `package.json`; the Python SDK uses `pyproject.toml`. The monorepo uses pnpm workspaces.

## How to Contribute

### Reporting Bugs

Open a [Bug Report](https://github.com/gethelio/helio/issues/new?template=bug_report.md) issue. Include:

- Steps to reproduce the problem
- What you expected to happen vs. what actually happened
- Your environment (OS, Node.js version, Helio version)
- Relevant config from `helio.yaml` (redact any secrets)
- Logs or error output

### Suggesting Features

Open a [Feature Request](https://github.com/gethelio/helio/issues/new?template=feature_request.md) issue. Describe the problem you're trying to solve, not just the solution you have in mind - this helps us find the right approach.

### Submitting Code

1. **Find or create an issue.** Check existing issues first. If you want to work on something, comment on the issue to let others know. Issues labeled `good-first-issue` are specifically scoped for new contributors.

2. **Create a branch** from `main`:

```bash
git checkout -b feat/your-feature-name
# or
git checkout -b fix/your-bug-fix
```

Use the prefixes: `feat/`, `fix/`, `docs/`, `refactor/`, `test/`, `chore/`.

3. **Write your code.** Follow the coding standards below.

4. **Write or update tests.** Every new feature needs tests. Every bug fix needs a regression test. Run the full suite before pushing:

```bash
pnpm test
```

5. **Run linting, formatting, type checks, and secret scan:**

```bash
pnpm lint
pnpm format:check
pnpm typecheck
pnpm secrets:scan
```

6. **Commit with a clear message.** We use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(proxy): add approval escalation delegates
fix(dashboard): correct timezone display in audit log
docs: update policy matching examples
test(proxy): add rate limiter edge case coverage
```

7. **Push and open a Pull Request** against `main`. Fill in the PR template. Link the related issue.

### Pull Request Process

- PRs require at least one approving review from a maintainer before merge.
- CI must pass (secret scan, docs drift check, dependency audit, build, lint, format:check, typecheck, tests, Docker build).
- Keep PRs focused - one logical change per PR. If you're fixing a bug and also refactoring nearby code, split them into two PRs.
- We aim to review PRs within 48 hours. If yours is waiting longer, comment on the PR or open a discussion.

## Coding Standards

### TypeScript

- **Strict mode** is enabled. No `any` types unless absolutely necessary (and commented explaining why).
- Use **Zod** for runtime validation of external inputs (config, tool call parameters, API responses).
- Prefer **named exports** over default exports.
- Use **async/await** rather than raw Promises with `.then()`.
- Keep functions small and testable. If a function is longer than ~50 lines, consider breaking it up.

### Formatting

- **ESLint** and **Prettier** are configured in the repo. Run `pnpm lint` to check, and `pnpm format` to auto-fix formatting (Prettier). ESLint findings must be resolved by hand.
- Don't bikeshed formatting in reviews - if Prettier accepts it, it's fine.

### Testing

- We use **Vitest** for JavaScript/TypeScript packages and **pytest** for the Python SDK.
- Test files live alongside the source: `engine.ts` → `engine.test.ts`.
- Aim for meaningful coverage of behavior, not line-count metrics. Test the cases that matter: happy path, error cases, and edge cases around policy matching and transaction controls.
- Integration tests that spin up the proxy and send real MCP requests go in `packages/proxy/src/__tests__/`.

### Performance

The proxy sits in the critical path of every agent tool call. Performance matters.

- Policy evaluation must stay under **1ms**.
- Audit writes must be **async and non-blocking**: never add latency to the tool call path.
- If you're adding a dependency, consider its impact on startup time and memory.

### Dependencies & supply-chain audits

Helio is a security tool, so the dependency tree is part of the threat model — npm
supply-chain campaigns (e.g. the 2026 TeamPCP wave) compromise **dev, build, and
transitive** packages, not just production ones, with install-time code execution.
Our audit posture reflects that:

- **Coverage is always the full tree** (dev + build + transitive). We never scope
  the audit to production-only — build tooling produces the shipped bundle and runs
  in CI with credentials, so it is in scope.
- **`pnpm audit --audit-level=high` is enforced unconditionally on `main`, on every
  release (`release.yml`), and daily (`security-audit.yml`).** These are the
  guarantees: a flagged dependency can never be merged to `main` unnoticed or
  shipped in a release.
- **On a pull request, the audit runs only when the PR changes a dependency
  manifest or install input** — `package.json`, `pnpm-lock.yaml`,
  `pnpm-workspace.yaml`, `.npmrc`, `.pnpmfile.*` (install hooks), or anything under
  `patches/`. With `--frozen-lockfile`, leaving all of these unchanged means an
  unchanged installed tree, so an unrelated feature PR is not blocked by a
  newly-published advisory on a dependency it never touched. The check still reports
  green with a notice explaining the skip. The guard **fails closed** — any
  uncertainty (unknown event, missing base SHA, diff/grep error) runs the audit. If
  you add a new install-affecting input (e.g. a new pnpm hook mechanism), add it to
  the trigger set in `ci.yml`.
- **Dependabot security updates** is enabled so advisories on the standing tree are
  auto-PR'd within hours rather than discovered by a CI failure.
- **This gate's integrity depends on branch protection.** `main` must require the
  `ci` status check and code-owner review (workflow files are owned via CODEOWNERS),
  with admin bypass disabled — otherwise a PR could weaken the workflow itself. Treat
  those settings as part of the control, not optional.

**Handling an advisory — triage by _type_, not just dev-vs-prod:**

- A **malicious package, install-time RCE, or credential-exfiltration** advisory is
  an **incident** regardless of whether the package is dev-only or shipped — remediate
  immediately (upgrade, or remove), do not ignore.
- A **benign vulnerability with no exploit path in our usage** (e.g. a dev-server
  SSRF or ReDoS in a build tool we only invoke on trusted input) may be **time-boxed
  ignored** via `pnpm.auditConfig.ignoreGhsas`, but **only** with a tracking issue to
  remove it. Prefer a real upgrade over an ignore.

Current dev-only ignores (each tracked for removal):

| GHSA                  | Package (path)                      | Why ignored                                                                                                           | Tracking |
| --------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------- |
| `GHSA-gv7w-rqvm-qjhr` | esbuild (via vite, dashboard build) | dev-server request vuln; not in the shipped bundle                                                                    | #64      |
| `GHSA-fx2h-pf6j-xcff` | vite (dashboard build)              | dev-server only; vite is not run in production                                                                        | #64      |
| `GHSA-vmh5-mc38-953g` | undici (via `jsdom`, test env)      | SOCKS5 ProxyAgent TLS path, not exercised in tests; no patched undici is compatible with `jsdom@29`'s internal layout | #64      |

## Issue Labels

| Label              | Meaning                                      |
| ------------------ | -------------------------------------------- |
| `good-first-issue` | Scoped and approachable for new contributors |
| `bug`              | Something isn't working correctly            |
| `feature`          | New functionality                            |
| `docs`             | Documentation improvements                   |
| `performance`      | Latency or resource usage                    |
| `policy-engine`    | Related to YAML policy evaluation            |
| `approvals`        | Related to approval workflows                |
| `audit`            | Related to the audit trail                   |
| `dashboard`        | Related to the React dashboard               |
| `sdk`              | Related to the Python SDK                    |
| `help-wanted`      | We'd welcome community help on this          |
| `wontfix`          | Considered and decided against               |

## Development Tips

**Running a single package's tests:**

```bash
pnpm --filter @gethelio/proxy test
```

**Building and testing the dashboard:**

```bash
pnpm --filter @gethelio/dashboard build
pnpm --filter @gethelio/dashboard test
```

**Running Python SDK tests:**

```bash
cd packages/python-sdk
pip install -e '.[dev]'
pytest
```

**Testing against a real MCP server:**

The `examples/basic/` directory includes a minimal setup with a test MCP server. Start it with:

```bash
cd examples/basic
pnpm start
```

**Checking your changes end-to-end:**

```bash
pnpm secrets:scan && pnpm docs:check:ci && pnpm audit --audit-level=high && pnpm build && pnpm test && pnpm lint && pnpm format:check && pnpm typecheck
```

If all checks pass, your PR is likely in good shape.

## Getting Help

- **GitHub Issues:** Bug reports, feature requests, and questions
- **GitHub Discussions:** For longer-form questions or design proposals

## License

By contributing to Helio, you agree that your contributions will be licensed under the [Apache 2.0 License](./LICENSE).
