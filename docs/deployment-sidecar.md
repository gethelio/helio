# Running Helio as a Sidecar

This guide shows how to run Helio in its **own container, next to your coding
agent**, so every MCP tool call the agent makes is forced through Helio's
policy engine and audit trail. This is the deployment most teams actually want:
the agent can't "just do the thing" — it has to go through governance.

It is different from the [Docker quickstart](../docker/README.md), which is a
5-minute demo with a throwaway echo server. Here the goal is a real topology you
can drop next to an existing development container.

## The one rule that makes this work

Governance only holds if the agent **cannot reach the upstream MCP server
directly**. If the agent can open a socket to the MCP server itself, it will
bypass Helio entirely and the audit trail becomes fiction.

So the topology is:

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

- The agent gets one address: Helio's edge at `:3000`.
- Helio is the **only** thing on the network that can reach the upstream MCP
  server.
- The upstream server is on an **internal** network with no route to the agent.

In Docker terms: put the upstream MCP server on an `internal: true` network that
the agent container is not attached to.

## Docker Compose recipe

This composes three things on two networks: an `edge` network the agent shares
with Helio, and an `internal` network only Helio and the MCP server share.

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
    command: ['node', 'packages/proxy/dist/cli.js', 'start', '-c', '/config/helio.yaml']
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

> **Apple Silicon / arm64:** the published image is currently `linux/amd64` only,
> so `docker compose up` (or `docker pull`) fails on arm64 hosts with a
> `no matching manifest` error. Until multi-arch images ship
> ([#101](https://github.com/gethelio/helio/issues/101)), either add
> `platform: linux/amd64` to the `helio` service above (it runs under emulation)
> or build from `docker/Dockerfile`.

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

dashboard:
  enabled: true
  port: 3100
  host: '0.0.0.0'
  api_secret: '${HELIO_DASHBOARD_SECRET}'

policies:
  default: allow
  flag_destructive: require_approval
  rules:
    - name: block-destructive
      match:
        annotations:
          destructiveHint: true
      action: deny
      feedback:
        message: 'Destructive actions are blocked by policy.'
        suggestion: 'Use a non-destructive alternative or request approval.'
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
```

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
  "forwardPorts": [3100], // dashboard only; do not forward the upstream MCP port
}
```

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
`internal` network. Helio retries priming with backoff and stays fail-closed
(undocumented tools denied) until the upstream answers, so once the MCP server
is up the proxy recovers on its own. Check that `mcp-server` is attached to the
`internal` network and that `upstream.url` matches its compose service name and
port.

## Related

- [Docker quickstart](../docker/README.md) — the demo stack and full security model
- [Getting Started](./getting-started.md) — config, policies, and the dashboard
- [Configuration Reference](./configuration.md) — every `helio.yaml` field
