import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * Self-tests for scripts/validate-config-samples.mjs — the CI guard that
 * extracts every ```yaml fence from the doc set and validates it against the
 * real schema. Each test builds a throwaway fixture tree and spawns the guard
 * with `--repo-root` pointed at it, so every failure class the guard exists
 * to catch has been SEEN failing at least once.
 *
 * The guard shells out to the built CLI: `pnpm build` first, like cli.test.ts.
 */

const GUARD_PATH = join(import.meta.dirname, '../../../scripts/validate-config-samples.mjs')
const CLI_PATH = join(import.meta.dirname, '../dist/cli.js')

const FIXTURE_SECRET = 'fixture-dashboard-secret-not-a-real-secret'

const fixtureRoots: string[] = []

beforeAll(() => {
  if (!existsSync(CLI_PATH)) {
    throw new Error(`Built CLI not found at ${CLI_PATH} — run \`pnpm build\` before running tests`)
  }
})

afterAll(() => {
  for (const root of fixtureRoots) {
    rmSync(root, { recursive: true, force: true })
  }
})

/** Write a fixture tree into a fresh temp dir and return its root. */
function makeTree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'helio-guard-fixture-'))
  fixtureRoots.push(root)
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  return root
}

/** Run the guard against a fixture tree and capture combined output. */
function runGuard(
  repoRoot: string,
  extraArgs: string[] = [],
  env?: NodeJS.ProcessEnv,
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    execFile(
      'node',
      [GUARD_PATH, '--repo-root', repoRoot, '--cli', CLI_PATH, ...extraArgs],
      { env: env ?? process.env },
      (error, stdout, stderr) => {
        resolve({
          code: typeof error?.code === 'number' ? error.code : error ? 1 : 0,
          output: `${stdout}\n${stderr}`,
        })
      },
    )
  })
}

/** A valid full config fence body: 1 policy rule, 0 budgets. */
const VALID_FULL_CONFIG = [
  "version: '1'",
  'upstream:',
  "  url: 'http://localhost:8080/mcp'",
  'policies:',
  '  rules:',
  '    - name: block-delete',
  '      match:',
  "        tool: 'delete_*'",
  '      action: deny',
  'dashboard:',
  `  api_secret: '${FIXTURE_SECRET}'`,
  '',
].join('\n')

/** Wrap YAML content in a column-0 ```yaml fence inside a minimal doc. */
function doc(...fences: string[]): string {
  const parts = ['# Fixture doc', '']
  for (const fence of fences) {
    parts.push('```yaml', fence.replace(/\n$/, ''), '```', '')
  }
  return parts.join('\n')
}

