# Running Helio as a Sidecar

This is a **deployment pattern, not a tutorial.** It shows the one topology that
makes Helio's governance impossible for an agent to bypass, with a copy-paste
Docker Compose setup that implements it.

**Who it's for:** you already know roughly what Helio does — if not, start with
the [README](../README.md) or [Getting Started](./getting-started.md) — and you
want to run it for real alongside a coding agent or dev container, not just try
the [5-minute demo](../docker/README.md).

**What you get:** every MCP (Model Context Protocol) tool call the agent makes is
forced through Helio's policy engine, approvals, and audit trail. The agent can't "just do the thing";
it has to go through governance. Everything below exists to guarantee that one
property.

## Why a sidecar — the one rule that makes it work

A proxy only governs what is **forced through it.** If the agent can open a
connection to the tool server directly, it just goes around Helio, and the audit
log records only the calls that happened to pass through — a comforting fiction.
So the whole design reduces to one requirement: the agent must have **no network
path to the upstream MCP server except through Helio.**

You get that with two Docker networks and Helio as the only bridge between them:

```
┌─────────────────┐        ┌──────────────┐        ┌────────────────────┐
│  coding agent   │  MCP   │              │  MCP   │  upstream MCP       │
│  (dev container)│ ─────► │    Helio     │ ─────► │  server             │
│                 │  :3000 │  (sidecar)   │  :8080 │  (internal only)    │
└─────────────────┘        └──────────────┘        └────────────────────┘
        │                         │                          ▲
        │   can reach Helio       │   can reach upstream      │
        └─────────────────────────┘   nothing else can ───────┘
```

Trace who can reach whom:

- **agent → Helio: yes** — they share the `edge` network, so the agent points
  its MCP client at `helio:3000`.
- **agent → upstream: no** — the upstream is only on the `internal` network,
  which the agent is not attached to, so there is simply no route.
- **Helio → upstream: yes** — Helio sits on both networks; it is the only bridge.

That missing route is the whole point. It is not a rule the agent is trusted to
follow; it is a wall Docker enforces. The only way for the agent to reach a tool
is to ask Helio, so every call is governed and logged.

In Docker terms: put the upstream MCP server on an `internal: true` network that
the agent container is not attached to, and attach Helio to both networks.

## Docker Compose recipe

This composes three things on two networks: an `edge` network the agent shares
with Helio, and an `internal` network only Helio and the MCP server share.

<!-- helio-config-guard: skip -->

```yaml
# compose.yaml
services:
  # Your coding agent / dev container. It can reach `helio:3000` and nothing
  # else MCP-related. Point the agent's MCP client at http://helio:3000/mcp.
  agent:
    build: ./agent # your existing dev container
    networks: [edge]
    # ...your agent config...

  helio:
    image: ghcr.io/gethelio/helio:latest # or build from docker/Dockerfile
    networks: [edge, internal]
    environment:
      HELIO_DASHBOARD_SECRET: '${HELIO_DASHBOARD_SECRET:?generate with: openssl rand -hex 32}'
    volumes:
      - ./helio.sidecar.yaml:/config/helio.yaml:ro
      - helio-data:/data
    ports:
      # Dashboard on loopback only — operator control plane, never the LAN.
      - '127.0.0.1:3100:3100'
    depends_on:
      mcp-server:
        condition: service_started
    restart: unless-stopped

  mcp-server:
    image: your-org/your-mcp-server:latest
    networks: [internal] # NOT on `edge` — the agent cannot reach this directly
    restart: unless-stopped

networks:
  edge: {}
  internal:
    internal: true # no outbound route; reachable only by attached services

volumes:
  helio-data: {}
```

> **Apple Silicon / arm64:** the currently published image (`0.7.0`) is
> `linux/amd64` only, so `docker compose up` (or `docker pull`) fails on arm64
> hosts with a `no matching manifest` error. The next release ships multi-arch
> images; until then, either add `platform: linux/amd64` to the `helio` service
> above (it runs under emulation) or build from `docker/Dockerfile`.

Note what is and isn't published:

- **`mcp-server` has no `ports:`** — it is never published to the host or the
  agent. Only `helio` (attached to `internal`) can reach it.
