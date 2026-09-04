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

- **Dashboard sideband port** (default `127.0.0.1:3100`, configurable via `dashboard.host` / `dashboard.port`). Serves the operator UI, the audit feed, the analytics endpoints, the unified rate/spend limit status (`/api/limits`), and the approval REST API (`/api/approvals`). **This port is the operator control plane.** It is bound to localhost by default. With `dashboard.api_secret` set, every `/api/*` endpoint except `/api/health`, `/api/auth/session`, and `/api/auth/logout` requires authentication via either `Authorization: Bearer <secret>` or a dashboard session cookie established by signing in with the secret. This covers both operator reads and approval mutations. Helio refuses to start if a config uses `require_approval` without setting a secret. The port also serves the dashboard's live event stream (`GET /api/events`), which carries a hardcoded cap of 256 concurrent connections, refusing new streams past it and never evicting a live one, mirroring the agent-edge `/sse` bound.

The split exists because an agent on the main MCP port must not be able to self-approve its own pending tickets. Mounting the approval REST API on the operator port (localhost-only by default, mandatory auth) is what enforces that boundary. Production deployments that need to expose the dashboard beyond localhost should set `dashboard.host` to a public address **and** front it with a reverse proxy that performs TLS termination, IP allow-listing, and any additional authentication you require.

The SDK sideband port (default `127.0.0.1:3200`, when `sdk.enabled: true`) is a third internal API for evidence submission from the Python SDK. See `docs/configuration.md` for details.

### Browser-originated traffic on the agent edge

Because the agent edge is bound to loopback by default, the browser on the same machine is part of its threat model: a page an operator visits can address `localhost` even though it cannot read what comes back. Helio requires `Content-Type: application/json` on `/mcp` and `/sse`, and compares the media type essence rather than searching the header for a substring. That distinction is the control: `text/plain`, `multipart/form-data`, and `application/x-www-form-urlencoded` are CORS-safelisted and cross a browser without a preflight, while `application/json` always triggers one that Helio does not answer. Loosening that check to a substring or prefix match re-opens the endpoint to any web page, so treat it as a security boundary rather than protocol hygiene.

The second control is `Origin` validation: any request to `/mcp` or `/sse` carrying an `Origin` header not listed in `listen.allowed_origins` is refused with `403` before it reaches the transport, and the default list is empty, so every `Origin` is refused out of the box. Legitimate MCP clients are non-browser processes and never send one. This closes the DNS-rebinding path on both transports' message endpoints. Rebinding works by keeping the attacker's own hostname in the page's origin while that hostname starts resolving to the proxy, so the browser sees nothing but an ordinary same-origin request. A `POST` carries an `Origin` regardless of that, and its value is still the attacker's hostname, so the request is refused. Rejections are logged server-side (deduplicated and capped, since the origin string is attacker-chosen) and never echoed back in the response. The allowlist is exact-match only and is not CORS support — Helio emits no CORS response headers, so allowlisting an origin does not let a browser read responses; it exists for deployments where a fronting proxy or embedding host injects an `Origin` the operator needs to name.

The residual is requests that carry no `Origin` at all, which nothing at this layer can gate. On the SSE listener — `GET /sse` in singular mode, `GET /sse/<name>` per named upstream (a bare `GET /sse` matches no door there and is refused with `404`, minting nothing) — a browser omits `Origin` on a same-origin request (including one from a DNS-rebound page) and on a no-cors request such as an `<img>` load, so either can still establish a stream. Neither can go on to send a message, for different reasons: a rebound page can read the stream and learn the session id, but the `POST` it would need carries an `Origin` and is refused, while a no-cors load gets an opaque response and never learns the session id at all. A cross-origin `EventSource` or cors-mode `fetch` does send `Origin` and is refused outright. So the residual is stream establishment rather than tool invocation, and the session it mints is bounded: each SSE route caps its concurrent sessions at 1024 — per door, since every route has its own session map — and refuses new streams with `503` past the cap, never evicting a live stream. Established streams are reclaimed on disconnect and, if held open idle, swept within ~150 seconds, so the bound holds regardless of client or fronting-proxy disconnect behavior. Closing the Origin-less path entirely needs `Host` validation, tracked in issue #231.

### Inbound header/body agreement on the agent edge

MCP 2026-07-28 introduces standard request headers (`Mcp-Method`, `Mcp-Name`, and the `MCP-Protocol-Version` header with a `params._meta` mirror) that duplicate facts from the JSON-RPC body, and requires any server that processes the body to reject a request whose headers disagree with it. Helio enforces this on `POST /mcp`: a request claiming protocol version `2026-07-28` must carry the full agreeing header set including the `_meta` mirror, and a present `Mcp-Method` or `Mcp-Name` must agree with the body under any version claim at all. Disagreement is refused with HTTP 400 and JSON-RPC `-32020` before any policy evaluation, and every rejection is recorded in the audit trail under `block_reason: header_mismatch` with the lying header values preserved verbatim.

Helio's own policy engine never trusted these headers — it evaluates the parsed body — so this control does not close a Helio policy bypass. It exists for spec conformance and defense-in-depth: gateways, WAFs, and load balancers in front of Helio may route or filter on the headers, and a header that lies about the body is a deception attempt the audit trail must not be blind to. One deliberate carve-out: under a legacy or absent version claim the `_meta` protocol-version mirror is ignored on purpose. A leftover `_meta` mirror under a legacy header is Helio's own relay shape — the legacy relay leg forwards a modern client's body verbatim under a `2025-06-18` stamp — not a deception this door claims to catch, and rejecting it would break chained Helio deployments. There is no configuration surface: a knob that turns the check off is a knob that silently disables a governance control. A client that claims `2026-07-28` but cannot send the required headers should send a legacy `MCP-Protocol-Version` value or a fully conformant modern request; Helio's governance reads the body either way.

