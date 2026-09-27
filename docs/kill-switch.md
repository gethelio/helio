# Kill Switch

Halt every governed call without editing policy, and resume it deliberately.
`helio kill` writes one marker file beside the config; the running proxy sees
it within about a second and refuses every governed call on both doors;
`helio resume` removes the file. The file is the state: a restart under the
marker starts killed, and a process killed this way comes back killed until
the file is gone.

This page is written for the operator in an incident first, with a terminal
on the host and no time to read, and then for the same operator the next
morning, reading what happened in the dashboard, in `helio policy status` and
in `helio report activation`.

## In an incident

### Stop it

```bash
helio kill -c /etc/helio/helio.yaml
```

```
Kill switch ON: wrote /etc/helio/helio.yaml.kill. Every Helio process polling it refuses every governed call within about a second. Resume with: helio resume -c /etc/helio/helio.yaml
```

- The command never loads, parses or validates the config, so a
  broken `helio.yaml` cannot stop a kill. It opens no network connection and no audit
  database.
- The config path must be a file. A typo is refused
  with `Error: no config file at <path>; pass -c <path> to the helio.yaml the proxy runs`,
  so a mistyped path cannot leave a stray marker nobody polls.
- The marker is `<config>.kill` beside the config, written through a temporary
  file and a rename, so the proxy never reads a half-written file.
- Run it where the config directory is writable. On the
  [separate-user tier](./deployment-separate-user.md) that is
  the command `sudo helio kill -c /etc/helio/helio.yaml`. A directory the
  command cannot write is refused
  with `Error: cannot write <marker> (EACCES). Run this where the config directory is writable (on the separate-user tier, as root)`.
- A second `helio kill` while the marker exists
  prints `Kill switch already ON: <marker> exists (since 2026-09-26 12:27 UTC)` and
  exits 0.
- The file holds one line, `killed at 2026-09-26T12:27:03.000Z by oli`. It is
  informational and unverified: the proxy never reads it, and the audit record
  never copies it. When no proxy was running at the time, that line is the
  only trace of who wrote the marker.

### Prove it stopped

The proxy prints one line to stderr within about a second:

```
[helio] Kill switch ON (file): every governed call is refused; resume with helio resume -c /etc/helio/helio.yaml or DELETE /api/kill-switch
```

And `helio policy status` opens with one line while the answering process is
killed, absent otherwise (the command reads the running proxy through the
dashboard API, so it needs the dashboard enabled and its secret):

```
Kill switch: ACTIVE since 2026-09-26 12:27 UTC (file, durable)
```

The parenthesis names the surface that holds the halt (`file`, `env` or
`api`) and whether the marker file backs it (`durable`) or not
(`memory-only`).

### What the agent sees

