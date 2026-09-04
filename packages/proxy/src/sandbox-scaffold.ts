// ---------------------------------------------------------------------------
// Sidecar layout for `helio init --sandbox`: the three files it writes.
// The sidecar guide (docs/deployment-sidecar.md) shows compose.yaml and
// helio/helio.yaml verbatim; a test pins the page to these renderers.
// ---------------------------------------------------------------------------

export const SANDBOX_DEFAULT_DIR = 'helio-sandbox'
export const SANDBOX_FILES = ['compose.yaml', 'helio/helio.yaml', 'helio/README.md'] as const
export const SANDBOX_FORWARDER_IMAGE = 'nginx:1.30-alpine'
export const SANDBOX_AGENT_PLACEHOLDER_IMAGE = 'curlimages/curl:8.22.0'

/** `0.0.0` is a source build with no published image; everything else is a release tag. */
export function sandboxImageTag(version: string): string {
  return version === '0.0.0' ? 'latest' : version
}

export function renderSandboxCompose(options: { imageTag: string }): string {
  const { imageTag } = options
  return `# Helio sidecar layout: four services on three networks. The sidecar
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
    # before you wire your own dev container in. Replace \`image:\` with
    # your agent image or a \`build:\`; keep \`networks: [edge]\`; mount your
    # project from a sibling directory (./workspace:/workspace). Never
    # mount this directory, ./helio, a .env file, or the Docker socket
    # into it.
    image: ${SANDBOX_AGENT_PLACEHOLDER_IMAGE}
    command: ['sleep', 'infinity']
    networks: [edge]

  helio-edge:
    # TCP forwarder for the MCP edge. Point the agent's MCP client at
    # http://helio-edge:3000/mcp. It relays port 3000 and nothing else.
    image: ${SANDBOX_FORWARDER_IMAGE}
    configs:
      - source: helio_edge_conf
        target: /etc/nginx/nginx.conf
    networks: [edge, plane]
    depends_on: [helio]
    restart: unless-stopped

  helio:
    image: ghcr.io/gethelio/helio:${imageTag}
    networks: [plane, internal]
    environment:
      # Put HELIO_DASHBOARD_SECRET=<secret or sha256:digest> in ./.env
      # (this directory is never mounted into agent) or export it.
      # \`helio secret\` prints a fresh pair.
      HELIO_DASHBOARD_SECRET: '\${HELIO_DASHBOARD_SECRET:?put it in ./.env or export it; generate with: helio secret}'
    volumes:
      - ./helio:/config:ro
      - helio-data:/data
    ports:
      # The dashboard, the operator control plane: host loopback only.
      - '127.0.0.1:3100:3100'
    depends_on: [mcp-server]
    restart: unless-stopped

  mcp-server:
    # Your MCP server. Set the image first: \`docker compose up\` fails at
    # the image pull until you do. Keep it on \`internal\` only. To try the
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
`
}

export function renderSandboxConfig(): string {
  return `# Helio sidecar config. This directory is mounted read-only into the
# helio service and never into the agent. Edit it on the host; policy
# changes reload live.
version: '1'

upstream:
  url: 'http://mcp-server:8080/mcp' # compose service name on the internal network
  transport: streamable-http
  # For an upstream that needs a credential, keep the only copy in this
  # service's environment; the agent never holds it:
  # headers:
  #   Authorization: 'Bearer \${UPSTREAM_TOKEN}'

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
  # The variable may hold the secret or the sha256: digest \`helio secret\` prints.
  api_secret: '\${HELIO_DASHBOARD_SECRET}'
`
}

export function renderSandboxReadme(): string {
  return `# Helio sidecar layout

Written by \`helio init --sandbox\`. This directory is the Compose
project directory. The agent container never mounts it.

## What this layout guarantees

From inside the \`agent\` container there is no route to the upstream
except through Helio, no mount holding Helio's config, no route to
Helio's dashboard by service name or address, and no copy of an
upstream credential. Helio is attached to no network the agent is on;
\`helio-edge\` forwards TCP port 3000 to it and nothing else.

## Make it yours

1. \`compose.yaml\`: set the \`agent\` image (or \`build:\`) and the
   \`mcp-server\` image. \`docker compose up\` fails at the image pull until
   the \`mcp-server\` image is set. Keep \`agent\` on \`edge\` only and
   \`mcp-server\` on \`internal\` only.
2. Run \`helio secret\`. Put \`HELIO_DASHBOARD_SECRET=sha256:<digest>\` in
   \`./.env\` next to \`compose.yaml\` (or export it). The variable may hold
   the secret itself or its \`sha256:\` digest; the dashboard login and the
   Bearer header always take the secret.
3. \`docker compose up -d\`, then run the checks below from inside the
   agent container (\`docker compose exec agent sh\`).
4. Point the agent's MCP client at \`http://helio-edge:3000/mcp\`. The
   dashboard is on the host at \`http://127.0.0.1:3100\`.

## Hard constraints

- Never mount \`.\` or \`.env\` into the \`agent\` service.
- Never mount \`docker.sock\` into it; an agent with the socket is the host.
- Secrets only on the \`helio\` service.
- \`./helio/\` is never mounted into \`agent\`.
- \`edge\` has internet egress, so an upstream the agent could reach on
  its own is protected only by Helio holding the sole copy of its
  credential (\`upstream.headers\` with \`\${VAR}\` in \`helio/helio.yaml\`).

## Verify from inside the agent container

\`\`\`sh
# 1. No route to the upstream: must fail (exit 6 or 7).
curl -s -m 3 http://mcp-server:8080/mcp; echo "exit: $?"
# 2. No mount holding the config: both paths must be missing.
ls /config /workspace/helio 2>&1; echo "exit: $?"
# 3. No route to the dashboard: must fail (exit 6; helio-edge:3100 gives 7).
curl -s -m 3 http://helio:3100/api/health; echo "exit: $?"
# 4. No credential in the environment: must print nothing.
env | grep -iE 'helio|upstream|secret'; echo "exit: $?"
# Through Helio it works and is audited:
curl -s -m 5 -X POST http://helio-edge:3000/mcp \\
  -H 'Content-Type: application/json' \\
  -H 'Accept: application/json, text/event-stream' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
\`\`\`

On Docker Desktop (macOS and Windows) every port published to the host
is reachable from every container through the Desktop host gateway:
\`curl -s -m 3 http://host.docker.internal:3100/api/health\` answers from
the agent there. Run the same probe on your own host and believe its
answer. The dashboard's control-plane routes stay behind its secret,
which the agent does not hold; \`/api/health\` answers without it. If that
is not acceptable, front the dashboard with an
authenticating reverse proxy or do not publish it while an untrusted
agent runs.

## Editing the config

\`./helio/\` is mounted read-only into the \`helio\` service, so edit
\`helio/helio.yaml\` on the host; policy changes reload live. Change it
from the host only. The agent container has no path to it, and that is
the point.

## Dev container

\`workspace/.devcontainer/devcontainer.json\`:

\`\`\`jsonc
{
  "name": "agent-workspace",
  "dockerComposeFile": "../../compose.yaml",
  "service": "agent",
  "workspaceFolder": "/workspace"
}
\`\`\`

and in \`compose.yaml\` give \`agent\` the mount \`./workspace:/workspace:cached\`
(a sibling of \`helio/\`, never this directory itself). Do not add a
\`forwardPorts\` entry for the dashboard: it is published to the host by
the \`helio\` service, and the agent has no route to \`helio\` by design.
`
}
