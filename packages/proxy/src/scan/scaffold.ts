import { writeFile } from 'node:fs/promises'
import yaml from 'js-yaml'
import { formatUtcMinute } from '../util/format-time.js'
import { StartupError } from '../startup-error.js'
import type { ScanReport, ScanReportTool } from './report.js'
import { stripUserinfoTextually } from './target.js'

// ---------------------------------------------------------------------------
// The --write scaffold (issue #299): a starter helio.yaml generated from the
// scanned surface. Owns its own text; it follows the section order and the
// commented-stub shape of `helio init` without sharing a table with it.
// ---------------------------------------------------------------------------

export interface ScanScaffoldInput {
  readonly report: ScanReport
  /**
   * The scanned entry as written in the config file, before interpolation
   * (anchors and merge keys resolved, `${VAR}` intact); undefined for a
   * bare URL target, whose `upstream:` block is the report's normalized URL.
   */
  readonly rawUpstream: unknown
  /** The `sha256:` digest of the freshly minted dashboard secret. */
  readonly apiSecretDigest: string
}

/**
 * A scalar the upstream chose (a tool name, a dot-path), written as a JSON
 * string: a valid YAML double-quoted scalar on one line, whatever the value
 * carries (a newline, a quote, a `#`, YAML structure). Never interpolate an
 * upstream-controlled string into the template any other way.
 */
function quoted(value: string): string {
  return JSON.stringify(value)
}

/** An upstream-chosen string inside a `#` comment: escaped so it stays on its line. */
function commentSafe(value: string): string {
  return JSON.stringify(value).slice(1, -1)
}

/**
 * A tool name as a `match.tool` value. The policy compiles that field as a
 * picomatch glob, so every ASCII character outside `[A-Za-z0-9_]` is escaped
 * with a backslash (the set picomatch honors for every metacharacter and for
 * the quote, slash and dot rules around them) and the rule matches that one
 * name, never a pattern the upstream chose. Only for names `exactlyMatchable`
 * admits: a backslash in a name cannot be expressed exactly by picomatch, and
 * an empty pattern does not compile.
 */
function globLiteral(name: string): string {
  return quoted(name.replaceAll(/[^A-Za-z0-9_\u0080-\uffff]/g, (char) => `\\${char}`))
}

/** Whether a `match.tool` glob can name this tool and nothing else. */
function exactlyMatchable(name: string): boolean {
  return name !== '' && !name.includes('\\')
}

/** The comment written above a tool no exact glob can name. */
function unmatchableNote(tool: ScanReportTool, prefix: string): string {
  return tool.name === ''
    ? `${prefix}# a tool with an empty name was skipped: match.tool cannot name it\n`
    : `${prefix}# ${commentSafe(tool.name)} cannot be matched exactly by a match.tool glob (the name carries a backslash); write its rule by hand\n`
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * The `upstream:` block. A config target is written as the operator wrote
 * it, minus the entry `name` and minus `headers` (a resolved credential
 * sits in the loaded copy; the commented placeholder line below is the
 * only header the scaffold ever writes). A bare URL is the normalized URL.
 */
function upstreamBlock(input: ScanScaffoldInput): string {
  const raw = asRecord(input.rawUpstream)
  let block: string
  if (raw === undefined) {
    block =
      `upstream:\n  url: "${input.report.target.label}"\n` +
      `  transport: ${input.report.target.transport}\n`
  } else {
    const entry: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(raw)) {
      if (key === 'name' || key === 'headers') continue
      // The URL as written, minus its userinfo: a credential belongs in
      // upstream.headers, never in a file the scaffold writes.
      entry[key] =
        key === 'url' && typeof value === 'string' ? stripUserinfoTextually(value) : value
    }
    block = yaml.dump({ upstream: entry }, { lineWidth: -1, noRefs: true })
  }
  return `${block}#   headers:\n#     Authorization: "Bearer \${UPSTREAM_TOKEN}"\n`
}

