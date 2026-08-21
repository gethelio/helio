# Policy Recipes

Copy these snippets into `helio.yaml` as starting points for common governance policies. Keep specific rules before broad fallback rules because Helio evaluates policy rules in order.

## Auto-Allow Read-Only Tools

Use this when your MCP servers set `readOnlyHint: true` on tools that only fetch or summarize data. Pair it with `default: deny` so unknown tools fail closed until they are reviewed.

```yaml
policies:
  default: deny
  rules:
    - name: allow-read-only-tools
      match:
        annotations:
          readOnlyHint: true
      action: allow
```

> MCP defaults `readOnlyHint` to `false`, so upstream tools must explicitly opt in before this rule matches.

## Route Destructive Tools to Approval

Use this when destructive actions should wait for a human through the dashboard, Slack, or webhook approval flow. Any approval flow also needs `dashboard.api_secret` so approvers or callback systems can resolve tickets through the sideband API.

```yaml
dashboard:
  enabled: true
  api_secret: '${HELIO_DASHBOARD_SECRET}'

policies:
  default: allow
  flag_destructive: require_approval
  rules:
    - name: approve-destructive-tools
      match:
        annotations:
          destructiveHint: true
      action: require_approval
      approval:
        channel: dashboard
        timeout: '10m'
```

> MCP defaults `destructiveHint` to `true`, so set `destructiveHint: false` on safe upstream tools to avoid unnecessary approvals.

## Set a Session Spend Cap

Use this to cap cumulative tool spend per MCP session. The budget is consumed only by calls that pass the spend check and are forwarded upstream.

```yaml
policies:
  default: allow
  rules:
    - name: cap-session-payments
      match:
        tool: 'create_payment'
      action: spend_limit
      limits:
        max_spend:
          field: '$.amount'
          limit: 500
          currency: USD
          window: '1h'
          key: session
      feedback:
        message: 'Session payment budget exceeded.'
        suggestion: 'Wait for the budget window to reset or request human approval.'
```

## Require Evidence Before a Refund

Use this when a refund should only proceed after the agent has looked up the relevant order in the same session.

```yaml
policies:
  default: allow
  rules:
    - name: require-order-lookup-before-refund
      match:
        tool: 'process_refund'
      action: allow
      evidence:
        requires:
          - order_lookup
```

The Python SDK can mark the evidence after the lookup succeeds:

```python
from helio import HelioContext

with HelioContext() as ctx:
    order = orders.lookup(order_id)
    ctx.mark_evidence('order_lookup', 'order_data', order)
```

If the agent calls `process_refund` without fresh `order_lookup` evidence, Helio blocks the call with self-repair feedback telling the agent what evidence to gather before retrying.
