/**
 * Record one of the two demos as two captures of ONE live session: the
 * terminal pane through VHS, the dashboard pane through screencapture, then
 * assembled side by side with ffmpeg. Nothing is spliced in from elsewhere.
 *
 *   node demo/record.mjs budget      # one $50 pot, three doors, a restart
 *   node demo/record.mjs approval    # the approval card for a write tool
 *   node demo/record.mjs budget --assemble --trim-dashboard 0.8
 *
 * The driver loads ../.env, deletes the example's audit database so the pot
 * starts empty, starts `pnpm start` from the example directory in its own
 * process group, waits for the dashboard's health route, launches the
 * Chrome binary with a fresh profile as an app window, logs the dashboard
 * in over the DevTools protocol, starts screencapture on that window's
 * rectangle, and runs the tape. While the tape runs it answers the cue
 * files the tape touches under demo/cues: approve, expand-1, expand-2 and
 * restart. The restart sends the example's process group the same SIGINT
 * Ctrl-C would, boots it again from the same directory, logs the dashboard
 * in again, and writes cues/restart-ready for wait-ready.mjs.
 *
 * Prerequisites: vhs (brew install vhs, which brings ffmpeg and ttyd),
 * Google Chrome, jq, and macOS Screen Recording permission for the terminal
 * that runs this script. Keep the app window unobscured while it records.
 * No package dependency.
 */

import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Dashboard } from './dashboard.mjs'

const DEMO_DIR = import.meta.dirname
const EXAMPLE_DIR = resolve(DEMO_DIR, '..')
const CUES_DIR = join(DEMO_DIR, 'cues')
const OUT_DIR = join(DEMO_DIR, 'out')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const FONT = '/System/Library/Fonts/Helvetica.ttc'
const DASHBOARD = 'http://127.0.0.1:3100'
const HEALTH_URL = `${DASHBOARD}/api/health`
const WINDOW = { width: 1280, height: 800, left: 0, top: 40 }
const PANE_HEIGHT = 800
const READ_MS = 3_000

const RECORDINGS = {
  budget: {
    tape: 'budget.tape',
    startPath: '/budgets',
    caption: 'One $50 budget. Three merchants. Three servers. Same agent mandate.',
    restartCaption: 'Restarted. The ledger kept it.',
    gif: 'side-by-side',
    gifWidth: 1100,
  },
  approval: {
    tape: 'approval.tape',
    startPath: '/approvals',
    caption:
      'The agent calls a write tool. The approver reads the tool, the door, the rule and the arguments.',
    restartCaption: null,
    gif: 'dashboard',
    gifWidth: 900,
  },
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// Arguments and environment
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const [name, ...rest] = argv
  const recording = RECORDINGS[name]
  if (!recording) {
    console.error(
      `usage: node demo/record.mjs <budget|approval> [--assemble] [--trim-terminal s] [--trim-dashboard s]`,
    )
    process.exit(2)
  }
  const options = { assemble: false, trimTerminal: undefined, trimDashboard: undefined }
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i]
    if (flag === '--assemble') options.assemble = true
    else if (flag === '--trim-terminal') options.trimTerminal = Number(rest[(i += 1)])
    else if (flag === '--trim-dashboard') options.trimDashboard = Number(rest[(i += 1)])
    else {
      console.error(`unknown flag ${flag}`)
      process.exit(2)
    }
  }
  return { name, recording, options }
}

/** Load ../.env into process.env without overriding what is already set. */
function loadEnv() {
  const file = join(EXAMPLE_DIR, '.env')
  if (!existsSync(file)) {
    console.error(`${file} is missing: copy .env.example to .env and set HELIO_DASHBOARD_SECRET`)
    process.exit(1)
  }
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2]
  }
  if (!process.env.HELIO_DASHBOARD_SECRET) {
    console.error('HELIO_DASHBOARD_SECRET is empty in .env')
    process.exit(1)
  }
}

