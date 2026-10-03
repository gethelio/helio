# Agent Budget Example

One coding agent, one $50 pot, three MCP servers behind three doors. The `compute` door sells compute units, the `market-data` door sells price lookups, and the `tools` door runs paid checks and ops jobs. Every spending tool declares its amount in an argument, and one budget, `coding-agent-run`, draws every door down. The call that would cross $50 is held for a human, the approved overage lands in the ledger, and the ledger survives a restart. A second control holds every `run_job` call for approval, so the approver reads the tool, the door, the rule and the arguments before anything runs.

This is the job a buyer of agent payments describes for themselves, in Adyen's words: "define limits and approvals, and review usage and spend." Here that job runs on MCP tools, with the proxy as the only moving part.

## What This Demonstrates

- Three named upstreams at their own doors, each listing a different tool set
- One `budgets:` pot with three contributors on two argument fields: `$.amount` on two doors, `$.price` on the third
- `window: session` and `key: session`: a pot that never replenishes on a timer, keyed by the caller's session id
- `on_exceed: require_approval`: the breaching call is held, a human approves the overage, and the ledger records it as an approved overage
- A `require_approval` rule scoped to one door: the ticket shows the tool, the door, the rule and the arguments
- The ledger persisting across a proxy restart

## The Honest Boundary

The tool declares the amount in an argument; the contributor names that field. Helio reads the number the tool's own schema exposes (`amount` on `top_up_compute` and `get_prices`, `price` on `run_check`) and charges the pot before the call is forwarded. Nothing here reads a price off the wire or settles a payment, and a tool with no amount argument, like `run_job`, never touches the pot.

## Prerequisites

- Node.js 24+
- `jq` (optional) for pretty-printing JSON command output. If unavailable, remove `| jq` from curl commands.
- Build the proxy from the repo root:

```bash
pnpm install && pnpm build
```

## Configure

Copy the example environment file and generate a dashboard secret:

```bash
cd examples/agent-budget
cp .env.example .env
echo "HELIO_DASHBOARD_SECRET=$(openssl rand -hex 32)" >> .env
```

(Sourcing the file applies assignments in order, so the appended secret overrides the empty placeholder.)

`.env` lives inside the checkout, where anything that can read the checkout, including a coding agent working in it, can read the secret. Past a local try, keep the file outside the checkout and source it from there (`set -a; . /path/outside/.env; set +a`).

The secret is required because both controls require approval: the budget uses `on_exceed: require_approval` and the `run_job` rule uses `action: require_approval`. Tickets need an authenticated dashboard to resolve them.

## Quick Start

```bash
set -a
. ./.env
set +a
pnpm start
```

This starts:

1. Three local MCP echo servers, one per door: `compute` on port 8080, `market-data` on port 8081, `tools` on port 8082, each with its own tool set
2. The Helio proxy on port 3000
3. The dashboard on port 3100

> **Note:** This example uses ports 8080, 8081, 8082, 3000, and 3100. Stop any running example before starting another.

