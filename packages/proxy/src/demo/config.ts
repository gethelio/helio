// ---------------------------------------------------------------------------
// The config and the README `helio init --demo` writes (issue #397). The
// config is shown verbatim in docs/demo.md inside a column-0 yaml fence, so
// the sample checker validates it; a test pins the page to this renderer.
// ---------------------------------------------------------------------------

import {
  DEMO_AUDIT_FILE,
  DEMO_BUDGET_LIMIT,
  DEMO_BUDGET_NAME,
  DEMO_CONFIG_FILE,
  DEMO_ENVIRONMENT,
  DEMO_UPSTREAM_FILE,
  DEMO_UPSTREAMS,
} from './corpus.js'

/** The three ports the rendered config names. */
export interface DemoPorts {
  /** Where `mcp-demo-server.mjs` listens; both doors point at it. */
  readonly upstreamPort: number
  /** The proxy's MCP port. */
  readonly listenPort: number
  /** The dashboard, in open mode on loopback. */
  readonly dashboardPort: number
}

/** The getting-started ports, so the guide's words hold over the demo directory. */
export const DEMO_DEFAULT_PORTS: DemoPorts = {
  upstreamPort: 8080,
  listenPort: 3000,
  dashboardPort: 3100,
}

/** The audit retention the config names; the seed opens the store with the same value. */
export const DEMO_AUDIT_RETENTION = '90d'

/** The sentence the config's first line, the README and the command print. */
export const DEMO_SAMPLE_SENTENCE = 'sample traffic, not your own'

/**
 * Render `helio-demo.yaml`: two named doors on one sample upstream, two
 * rules, one pot with `on_exceed: deny`, the audit database beside it and
 * the dashboard in open mode on loopback. No `require_approval` anywhere,
 * so nothing here needs a secret.
 */
export function renderDemoConfig(ports: DemoPorts): string {
  const upstream = `http://127.0.0.1:${String(ports.upstreamPort)}`
  return `# Helio demo: ${DEMO_SAMPLE_SENTENCE}. Written by helio init --demo.
# Every command takes -c ${DEMO_CONFIG_FILE}; run it from this directory, because
# audit.path below resolves against the working directory. The reload records
# in the audit database are titled after this file.
version: '1'

upstreams:
  - name: ${DEMO_UPSTREAMS.crm}
    url: '${upstream}/crm'
    transport: streamable-http
  - name: ${DEMO_UPSTREAMS.billing}
    url: '${upstream}/billing'
    transport: streamable-http

listen:
  port: ${String(ports.listenPort)}
  host: '127.0.0.1'

environment: ${DEMO_ENVIRONMENT}

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
  - name: ${DEMO_BUDGET_NAME}
    limit: ${String(DEMO_BUDGET_LIMIT)}
    currency: USD
    window: 24h
    on_exceed: deny
    contributors:
      - match:
          tool: 'create_charge'
          upstreams: [${DEMO_UPSTREAMS.billing}]
        field: '$.amount'
      - match:
          tool: 'refund_charge'
          upstreams: [${DEMO_UPSTREAMS.billing}]
        field: '$.amount'

audit:
  storage: sqlite
  path: ./${DEMO_AUDIT_FILE}
  retention: ${DEMO_AUDIT_RETENTION}
  include_responses: true

dashboard:
  enabled: true
  port: ${String(ports.dashboardPort)}
  host: '127.0.0.1'
  allow_open_mode: true
`
}

/** Render the README: what is sample, what to run, what each surface shows, and the two holes. */
export function renderDemoReadme(): string {
  return `# Helio demo directory

Written by \`helio init --demo\`. Everything in this directory is
${DEMO_SAMPLE_SENTENCE}: every row in \`${DEMO_AUDIT_FILE}\` was
written by the command, not by an agent. Every upstream name, session id
and pot name in it starts with \`demo-\`, every row carries the environment
label \`${DEMO_ENVIRONMENT}\`, and the config reload records are titled
\`${DEMO_CONFIG_FILE}\` after the file beside them.

## The four files

- \`${DEMO_CONFIG_FILE}\`: two named upstreams (\`${DEMO_UPSTREAMS.crm}\`, \`${DEMO_UPSTREAMS.billing}\`),
  two rules (\`allow-reads\`, \`block-destructive\`), one budget
  (\`${DEMO_BUDGET_NAME}\`, ${String(DEMO_BUDGET_LIMIT)} USD per 24h) and the dashboard in open mode
  on loopback. Nothing in it needs a secret.
- \`${DEMO_AUDIT_FILE}\`: about 360 audit rows over 45 days in three
  config epochs (a first one with no rule, a second under an approval
  rule, the current one under the file above) and 19 budget ledger rows
  with the pot past its limit.
- \`${DEMO_UPSTREAM_FILE}\`: a dependency-free MCP upstream serving the
  same ten tools, five on \`/crm\` and five on \`/billing\`.
- \`README.md\`: this file.

## Every command takes -c ${DEMO_CONFIG_FILE}

Run everything from this directory: \`audit.path\` in the config resolves
against the working directory. A bare command looks for \`helio.yaml\` and
prints \`Error: Cannot read config file: helio.yaml\`; that is the loader's
line, not a fault in the demo.

Without a proxy:

\`\`\`bash
helio report activation -c ${DEMO_CONFIG_FILE}
helio report activation -c ${DEMO_CONFIG_FILE} --include-names
helio export -c ${DEMO_CONFIG_FILE} --budgets ${DEMO_BUDGET_NAME}
\`\`\`

With a proxy, in two terminals:

\`\`\`bash
node ${DEMO_UPSTREAM_FILE}
\`\`\`

\`\`\`bash
helio start -c ${DEMO_CONFIG_FILE}
helio policy status -c ${DEMO_CONFIG_FILE}
\`\`\`

Then open the dashboard at http://127.0.0.1:3100. The boot prints
\`Upstream MCP era detected: legacy (initialize handshake)\` once per door:
the sample upstream answers \`initialize\` with the 2025-06-18 revision on
purpose, and the line is a fact about it, not a fault.

## What each surface shows

- \`helio report activation\`: the timeline (a first call 45 days back, a
  first rule 20 days back by a live reload, a first blocked call 6 days
  back) and the windowed counts. The default output carries no name, no
  path and no label by design, so nothing on its face says "demo"; share
  a demo report with \`--include-names\`, which restores tool, door and
  rule names: with no proxy answering, the text face names the first
  blocked call's tool, and the \`${DEMO_UPSTREAMS.crm}\` and \`${DEMO_UPSTREAMS.billing}\`
  door names sit in the JSON's called pairs (\`--format json --include-names\`)
  and in the text pairs table once a proxy answers.
- \`helio start\`: two doors, ten tool-door pairs, a pot at 540 of
  ${String(DEMO_BUDGET_LIMIT)} USD. A \`create_charge\` through the proxy is refused with
  \`budget_exceeded\`; a \`delete_customer\` is refused by \`block-destructive\`.
- \`helio policy status\`: the authority surface, the coverage of the two
  rules, and one tool the upstream lists that no row has ever called.
- The dashboard: the feed, the audit log and the budgets page over the
  same rows. The analytics page labels the one sideband row's bar
  \`send_message\` with no door beside it, because that row has no door.

## Regenerating

The pot's window is 24 hours, so a day after the seed the breach face has
aged out; the report's windows (7 days by default) empty over the
following weeks, and the audit retention (90 days) purges the oldest rows
at the next open. Rerun \`helio init --demo --force\` in the parent
directory to write a fresh directory against the current schema; pass
\`--at <iso>\` to pin the base instant so two runs write the same rows.
`
}
