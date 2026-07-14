# Cross-Tool Spend Budgets Example

One cross-tool budget pot shared by Stripe and PayPal demo tools: $50 per session, depleting with every charge, with a break-glass approval when a call would push past the limit. This is the [cross-tool spend budgets](../../docs/policies.md#cross-tool-spend-budgets) feature end to end — live depletion in the dashboard, a human approving an overage, and the approved overage landing in the spend ledger.

## What This Demonstrates

- A `budgets:` section independent of policy rules — no rule mentions the payment tools at all
- Cross-tool aggregation: `stripe_*` and `paypal_*` calls deplete the same pot, each contributing from its own argument field (`$.amount` vs `$.total`)
- `window: session` — a pot that never replenishes on a timer
- `on_exceed: require_approval` — a breach raises a break-glass ticket instead of a denial
- The dashboard Budgets tab: live depletion bars and the per-budget spend ledger, where an approved overage carries its own badge
- Budget spend persisting across a proxy restart via the ledger

## Prerequisites

- Node.js 22+
- `jq` (optional) for pretty-printing JSON command output. If unavailable, remove `| jq` from curl commands.
- Build the proxy from the repo root:

```bash
pnpm install && pnpm build
```

## Configure

Copy the example environment file and generate a dashboard secret:

```bash
cd examples/budgets
cp .env.example .env
echo "HELIO_DASHBOARD_SECRET=$(openssl rand -hex 32)" >> .env
```

(Sourcing the file applies assignments in order, so the appended secret overrides the empty placeholder.)

The secret is required because the budget uses `on_exceed: require_approval` — break-glass tickets need an authenticated dashboard to resolve them, exactly like `require_approval` rules.

## Quick Start

```bash
set -a
. ./.env
set +a
pnpm start
```

This starts:

1. A local MCP echo server on port 8080 (7 demo tools including `stripe_charge` and `paypal_payout`)
2. The Helio proxy on port 3000
3. The dashboard on port 3100

> **Note:** All examples use the same ports (8080, 3000, 3100). Stop any running example before starting another.

Open [http://localhost:3100](http://localhost:3100), log in with the secret from `.env`, and go to the **Budgets** tab. The `agent-payments` pot is already there at full headroom — configured budgets appear before any spend.

## Try It Out

Keep the Budgets tab visible while you run these — the pot updates live on every charge.

> If `jq` is not installed, remove `| jq` from the command snippets below.

### Charge 1: Stripe, $20 (20/50 used)

```bash
curl -s -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"stripe_charge","arguments":{"amount":20,"currency":"USD","customer":"cus_123"}}}' | jq
```

Succeeds. Helio matched the `stripe_*` contributor, extracted `amount: 20`, and recorded it against the pot — the Budgets tab bar moves as the charge commits.

### Charge 2: PayPal, $20 into the same pot (40/50 used)

```bash
curl -s -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"paypal_payout","arguments":{"total":20,"recipient":"ops@example.com"}}}' | jq
```

Succeeds — and this is the point of the example: a different tool, from a different provider, reading its amount from a different field (`$.total`), depleting the **same** $50 pot. No `spend_limit` rule can do this; each rule tracks only its own matched tools.

### Charge 3: Stripe, $20 — breach, break the glass

```bash
curl -s -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"stripe_charge","arguments":{"amount":20,"currency":"USD","customer":"cus_123"}}}' | jq
```

This would bring the pot to $60, past the $50 limit — and the command **hangs**. Because the budget is `on_exceed: require_approval`, the breach raised a break-glass approval ticket instead of a denial.

Open the **Approvals** tab. The pending ticket lists the breached budget — name, spent, limit, and the attempted amount — with a note that approving spends past the limit. Approve it, and the curl returns the Stripe response. Deny it (or let it time out) and the call is blocked with `reason: budget_exceeded` — budget tickets always fail closed on timeout, even if `approval.default_on_timeout` is `allow`.

### See where the money went

Back on the **Budgets** tab, the pot now shows $60 spent of $50 — an approved overage legitimately pushes a pot past its limit, and the remaining headroom floors at zero, so every further payment call breaches again (and raises a fresh ticket; a budget approval covers exactly one call, never a standing grant).

Expand the pot's event list: three charges, newest first, and the third one carries the **approved overage** badge. That marking is durable — it is how the charge is recorded in the ledger and on the call's audit record, not just a UI flourish.

Prefer the API? The same state is available with the dashboard secret as a Bearer token. These need `HELIO_DASHBOARD_SECRET` in the current shell — if this is not the terminal where you sourced `.env`, run `set -a; . ./.env; set +a` (from `examples/budgets`) first:

```bash
curl -s -H "Authorization: Bearer $HELIO_DASHBOARD_SECRET" http://localhost:3100/api/budgets | jq
curl -s -H "Authorization: Bearer $HELIO_DASHBOARD_SECRET" http://localhost:3100/api/budgets/agent-payments/events | jq
```

### Restart — the pot survives

Stop the example (Ctrl+C) and start it again:

```bash
pnpm start
```

The Budgets tab shows the pot exactly where it left off — $60 spent, zero remaining. Every charge was written to a ledger in the audit database (`./helio-audit.db`) at record time, and startup replays it. A `window: session` pot comes back with its full accrued spend as long as its last activity is within `idle_ttl` (24h by default). Rule-level rate and spend limits are in-memory and reset on restart; budgets do not.

## How It Works

- **The gate is all-or-nothing.** Every budget matching a call is checked before it forwards; one breach denies (or gates) the whole call, and a denied call records nothing on any budget — or on rule-level rate/spend counters.
- **Rules decide first, budgets deplete after.** The `policies` rules in this example never mention the payment tools; the budget layer is independent. A deny rule that matched a payment tool would block it before the budget gate — keep deny rules scoped so the budget gate stays reachable.
- **`window: session` pots never replenish on a timer.** Idle pots are collected after `idle_ttl` (default 24h), because neither door has an authoritative session-end signal. The curl walkthrough sends no MCP session id, so its calls pool into the budget's shared `unknown` session pot — real MCP clients with sessions each get their own pot.
- **Break-glass is scope-once and fails closed.** Approving covers exactly the one call's overage; timeouts never fail open for money gates.

See the [Policy Guide](../../docs/policies.md#cross-tool-spend-budgets) for full budget semantics and the [configuration reference](../../docs/configuration.md#budgets) for every field and validation rule.

## Routing Break-Glass Tickets to Slack

The same flow works with Slack instead of the dashboard. In `helio.yaml`, uncomment the `slack` channel under `approval.channels`, switch the budget's `approval.channel` to `slack`, and fill in the Slack variables in `.env` (see [Slack Approvals](../slack-approvals/) for the app setup). Breach tickets then arrive as Slack messages with a rendered "Breached budgets" section and Approve/Deny buttons.

## Next Steps

- [Spend Limits](../spend-limits/) — the per-rule quick path budgets build on
- [Slack Approvals](../slack-approvals/) — full Slack app setup for approval channels
- [Docker quickstart](../../docker/) — the same budget demo, containerized
