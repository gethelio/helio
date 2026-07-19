<p align="center">
  <h1 align="center">Helio</h1>
  <p align="center">Open-source governance proxy for AI agents</p>
</p>

<p align="center">
  <a href="https://github.com/gethelio/helio/actions/workflows/ci.yml"><img src="https://github.com/gethelio/helio/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/gethelio/helio/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" alt="License" /></a>
  <a href="https://www.npmjs.com/package/@gethelio/proxy"><img src="https://img.shields.io/npm/v/@gethelio/proxy.svg" alt="npm version" /></a>
</p>

<p align="center">
  <a href="https://github.com/gethelio/helio/blob/main/docs/getting-started.md">Getting Started</a> · <a href="https://github.com/gethelio/helio/blob/main/docs/configuration.md">Docs</a> · <a href="https://github.com/gethelio/helio/blob/main/CONTRIBUTING.md">Contributing</a>
</p>

---

Helio is an MCP proxy that sits between your AI agents and the tools they use. Every tool call passes through Helio, which enforces policies, checks evidence, routes approvals, tracks spend, and records everything - **without changing your agent code or your MCP servers.**

```bash
npx @gethelio/proxy init
```

## Why Helio?

Your agent just called an API you didn't expect. It spent money you didn't authorize. It modified a production record you can't easily undo.

Model providers are building governance for their own platforms but your agents run across Claude, ChatGPT, LangChain, CrewAI, and custom frameworks. No single platform governs the full picture. And none of them govern what happens in downstream systems like Stripe, Salesforce, or GitHub.

Helio governs what agents **do to the rest of the world** across any MCP-compatible agent, any tool, any platform.

## How It Works

```
┌──────────────┐     ┌──────────────────────┐     ┌──────────────┐
│              │     │       Helio           │     │              │
│  MCP Client  │────▶│                       │────▶│  MCP Server  │
│  (Agent)     │◀────│  • Policy engine      │◀────│  (Tools)     │
│              │     │  • Evidence grounding  │     │              │
└──────────────┘     │  • Approval workflows  │     └──────────────┘
                     │  • Rate & spend limits │
        Optional     │  • Audit trail         │
      ┌─────────┐    │  • Self-repair feedback│
      │  SDK    │───▶│                       │
      │ (thin)  │    └──────────────────────┘
      └─────────┘
```

Two integration paths:

1. **Proxy only**: Point your MCP client at Helio instead of your MCP server. Zero code changes. Immediate governance.
2. **Proxy + SDK**: Add the thin Python SDK to annotate tool calls with evidence context and action dependencies. Richer governance, under 500 lines of code.

## Quick Start (5 minutes)

### 1. Install

```bash
npx @gethelio/proxy init
```

### 2. Configure

Create a `helio.yaml` in your project root:

```yaml
version: '1'

upstream:
  url: 'http://localhost:3001/mcp' # Your existing MCP server

listen:
  port: 3000 # Helio listens here

policies:
  default: allow

  rules:
    # Require approval for write operations
    - match:
        tool: '*'
        annotations:
          readOnlyHint: false
      action: require_approval
      approval:
        channel: dashboard
        timeout: 300s

    # Block destructive operations
    - match:
        tool: 'delete_*'
      action: deny
      feedback:
        message: 'Destructive operations are disabled'

    # Rate limit expensive API calls
    - match:
        tool: 'search_*'
      action: rate_limit
      limits:
        max_calls: 100
        window: 1h
        key: tool

    # Spend limit on payment tools
    - match:
        tool: 'create_payment'
      action: spend_limit
      limits:
        max_spend:
          field: '$.amount'
          limit: 5000
          currency: 'GBP'
          window: 24h

budgets:
  # One depleting pot shared by every tool that spends.
  - name: agent-payments
    limit: 50
    currency: USD
    window: session
    key: session
    on_exceed: deny # or require_approval for a break-glass ticket
    contributors:
      - tool: 'stripe_*'
        field: '$.amount'
      - tool: 'paypal_*'
        field: '$.total'

audit:
  storage: sqlite
  retention: 90d
  include_responses: true

dashboard:
  enabled: true
  port: 3100
  # Required whenever any rule uses `require_approval`. Generate with:
  #   openssl rand -hex 32
  api_secret: '${HELIO_DASHBOARD_SECRET}'
```

If you use the `${HELIO_DASHBOARD_SECRET}` placeholder above, set it before `start`:

```bash
export HELIO_DASHBOARD_SECRET="$(openssl rand -hex 32)"
```

