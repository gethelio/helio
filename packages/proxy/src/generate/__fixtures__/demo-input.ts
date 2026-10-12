import { createHash } from 'node:crypto'
import { AuditStore } from '../../audit/store.js'
import type { PersistedSummary } from '../../audit/types.js'
import { parseConfigSource } from '../../config/loader.js'
import type { HelioConfig } from '../../config/schema.js'
import { DEMO_TOOLS, DEMO_UPSTREAMS, buildDemoCorpus } from '../../demo/corpus.js'
import { DEMO_DEFAULT_PORTS, renderDemoConfig } from '../../demo/config.js'
import { wireTool } from '../../demo/upstream.js'
import { definitionFromListed } from '../classify.js'
import type { GenerationDefinition } from '../classify.js'

// ---------------------------------------------------------------------------
// The shipped demo as a generation input: the ten definitions on their two
// doors, helio-demo.yaml as written, and the demo corpus seeded into a
// memory store and summarized over the whole trail. Shared by the model and
// the report suites so the demo pin is one object.
// ---------------------------------------------------------------------------

export const WHOLE_TRAIL_SINCE = '1970-01-01T00:00:00.000Z'

export interface DemoGenerationInput {
  readonly source: { readonly raw: string; readonly sha256: string; readonly config: HelioConfig }
  readonly doors: ReadonlyArray<{
    readonly name: string | undefined
    readonly tools: readonly GenerationDefinition[]
  }>
  readonly observed: PersistedSummary
}

/** The demo input; `base` is the corpus's newest instant (default now, so every row is within retention). */
export function demoGenerationInput(base: Date = new Date()): DemoGenerationInput {
  const raw = renderDemoConfig(DEMO_DEFAULT_PORTS)
  const sha256 = createHash('sha256').update(raw).digest('hex')
  const { config } = parseConfigSource({ raw, sha256 }, 'helio-demo.yaml', {})
  const doors = [DEMO_UPSTREAMS.crm, DEMO_UPSTREAMS.billing].map((name) => ({
    name,
    tools: DEMO_TOOLS.filter((tool) => tool.upstream === name).map((tool) =>
      definitionFromListed(wireTool(tool)),
    ),
  }))
  const store = new AuditStore({
    path: ':memory:',
    retention: '90d',
    includeResponses: true,
    cleanupIntervalMs: 0,
  })
  try {
    const corpus = buildDemoCorpus({ base, configSha256: sha256 })
    store.database.transaction(() => {
      for (const row of corpus.records) store.insert(row.record, row.created_at, row.id)
    })()
    return {
      source: { raw, sha256, config },
      doors,
      observed: store.persistedSummary(WHOLE_TRAIL_SINCE),
    }
  } finally {
    store.close()
  }
}
