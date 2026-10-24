// ---------------------------------------------------------------------------
// The one line a CLI command prints when it cannot write an output file:
// `Error: cannot write <path> (<CODE>).`, with the path as the operator spelled
// it. `helio init`, `helio init --demo` and `helio report activation --out`
// all refuse through this module, so the line and its errno fallback are
// written once.
// ---------------------------------------------------------------------------

import { writeFile } from 'node:fs/promises'
import { StartupError } from '../startup-error.js'

function errnoCode(err: unknown): string {
  const code = (err as { code?: unknown }).code
  return typeof code === 'string' ? code : 'unknown error'
}

/** The one line a CLI command prints when it cannot write `path`. */
export function cannotWriteLine(path: string, code: string): string {
  return `Error: cannot write ${path} (${code}).`
}

/** The same line for a thrown error, read through this module's one errno fallback. */
export function cannotWriteFrom(path: string, err: unknown): string {
  return cannotWriteLine(path, errnoCode(err))
}

/** Write one file, or refuse with one line naming the path and the code. */
export async function writeOrRefuse(path: string, content: string): Promise<void> {
  try {
    await writeFile(path, content, 'utf-8')
  } catch (err) {
    throw new StartupError(cannotWriteFrom(path, err))
  }
}
