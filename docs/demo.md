# Sample traffic: `helio init --demo`

You installed Helio and nothing has been governed yet, so every surface is
empty: the activation report says no record has been written, the
dashboard has no feed, `helio policy status` has no calls to count. To see
what those surfaces look like with history behind them, run one command:

```bash
npx @gethelio/proxy init --demo
```

It writes a directory named `helio-demo` holding a config, an audit
database of sample traffic and a sample MCP upstream, and prints:

```text
Created helio-demo/helio-demo.yaml
Created helio-demo/helio-demo-audit.db
Created helio-demo/mcp-demo-server.mjs
Created helio-demo/README.md

Sample traffic, not your own: every row in helio-demo/helio-demo-audit.db was written by helio init --demo.

Next steps:
  1. cd helio-demo
  2. helio report activation -c helio-demo.yaml (no proxy needed; --include-names restores tool, door and rule names)
  3. node mcp-demo-server.mjs in one terminal, then helio start -c helio-demo.yaml in another
  4. helio policy status -c helio-demo.yaml, and open http://127.0.0.1:3100
Every command in that directory takes -c helio-demo.yaml; a bare one looks for helio.yaml.
```

The `Created` lines print the absolute paths. Pass a directory to write
somewhere else (`helio init --demo ./somewhere`); the parent directories
are created. The command refuses to touch any of its four files when one
already exists (`Error: <path> already exists. Use --force to overwrite.`)
and writes nothing else: never the working directory's own `helio.yaml` or
`helio-audit.db`, never a socket, never a secret (the config needs none).

