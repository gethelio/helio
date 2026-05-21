# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.x.x   | :white_check_mark: |

We are in active pre-release development. Security fixes will be applied to the latest release only.

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues, discussions, or pull requests.**

Instead, please report them via email to **security@helio.so**.

Include as much of the following as you can to help us understand and resolve the issue quickly:

- A description of the vulnerability and its potential impact
- Step-by-step instructions to reproduce the issue
- Affected versions
- Any potential mitigations you've identified

### What to Expect

- **Acknowledgement** within 48 hours confirming we received your report.
- **Initial assessment** within 5 business days with our evaluation of the severity and an expected timeline for a fix.
- **Regular updates** at least every 7 days until the issue is resolved.
- **Credit** in the release notes and security advisory (unless you prefer to remain anonymous).

We will work with you to coordinate disclosure. We ask that you give us a reasonable window to address the issue before any public disclosure.

## Security Considerations

Helio is a governance proxy that sits in the critical path between AI agents and external systems. We take this position of trust seriously:

- **Policy evaluation** happens locally - your policy rules and audit data never leave your infrastructure.
- **Audit data** is stored in a local SQLite database. Configure `audit.retention` to control how long records are kept.
- **Slack integration** uses the official Slack Web API SDK (`@slack/web-api`) with scoped bot tokens. Helio never requests broader permissions than necessary.
- **No telemetry** - Helio does not phone home, collect analytics, or transmit any data to Helio maintainers or third parties.

## Network Boundaries

Helio runs two HTTP servers on different ports for trust-boundary reasons:

- **Main MCP port** (default `127.0.0.1:3000`, configurable via `listen.host` / `listen.port`). Serves the MCP transport (`/mcp`, `/sse`) and the Slack signature-verified callback (`/slack/actions`). **This port is the agent edge.** Treat any traffic on this port as potentially adversarial - any agent that speaks MCP can reach it, including ones you do not operate. Operator read endpoints (audit feed, approval queue, rate and spend limit status) are deliberately **not** mounted on this port so a compromised agent cannot enumerate operator state.

- **Dashboard sideband port** (default `127.0.0.1:3100`, configurable via `dashboard.host` / `dashboard.port`). Serves the operator UI, the audit feed, the analytics endpoints, the unified rate/spend limit status (`/api/limits`), and the approval REST API (`/api/approvals`). **This port is the operator control plane.** It is bound to localhost by default. With `dashboard.api_secret` set, every `/api/*` endpoint except `/api/health`, `/api/auth/session`, and `/api/auth/logout` requires authentication via either `Authorization: Bearer <secret>` or a dashboard session cookie established by signing in with the secret. This covers both operator reads and approval mutations. Helio refuses to start if a config uses `require_approval` without setting a secret.

The split exists because an agent on the main MCP port must not be able to self-approve its own pending tickets. Mounting the approval REST API on the operator port (localhost-only by default, mandatory auth) is what enforces that boundary. Production deployments that need to expose the dashboard beyond localhost should set `dashboard.host` to a public address **and** front it with a reverse proxy that performs TLS termination, IP allow-listing, and any additional authentication you require.

The SDK sideband port (default `127.0.0.1:3200`, when `sdk.enabled: true`) is a third internal API for evidence submission from the Python SDK. See `docs/configuration.md` for details.

## Scope

The following are in scope for security reports:

- The MCP proxy (`@gethelio/proxy`)
- The Python SDK (`helio`)
- The dashboard served by the proxy
- The CLI (`helio` command)
- Official Docker images
- Example configurations shipped in the repository

Third-party dependencies are out of scope, but we appreciate being notified if you discover a vulnerability in a dependency we use so that we can assess the impact.