function requireTool(tool, hint) {
  if (spawnSync('which', [tool], { stdio: 'ignore' }).status !== 0) {
    console.error(`${tool} is not installed: ${hint}`)
    process.exit(1)
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

// ---------------------------------------------------------------------------
// The example's process group
// ---------------------------------------------------------------------------

/** Start `pnpm start` from the example directory in its own process group. */
function spawnExample() {
  const child = spawn('pnpm', ['start'], {
    cwd: EXAMPLE_DIR,
    detached: true,
    stdio: 'ignore',
    env: process.env,
  })
  child.on('error', (err) => {
    console.error(`pnpm start failed: ${err.message}`)
  })
  return child
}

async function waitForHealth(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const res = await fetch(HEALTH_URL)
      if (res.status === 200) return
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error('the dashboard health route did not answer 200')
    await sleep(200)
  }
}

async function waitForPortClosed(url, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      await fetch(url)
    } catch {
      return
    }
    if (Date.now() > deadline) throw new Error(`${url} is still answering`)
    await sleep(200)
  }
}

/** Ctrl-C the whole group and wait for the leader and the ports. */
async function stopExample(child) {
  if (child.exitCode !== null) return
  const exited = new Promise((r) => child.once('exit', r))
  try {
    process.kill(-child.pid, 'SIGINT')
  } catch {
    return
  }
  await exited
  await waitForPortClosed(HEALTH_URL)
  await waitForPortClosed('http://127.0.0.1:3000/mcp/compute')
}

// ---------------------------------------------------------------------------
// Chrome and screencapture
// ---------------------------------------------------------------------------

/**
 * Launch the Chrome binary with a fresh profile, never `open -a`: a running
 * Chrome would adopt the launch and drop the flags. The app URL loads as
 * the process starts, so this runs only after the dashboard answered 200.
 */
