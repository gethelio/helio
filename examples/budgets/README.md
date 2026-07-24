# Cross-Tool Spend Budgets Example

Two pots over the same payment tools. An umbrella budget — `agent-payments`, $50 per session — that every Stripe and PayPal call charges, with a break-glass approval when a call would push past it. And a category cap — `content-distribution`, $15 per session — that only Stripe payments labeled `content_distribution` charge, denying outright when it runs out. This is the [cross-tool spend budgets](../../docs/policies.md#cross-tool-spend-budgets) feature end to end — live depletion in the dashboard, one call feeding two pots, a human approving an overage, and the approved overage landing in the spend ledger.

## What This Demonstrates

- A `budgets:` section independent of policy rules — no rule mentions the payment tools at all
- Cross-tool aggregation: `stripe_*` and `paypal_*` calls deplete the same pot, each contributing from its own argument field (`$.amount` vs `$.total`)
- Contributor input matching: the `content-distribution` pot charges only calls whose `$.category` argument says so, while the umbrella pot charges everything — the [category cap](../../docs/configuration.md#scoping-contributors-by-argument-values) pattern
- `window: session` — a pot that never replenishes on a timer
- `on_exceed: deny` versus `on_exceed: require_approval` — a hard stop on the category cap, a break-glass ticket on the umbrella
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

Open [http://localhost:3100](http://localhost:3100), log in with the secret from `.env`, and go to the **Budgets** tab. Both pots are already there at full headroom — configured budgets appear before any spend.

## Try It Out

Keep the Budgets tab visible while you run these — the pots update live on every charge.

> If `jq` is not installed, remove `| jq` from the command snippets below.

### Charge 1: Stripe, $10 labeled `content_distribution` — one call, two pots

```bash
curl -s -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"stripe_charge","arguments":{"amount":10,"category":"content_distribution","currency":"USD","customer":"cus_123"}}}' | jq
```

Succeeds, and both bars move: **content-distribution 10/15**, **agent-payments 10/50**. The call matched the `stripe_*` glob in both budgets, and in `content-distribution` it also satisfied the `$.category` condition — so the same $10 charges the category pot and the umbrella pot at once. That is the category cap in one screenshot: "$15 a session on content distribution", inside a wider payments budget.

### Charge 2: the same $10 again — the category cap denies

```bash
curl -s -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"stripe_charge","arguments":{"amount":10,"category":"content_distribution","currency":"USD","customer":"cus_123"}}}' | jq
```

Blocked, with `reason: "budget_exceeded"` and a `budgets` array naming **content-distribution** (`limit: 15`, `spent: 10`, `attempted_amount: 10` — the amount this call would charge, which on top of the $10 already spent overshoots the $15 cap). This pot is `on_exceed: deny`, so there is no ticket to approve.

Check the Budgets tab: **agent-payments is still 10/50**. The gate is all-or-nothing — a call rejected by any budget consumes nothing anywhere, not even in the pots that would have allowed it.

### Charge 3: Stripe, $20 with no category — non-participation

```bash
curl -s -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"stripe_charge","arguments":{"amount":20,"currency":"USD","customer":"cus_123"}}}' | jq
```

Succeeds: **agent-payments 30/50**, **content-distribution untouched at 10/15**. The tool glob matched the category pot, but the `$.category` condition did not hold, so the call simply does not feed that budget — not a breach, not a denial, just non-participation.

This is the honest edge of input scoping, and the reason the two pots are paired: an unlabeled call escapes the category cap, but the umbrella still charges it. See [Scoping contributors by argument values](../../docs/configuration.md#scoping-contributors-by-argument-values) for the trust caveat and the allow-list rule that closes the gap when you need it closed.

### Charge 4: PayPal, $20 into the umbrella pot (50/50 used)

```bash
curl -s -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"paypal_payout","arguments":{"total":20,"recipient":"ops@example.com"}}}' | jq
```

Succeeds and lands the umbrella pot exactly on its limit — **agent-payments 50/50** — because a call is allowed while `spent + amount <= limit`. This is the cross-tool point: a different tool, from a different provider, reading its amount from a different field (`$.total`), depleting the **same** $50 pot. No `spend_limit` rule can do this; each rule tracks only its own matched tools. `content-distribution` never sees PayPal at all.

### Charge 5: Stripe, $20 — breach the umbrella, break the glass

```bash
curl -s -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"stripe_charge","arguments":{"amount":20,"currency":"USD","customer":"cus_123"}}}' | jq
```

This would bring the umbrella pot to $70, past the $50 limit — and the command **hangs**. Because `agent-payments` is `on_exceed: require_approval`, the breach raised a break-glass approval ticket instead of a denial. (Contrast charge 2: same breach shape, but a `deny` pot answers immediately.)

Open the **Approvals** tab. The pending ticket lists the breached budget — name, spent, limit, and the attempted amount — with a note that approving spends past the limit. Approve it, and the curl returns the Stripe response. Deny it (or let it time out) and the call is blocked with `reason: budget_exceeded` — budget tickets always fail closed on timeout, even if `approval.default_on_timeout` is `allow`.

### See where the money went

Back on the **Budgets** tab, the umbrella pot now shows $70 spent of $50 — an approved overage legitimately pushes a pot past its limit, and the remaining headroom floors at zero, so every further payment call breaches again (and raises a fresh ticket; a budget approval covers exactly one call, never a standing grant). `content-distribution` is still sitting at 10/15, untouched by anything that did not declare itself.

Expand the umbrella pot's event list: four charges, newest first, and the newest carries the **approved overage** badge. That marking is durable — it is how the charge is recorded in the ledger and on the call's audit record, not just a UI flourish. The category pot's list has exactly one charge — the only call that ever declared itself.

Prefer the API? The same state is available with the dashboard secret as a Bearer token. These need `HELIO_DASHBOARD_SECRET` in the current shell — if this is not the terminal where you sourced `.env`, run `set -a; . ./.env; set +a` (from `examples/budgets`) first:

```bash
curl -s -H "Authorization: Bearer $HELIO_DASHBOARD_SECRET" http://localhost:3100/api/budgets | jq
curl -s -H "Authorization: Bearer $HELIO_DASHBOARD_SECRET" http://localhost:3100/api/budgets/agent-payments/events | jq
curl -s -H "Authorization: Bearer $HELIO_DASHBOARD_SECRET" http://localhost:3100/api/budgets/content-distribution/events | jq
```

### Restart — the pots survive

Stop the example (Ctrl+C) and start it again:

```bash
pnpm start
```

The Budgets tab shows both pots exactly where they left off — agent-payments at $70 spent with zero remaining, content-distribution at $10 of $15. Every charge was written to a ledger in the audit database (`./helio-audit.db`) at record time, and startup replays it. A `window: session` pot comes back with its full accrued spend as long as its last activity is within `idle_ttl` (24h by default). Rule-level rate and spend limits are in-memory and reset on restart; budgets do not.

## How It Works

- **The gate is all-or-nothing.** Every budget matching a call is checked before it forwards; one breach denies (or gates) the whole call, and a denied call records nothing on any budget — or on rule-level rate/spend counters. Charge 2 is that rule in action: the category cap refused, so the umbrella pot stayed where it was.
- **Contributors select on the whole predicate.** A contributor participates when its `tool` glob matches and every `match.input` condition holds; selection is first-match-wins in config order over that combined predicate. A call that matches the glob but fails the conditions does not feed the budget at all — which is why an unlabeled payment charges only the umbrella.
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