Nothing in the directory is yours, and every surface says so from the
name of what it prints: every upstream name, session id and pot name in
the database starts with `demo-`, every row carries the environment label
`demo`, the config file is `helio-demo.yaml` and the config reload records
in the database are titled after it. The one surface that prints no name
by design is the default activation report; see [the marks](#the-marks-and-the-one-hole).

## The four files

- `helio-demo.yaml`: two named upstreams (`demo-crm`, `demo-billing`),
  two rules (`allow-reads` on `readOnlyHint`, `block-destructive` on
  `destructiveHint`), one budget (`demo-payments`, 500 USD per 24 hours,
  `on_exceed: deny`), the audit database beside it, and the dashboard in
  open mode on loopback. No rule uses `require_approval`, so nothing here
  needs `dashboard.api_secret`.
- `helio-demo-audit.db`: 357 audit rows over 45 days in three config
  epochs, 41 budget ledger rows and the ten tool baselines. The first
  epoch has no rule and the destructive tools run unopposed; the second
  sits under an approval rule (`big-charge-approval`) with four approved
  charges; the current one is the written file, with read-only calls
  decided by `allow-reads`, destructive calls denied by
  `block-destructive`, a few upstream 503s, one drift event, one rejected
  nameless call, and the pot's refusals. Two applied reloads and one
  refused edit sit between the epochs. The ledger is the calls' own
  amounts walked through the pot the way the proxy walks it: the pot
  filled 2 h 52 min before the end, refusing a refund of 21; of the 19
  contributor calls after that, 18 were refused and one refund of 11
  still fit, so the ledger holds it at 498 of 500 with 19 refusals in
  all. The baselines are the ten definitions the sample upstream lists,
  so the first `helio start` restores them instead of baselining anew.
- `mcp-demo-server.mjs`: a dependency-free MCP upstream on `node:http`
  serving the same ten tools, five on `/crm` and five on `/billing`,
  answering every call with `<tool>: ok (sample)`. `PORT` overrides its 8080.
- `README.md`: the same facts, next to the files.

## The config, verbatim

`helio init --demo` writes this file. The ports are the getting-started
defaults (3000, 3100, 8080), so the guide's words hold over the demo.

```yaml
# Helio demo: sample traffic, not your own. Written by helio init --demo.
# Every command takes -c helio-demo.yaml; run it from this directory, because
# audit.path below resolves against the working directory. The reload records
# in the audit database are titled after this file.
version: '1'

upstreams:
  - name: demo-crm
    url: 'http://127.0.0.1:8080/crm'
    transport: streamable-http
  - name: demo-billing
    url: 'http://127.0.0.1:8080/billing'
    transport: streamable-http

listen:
  port: 3000
  host: '127.0.0.1'

environment: demo

policies:
  default: allow
  rules:
    - name: allow-reads
      match:
        annotations:
          readOnlyHint: true
      action: allow
    - name: block-destructive
      match:
        annotations:
          destructiveHint: true
      action: deny

budgets:
  - name: demo-payments
    limit: 500
    currency: USD
    window: 24h
    on_exceed: deny
    contributors:
      - match:
          tool: 'create_charge'
          upstreams: [demo-billing]
        field: '$.amount'
      - match:
          tool: 'refund_charge'
          upstreams: [demo-billing]
        field: '$.amount'

audit:
  storage: sqlite
  path: ./helio-demo-audit.db
  retention: 90d
  include_responses: true

dashboard:
  enabled: true
  port: 3100
  host: '127.0.0.1'
  allow_open_mode: true
```

## Every command takes `-c helio-demo.yaml`

Run the commands from inside the directory: `audit.path` in the config is
`./helio-demo-audit.db` and resolves against the working directory. A bare
`helio report activation` in the directory looks for `helio.yaml` and
prints the loader's line, which is not a fault in the demo:

```text
Error: Cannot read config file: helio.yaml
```

The file is named `helio-demo.yaml` on purpose: the proxy titles a config
reload record by the config file's basename, and those three records have
no upstream and no session id beside them on the feed. Named after the
demo file they read as sample; named `helio.yaml` they would read as your
own.

## Without a proxy

```bash
cd helio-demo
helio report activation -c helio-demo.yaml
```

The report reads the database and asks the dashboard port for a snapshot;
with no proxy running it says so on one stderr line and prints the rest.
Right after seeding, on a 7-day window:

```text
Helio activation report
  Written by Helio 0.0.0 (unreleased build) on 2026-10-04 (UTC). Names: excluded (--include-names restores tool, door and rule names).
  Counts cover the last 7d; dates are within the audit retention of 90d.
  Sources: the audit database (read; this config file is the one that last wrote policy to it). No proxy answered on the configured dashboard port, so the snapshot section is absent.
  Kill switch: unknown; this report got no kill-switch status (see Sources), and the audit rows record kills and resumes as they happened, not whether a halt is in force now.

Timeline (dates within retention)
  First call observed            2026-08-20   earliest persisted tool call
  First rule                     2026-09-14   first applied config reload
                                 Rules present at the first start, or edited between runs, leave no reload record; a rule is visible here only once it decides a call or arrives by a live reload.
  First generation               not available in this version
  First simulation               not available in this version
  First apply                    not available in this version
  First enforcement decision     2026-09-28   first blocked call (policy_denied)

Persisted (last 7d)
  252 calls across 8 tool-door pairs, 6 sessions, 1 call without a session id (denied and dry-run calls included)
  Decisions: 183 permitted, 69 blocked (budget_exceeded 19, policy_denied 50), 0 dry-run, 0 approvals requested
  Config versions seen: 1
  Config reloads: 2 (1 applied)
  audit rows since 2026-08-20
```

The dates move with the day you seed (the first call is always 45 days
before the base instant); the counts hold for the windows the rows were
placed in. `--window 4h` right after seeding reads `132 calls across 8
tool-door pairs, 6 sessions`; `--window 30d` reads `312 calls`, `4
approvals requested`, `Config versions seen: 2` and `Config reloads: 3 (2
applied)`, because the approval rule's epoch and the first reload fall
inside it. The counts slide out of each window as time passes: the oldest
call in the 4-hour window sits 3 h 55 min before the base, so that count
starts falling five minutes after the seed, and a day later the window is
empty.

`--include-names` restores tool, door and rule names. With no proxy
answering, the text face restores the first blocked call's tool
(`first blocked call (policy_denied, tool delete_customer)`); the door
names sit in the JSON's called pairs (`--format json --include-names`,
under `persisted.pairs_called_in_window`), and in the text face's
tool-door pairs table once a proxy answers (below).

```bash
helio export -c helio-demo.yaml                      # 357 records, every one with "environment": "demo"
helio export -c helio-demo.yaml --budgets demo-payments   # the 41 ledger rows, newest first
helio validate -c helio-demo.yaml                    # Config is valid: helio-demo.yaml (2 policy rules, 1 budget)
```

## With a proxy

In one terminal:

```bash
cd helio-demo
node mcp-demo-server.mjs
```

It prints `Helio demo upstream listening on http://127.0.0.1:8080 (doors:
/crm and /billing)`. In another:

```bash
cd helio-demo
helio start -c helio-demo.yaml
```

The boot begins, per door, with three lines that are facts about the
sample directory, not faults: the ten tool baselines the seed wrote are
restored from the database; the upstream answers `initialize` with the
2025-06-18 revision, so the proxy detects the legacy era and says so; and
the annotation cache primes against the live listing, which matches the
restored baselines (`5 restored, 0 new`, nothing drifted). Then the two
authority lines, the doors and the audit path:

```text
[helio][demo-crm] Tool baselines restored: 5 for demo-crm from helio-demo-audit.db
[helio][demo-crm] Upstream MCP era detected: legacy (initialize handshake)
[helio][demo-crm] Annotation cache primed: 5 tool definitions baselined for drift detection (5 restored, 0 new)
[helio][demo-billing] Tool baselines restored: 5 for demo-billing from helio-demo-audit.db
[helio][demo-billing] Upstream MCP era detected: legacy (initialize handshake)
[helio][demo-billing] Annotation cache primed: 5 tool definitions baselined for drift detection (5 restored, 0 new)
Helio proxy listening on http://127.0.0.1:3000
Policies: 2 rules loaded (default: allow)
Authority surface: 10 tool-door pairs across 2 upstreams, 2 annotated destructive
Policy coverage: 6 of 10 have a rule that can match them, default allow
Upstream[demo-crm]: http://127.0.0.1:8080/crm (streamable-http)
Upstream[demo-billing]: http://127.0.0.1:8080/billing (streamable-http)
Audit: ./helio-demo-audit.db (retention: 90d)
Dashboard API listening on http://127.0.0.1:3100
```

(The open-mode and enforcement-posture warnings after the dashboard line
are the same ones any config prints.)

```bash
helio policy status -c helio-demo.yaml
```

```text
Authority surface
  10 tool-door pairs across 2 upstreams
  2 annotated destructive
  1 destructive by MCP default (no destructiveHint set)

Policy coverage
  6 of 10 have a rule that can match them
  4 fall through to the default: allow
  Effective action: allow 7, deny 3
  on_tool_drift: block

Persisted (last 4h)
  132 calls across 8 tool-door pairs, 6 sessions (denied and dry-run calls included)
  1 reachable and permitted, never called in the last 4h
  audit rows since 2026-08-20
  Readiness: suppressed, the policy enforces something (132 calls across 8 tool-door pairs in the last 4h)

Tool-door pairs (calls in the last 4h)
  get_customer      demo-crm      allow  rule "allow-reads"        26
  update_customer   demo-crm      allow  no rule, default allow    13
  delete_customer   demo-crm      deny   rule "block-destructive"  13
  export_customers  demo-crm      deny   rule "block-destructive"  13
  merge_customers   demo-crm      deny   rule "block-destructive"  0
  get_invoice       demo-billing  allow  rule "allow-reads"        26
  list_invoices     demo-billing  allow  rule "allow-reads"        0
  send_invoice      demo-billing  allow  no rule, default allow    14
  create_charge     demo-billing  allow  no rule, default allow    14
  refund_charge     demo-billing  allow  no rule, default allow    13
```

Every face of the status command has a row here: `export_customers` is
the tool with no annotations, destructive by MCP default and denied by
`block-destructive`; `merge_customers` is exposed by the upstream and has
never been called; `list_invoices` is reachable, permitted and never
called. Every call sits on a primed door, so the line that would count
calls on none does not print.

The pot stands at 498 of 500, so a charge of 60 is refused, and so is a
destructive call:

```bash
curl -s -X POST http://127.0.0.1:3000/mcp/demo-billing \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -H 'x-helio-session-id: live-1' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"create_charge","arguments":{"amount":60,"currency":"USD","customer":"cus_1077"}}}'
```

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "error": {
    "code": -32001,
    "message": "Budget exceeded: \"demo-payments\"",
    "data": {
      "blocked": true,
      "reason": "budget_exceeded",
      "rule": null,
      "rule_index": null,
      "action": "budget",
      "budgets": [
        {
          "name": "demo-payments",
          "limit": 500,
          "spent": 498,
          "remaining": 2,
          "attempted_amount": 60,
          "currency": "USD",
          "window": "24h",
          "on_exceed": "deny",
          "reset_at": "2026-10-04T17:47:00.000Z"
        }
      ],
      "suggestion": "Budget \"demo-payments\" would be exceeded by this call. Wait for the window to reset or reduce the amount.",
      "retry_allowed": true
    }
  }
}
```

The same call with `"name":"delete_customer"` on `/mcp/demo-crm` is
refused with `"reason":"policy_denied"` and `"rule":"block-destructive"`.
Both refusals are written to the same database, and the pot survives a
restart of the proxy (`GET http://127.0.0.1:3100/api/budgets` reads `498`
spent, `2` remaining, before and after, within 2 h 20 min of the seed).