function launchChrome(port, startPath) {
  const profile = mkdtempSync(join(tmpdir(), 'helio-demo-chrome-'))
  const chrome = spawn(
    CHROME,
    [
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${String(port)}`,
      '--no-first-run',
      '--no-default-browser-check',
      `--window-size=${String(WINDOW.width)},${String(WINDOW.height)}`,
      `--window-position=${String(WINDOW.left)},${String(WINDOW.top)}`,
      `--app=${DASHBOARD}${startPath}`,
    ],
    { stdio: 'ignore' },
  )
  return { chrome, profile }
}

function startCapture(bounds, file) {
  const rect = [bounds.left, bounds.top, bounds.width, bounds.height].map(String).join(',')
  return spawn('screencapture', ['-v', '-R', rect, '-V', '300', file], { stdio: 'ignore' })
}

function stopProcess(child, signal) {
  if (child.exitCode !== null) return Promise.resolve()
  const exited = new Promise((r) => child.once('exit', r))
  child.kill(signal)
  return exited
}

// ---------------------------------------------------------------------------
// Cues
// ---------------------------------------------------------------------------

function clearCues() {
  mkdirSync(CUES_DIR, { recursive: true })
  for (const file of readdirSync(CUES_DIR)) unlinkSync(join(CUES_DIR, file))
}

/**
 * Answer each cue file once, in the order the tape touches them. A handler
 * that throws is recorded on the timeline and fails the take once the tape
 * ends: a frame the driver could not produce is not a take.
 */
function watchCues(handlers, timeline) {
  let busy = Promise.resolve()
  const timer = setInterval(() => {
    for (const name of Object.keys(handlers)) {
      const file = join(CUES_DIR, name)
      if (!existsSync(file)) continue
      unlinkSync(file)
      timeline.cues[name] = Date.now()
      busy = busy
        .then(() => handlers[name]())
        .catch((err) => {
          console.error(`cue ${name} failed: ${err.message}`)
          timeline.failedCues.push(name)
        })
    }
  }, 100)
  return () => {
    clearInterval(timer)
    return busy
  }
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

function ffmpeg(args) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    stdio: 'inherit',
  })
  if (result.status !== 0) throw new Error(`ffmpeg exited ${String(result.status)}`)
}

function drawtext(textFile, y, enable) {
  const base = `drawtext=fontfile=${FONT}:textfile=${textFile}:fontsize=30:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=14:x=(w-text_w)/2:y=${y}`
  return enable ? `${base}:enable='gte(t,${enable})'` : base
}

/**
 * Both panes resampled to a constant 30 fps, trimmed so the terminal's
 * `date -u` line and the dashboard agree, stacked side by side, captioned,
 * written as an mp4 and a palette GIF. The timeline file records the trims
 * used, so a re-run with --assemble can adjust them without a retake.
 */
function assemble(name, recording, timeline) {
  const terminal = join(OUT_DIR, `${name}-terminal.mp4`)
  const dashboard = join(OUT_DIR, `${name}-dashboard.mov`)
  const captionFile = join(OUT_DIR, `${name}-caption.txt`)
  writeFileSync(captionFile, recording.caption)
  const filters = [
    `[0:v]fps=30,scale=-2:${String(PANE_HEIGHT)}[t]`,
    `[1:v]fps=30,scale=-2:${String(PANE_HEIGHT)}[d]`,
  ]
  let chain = `[t][d]hstack=inputs=2,${drawtext(captionFile, 'h-th-36')}`
  if (recording.restartCaption && timeline.cues.restart) {
    const restartFile = join(OUT_DIR, `${name}-caption-restart.txt`)
    writeFileSync(restartFile, recording.restartCaption)
    const at = Math.max(
      0,
      (timeline.cues.restart - timeline.vhsStartedAt) / 1000 - timeline.trimTerminal,
    )
    chain += `,${drawtext(restartFile, 'h-th-96', at.toFixed(2))}`
  }
  filters.push(`${chain}[v]`)
  const mp4 = join(OUT_DIR, `${name}.mp4`)
  ffmpeg([
    '-ss',
    timeline.trimTerminal.toFixed(2),
    '-i',
    terminal,
    '-ss',
    timeline.trimDashboard.toFixed(2),
    '-i',
    dashboard,
    '-filter_complex',
    filters.join(';'),
    '-map',
    '[v]',
    '-shortest',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-crf',
    '20',
    '-movflags',
    '+faststart',
    '-an',
    mp4,
  ])
  const palette = `split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5`
  const gif = join(OUT_DIR, `${name}.gif`)
  if (recording.gif === 'side-by-side') {
    ffmpeg([
      '-i',
      mp4,
      '-vf',
      `fps=12,scale=${String(recording.gifWidth)}:-1:flags=lanczos,${palette}`,
      gif,
    ])
  } else {
    // The approval GIF is a crop on the dashboard pane: the card is the point.
    ffmpeg([
      '-ss',
      timeline.trimDashboard.toFixed(2),
      '-i',
      dashboard,
      '-vf',
      `fps=12,scale=${String(recording.gifWidth)}:-1:flags=lanczos,${drawtext(captionFile, 'h-th-24')},${palette}`,
      '-an',
      gif,
    ])
  }
  console.log(
    `wrote ${mp4} and ${gif} (trims: terminal ${timeline.trimTerminal.toFixed(2)} s, dashboard ${timeline.trimDashboard.toFixed(2)} s)`,
  )
}

// ---------------------------------------------------------------------------
// The take
// ---------------------------------------------------------------------------

async function record(name, recording, options) {
  requireTool('vhs', 'brew install vhs')
  requireTool('ffmpeg', 'brew install vhs brings it')
  requireTool('jq', 'the tapes pipe tools/list through it')
  if (!existsSync(CHROME)) {
    console.error(`${CHROME} is missing: install Google Chrome`)
    process.exit(1)
  }
  mkdirSync(OUT_DIR, { recursive: true })
  clearCues()
  for (const suffix of ['', '-wal', '-shm'])
    rmSync(join(EXAMPLE_DIR, `helio-audit.db${suffix}`), { force: true })
  console.log('deleted the example audit database so the pot starts empty')

  const timeline = {
    name,
    vhsStartedAt: 0,
    captureStartedAt: 0,
    cues: {},
    failedCues: [],
    trimTerminal: 0,
    trimDashboard: 0,
  }
  let example = spawnExample()
  let chrome
  let profile
  let capture
  let dash
  let stopWatching = () => Promise.resolve()
  const secret = process.env.HELIO_DASHBOARD_SECRET

  const cleanup = async () => {
    await stopWatching()
    if (capture) await stopProcess(capture, 'SIGINT')
    if (dash) dash.close()
    if (chrome) await stopProcess(chrome, 'SIGTERM')
    if (profile) rmSync(profile, { recursive: true, force: true })
    await stopExample(example)
  }
  process.once('SIGINT', () => {
    cleanup().finally(() => process.exit(130))
  })

  try {
    await waitForHealth()
    const port = await freePort()
    ;({ chrome, profile } = launchChrome(port, recording.startPath))
    dash = await Dashboard.connect(port)
    await dash.login(secret)
    await dash.waitFor(
      `location.pathname === ${JSON.stringify(recording.startPath)}`,
      'the start page',
    )
    await dash.bringToFront()
    const bounds = await dash.windowBounds()

    capture = startCapture(bounds, join(OUT_DIR, `${name}-dashboard.mov`))
    timeline.captureStartedAt = Date.now()
    await sleep(1_000)

    stopWatching = watchCues(
      {
        approve: async () => {
          await dash.approvePending({ readMs: READ_MS })
          if (name === 'budget') await dash.go('/budgets')
        },
        'expand-1': () => dash.expandRecentEvents(),
        'expand-2': () => dash.expandRecentEvents(),
        restart: async () => {
          await stopExample(example)
          example = spawnExample()
          await waitForHealth()
          await dash.send('Page.reload')
          await dash.login(secret)
          await dash.waitFor(`location.pathname === '/budgets'`, 'the Budgets page')
          writeFileSync(join(CUES_DIR, 'restart-ready'), '')
        },
      },
      timeline,
    )

    timeline.vhsStartedAt = Date.now()
    const vhs = spawn('vhs', [recording.tape], {
      cwd: DEMO_DIR,
      stdio: 'inherit',
      env: process.env,
    })
    const code = await new Promise((r) => vhs.once('exit', r))
    if (code !== 0) throw new Error(`vhs exited ${String(code)}`)
  } finally {
    await cleanup()
  }
  if (timeline.failedCues.length > 0) {
    throw new Error(`the take is not usable: cue ${timeline.failedCues.join(', ')} failed`)
  }

  timeline.trimTerminal = options.trimTerminal ?? 0
  timeline.trimDashboard =
    options.trimDashboard ?? Math.max(0, (timeline.vhsStartedAt - timeline.captureStartedAt) / 1000)
  writeFileSync(join(OUT_DIR, `${name}-timeline.json`), JSON.stringify(timeline, null, 2) + '\n')
  assemble(name, recording, timeline)
}

function reassemble(name, recording, options) {
  const file = join(OUT_DIR, `${name}-timeline.json`)
  if (!existsSync(file)) {
    console.error(`${file} is missing: record first`)
    process.exit(1)
  }
  const timeline = JSON.parse(readFileSync(file, 'utf8'))
  if (options.trimTerminal !== undefined) timeline.trimTerminal = options.trimTerminal
  if (options.trimDashboard !== undefined) timeline.trimDashboard = options.trimDashboard
  writeFileSync(file, JSON.stringify(timeline, null, 2) + '\n')
  assemble(name, recording, timeline)
}

const { name, recording, options } = parseArgs(process.argv.slice(2))
loadEnv()
if (options.assemble) reassemble(name, recording, options)
else await record(name, recording, options)
