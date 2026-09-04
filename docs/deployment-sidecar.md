# Running Helio as a Sidecar

This is a **deployment pattern, not a tutorial.** It shows the layout that
makes Helio's governance non-bypassable from inside the agent's container on
both axes [SECURITY.md](../SECURITY.md#process-and-filesystem-boundaries)
names: the network axis (the agent has no route to the upstream) and the
process and filesystem axis (the agent has no mount holding the config, no
route to Helio by service name or address, and no copy of the upstream
credential; the one residual, a dashboard port published to the host that
Docker Desktop's host gateway still reaches, is stated in the verification
section), with a copy-paste Docker Compose setup that implements it.
`helio init --sandbox` writes the same files.

**Who it's for:** you already know roughly what Helio does — if not, start with
the [README](../README.md) or [Getting Started](./getting-started.md) — and you
want to run it for real alongside a coding agent or dev container, not just try
the [5-minute demo](../docker/README.md).

**What you get:** every MCP (Model Context Protocol) tool call the agent makes
is forced through Helio's policy engine, approvals, and audit trail, and the
agent cannot change what that policy says. From inside the `agent` container
there is no route to the upstream except through Helio, no mount holding
Helio's config, no route to Helio's dashboard by service name or address,
and no copy of an upstream credential. Helio is attached to no network the
agent is on; a small forwarder relays TCP port 3000 to it and nothing else.
The [verification section](#verifying-the-boundary-from-inside-the-agent-container)
proves each of those from inside the agent container and names the one
residual.

## Why a sidecar: the two rules that make it work

A proxy only governs what is **forced through it.** If the agent can open a
connection to the tool server directly, it goes around Helio, and the audit
log records only the calls that happened to pass through. And a proxy only
enforces the policy its operator wrote while the agent cannot rewrite it: a
process that can write `helio.yaml` changes what the proxy enforces in well
under a second, and a process on Helio's network can reach every port Helio
listens on, the dashboard included. So the design reduces to two rules:

1. The agent has **no network path to the upstream MCP server except through
   Helio.**
2. The agent has **no mount holding Helio's config and no network shared
   with Helio.**

You get both with three Docker networks, Helio on the two the agent is not
on, and a forwarder as the one thing the agent can talk to:

```
      edge            edge + plane     plane + internal      internal
┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│ coding agent │MCP │  helio-edge  │TCP │    Helio     │MCP │ upstream MCP │
│dev container │──► │ (forwarder)  │──► │  (sidecar)   │──► │    server    │
│              │3000│  :3000 only  │3000│ :3000  :3100 │8080│    :8080     │
└──────────────┘    └──────────────┘    └──────────────┘    └──────────────┘
                                              │ :3100 published to
                                              ▼ the host loopback
                                     operator at 127.0.0.1:3100
```

Trace who can reach whom:

- **agent → helio-edge: yes**, TCP port 3000 only. They share `edge`, so the
  agent points its MCP client at `http://helio-edge:3000/mcp`.
- **agent → Helio: no.** They share no network, so `helio` does not resolve
  from the agent and `:3100` is unreachable by service name or address. The
  port published to the host is a separate path; see the verification
  section.
- **agent → config: no.** `./helio/` is mounted into `helio` only, and the
  compose directory is never mounted into `agent`.
- **agent → upstream: no.** The upstream is only on `internal`, which the
  agent is not attached to, so there is simply no route.
- **helio-edge → Helio: yes**, over `plane`, port 3000 only.
- **Helio → upstream: yes.** Helio sits on `internal` too; it is the only
  bridge.
- **operator → dashboard: yes**, on the host at `127.0.0.1:3100`.

Those missing routes and that missing mount are the whole point. They are not
rules the agent is trusted to follow; they are walls Docker enforces. The only
way for the agent to reach a tool is to ask Helio, and the only way to change
what Helio allows is from the host.

## The layout

```
helio-sandbox/          the Compose project directory; never mounted into agent
├── compose.yaml
├── helio/
│   ├── helio.yaml      mounted read-only into the helio service only
│   └── README.md       the constraints and the checks; optional by hand
└── workspace/          your project; the only thing agent mounts
```

Three networks. `edge` is an ordinary bridge with internet egress, for the
agent and the forwarder. `plane` is an ordinary bridge for the forwarder and
Helio, and Helio's route out for upstreams on the internet. `internal` is
marked `internal: true`, for Helio and the upstream, with no route anywhere
else. `helio-edge` is the only service on both `edge` and `plane`; Helio is on
`plane` and `internal` and never on `edge`. `helio init --sandbox` creates this
layout; by hand, the files are the two below. First `compose.yaml`:

<!-- helio-config-guard: skip -->

```yaml
# Helio sidecar layout: four services on three networks. The sidecar
# guide (docs/deployment-sidecar.md) explains every line and carries the
# checks that prove the layout from inside the agent container.
#
#   agent        edge              your coding agent (placeholder below)
#   helio-edge   edge + plane      forwards :3000 to Helio; the only thing the agent can reach
#   helio        plane + internal  the proxy; attached to no network the agent is on
#   mcp-server   internal          your MCP server (placeholder below)
services:
  agent:
    # Placeholder: a shell with curl, so the verification checks run
    # before you wire your own dev container in. Replace `image:` with
    # your agent image or a `build:`; keep `networks: [edge]`; mount your
    # project from a sibling directory (./workspace:/workspace). Never
    # mount this directory, ./helio, a .env file, or the Docker socket
    # into it.
    image: curlimages/curl:8.22.0
    command: ['sleep', 'infinity']
    networks: [edge]

  helio-edge:
    # TCP forwarder for the MCP edge. Point the agent's MCP client at
    # http://helio-edge:3000/mcp. It relays port 3000 and nothing else.
    image: nginx:1.30-alpine
    configs:
      - source: helio_edge_conf
        target: /etc/nginx/nginx.conf
    networks: [edge, plane]
    depends_on: [helio]
    restart: unless-stopped

  helio:
    image: ghcr.io/gethelio/helio:latest
    networks: [plane, internal]
    environment:
      # Put HELIO_DASHBOARD_SECRET=<secret or sha256:digest> in ./.env
      # (this directory is never mounted into agent) or export it.
      # `helio secret` prints a fresh pair.
      HELIO_DASHBOARD_SECRET: '${HELIO_DASHBOARD_SECRET:?put it in ./.env or export it; generate with: helio secret}'
    volumes:
      - ./helio:/config:ro
      - helio-data:/data
    ports:
      # The dashboard, the operator control plane: host loopback only.
      - '127.0.0.1:3100:3100'
    depends_on: [mcp-server]
    restart: unless-stopped

  mcp-server:
    # Your MCP server. Set the image first: `docker compose up` fails at
    # the image pull until you do. Keep it on `internal` only. To try the
    # layout without one, save
    # https://raw.githubusercontent.com/gethelio/helio/main/docker/mcp-echo-server.mjs
    # as ./mcp-server/server.mjs and use the three commented lines
    # instead of the image line.
    image: your-org/your-mcp-server:latest
    # image: node:24-slim
    # command: ['node', '/srv/server.mjs']
    # volumes: ['./mcp-server/server.mjs:/srv/server.mjs:ro']
    networks: [internal]
    restart: unless-stopped

configs:
  helio_edge_conf:
    content: |
      events {}
      stream {
        resolver 127.0.0.11 valid=1s;
        server {
          listen 3000;
          proxy_timeout 1h;
          set $$helio helio:3000;
          proxy_pass $$helio;
        }
      }

networks:
  edge: {} # agent + helio-edge; an ordinary bridge with internet egress
  plane: {} # helio-edge + helio; Helio's route out for internet upstreams
  internal:
    internal: true # helio + mcp-server; no route anywhere else

volumes:
  helio-data: {}
```

`docker compose up` fails at the image pull until you set the `mcp-server`
image; the commented lines run the demo echo server instead, which is enough
to run every check below.

What the mount does and does not protect: `:ro` stops the Helio container
from writing its own config. It does nothing about a writer on the host
side: a write from any process that can reach `./helio/helio.yaml` on the
host, including an agent whose container mounts that directory, reaches the
running proxy through the bind mount and hot-reloads it, and it survives a
`docker restart`. Keep the file where the agent's mounts cannot reach it;
that is what this layout does. The mount is the directory, not the file: a
single-file bind mount binds an inode, so an editor that saves by writing a
temporary file and renaming it leaves the running container on the old inode
until it is recreated, while the directory mount reloads on both save styles.
Hot reload and the config pin tracked in #341 matter less once the file is
where the agent cannot reach it, and more if it is not.

Why Helio is not on `edge`: on a shared network the agent container can reach
every port Helio listens on, including the dashboard at `helio:3100`; a
Compose `ports:` entry protects the host's LAN, not the containers on the
same network. `helio-edge` is the official nginx image running a seven-line
stream config delivered inline through the Compose `configs:` block (Compose
2.23.1 or later): it listens on 3000 and relays to `helio:3000`, resolving
the name through Docker's DNS at `127.0.0.11` for every connection
(`valid=1s`), so it recovers within a second when Helio comes back with a new
address, and it keeps an idle stream open for an hour (`proxy_timeout 1h`;
raise it for clients that hold idle SSE streams longer). The variable is
spelled `$$helio` in the Compose file so that Compose interpolation leaves
one `$` for nginx.

Two other places for the config were considered. A Docker config or secret
object: secrets are Swarm-only, and a config object is still a file the
compose directory produces, so it moves the question rather than answering
it. A derived image with the file baked in: a rebuild per policy change, and
the file still needs a home. Both work; the sibling directory is the cheapest
correct one.

## The matching Helio config

`helio/helio.yaml` points upstream at the MCP server by its compose service
name:

```yaml
# Helio sidecar config. This directory is mounted read-only into the
# helio service and never into the agent. Edit it on the host; policy
# changes reload live.
version: '1'

upstream:
  url: 'http://mcp-server:8080/mcp' # compose service name on the internal network
  transport: streamable-http
  # For an upstream that needs a credential, keep the only copy in this
  # service's environment; the agent never holds it:
  # headers:
  #   Authorization: 'Bearer ${UPSTREAM_TOKEN}'

listen:
  port: 3000
  host: '0.0.0.0' # inside the container; reached only through helio-edge

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
  host: '0.0.0.0' # inside the container; the agent is on no network this container is on
  # The variable may hold the secret or the sha256: digest `helio secret` prints.
  api_secret: '${HELIO_DASHBOARD_SECRET}'
```

This sample **denies** destructive tools outright. To require human approval
instead, so that an operator approves or denies each destructive call from
the dashboard, change that rule's `action` to `require_approval` and add an
`approval:` section with a `dashboard` channel. See [Approvals](./approvals.md).

## Start it

Generate the dashboard secret and put its digest where Compose reads it:

```bash
helio secret   # or: npx @gethelio/proxy secret
```

It prints a secret and its `sha256:` digest. Put the digest in
`helio-sandbox/.env` as `HELIO_DASHBOARD_SECRET=sha256:<digest>` and keep the
secret in your password manager; the variable may hold the secret itself
instead, but with the digest nothing on the box holds the secret. Compose
reads `.env` from the project directory, which the agent never mounts; to
keep it elsewhere, use `docker compose --env-file /path/outside/.env`. Then:

```bash
cd helio-sandbox
docker compose up -d
```

Point the agent's MCP client at `http://helio-edge:3000/mcp`. The dashboard
is at `http://localhost:3100` on the host, published from the `helio`
service. Because `listen.host: '0.0.0.0'` deployments are often fronted by a
reverse proxy or service mesh, note that any `Origin` header arriving at
Helio is refused with `403` unless listed in `listen.allowed_origins`; if
something in front of the proxy injects or forwards one, either strip it
there or name it in the list.

## VS Code Dev Containers

If your agent runs inside a [VS Code dev container](https://containers.dev),
the workspace is `workspace/`, a sibling of `helio/` inside the sandbox
directory, never the sandbox directory itself. Replace the placeholder
`agent` service with your dev container image and the workspace mount:

<!-- helio-config-guard: skip -->

```yaml
services:
  agent:
    image: your-org/your-dev-container:latest # or a build: block
    networks: [edge]
    volumes:
      - ./workspace:/workspace:cached
```

`workspace/.devcontainer/devcontainer.json`:

```jsonc
{
  "name": "agent-workspace",
  "dockerComposeFile": "../../compose.yaml",
  "service": "agent",
  "workspaceFolder": "/workspace",
}
```

`dockerComposeFile` is resolved relative to `devcontainer.json`, so from
`workspace/.devcontainer/` it points at the sandbox's `compose.yaml`. There
is no `forwardPorts` entry: the dashboard is published to the host by the
`helio` service, and the agent container has no route to `helio` by design.
Inside the dev container, configure your MCP client (Claude Desktop, an SDK,
or the agent framework you use) with the URL `http://helio-edge:3000/mcp`.

> **Don't** add `mcp-server` or `helio` to `edge`, add `agent` to `plane` or
> `internal`, or mount the sandbox directory, `./helio`, `.env`, or the
> Docker socket into `agent`. Each of those hands the agent a path around the
> boundary.

## Verifying the boundary from inside the agent container

Open a shell in the agent container (`docker compose exec agent sh`) and run
the four checks. With the placeholder `agent` image they work out of the box;
in your own image, `curl` is the only tool they need.

```bash
# 1. No route to the upstream: must fail (exit 6, no such host; 7 if a
#    service by that name exists on edge).
curl -s -m 3 http://mcp-server:8080/mcp; echo "exit: $?"
# 2. No mount holding the config: both paths must be missing, non-zero exit.
ls /config /workspace/helio 2>&1; echo "exit: $?"
# 3. No route to the dashboard: must fail (exit 6; helio-edge:3100 gives 7).
curl -s -m 3 http://helio:3100/api/health; echo "exit: $?"
# 4. No credential in the environment: must print nothing (exit 1).
env | grep -iE 'helio|upstream|secret'; echo "exit: $?"
# Through Helio it works and is audited: the upstream's tool list comes back.
curl -s -m 5 -X POST http://helio-edge:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Check 2 witnesses the two places this layout could leak the config: Helio's
mount copied onto `agent`, and the sandbox root mounted as the workspace. The
general rule is that no path inside the agent container may reach `helio/`,
`compose.yaml`, or `.env`; if your mounts land elsewhere, `ls` those paths
from wherever they land.

Check 4 has one documented exception: a `HELIO_SDK_TOKEN` you set on purpose
for the SDK sideband. Anything else it prints is a leak.

Check 3 proves the route by service name and address is closed. A port
published to the host is a different path. Run this probe next:

```bash
curl -s -m 3 http://host.docker.internal:3100/api/health; echo "exit: $?"
```

On Docker Desktop (macOS and Windows) it answers with the dashboard's health
from inside the agent container, even though the agent shares no network
with Helio: every port published to the host is reachable from every
container through the Desktop host gateway, by that name and by its address.
The dashboard's control-plane routes (audit, approvals, limits) stay behind
the secret, which the agent does not hold; the config and the `helio`
environment carry the digest, and the secret lives with the operator.
`/api/health`, the login route, and the logout route answer without it,
which is why the probe returns health. Whether a Linux Docker Engine host
behaves the same was not tested; run the probe on your own host and believe
its answer over anything written here. If a reachable login route is not
acceptable while an untrusted agent runs, front the dashboard with an
authenticating reverse proxy, or stop publishing it while that agent runs.

`edge` is an ordinary bridge with internet egress, because the agent needs
its model API, so check 1 proves only that the compose-internal route is
closed. An upstream reachable over the internet is protected only while the
sole copy of its credential is in Helio's environment (`upstream.headers`
with `${VAR}` in `helio/helio.yaml`): an agent that can reach such an
upstream on its own and holds no credential for it still has to go through
Helio.

If a check passes where it must fail, the layout has been changed in a way
that opens a path around Helio: a service added to `edge`, `agent` added to
another network, or a mount into `agent` that reaches the sandbox directory.
Fix the compose file before trusting the audit trail.

## Troubleshooting

**`Upstream MCP server at http://mcp-server:8080/mcp is unreachable — is it running?`**
Helio started before the upstream was ready, or the upstream isn't on the
`internal` network. Helio retries priming (the startup fetch of the upstream's
tool list) with backoff and stays fail-closed (calls it can't verify are denied)
until the upstream answers, so once the MCP server is up the proxy recovers on
its own. Check that `mcp-server` is attached to the
`internal` network and that `upstream.url` matches its compose service name and
port.

**`curl: (7) Failed to connect to helio-edge port 3000`** right after
`docker compose up`. Helio is not listening yet; the forwarder resolves
`helio` for every connection and relays as soon as it does. Retry once
`docker compose logs helio` shows `listening`.

## Related

- [Running Helio as its own user](./deployment-separate-user.md): the
  process and filesystem tier on one host, without Docker
- [Docker quickstart](../docker/README.md): the demo stack and full security
  model
- [Getting Started](./getting-started.md): config, policies, and the dashboard
- [Configuration Reference](./configuration.md): every `helio.yaml` field
