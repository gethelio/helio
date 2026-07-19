#!/usr/bin/env node
/**
 * validate-config-samples.mjs — extract every config sample we ship and
 * validate it against the real schema via the built CLI.
 *
 * Scope: every column-0 ```yaml fence in the doc set (the drift script's
 * markdown set plus AGENTS.md), every `examples/<name>/helio.yaml`, and
 * `docker/helio.docker.yaml`. Fences that are fragments (a bare `policies:`
 * block, a rule, a rules list) are overlaid onto a standard harness config
 * first. Zero exit from `helio validate` is not trusted alone: the printed
 * `(N policy rules, M budgets)` counts must match counts derived from the
 * candidate document, so a silently-dropped section can never pass.
 *
 * Enforced at merge: fence validation (check 1), shipped-config validation
 * (check 2), the examples/basic README mirror rule, extraction hygiene, and
 * root-key completeness of the init scaffold + configuration.md (check 4,
 * --enforce-completeness, passed by both package.json entry points).
 * Implemented but flag-gated until its fix lands: canonical section order
 * (check 3, --enforce-order, activates with #163). It reports loudly while
 * unenforced.
 *
 * Usage: node scripts/validate-config-samples.mjs
 *   [--repo-root <dir>] [--cli <path>] [--scaffold-file <path>]
 *   [--enforce-order] [--enforce-completeness]
 *
 * Requires a build first: pnpm build && pnpm docs:check:samples
 */

import { execFile } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { availableParallelism, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** Canonical top-level section order (docs/configuration.md is the reference). */
const CANONICAL_ORDER = [
  'version',
  'upstream',
  'listen',
  'environment',
  'policies',
  'budgets',
  'approval',
  'audit',
  'dashboard',
  'sdk',
]
const ROOT_KEYS = new Set(CANONICAL_ORDER)

/** Top-level keys of a policy rule (policyRuleSchema in config/schema.ts). */
const RULE_KEYS = new Set([
  'name',
  'match',
  'action',
  'approval',
  'evidence',
  'requires',
  'requires_success',
  'limits',
  'feedback',
])

/** Top-level keys of a budget (budgetSchema in config/schema.ts). */
const BUDGET_KEYS = new Set([
  'name',
  'limit',
  'currency',
  'window',
  'key',
  'on_exceed',
  'approval',
  'idle_ttl',
  'contributors',
])
/** A budget-shaped item must carry at least one of these discriminators. */
const BUDGET_MARKERS = ['limit', 'currency', 'contributors', 'window']

/**
 * Keys of the ROOT approval section (approvalSchema). `approval` is also rule
 * vocabulary, and until #182 the root schema silently drops unknown keys — so
 * a rule-level approval excerpt shown as a top-level `approval:` block would
 * validate against the wrong schema and false-PASS. Any candidate whose root
 * `approval:` carries keys outside this set is rejected here instead.
 * Redundant (and removable) once #182 makes the nested schemas strict.
 */
const ROOT_APPROVAL_KEYS = new Set(['timeout', 'default_on_timeout', 'channels'])

const SKIP_MARKER = 'helio-config-guard: skip'
const DUMMY_ENV_VALUE = 'docs-guard-dummy'
const ENV_VAR_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g

/**
 * The standard harness fragments are overlaid onto (fence keys win). It
 * satisfies the cross-reference validators fragments commonly lean on: a
 * top-level `environment` for `match.environment`, a `slack` channel and a
 * `webhook` delegate for rule/budget `approval` blocks, and a dashboard
 * api_secret for `require_approval` actions.
 */
const HARNESS_YAML = `version: '1'
upstream:
  url: 'http://localhost:8080/mcp'
environment: production
approval:
  channels:
    - type: slack
      bot_token: 'xoxb-your-bot-token'
      signing_secret: 'docs-guard-dummy-signing'
      channel: '#docs-guard'
    - name: webhook
      type: webhook
      url: 'https://example.invalid/docs-guard'
dashboard:
  api_secret: 'docs-guard-0123456789abcdef0123456789abcdef'
`
const HARNESS = yaml.load(HARNESS_YAML)

const DUMP_OPTS = { lineWidth: -1, noRefs: true }

/**
 * READMEs that quote a shipped config file section by section. Every yaml
 * fence in the readme must be a contiguous verbatim substring of the source
 * file — strictly stronger than validation for a file-quoting readme, since
 * it pins content drift too. Per-file explicit; extend the list if another
 * example readme adopts the mirror pattern.
 */
const MIRROR_RULES = [{ readme: 'examples/basic/README.md', source: 'examples/basic/helio.yaml' }]

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function die(message) {
  console.error(`validate-config-samples: ${message}`)
  process.exit(2)
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function run(cmd, args, env) {
  return new Promise((resolvePromise) => {
    execFile(cmd, args, { env, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolvePromise({
        code: typeof error?.code === 'number' ? error.code : error ? 1 : 0,
        output: `${stdout}${stderr}`,
      })
    })
  })
}

/** Run `fn` over `items` with bounded concurrency, preserving result order. */
async function mapPool(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Split into lines accepting LF, CRLF, and lone-CR endings — a CR-only file
 * must not collapse into one giant line and silently carry zero fences. */
function splitLines(text) {
  return text.split(/\r\n?|\n/)
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    repoRoot: null,
    cli: null,
    scaffoldFile: null,
    enforceOrder: false,
    enforceCompleteness: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--repo-root':
      case '--cli':
      case '--scaffold-file': {
        const value = argv[++i]
        if (value === undefined) die(`${arg} requires a value`)
        if (arg === '--repo-root') opts.repoRoot = value
        else if (arg === '--cli') opts.cli = value
        else opts.scaffoldFile = value
        break
      }
      case '--enforce-order':
        opts.enforceOrder = true
        break
      case '--enforce-completeness':
        opts.enforceCompleteness = true
        break
      default:
        die(`unknown argument: ${arg}`)
    }
  }
  opts.repoRoot = resolve(opts.repoRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), '..'))
  opts.cli = resolve(opts.cli ?? join(opts.repoRoot, 'packages/proxy/dist/cli.js'))
  return opts
}

