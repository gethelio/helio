# Spend Limits Example

Cap monetary spend across payment and refund tools using sliding window tracking. Payments are limited to $500/hour globally, refunds to $200/hour per session.

## What This Demonstrates

- Spend limit policies with `action: spend_limit`
- Field extraction from tool arguments via JSONPath-style dot paths (`$.amount`)
- Two scoping strategies: `key: tool` (global budget) vs `key: session` (per-session budget)
- Structured self-repair feedback when limits are exceeded
- Dashboard Limits page showing real-time spend utilization

## Prerequisites

- Node.js 22+
- `jq` (optional) for pretty-printing JSON command output. If unavailable, remove `| jq` from curl commands.
- Build the proxy from the repo root:

```bash
pnpm install && pnpm build
```

## Quick Start

```bash
cd examples/spend-limits
pnpm start
```

This starts:

1. A local MCP echo server on port 8080 (7 demo tools including `create_payment` and `create_refund`)
2. The Helio proxy on port 3000
3. The dashboard on port 3100

> **Note:** All examples use the same ports (8080, 3000, 3100). Stop any running example before starting another.
>
> This example enables dashboard local open mode (`dashboard.allow_open_mode: true`) so `pnpm start` works without secret setup. Keep this loopback-only.

## Try It Out

Run these commands in sequence to see the spend limit in action:

> If `jq` is not installed, remove `| jq` from the command snippets below.

### Payment 1: $200 (200/500 used)

```bash
curl -s -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"create_payment","arguments":{"amount":200,"currency":"USD","recipient":"Alice"}}}' | jq
```

Succeeds. Helio extracts `amount: 200` from the tool arguments and records it against the payment budget.

### Payment 2: $200 (400/500 used)

```bash
curl -s -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"create_payment","arguments":{"amount":200,"currency":"USD","recipient":"Bob"}}}' | jq
```

Succeeds. Cumulative spend is now $400 out of the $500 limit.

### Payment 3: $200 (would exceed $500 limit — blocked)

```bash
curl -s -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"create_payment","arguments":{"amount":200,"currency":"USD","recipient":"Charlie"}}}' | jq
```

Blocked. This would bring the total to $600, exceeding the $500/hour limit. The response includes structured feedback explaining the limit and suggesting next steps.

### Check the dashboard

Open [http://localhost:3100](http://localhost:3100) and navigate to the **Limits** page to see current spend utilization with progress bars and countdown timers.

### Refund (separate budget)

```bash
curl -s -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"create_refund","arguments":{"amount":150,"order_id":"ORD-001"}}}' | jq
```

Succeeds. Refunds have their own $200/hour budget tracked per session, independent of the payment budget.

## How Spend Tracking Works

### Sliding window

Spend limits use a sliding window algorithm, not calendar-based resets. A `window: 1h` limit means "no more than $500 in any rolling 1-hour period." As older transactions age out of the window, budget frees up.

### Field extraction

The `field: '$.amount'` setting tells Helio which tool argument contains the monetary amount. It uses JSONPath-style dot notation to resolve nested fields. For example, `$.payment.amount` would extract from `{ payment: { amount: 200 } }`.

### Scoping

- **`key: tool`** — All sessions share a single budget per tool. If one agent spends $400, only $100 remains for any other agent using the same tool.
- **`key: session`** — Each MCP session gets its own independent budget. One session hitting its limit doesn't affect others.

### Rejected calls don't consume budget

If a payment is blocked by the spend limit, the amount is not deducted. Any call that passes the limiter check and is forwarded consumes budget, even if the later upstream call fails.

### In-memory state

Spend-limit rule tracking is stored in memory. Restarting the proxy resets rule-level spend counters. [Cross-tool spend budgets](../budgets/) persist their spend across restarts via a durable ledger.

## Configuration Walkthrough

```yaml
- name: limit-payments
  match:
    tool: 'create_payment'
  action: spend_limit
  limits:
    max_spend:
      field: '$.amount'
      limit: 500
      currency: 'USD'
      window: 1h
      key: tool
  feedback:
    message: 'Payment spend limit exceeded.'
    suggestion: 'Wait for the current window to reset or reduce the payment amount.'
```

- **`match.tool`** — Matches the tool by exact name (glob patterns like `create_*` also work)
- **`action: spend_limit`** — Enables spend tracking for matching calls
- **`limits.max_spend.field`** — JSONPath-style dot path to extract the amount from tool arguments
- **`limits.max_spend.limit`** — Maximum cumulative spend within the window
- **`limits.max_spend.currency`** — Currency label (displayed in the dashboard)
- **`limits.max_spend.window`** — Sliding window duration (`1h`, `24h`, `7d`, etc.)
- **`limits.max_spend.key`** — Scoping: `tool` (global), `session` (per-session), or `agent` (per-agent)
- **`feedback`** — Structured message returned to the agent when the limit is exceeded

## Next Steps

- [Basic](../basic/) — Start with a simpler configuration
- [Slack Approvals](../slack-approvals/) — Route sensitive actions to Slack for human approval
- [Budgets](../budgets/) — One cross-tool budget across Stripe and PayPal tools, with break-glass overage approvals
- Try combining spend limits with approval workflows: require Slack approval for any payment over $100 using `input` matching