## Process and filesystem boundaries

The network boundaries above describe adversaries that reach Helio over a socket. This section describes the other axis: a process that shares a filesystem, a user account, or a process namespace with the proxy. In the default local install, that includes the governed agent itself: `helio init` and `helio start` run as the same user as the coding agent, and coding agents carry file and shell tools that never pass through Helio.

Helio's enforcement point is a separate process. It is outside the agent's trust domain only when you give it its own user or its own container and keep its config, its secret, and its audit database off the agent's filesystem. Nothing in this section is a property of the software alone. It is a property of where you put the process and its files.

**What the config file controls.** Everything load-bearing for enforcement lives in `helio.yaml`, and most of it reloads live by default: `policies.rules` (including each rule's `evidence`, `limits`, and `approval` blocks), `policies.default`, `policies.dry_run`, `policies.flag_destructive`, `policies.on_tool_drift`, `policies.tool_revalidation`, `policies.install`, and `budgets`. A process that can write the file can change every one of those keys on a running proxy in well under a second without restarting anything, and the proxy does not check who wrote it. The top-level `approval`, `dashboard`, `listen`, `audit`, `sdk`, and `upstream` sections are read at startup only, but changing a rule's `action` from `require_approval` to `allow` is a `policies.rules` edit and takes effect live. Helio governs MCP `tools/call`; it does not govern filesystem writes, so an edit to its own config is not a governed event. `policies.hot_reload: false` moves a write to the next restart; for a process the agent can restart, that is not a closure.

**What the audit trail shows today.** A reload is reported on stderr (`Policy reloaded: ...`) and nowhere else. It is not an audit record, it is not on the dashboard event stream, and no endpoint exposes the policy in force, so a weakened policy is not visible after the fact. Audited reload records, a config hash on every audit row, and an opt-in `HELIO_CONFIG_SHA256` pin that refuses a changed file at reload and at startup are tracked in #341. Until they ship, stderr is the only signal; where the agent can reach the audit file, ship stderr off the box.

**The dashboard secret.** `dashboard.api_secret` gates the operator control plane, including ticket approval. `helio init` writes the SHA-256 digest of the secret into the config, never the secret itself, and `helio secret` prints a fresh secret and digest pair for hand-written configs and for rotation, so read access to a file that holds the digest does not yield a working credential. A plaintext value is still accepted for compatibility and warned about at startup; a file that holds one is as exposed as it was before. Supplying the plaintext through `${HELIO_DASHBOARD_SECRET}` moves it to the proxy's environment, which a same-user process can read. Versions through 0.13.0 stored the plaintext in the file by default; see GHSA-5hpf-j7jh-7x44.

**Which tier you are running.** Four questions decide it: can the agent write the config, can it read the secret, can it restart the proxy or set its environment, and can it write the audit database. If every answer is yes, you are on the detection-only tier, whatever else you have configured. Turning the answers to no is deployment work: run the proxy as a dedicated OS user or in its own container, and keep the config, the secret, and the audit database out of every directory the agent can reach, including bind mounts into the agent's container. The [sidecar recipe](docs/deployment-sidecar.md) keeps the upstream and the config out of the agent container's reach and Helio off the agent's network, so the dashboard is unreachable from the agent by service name or address (a port published to the host stays reachable from containers through Docker Desktop's host gateway; its control-plane routes stay behind the secret and `/api/health` answers without it); the [separate-user recipe](docs/deployment-separate-user.md) turns the four answers to no on one host without containers, with the config, the digest, and the audit database in directories the agent's account cannot read or write and no signal path to the proxy, while the dashboard on the host loopback stays reachable from the agent's account, its control-plane routes behind the secret and `/api/health` answering without it; both end with the checks that prove it.

**Residuals.** A same-user agent can restart the proxy; edit or delete the audit file, which also holds the budget ledger (deleting it resets spend) and which `helio export` reads as written; read the proxy's environment, including `HELIO_SDK_TOKEN` and `HELIO_ADAPTER_TOKEN` when the SDK sideband is enabled; read any other secret the config carries as a literal, such as Slack `bot_token` and `signing_secret` (the Slack action callback is served on the agent-edge port), webhook `url` and `secret`, and static `upstream.headers` values; and, for stdio upstreams, run the server command itself, as can any co-located process that can read the proxy's command line. An agent at any tier can rewrite its own MCP client config to address an HTTP upstream directly; the answer is credential termination (`upstream.headers` with `${VAR}` interpolation, where operator headers override caller headers), which holds only while the sole copy of the credential is in Helio's environment. Evidence grounding at the SDK sideband is cooperative: the proxy checks that an allowlisted evidence key was posted for the session and has not expired, not what it contains, and the SDK token lives in the agent's process by design. Windows is outside this statement: the audit file permission hardening is a no-op there.

## Scope

The following are in scope for security reports:

- The MCP proxy (`@gethelio/proxy`)
- The Python SDK (`helio`)
- The dashboard served by the proxy
- The CLI (`helio` command)
- Official Docker images
- Example configurations shipped in the repository

Third-party dependencies are out of scope, but we appreciate being notified if you discover a vulnerability in a dependency we use so that we can assess the impact.