describe('config-samples guard', () => {
  it(
    'fails a bare top-level rules: fence (landing-page defect class)',
    { timeout: 60_000 },
    async () => {
      const root = makeTree({
        'docs/test.md': doc(
          [
            'rules:',
            '  - name: nope',
            '    match:',
            "      tool: 'delete_*'",
            '    action: deny',
          ].join('\n'),
        ),
      })
      const { code, output } = await runGuard(root)
      expect(code).toBe(1)
      expect(output).toContain('docs/test.md:3')
      expect(output).toContain('FAIL')
      expect(output).toContain('unclassifiable')
    },
  )

  it(
    'fails a full config carrying a top-level rules: key (#167 regression pin)',
    { timeout: 60_000 },
    async () => {
      const root = makeTree({
        'docs/test.md': doc(
          [
            "version: '1'",
            'upstream:',
            "  url: 'http://localhost:8080/mcp'",
            'rules:',
            '  - name: nope',
            '    match:',
            "      tool: 'delete_*'",
            '    action: deny',
            'dashboard:',
            `  api_secret: '${FIXTURE_SECRET}'`,
          ].join('\n'),
        ),
      })
      const { code, output } = await runGuard(root)
      expect(code).toBe(1)
      expect(output).toContain('docs/test.md:3')
      expect(output).toContain('FAIL')
      expect(output).toContain('Unrecognized key: "rules"')
    },
  )

  it(
    'fails a rules-list fence whose rule is missing action: (README defect class)',
    { timeout: 60_000 },
    async () => {
      const root = makeTree({
        'docs/test.md': doc(['- name: no-action', '  match:', "    tool: 'delete_*'"].join('\n')),
      })
      const { code, output } = await runGuard(root)
      expect(code).toBe(1)
      expect(output).toContain('docs/test.md:3')
      expect(output).toContain('FAIL')
      expect(output).toContain('action')
    },
  )

  it(
    'fails a full config with a dangling approval channel reference (AGENTS.md defect class)',
    { timeout: 60_000 },
    async () => {
      const root = makeTree({
        'docs/test.md': doc(
          [
            "version: '1'",
            'upstream:',
            "  url: 'http://localhost:8080/mcp'",
            'policies:',
            '  rules:',
            '    - name: needs-approval',
            '      match:',
            "        tool: 'deploy_*'",
            '      action: require_approval',
            '      approval:',
            "        channel: 'sec-team'",
            'dashboard:',
            `  api_secret: '${FIXTURE_SECRET}'`,
          ].join('\n'),
        ),
      })
      const { code, output } = await runGuard(root)
      expect(code).toBe(1)
      expect(output).toContain('docs/test.md:3')
      expect(output).toContain('FAIL')
      expect(output).toMatch(/channel/i)
    },
  )

  it('fails a yaml fence that does not parse', { timeout: 60_000 }, async () => {
    const root = makeTree({
      'docs/test.md': doc(['policies:', '  rules:', '   - name: [unclosed'].join('\n')),
    })
    const { code, output } = await runGuard(root)
    expect(code).toBe(1)
    expect(output).toContain('docs/test.md:3')
    expect(output).toContain('FAIL')
    expect(output).toMatch(/parse/i)
  })

  it(
    'fails a compose-style fence without a skip marker, passes with one',
    { timeout: 60_000 },
    async () => {
      const composeFence = [
        '```yaml',
        'services:',
        '  helio:',
        '    image: ghcr.io/gethelio/helio:latest',
        '```',
      ].join('\n')

      const unmarked = makeTree({
        'docs/test.md': ['# Fixture doc', '', composeFence, ''].join('\n'),
      })
      const bad = await runGuard(unmarked)
      expect(bad.code).toBe(1)
      expect(bad.output).toContain('docs/test.md:3')
      expect(bad.output).toContain('unclassifiable')
      expect(bad.output).toContain('helio-config-guard: skip')

      const marked = makeTree({
        'docs/test.md': [
          '# Fixture doc',
          '',
          '<!-- helio-config-guard: skip -->',
          '',
          composeFence,
          '',
        ].join('\n'),
      })
      const good = await runGuard(marked)
      expect(good.output).toContain('SKIP')
      expect(good.code).toBe(0)
    },
  )

  it(
    'reports an out-of-order example loudly by default and fails under --enforce-order',
    { timeout: 60_000 },
    async () => {
      const root = makeTree({
        'examples/misordered/helio.yaml': [
          "version: '1'",
          'upstream:',
          "  url: 'http://localhost:8080/mcp'",
          'dashboard:',
          `  api_secret: '${FIXTURE_SECRET}'`,
          'policies:',
          '  rules: []',
          '',
        ].join('\n'),
      })

      const relaxed = await runGuard(root)
      expect(relaxed.code).toBe(0)
      expect(relaxed.output).toContain('NOT YET ENFORCED')
      expect(relaxed.output).toContain('#163')

      const enforced = await runGuard(root, ['--enforce-order'])
      expect(enforced.code).toBe(1)
      expect(enforced.output).toContain('examples/misordered/helio.yaml')
      expect(enforced.output).toMatch(/order/i)
      // Violations are counted separately — the candidate itself validated,
      // so the summary must not double-count it as failed.
      expect(enforced.output).toContain('1 checked, 1 passed, 0 failed, 0 skipped')
      expect(enforced.output).toContain('1 enforced order violation')
    },
  )

  it(
    'reports a scaffold missing budgets: loudly by default and fails under --enforce-completeness',
    { timeout: 60_000 },
    async () => {
      const scaffoldMissingBudgets = [
        'version: "1"',
        'upstream:',
        '  url: "http://localhost:8080/mcp"',
        '# listen:',
        'environment: production',
        '# policies:',
        '# approval:',
        '# audit:',
        'dashboard:',
        `  api_secret: "${FIXTURE_SECRET}"`,
        '# sdk:',
        '',
      ].join('\n')
      const allKeysConfig = [
        "version: '1'",
        'upstream:',
        "  url: 'http://localhost:8080/mcp'",
        'listen:',
        '  port: 3000',
        'environment: production',
        'policies:',
        '  rules: []',
        'budgets: []',
        'approval:',
        "  timeout: '300s'",
        'audit:',
        "  retention: '90d'",
        'dashboard:',
        `  api_secret: '${FIXTURE_SECRET}'`,
        'sdk:',
        '  enabled: false',
      ].join('\n')
      const root = makeTree({
        'scaffold.yaml': scaffoldMissingBudgets,
        'docs/configuration.md': doc(allKeysConfig),
      })
      const scaffoldArgs = ['--scaffold-file', join(root, 'scaffold.yaml')]

      const relaxed = await runGuard(root, scaffoldArgs)
      expect(relaxed.code).toBe(0)
      expect(relaxed.output).toContain('not enforced without --enforce-completeness')
      expect(relaxed.output).toContain('missing a top-level `budgets:` stub')

      const enforced = await runGuard(root, [...scaffoldArgs, '--enforce-completeness'])
      expect(enforced.code).toBe(1)
      expect(enforced.output).toContain('budgets')
    },
  )

  it(
    'fails when validate-reported counts disagree with the candidate (stub CLI)',
    { timeout: 60_000 },
    async () => {
      // The decoy warning carries a count-shaped substring matching the
      // candidate's EXPECTED counts — parsing must anchor to the success
      // line, not the first count-shaped text in the output.
      const root = makeTree({
        'docs/test.md': doc(VALID_FULL_CONFIG),
        'stub-cli.mjs': [
          "const p = process.argv[process.argv.indexOf('-c') + 1]",
          'console.error(\'Warning: policy rule "r": (1 policy rule, 0 budgets)\')',
          'console.error(`Config is valid: ${p} (0 policy rules, 0 budgets)`)',
          'process.exit(0)',
          '',
        ].join('\n'),
      })
      const { code, output } = await runGuard(root, ['--cli', join(root, 'stub-cli.mjs')])
      expect(code).toBe(1)
      expect(output).toContain('docs/test.md:3')
      expect(output).toMatch(/count/i)
      expect(output).toContain('expected 1 policy rule')
    },
  )

  it(
    'strips a UTF-8 BOM so a first-line fence extracts normally',
    { timeout: 60_000 },
    async () => {
      const root = makeTree({
        'docs/bom.md': '\uFEFF' + ['```yaml', "version: '1'", '```', ''].join('\n'),
      })
      const { code, output } = await runGuard(root)
      expect(output).toContain('docs/bom.md:1')
      expect(output).toContain('PASS')
      expect(code).toBe(0)
    },
  )

  it(
    'accepts a closing fence indented up to three spaces (CommonMark)',
    { timeout: 60_000 },
    async () => {
      const root = makeTree({
        'docs/close.md': ['# Doc', '', '```yaml', "version: '1'", '  ```', '', 'prose', ''].join(
          '\n',
        ),
      })
      const { code, output } = await runGuard(root)
      expect(output).toContain('docs/close.md:3')
      expect(output).toContain('PASS')
      expect(code).toBe(0)
    },
  )

  it(
    'does not treat an NBSP-suffixed backtick line as a closing fence',
    { timeout: 60_000 },
    async () => {
      // CommonMark allows only spaces/tabs after a closing fence — a
      // NBSP-suffixed line is fence CONTENT. Treating it as a closer would
      // truncate extraction and let everything after it escape scanning.
      const root = makeTree({
        'docs/nbsp.md': ['```yaml', 'policies:', '  rules: []', '```\u00A0', ''].join('\n'),
      })
      const { code, output } = await runGuard(root)
      expect(code).toBe(1)
      expect(output).toContain('docs/nbsp.md')
      expect(output).toMatch(/unclosed/i)
    },
  )

  it('scans only the three contracted package READMEs', { timeout: 60_000 }, async () => {
    // The scan contract is the drift script's DOC_PATTERNS, which names
    // proxy, dashboard, and python-sdk READMEs — not packages/*.
    const root = makeTree({
      'packages/proxy/README.md': doc("version: '1'"),
      'packages/other/README.md': doc('rules: []'),
    })
    const { code, output } = await runGuard(root)
    expect(output).toContain('packages/proxy/README.md:3')
    expect(output).not.toContain('packages/other/README.md')
    expect(code).toBe(0)
  })

  it(
    'scans CR-only markdown files instead of treating them as one line',
    { timeout: 60_000 },
    async () => {
      const root = makeTree({
        'docs/cr.md': '# Doc\r\r```yaml\rrules: []\r```\r',
      })
      const { code, output } = await runGuard(root)
      expect(code).toBe(1)
      expect(output).toContain('docs/cr.md:3')
      expect(output).toContain('FAIL')
    },
  )

  it(
    'anchors count parsing to the validated file path (forged success lines lose)',
    { timeout: 60_000 },
    async () => {
      // The decoy success line carries the candidate's EXPECTED counts but a
      // path the stub invented; the real-path line reports the wrong counts.
      // Warning text can forge count-shaped lines (a multiline rule name is
      // echoed verbatim), but never the mkdtemp-random candidate path.
      const root = makeTree({
        'docs/test.md': doc(VALID_FULL_CONFIG),
        'stub-cli.mjs': [
          "const p = process.argv[process.argv.indexOf('-c') + 1]",
          "console.error('Config is valid: /bogus.yaml (1 policy rule, 0 budgets)')",
          'console.error(`Config is valid: ${p} (0 policy rules, 0 budgets)`)',
          'process.exit(0)',
          '',
        ].join('\n'),
      })
      const { code, output } = await runGuard(root, ['--cli', join(root, 'stub-cli.mjs')])
      expect(code).toBe(1)
      expect(output).toContain('docs/test.md:3')
      expect(output).toMatch(/count mismatch/i)
    },
  )

  it(
    'takes the LAST same-path success line (shipped-config paths are predictable)',
    { timeout: 60_000 },
    async () => {
      // A shipped config knows the exact path the guard validates it at, so a
      // multiline rule name can forge a same-path success line — but only in
      // warning output, which always precedes the genuine (last) line. This
      // valid one-rule config must PASS despite the forged line.
      const root = makeTree({})
      const configPath = join(root, 'examples/inject/helio.yaml')
      mkdirSync(dirname(configPath), { recursive: true })
      const forged = `Config is valid: ${configPath} (9 policy rules, 9 budgets)`
      writeFileSync(
        configPath,
        [
          "version: '1'",
          'upstream:',
          "  url: 'http://localhost:8080/mcp'",
          'policies:',
          '  rules:',
          `    - name: "x\\n${forged}\\ny"`,
          '      match:',
          "        tool: 'deploy_*'",
          '      action: require_approval',
          'dashboard:',
          `  api_secret: '${FIXTURE_SECRET}'`,
          '',
        ].join('\n'),
      )
      const { code, output } = await runGuard(root)
      expect(output).toContain('examples/inject/helio.yaml')
      expect(output).not.toMatch(/count mismatch/i)
      expect(code).toBe(0)
    },
  )

  it('fails on a dangling shipped-config symlink', { timeout: 60_000 }, async (ctx) => {
    const root = makeTree({
      'docs/real.md': doc("version: '1'"),
    })
    mkdirSync(join(root, 'docker'), { recursive: true })
    try {
      symlinkSync(join(root, 'missing.yaml'), join(root, 'docker/helio.docker.yaml'))
    } catch {
      ctx.skip() // platform cannot create symlinks (e.g. non-elevated Windows)
    }
    const { code, output } = await runGuard(root)
    expect(code).toBe(1)
    expect(output).toContain('docker/helio.docker.yaml')
    expect(output).toMatch(/dangling/i)
  })

  it(
    'fails on a dangling scan-root symlink (docs, examples, packages, docker)',
    { timeout: 120_000 },
    async (ctx) => {
      // existsSync follows links, so a dangling root would otherwise read as
      // "absent" and the guard would scan nothing while exiting 0.
      for (const rootDir of ['docs', 'examples', 'packages', 'docker']) {
        const root = makeTree({})
        try {
          symlinkSync(join(root, 'nowhere'), join(root, rootDir))
        } catch {
          ctx.skip() // platform cannot create symlinks (e.g. non-elevated Windows)
        }
        const { code, output } = await runGuard(root)
        expect(output).toContain(rootDir)
        expect(output).toMatch(/dangling/i)
        expect(code).toBe(1)
      }
    },
  )

  it('fails on a dangling symlink in the doc tree', { timeout: 60_000 }, async (ctx) => {
    const root = makeTree({
      'docs/real.md': doc("version: '1'"),
    })
    try {
      symlinkSync(join(root, 'missing.md'), join(root, 'docs/broken.md'))
    } catch {
      ctx.skip() // platform cannot create symlinks (e.g. non-elevated Windows)
    }
    const { code, output } = await runGuard(root)
    expect(code).toBe(1)
    expect(output).toContain('docs/broken.md')
    expect(output).toMatch(/dangling|symlink/i)
  })

  it(
    'fails on an invalid backtick opener instead of letting it mask the next fence',
    { timeout: 60_000 },
    async () => {
      // CommonMark: a backtick fence's info string cannot contain a backtick,
      // so this line is prose and the following fence is real. The guard must
      // both flag the bogus opener and still see the broken fence behind it.
      const root = makeTree({
        'docs/test.md': [
          '# Fixture doc',
          '',
          '``` `inline`',
          '```yaml',
          'rules: []',
          '```',
          '',
        ].join('\n'),
      })
      const { code, output } = await runGuard(root)
      expect(code).toBe(1)
      expect(output).toContain('docs/test.md:3')
      expect(output).toContain('docs/test.md:4')
      expect(output).toMatch(/CommonMark|opener/i)
    },
  )

  it(
    'ignores skipped fences when checking configuration.md completeness',
    { timeout: 60_000 },
    async () => {
      const nineKeysConfig = [
        "version: '1'",
        'upstream:',
        "  url: 'http://localhost:8080/mcp'",
        'listen:',
        '  port: 3000',
        'environment: production',
        'policies:',
        '  rules: []',
        'approval:',
        "  timeout: '300s'",
        'audit:',
        "  retention: '90d'",
        'dashboard:',
        `  api_secret: '${FIXTURE_SECRET}'`,
        'sdk:',
        '  enabled: false',
      ].join('\n')
      const completeScaffold = [
        'version: "1"',
        'upstream:',
        '  url: "x"',
        '# listen:',
        '# environment:',
        '# policies:',
        '# budgets:',
        '# approval:',
        '# audit:',
        '# dashboard:',
        '# sdk:',
        '',
      ].join('\n')
      const root = makeTree({
        'scaffold.yaml': completeScaffold,
        // budgets: appears ONLY inside a skip-marked non-Helio fence — it
        // must not satisfy the completeness check.
        'docs/configuration.md': [
          '# Config',
          '',
          '```yaml',
          nineKeysConfig,
          '```',
          '',
          '<!-- helio-config-guard: skip -->',
          '',
          '```yaml',
          'budgets:',
          '  something: non-helio',
          '```',
          '',
        ].join('\n'),
      })
      const { code, output } = await runGuard(root, [
        '--scaffold-file',
        join(root, 'scaffold.yaml'),
        '--enforce-completeness',
      ])
      expect(code).toBe(1)
      expect(output).toContain('docs/configuration.md shows no fence with a top-level `budgets:`')
    },
  )

  it(
    'passes a config using ${VAR} with the variable unset (env synthesis)',
    { timeout: 60_000 },
    async () => {
      const root = makeTree({
        'docs/test.md': doc(
          [
            "version: '1'",
            'upstream:',
            "  url: 'http://localhost:8080/mcp'",
            '  headers:',
            "    Authorization: 'Bearer ${HELIO_GUARD_TEST_TOKEN}'",
            'dashboard:',
            "  api_secret: '${HELIO_GUARD_TEST_SECRET}'",
          ].join('\n'),
        ),
      })
      const env = { ...process.env }
      delete env.HELIO_GUARD_TEST_TOKEN
      delete env.HELIO_GUARD_TEST_SECRET
      const { code, output } = await runGuard(root, [], env)
      expect(output).toContain('PASS')
      expect(code).toBe(0)
    },
  )

  it(
    'fails an examples/basic README fence that is not a verbatim substring of the example config',
    { timeout: 60_000 },
    async () => {
      const root = makeTree({
        'examples/basic/helio.yaml': VALID_FULL_CONFIG,
        'examples/basic/README.md': doc(
          [
            'policies:',
            '  rules:',
            '    - name: renamed-rule',
            '      match:',
            "        tool: 'delete_*'",
            '      action: deny',
          ].join('\n'),
        ),
      })
      const { code, output } = await runGuard(root)
      expect(code).toBe(1)
      expect(output).toContain('examples/basic/README.md:3')
      expect(output).toMatch(/verbatim|substring/i)
      expect(output).toContain('examples/basic/helio.yaml')

      // A skip marker must not silence the mirror rule.
      const marked = makeTree({
        'examples/basic/helio.yaml': VALID_FULL_CONFIG,
        'examples/basic/README.md': [
          '# Fixture doc',
          '',
          '<!-- helio-config-guard: skip -->',
          '',
          '```yaml',
          'policies:',
          '  rules: []',
          '```',
          '',
        ].join('\n'),
      })
      const skipped = await runGuard(marked)
      expect(skipped.code).toBe(1)
      expect(skipped.output).toMatch(/verbatim|substring/i)
    },
  )

  it(
    'fails a rule-level approval: fragment instead of validating it as the root section',
    { timeout: 60_000 },
    async () => {
      const root = makeTree({
        'docs/test.md': doc(['approval:', "  channel: 'sec-team'"].join('\n')),
      })
      const { code, output } = await runGuard(root)
      expect(code).toBe(1)
      expect(output).toContain('docs/test.md:3')
      expect(output).toContain('FAIL')
      expect(output).toContain('policies.rules')
    },
  )

  it(
    'does not treat a prose mention of the skip marker as a marker',
    { timeout: 60_000 },
    async () => {
      const root = makeTree({
        'docs/test.md': [
          '# Fixture doc',
          '',
          'If a fence is not Helio YAML, put `<!-- helio-config-guard: skip -->` above it:',
          '',
          '```yaml',
          'rules: []',
          '```',
          '',
        ].join('\n'),
      })
      const { code, output } = await runGuard(root)
      expect(code).toBe(1)
      expect(output).toContain('docs/test.md:5')
      expect(output).toContain('FAIL')
      expect(output).not.toContain('SKIP')
    },
  )

  it(
    'passes a version-only fence as a fragment (basic-README shape)',
    { timeout: 60_000 },
    async () => {
      const root = makeTree({
        'docs/test.md': doc("version: '1'"),
      })
      const { code, output } = await runGuard(root)
      expect(output).toContain('fragment')
      expect(output).toContain('PASS')
      expect(code).toBe(0)
    },
  )

  it('passes a clean fixture tree with exit 0', { timeout: 120_000 }, async () => {
    const basicPolicies = [
      'policies:',
      '  default: allow',
      '  rules:',
      '    - name: block-delete',
      '      match:',
      "        tool: 'delete_*'",
      '      action: deny',
    ].join('\n')
    const root = makeTree({
      'docs/guide.md': doc(
        VALID_FULL_CONFIG,
        // Section fragment.
        basicPolicies,
        // Match-only fragment: the guard fills action: deny.
        ['match:', "  tool: 'delete_*'"].join('\n'),
        // Rules-list fragment.
        ['- name: limit-payments', '  match:', "    tool: 'create_payment'", '  action: deny'].join(
          '\n',
        ),
        // Budgets-list fragment.
        [
          '- name: daily-spend',
          '  limit: 500',
          "  currency: 'USD'",
          "  window: '24h'",
          '  contributors:',
          "    - tool: 'create_payment'",
          "      field: '$.amount'",
        ].join('\n'),
        // Anchor-holder fragment (the ^x- classifier rule).
        [
          'x-defaults: &defaults',
          '  action: deny',
          '',
          'policies:',
          '  rules:',
          '    - <<: *defaults',
          '      name: block-drop',
          '      match:',
          "        tool: 'drop_*'",
        ].join('\n'),
      ),
      // Nested doc dir: the scan is recursive like the drift script's patterns.
      'docs/guides/nested.md': doc(basicPolicies),
      // Hidden markdown files and dirs are still docs to the drift patterns.
      'docs/.hidden.md': doc(basicPolicies),
      'docs/.hidden-dir/inner.md': doc(basicPolicies),
      'linked-source.md': doc(basicPolicies),
      'examples/basic/helio.yaml': VALID_FULL_CONFIG,
      'examples/basic/README.md': doc(VALID_FULL_CONFIG.split('\n').slice(3, 9).join('\n')),
      'docker/helio.docker.yaml': [
        "version: '1'",
        'upstream:',
        "  url: 'http://helio-demo-upstream:8080/mcp'",
        'dashboard:',
        "  api_secret: '${HELIO_DASHBOARD_SECRET}'",
        '',
      ].join('\n'),
    })
    // A symlinked markdown file is scanned through the link (skipped where
    // the platform cannot create symlinks, e.g. non-elevated Windows).
    let symlinkCreated = true
    try {
      symlinkSync(join(root, 'linked-source.md'), join(root, 'docs/linked.md'))
    } catch {
      symlinkCreated = false
    }
    const env = { ...process.env }
    delete env.HELIO_DASHBOARD_SECRET
    const { code, output } = await runGuard(root, [], env)
    expect(output).toContain('full-config')
    expect(output).toContain('fragment')
    expect(output).toContain('shipped-config')
    expect(output).toContain('docs/guides/nested.md:3')
    expect(output).toContain('docs/.hidden.md:3')
    expect(output).toContain('docs/.hidden-dir/inner.md:3')
    if (symlinkCreated) expect(output).toContain('docs/linked.md:3')
    expect(output).not.toContain('FAIL')
    expect(code).toBe(0)
  })

  it(
    'fails on yaml-ish fence openers the extractor cannot capture',
    { timeout: 60_000 },
    async () => {
      const root = makeTree({
        'docs/test.md': [
          '# Fixture doc',
          '',
          '~~~yaml',
          "version: '1'",
          '~~~',
          '',
          '> ```yaml',
          '> policies: {}',
          '> ```',
          '',
          '```{.yaml}',
          "version: '1'",
          '```',
          '',
        ].join('\n'),
      })
      const { code, output } = await runGuard(root)
      expect(code).toBe(1)
      expect(output).toContain('docs/test.md:3')
      expect(output).toContain('docs/test.md:7')
      expect(output).toContain('docs/test.md:11')
      expect(output).toMatch(/opener|fence/i)
    },
  )
})
