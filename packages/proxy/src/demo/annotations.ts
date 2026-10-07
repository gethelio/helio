import type { AnnotationSource } from '../policy/simulate/types.js'
import { extractAnnotations } from '../policy/tool-definitions.js'
import { DEMO_TOOLS } from './corpus.js'
import { wireTool } from './upstream.js'

// ---------------------------------------------------------------------------
// The demo-only annotation source (issue #490): what `helio policy simulate
// --demo` hands the harness. The demo seed stamps every baseline's
// `first_seen` at the base instant and every corpus row earlier, so the
// trail source names every replayed demo call unknown by design; the
// sample server's listed definitions are the input the corpus was decided
// on, and the report names them as the source it used.
// ---------------------------------------------------------------------------

/** The one line `--demo` prints beside the frozen sentences, verbatim from the fidelity page. */
export const DEMO_ANNOTATION_LINE =
  "Annotations for --demo came from the sample server's listed definitions, not from the audit trail."

/**
 * The sample server's listed definitions as an annotation source: `known`
 * with the listed hints (undefined for a tool listed without annotations)
 * for an MCP row on a listed door and tool, `unknown` for any other origin
 * or pair.
 */
export function demoAnnotationSource(): AnnotationSource {
  const listed = new Map(
    DEMO_TOOLS.map((tool) => [`${tool.upstream}/${tool.name}`, extractAnnotations(wireTool(tool))]),
  )
  return {
    resolve: (query) => {
      const key = `${query.upstream ?? ''}/${query.tool}`
      if (query.origin !== 'mcp' || !listed.has(key)) return { kind: 'unknown' }
      return { kind: 'known', hints: listed.get(key), source: 'demo' }
    },
  }
}
