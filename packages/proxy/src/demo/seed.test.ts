import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { AuditStore } from '../audit/store.js'
import { BudgetEngine, BudgetLedger, compileBudgets } from '../budget/index.js'
import { loadConfig } from '../config/index.js'
import { mintGatedCharges } from '../__tests__/helpers/session-gate-mints.js'
import {
  DEMO_AUDIT_FILE,
  DEMO_BUDGET_NAME,
  DEMO_CONFIG_FILE,
  DEMO_FILES,
  DEMO_README_FILE,
  DEMO_UPSTREAM_FILE,
  buildDemoCorpus,
} from './corpus.js'
import { DEMO_MAX_BASE_AGE_MS, parseDemoBase, seedDemoDirectory } from './seed.js'

// ---------------------------------------------------------------------------
// Every seed lands in its own temp directory and is deleted after the test.
// The base is pinned so two seeds can be compared row for row.
// ---------------------------------------------------------------------------

const BASE = new Date('2026-09-24T12:00:00.000Z')
const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'helio-demo-seed-'))
}

function openStore(dir: string): AuditStore {
  return new AuditStore({
    path: join(dir, DEMO_AUDIT_FILE),
    retention: '90d',
    includeResponses: true,
    cleanupIntervalMs: 0,
  })
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** Every column of every row, as the row-for-row comparison of two seeds reads them. */
function dump(path: string, sql: string): string[] {
  const db = new Database(path, { readonly: true })
  try {
    return (db.prepare(sql).all() as Array<Record<string, unknown>>).map((row) =>
      JSON.stringify(row),
    )
  } finally {
    db.close()
  }
}

const AUDIT_SQL = 'SELECT * FROM audit_records ORDER BY created_at, id'
const EVENTS_SQL =
  'SELECT budget_name, epoch, bucket_key, kind, amount, currency, tool_name, origin, ' +
  'audit_record_id, timestamp, timestamp_ms, created_at FROM budget_events ' +
  'ORDER BY timestamp_ms, audit_record_id'
const META_SQL = 'SELECT * FROM budget_meta ORDER BY budget_name'

describe('parseDemoBase', () => {
  const now = new Date('2026-09-24T12:34:56.789Z')

  it('floors the current minute when nothing is given', () => {
    expect(parseDemoBase(undefined, now).toISOString()).toBe('2026-09-24T12:34:00.000Z')
  })

  it('pins the given instant verbatim', () => {
    expect(parseDemoBase('2026-09-20T08:15:30Z', now).toISOString()).toBe(
      '2026-09-20T08:15:30.000Z',
    )
  })

  it('refuses an instant it cannot parse', () => {
    expect(() => parseDemoBase('yesterday', now)).toThrow(
      'Error: --at must be an ISO 8601 instant (got "yesterday").',
    )
  })

  it('refuses an instant more than 45 days back', () => {
    const tooOld = new Date(now.getTime() - DEMO_MAX_BASE_AGE_MS - MINUTE).toISOString()
    expect(() => parseDemoBase(tooOld, now)).toThrow(
      `Error: --at must be within the last 45 days (got ${tooOld}).`,
    )
    const oldest = new Date(now.getTime() - DEMO_MAX_BASE_AGE_MS).toISOString()
    expect(parseDemoBase(oldest, now).toISOString()).toBe(oldest)
  })

  it('refuses an instant in the future', () => {
    const later = new Date(now.getTime() + MINUTE).toISOString()
    expect(() => parseDemoBase(later, now)).toThrow(
      `Error: --at must not be in the future (got ${later}).`,
    )
  })

  it('bounds the base at 45 days', () => {
    expect(DEMO_MAX_BASE_AGE_MS).toBe(45 * DAY)
  })
})

describe('seedDemoDirectory: what it writes', () => {
  it('writes the four files and reports their paths and counts', async () => {
    const dir = tempDir()
    try {
      const target = join(dir, 'demo')
      const result = await seedDemoDirectory(target, { base: BASE, force: false })
      expect(DEMO_FILES).toEqual([
        DEMO_CONFIG_FILE,
        DEMO_AUDIT_FILE,
        DEMO_UPSTREAM_FILE,
        DEMO_README_FILE,
      ])
      expect(result.dir).toBe(target)
      expect(result.files).toEqual(DEMO_FILES.map((name) => join(target, name)))
      for (const path of result.files) expect(existsSync(path), path).toBe(true)
      const corpus = buildDemoCorpus({ base: BASE, configSha256: result.configSha256 })
      expect(result.auditRows).toBe(corpus.records.length)
      expect(result.ledgerRows).toBe(19)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('creates the parent directories', async () => {
    const dir = tempDir()
    try {
      const target = join(dir, 'a', 'b', 'demo')
      await seedDemoDirectory(target, { base: BASE, force: false })
      expect(existsSync(join(target, DEMO_CONFIG_FILE))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('stamps the current epoch with the sha256 of the config bytes it wrote', async () => {
    const dir = tempDir()
    try {
      const result = await seedDemoDirectory(dir, { base: BASE, force: false })
      const hash = sha256(join(dir, DEMO_CONFIG_FILE))
      expect(result.configSha256).toBe(hash)
      const store = openStore(dir)
      try {
        const newest = store.database
          .prepare(
            'SELECT config_sha256 FROM audit_records ORDER BY created_at DESC, rowid DESC LIMIT 1',
          )
          .get() as { config_sha256: string }
        expect(newest.config_sha256).toBe(hash)
        const { n } = store.database.prepare('SELECT COUNT(*) AS n FROM audit_records').get() as {
          n: number
        }
        expect(n).toBe(result.auditRows)
      } finally {
        store.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('writes the ledger meta and the 19 events through the ledger', async () => {
    const dir = tempDir()
    try {
      await seedDemoDirectory(dir, { base: BASE, force: false })
      const store = openStore(dir)
      try {
        const ledger = new BudgetLedger({ database: store.database })
        expect(ledger.readMeta(DEMO_BUDGET_NAME)).toEqual({
          budget_name: DEMO_BUDGET_NAME,
          limit_amount: 500,
          currency: 'USD',
          window: '24h',
          key: 'global',
          epoch: 2,
        })
        const page = ledger.listEventsForExport(DEMO_BUDGET_NAME)
        expect(page.total).toBe(19)
        expect(page.events).toHaveLength(19)
        const meta = store.database.prepare('SELECT updated_at FROM budget_meta').get() as {
          updated_at: string
        }
        expect(meta.updated_at).toBe(BASE.toISOString())
        for (const event of page.events) expect(event.created_at).toBe(BASE.toISOString())
      } finally {
        store.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('hydrates into one pot past its limit that refuses the next charge', async () => {
    const dir = tempDir()
    try {
      await seedDemoDirectory(dir, { base: BASE, force: false })
      const config = await loadConfig(join(dir, DEMO_CONFIG_FILE))
      const store = openStore(dir)
      try {
        const now = () => BASE.getTime() + MINUTE
        const ledger = new BudgetLedger({ database: store.database, now })
        const engine = new BudgetEngine({
          budgets: compileBudgets(config.budgets),
          now,
          cleanupIntervalMs: 0,
          ledger,
        })
        engine.hydrate()
        const states = engine.listStates()
        expect(states).toHaveLength(1)
        expect(states[0]?.name).toBe(DEMO_BUDGET_NAME)
        expect(states[0]?.buckets).toHaveLength(1)
        expect(states[0]?.buckets[0]).toMatchObject({
          bucket_key: `budget:${DEMO_BUDGET_NAME}:global`,
          spent: 540,
          remaining: 0,
        })
        const { charges } = engine.resolveCharges({
          toolName: 'create_charge',
          toolArguments: { amount: 60, currency: 'USD', customer: 'cus_1077' },
          sessionId: null,
          senderId: null,
          upstream: 'demo-billing',
        })
        expect(charges).toHaveLength(1)
        expect(engine.peekAll(mintGatedCharges(charges)).allowed).toBe(false)
        engine.close()
      } finally {
        store.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('seedDemoDirectory: refusals and --force', () => {
  it('refuses any existing target file without --force and writes nothing', async () => {
    const dir = tempDir()
    try {
      const readme = join(dir, DEMO_README_FILE)
      writeFileSync(readme, 'mine\n')
      await expect(seedDemoDirectory(dir, { base: BASE, force: false })).rejects.toThrow(
        `Error: ${readme} already exists. Use --force to overwrite.`,
      )
      expect(readFileSync(readme, 'utf-8')).toBe('mine\n')
      expect(existsSync(join(dir, DEMO_CONFIG_FILE))).toBe(false)
      expect(existsSync(join(dir, DEMO_AUDIT_FILE))).toBe(false)
      expect(existsSync(join(dir, DEMO_UPSTREAM_FILE))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('names the first existing file in the written order', async () => {
    const dir = tempDir()
    try {
      writeFileSync(join(dir, DEMO_AUDIT_FILE), '')
      writeFileSync(join(dir, DEMO_README_FILE), '')
      await expect(seedDemoDirectory(dir, { base: BASE, force: false })).rejects.toThrow(
        `Error: ${join(dir, DEMO_AUDIT_FILE)} already exists. Use --force to overwrite.`,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('replaces the database and its sidecars with --force and leaves a stray file alone', async () => {
    const dir = tempDir()
    try {
      const first = await seedDemoDirectory(dir, { base: BASE, force: false })
      const store = openStore(dir)
      const sample = buildDemoCorpus({ base: BASE, configSha256: first.configSha256 }).records[0]
      if (!sample) throw new Error('the corpus is empty')
      const extra = store.insert(
        { ...sample.record, tool_name: 'extra_row_before_force' },
        BASE.toISOString(),
      )
      store.close()
      expect(extra).toBeTruthy()
      const stray = join(dir, 'notes.txt')
      writeFileSync(stray, 'keep me\n')
      writeFileSync(join(dir, `${DEMO_AUDIT_FILE}-wal`), 'STALE')
      writeFileSync(join(dir, `${DEMO_AUDIT_FILE}-shm`), 'STALE')

      const second = await seedDemoDirectory(dir, { base: BASE, force: true })
      expect(second.auditRows).toBe(first.auditRows)
      expect(readFileSync(stray, 'utf-8')).toBe('keep me\n')
      for (const sidecar of ['-wal', '-shm']) {
        const path = join(dir, `${DEMO_AUDIT_FILE}${sidecar}`)
        if (existsSync(path)) expect(readFileSync(path, 'utf-8')).not.toContain('STALE')
      }
      const again = openStore(dir)
      try {
        const { n } = again.database.prepare('SELECT COUNT(*) AS n FROM audit_records').get() as {
          n: number
        }
        expect(n).toBe(first.auditRows)
        const { gone } = again.database
          .prepare(
            "SELECT COUNT(*) AS gone FROM audit_records WHERE tool_name = 'extra_row_before_force'",
          )
          .get() as { gone: number }
        expect(gone).toBe(0)
      } finally {
        again.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('seedDemoDirectory: determinism', () => {
  it('writes byte-equal audit rows and ledger rows (minus the event id) from one base', async () => {
    const dir = tempDir()
    try {
      const a = join(dir, 'a')
      const b = join(dir, 'b')
      await seedDemoDirectory(a, { base: BASE, force: false })
      await seedDemoDirectory(b, { base: BASE, force: false })
      expect(sha256(join(a, DEMO_CONFIG_FILE))).toBe(sha256(join(b, DEMO_CONFIG_FILE)))
      expect(readFileSync(join(a, DEMO_UPSTREAM_FILE))).toEqual(
        readFileSync(join(b, DEMO_UPSTREAM_FILE)),
      )
      expect(readFileSync(join(a, DEMO_README_FILE))).toEqual(
        readFileSync(join(b, DEMO_README_FILE)),
      )
      const dbA = join(a, DEMO_AUDIT_FILE)
      const dbB = join(b, DEMO_AUDIT_FILE)
      const auditA = dump(dbA, AUDIT_SQL)
      expect(auditA.length).toBeGreaterThan(300)
      expect(auditA).toEqual(dump(dbB, AUDIT_SQL))
      expect(dump(dbA, EVENTS_SQL)).toEqual(dump(dbB, EVENTS_SQL))
      expect(dump(dbA, META_SQL)).toEqual(dump(dbB, META_SQL))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
