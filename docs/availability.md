# Availability and Failure Modes

What an agent sees and what an operator does when Helio is not running,
refuses to run, crashes, stops, or loses its upstream. The first screen is for
the evaluator asking "what happens when the proxy is down"; the rest is for the
operator running it under a supervisor. Every claim names the test that pins
it, by its describe and it names, or is marked "not currently guaranteed".
Where the code falls short of what a reader would expect, the shortfall is an
issue listed under [Known gaps](#known-gaps), never described as handled.

What the agent sees is stated at the wire: a refused connection, an empty
reply, or HTTP 200 carrying a JSON-RPC error with its `code`, `reason` and
`failure_class`. Those are what Helio controls. How a client renders them is
not claimed here.

## The posture

**1. No governed call passes while Helio is not serving.** A stopped, crashed,
restarting or refusing proxy refuses traffic; there is no fail-open path in the
proxy. This holds only while the agent has no other route to the upstream, and
the [residuals in SECURITY.md](../SECURITY.md#process-and-filesystem-boundaries)
name two: an HTTP upstream the agent can address directly, closed only by
credential termination, and, for stdio upstreams, the server command itself,
which the agent, or any co-located process that can read the proxy's command
line, can run.

**2. A refusal to start is a refusal to serve.** A failure of validation, of
the config pin, of policy compilation, of a port bind, or of any upstream's
connect exits 1 before or instead of serving; the operator reads one diagnosis,
with the offending config path on the next line when there is one. On a
named-upstreams config one door's failed connect refuses the whole process. The
exception: a `streamable-http` upstream that is down at boot does not refuse,
because that transport connects lazily. What each call then gets is the table
directly below.

### Every gate, with the upstream down

Scope: one door. On a named config each door at `/mcp/<name>` and
`/sse/<name>` has its own forwarder, era and tool cache, and a bare `/mcp` or
`/sse` is a 404 whatever the upstream's state. The proxy serves only when
every door's connect succeeded. Wire shape: for a request with an id, each row
states the JSON-RPC body the agent's POST gets on the streamable-http listener
(HTTP 200); on Helio's `/sse` listener the same body arrives as an event on the
agent's stream and the POST gets 202. A notification has its own row. For
`tools/call` the gate code is unchanged; its annotation and drift inputs are
the unprimed ones until a prime succeeds, and only a call the gates let through
reaches the upstream-unreachable error. Other methods pass through ungoverned;
see the last three rows.

| Gate                                                                                                                  | With the upstream down                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Backed by                                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kill switch                                                                                                           | refused before any evaluation, never waits ([Kill Switch](./kill-switch.md))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `kill switch on the MCP door (issue #402)`                                                                                                                                                                                                               |
| Rule `deny`, or `default: deny` with no rule                                                                          | blocks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `GovernedForwarder > deny action`                                                                                                                                                                                                                        |
| `on_tool_drift: block` on a drifted tool                                                                              | blocks, but only after a live list has compared the tool: while the prime fails, no drift is recorded and neither `block` nor `require_approval` fires                                                                                                                                                                                                                                                                                                                                                                                                                                                            | depends on a successful prime; the unprimed decision is the documented default ([drift after a restart](./policies.md#tool-definition-drift)), not a test                                                                                                |
| A rule matching on annotations; `flag_destructive`                                                                    | while unprimed, judged on the MCP defaults (`destructiveHint: true`, `readOnlyHint: false`), so a tool the primed cache would call read-only can match a destructive rule or wait under `flag_destructive: require_approval`                                                                                                                                                                                                                                                                                                                                                                                      | depends on a successful prime; the unprimed decision is the documented default ([startup priming](./configuration.md#startup-annotation-cache-priming)), not a test                                                                                      |
| Missing or expired evidence key                                                                                       | blocks (rewritten to deny)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `GovernedForwarder > evidence grounding`                                                                                                                                                                                                                 |
| Unmet `requires` dependency                                                                                           | blocks (rewritten to deny)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `GovernedForwarder > dependency chains`                                                                                                                                                                                                                  |
| Spent `rate_limit`                                                                                                    | blocks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `GovernedForwarder > rate_limit action`                                                                                                                                                                                                                  |
| Spent `spend_limit`, or an amount it cannot read                                                                      | blocks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `GovernedForwarder > spend_limit action`                                                                                                                                                                                                                 |
| Budget breach under `on_exceed: deny`, or an amount it cannot read                                                    | blocks, records nothing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `GovernedForwarder > budget gate (issue #14)`                                                                                                                                                                                                            |
| Rule `require_approval`; `flag_destructive: require_approval` with no rule matched; `on_tool_drift: require_approval` | waits; an approval or break-glass, or a timeout under `default_on_timeout: allow`, goes on to the budget gate, and only a call that passes it is forwarded and gets the error (charged when it feeds a budget or a rate or spend limit); a denial or a closed timeout blocks                                                                                                                                                                                                                                                                                                                                      | `GovernedForwarder > break-glass approval outcome`, `GovernedForwarder > approval context on audit records`                                                                                                                                              |
| Budget breach under `on_exceed: require_approval`                                                                     | waits; only an approval or break-glass forwards (into the charge and the error); the ticket's timeout stays closed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `GovernedForwarder > budget break-glass (issue #14)`                                                                                                                                                                                                     |
| `dry_run` (rule action or global)                                                                                     | never forwarded; returns its synthetic response                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `GovernedForwarder > dry_run`                                                                                                                                                                                                                            |
| Everything else (`allow`, a passing rate or spend limit, a passing budget)                                            | forwarded, gets the error; charged when it feeds a budget or a rate or spend limit, and a plain `allow` that feeds neither is charged nothing                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `writes audit row when upstream forwarding throws after policy allow`; `consumes the budget charge and the rate slot before a forward that fails`                                                                                                        |
| A request other than `tools/call` with an id, except `initialize` (for example `tools/list`)                          | not governed; passed through and gets the error                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `GovernedForwarder > non-tool methods pass through`; `upstream unreachable returns normalized JSON-RPC error envelope`                                                                                                                                   |
| A notification (no id)                                                                                                | not governed; the agent gets HTTP 202 and an empty body on either listener, never the error; the forward's failure is only a stderr line (`[helio] Upstream notification forward failed`)                                                                                                                                                                                                                                                                                                                                                                                                                         | `returns 202 for notifications even when upstream forwarding fails`; `POST notification returns 202 when forwarder throws and emits no SSE response envelope`                                                                                            |
| `initialize` on an auto-mode `streamable-http` door                                                                   | while the era probe cannot classify the upstream, the relay presumes legacy for that request and forwards it (so it gets the error); once classified modern it is answered locally. A dated `protocol_version` pin never probes: a modern pin answers `initialize` locally even while the upstream is down, a legacy pin forwards it. An `sse` upstream has no era probe and always forwards `initialize`; it cannot be down at boot (its connect refuses), and if its stream drops later a call already waiting on it fails `SSE stream ended` and every forward after that throws `SSE forwarder not connected` | not currently guaranteed; the era rules are the [era detection reference](./configuration.md#upstream-mcp-era-detection), and `start with an unreachable singular sse upstream exits 1 with the connect error alone (issue #233)` pins the `sse` refusal |

**3. A call waiting on an approval fails closed.** On a graceful stop it is
answered `shutdown_cancelled`; on a crash or hard kill the connection closes
with no answer, which is not currently guaranteed to carry a reason
([#460](https://github.com/gethelio/helio/issues/460)). This says nothing
about a call already forwarded to the upstream; see the
[graceful stop](#graceful-stop) note.

**4. On the MCP door, money and rate counters are consumed before the forward,
and there is no refund path,** including for a refused connect that provably
never reached the upstream. The order exists so that a failed ledger write
blocks the call ([Budget Ledger Tables](./audit.md#budget-ledger-tables)). The
sideband door commits at `/audit` once the call executed
([budget gate order](./policies.md#cross-tool-spend-budgets)).

**5. Audit never blocks a call,** so its durability is bounded: a crash drains
the buffered rows before the process exits; a hard kill can lose the last
100 ms of them.

## The failure table

| Case                                                 | What the agent sees                                                                                                                                                                                                                                                              | What the operator does                                                                                                                                                                                         | Backed by                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Never started                                        | a TCP connection refused at the configured URL; nothing reaches the upstream through Helio                                                                                                                                                                                       | start it under a supervisor; the bound is the residuals in sentence 1                                                                                                                                          | not currently guaranteed (nothing is running to test)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Refuses to start                                     | the same refused connection; the process exits 1 after one diagnosis on stderr, and no port stays bound                                                                                                                                                                          | read the diagnosis, fix the file, run `helio validate -c <file>`, restart                                                                                                                                      | `refuses a compile failure before a missing stdio command is spawned (issue #195)`; `refuses an audit.path whose directory does not exist on one line (issue #388)`; `start with listen.port already in use closes the stdio upstream child it had spawned (issue #375)`; `start with an unreachable singular sse upstream exits 1 with the connect error alone (issue #233)`; `all-or-nothing boot: an unreachable entry fails startup naming it (issue #294)`; `rejects an explicit dashboard channel when the dashboard is disabled` |
| Crash (uncaught exception or unhandled rejection)    | every open connection closes with no answer, a call held on an approval included; exit 1 after the audit drain                                                                                                                                                                   | let the supervisor restart it; read the `[helio] Uncaught exception:` or `[helio] Unhandled promise rejection:` line; check for an orphaned stdio child ([#377](https://github.com/gethelio/helio/issues/377)) | `a crash drains the audit buffer and exits 1`; the held call's silence is [#460](https://github.com/gethelio/helio/issues/460)                                                                                                                                                                                                                                                                                                                                                                                                          |
| Hard kill (SIGKILL, the OOM killer, power loss)      | every open connection closes with no answer; nothing is drained                                                                                                                                                                                                                  | let the supervisor restart it; expect the audit gap described under [crash](#crash)                                                                                                                            | not currently guaranteed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Graceful stop (SIGTERM or SIGINT)                    | a held approval is answered `-32001` with `reason: shutdown_cancelled` and `retry_allowed: true`, and gets its audit row; a call already forwarded is waited on inside a short grace; then the doors close; exit 0                                                               | nothing; the agent retries once the proxy is back                                                                                                                                                              | `keeps budget spend, clears rate windows and evidence, and settles a held approval on SIGTERM`; `shutdown with pending approval returns shutdown_cancelled and writes distinct audit fields`; `drains every traffic door before tearing down governance state`; the in-flight grace is not currently guaranteed                                                                                                                                                                                                                         |
| Upstream unreachable, HTTP connection refused        | HTTP 200 with `-32603` and `failure_class: upstream_forward_error`; the gates decided first and their counters are consumed                                                                                                                                                      | fix the upstream; no proxy restart is needed; expect the first calls after recovery to meet the counters the outage consumed                                                                                   | `writes audit row when upstream forwarding throws after policy allow`; `consumes the budget charge and the rate slot before a forward that fails`; `upstream unreachable returns normalized JSON-RPC error envelope`; `continues startup when initial annotation prime fails, remaining fail-closed`                                                                                                                                                                                                                                    |
| Upstream unreachable, HTTP accepts and never answers | the same envelope after `upstream.request_timeout`                                                                                                                                                                                                                               | the same                                                                                                                                                                                                       | the charge and slot by `consumes the budget charge and the rate slot before a forward that fails`; the wait itself is not currently guaranteed                                                                                                                                                                                                                                                                                                                                                                                          |
| Upstream unreachable, stdio child exits              | the in-flight call waits out `upstream.request_timeout`, then the same envelope; the child is respawned and the next call is served; a server that enforces `initialize` rejects every call after the respawn with `-32002` until the client re-initializes                      | nothing for the respawn; for a handshake-enforcing server, have the client re-initialize ([#459](https://github.com/gethelio/helio/issues/459))                                                                | `auto-restarts on crash up to maxRetries`; `uses upstream.request_timeout for stdio transport`; the wait is [#461](https://github.com/gethelio/helio/issues/461); the respawn delay and how many respawns a repeatedly crashing server gets are not currently guaranteed                                                                                                                                                                                                                                                                |
| Sideband unreachable while the proxy serves          | the Python SDK raises `HelioError` with a message starting `Cannot connect to proxy at`; the evidence is not stored, so the gated call is denied `evidence_missing`; an approver who cannot reach the dashboard leaves held calls to `approval.timeout` and `default_on_timeout` | fix the route to the sideband; an adapter must block on its own (see [Adapter API](./adapter-api.md))                                                                                                          | `test_raises_helio_error_when_proxy_is_unreachable` for the SDK error; `blocks action when required evidence is missing` for the denial; `resolves with timeout status and timeoutMs when timer fires` and `escalated then timed out (deny mode) records the escalation` for the timeout; `rejects an explicit dashboard channel when the dashboard is disabled` for the refused configuration                                                                                                                                          |
| Deliberate halt                                      | every governed call refused `-32001` with `reason: kill_switch` and `retry_allowed: false`                                                                                                                                                                                       | `helio resume`; see [Kill Switch](./kill-switch.md)                                                                                                                                                            | `kill switch on the MCP door (issue #402)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Bad config written while running                     | nothing; the running policy stays                                                                                                                                                                                                                                                | fix the file before any restart: the next boot refuses it; alert on `[helio] Config reload failed (keeping current configuration):`                                                                            | `calls onError and keeps old policy when config is invalid YAML`; `refuses a reload whose bytes do not hash to the pin, before parsing, and keeps the policy`                                                                                                                                                                                                                                                                                                                                                                           |

## Each case

### Never started

Nothing is listening at the configured URL, so the agent's connection is
refused at the TCP level and nothing reaches the upstream through Helio. That
is fail closed only while the agent has no other route to the upstream, which
is the bound sentence 1 states.

### Refuses to start

Every refusal prints one diagnosis on stderr and exits 1; when the cause is a
config path, that path is on the next line. No port stays bound after the
exit: the MCP port binds first and is closed again when a later bind fails.
The shapes:

```
Error: Invalid configuration (1 error)
  dashboard.api_secret: dashboard.api_secret is required when any rule uses require_approval, ...
```

```
Error: Environment variable "HELIO_DASHBOARD_SECRET" is not set
  dashboard.api_secret: reads ${HELIO_DASHBOARD_SECRET}
```

```
listen.port 3000 is already in use on 127.0.0.1 (EADDRINUSE). Stop the process holding it, or set listen.port in helio.yaml to a free port.
```

```
Upstream MCP server at http://127.0.0.1:8080/sse is unreachable (ECONNREFUSED) ...
```

The refusing causes: a missing or unreadable config file, a schema error, a
policy or budget that does not compile, an unset `${VAR}`, a
`HELIO_CONFIG_SHA256` that does not match the file, a `require_approval` with
no `dashboard.api_secret`, a dashboard-channel approval with the dashboard
disabled, a stdio command that cannot be spawned, an `sse` upstream that
refuses the connection, and a held `listen.port` or `dashboard.port`. A
`streamable-http` upstream that is down at boot is not one of them: the proxy
starts, prints the listening line, prints
`[helio] Annotation cache priming failed: ...` and retries the prime on a
backoff. The `fail-closed` in that line is the annotation default (an unprimed
tool is judged on the MCP defaults); it does not mean calls are denied. Every
call the gates let through gets the upstream-unreachable envelope until the
upstream is up; every blocking gate still blocks, and a `dry_run` never
forwards, as the table under sentence 2 says.

### Crash

An uncaught exception or an unhandled rejection prints
`[helio] Uncaught exception:` or `[helio] Unhandled promise rejection:`, runs
the crash drain with a 2 s cap, which flushes the buffered audit rows, and
exits 1. Every open connection closes with no answer. A call held on an
approval gets that silence and no audit row; the ticket vanishes
([#460](https://github.com/gethelio/helio/issues/460)). A stdio child that
ignores stdin EOF survives the crash and is not reaped
([#377](https://github.com/gethelio/helio/issues/377)).

A hard kill (SIGKILL, the OOM killer, power loss) drains nothing. Audit rows
still in the writer's buffer are lost; the buffer flushes about every 100 ms,
so that is the bound, and it is not currently guaranteed. The budget ledger is
written synchronously before the forward, so every charge lands even when the
audit row for the same call did not; a ledger row can then reference an audit
id that never landed, which is not currently guaranteed either way. This is the
cost of audit never blocking a call, and no issue tracks it.

### Graceful stop

SIGTERM or SIGINT prints `[helio] Shutting down...` and closes in this order:
the prime loops and the config watcher stop, the kill-switch poller stops,
held approvals settle, SSE clients close, the three doors drain, governance
state and storage close, the forwarders close last. The exit code is 0; a 5 s
timer prints `[helio] Forced shutdown after timeout` and exits 1 if the close
has not finished.

A call held on an approval is answered on the wire:

```json
{
  "jsonrpc": "2.0",
  "id": 6,
  "error": {
    "code": -32001,
    "message": "Approval cancelled by proxy shutdown",
    "data": {
      "blocked": true,
      "reason": "shutdown_cancelled",
      "rule": "email-approval",
      "rule_index": 2,
      "action": "require_approval",
      "suggestion": "The proxy was shut down while this request was awaiting approval (for example during deploy/restart). Retry once the proxy is healthy.",
      "retry_allowed": true
    }
  }
}
```

and its audit row carries `block_reason: shutdown_cancelled` and
`approval_status: shutdown_cancelled`.

A call already forwarded to the upstream when the stop begins is waited on by
its door's drain, and its socket is force-closed after a 1.5 s grace; one that
finishes inside the grace returns its real result. That is the code's shape,
not currently guaranteed. Pending sideband evaluations are dropped with no
record ([#458](https://github.com/gethelio/helio/issues/458)).

### Upstream unreachable while the proxy is healthy

`GET /healthz` on the MCP port stays 200 throughout; it says the HTTP server
answers, nothing about the upstream.

An HTTP upstream that refuses the connection: the agent gets HTTP 200 carrying

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32603,
    "message": "upstream forwarding failed",
    "data": {
      "failure_class": "upstream_forward_error",
      "failure_reason": "Upstream MCP server at http://127.0.0.1:8080/mcp is unreachable (ECONNREFUSED) ..."
    }
  }
}
```

and the audit row carries the decision and the `upstream_error`. The gates
decided first, and on the MCP door the ledger commit and the rule-limit commit
both run before the forward with no refund on failure: a call that never
reached the upstream still used a rate-limit slot and its budget charge, and
the ledger row is written. No proxy restart is needed for the upstream to be
reachable again, but the first calls after recovery can be the blocks those
consumed counters now require.

An HTTP upstream that accepts and never answers: the same envelope after
`upstream.request_timeout`, with
`failure_reason: "upstream request timed out after 30000ms"` at the default.

A stdio child that exits mid-call: the in-flight call is not failed at the
exit; it waits out `upstream.request_timeout` and then gets the same envelope
with `failure_reason: "request <id> timed out after <n>ms"`
([#461](https://github.com/gethelio/helio/issues/461)). The child is
respawned and the next call is served; the respawn delay and how many
respawns a repeatedly crashing server gets are not currently guaranteed. The
respawned child is never sent `initialize`, so a server that enforces the
handshake rejects every call with `-32002` until the client re-initializes
([#459](https://github.com/gethelio/helio/issues/459)); Helio's own prime
sends `tools/list` to a stdio child without a handshake
([#256](https://github.com/gethelio/helio/issues/256)), so against such a
server the boot prints `not primed`. A chatty stdio child can also block on
its own stderr while `/healthz` stays 200
([#457](https://github.com/gethelio/helio/issues/457)).

### Sideband unreachable while the proxy serves

The dashboard API and the SDK sideband run inside the proxy process and bind at
boot or the boot aborts, so there is no state where the proxy serves and a
configured sideband is not listening. What remains is the route to them.

- The approver cannot reach the dashboard: held calls wait for
  `approval.timeout`, then `default_on_timeout` applies (deny by default; see
  [timeout behavior](./approvals.md#timeout-behavior)). A dashboard-channel
  approval with `dashboard.enabled: false` is refused at validation, so that
  unresolvable state cannot be configured.
- The SDK cannot reach the sideband: the Python SDK raises `HelioError` with a
  message starting `Cannot connect to proxy at`; the evidence is not stored,
  so an evidence-gated call is denied with `evidence_missing` at the gate.
- An adapter cannot reach `/evaluate`: the [Adapter API](./adapter-api.md)
  requires the adapter to block. Helio cannot enforce that from its side.

### Deliberate halt

`helio kill`, or `POST /api/kill-switch`, refuses every governed call with
`-32001` and `reason: kill_switch` before any evaluation, freezes held
approvals, and survives a restart when the marker file was written. The
[Kill Switch](./kill-switch.md) page has the wire shape, the records and the
marker's durability rules.

### Bad config written while running

Hot reload refuses the file and keeps the running policy; stderr prints
`[helio] Config reload failed (keeping current configuration): ...` and a
`policy_reload` audit record carries the outcome. The agent sees nothing. The
next restart refuses to boot on that file, so the running proxy is fine and
the bad file is latent: under a supervisor that restarts on exit, a restart
with the bad file in place loops, and every agent call is refused at the edge
until the file is fixed, after which the loop recovers on its own.

## What survives a restart

One row per kind of state. A restart here is a graceful stop and a start on
the same config and audit path.

| State                                              | Where it lives                                                              | After a restart                                                                                                                                                                                                                                                                                                                                                          | Backed by                                                                                                                                                                                                                                                            |
| -------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Audit records                                      | the audit database (SQLite, WAL)                                            | kept; a crash drains the buffer first; on a hard kill the last 100 ms or so of buffered rows are lost                                                                                                                                                                                                                                                                    | `a crash drains the audit buffer and exits 1`; the hard-kill bound and the ledger rows it can leave pointing at audit ids that never landed are not currently guaranteed                                                                                             |
| Budget ledger and pots                             | the audit database, written synchronously at record time, replayed at boot  | kept: spend is the same before and after                                                                                                                                                                                                                                                                                                                                 | `keeps budget spend, clears rate windows and evidence, and settles a held approval on SIGTERM`; `replays duration-window spend across a restart inside the window`                                                                                                   |
| Tool baselines (MCP doors)                         | the audit database under `persist_baselines` (the default), loaded per door | rows kept, but a restored baseline is inert until a live list names the tool: until that door's next successful list, calls are judged on the MCP defaults. That first list is compared against the restored definitions, so a tool that changed while Helio was down is reported as drift and governed by `on_tool_drift`. Memory-only under `persist_baselines: false` | `keeps a drifted tool blocked across a restart until helio baseline accept lifts it`; `persist_baselines: false keeps the memory-only behavior and creates no table`                                                                                                 |
| Tool baselines (adapter origins)                   | memory, one cache per origin on the sideband                                | re-baselined at boot: an `on_tool_drift` block on an adapter tool lifts until the tool drifts again, and `helio baseline accept` does not reach them ([Adapter API](./adapter-api.md))                                                                                                                                                                                   | not currently guaranteed                                                                                                                                                                                                                                             |
| Upstream era and upstream session                  | memory, per upstream connection; with named `upstreams`, per door           | on every auto-mode door, cleared: the next request re-probes and re-establishes, which is why a restart is the documented repair for a sticky cached modern era. A door with a dated `protocol_version` pin has nothing to clear: its era is a constant                                                                                                                  | not currently guaranteed; the rules are the [era detection reference](./configuration.md#upstream-mcp-era-detection)                                                                                                                                                 |
| Kill switch                                        | the `<config>.kill` marker                                                  | a marker halt is kept; a `HELIO_KILL_SWITCH=1` halt ends on a restart that no longer exports the variable, and a supervisor that keeps exporting it starts killed again; an API halt that could not write the marker ends with the process                                                                                                                               | `reads the kill switch from the running proxy, never from the rows: a file halt, a clean stop, helio resume while down, a restart`; `reads a HELIO_KILL_SWITCH=1 halt as env, memory-only, and not active after its process ends and a restart without the variable` |
| Rule-level `rate_limit` and `spend_limit` windows  | memory                                                                      | reset: a restart hands back the headroom                                                                                                                                                                                                                                                                                                                                 | `keeps budget spend, clears rate windows and evidence, and settles a held approval on SIGTERM` for rate limits; spend limits are not currently guaranteed                                                                                                            |
| Evidence and dependency (`requires`) session state | memory                                                                      | lost: evidence-gated and `requires` calls are denied until re-grounded                                                                                                                                                                                                                                                                                                   | `keeps budget spend, clears rate windows and evidence, and settles a held approval on SIGTERM` for evidence; `requires` is not currently guaranteed                                                                                                                  |
| Held approvals (MCP door)                          | memory                                                                      | graceful stop: settled `shutdown_cancelled` with a row; crash or hard kill: lost with no row. Either way the ticket is gone: an old Slack button or dashboard card resolves nothing, open dashboard event streams drop, and the audit database is the history                                                                                                            | `keeps budget spend, clears rate windows and evidence, and settles a held approval on SIGTERM`; the crash path is [#460](https://github.com/gethelio/helio/issues/460)                                                                                               |
| Pending sideband evaluations                       | memory                                                                      | lost with no record; the adapter's `/audit` gets `404 evaluation_unknown`                                                                                                                                                                                                                                                                                                | not currently guaranteed; [#458](https://github.com/gethelio/helio/issues/458)                                                                                                                                                                                       |
| Adapter registry (`GET /api/adapters`)             | memory                                                                      | empty until each adapter's next `/evaluate`                                                                                                                                                                                                                                                                                                                              | not currently guaranteed                                                                                                                                                                                                                                             |
| Dashboard login sessions                           | memory, signed with a per-process key                                       | invalid: log in again                                                                                                                                                                                                                                                                                                                                                    | not currently guaranteed                                                                                                                                                                                                                                             |
| `HELIO_SDK_TOKEN` and `HELIO_ADAPTER_TOKEN`        | generated per boot unless set in the environment                            | a generated token changes: every SDK client and adapter needs the new one; a token set in the environment is kept                                                                                                                                                                                                                                                        | `respects a pre-set HELIO_SDK_TOKEN environment variable`                                                                                                                                                                                                            |

Nothing is claimed about an MCP client's own session state across a proxy
restart against a stateful upstream.

## Running under a supervisor

- **Restart on exit.** systemd `Restart=on-failure`, Compose
  `restart: unless-stopped`. Exit 1 means "do not trust this process": a
  supervisor cannot tell a config refusal from a crash, and looping on a
  refusal is the fail-closed outcome. Fix the file and the loop recovers.
- **Validate before any restart.** `helio validate -c <file>`: a bad edit the
  running proxy refused is latent until the next boot. The line to alert on is
  `[helio] Config reload failed (keeping current configuration):`.
- **The three probes.** `GET /healthz` on the MCP port is unauthenticated,
  always served, and used by the Docker image's HEALTHCHECK; it says the HTTP
  server answers. `GET /api/health` on the dashboard port answers without the
  secret when the dashboard is enabled. `GET /healthz` on the SDK sideband
  answers without a token when `sdk.enabled` is set. None of them says
  anything about the upstream, the prime or the kill switch;
  `helio policy status` and `GET /api/policy/status` do, and a per-upstream
  health surface is [#322](https://github.com/gethelio/helio/issues/322).
  Backed by `responds to GET /healthz with 200`,
  `allows GET /api/health without auth even when secret is set` and
  `allows GET /healthz without a token for container probes`.
- **The Docker HEALTHCHECK port.** The image probes
  `http://localhost:3000/healthz`, so a `listen.port` other than 3000 makes
  the container report unhealthy while serving normally. Docker restarts a
  container when its process exits; an unhealthy HEALTHCHECK restarts nothing
  under plain Docker or Compose.
- **Pin the tokens.** Set `HELIO_SDK_TOKEN` and `HELIO_ADAPTER_TOKEN` in the
  supervisor's environment, or every restart strands the SDK clients and
  adapters on a token that no longer exists.
- **Stop grace.** The proxy force-exits 5 s after SIGTERM; give the
  supervisor at least that. The systemd default of 90 s and the `docker stop`
  default of 10 s both do.
- **The sandbox layout.** `helio init --sandbox` gives every service
  `restart: unless-stopped`; `depends_on` only orders startup, and the edge
  forwarder re-resolves the proxy every second. Measured once on 0.14.0 under
  Docker Desktop, not a guarantee: the proxy's process killed inside its
  container gave about 3 s of connection failures at the edge before Docker
  restarted it with every audit row kept in the volume; `docker compose
restart helio` gave about 2 s. The agent never reaches the upstream directly
  in either window, because it is on no network with the MCP server.

## Known gaps

Each is filed and linked; none is described above as handled.

- [#458](https://github.com/gethelio/helio/issues/458): a graceful stop drops
  pending sideband evaluations without an `evaluation_expired` record.
- [#459](https://github.com/gethelio/helio/issues/459): a respawned stdio
  child is never sent `initialize`.
- [#460](https://github.com/gethelio/helio/issues/460): a crash ends calls
  held on an approval with no answer and no audit row.
- [#461](https://github.com/gethelio/helio/issues/461): in-flight stdio
  requests wait out the request timeout instead of failing at the child's
  exit.
- [#377](https://github.com/gethelio/helio/issues/377): the crash drain does
  not close stdio upstream children.
- [#118](https://github.com/gethelio/helio/issues/118): a throw outside the
  forward's own handling reaches the agent as a `text/plain` 500, not a
  JSON-RPC error.
- [#457](https://github.com/gethelio/helio/issues/457): a chatty stdio child
  blocks once its stderr pipe fills, while `/healthz` stays 200.
- [#256](https://github.com/gethelio/helio/issues/256): the prime sends a
  stdio child `tools/list` without a handshake.
- [#322](https://github.com/gethelio/helio/issues/322): no per-upstream health
  surface; `/healthz` says nothing about the upstream.
- [#384](https://github.com/gethelio/helio/issues/384),
  [#383](https://github.com/gethelio/helio/issues/383),
  [#382](https://github.com/gethelio/helio/issues/382): config watch losses
  and reload read errors the operator learns of late or without the error code.
- [#405](https://github.com/gethelio/helio/issues/405): an audit database
  that cannot be opened is refused with a wrapped message, not one line.
- [#446](https://github.com/gethelio/helio/issues/446): the kill switch
  status after a restart under the marker does not say it started killed.

## See also

- [SECURITY.md, Process and filesystem boundaries](../SECURITY.md#process-and-filesystem-boundaries):
  the tiers, the residuals that bound sentence 1, and what a restart clears
- [Running Helio as a Sidecar](./deployment-sidecar.md) and
  [Running Helio as its own user](./deployment-separate-user.md): the two tier
  recipes
- [Kill Switch](./kill-switch.md): the deliberate halt
- [Adapter API](./adapter-api.md): the host-enforced tier and its fail-closed
  requirement
- [Configuration Reference](./configuration.md): `listen`, `upstream`,
  `approval`, `audit` and `sdk`
