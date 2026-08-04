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

### Browser-originated traffic on the agent edge

Because the agent edge is bound to loopback by default, the browser on the same machine is part of its threat model: a page an operator visits can address `localhost` even though it cannot read what comes back. Helio requires `Content-Type: application/json` on `/mcp` and `/sse`, and compares the media type essence rather than searching the header for a substring. That distinction is the control: `text/plain`, `multipart/form-data`, and `application/x-www-form-urlencoded` are CORS-safelisted and cross a browser without a preflight, while `application/json` always triggers one that Helio does not answer. Loosening that check to a substring or prefix match re-opens the endpoint to any web page, so treat it as a security boundary rather than protocol hygiene.

The second control is `Origin` validation: any request to `/mcp` or `/sse` carrying an `Origin` header not listed in `listen.allowed_origins` is refused with `403` before it reaches the transport, and the default list is empty, so every `Origin` is refused out of the box. Legitimate MCP clients are non-browser processes and never send one. This closes the DNS-rebinding path on both transports' message endpoints. Rebinding works by keeping the attacker's own hostname in the page's origin while that hostname starts resolving to the proxy, so the browser sees nothing but an ordinary same-origin request. A `POST` carries an `Origin` regardless of that, and its value is still the attacker's hostname, so the request is refused. Rejections are logged server-side (deduplicated and capped, since the origin string is attacker-chosen) and never echoed back in the response. The allowlist is exact-match only and is not CORS support — Helio emits no CORS response headers, so allowlisting an origin does not let a browser read responses; it exists for deployments where a fronting proxy or embedding host injects an `Origin` the operator needs to name.

The residual is requests that carry no `Origin` at all, which nothing at this layer can gate. On `GET /sse`, a browser omits `Origin` on a same-origin request (including one from a DNS-rebound page) and on a no-cors request such as an `<img>` load, so either can still establish a stream and mint a session. Neither can go on to send a message, for different reasons: a rebound page can read the stream and learn the session id, but the `POST` it would need carries an `Origin` and is refused, while a no-cors load gets an opaque response and never learns the session id at all. A cross-origin `EventSource` or cors-mode `fetch` does send `Origin` and is refused outright. So the residual is session minting rather than tool invocation. Closing the Origin-less path needs `Host` validation, tracked in issue #231; the unbounded minting it enables is issue #232.

## Scope

The following are in scope for security reports:

- The MCP proxy (`@gethelio/proxy`)
- The Python SDK (`helio`)
- The dashboard served by the proxy
- The CLI (`helio` command)
- Official Docker images
- Example configurations shipped in the repository

Third-party dependencies are out of scope, but we appreciate being notified if you discover a vulnerability in a dependency we use so that we can assess the impact.