With the proxy answering, `helio report activation -c helio-demo.yaml
--include-names` gains its snapshot section and the tool-door pairs table
with `demo-crm` and `demo-billing` on every row.

Open http://127.0.0.1:3100. The feed and the audit log show the door
(`demo-crm` or `demo-billing`) on every MCP row and the session id whole
(`demo-s01` to `demo-s06`); the budgets page shows `demo-payments` at
498.00 of 500.00 USD with its 41 events; the analytics page ranks the
tools as `tool (door)`.

## The marks, and the one hole

| Surface                                     | What it prints from the rows                  | The mark                                                                                                                                          |
| ------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `helio init --demo`                         | the four paths, the next steps                | the sentence `Sample traffic, not your own`, and `-c helio-demo.yaml` on every next step                                                          |
| `helio report activation`                   | counts, dates, decision classes               | none from the rows, by design (below)                                                                                                             |
| `helio report activation --include-names`   | tool, door and rule names                     | `demo-crm`, `demo-billing` (in the JSON's called pairs without a proxy; in the pairs table with one)                                              |
| `helio start`                               | upstream names, the audit path                | `Upstream[demo-crm]`, `Upstream[demo-billing]`, `Audit: ./helio-demo-audit.db`                                                                    |
| `helio policy status`                       | the door on every pair                        | `demo-crm`, `demo-billing`                                                                                                                        |
| the dashboard feed, audit log, detail panel | the door when the row has one, the session id | `demo-crm` / `demo-billing` on every MCP row; `demo-s01` to `demo-s06` whole; the three reload rows have neither and are titled `helio-demo.yaml` |
| the dashboard budgets page                  | the pot name                                  | `demo-payments`                                                                                                                                   |
| `helio export`                              | every column                                  | `environment: demo`, `upstream: demo-*`, `session_id: demo-*`                                                                                     |

One surface carries no mark, and it is stated here rather than patched:
the default activation report is nameless by design. It holds counts,
dates and enum values so it can be handed over, and nothing on its face
says which database it read. Share a demo report with `--include-names`,
or say where it came from.

## The report's same-file line

The report compares the config file's hash with the hash the newest audit
record was written under. Over a fresh demo directory it reads `this
config file is the one that last wrote policy to it`: the current epoch is
stamped with the sha256 of the bytes the seed wrote, ports included. Edit
`helio-demo.yaml` by hand and the next report reads `NOT the one`; rerun
`helio init --demo --force` and it reads `the one` again. It never reads
`the newest record carries no config hash`, because every seeded row
carries a hash.

## Time, and regenerating

Every timestamp counts back from one base instant, the minute the command
ran. `--at <iso>` pins that instant, so two runs with one `--at` write
byte-identical audit rows, byte-identical exports and a byte-identical
text report; the one column that differs is the ledger's own event id.
`--at` accepts an instant within the last 45 days and never in the future:
the oldest row is 45 days before the base, and the config's retention is
90 days.

The pot's window is 24 hours and slides: `498 of 500` reads for 2 h 20
min after the seed, until the oldest in-window charge ages out; the
documented charge of 60 is refused for 4 h 40 min, until the pot drops to
401; a day after the seed the window is empty. The report's 4-hour window
empties within hours and its 7-day window over the following days; the
audit retention purges the oldest rows at the next open once they pass 90
days. Rerun
`helio init --demo --force` in the parent directory for a fresh history.
`--force` removes the database and its `-wal` and `-shm` sidecars before
writing, overwrites the other three files, and leaves anything else in the
directory alone.

The database is never checked in: it is written by a committed builder in
the proxy package through the store's and the ledger's own write paths,
with no schema statement of its own, so a later Helio that adds a column
picks it up at the next open, and `helio init --demo --force` regenerates
the file against the current schema.
