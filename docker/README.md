# Helio Docker Quickstart

A self-contained, 5-minute demo that shows Helio governing MCP tool
calls inside Docker. `docker compose up` starts three things together:
the Helio proxy, a throwaway echo server that stands in for an upstream
MCP server, and the dashboard. You send a couple of tool calls, watch
one get allowed and one get blocked, and see both land in the dashboard
audit feed. No MCP server or agent of your own is required.

> **This is a demo, not a deployment.** To run Helio in its own
> container next to a coding agent or dev container, with network
> isolation so the agent can't bypass governance, and pointed at your
> own MCP server, see
> [Running Helio as a Sidecar](../docs/deployment-sidecar.md).

## Setup (one-time)

Prerequisites: a local clone of this repo, and Docker running (Docker
Desktop, or a Docker Engine daemon). Every command below is run from
the `docker/` directory.

1. Clone the repo and change into the `docker/` directory:

   ```bash
   git clone https://github.com/gethelio/helio.git
   cd helio/docker
   ```

2. Copy the example env file:

   ```bash
   cp .env.example .env
   ```

3. Generate a 32-byte hex secret and set it as `HELIO_DASHBOARD_SECRET`
   in `.env`. The file ships with an empty `HELIO_DASHBOARD_SECRET=`
   line; open `.env` in your editor and paste the value after the `=`:

   ```bash
   openssl rand -hex 32           # macOS / Linux
   # or: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

   Prefer a one-liner? This appends the secret. Compose uses the last
   value for a repeated key, so it overrides the empty placeholder:

   ```bash
   echo "HELIO_DASHBOARD_SECRET=$(openssl rand -hex 32)" >> .env
   ```

4. Start the stack:

   ```bash
   docker compose up
   ```

   If you skip step 3, compose aborts before any container starts with
   an error that mentions
   `required variable HELIO_DASHBOARD_SECRET is missing` followed by
   the remediation hint baked into `docker-compose.yml`
   (`Set HELIO_DASHBOARD_SECRET in docker/.env — generate with: openssl rand -hex 32`).
   The `${HELIO_DASHBOARD_SECRET:?...}` guard in `docker-compose.yml`
   makes a silent-unauth start impossible.

Open <http://localhost:3100> for the dashboard and log in with the
secret you set in step 3 (the value of `HELIO_DASHBOARD_SECRET` in
`docker/.env`). That same secret also works as an
`Authorization: Bearer <secret>` credential for machine clients on
dashboard API calls.

## Exercise it

The demo runs Helio's policy engine in front of the echo server, so you
can watch governance act. The config (`helio.docker.yaml`) allows
read-only tools, denies destructive ones, requires approval before
sending email, and caps what the payment tools spend together with a
named budget (next section). Send a couple of calls through the proxy
on port 3000:

```bash
# Allowed: get_weather is read-only
curl -s -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_weather","arguments":{"city":"London"}}}'

# Denied: delete_record is destructive, so the policy blocks it
curl -s -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"delete_record","arguments":{"id":"rec_42"}}}'
```

`get_weather` returns a result; `delete_record` returns a policy denial
that names the `block-destructive` rule. Both appear in the dashboard
activity feed with their decision.

Now trigger a human-in-the-loop approval. This call **waits** for a
decision:

```bash
# Requires approval: send_email pauses until you approve it
curl -s -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"send_email","arguments":{"to":"ceo@example.com","body":"hi"}}}'
```

The command hangs because the call is pending. Open the dashboard at
<http://localhost:3100>, go to **Approvals**, and approve the
`send_email` ticket — the curl then returns `Email sent to
ceo@example.com`. (Deny it, or wait past the 120s timeout, and the call
is denied instead.)

No agent handy? You can also point the official
[MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector)
at <http://localhost:3000/mcp> (run `npx @modelcontextprotocol/inspector`,
transport: Streamable HTTP) and call the tools from its UI.

## Break the budget

The config also defines a [named budget](../docs/policies.md#named-budgets-cross-tool):
one `demo-payments` pot of $50 per hour, shared by the `stripe_charge`
and `paypal_payout` demo tools. Open the dashboard's **Budgets** tab —
the pot is already there at full headroom — and keep it visible while
you deplete it:

```bash
# Stripe charge: $20 (20/50 used)
curl -s -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"stripe_charge","arguments":{"amount":20,"currency":"USD","customer":"cus_123"}}}'

# PayPal payout: $20 into the SAME pot (40/50 used)
curl -s -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"paypal_payout","arguments":{"total":20,"recipient":"ops@example.com"}}}'
```

Both succeed, and the Budgets tab bar moves on each one: two different
providers, each exposing its amount under a different argument field
(`$.amount` vs `$.total`), depleting one shared cap. Now push past it:

```bash
# Stripe charge: $20 — would exceed $50, so this call WAITS
curl -s -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"stripe_charge","arguments":{"amount":20,"currency":"USD","customer":"cus_123"}}}'
```

The budget is `on_exceed: require_approval`, so the breach raises a
break-glass approval instead of a denial. Go to **Approvals**: the
pending ticket lists the breached budget — spent, limit, and the
attempted amount — and warns that approving spends past the limit.
Approve it and the curl returns; deny it (or let the 120s timeout fire)
and the call is blocked. Budget tickets always fail closed on timeout.

After approving, the Budgets tab shows $60 spent of $50 — an approved
overage legitimately pushes the pot past its limit. Expand the pot's
event list: the third charge carries the **approved overage** badge,
and that marking is durable — it is how the ledger and the call's audit
record store the charge.

Budget spend also survives restarts (it lives in the `helio-data`
volume next to the audit records — sliding-window pots resume
mid-window):

```bash
docker compose restart helio
```

Reload the Budgets tab: still $60 of $50, mid-window.

That is as far as the demo goes. To govern your own MCP server, with
Helio in its own container next to an agent, see
[Running Helio as a Sidecar](../docs/deployment-sidecar.md).

## Reset the demo

Audit records and budget spend persist in the `helio-data` Docker volume
across restarts. `docker compose down` stops the containers but keeps
that volume, so a later `docker compose up` still shows earlier tool
calls in the feed and replays the budget ledger into the pot. To wipe
the audit history and budget spend and start from a clean slate, remove
the volume too:

```bash
docker compose down -v
```

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

| File                    | Purpose                                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------------------------- |
| `Dockerfile`            | 4-stage build (deps, build, prod-deps, runtime) with `tini`, a non-root user, and a healthcheck       |
| `docker-compose.yml`    | Orchestrates `helio` + `mcp-server` (the demo upstream)                                               |
| `docker-compose.ci.yml` | CI-only override that runs the smoke test against the prebuilt image (see `.github/workflows/ci.yml`) |
| `helio.docker.yaml`     | Helio config loaded by the proxy container                                                            |
| `mcp-echo-server.mjs`   | Zero-dependency MCP echo server for the demo                                                          |
| `.env.example`          | Template for local env vars (copy to `.env`, fill in the secret)                                      |