- **`helio` publishes only `:3100`, bound to `127.0.0.1`** — the dashboard is the
  operator control plane and must stay on loopback (see the
  [security model](../docker/README.md#security-model)). The agent reaches the
  `:3000` MCP edge over the `edge` Docker network by service name, so `:3000`
  does not need to be published to the host at all.

The matching Helio config points upstream at the MCP server by its compose
service name:

```yaml
# helio.sidecar.yaml
version: '1'

upstream:
  url: 'http://mcp-server:8080/mcp' # compose service name on the internal network
  transport: streamable-http

listen:
  port: 3000
  host: '0.0.0.0' # bind inside the container namespace; not published to host

policies:
  default: allow
  rules:
    # Deny anything the tool marks as destructive.
    - name: block-destructive
      match:
        annotations:
          destructiveHint: true
      action: deny
      feedback:
        message: 'Destructive actions are blocked by policy.'
        suggestion: 'Use a non-destructive alternative or request approval.'
    # Allow read-only tools.
    - name: allow-reads
      match:
        annotations:
          readOnlyHint: true
      action: allow

audit:
  storage: sqlite
  path: /data/helio-audit.db
  retention: 90d
  include_responses: true

dashboard:
  enabled: true
  port: 3100
  host: '0.0.0.0'
  api_secret: '${HELIO_DASHBOARD_SECRET}'
```

This sample **denies** destructive tools outright. To require human approval
instead — an operator approves or denies each destructive call from the
dashboard — change that rule's `action` to `require_approval` and add an
`approval:` section with a `dashboard` channel. See [Approvals](./approvals.md).

Start it:

```bash
export HELIO_DASHBOARD_SECRET="$(openssl rand -hex 32)"
docker compose up
```

Then point the agent's MCP client at `http://helio:3000/mcp` instead of the MCP
server directly. The dashboard is at `http://localhost:3100`.

## VS Code Dev Containers

If your agent runs inside a [VS Code dev container](https://containers.dev), add
Helio and the upstream MCP server as sidecar services with Docker Compose and
keep the upstream server off the network your dev container is attached to.

`.devcontainer/devcontainer.json`:

```jsonc
{
  "name": "agent-workspace",
  "dockerComposeFile": "../compose.yaml",
  "service": "agent", // VS Code attaches to the agent service above
  "workspaceFolder": "/workspace",
  "forwardPorts": ["helio:3100"], // the dashboard runs on the helio service; never forward the MCP port
}
```

The dashboard runs on the `helio` service, not `agent` — that is why the forward
is qualified as `helio:3100`. The compose file already publishes it to
`127.0.0.1:3100` on the host, so locally you can just open `localhost:3100`; the
`forwardPorts` entry makes VS Code Dev Containers forward it explicitly. GitHub
Codespaces does not support the `host:port` form of `forwardPorts`, so there drop
the entry and use the auto-forwarded published port (it appears in the Ports
panel).

Inside the dev container, configure your MCP client (Claude Desktop, an SDK, or
the agent framework you use) with the URL `http://helio:3000/mcp`. Because the
dev container is only on the `edge` network, it has no route to `mcp-server` and
must go through Helio.

> **Don't** add `mcp-server` to `forwardPorts` or to the `edge` network. Doing so
> hands the agent a direct path to the upstream and defeats the point of the
> sidecar.

## Verifying the agent can't bypass Helio

From inside the agent / dev container, confirm the upstream is unreachable
directly but reachable through Helio:

```bash
# Directly hitting the upstream should fail (no route / refused):
curl -sS -m 3 http://mcp-server:8080/mcp ; echo "exit: $?"

# Through Helio it should succeed and be audited:
curl -sS -X POST http://helio:3000/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

If the first command connects, your network isolation is wrong — the upstream is
reachable from the agent and governance can be bypassed.

## Troubleshooting

**`Upstream MCP server at http://mcp-server:8080/mcp is unreachable — is it running?`**
Helio started before the upstream was ready, or the upstream isn't on the
`internal` network. Helio retries priming (the startup fetch of the upstream's
tool list) with backoff and stays fail-closed (calls it can't verify are denied)
until the upstream answers, so once the MCP server is up the proxy recovers on
its own. Check that `mcp-server` is attached to the
`internal` network and that `upstream.url` matches its compose service name and
port.

## Related

- [Docker quickstart](../docker/README.md) — the demo stack and full security model
- [Getting Started](./getting-started.md) — config, policies, and the dashboard
- [Configuration Reference](./configuration.md) — every `helio.yaml` field
