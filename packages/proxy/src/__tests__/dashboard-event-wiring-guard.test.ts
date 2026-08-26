import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// Source guard (issue #292): both composition homes must consume the
// dashboardEventCallbacks factory instead of inlining the record/ticket/
// limiter-state projections.
//
// Nothing type-level forces a composition root to CALL the factory — a
// call-and-discard (or a re-inlined emit) would ship three dark SSE events
// while every unit test stays green. This pin closes that residual with
// comment-stripped string assertions. Stated honesty limit: string matching
// cannot prove the assignments reach the constructors (a pin-shaped dummy
// object beside bare constructors would pass) — that is deliberate evasion,
// not the accident class this guard exists to catch; a full AST guard is
// out of scope.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url))

/** Strip block comments and whole-token line comments. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/gm, '$1')
}

const HOMES = [
  {
    label: 'src/cli.ts',
    path: join(here, '..', 'cli.ts'),
    // Anchored per-file specifier: the factory NAME must appear inside the
    // import clause from this file's own barrel path. `[^}]*` spans
    // Prettier-wrapped multiline named imports. Never an unanchored
    // `includes` — '../dashboard/index.js' substring-contains the cli path.
    importRe: /import \{[^}]*dashboardEventCallbacks[^}]*\} from '\.\/dashboard\/index\.js'/,
  },
  {
    label: 'src/__tests__/e2e-full.test.ts',
    path: join(here, 'e2e-full.test.ts'),
    importRe: /import \{[^}]*dashboardEventCallbacks[^}]*\} from '\.\.\/dashboard\/index\.js'/,
  },
] as const

const BINDING_RE = /const (\w+) = dashboardEventCallbacks\(/

describe.each(HOMES)('dashboard event wiring in $label (issue #292)', ({ path, importRe }) => {
  const source = stripComments(readFileSync(path, 'utf8'))

  it('imports the factory from the dashboard barrel', () => {
    expect(source).toMatch(importRe)
  })

  it('binds the factory result and assigns all four callbacks explicitly', () => {
    // D3b mandates the `const <id> = dashboardEventCallbacks(...)` binding
    // form; destructuring is a documented false-fail of this guard, not a
    // supported spelling.
    const binding = BINDING_RE.exec(source)
    expect(binding).not.toBeNull()
    const id = binding?.[1] ?? ''
    expect(source).toContain(`onPersist: ${id}.onPersist`)
    expect(source).toContain(`onSubmit: ${id}.onApprovalSubmit`)
    expect(source).toContain(`onWarning: ${id}.onRateWarning`)
    expect(source).toContain(`onWarning: ${id}.onSpendWarning`)
  })

  it('keeps the three moved projections out of the composition root', () => {
    // approval_resolved (and, in cli.ts, the notification + budget
    // passthroughs) legitimately remain inline — only the three projections
    // the factory owns must not reappear as hand-built emits.
    expect(source).not.toContain("emit('action'")
    expect(source).not.toContain("emit('approval_requested'")
    expect(source).not.toContain("emit('limit_warning'")
  })
})