// ---------------------------------------------------------------------------
// File discovery (the drift script's DOC_PATTERNS markdown set + AGENTS.md)
// ---------------------------------------------------------------------------

function listSubdirs(root, rel) {
  const abs = join(root, rel)
  if (!existsSync(abs)) return []
  return readdirSync(abs, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

/** Recursively collect files matching `matches`, mirroring the drift script's
 * recursive patterns (`^docs/.*\.md$`, `^examples/.*\/README\.md$`). Hidden
 * files and directories count (the drift patterns match them); symlinked
 * files are followed, symlinked directories are not (cycle risk), and a
 * dangling symlink is reported as a problem rather than silently dropped. */
function walkFiles(repoRoot, rel, matches, out, problems) {
  const abs = join(repoRoot, rel)
  if (!existsSync(abs)) return
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue
    const childRel = `${rel}/${entry.name}`
    let kind = entry
    if (entry.isSymbolicLink()) {
      try {
        kind = statSync(join(abs, entry.name))
      } catch {
        // A dangling symlink is broken repo state, not a skippable entry.
        problems.push({ file: childRel, reason: DANGLING_SYMLINK_REASON })
        continue
      }
      if (kind.isDirectory()) continue // symlinked dirs: cycle risk, not followed
    }
    if (kind.isDirectory()) {
      walkFiles(repoRoot, childRel, matches, out, problems)
    } else if (kind.isFile() && matches(entry.name)) {
      out.push(childRel)
    }
  }
}

const DANGLING_SYMLINK_REASON =
  'dangling symlink — the target does not exist; fix or remove the link'

/** Push `rel` when present; a dangling symlink at `rel` is a problem, not a
 * silent absence (existsSync follows links and reports it as missing). */
function addIfPresent(repoRoot, rel, files, problems) {
  const abs = join(repoRoot, rel)
  if (existsSync(abs)) {
    files.push(rel)
    return
  }
  try {
    lstatSync(abs)
    problems.push({ file: rel, reason: DANGLING_SYMLINK_REASON })
  } catch {
    // Genuinely absent — fine, the list is a superset of what a repo has.
  }
}

/** existsSync follows symlinks, so a dangling scan-root symlink would read
 * as absent and the guard would scan nothing while exiting 0. Returns true
 * when `rel` is unusable (absent or dangling); dangling is a problem. */
function rootMissing(repoRoot, rel, problems) {
  const abs = join(repoRoot, rel)
  if (existsSync(abs)) return false
  try {
    lstatSync(abs)
    problems.push({ file: rel, reason: DANGLING_SYMLINK_REASON })
  } catch {
    // Genuinely absent — normal for partial trees.
  }
  return true
}

function listDocFiles(repoRoot) {
  const files = []
  const problems = []
  for (const rel of [
    'README.md',
    'CONTRIBUTING.md',
    'SECURITY.md',
    'CODE_OF_CONDUCT.md',
    'DEPENDENCIES.md',
    'AGENTS.md',
    'docker/README.md',
  ]) {
    addIfPresent(repoRoot, rel, files, problems)
  }
  if (!rootMissing(repoRoot, 'docs', problems)) {
    walkFiles(repoRoot, 'docs', (name) => name.endsWith('.md'), files, problems)
  }
  // Exactly the package READMEs the drift script's DOC_PATTERNS name — the
  // scan contract is parity with that set, not packages/*.
  if (!rootMissing(repoRoot, 'packages', problems)) {
    for (const rel of [
      'packages/proxy/README.md',
      'packages/dashboard/README.md',
      'packages/python-sdk/README.md',
    ]) {
      addIfPresent(repoRoot, rel, files, problems)
    }
  }
  for (const example of listSubdirs(repoRoot, 'examples')) {
    walkFiles(repoRoot, `examples/${example}`, (name) => name === 'README.md', files, problems)
  }
  return { files: files.sort(), problems }
}

function listShippedConfigs(repoRoot) {
  const files = []
  const problems = []
  if (!rootMissing(repoRoot, 'examples', problems)) {
    for (const example of listSubdirs(repoRoot, 'examples')) {
      addIfPresent(repoRoot, `examples/${example}/helio.yaml`, files, problems)
    }
  }
  if (!rootMissing(repoRoot, 'docker', problems)) {
    addIfPresent(repoRoot, 'docker/helio.docker.yaml', files, problems)
  }
  return { files: files.sort(), problems }
}

// ---------------------------------------------------------------------------
// Fence extraction
// ---------------------------------------------------------------------------

/**
 * Extract column-0 ```yaml / ```yml fences. Any other yaml-ish opener —
 * tilde, 4-backtick, blockquoted, or indented — is a hard error, so a fence
 * the extractor cannot see is a build failure, not a silent skip.
 */
function extractFences(text) {
  // Strip one leading UTF-8 BOM so a first-line fence is not misread as
  // indented (and its closer as a stray opener).
  const lines = splitLines(text.replace(/^\uFEFF/, ''))
  const fences = []
  const problems = []
  const yamlInfo = /^ya?ml\b/i
  // Anything carrying a yaml/yml token anywhere in the info string — catches
  // attribute-syntax variants like `{.yaml}` that are yaml-ish but not
  // capturable, so they hard-error instead of silently not being scanned.
  const yamlish = /(?:^|[^a-z0-9])ya?ml(?:$|[^a-z0-9])/i
  let open = null

  // The nearest non-blank line above the opener must BE the marker comment —
  // a prose line merely mentioning the marker convention must not skip.
  const markerPattern = new RegExp(`^<!--\\s*${SKIP_MARKER}\\s*-->\\s*$`)
  const markerAbove = (index) => {
    let j = index - 1
    while (j >= 0 && lines[j].trim() === '') j--
    return j >= 0 && markerPattern.test(lines[j])
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (open) {
      // CommonMark allows a closing fence indented up to three spaces and
      // followed only by spaces/tabs — not \s, which would let Unicode
      // whitespace (NBSP) fake a closer and truncate extraction.
      const close = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/)
      if (close && close[1][0] === open.char && close[1].length >= open.len) {
        if (open.capture) {
          fences.push({
            line: open.start + 1,
            text: open.content.join('\n'),
            skip: open.skip,
          })
        }
        open = null
      } else if (open.capture) {
        open.content.push(line)
      }
      continue
    }
    const opener = line.match(/^(`{3,}|~{3,})(.*)$/)
    if (opener) {
      const info = opener[2].trim()
      if (opener[1][0] === '`' && info.includes('`')) {
        // CommonMark: a backtick fence's info string cannot contain a
        // backtick, so this line is NOT a fence opener. Tracking it as one
        // would swallow every real fence until the next stray terminator —
        // hard-error instead of mis-tracking fence state.
        problems.push({
          line: i + 1,
          reason:
            'not a valid CommonMark fence opener (a backtick fence info string cannot ' +
            'contain a backtick) — rewrite the line so fence extraction stays unambiguous',
        })
        continue
      }
      const capture = opener[1] === '```' && yamlInfo.test(info)
      if (yamlish.test(info) && !capture) {
        problems.push({
          line: i + 1,
          reason:
            `yaml fence opener the extractor cannot capture (${JSON.stringify(opener[1])} ` +
            `with info ${JSON.stringify(info)}) — use a plain column-0 \`\`\`yaml fence`,
        })
      }
      open = {
        char: opener[1][0],
        len: opener[1].length,
        capture,
        start: i,
        content: [],
        skip: markerAbove(i),
      }
      continue
    }
    // Column-0 openers were consumed above, so anything matching here is
    // blockquoted or indented — shapes the extractor cannot capture.
    const hidden = line.match(/^\s*(?:>\s*)*(`{3,}|~{3,})(.*)$/)
    if (hidden && yamlish.test(hidden[2].trim())) {
      problems.push({
        line: i + 1,
        reason:
          'blockquoted or indented yaml fence opener the extractor cannot capture — ' +
          'use a plain column-0 ```yaml fence',
      })
    }
  }
  if (open) {
    problems.push({ line: open.start + 1, reason: 'unclosed fence' })
  }
  return { fences, problems }
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Classify a fence by parsed shape and build the candidate document to
 * validate. Returns { kind } plus, for validatable kinds, { candidateText,
 * doc, ownKeys } — or { reason } for error kinds.
 */
function classifyFence(text) {
  let node
  try {
    node = yaml.load(text)
  } catch (err) {
    return { kind: 'unparseable', reason: `YAML parse failed: ${err.message}` }
  }

  if (isPlainObject(node)) {
    const keys = Object.keys(node)
    const approvalViolation = rootApprovalViolation(node)
    if (keys.includes('version') && keys.includes('upstream')) {
      if (approvalViolation) return { kind: 'full-config', reason: approvalViolation }
      // Full config: validate the fence text as-is, byte for byte.
      return { kind: 'full-config', candidateText: text, doc: node, ownKeys: keys }
    }
    if (keys.length > 0 && keys.every((key) => ROOT_KEYS.has(key) || key.startsWith('x-'))) {
      if (approvalViolation) return { kind: 'fragment', reason: approvalViolation }
      const merged = { ...HARNESS, ...node }
      return {
        kind: 'fragment',
        candidateText: yaml.dump(merged, DUMP_OPTS),
        doc: merged,
        ownKeys: keys,
      }
    }
    if (keys.length > 0 && keys.every((key) => RULE_KEYS.has(key))) {
      // Single rule. `action: deny` is defaulted ONLY for match-only anatomy
      // excerpts — a rule using any other vocabulary must supply its own
      // action or fail, so the guard cannot silently repair the
      // missing-action defect class.
      const rule = { ...node }
      if (keys.every((key) => key === 'match') && rule.action === undefined) {
        rule.action = 'deny'
      }
      const merged = { ...HARNESS, policies: { rules: [rule] } }
      return { kind: 'rule-fragment', candidateText: yaml.dump(merged, DUMP_OPTS), doc: merged }
    }
  }

  if (Array.isArray(node) && node.length > 0 && node.every(isPlainObject)) {
    if (node.every((item) => Object.keys(item).every((key) => RULE_KEYS.has(key)))) {
      const merged = { ...HARNESS, policies: { rules: node } }
      return { kind: 'rules-list', candidateText: yaml.dump(merged, DUMP_OPTS), doc: merged }
    }
    if (
      node.every(
        (item) =>
          Object.keys(item).every((key) => BUDGET_KEYS.has(key)) &&
          BUDGET_MARKERS.some((marker) => marker in item),
      )
    ) {
      const merged = { ...HARNESS, budgets: node }
      return { kind: 'budgets-list', candidateText: yaml.dump(merged, DUMP_OPTS), doc: merged }
    }
  }

  return {
    kind: 'unclassifiable',
    reason:
      'not a full config, root-section fragment, rule fragment, or rules/budgets list. ' +
      `If this is not Helio config YAML, put <!-- ${SKIP_MARKER} --> on the line above the fence.`,
  }
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

function expectedCounts(doc) {
  const rules =
    isPlainObject(doc) && isPlainObject(doc.policies) && Array.isArray(doc.policies.rules)
      ? doc.policies.rules.length
      : 0
  const budgets = isPlainObject(doc) && Array.isArray(doc.budgets) ? doc.budgets.length : 0
  return { rules, budgets }
}

/**
 * Reject a root `approval:` section carrying rule/budget-level approval keys
 * (see ROOT_APPROVAL_KEYS — the false-pass path this closes).
 */
function rootApprovalViolation(doc) {
  if (!isPlainObject(doc) || !isPlainObject(doc.approval)) return null
  const unknown = Object.keys(doc.approval).filter((key) => !ROOT_APPROVAL_KEYS.has(key))
  if (unknown.length === 0) return null
  return (
    `top-level approval: carries ${unknown.map((key) => `"${key}"`).join(', ')} — ` +
    'rule/budget-level approval keys. The root approval section takes only timeout, ' +
    'default_on_timeout, and channels, and silently drops unknown keys until #182 lands ' +
    '(a false pass). Nest the block under policies.rules[].approval (or budgets[].approval) ' +
    'instead.'
  )
}

/** Canonical-order subsequence check over a document's own top-level keys. */
function orderViolation(ownKeys) {
  const indices = ownKeys
    .filter((key) => ROOT_KEYS.has(key))
    .map((key) => CANONICAL_ORDER.indexOf(key))
  for (let i = 1; i < indices.length; i++) {
    if (indices[i] <= indices[i - 1]) {
      return `top-level keys not in canonical order (${CANONICAL_ORDER.join(' → ')})`
    }
  }
  return null
}

/**
 * Validate a candidate through the built CLI. Every `${VAR}` in the final
 * candidate text gets a dummy value in the child env — loadConfig throws on
 * unset variables before the schema ever runs, and shipped configs use them.
 */
async function runValidate(cli, filePath, candidateText, expected) {
  const env = { ...process.env }
  for (const match of candidateText.matchAll(ENV_VAR_PATTERN)) {
    env[match[1]] = DUMMY_ENV_VALUE
  }
  const { code, output } = await run('node', [cli, 'validate', '-c', filePath], env)
  if (code !== 0) {
    return { failures: [`validate exited ${code}:\n${output.trimEnd()}`] }
  }
  // Anchor to the success line for the exact file we validated, and take the
  // LAST such line: warning text can echo doc-controlled strings (a
  // multiline rule name lands at column 0) and a shipped config even knows
  // its own path — but warnings always precede the genuine success line,
  // which is the final thing validate prints.
  const successLine = new RegExp(
    `^Config is valid: ${escapeRegExp(filePath)} \\((\\d+) policy rules?, (\\d+) budgets?\\)\\s*$`,
    'gm',
  )
  let counts = null
  for (const match of output.matchAll(successLine)) counts = match
  if (!counts) {
    return {
      failures: [`could not parse counts from validate output:\n${output.trimEnd()}`],
    }
  }
  const rules = Number(counts[1])
  const budgets = Number(counts[2])
  if (rules !== expected.rules || budgets !== expected.budgets) {
    return {
      failures: [
        `count mismatch: validate reported ${plural(rules, 'policy rule')}, ` +
          `${plural(budgets, 'budget')}; expected ${plural(expected.rules, 'policy rule')}, ` +
          `${plural(expected.budgets, 'budget')}`,
      ],
    }
  }
  return { failures: [] }
}

/**
 * Check 4: all 10 root keys present in the init scaffold (commented stubs
 * count) and, uncommented at column 0, in at least one configuration.md
 * fence. Returns violation strings.
 */
async function checkCompleteness(opts, workDir, configurationFences) {
  const violations = []

  let scaffoldText = null
  if (opts.scaffoldFile) {
    if (existsSync(opts.scaffoldFile)) {
      scaffoldText = readFileSync(opts.scaffoldFile, 'utf8')
    } else {
      violations.push(`scaffold file not found: ${opts.scaffoldFile}`)
    }
  } else {
    const scaffoldPath = join(workDir, 'scaffold.yaml')
    const { code, output } = await run('node', [opts.cli, 'init', '-o', scaffoldPath], {
      ...process.env,
    })
    if (code === 0 && existsSync(scaffoldPath)) {
      scaffoldText = readFileSync(scaffoldPath, 'utf8')
    } else {
      violations.push(`could not generate the init scaffold (exit ${code}):\n${output.trimEnd()}`)
    }
  }
  if (scaffoldText !== null) {
    for (const key of CANONICAL_ORDER) {
      if (!new RegExp(`^(?:#\\s*)?${key}:`, 'm').test(scaffoldText)) {
        violations.push(`init scaffold is missing a top-level \`${key}:\` stub`)
      }
    }
  }

  if (configurationFences === undefined) {
    violations.push('docs/configuration.md not found — cannot check root-key completeness')
  } else {
    for (const key of CANONICAL_ORDER) {
      const shown = configurationFences.some((fence) =>
        new RegExp(`^${key}:`, 'm').test(fence.text),
      )
      if (!shown) {
        violations.push(`docs/configuration.md shows no fence with a top-level \`${key}:\``)
      }
    }
  }
  return violations
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (!existsSync(opts.repoRoot)) die(`repo root not found: ${opts.repoRoot}`)
  if (!existsSync(opts.cli)) {
    die(`built CLI not found at ${opts.cli} — run \`pnpm build\` first`)
  }

  const workDir = mkdtempSync(join(tmpdir(), 'helio-config-guard-'))
  try {
    // Pre-flight: the harness itself must validate, so harness rot fails as
    // one named error instead of as failures on every fragment fence.
    const harnessPath = join(workDir, 'harness.yaml')
    writeFileSync(harnessPath, HARNESS_YAML)
    const harnessResult = await runValidate(opts.cli, harnessPath, HARNESS_YAML, {
      rules: 0,
      budgets: 0,
    })
    if (harnessResult.failures.length > 0) {
      console.error(
        'validate-config-samples: the standard harness failed validation — ' +
          'HARNESS_YAML in this script is stale, fix it first:',
      )
      for (const failure of harnessResult.failures) console.error(failure)
      process.exitCode = 2
      return
    }

    const candidates = []
    const orderViolations = []
    const fencesByFile = new Map()

    const docDiscovery = listDocFiles(opts.repoRoot)
    for (const problem of docDiscovery.problems) {
      candidates.push({ label: problem.file, kind: 'discovery', failures: [problem.reason] })
    }
    for (const file of docDiscovery.files) {
      const text = readFileSync(join(opts.repoRoot, file), 'utf8')
      const { fences, problems } = extractFences(text)
      fencesByFile.set(file, fences)
      for (const problem of problems) {
        candidates.push({
          label: `${file}:${problem.line}`,
          kind: 'extraction',
          failures: [problem.reason],
        })
      }
      const mirror = MIRROR_RULES.find((rule) => rule.readme === file)
      const mirrorSourcePath = mirror ? join(opts.repoRoot, mirror.source) : null
      // Fence text is LF-joined by extraction, so normalize the source too.
      const mirrorSource =
        mirrorSourcePath && existsSync(mirrorSourcePath)
          ? readFileSync(mirrorSourcePath, 'utf8').replace(/\r\n?/g, '\n')
          : null
      for (const fence of fences) {
        const label = `${file}:${fence.line}`
        // The mirror rule applies to every fence in a mirror readme — a skip
        // marker exempts a fence from validation, never from the mirror rule.
        const mirrorFailures = []
        if (mirror) {
          const fenceText = fence.text.replace(/\n+$/, '')
          if (mirrorSource === null) {
            mirrorFailures.push(`mirror source ${mirror.source} not found`)
          } else if (!mirrorSource.includes(fenceText)) {
            mirrorFailures.push(
              `not a contiguous verbatim substring of ${mirror.source} — the readme quotes ` +
                'the shipped file and must stay identical to it',
            )
          }
        }
        if (fence.skip) {
          candidates.push({ label, kind: 'skipped', failures: mirrorFailures })
          continue
        }
        const cls = classifyFence(fence.text)
        const candidate = { label, kind: cls.kind, failures: mirrorFailures }
        if (cls.reason) {
          candidate.failures.push(cls.reason)
        } else {
          candidate.candidateText = cls.candidateText
          candidate.expected = expectedCounts(cls.doc)
          if (cls.ownKeys) {
            const violation = orderViolation(cls.ownKeys)
            if (violation) orderViolations.push(`${label}: ${violation}`)
          }
        }
        candidates.push(candidate)
      }
    }

    const shippedDiscovery = listShippedConfigs(opts.repoRoot)
    for (const problem of shippedDiscovery.problems) {
      candidates.push({ label: problem.file, kind: 'discovery', failures: [problem.reason] })
    }
    for (const file of shippedDiscovery.files) {
      const text = readFileSync(join(opts.repoRoot, file), 'utf8')
      const candidate = { label: file, kind: 'shipped-config', failures: [] }
      try {
        const doc = yaml.load(text)
        const approvalViolation = rootApprovalViolation(doc)
        if (approvalViolation) candidate.failures.push(approvalViolation)
        candidate.validatePath = join(opts.repoRoot, file)
        candidate.candidateText = text
        candidate.expected = expectedCounts(doc)
        const violation = orderViolation(isPlainObject(doc) ? Object.keys(doc) : [])
        if (violation) orderViolations.push(`${file}: ${violation}`)
      } catch (err) {
        candidate.failures.push(`YAML parse failed: ${err.message}`)
      }
      candidates.push(candidate)
    }

    // Validate every candidate that classified cleanly, bounded-parallel.
    let candidateIndex = 0
    await mapPool(
      candidates.filter((c) => c.candidateText !== undefined && c.failures.length === 0),
      Math.min(8, availableParallelism()),
      async (candidate) => {
        let filePath = candidate.validatePath
        if (!filePath) {
          filePath = join(workDir, `candidate-${candidateIndex++}.yaml`)
          const text = candidate.candidateText
          writeFileSync(filePath, text.endsWith('\n') ? text : `${text}\n`)
        }
        const { failures } = await runValidate(
          opts.cli,
          filePath,
          candidate.candidateText,
          candidate.expected,
        )
        candidate.failures.push(...failures)
      },
    )

    // Skip-marked fences are non-Helio YAML by definition — they must not
    // satisfy the completeness check.
    const completenessViolations = await checkCompleteness(
      opts,
      workDir,
      fencesByFile.get('docs/configuration.md')?.filter((fence) => !fence.skip),
    )

    // -----------------------------------------------------------------------
    // Report
    // -----------------------------------------------------------------------

    let failed = 0
    let passed = 0
    let skipped = 0
    const width = Math.max(...candidates.map((c) => c.label.length), 0)
    for (const candidate of candidates) {
      let status
      if (candidate.failures.length > 0) {
        status = 'FAIL'
        failed++
      } else if (candidate.kind === 'skipped') {
        status = 'SKIP'
        skipped++
      } else {
        status = 'PASS'
        passed++
      }
      console.log(`${candidate.label.padEnd(width)}  ${candidate.kind.padEnd(14)}  ${status}`)
      for (const failure of candidate.failures) {
        for (const line of failure.split('\n')) console.log(`    ${line}`)
      }
    }

    console.log('')
    if (orderViolations.length > 0) {
      const header = opts.enforceOrder
        ? 'canonical-order violations (enforced):'
        : 'NOT YET ENFORCED (activates with #163) — canonical-order violations:'
      console.log(header)
      for (const violation of orderViolations) console.log(`  ${violation}`)
      console.log('')
    }
    if (completenessViolations.length > 0) {
      const header = opts.enforceCompleteness
        ? 'root-key completeness violations (enforced):'
        : 'root-key completeness violations (not enforced without --enforce-completeness):'
      console.log(header)
      for (const violation of completenessViolations) console.log(`  ${violation}`)
      console.log('')
    }

    // Enforced violations are counted beside the per-candidate totals, not
    // folded into them — a candidate that validated but sits out of order
    // must not show up as both passed and failed.
    const enforcedOrder = opts.enforceOrder ? orderViolations.length : 0
    const enforcedCompleteness = opts.enforceCompleteness ? completenessViolations.length : 0
    let summary =
      `Config samples: ${candidates.length} checked, ${passed} passed, ` +
      `${failed} failed, ${skipped} skipped`
    if (enforcedOrder > 0) summary += `; ${plural(enforcedOrder, 'enforced order violation')}`
    if (enforcedCompleteness > 0) {
      summary += `; ${plural(enforcedCompleteness, 'enforced completeness violation')}`
    }
    console.log(summary)
    process.exitCode = failed > 0 || enforcedOrder > 0 || enforcedCompleteness > 0 ? 1 : 0
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

await main()