> **Host binding defaults.** `helio start` binds `listen.host` and `dashboard.host` to `127.0.0.1` by default (the `helio init` template writes this value, and the schema defaults to it). Do **not** flip either to `0.0.0.0` without putting an authenticating reverse proxy in front — the MCP edge has no authentication at all, and the dashboard sideband's bearer is a shared secret, not a user session. The [Docker quickstart](https://github.com/gethelio/helio/tree/main/docker) inverts this layering: inside the container the bundled config binds `0.0.0.0` (correct for the container's virtual network) and Compose's `ports:` map publishes both ports back to `127.0.0.1` on the host.

### 3. Start Helio

```bash
npx @gethelio/proxy start
```

### 4. Point your agent at Helio

```json
{
  "mcpServers": {
    "my-tools": {
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

### 5. Open the dashboard

```
http://localhost:3100
```

That's it. Every tool call now passes through Helio. This includes full audit trail, approval workflows, rate limits, and spend controls.

> **Notification transport semantics (v0.1).** For JSON-RPC notifications (requests with no `id`), Helio's `streamable-http` endpoint returns `HTTP 202 Accepted` with an empty body after forwarding upstream fire-and-forget. For the legacy `sse` transport, POST requests also return `202` with empty body and response payloads are delivered on the SSE stream. For correlated (non-notification) requests, Helio now requires upstream JSON-RPC responses to include an `id`; missing-id upstream replies are wrapped as protocol-invalid upstream errors.

## Features

### Policy Engine

Declarative YAML rules that match on tool name, annotations, input parameters, environment, and cumulative state. Irreversible actions are flagged, and dry-run mode runs the full pipeline without forwarding to the MCP server. Policies hot-reload without restart.

```yaml
policies:
  rules:
    - match:
        tool: 'create_payment'
        input:
          '$.amount': { gt: 1000 }
      action: require_approval
```

### Cross-Tool Spend Budgets

Cumulative cross-tool spend enforcement: one depleting pot aggregates spend across every tool that feeds it — Stripe and PayPal into one cap, each exposing the amount under its own argument field. Deterministic at the MCP gate, persistent across restarts via a durable spend ledger, with break-glass approvals for overages and a live dashboard view.

```yaml
budgets:
  - name: agent-payments
    limit: 50
    currency: USD
    window: session
    key: session
    on_exceed: require_approval # or: deny
    contributors:
      - tool: 'stripe_*'
        field: '$.amount'
      - tool: 'paypal_*'
        field: '$.total'
```

### Evidence Grounding

Require proof before high-stakes actions. A refund requires a prior order lookup. A deployment requires a passing test run. The optional SDK marks tool outputs as evidence; the proxy enforces evidence requirements.

```yaml
policies:
  rules:
    - match:
        tool: 'process_refund'
      action: deny
      evidence:
        requires: ['orders.lookup']
```

```python
# Optional SDK enrichment
from helio import HelioContext

# Mark a tool output as evidence
with HelioContext() as ctx:
    result = orders.lookup(order_id)
    ctx.mark_evidence("orders.lookup", "order_data", result)
```

The SDK talks to the proxy over the sideband API (default `127.0.0.1:3200`; bind host is configurable via `sdk.host`). On every `helio start` the proxy generates a fresh 32-byte hex token and prints it to stderr:

```
SDK sideband listening on http://127.0.0.1:3200
SDK token (pass as HELIO_SDK_TOKEN env var to your SDK clients):
  3f9c2b...d8a1
```

Pass the same value to the SDK process via `HELIO_SDK_TOKEN` and the SDK automatically attaches `Authorization: Bearer <token>` to every sideband call. The sideband also rejects any request carrying a non-null `Origin` header, so a malicious local HTML file cannot talk to it through a browser. Operators who need a stable token across restarts can set `HELIO_SDK_TOKEN` explicitly in the proxy's environment — the proxy respects a pre-set value instead of regenerating one.

### Self-Repair Feedback

When Helio blocks an action, it returns structured feedback explaining what failed and what the agent should do next. The agents can then self-correct and retry.

```json
{
  "blocked": true,
  "reason": "evidence_missing",
  "missing_evidence": ["orders.lookup"],
  "suggestion": "Call orders.lookup with the order ID before retrying"
}
```

### Action Dependency Chains

Declare prerequisite actions in policy. The proxy tracks completed actions per session and blocks anything where prerequisites aren't met.

```yaml
policies:
  rules:
    - match:
        tool: 'process_refund'
      action: allow
      requires: ['orders.lookup', 'customer.verify']