function approvalRule(tool: ScanReportTool, prefix: string): string {
  return (
    `${prefix}- name: ${quoted(`approve-${tool.name}`)}\n` +
    `${prefix}  match:\n` +
    `${prefix}    tool: ${globLiteral(tool.name)}\n` +
    `${prefix}  action: require_approval\n` +
    `${prefix}  approval:\n` +
    `${prefix}    channel: dashboard\n`
  )
}

function allowRule(tool: ScanReportTool, prefix: string): string {
  return (
    `${prefix}- name: ${quoted(`allow-${tool.name}`)}\n` +
    `${prefix}  match:\n` +
    `${prefix}    tool: ${globLiteral(tool.name)}\n` +
    `${prefix}  action: allow\n`
  )
}

function rulesBlock(tools: readonly ScanReportTool[]): string {
  const annotatedDestructive = tools.filter((tool) => tool.destructive === 'annotated')
  const readOnly = tools.filter((tool) => tool.hints.readOnlyHint.value)
  const defaultDestructive = tools.filter((tool) => tool.destructive === 'default')
  const live = [...annotatedDestructive, ...readOnly].filter((tool) => exactlyMatchable(tool.name))
  const lines: string[] = []
  if (live.length === 0) {
    lines.push('  rules: []\n')
  } else {
    lines.push('  rules:\n')
    for (const tool of annotatedDestructive) {
      if (exactlyMatchable(tool.name)) lines.push(approvalRule(tool, '    '))
    }
    for (const tool of readOnly) {
      if (exactlyMatchable(tool.name)) lines.push(allowRule(tool, '    '))
    }
  }
  // A name no glob can match exactly gets its rule commented, with the reason.
  for (const tool of annotatedDestructive) {
    if (exactlyMatchable(tool.name)) continue
    lines.push(unmatchableNote(tool, '    '))
    if (tool.name !== '') lines.push(approvalRule(tool, '    # '))
  }
  for (const tool of readOnly) {
    if (exactlyMatchable(tool.name)) continue
    lines.push(unmatchableNote(tool, '    '))
    if (tool.name !== '') lines.push(allowRule(tool, '    # '))
  }
  for (const tool of defaultDestructive) {
    if (!exactlyMatchable(tool.name)) {
      lines.push(unmatchableNote(tool, '    '))
      continue
    }
    lines.push(
      `    # ${commentSafe(tool.name)} sets no destructiveHint: destructive by MCP default\n`,
    )
    lines.push(approvalRule(tool, '    # '))
  }
  return lines.join('')
}

function budgetsBlock(tools: readonly ScanReportTool[]): string {
  const contributors = tools
    .filter((tool) => exactlyMatchable(tool.name))
    .flatMap((tool) =>
      tool.candidates
        .filter((candidate) => candidate.kind === 'amount')
        .map((candidate) => ({ tool: tool.name, field: candidate.path })),
    )
  if (contributors.length === 0) {
    return '# budgets:\n#   # One depleting pot shared by every tool that spends; see docs/policies.md.\n'
  }
  const lines = [
    '# budgets:\n',
    '#   # candidates from the live schema, not certainties\n',
    '#   - name: agent-payments\n',
    '#     limit: 50\n',
    '#     currency: USD\n',
    '#     window: session\n',
    '#     key: session\n',
    '#     on_exceed: deny # or require_approval for a break-glass ticket\n',
    '#     contributors:\n',
  ]
  for (const contributor of contributors) {
    lines.push(`#       - match:\n#           tool: ${globLiteral(contributor.tool)}\n`)
    lines.push(`#         field: ${quoted(contributor.field)}\n`)
  }
  return lines.join('')
}

/**
 * Render the starter config for a scanned surface: the target as the
 * upstream, live `require_approval` rules for annotated-destructive tools,
 * live `allow` rules for read-only tools, a commented rule per tool that is
 * destructive by MCP default, a commented budget over the amount-like
 * candidates, the dashboard channel and a live dashboard block carrying the
 * minted secret's digest. Every top-level section of `helio init` is present
 * as a live block or a commented stub, in the same order.
 */
