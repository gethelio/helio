# Policy simulation: `helio policy simulate`

`helio policy simulate` replays the calls the proxy has already recorded against a candidate policy and prints what would have been decided differently. It reads the audit database on disk, needs no running proxy, calls no tool, writes one provenance record into the database it replayed, and changes nothing else. This page is the command's reference: what it reads and writes, the candidate and its default, the window and the config epochs, the report section by section, the JSON, the exit codes, a CI example that is green on every run, and what the report carries when it is pasted somewhere. The walkthrough, with a captured report of a candidate that adds a rule, is [Try a rule before it lands](./getting-started.md#try-a-rule-before-it-lands) in Getting Started; this page does not repeat it.

## What it reads and writes

Three inputs, one of them written to.

- **The deployed file.** `-c, --config <path>` (default `helio.yaml`) is the file the proxy runs. It is always read, even when the candidate is another file: it names `audit.path`, the database to replay; `audit.retention`, which the open applies before anything is read; and `environment`, which the run's record carries. The replay is also handed its bytes, so a row this file decided can be matched to it by hash.
- **The candidate.** The policy under test, a complete `helio.yaml` of its own (next section).
- **The database.** By default the deployed file's `audit.path`, resolved against the working directory as every Helio command resolves it. `--audit-db <path>` replaces the path and nothing else: the file is opened the way `helio export` and `helio report activation` open one, so rows older than the deployed `audit.retention` are deleted at open, by insert time, and the run's record is then written into the same file. That holds for a copy too; there is no read-only open. The header says how many rows the open deleted whenever it deleted any.

When `audit.path` names a file that does not exist, the command refuses before anything is read and creates nothing. From the parent of a `helio init --demo` directory, naming the config alone:

```bash
helio policy simulate -c helio-demo/helio-demo.yaml --demo --fail-on-change
```

```text
Error: no audit database at ./helio-demo-audit.db. helio start writes it on the first governed call; nothing has been recorded on this machine.
```

The relative `audit.path` resolved against the parent directory, where there is no database. Run the command inside the directory that holds the database, or name both files with `-c` and `--audit-db`.

## The candidate

The candidate is any complete `helio.yaml`, loaded and compiled as `helio validate` loads one; a file that does not load or compile is a refusal with the loader's line. With no argument the command takes the one `helio.candidate.yaml` (or `helio.candidate.yml`) in the working directory. Two present is a refusal naming both; none present is a refusal that says to pass the file:

```text
Error: no candidate given and no helio.candidate.yaml here. Pass the candidate file: helio policy simulate <candidate>.
```

Write the candidate by hand: copy the deployed file and add the rule, as Getting Started shows (`cp helio.yaml helio.candidate.yaml`). A candidate whose hash equals the one the replayed rows carry is the same-file run: the file that decided those rows, byte for byte, so the budget pot check (below) has snapshots to test, which it has for no candidate of another hash (an edited `helio.yaml` has a new hash, and the check does not run). It is not a guaranteed zero-delta run. A call whose tool annotations the trail did not record replays through the annotation defaults, so on the sample corpus the deployed file replayed without `--demo` reports 202 changed decisions, every one of them also named under a fidelity warning; the same file under `--demo` reports zero.

## The window and the epochs

The window defaults to the whole trail. `--since <duration>` starts it this long ago, in the config's duration grammar (`24h`, `7d`); `--until <iso>` ends it at an ISO 8601 instant, which must not be earlier than `--since`; `--upstream <name>` keeps only the rows of one named door; `--session <id>` keeps only the rows of one session.

A config epoch is the run of rows that one config file decided, identified by the hash the proxy stamps on every row. One run simulates one epoch: the most recent in the window by default, and the report's epoch notice names the others, newest first, with the two flags that move the selection. `--across-configs` simulates every epoch in the window in one pass; `--config-sha <hash>` picks one by a prefix of 8 or more lowercase hex characters. The two do not combine.