```

### Approval Workflows

Route sensitive actions to Slack, webhook, or the Helio dashboard. Configurable timeout and escalation, plus a dashboard-only break-glass override (REST API and dashboard UI; not exposed as a Slack button).
If a channel delivery fails, Helio logs an operational warning and emits an `approval_notification_failed` dashboard event so operators can investigate without losing the underlying pending ticket.

### Rate & Spend Limits

Rate limits per tool and per session. Per-rule spend limits that block a matched tool at its own cap - for a cumulative cap that spans tools, see [Cross-Tool Spend Budgets](#cross-tool-spend-budgets).

### Audit Trail

Every tool call recorded: timestamp, agent identity, tool name, inputs, policy decision, evidence chain, approval status, downstream response, and latency. Searchable dashboard. Export to JSON or CSV.

## How Helio Compares

|                                              | Helio                                    | Obot                           | Cerbos                            | Built-in (Anthropic / OpenAI)         | Framework (LangChain / CrewAI)      |
| -------------------------------------------- | ---------------------------------------- | ------------------------------ | --------------------------------- | ------------------------------------- | ----------------------------------- |
| **What it governs**                          | Per-call actions with cross-call state   | Which tools/MCPs are reachable | App-level authorization decisions | Agent permissions inside one platform | Agent behavior inside one framework |
| **Architecture**                             | Out-of-process MCP proxy                 | Out-of-process MCP gateway     | Sidecar / library                 | In-platform                           | In-framework                        |
| **Open source**                              | ✅ Apache 2.0                            | ✅ Apache 2.0                  | ✅ Apache 2.0                     | ❌                                    | Varies                              |
| **Time to value**                            | 5 minutes                                | Setup-dependent                | Hours                             | Built-in                              | Built-in                            |
| **No agent code changes**                    | ✅                                       | ✅                             | ❌                                | ✅ (within platform)                  | ❌                                  |
| **Governs agents you didn't build**          | ✅ Any MCP agent                         | ✅ Any MCP agent               | ✅ (any app)                      | ❌ One platform only                  | ❌ One framework only               |
| **Evidence grounding**                       | ✅ Cumulative across calls               | ❌                             | ❌                                | ❌                                    | Limited                             |
| **Self-repair feedback**                     | ✅ Structured retry hints                | ❌                             | ❌                                | ❌                                    | Limited                             |
| **Stateful spend / rate limits**             | ✅ Cross-tool budgets + per-rule limits¹ | Basic                          | ❌                                | ❌                                    | Limited                             |
| **Approval workflows**                       | ✅ Slack, webhook, dashboard             | ✅                             | ❌                                | Limited                               | Limited                             |
| **Audit trail (incl. downstream responses)** | ✅ Captures upstream MCP responses       | Decision logs                  | Decision logs                     | Platform telemetry                    | Framework logs                      |

¹ Per-rule rate and spend limits, plus named cross-tool budgets: persistent depleting pots with break-glass approvals for overages.

## Works With

Helio works with any MCP-compatible agent or framework:

- **Claude** (Anthropic)
- **ChatGPT** (OpenAI)
- **LangChain / LangGraph**
- **CrewAI**
- **AutoGen**
- **Custom agents** using any MCP client SDK

## Documentation

The full docs live in the [monorepo](https://github.com/gethelio/helio) and are not bundled into this package tarball.

- **[Getting Started](https://github.com/gethelio/helio/blob/main/docs/getting-started.md)**: Install and configure in 5 minutes
- **[Configuration Reference](https://github.com/gethelio/helio/blob/main/docs/configuration.md)**: Every YAML option explained
- **[Policy Guide](https://github.com/gethelio/helio/blob/main/docs/policies.md)**: How to write rules with examples
- **[Approval Workflows](https://github.com/gethelio/helio/blob/main/docs/approvals.md)**: Slack, webhook, and dashboard approvals
- **[Audit Trail](https://github.com/gethelio/helio/blob/main/docs/audit.md)**: What's recorded, how to search, how to export

## Examples

Ready-made configurations for common patterns:

- **[Basic](https://github.com/gethelio/helio/tree/main/examples/basic)**: Deny destructive operations, allow everything else
- **[Slack Approvals](https://github.com/gethelio/helio/tree/main/examples/slack-approvals)**: Route destructive actions to Slack
- **[Spend Limits](https://github.com/gethelio/helio/tree/main/examples/spend-limits)**: Govern payment tool usage
- **[Budgets](https://github.com/gethelio/helio/tree/main/examples/budgets)**: One cross-tool budget across Stripe and PayPal tools, with break-glass overage approvals

## Contributing

We welcome contributions. See [CONTRIBUTING.md](https://github.com/gethelio/helio/blob/main/CONTRIBUTING.md) for setup instructions, coding standards, and PR process.

Good first issues are labeled [`good-first-issue`](https://github.com/gethelio/helio/labels/good-first-issue).

## Community

- **[GitHub Issues](https://github.com/gethelio/helio/issues)**: Bug reports and feature requests
- **[Twitter/X](https://x.com/get_helio)**: Updates and announcements

## License

Apache 2.0 - see [LICENSE](./LICENSE).
