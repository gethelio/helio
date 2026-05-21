# Slack Approvals Example

Route non-read-only tool calls to a Slack channel for human approval before execution. Destructive operations are denied outright.

## What This Demonstrates

- Slack approval channel with interactive Approve/Deny buttons
- Rule ordering: deny destructive first, then require approval for writes
- Approval timeout with configurable default action
- Environment variable interpolation for secrets (`${HELIO_SLACK_BOT_TOKEN}`)
- Dashboard approval queue as a fallback channel

## Prerequisites

- Node.js 22+
- `jq` (optional) for pretty-printing JSON command output. If unavailable, remove `| jq` from curl commands.
- A Slack workspace you control
- Build the proxy from the repo root:

```bash
pnpm install && pnpm build
```

## Slack App Setup

### 1. Create the app

Go to [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App** > **From scratch**.

- **App Name**: `Helio Approvals`
- **Workspace**: Select your workspace

### 2. Configure bot permissions

Navigate to **OAuth & Permissions** and add these **Bot Token Scopes**:

- `chat:write` — send approval messages and update them after approve/deny (Slack's `chat.update` API method is authorized by `chat:write`; there is no separate `chat:update` scope)

### 3. Install to workspace

Click **Install to Workspace** and authorize. Copy the **Bot User OAuth Token** (starts with `xoxb-`).

### 4. Get the signing secret

Go to **Basic Information** and copy the **Signing Secret**.

### 5. Set up the approval channel

1. Create a channel (e.g. `#agent-approvals`) or use an existing one
2. Invite the bot: type `/invite @Helio Approvals` in the channel
3. Get the channel ID: right-click the channel name > **View channel details** > copy the ID at the bottom (starts with `C`)

### 6. Enable interactivity

Navigate to **Interactivity & Shortcuts** and toggle **Interactivity** on.

Set the **Request URL** to:

```
http://<your-host>:3000/slack/actions
```

For local testing, you'll need a tunnel (e.g. [ngrok](https://ngrok.com)):

```bash
ngrok http 3000
# Use the https URL from ngrok as the Request URL
```

## Configure

Copy the example environment file and fill in your values:

```bash
cp .env.example .env
```

Edit `.env` and set all four variables:

```
HELIO_SLACK_BOT_TOKEN=xoxb-your-actual-bot-token
HELIO_SLACK_SIGNING_SECRET=your-actual-signing-secret
HELIO_SLACK_CHANNEL=C0123456789
HELIO_DASHBOARD_SECRET=<generate with: openssl rand -hex 32>
```

`helio.yaml` references each value via `${VAR_NAME}` interpolation, so secrets stay out of the YAML.

The dashboard API secret is required whenever any rule uses `require_approval`. Generate a fresh value with `openssl rand -hex 32` — operators use it to unlock the dashboard login screen at `http://127.0.0.1:3100`, and machine clients use it as a Bearer credential for the sideband API. Keep it stored safely (password manager, secrets vault, etc.).

If you lose the secret, recovery means rotation: generate a new value, update `.env`, and restart Helio. Existing dashboard sessions are invalidated and users must sign in again with the new secret.

## Quick Start

```bash
set -a
. ./.env
set +a
pnpm start
```

This starts:

1. A local MCP echo server on port 8080 (5 demo tools)
2. The Helio proxy on port 3000
3. The dashboard on port 3100

> **Note:** All examples use the same ports (8080, 3000, 3100). Stop any running example before starting another.

## Try It Out

> If `jq` is not installed, remove `| jq` from the command snippets below.

### Read-only tool (passes through immediately)

```bash
curl -s -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_weather","arguments":{"city":"London"}}}' | jq
```

`get_weather` has `readOnlyHint: true` — it matches the `allow-reads` rule and passes through.

### Write tool (requires Slack approval)

```bash
curl -s -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"send_email","arguments":{"to":"alice@example.com","body":"Hello"}}}' | jq
```

`send_email` has `readOnlyHint: false` — it matches the `approve-writes` rule. The request hangs while Helio sends an approval message to Slack. Click **Approve** in Slack to allow it, or **Deny** to block it.

### Destructive tool (denied immediately)

```bash
curl -s -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"delete_record","arguments":{"id":"123"}}}' | jq
```

`delete_record` has `destructiveHint: true` — it matches the `block-destructive` rule and is denied before reaching the approval flow.

## How It Works

### Rule evaluation order

Rules are evaluated top-to-bottom, first match wins:

1. **block-destructive** — Denies tools with `destructiveHint: true`
2. **approve-writes** — Requires Slack approval for tools with `readOnlyHint: false`
3. **allow-reads** — Allows tools with `readOnlyHint: true`
4. **default: allow** — Anything not matching a rule is permitted

The order matters: `delete_record` has both `destructiveHint: true` and implicitly `readOnlyHint: false`. Because `block-destructive` is first, it gets denied rather than sent for approval.

### Approval flow

1. Helio holds the MCP request and creates an approval ticket
2. A Block Kit message is posted to the configured Slack channel
3. A human clicks **Approve** or **Deny**
4. Helio resumes the request (forwards to upstream on approve, returns feedback on deny)
5. The entire flow is recorded in the audit trail

### Timeout behavior

If nobody responds within `timeout: 300s` (5 minutes), the `default_on_timeout: deny` setting automatically denies the request. The dashboard also has an approval queue where you can approve/deny directly.

## Next Steps

- [Basic](../basic/) — Start with a simpler configuration
- [Spend Limits](../spend-limits/) — Cap monetary spend across payment tools
