# Multi-Upstream Example

One Helio governing two MCP servers through named doors: `files` at `/mcp/files` and `payments` at `/mcp/payments`. Both upstreams expose the same demo toolset, which is the point — the same tool name on two doors stays two distinct governance targets.

## What This Demonstrates

- A named `upstreams:` list with two entries, each served at its own `/mcp/<name>` door
- The bare-path `404` rejection envelope (nothing is served at `/mcp` or `/sse` in named mode)
- A rule scoped with `match.upstreams` — the rate limit fires only on payments-door traffic
- An upstream-scoped budget contributor — only payments-door charges feed the pot
- Dashboard upstream attribution: Feed upstream chips and filter, the Audit Upstream column and filter, Limits gauges grouped by door, and Analytics (tool, upstream) top-tool rows

## Prerequisites

- Node.js 24+
- `jq` (optional) for pretty-printing JSON command output. If unavailable, remove `| jq` from curl commands.
- Build the proxy from the repo root:

```bash
pnpm install && pnpm build
```

## Quick Start

```bash
cd examples/multi-upstream
pnpm start
```

This starts:

1. Two local MCP echo servers: one for the `files` upstream on port 8080, one for the `payments` upstream on port 8081 (7 demo tools each)
2. The Helio proxy on port 3000
3. The dashboard on port 3100

> **Note:** This example uses ports 8080, 8081, 3000, and 3100. Stop any running example before starting another.
>
> This example enables dashboard local open mode (`dashboard.allow_open_mode: true`) so `pnpm start` works without secret setup. Keep this loopback-only.

## Try It Out

> If `jq` is not installed, remove `| jq` from the command snippets below.

### Each upstream answers at its own door

```bash
curl -s -X POST http://localhost:3000/mcp/files \
  -H 'Content-Type: application/json' \
  -H 'x-helio-session-id: demo' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq '.result.tools | length'
```

Returns `7`. The same request against `http://localhost:3000/mcp/payments` returns the payments upstream's own seven tools. Tool sets are never merged: each door serves exactly its upstream.

### Bare /mcp answers nothing

```bash
curl -s -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

HTTP `404`, with an envelope naming the expected shape:

```
{"jsonrpc":"2.0","error":{"code":-32600,"message":"No MCP endpoint answers this request: this Helio serves named upstreams at /mcp/<name>."}}
```

An unknown name (`/mcp/search`, say) gets the same envelope.

### The rate limit only guards the payments door

The `rate-limit-payments-door` rule matches `create_payment` with `upstreams: [payments]` — three calls per minute. Call it four times through the payments door:

```bash
for i in 1 2 3 4; do
  curl -s -X POST http://localhost:3000/mcp/payments \
    -H 'Content-Type: application/json' \
    -H 'x-helio-session-id: demo' \
    -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"create_payment","arguments":{"amount":10,"currency":"USD","recipient":"Alice"}}}' | jq -c
done
```

The first three succeed; the fourth is denied with the rule's feedback (`The payments door is rate limited.`). Now the same call through the files door:

```bash
curl -s -X POST http://localhost:3000/mcp/files \
  -H 'Content-Type: application/json' \
  -H 'x-helio-session-id: demo' \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"create_payment","arguments":{"amount":10,"currency":"USD","recipient":"Alice"}}}' | jq
```

Succeeds. The rule never matches the files door, and in named mode `key: tool` buckets are keyed per (upstream, tool) — `upstream:payments:tool:create_payment` — so the doors could not share a bucket even under a door-agnostic rule.

### Only payments-door charges feed the budget

The `payments-door-cap` budget caps `stripe_charge` spend at $500 per 24 hours, but its only contributor is scoped `upstreams: [payments]`. Run this twice ($400 of $500 used):

```bash
curl -s -X POST http://localhost:3000/mcp/payments \
  -H 'Content-Type: application/json' \
  -H 'x-helio-session-id: demo' \
  -d '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"stripe_charge","arguments":{"amount":200,"currency":"USD","customer":"cus_1"}}}' | jq
```

The third $200 charge through the payments door is denied — it would bring the pot to $600. The same charge through the files door:

```bash
curl -s -X POST http://localhost:3000/mcp/files \
  -H 'Content-Type: application/json' \
  -H 'x-helio-session-id: demo' \
  -d '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"stripe_charge","arguments":{"amount":200,"currency":"USD","customer":"cus_1"}}}' | jq
```

Succeeds, even though the identical charge through the payments door was just denied: the contributor does not match the files door, so the call neither feeds the pot nor is gated by it.

### See the attribution in the dashboard

Open [http://localhost:3100](http://localhost:3100):

- **Feed** — every call row carries an upstream chip (`files` or `payments`), and the upstream filter narrows the stream to one door.
- **Audit** — the Upstream column records the door; filter by upstream to isolate one server's history.
- **Limits** — the `create_payment` rate gauge sits under its `payments` door group, while unprefixed keys stay in the leading block.
- **Analytics** — top tools count (tool, upstream) pairs, so `create_payment` via `payments` is a separate row from `create_payment` via `files`.

## Configuration Walkthrough

The full config is [helio.yaml](./helio.yaml). The two scoping constructs, with the named `upstreams:` context they require:

```yaml
upstreams:
  - name: files
    url: 'http://localhost:8080/mcp'
  - name: payments
    url: 'http://localhost:8081/mcp'

policies:
  rules:
    - name: rate-limit-payments-door
      match:
        upstreams: [payments] # exact names from the upstreams: list
        tool: 'create_payment'
      action: rate_limit
      limits:
        max_calls: 3
        window: 1m
        key: tool # named mode keys this upstream:payments:tool:create_payment
```

- **`match.upstreams`** — exact upstream names (no globs), OR within the list, AND-combined with the rest of `match`; only valid in named mode
- **`key: tool`** — on the MCP path in named mode, tool buckets key per (upstream, tool), so the same tool on another door tracks separately

```yaml
upstreams:
  - name: files
    url: 'http://localhost:8080/mcp'
  - name: payments
    url: 'http://localhost:8081/mcp'

budgets:
  - name: payments-door-cap
    limit: 500
    currency: USD
    window: 24h
    contributors:
      - match:
          tool: 'stripe_charge'
          upstreams: [payments] # only payments-door calls feed the pot
        field: '$.amount'
```

- **`contributors[].match.upstreams`** — the same exact-name scoping for budget contributors; sideband calls carry no upstream and never match a scoped contributor

See the [Configuration Reference](../../docs/configuration.md#upstreams) for the full `upstreams` schema and the [Policy Guide](../../docs/policies.md#upstreams) for the dead-combination validation rules.

## Next Steps

- [Basic](../basic/) — Start with a simpler single-upstream configuration
- [Spend Limits](../spend-limits/) — Sliding-window spend tracking with field extraction
- [Budgets](../budgets/) — One cross-tool budget across Stripe and PayPal tools, with break-glass overage approvals
- [Migrating to Named Upstreams](../../docs/configuration.md#migrating-to-named-upstreams) — Move an existing singular deployment onto named doors