On the MCP door every `tools/call` is answered with HTTP 200 and the same
JSON-RPC error a policy denial uses, code `-32001`, with the self-repair body
in `error.data`:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32001,
    "message": "Kill switch active: every governed call is refused",
    "data": {
      "blocked": true,
      "reason": "kill_switch",
      "rule": null,
      "rule_index": null,
      "action": "deny",
      "suggestion": "An operator halted Helio with its kill switch. Every governed call is refused until an operator resumes it; retrying does not help.",
      "retry_allowed": false
    }
  }
}
```

`retry_allowed` is false because the agent cannot repair an operator halt;
after a resume a fresh call is an ordinary call. `tools/list` and every other
MCP method pass through untouched, so an agent can still see its tools and
keep its session while nothing executes. The refusal runs before any rule,
limit, budget or approval, and under global `dry_run` too.

On the [sideband](./adapter-api.md), `POST /evaluate` answers
`decision: "deny"`, `reason: "kill_switch"`, `matched_rule: null` and a
`feedback` block with the same message and suggestion; `POST /install-scan`
answers the same way. Nothing is cached or registered for a refused call, and
a later `/audit` for that evaluation answers `already_finalized`.

### Resume it

```bash
helio resume -c /etc/helio/helio.yaml
```

```
Removed /etc/helio/helio.yaml.kill. A Helio process killed by that file resumes within about a second and continues held approvals with their remaining time; a process also started with HELIO_KILL_SWITCH=1, or halted through the API because it could not write the marker, stays killed until DELETE /api/kill-switch or a restart without the variable. The proxy's own "Kill switch OFF" line is the proof it resumed
```

The proxy's line is the proof:

```
[helio] Kill switch OFF (file): governed calls resume; held approvals continue with their remaining time
```

Deleting the file by hand, `helio resume`, and the authenticated
`DELETE /api/kill-switch` are one and the same resume. `helio resume` with no
marker to remove is not a failure: it prints
`No kill marker at <marker>. A halt set through the API that could not write the marker, or by HELIO_KILL_SWITCH=1, ends with DELETE /api/kill-switch or a restart without the variable`
and exits 0.

## The next morning

### The audit records

The kill and the resume are governance events in the same record stream as
decisions, on the [policy reload](./audit.md#policy-reload-records)
precedent: **`record_kind: kill_switch`, `policy_decision: kill_switch`,
`origin: operator`, `tool_name: <kill_switch>`**. The decision column holds
the constant, never the outcome; the outcome is in `block_reason`
(`kill_switch` for a kill, null for a resume), and the facts are under
`evidence_chain.kill_switch`:

| Field               | Meaning                                                                                                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `action`            | `kill` or `resume`.                                                                                                                                                           |
| `surface`           | What flipped the switch: `file` (the marker, seen by the poll), `env` (`HELIO_KILL_SWITCH=1` at boot) or `api` (the endpoint).                                                |
| `actor`             | The `actor` the endpoint body named, else the credential's mode (`bearer` or `session`); null for the file and the variable, since the poll cannot know who wrote the marker. |
| `durable`           | Whether the marker file backed the halt; for a resume, whether it backed the halt that was lifted.                                                                            |
| `at_boot`           | True when the edge fired at start, from a present marker or the variable: a restart under a halt is a governance event.                                                       |
| `pending_approvals` | Approval tickets pending at the transition: what was in flight.                                                                                                               |

Every call refused while killed is a `tool_call` record with
`policy_decision: deny` and `block_reason: kill_switch`, under the real tool
name, on both doors. `helio export --reason kill_switch` lists the kill record
and every refused call; the resume record has a null reason and rides
`helio export` without the filter.

### The dashboard

A kill or resume record wears the `Kill Switch` chip, and the audit page's
kind filter has a `Kill Switch` option. The kill record and every refused call
carry the Deny badge whatever their decision column says; the resume record
reads Allow beside its chip, as an applied reload does: calls are allowed
again. Until the kind-as-title follow-up lands, the row title of the two
operator records is the `<kill_switch>` sentinel.

### The status line and the report

`helio policy status` prints the `Kill switch: ACTIVE since ...` line first
while the answering process is killed and nothing at all otherwise; the JSON
form carries the same facts under `kill_switch`
(`{ active, since, surface, durable }`). `helio report activation` names
refused calls under `blocked_by_reason: kill_switch`, never `other`, and its
first enforcement decision never names a kill refusal, which is an operator
halt and not a policy decision.

The report also says whether the switch is active, on every face: one line
under `Sources` in its header, and one top-level JSON field, `kill_switch`
(`{ state, since, surface, durable }`, where `state` is `active`, `inactive`
or `unknown` and the other three are null unless active). Both read exactly
one source, the running proxy's status field, copied by name, and never the
audit rows:

```text
  Kill switch: ACTIVE since 2026-09-27 16:42 UTC (file, durable), from the proxy.
  Kill switch: not active, from the proxy.
  Kill switch: unknown; this report got no kill-switch status (see Sources), and the audit rows record kills and resumes as they happened, not whether a halt is in force now.
