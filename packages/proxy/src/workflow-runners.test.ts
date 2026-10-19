/**
 * Every job in every workflow under `.github/workflows/` runs on one pinned
 * runner image, so the release jobs run on the image CI proved and GitHub's
 * move of a floating label such as `ubuntu-latest` changes nothing here on its
 * schedule (#502). Moving the image is a deliberate change made in this
 * constant and in the workflows together, on a branch whose full gate has run
 * on the new image (#528). A job with no `runs-on` fails; when a job that
 * calls a reusable workflow is added, amend this test then.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import yaml from 'js-yaml'

const REPO_ROOT = join(import.meta.dirname, '../../..')
const WORKFLOWS_DIR = join(REPO_ROOT, '.github/workflows')

const RUNNER_IMAGE = 'ubuntu-24.04'

/** The one key this test reads from a workflow file. */
interface WorkflowJobs {
  readonly jobs?: unknown
}

const files: readonly string[] = readdirSync(WORKFLOWS_DIR)
  .filter((file) => file.endsWith('.yml'))
  .sort()

function loadJobs(file: string): Readonly<Record<string, unknown>> {
  const { jobs } = yaml.load(readFileSync(join(WORKFLOWS_DIR, file), 'utf8')) as WorkflowJobs
  return typeof jobs === 'object' && jobs !== null
    ? (jobs as Readonly<Record<string, unknown>>)
    : {}
}

function runsOn(job: unknown): unknown {
  return typeof job === 'object' && job !== null
    ? (job as { readonly 'runs-on'?: unknown })['runs-on']
    : undefined
}

const jobs: readonly (readonly [string, unknown])[] = files.flatMap((file) =>
  Object.entries(loadJobs(file)).map(([name, job]) => [`${file}:${name}`, job] as const),
)

describe('workflow runner images', () => {
  it.each(files)('%s declares at least one job', (file) => {
    expect(Object.keys(loadJobs(file)).length, `${file} declares no jobs`).toBeGreaterThan(0)
  })

  it.each(jobs)('%s runs on the pinned image', (label, job) => {
    expect(runsOn(job), `${label} does not run on ${RUNNER_IMAGE}`).toBe(RUNNER_IMAGE)
  })
})