The epochs are decided in order, with the budget pots rebuilt from the ledger as [Simulation fidelity](./policy-fidelity.md#what-the-harness-does-not-rebuild) describes, and one limit from that page applies to an older epoch: an epoch older than the pot's current generation starts its pots empty, because `budget_meta` keeps no generation history, so a simulation of an earlier config hydrates nothing unless that epoch's ledger rows are at the current generation.

## Reading the report

### What the report cannot tell you: the counterfactual sequence

A replay evaluates the recorded calls, in the order they happened, against the candidate, and rebuilds the cumulative state (rate windows, spend windows, budget pots, evidence, dependency chains) from what the agent actually did. It cannot know what the agent would have done next had an earlier decision gone the other way. When the candidate denies a call the live proxy allowed, every later call stays in the replay as recorded, including calls the agent would never have made after a denial, and the dependency facts those calls established stay established. The report counts deltas per row and states none of these consequences. A simulation is a per-call answer to "what would this candidate have decided about each recorded call", not a prediction of a different history, and a zero-delta run says that no recorded call would have been decided differently, nothing more. The command's output does not state this; this page and the fidelity page's [Known limitation](./policy-fidelity.md#known-limitation-the-counterfactual-sequence) do.

Inside a `helio init --demo` directory, `helio policy simulate --demo --fail-on-change` prints the report the sections below walk through:

```text
Policy simulation
  Candidate: helio-demo.yaml
  Written by Helio 0.0.0 (unreleased build) on 2026-10-08 (UTC).
  Window: the whole trail
  Epoch: the most recent config epoch, 253 calls, 2026-10-02 13:57 UTC to 2026-10-08 12:47 UTC
  Annotations: the sample server's listed definitions (--demo)

Simulated the most recent config epoch only: config cdf1b846..., 2026-10-02 13:57 UTC to 2026-10-08 12:47 UTC, 253 calls.
The window spans 2 other config epoch(s), not simulated:
  config 8a02d014...: 60 calls, 2026-09-18 14:57 UTC to 2026-09-28 10:57 UTC
  config 49f4aeb2...: 40 calls, 2026-08-24 12:57 UTC to 2026-08-29 09:57 UTC
Pass --across-configs to simulate every epoch in the window, or --config-sha <hash> to pick one.

Decisions (252 replayed)
  252 unchanged
    0 changed

Fidelity
  Skipped 1 row(s) that never entered policy evaluation: 1 rejected, 0 refused by the kill switch.
  0 sideband evaluation(s) were decided but never reported (evaluation_expired); their outcome is unknown.

Annotations for --demo came from the sample server's listed definitions, not from the audit trail.
No live tools were called. Nothing was applied.
```

One line goes to stderr, before the report: `Wrote one policy_simulation record to ./helio-demo-audit.db.`

### The header

- `Candidate:` the candidate file's basename.
- `Written by Helio <version> on <day> (UTC).` A build that is not a release reads `Helio 0.0.0 (unreleased build)`.
- `Window:` `the whole trail`, or `from <instant>`, `to <instant>`, or both, as `--since` and `--until` set them.
- `Retention:` printed only when the open deleted rows: `N row(s) inserted before <instant> were deleted at open (audit.retention 90d).`
- `Epoch:` the epoch simulated and its size: `the most recent config epoch, 253 calls, <first> to <last>`, or `every config epoch in the window (3)` under `--across-configs`.
- `Annotations:` where the replay took each tool's annotations from: `the audit trail`, or `the sample server's listed definitions (--demo)`.

When the window holds more than one epoch, the epoch notice follows the header: which epoch was simulated, which were left out and their sizes, and the two flags that move the selection.

### The decisions

`Decisions (N replayed)` counts the rows that entered policy evaluation; `N unchanged` and `M changed` partition them. Under `changed`, one line per class of delta that is not zero: `would be blocked` with the block reasons and their counts, `would be held for approval` (a candidate rule or pot asks for an approval nobody answered live), `would require approval, answered live` (the recorded human answer is replayed), `would pass under a limit`, `would be decided but not enforced` (a dry run), `would be allowed`. Then `Changed decisions, by tool and rule`, one line per tool, decision pair and rule, with the count and the first and last instant. A candidate that adds a deny rule on the demo corpus's `get_customer` prints:

```text
Decisions (252 replayed)
  202 unchanged
   50 changed
       50 would be blocked (policy_denied 50)

Changed decisions, by tool and rule
  tool "get_customer" on door "demo-crm": allow -> deny (policy_denied), rule "block-get-customer": 50 calls, 2026-10-02 13:57 UTC to 2026-10-08 12:46 UTC
```

Two other shapes. When the replayed epoch was decided by a file with no rule and no budget, and the candidate changes a decision, the block opens with `Baseline: no restrictive rules (default allow)` and `This is your first policy, so every restriction is new.`, and the lines read `N calls would have been denied`, `N unaffected`; the Getting Started capture is that shape. A run over such a baseline that changes nothing keeps the `Baseline:` line above the standard block. An empty window prints `No tool calls in the window.`

### Fidelity

The `Fidelity` block is the fidelity page's language, printed on every run, and [The report's language](./policy-fidelity.md#the-reports-language) defines every sentence. Two lines always print: the rows skipped because they never entered policy evaluation (a rejected request, a kill-switch refusal) and the sideband evaluations that were decided but never reported. A third kind prints per rule and dimension when the replay could not fully evaluate a rule on some calls, with up to five of their instants under it:

```text
Could not fully evaluate rule "<rule>" on <n> call(s): <dimension> was not recorded for <subject>. These calls count as unverified, never as passed.
```

What that means for the answer: the warned calls stay inside `N unchanged / M changed`, in `unchanged` when the decision the replay reached matches the stored one on all four of the policy decision, the block reason, the dry-run flag and the ticket kind (none, a rule ticket, a budget ticket or both; the answer is not compared), and in `changed` when any differs (a deny that stays a deny under another reason is changed) (on the sample corpus without `--demo`, `export_customers` is warned and unchanged because it was already denied, `get_customer` warned and changed), and the warning means the rule was not passed on them; they count as unverified, never as passed, and the report never silently passes a rule it could not check. A warning never changes the exit code: under `--fail-on-change` a run with warnings and no changed decision exits 0, and a changed decision exits 2 with or without a warning on it; without the flag every completed run exits 0. One more line prints when a budget snapshot on a row the candidate itself decided was not met by the rebuilt pot; it is a same-file check, and a changed candidate leaves it empty on purpose.

Under `--demo` the line before the last names the annotation source so its passes are never confused with trail-derived ones: `Annotations for --demo came from the sample server's listed definitions, not from the audit trail.` Every run ends with `No live tools were called. Nothing was applied.`

## The JSON

`--format json` prints the report as one object on stdout; the `Wrote one policy_simulation record` line stays on stderr. The text is rendered from this object: the text's `Helio 0.0.0 (unreleased build)` is `helio_version: "0.0.0"`, and where the text names five instants under a warning and `and N more`, `fidelity.warnings` names every instant. Two text lines are no field: the flag hint under the epoch notice (`Pass --across-configs to simulate every epoch in the window, or --config-sha <hash> to pick one.`) and the closing line. Several fields have no text line: `schema_version`; `baseline.opening_reload`; `window.upstream` and `window.session_filtered` (the `Window:` line prints the time bounds only, `the whole trail` when there are none, and never the door or the session filter); `window.retention` unless the open deleted rows; `budget_checks[].timestamp` (the text names the count and the pot names); the epoch and baseline prefixes when the window holds one epoch under the default selector (the `Epoch:` line names the most recent epoch without its hash and there is no notice; under `--config-sha` the line prints `config <prefix>...` even for the only epoch); and `warnings_suppressed`, the count of operational lines the policy pipeline would have printed live, which the command reports on stderr instead when it is not zero. The acceptance run above, as JSON:

```json
{
  "schema_version": 1,
  "helio_version": "0.0.0",
  "generated_at": "2026-10-08T12:57:58.014Z",
  "candidate": {
    "name": "helio-demo.yaml",
    "sha256": "cdf1b846733bdef33810c368df91a169dc323e2a45824956a3e0e2bc10cb4ece"
  },
  "annotation_source": "demo",
  "window": {
    "from": null,
    "to": null,
    "purged_before": null,
    "purged_rows": 0,
    "retention": "90d",
    "upstream": null,
    "session_filtered": false
  },
  "epoch": {
    "selector": "latest",
    "epochs": [
      {
        "config_sha256_prefix": "49f4aeb2",
        "rows": 40,
        "first_timestamp": "2026-08-24T12:57:00.000Z",
        "last_timestamp": "2026-08-29T09:57:00.000Z",
        "selected": false
      },
      {
        "config_sha256_prefix": "8a02d014",
        "rows": 60,
        "first_timestamp": "2026-09-18T14:57:00.000Z",
        "last_timestamp": "2026-09-28T10:57:00.000Z",
        "selected": false
      },
      {
        "config_sha256_prefix": "cdf1b846",
        "rows": 253,
        "first_timestamp": "2026-10-02T13:57:00.000Z",
        "last_timestamp": "2026-10-08T12:47:45.000Z",
        "selected": true
      }
    ]
  },
  "baseline": {
    "config_sha256_prefix": "cdf1b846",
    "first_policy": false,
    "opening_reload": true
  },
  "replayed": 252,
  "skipped": {
    "rejected": 1,
    "kill_switch": 0
  },
  "unreported": 0,
  "changed": false,
  "deltas": {
    "total": 0,
    "blocked": 0,
    "unanswered": 0,
    "approval_recorded": 0,
    "limited": 0,
    "dry_run": 0,
    "allowed": 0,
    "blocked_by_reason": [],
    "dry_run_by_decision": [],
    "rows": []
  },
  "fidelity": {
    "lines": [
      "Skipped 1 row(s) that never entered policy evaluation: 1 rejected, 0 refused by the kill switch.",
      "0 sideband evaluation(s) were decided but never reported (evaluation_expired); their outcome is unknown."
    ],
    "warnings": [],
    "skipped": {
      "rejected": 1,
      "kill_switch": 0
    },
    "unreported": 0
  },
  "budget_checks": [],
  "budget_check_line": "",
  "epoch_notice": "Simulated the most recent config epoch only: config cdf1b846..., 2026-10-02 13:57 UTC to 2026-10-08 12:47 UTC, 253 calls.\nThe window spans 2 other config epoch(s), not simulated:\n  config 8a02d014...: 60 calls, 2026-09-18 14:57 UTC to 2026-09-28 10:57 UTC\n  config 49f4aeb2...: 40 calls, 2026-08-24 12:57 UTC to 2026-08-29 09:57 UTC",
  "demo_line": "Annotations for --demo came from the sample server's listed definitions, not from the audit trail.",
  "warnings_suppressed": 0,
  "provenance": {
    "record_id": "825d6b66-1517-45d8-b2d9-8b076f732f08"
  }
}
```

`schema_version` is `1`. The fields a CI step may parse when it wants more than the exit code: `changed` (a boolean), `deltas.total`, `deltas.blocked`, `deltas.unanswered`, `replayed` and `fidelity.warnings` (an array, one entry per warning with every instant, where the text names five). `deltas.rows` lists every changed decision with its tool, door, rule and instant. Two fields are provenance and nothing else: `candidate.sha256`, the full hash of the candidate file and the key the run's record is filed under, and `provenance.record_id`, the id of that record and of no tool call. The config epoch hashes under `epoch` and `baseline` are prefixes, the shortest unique among the window's epochs and at least eight characters, as the text prints them. The object carries no session id and no tool call's record id.

## Exit codes

| Exit | When                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | The run completed. Without `--fail-on-change` every completed run exits 0, whatever it found; with it, no decision changed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `2`  | `--fail-on-change` and at least one decision changed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `1`  | A refusal before anything was replayed, with the reason on stderr (a schema failure prints the loader's `Invalid configuration` line and one detail line per error). Among them: the deployed file or the candidate does not load or compile, no database at `audit.path` or one that cannot be opened, no default candidate or two of them, `--since` not a duration or too long to replay, `--until` not an instant or earlier than `--since`, `--config-sha` not 8 to 64 lowercase hex characters, matching no epoch in the window or more than one, or combined with `--across-configs`, `--format` neither `text` nor `json`. |

Nothing else moves the code. A fidelity warning, the budget check line, the epoch notice, a retention purge at open and an empty window all exit 0 (or 2, when a decision changed as well).

## A deterministic CI example

A gate that replays a rolling window (`--since 7d`) against a live trail changes with tomorrow's traffic, so the first team to copy it gets a flaky build. This example replays a frozen corpus instead: `helio init --demo` seeds the sample traffic into a fresh directory, and the second command replays its most recent config epoch against the policy that decided it. No database is checked in. Two commands, in an operator's repository:

<!-- helio-config-guard: skip -->

```yaml
# .github/workflows/policy-simulate.yml
name: Policy simulation
on: [pull_request]
jobs:
  simulate:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - name: Seed the sample corpus
        run: npx @gethelio/proxy init --demo "$RUNNER_TEMP/helio-demo"
      - name: Replay the current epoch against its own policy
        working-directory: ${{ runner.temp }}/helio-demo
        run: npx @gethelio/proxy policy simulate --demo --fail-on-change
```

`npx @gethelio/proxy` runs the latest published release; the snippet needs the release that carries `helio policy simulate`. The same two commands from a shell, with the report they print, are the capture under [Reading the report](#reading-the-report):

```bash
helio init --demo helio-demo
cd helio-demo
helio policy simulate --demo --fail-on-change     # exit 0: 252 unchanged / 0 changed
```

Why each choice:

- **`--demo`**, on the second command. The corpus's rows predate the baselines the seed inserts, so a replay that takes annotations from the trail evaluates every call on the defaults and reports hundreds of deltas by design; `--demo` hands the replay the sample server's listed definitions instead, and the report names that source. The reason is settled on the fidelity page, under [The demo corpus and `--demo`](./policy-fidelity.md#the-demo-corpus-and---demo).
- **The most recent epoch**, the default. The corpus holds three config epochs, and the two older ones were decided under other policies (a first with no rule, a second under an approval rule), so no single candidate reproduces them. `--across-configs` on this corpus exits 2 on every run; the deltas are the older epochs' decisions, not a defect:

  ```text
  Decisions (352 replayed)
    318 unchanged
     34 changed
         34 would be blocked (policy_denied 30, budget_exceeded 4)
  ```

- **No `--at`.** `helio init --demo --at <iso>` pins the instant the sample history ends, so two seeds with one `--at` write byte-identical rows ([Time, and regenerating](./demo.md#time-and-regenerating)). The gate does not need that: the decisions are the same whatever the base, and only the epoch bounds in the header move. `--at` also accepts only an instant within the last 45 days, so a date written into a workflow fails six weeks later. The example passes none.
- **A fresh directory.** A second `helio init --demo` into a directory that already holds `helio-demo.yaml` refuses with `already exists. Use --force to overwrite.` The runner's temp directory is empty on every job; a workflow that reuses a workspace passes `--force` or removes the directory first.
- **`cd` into the directory.** `audit.path` in the seeded config is `./helio-demo-audit.db` and resolves against the working directory, so inside the directory the command needs neither `-c` nor `--audit-db`. When a `cd` is awkward, name both files from outside: `helio policy simulate -c helio-demo/helio-demo.yaml --audit-db helio-demo/helio-demo-audit.db --demo --fail-on-change` prints the same report; `-c` alone from outside is the refusal shown under [What it reads and writes](#what-it-reads-and-writes).
- **The exit code is the gate.** The step asserts nothing else: 0 ran with no changed decision, 2 a changed decision, 1 a refusal. A step that wants a summary parses the JSON fields named above with `--format json`.

**What `--fail-on-change` means.** It is a change-nothing gate: it guards an edit meant to change no decision (a reorder, a rename, a cleanup) and a frozen corpus. A candidate that adds a rule is expected to change decisions and exits 2 by design, as the `get_customer` deny above does; run that one without the flag and read the report.

**Your own trail.** To gate your own policy rather than the sample, three things change. The frozen copy is a copy of your database, supplied by a checkout or an artifact download, and `--audit-db <copy>` names it from a directory holding the deployed `helio.yaml` (or `-c` names that file). The candidate, the deployed file with the rule added, is the positional. There is no `--demo`: the annotation source is then the trail, and the `--demo` line does not print. One caveat: the open deletes rows older than the deployed `audit.retention` from the copy and writes the run's record into it, so copy the archive on each run rather than opening the archive itself.

A green gate is a per-call answer: no recorded call would have been decided differently. It is not a statement about the calls an agent would have made under the candidate; [What the report cannot tell you](#what-the-report-cannot-tell-you-the-counterfactual-sequence) is as true of a green run as of a red one.

## The sample corpus and `--demo`

`--demo` is a boolean. Under it the deployed file is `helio-demo.yaml` in the working directory unless `-c` names another; the candidate is that same file unless a positional names one; the annotation source is the sample server's listed definitions, and the report says so twice, on the header's `Annotations:` line and on the line before the last. It is the one command in a `helio init --demo` directory that needs no `-c helio-demo.yaml`. The corpus itself, its three epochs and the four files are described in [Sample traffic](./demo.md).

## What the report carries

The report's language is the fidelity page's, and so is its set, stated under [Privacy](./policy-fidelity.md#privacy): tool, door, origin and rule names, plus counts and instants. It never carries `tool_input`, `upstream_response`, `upstream_error`, evidence data, metadata values, session ids, record ids, the audit or config path, or a full hash, with two exceptions that `--format json` makes for provenance: `candidate.sha256`, the full hash of the candidate file, and `provenance.record_id`, the id of the run's own record and of no tool call. The text face prints neither. Config epoch hashes appear as prefixes in both faces (`config cdf1b846...` in the text, `config_sha256_prefix` under `epoch` and `baseline` in the JSON), the shortest prefix unique among the window's epochs and at least eight characters: enough to hand to `--config-sha`, never the full hash. An instant beside a tool and a rule still identifies a row for someone who has the database, a weaker join than a record id but a join; this release ships no flag that widens or narrows the set, and the decision to paste a report into a ticket or leave it in a CI log is the operator's, as it is for `helio report activation --include-names`.

## The provenance record

Every run writes one `record_kind: policy_simulation` record into the database it replayed, keyed by the candidate's hash (`config_sha256` on the row), with the window, the epoch, the counts and the fidelity warning count in its evidence; the `Wrote one policy_simulation record` line on stderr is that write, observed. The record stays out of every decision aggregate, the observed counts and the activation report's last-policy-write check, so a simulation never reads as a call, a block or a policy write, and a later run over the same database replays the same calls. The fields are in [Policy Simulation Records](./audit.md#policy-simulation-records).

## See also

- [Try a rule before it lands](./getting-started.md#try-a-rule-before-it-lands): the walkthrough, with a captured report of a candidate that adds a rule
- [Simulation fidelity](./policy-fidelity.md): what the audit trail can replay, the frozen sentences, the privacy set and the counterfactual limitation
- [Policy Simulation Records](./audit.md#policy-simulation-records): the record every run writes
- [Sample traffic: `helio init --demo`](./demo.md): the corpus the CI example replays
- [Policy Guide](./policies.md): the rules a candidate is written in
