# Rate Limits Example

A Helio configuration that demonstrates sliding-window rate limits for repeated tool calls.

## What This Demonstrates

- Per-tool rate limiting with a shared bucket across all sessions
- The accepted `key: agent` configuration shape, including the current MCP fallback behavior
- Structured self-repair feedback when a request exceeds its limit
- The dashboard Limits page for live bucket state
- Audit trail recording for allowed and rate-limited tool calls

## Prerequisites

- Node.js 22+
- `jq` (optional) for pretty-printing JSON command output. If unavailable, remove `| jq` from curl commands.
- Build the proxy from the repo root:

```bash
pnpm install && pnpm build
```

## Quick Start

```bash
cd examples/rate-limits
pnpm start
```

This starts:

1. A local MCP echo server on port 8080 (5 demo tools)
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

### Hit the per-tool limit

The `limit-weather-lookups` rule allows 3 `get_weather` calls per one-minute window. The fourth call is blocked and returns structured `rate_limited` feedback.

```bash
for city in London Paris Tokyo Berlin; do
  curl -s -X POST http://localhost:3000/mcp \
    -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":\"$city\",\"method\":\"tools/call\",\"params\":{\"name\":\"get_weather\",\"arguments\":{\"city\":\"$city\"}}}" | jq
done
```

This rule uses:

```yaml
- name: limit-weather-lookups
  match:
    tool: 'get_weather'
  action: rate_limit
  limits:
    max_calls: 3
    window: 1m
    key: tool
```

`key: tool` means all `get_weather` calls share one bucket, regardless of session.

### See the agent-scoped config shape

The `limit-email-by-agent` rule shows the `key: agent` shape requested by agent-governance deployments:

```yaml
- name: limit-email-by-agent
  match:
    tool: 'send_email'
  action: rate_limit
  limits:
    max_calls: 2
    window: 5m
    key: agent
```

Current MCP requests do not carry agent identity through `McpRequest`, so Helio accepts this config and logs a startup warning that `key: agent` falls back to `key: tool` at runtime. If you need isolation that works today, use `key: session` and pass an MCP session ID with each request.

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

The MCP server to govern. All tool calls are forwarded here after policy evaluation.

```yaml
dashboard:
  enabled: true
  port: 3100
  allow_open_mode: true
```

The dashboard shows live rate-limit buckets on the Limits page. This example intentionally uses local open mode so `pnpm start` works without extra setup; keep this loopback-only.

```yaml
policies:
  default: allow
```

Any call that does not match a rate-limit or deny rule is allowed.

```yaml
- name: block-destructive
  match:
    annotations:
      destructiveHint: true
  action: deny
```

Destructive tools are denied before rate-limit rules run.

```yaml
- name: allow-reads
  match:
    annotations:
      readOnlyHint: true
  action: allow
```

Read-only tools are explicitly allowed after the more specific `get_weather` rate limit has a chance to match.

```yaml
audit:
  storage: sqlite
  path: ./helio-audit.db
  retention: 90d
  include_responses: true
```

Allowed and blocked calls are recorded to a local SQLite database for dashboard review and export.

## Next Steps

- [Basic](../basic/) - Learn annotation-based allow and deny rules
- [Spend Limits](../spend-limits/) - Cap cumulative spend across payment tools
- [Slack Approvals](../slack-approvals/) - Route sensitive actions to Slack for human approval