```

The `since` instant is when the answering process's halt began. A restart
under the marker starts a new clock: the kill record with `at_boot: true`
dates the restart, while the earlier kill record and the marker's own line
date the halt. What lifts each surface: `helio resume`, a hand deletion of
the marker or `DELETE /api/kill-switch` for a `file` halt; for a memory-only
halt (`env`, or an `api` halt that could not write the marker), that same
delete call or a restart without the variable.

The limit, stated plainly: the line reads only the running proxy. A
file-backed halt survives a crash and a clean stop alike, and after the next
start the line is `ACTIVE` with that process's `since`. A halt that ends
while no proxy runs leaves no resume record: a `helio resume` or a hand
removal of the marker while the proxy is stopped, and a memory-only halt,
which ends when its process exits, by a crash or a clean stop. So the rows
read as the transitions a proxy saw, never as the current state, and a
report that reads `unknown` got no status: the word is about the report,
never about the halt. A status report from a proxy older than the switch
has no field and reads `not active`, since a process with no switch cannot
have one active.

## Held approvals

A kill freezes decisions, not observers. Every clock that would turn a held
ticket into a decision stops: the timeout and the escalation timers of
router-managed tickets, the deadlines and the evaluation TTLs of sideband
native tickets, and the sideband deadline sweep. `approve`, `deny` and
`break-glass` are refused for the duration:

- `POST /api/approvals/:id/approve`, `/deny` and `/break-glass`
  answer `409 { "error": "kill_switch_active", "suggestion": "resume Helio first; the ticket keeps its remaining time" }`,
  before the ticket lookup.
- A Slack button press updates the message to say Helio is halted by its kill
  switch and that the approval keeps its remaining time; the buttons stay.
- The sideband's `POST /approval/:id/resolve`
  answers `409 { "error": "kill_switch_active" }`.

On resume every clock continues with the time it had left: a ticket frozen
with two minutes to go has two minutes after the resume, whatever the halt
lasted. The approvals list shows the pre-kill deadline while killed and the
shifted `timeout_at` after the resume. A ticket submitted while killed is
created frozen. An escalation that already fired is not fired again.

Two things still settle while killed, because neither is a clock: a real
client abort resolves its ticket `client_disconnected` at once, and a real
shutdown resolves every held ticket `shutdown_cancelled`. A kill is never
itself either outcome, and it never converts a pending ticket into a timeout
denial.

## Starting killed: `HELIO_KILL_SWITCH=1`

A boot input, on the `HELIO_CONFIG_SHA256` precedent: `helio start` under
`HELIO_KILL_SWITCH=1` starts killed with the surface `env`. It creates no
marker, so the halt is memory-only: `helio resume` and a hand deletion cannot
lift it; `DELETE /api/kill-switch`, or a restart without the variable, can.
The next start is killed only if the variable is set again or the marker is
present. Any other value, the empty string included, is refused before
anything is served:

```
Error: HELIO_KILL_SWITCH is set but is not "1": "yes". Unset it, or set it to 1 to start killed.
```

The variable is read once at boot, like the pin, never on a poll.

## The endpoint

Both verbs sit on the dashboard API under its bearer-or-cookie
authentication; a cookie session also needs the `x-helio-csrf` header, as
every mutating route does.

`POST /api/kill-switch`, body optional, `{ "actor": "alice" }` (1 to 200
characters):

- The marker written: `200 { "killed": true, "changed": true, "durable": true, "since": "<ISO 8601>" }`.
  The endpoint writes the same file `helio kill` writes, so `helio resume`, a
  hand deletion and `DELETE` all lift it.
- The marker not writable (the separate-user tier, a read-only
  mount): `200 { "killed": true, "changed": true, "durable": false, "since": "<ISO 8601>", "note": "this process cannot write the marker beside the config (EACCES), so this halt is memory-only and ends with the process; run helio kill -c <config> where the config directory is writable" }`.
  The write itself is the test; the marker path is not in the body.
- Already killed: `200 { "killed": true, "changed": false, "durable": <bool>, "since": "<ISO 8601>" }`.

`DELETE /api/kill-switch`, no body:

- The marker removed, or a memory-only halt
  cleared: `200 { "killed": false, "changed": true }`, at once, without waiting for
  the poll.
- The marker could not be
  removed: `409 { "error": "marker_unlink_failed", "killed": true, "code": "EACCES", "suggestion": "run helio resume -c <config> where the config directory is writable, or delete the marker by hand" }`.
  Nothing changes: clearing the hold while the file remains would resume for
  one poll and halt again.
- Not killed: `200 { "killed": false, "changed": false }`.

In open mode (`dashboard.allow_open_mode: true`, no secret) both verbs answer
`403 { "error": "kill_switch_requires_secret", "marker": "helio.yaml.kill", "suggestion": "run helio kill -c <config> or helio resume -c <config>, or create and delete the marker file by hand" }`
before any write or unlink. The marker's basename is named, not its path: the
operator is on the box, and the file is the way in.

## Accepted limits

These are documented, not designed around.

- An endpoint kill that cannot write `<config>.kill` (the separate-user tier,
  a read-only mount) is memory-only and ends with the process. `helio kill`
  run where the config is writable is the durable path.
- The Docker quickstart mounts a single file
  (`./helio.docker.yaml:/config/helio.yaml:ro`), so a host-side `helio kill`
  writes a marker the container never sees. Mount the config directory, as
  the [sidecar guide](./deployment-sidecar.md) does with `./helio:/config:ro`,
  for a file-based kill.
- The marker is polled about once a second, not watched. A file created and
  removed inside one poll second is not seen.
- A raw API resume can lift a kill that landed during the call: the two are
  ordinary state changes with no ordering between callers.
- On the detection-only tier the agent can reach every kill-switch surface,
  as with every other control on that tier.
- One proxy per config and audit path. A second process on the same files
  halts on the file but not on another process's memory-only halt.
- Until the kind-as-title follow-up lands, the operator row is
  titled `<kill_switch>` in the feed, the audit table and the detail panel.

## See also

- [Audit Trail](./audit.md#kill-switch-records): the two records and
  the `kill_switch` block reason
- [Approval Workflows](./approvals.md#timeout-behavior): what a held ticket
  does across a kill
- [Sideband API Reference](./sideband-api.md#kill-switch): the endpoint and
  the `kill_switch` field of `GET /api/policy/status`
- [Adapter API](./adapter-api.md): the sideband refusal
- [Configuration Reference](./configuration.md#starting-killed): the boot
  variable beside the config pin
- [SECURITY.md](../SECURITY.md#process-and-filesystem-boundaries): the tiers
  and what each one can reach
