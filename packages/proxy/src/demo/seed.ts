// ---------------------------------------------------------------------------
// `seedDemoDirectory`: write the four demo files (issue #397). The config
// goes first so its bytes' sha256 can stamp the current epoch; the corpus
// then goes through `AuditStore.insert` in one transaction and through the
// `BudgetLedger` with the base instant as its clock, never through DDL or a
// column list of its own, so the next schema migration is picked up by
// rerunning the command. Nothing here opens a socket or reads the working
// directory's own helio.yaml or audit database.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { AuditStore } from '../audit/store.js'
import { BudgetLedger } from '../budget/ledger.js'
import { StartupError } from '../startup-error.js'
import {
  DEMO_AUDIT_RETENTION,
  DEMO_DEFAULT_PORTS,
  renderDemoConfig,
  renderDemoReadme,
} from './config.js'
import type { DemoPorts } from './config.js'
import {
  DEMO_AUDIT_FILE,
  DEMO_CONFIG_FILE,
  DEMO_FILES,
  DEMO_README_FILE,
  DEMO_UPSTREAM_FILE,
  buildDemoCorpus,
} from './corpus.js'
import { renderDemoUpstream } from './upstream.js'

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

/**
 * How far back `--at` may sit: the oldest row is 45 days before the base,
 * and the audit retention of the rendered config is 90 days, so a base
 * older than this would have its first rows purged at the next open within
 * the day.
 */
export const DEMO_MAX_BASE_AGE_MS = 45 * DAY

/**
 * The base instant: `at` verbatim when given, else `now` floored to the
 * minute so two runs inside one minute write the same rows. Refuses one
 * line each for an unparseable instant, one older than 45 days and one in
 * the future.
 */
export function parseDemoBase(at: string | undefined, now: Date = new Date()): Date {
  if (at === undefined) return new Date(Math.floor(now.getTime() / MINUTE) * MINUTE)
  const base = new Date(at)
  if (Number.isNaN(base.getTime())) {
    throw new StartupError(`Error: --at must be an ISO 8601 instant (got "${at}").`)
  }
  if (base.getTime() < now.getTime() - DEMO_MAX_BASE_AGE_MS) {
    throw new StartupError(`Error: --at must be within the last 45 days (got ${at}).`)
  }
  if (base.getTime() > now.getTime()) {
    throw new StartupError(`Error: --at must not be in the future (got ${at}).`)
  }
  return base
}

export interface SeedDemoOptions {
  /** The base instant every row's time counts back from (see {@link parseDemoBase}). */
  readonly base: Date
  /** Overwrite the four files; the database and its sidecars are removed before the store opens. */
  readonly force: boolean
  /** The ports the config names; the getting-started defaults when omitted. */
  readonly ports?: DemoPorts
}

export interface SeedDemoResult {
  /** The resolved directory. */
  readonly dir: string
  /** The four written paths, in the order of {@link DEMO_FILES}. */
  readonly files: readonly string[]
  readonly auditRows: number
  readonly ledgerRows: number
  /** The sha256 of the written config's bytes, stamped on the current epoch's rows. */
  readonly configSha256: string
}

function errnoCode(err: unknown): string {
  const code = (err as { code?: unknown }).code
  return typeof code === 'string' ? code : 'unknown error'
}

/** Write one file, or refuse with one line naming the path and the code. */
async function writeOrRefuse(path: string, content: string): Promise<void> {
  try {
    await writeFile(path, content, 'utf-8')
  } catch (err) {
    throw new StartupError(`Error: cannot write ${path} (${errnoCode(err)}).`)
  }
}

/**
 * Write the demo directory. Refuses (one line, nothing written) when any
 * of the four target files exists and `force` is false; creates the parent
 * directories otherwise.
 */
export async function seedDemoDirectory(
  dir: string,
  options: SeedDemoOptions,
): Promise<SeedDemoResult> {
  const root = resolve(dir)
  const targets = DEMO_FILES.map((name) => join(root, name))
  const existing = targets.find((path) => existsSync(path))
  if (existing !== undefined && !options.force) {
    throw new StartupError(`Error: ${existing} already exists. Use --force to overwrite.`)
  }

  await mkdir(root, { recursive: true })

  const configPath = join(root, DEMO_CONFIG_FILE)
  const config = renderDemoConfig(options.ports ?? DEMO_DEFAULT_PORTS)
  await writeOrRefuse(configPath, config)
  const configSha256 = createHash('sha256').update(config, 'utf-8').digest('hex')

  const auditPath = join(root, DEMO_AUDIT_FILE)
  if (options.force) {
    for (const suffix of ['', '-wal', '-shm']) await rm(`${auditPath}${suffix}`, { force: true })
  }
  const corpus = buildDemoCorpus({ base: options.base, configSha256 })

  // The one open, wrapped the way the report wraps its own: a SQLite code
  // becomes one line naming the path.
  let store: AuditStore
  try {
    store = new AuditStore({
      path: auditPath,
      retention: DEMO_AUDIT_RETENTION,
      includeResponses: true,
      cleanupIntervalMs: 0,
    })
  } catch (err) {
    const code = errnoCode(err)
    if (code.startsWith('SQLITE_')) {
      const message = err instanceof Error ? err.message : String(err)
      throw new StartupError(`Error: cannot open ${auditPath} (${code}: ${message}).`)
    }
    throw err
  }
  try {
    store.database.transaction(() => {
      for (const row of corpus.records) store.insert(row.record, row.created_at, row.id)
    })()
    const ledger = new BudgetLedger({ database: store.database, now: () => options.base.getTime() })
    ledger.writeMeta(corpus.ledgerMeta)
    ledger.commitAll(corpus.ledgerRows)
  } finally {
    store.close()
  }

  await writeOrRefuse(join(root, DEMO_UPSTREAM_FILE), renderDemoUpstream())
  await writeOrRefuse(join(root, DEMO_README_FILE), renderDemoReadme())

  return {
    dir: root,
    files: targets,
    auditRows: corpus.records.length,
    ledgerRows: corpus.ledgerRows.length,
    configSha256,
  }
}