export function renderScanTemplate(input: ScanScaffoldInput): string {
  const { report } = input
  const { summary } = report
  const counts =
    `${String(summary.tools)} ${summary.tools === 1 ? 'tool' : 'tools'} exposed, ` +
    `${String(summary.destructive)} destructive (${String(summary.destructive_by_default)} by MCP default)`
  return (
    `# Helio MCP Governance Proxy configuration, scaffolded by helio scan\n` +
    `# from ${commentSafe(report.target.label)} (${report.target.transport}) at ${formatUtcMinute(report.generated_at)}:\n` +
    `# ${counts}. Every rule below is a starting point; see docs/policies.md.\n` +
    `# Docs: https://github.com/gethelio/helio\n` +
    `\n` +
    `version: "1"\n` +
    `\n` +
    upstreamBlock(input) +
    `\n` +
    `# Multiple named upstreams (multi-upstream mode) replace \`upstream:\`;\n` +
    `# set exactly one of the two. See docs/configuration.md.\n` +
    `# upstreams:\n` +
    `#   - name: files\n` +
    `#     url: "http://localhost:8081/mcp"\n` +
    `\n` +
    `# listen:\n` +
    `#   port: 3000\n` +
    `#   host: 127.0.0.1\n` +
    `\n` +
    `# environment: production\n` +
    `\n` +
    `# session:\n` +
    `#   identity: # ordered; first match wins\n` +
    `#     - source: header\n` +
    `#       name: x-helio-session-id\n` +
    `#     - source: legacy_header # verbatim Mcp-Session-Id (deprecation window)\n` +
    `#   on_unresolved: deny # deny | anonymous\n` +
    `\n` +
    `policies:\n` +
    `  # Production posture is deny; allow keeps the first helio start from blocking anything by surprise.\n` +
    `  default: allow\n` +
    rulesBlock(report.tools) +
    `\n` +
    budgetsBlock(report.tools) +
    `\n` +
    `approval:\n` +
    `  timeout: 300s\n` +
    `  default_on_timeout: deny\n` +
    `  channels:\n` +
    `    - type: dashboard\n` +
    `\n` +
    `# audit:\n` +
    `#   storage: sqlite\n` +
    `#   path: ./helio-audit.db\n` +
    `#   retention: 90d\n` +
    `#   include_responses: true\n` +
    `\n` +
    `# Operator dashboard + approval REST API, where the require_approval rules\n` +
    `# above hold their calls. Bound to 127.0.0.1 by default; do not change to\n` +
    `# 0.0.0.0 without an authenticating reverse proxy in front.\n` +
    `# dashboard.api_secret holds the SHA-256 digest of the dashboard secret\n` +
    `# helio scan printed once, never the secret itself. To rotate, run\n` +
    `# \`helio secret\`, paste the new digest here, and restart the proxy.\n` +
    `dashboard:\n` +
    `  enabled: true\n` +
    `  port: 3100\n` +
    `  host: 127.0.0.1\n` +
    `  api_secret: "${input.apiSecretDigest}"\n` +
    `\n` +
    `# sdk:\n` +
    `#   enabled: false\n` +
    `#   port: 3200\n` +
    `#   host: 127.0.0.1\n`
  )
}

/**
 * Write the scaffold. Without `force` the file is created exclusively, so a
 * file that appeared while the scan ran is refused with the same line as one
 * that existed before it; any other failure names the path and the cause.
 */
export async function writeScaffold(path: string, text: string, force: boolean): Promise<void> {
  try {
    await writeFile(path, text, { encoding: 'utf-8', flag: force ? 'w' : 'wx' })
  } catch (err) {
    const code = (err as { code?: unknown }).code
    if (code === 'EEXIST') {
      throw new StartupError(`Error: ${path} already exists. Use --force to overwrite.`)
    }
    const message = err instanceof Error ? err.message : String(err)
    throw new StartupError(`Error: cannot write ${path}: ${message}`)
  }
}