Open [http://localhost:3100](http://localhost:3100), log in with the secret from `.env`, and go to the **Budgets** tab. The `coding-agent-run` pot is there at `$0.00 / $50.00` before any call is made. (The dashboard formats the currency in your browser's locale; a British English browser, for example, shows the limit as `US$50.00`.)

## Try It Out

Keep the Budgets tab visible while you run these. Every call below carries two headers: `Content-Type: application/json`, because the door answers 415 to anything else, and `x-helio-session-id: coding-agent-run`, because a call without a session id is refused and charges nothing (see [What goes wrong](#what-goes-wrong)). The request bodies live in `demo/calls/`, so run the commands from `examples/agent-budget`.

> If `jq` is not installed, remove `| jq` from the command snippets below.

### Three doors, three tool sets

Each named upstream answers at `/mcp/<name>` and lists exactly its own tools:

```bash
curl -s -X POST http://127.0.0.1:3000/mcp/compute \
  -H 'Content-Type: application/json' \
  -H 'x-helio-session-id: coding-agent-run' \
  -d @demo/calls/list.json | jq -r '.result.tools[].name'
```

Prints `get_weather` and `top_up_compute`. The same request against `/mcp/market-data` prints `get_weather` and `get_prices`; against `/mcp/tools` it prints `get_weather`, `run_check` and `run_job`. Three servers, three tool sets, one proxy.

### Four allowed calls: 20, 8, 8, 8

Buy compute on the first door ($20):

```bash
curl -s -X POST http://127.0.0.1:3000/mcp/compute \
  -H 'Content-Type: application/json' \
  -H 'x-helio-session-id: coding-agent-run' \
  -d @demo/calls/top-up-compute.json | jq
```

The echo server answers `Added 2000 compute units for 20 USD`, and the Budgets tab moves to `$20.00 / $50.00`. The contributor read `$.amount` from the call's arguments.

Now three price lookups on the second door ($8 each). Run this three times:

```bash
curl -s -X POST http://127.0.0.1:3000/mcp/market-data \
  -H 'Content-Type: application/json' \
  -H 'x-helio-session-id: coding-agent-run' \
  -d @demo/calls/get-prices.json | jq
```

Each answers `Prices for AAPL, MSFT, NVDA fetched for 8 USD`, and the bar steps to 28, 36, then `$44.00 / $50.00`. A different server, a read-only tool, the same pot.

### The call that crosses the line

A paid check on the third door costs $9. The pot holds $44 of $50, so this call would reach $53:

```bash
curl -s -X POST http://127.0.0.1:3000/mcp/tools \
  -H 'Content-Type: application/json' \
  -H 'x-helio-session-id: coding-agent-run' \
  -d @demo/calls/run-check.json | jq
```

The command **hangs**. The contributor for this door reads `$.price`, not `$.amount`, and the budget is `on_exceed: require_approval`, so the breach raised a break-glass ticket instead of a denial.

Open the **Approvals** tab. The pending card shows the tool (`run_check`), the door (`tools`), the session, the arguments, and the breached pot with its numbers: `44/50 USD spent, attempting +9 (session window)`. Approve it, and the curl returns `Check of api.example.com ran for 9 USD`. Deny it, or let it time out, and the call is blocked: budget tickets always fail closed on timeout.

Back on the **Budgets** tab the pot reads `$53.00 / $50.00` with a full bar. Click **Recent events** on the pot: the newest row is the `run_check` charge, attributed to the `tools` door, with the **approved overage** badge. That badge is how the charge is recorded in the ledger, not a flourish of the page.

### Restart: the ledger kept it

Stop the example with `Ctrl-C` and start it again **from the same directory**:

```bash
pnpm start
```

`audit.path` in `helio.yaml` is relative to the working directory, not to the config file, so a start from anywhere else opens a different, empty database and the pot starts over. From `examples/agent-budget` it reopens `./helio-audit.db`, replays the ledger, and the pot comes back at `$53.00 / $50.00`.

Log in again (the dashboard session does not survive a restart) and click **Recent events** again (the panel starts collapsed): the same `run_check` row, the same door, the same badge.

The same proof from the API, with the dashboard secret as a Bearer token. This needs `HELIO_DASHBOARD_SECRET` in the current terminal; if this is not the one where you sourced `.env`, run `set -a; . ./.env; set +a` first:

```bash
curl -s -H "Authorization: Bearer $HELIO_DASHBOARD_SECRET" \
  http://127.0.0.1:3100/api/budgets/coding-agent-run/events | jq '.data[0] | {kind, tool_name, upstream}'
```

Prints `"approved_overage"`, `"run_check"` and `"tools"`: the newest ledger row, read from the restarted process.

### A write tool held by a rule

`run_job` carries no amount, so the pot never sees it. The `approve-job-runs` rule holds it instead:

```bash
curl -s -X POST http://127.0.0.1:3000/mcp/tools \
  -H 'Content-Type: application/json' \
  -H 'x-helio-session-id: coding-agent-run' \
  -d @demo/calls/run-job.json | jq
```

The command hangs and a ticket appears on the **Approvals** tab: tool `run_job`, door `tools`, rule `approve-job-runs`, the session, and the whole input, legible: the job name, the branch, the eight commands in order, and the environment the job would run with. Approve it and the curl returns `Job release-preview queued on release/2026.10 with 8 commands`; the Budgets tab has not moved.

The same ticket routes to a Slack channel when one is configured: uncomment the `slack` channel under `approval.channels` in `helio.yaml`, point both `approval.channel` values at it, and fill in the Slack variables in `.env`; see [Slack Approvals](../slack-approvals/) for the app setup. The Slack card shows the same tool, door, rule and arguments, with the input as JSON up to 2,000 characters.

### What goes wrong

Two mistakes are easy to make from the command line, and both are answered before any policy runs.

A `-d` without a `Content-Type` header posts `application/x-www-form-urlencoded`, and the door refuses it:

```bash
curl -s -i -X POST http://127.0.0.1:3000/mcp/compute \
  -H 'x-helio-session-id: coding-agent-run' \
  -d @demo/calls/top-up-compute.json | head -1
```

Prints `HTTP/1.1 415 Unsupported Media Type`, and the body says `Content-Type must be application/json`.

A call without `x-helio-session-id` has no session for a session-keyed pot to charge:

```bash
curl -s -X POST http://127.0.0.1:3000/mcp/compute \
  -H 'Content-Type: application/json' \
  -d @demo/calls/top-up-compute.json | jq
```

Blocked, with `reason: "session_unresolved"` and a suggestion to send the header once per agent run. The pot is untouched: a refused call charges nothing. This is the default `session.on_unresolved: deny`; each real caller sends its own id and gets its own pot.

## Configuration Walkthrough

The full config is [helio.yaml](./helio.yaml). The pot and the rule, with the named `upstreams:` they scope to:

```yaml
upstreams:
  - name: compute
    url: 'http://localhost:8080/mcp'
  - name: market-data
    url: 'http://localhost:8081/mcp'
  - name: tools
    url: 'http://localhost:8082/mcp'

policies:
  rules:
    - name: approve-job-runs
      match:
        upstreams: [tools]
        tool: 'run_job'
      action: require_approval
      approval:
        channel: dashboard
        timeout: '300s'

budgets:
  - name: coding-agent-run
    limit: 50
    currency: USD
    window: session # never replenishes on a timer
    key: session # one pot per x-helio-session-id
    on_exceed: require_approval # a breach raises a break-glass ticket
    approval:
      channel: dashboard
    contributors:
      - match:
          tool: 'top_up_compute'
          upstreams: [compute]
        field: '$.amount'
      - match:
          tool: 'get_prices'
          upstreams: [market-data]
        field: '$.amount'
      - match:
          tool: 'run_check'
          upstreams: [tools]
        field: '$.price'
```

- **`contributors[].match.upstreams`** scopes each contributor to one door, so the same tool name on another door would not feed this pot
- **`field`** is the dot path to the amount in the call's arguments; two contributors read `$.amount`, the third reads `$.price`
- **`key: session`** with the default `session` settings keys the pot by the `x-helio-session-id` header; `session` is left at its defaults on purpose

## How It Works

- **Rules decide first, budgets deplete after.** The `approve-job-runs` rule never mentions a spending tool, and the budget never mentions `run_job`; the two controls are independent and each ticket says which one held the call.
- **The gate is all-or-nothing.** The pot is checked before the call is forwarded, and a refused call charges nothing.
- **Break-glass is scope-once and fails closed.** Approving covers exactly the one call's overage; the next breach raises a fresh ticket, and a timeout never fails open for a money gate.
- **The ledger is the audit database.** Every charge is written at record time to `./helio-audit.db`, and startup replays it; a `window: session` pot comes back with its full accrued spend while its last activity is within `idle_ttl` (24h by default).

See the [Policy Guide](../../docs/policies.md#cross-tool-spend-budgets) for budget semantics, the [configuration reference](../../docs/configuration.md#budgets) for every field, and [Approvals](../../docs/approvals.md) for the ticket surfaces.

## Re-record the Demo

The two demo recordings, the budget demo and the approval card, come from a committed pipeline under `demo/`, so a maintainer can re-record after a dashboard change instead of reconstructing mouse movements. Each recording is two captures of one live session, the terminal pane and the dashboard pane, assembled side by side; nothing is spliced in from anywhere else, and the approval on screen is a click on the dashboard's own Approve button.

Prerequisites, all on macOS:

- `brew install vhs`, which brings `ffmpeg` and `ttyd` with it
- Google Chrome, launched by the driver as its own app window with a fresh profile (a Chrome that is already open is left alone)
- `jq`, which the tapes pipe `tools/list` through (current macOS ships it at `/usr/bin/jq`)
- Screen Recording permission for the terminal that runs the driver; macOS asks once
- Accessibility permission for the same terminal (System Settings, Privacy & Security, Accessibility), so the driver can move the real mouse pointer and click the dashboard's own controls on screen; the driver refuses to start without it
- `.env` filled in as above, with the dashboard channel as committed; nothing in `helio.yaml` is edited for a take

Then, from this directory:

```bash
node demo/record.mjs budget      # one $50 pot, three doors, a held overage, a restart
node demo/record.mjs approval    # the approval card for a write tool
```

The driver deletes this example's audit database so the pot starts at `$0.00 / $50.00`, starts `pnpm start` from this directory in its own process group, waits for the dashboard's health route, opens the dashboard as a Chrome app window and logs it in, starts an `ffmpeg` screen capture of that window, and runs the tape (`demo/budget.tape` or `demo/approval.tape`). The tape types every call from `demo/calls/` with both headers and never types the secret: its two API lines read the bearer from the environment the driver passes to the tape's own zsh.

The tape and the driver talk through cue files under `demo/cues/`:

- `approve`: the driver moves the pointer to the Approvals link, opens the one pending ticket, holds it on screen long enough to read, wheels through the arguments and down to the buttons, and clicks Approve; the tape's `wait` returns when the held call completes
- `expand-1` and `expand-2`: the driver clicks the pot's **Recent events** so the ledger row and its badge are on screen
- `restart`: the driver sends the example's process group the same SIGINT as `Ctrl-C`, starts it again from this directory, waits for the health route, logs the dashboard in again and writes `restart-ready`; the tape's `demo/wait-ready.mjs` exits the moment that file appears, so the events line it is chained to reads the restarted process however long the boot took

Outputs land under `demo/out/`: the raw terminal and dashboard captures, `budget.mp4`, `budget.gif`, `approval.mp4`, `approval.gif` and a timeline file with the trims used. The two panes are aligned on the tape's own `date -u` lines; if a cut shows the dashboard moving before or after the terminal, adjust the trim and re-assemble without a retake:

```bash
node demo/record.mjs budget --assemble --trim-dashboard 0.8
```

Keep the app window unobscured while a take runs and leave the mouse alone: the driver parks the pointer below the window before the capture starts and drives it from there. The published assets live on the website, deployed before any README links to them; this repository carries the pipeline, not the videos.

## Next Steps

- [Budgets](../budgets/): two pots over the same tools, with a category cap
- [Multi-Upstream](../multi-upstream/): the same toolset on two doors, with door-scoped controls
- [Slack Approvals](../slack-approvals/): the Slack app setup for approval channels
