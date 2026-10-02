/**
 * Every workflow under `.github/workflows/` needs a concurrency group so
 * GitHub can keep one run per ref, and `release.yml`'s block is pinned
 * exactly: a tag push delivered twice created two Release runs on `v0.15.0`
 * (#481), and the pinned group is what lets the newer run take the ref and
 * cancel the other on whatever job it has reached. The groups must also be
 * distinct across files when compared case-insensitively, because GitHub
 * treats group names case-insensitively and two workflows sharing a group
 * would cancel each other. No workflow is required to set
 * `cancel-in-progress`: a queueing workflow (`queue: max`) cannot combine
 * with it and would be a legal shape later.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import yaml from 'js-yaml'

const REPO_ROOT = join(import.meta.dirname, '../../..')
const WORKFLOWS_DIR = join(REPO_ROOT, '.github/workflows')

/** The one key this test reads from a workflow file. */
interface WorkflowConcurrency {
  readonly concurrency?: {
    readonly group?: unknown
    readonly 'cancel-in-progress'?: unknown
  }
}

const files: readonly string[] = readdirSync(WORKFLOWS_DIR)
  .filter((file) => file.endsWith('.yml'))
  .sort()

function loadWorkflow(file: string): WorkflowConcurrency {
  return yaml.load(readFileSync(join(WORKFLOWS_DIR, file), 'utf8')) as WorkflowConcurrency
}

describe('workflow concurrency groups', () => {
  it.each(files)('%s declares a non-empty concurrency.group', (file) => {
    const group = loadWorkflow(file).concurrency?.group
    expect(group, `${file} has no concurrency.group`).toBeTypeOf('string')
    expect(group).not.toMatch(/^\s*$/)
  })

  it('uses distinct groups across workflows, compared case-insensitively', () => {
    const groups = files
      .map((file) => loadWorkflow(file).concurrency?.group)
      .filter((group): group is string => typeof group === 'string')
      .map((group) => group.toLowerCase())
    expect(new Set(groups).size).toBe(groups.length)
  })

  it('pins release.yml to one run per tag with cancel-in-progress', () => {
    expect(files).toContain('release.yml')
    expect(loadWorkflow('release.yml').concurrency).toEqual({
      group: 'release-${{ github.ref }}',
      'cancel-in-progress': true,
    })
  })
})
