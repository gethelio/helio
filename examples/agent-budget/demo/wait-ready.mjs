/**
 * Wait for the recording driver's restart-ready cue.
 *
 * The budget tape touches cues/restart; record.mjs then restarts the
 * example, waits for the dashboard's health route and logs the dashboard
 * in again before it writes cues/restart-ready. This script exits 0 the
 * moment that file exists, so the tape's next command reads the second
 * process however long the boot took, and exits 1 after 30 seconds so a
 * failed boot never hangs the tape. No dependency.
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const cue = resolve(import.meta.dirname, 'cues', 'restart-ready')
const deadline = Date.now() + 30_000

while (Date.now() < deadline) {
  if (existsSync(cue)) process.exit(0)
  await new Promise((r) => setTimeout(r, 200))
}

console.error('wait-ready: cues/restart-ready did not appear within 30 s')
process.exit(1)
