# Basic Example

A minimal Helio configuration that logs everything, denies destructive operations, and allows everything else. This is the best starting point for understanding how Helio works.

## What This Demonstrates

- Transparent MCP proxying (all tool calls pass through Helio)
- Annotation-based policy matching (`readOnlyHint`, `destructiveHint`)
- Deny rules with structured self-repair feedback
- The Helio dashboard for real-time visibility
- Audit trail recording every tool call

## Prerequisites

- Node.js 22+
- `jq` (optional) for pretty-printing JSON command output. If unavailable, remove `| jq` from curl commands.
- Build the proxy from the repo root:

```bash
pnpm install && pnpm build
```

## Quick Start

```bash
cd examples/basic
pnpm start
```

This starts:

1. A local MCP echo server on port 8080 (7 demo tools)
2. The Helio proxy on port 3000
3. The dashboard on port 3100

> **Note:** All examples use the same ports (8080, 3000, 3100). Stop any running example before starting another.

## Try It Out

> If `jq` is not installed, remove `| jq` from the command snippets below.

### List available tools

```bash
curl -s -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq
```

### Call a read-only tool (allowed)

```bash
curl -s -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_weather","arguments":{"city":"London"}}}' | jq
```

This passes through because `get_weather` has `readOnlyHint: true` and matches the `allow-reads` rule.

### Call a write tool (allowed by default)

```bash
curl -s -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"send_email","arguments":{"to":"alice@example.com","body":"Hello"}}}' | jq
```

No rule matches `send_email` specifically, so it falls through to `default: allow`.

### Call a destructive tool (denied)

```bash
curl -s -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"delete_record","arguments":{"id":"123"}}}' | jq
```

This is blocked because `delete_record` has `destructiveHint: true` and matches the `block-destructive` rule. The response includes structured feedback explaining why the action was denied.

### Open the Dashboard

Navigate to [http://localhost:3100](http://localhost:3100) to see (no login prompt in this local open-mode example):

- **Feed**: Real-time stream of all tool calls and policy decisions
- **Audit**: Searchable log of every action with full details
- **Approvals**: Pending approval queue (empty in this example)
- **Limits**: Rate and spend limit status (none configured in this example)
- **Budgets**: Named cross-tool spend pots (none configured in this example)
- **Analytics**: Charts showing action volume, decision breakdown, and top tools

## Configuration Walkthrough

```yaml
version: '1'
```

Required. Currently always `"1"`.

```yaml
upstream:
  url: 'http://localhost:8080/mcp'
  transport: streamable-http
```

The MCP server to govern. All tool calls are forwarded here after policy evaluation. `streamable-http` is the default transport.

```yaml
listen:
  port: 3000
  host: '127.0.0.1'
```

Where the Helio proxy listens. Point your MCP client here instead of directly at the upstream server.

```yaml
dashboard:
  enabled: true
  port: 3100
  allow_open_mode: true
```

The web dashboard for real-time visibility. Served on a separate port. This example intentionally uses local open mode (`allow_open_mode: true`) so `pnpm start` works without secret setup; keep this loopback-only.

```yaml
policies:
  default: allow
  flag_destructive: log
```

`default: allow` means any tool call that doesn't match a rule is permitted. `flag_destructive: log` adds an audit flag when tools have `destructiveHint: true` (even if they're explicitly denied by a rule).

```yaml
rules:
  - name: block-destructive
    match:
      annotations:
        destructiveHint: true
    action: deny
    feedback:
      message: 'Destructive operations are blocked by policy.'
      suggestion: 'Use a non-destructive alternative or request manual action.'
```

First rule evaluated. Any tool with `destructiveHint: true` in its MCP annotations is denied. The `feedback` block provides structured self-repair information to the calling agent.

```yaml
- name: allow-reads
  match:
    annotations:
      readOnlyHint: true
  action: allow
```

Explicitly allows read-only tools. This is redundant with `default: allow` but demonstrates the pattern — in production you'd typically use `default: deny` and explicitly allow specific tools.

```yaml
approval:
  timeout: 300s
  default_on_timeout: deny
  channels:
    - type: dashboard
```

Approval configuration. No rules in this example use `require_approval`, but the dashboard channel is set up so the Approvals page works. See the [slack-approvals example](../slack-approvals/) for approval workflows in action.

```yaml
audit:
  storage: sqlite
  path: ./helio-audit.db
  retention: 90d
  include_responses: true
```

Every tool call is recorded to a local SQLite database. `include_responses: true` captures the full upstream response (set to `false` for privacy-sensitive deployments). Records older than 90 days are automatically cleaned up.

## Next Steps

- [Slack Approvals](../slack-approvals/) — Route sensitive actions to Slack for human approval
- [Spend Limits](../spend-limits/) — Cap monetary spend across payment tools
- [Budgets](../budgets/) — One cross-tool budget with break-glass overage approvals
