# Helio Docker Quickstart

Runs the Helio proxy, a mock MCP echo server, and the dashboard via
Docker Compose. Designed for a 5-minute demo on your local machine.

## Setup (one-time)

1. Copy the example env file:

   ```bash
   cp .env.example .env
   ```

2. Generate a 32-byte hex secret and paste it into `.env` as
   `HELIO_DASHBOARD_SECRET=...`:

   ```bash
   openssl rand -hex 32           # macOS / Linux
   # or: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

3. Start the stack:

   ```bash
   docker compose up
   ```

   If you skip step 2, compose aborts before any container starts with
   an error that mentions
   `required variable HELIO_DASHBOARD_SECRET is missing` followed by
   the remediation hint baked into `docker-compose.yml`
   (`Set HELIO_DASHBOARD_SECRET in docker/.env — generate with: openssl rand -hex 32`).
   The `${HELIO_DASHBOARD_SECRET:?...}` guard in `docker-compose.yml`
   makes a silent-unauth start impossible.

Open <http://localhost:3100> for the dashboard. Send tool calls to
<http://localhost:3000/mcp>. The secret from step 2 is used as a
dashboard login secret and can also be used by machine clients as an
`Authorization: Bearer <secret>` credential on dashboard API calls.

## Security model

By default the quickstart binds **both** published ports to
`127.0.0.1` on the host (see `ports:` in `docker-compose.yml`), so the
proxy and dashboard are only reachable from the machine running
`docker compose`. Note that inside the container the config file
(`helio.docker.yaml`) binds `listen.host` and `dashboard.host` to
`0.0.0.0` — that is the correct setting for _inside the container
namespace_, where the process needs to accept traffic from the
container's virtual network. The compose `ports:` map is what
controls whether that inner port is exposed to the host LAN or kept
on loopback, and the quickstart keeps it on loopback. This protects
you from:

- Anyone else on the same wifi network reaching the MCP edge on port
  3000 and sending tool calls through your upstream.
- Anyone on the same wifi sending requests to the dashboard sideband
  API on port 3100 using the shared `HELIO_DASHBOARD_SECRET` bearer
  token (which would let them read the audit feed, enumerate evidence
  state, or approve pending tickets).

The main MCP port (3000) is the "agent edge" — anything that can
reach it can send tool calls. The dashboard sideband (3100) is the
"operator control plane" — every `/api/*` endpoint except
`/api/health`, `/api/auth/session`, and `/api/auth/logout` requires
authentication via either:

- `Authorization: Bearer <HELIO_DASHBOARD_SECRET>` (machine clients), or
- a dashboard session cookie established after logging in with the secret.

This covers both operator reads (audit, evidence, limits) and approval
mutations (approve / deny / break-glass).

## Opting in to LAN or remote access

If you need an agent on another machine to reach the proxy, change the
`ports:` entry in `docker-compose.yml` from
`'127.0.0.1:3000:3000'` to `'3000:3000'`. You should understand what
you're giving up:

- Any host on the LAN can now hit `/mcp` and send tool calls through
  your upstream MCP server. They go through the same policy engine
  you configured, but you're extending trust to the entire LAN.
- The main MCP port has no authentication itself — Helio's trust
  boundary assumes the agent speaking MCP is the thing you are
  governing, not an authenticated user.

For the dashboard (port 3100), **do not** change the publish to
`'3100:3100'` without putting it behind a reverse proxy that handles
TLS, allow-listing, and (ideally) an additional layer of
authentication. Helio's `api_secret` is a shared secret, not a user
session, so exposing it to an untrusted network puts it at risk of
replay and offline brute-force. Production deployments should front
the dashboard with a hosted identity layer (Okta, Auth0, GitHub
OAuth, etc.).

## What's in this directory

| File                  | Purpose                                                                            |
| --------------------- | ---------------------------------------------------------------------------------- |
| `Dockerfile`          | 4-stage build: deps, build, runtime, with `tini`, non-root user, and a healthcheck |
| `docker-compose.yml`  | Orchestrates `helio` + `mcp-server` (the demo upstream)                            |
| `helio.docker.yaml`   | Helio config loaded by the proxy container                                         |
| `mcp-echo-server.mjs` | Zero-dependency MCP echo server for the demo                                       |
| `.env.example`        | Template for local env vars (copy to `.env`, fill in the secret)                   |
