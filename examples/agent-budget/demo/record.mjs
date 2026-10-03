/**
 * Record one of the two demos as two captures of ONE live session: the
 * terminal pane through VHS, the dashboard pane through ffmpeg's screen
 * device, then assembled side by side with ffmpeg. Nothing is spliced in
 * from elsewhere.
 *
 *   node demo/record.mjs budget      # one $50 pot, three doors, a restart
 *   node demo/record.mjs approval    # the approval card for a write tool
 *   node demo/record.mjs budget --assemble --trim-dashboard 0.8
 *
 * The driver loads ../.env, deletes the example's audit database so the pot
 * starts empty, starts `pnpm start` from the example directory in its own
 * process group, waits for the dashboard's health route, launches the
 * Chrome binary with a fresh profile as an app window, logs the dashboard
 * in over the DevTools protocol, starts an ffmpeg capture of that window's
 * rectangle, and runs the tape. While the tape runs it answers the cue
 * files the tape touches under demo/cues: approve, expand-1, expand-2 and
 * restart, with the real mouse pointer on the page's own controls (see
 * pointer.mjs), so the recording shows the clicks. The restart sends the example's process group the same SIGINT
 * Ctrl-C would, boots it again from the same directory, logs the dashboard
 * in again, and writes cues/restart-ready for wait-ready.mjs.
 *
 * Prerequisites: vhs (brew install vhs, which brings ffmpeg and ttyd),
 * Google Chrome, jq, and macOS Screen Recording permission for the terminal
 * that runs this script. Keep the app window unobscured while it records.
 * No package dependency.
 *
 * Why ffmpeg and not screencapture for the dashboard pane: screencapture
 * only finalizes its movie on a Ctrl-C from its own terminal; a signal
 * from a parent process kills it without writing a file. ffmpeg's
 * avfoundation device stops cleanly on a `q` and needs the same Screen
 * Recording permission. The captions are rendered to transparent PNGs by
 * Chrome and composited with ffmpeg's overlay filter, because the Homebrew
 * ffmpeg bottle carries no text filter (no drawtext, no subtitles).
 */

import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Dashboard } from './dashboard.mjs'
import { click, moveTo, pointerPosition, selfTest } from './pointer.mjs'

const DEMO_DIR = import.meta.dirname
const EXAMPLE_DIR = resolve(DEMO_DIR, '..')
const CUES_DIR = join(DEMO_DIR, 'cues')
const OUT_DIR = join(DEMO_DIR, 'out')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const DASHBOARD = 'http://127.0.0.1:3100'
const HEALTH_URL = `${DASHBOARD}/api/health`
// Wide enough for the pot card's ledger rows, badge and amount included, to
// lay out on one line each at the three-column card width, and narrow
// enough for a 1512-point MacBook Pro display.
const WINDOW = { width: 1500, height: 800, left: 0, top: 40 }
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
// Chrome and the screen capture
// ---------------------------------------------------------------------------

/**
 * Launch the Chrome binary with a fresh profile, never `open -a`: a running
 * Chrome would adopt the launch and drop the flags. The app URL loads as
 * the process starts, so this runs only after the dashboard answered 200.
 */
function launchChrome(port, startPath) {
  const profile = mkdtempSync(join(tmpdir(), 'helio-demo-chrome-'))
  // A fresh profile offers to save the secret after the login; this
  // preference keeps that bubble off the recorded window.
  mkdirSync(join(profile, 'Default'))
  writeFileSync(
    join(profile, 'Default', 'Preferences'),
    JSON.stringify({
      credentials_enable_service: false,
      profile: { password_manager_enabled: false },
    }),
  )
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

/** The avfoundation index of the main display, where the app window sits. */
function screenDevice() {
  const listing = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''],
    {
      encoding: 'utf8',
    },
  )
  const match = /\[(\d+)\] Capture screen 0/.exec(listing.stderr)
  if (!match) {
    throw new Error(
      'ffmpeg lists no screen device: grant Screen Recording to the terminal running this script',
    )
  }
  return match[1]
}

/**
 * Record the window's rectangle through ffmpeg's screen device at the
 * display's pixel scale. The capture reports its own start: the first
 * progress block carries the media time already recorded, so the wall
 * clock of frame zero is known to the block's cadence, not to the time
 * ffmpeg took to open the device.
 */
function startCapture(bounds, scale, file) {
  const crop = [bounds.width, bounds.height, bounds.left, bounds.top]
    .map((n) => String(Math.round(n * scale)))
    .join(':')
  const child = spawn(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'avfoundation',
      '-framerate',
      '30',
      '-capture_cursor',
      '1',
      // Frames keep the device's wall-clock stamps, so the file's own
      // start_time says exactly when the capture began.
      '-use_wallclock_as_timestamps',
      '1',
      '-i',
      `${screenDevice()}:none`,
      '-vf',
      `crop=${crop}`,
      // The hardware encoder keeps the CPU free for VHS: a loaded machine
      // makes VHS skip screenshots and its terminal video runs fast.
      '-c:v',
      'h264_videotoolbox',
      '-b:v',
      '12M',
      '-pix_fmt',
      'yuv420p',
      '-copyts',
      '-video_track_timescale',
      '30000',
      '-progress',
      'pipe:1',
      '-stats_period',
      '0.25',
      file,
    ],
    { stdio: ['pipe', 'pipe', 'inherit'] },
  )
  const started = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('the screen capture produced no frames')),
      15_000,
    )
    child.stdout.on('data', (chunk) => {
      const match = /out_time_us=(\d+)/.exec(String(chunk))
      if (!match) return
      clearTimeout(timer)
      resolve(Date.now() - Number(match[1]) / 1000)
    })
    child.once('exit', () => {
      clearTimeout(timer)
      reject(new Error('the screen capture exited before its first frame'))
    })
  })
  return { child, started }
}

/** The capture's first frame as a wall-clock epoch in ms, from its start_time. */
function captureStart(file) {
  const probe = spawnSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=start_time', '-of', 'csv=p=0', file],
    { encoding: 'utf8' },
  )
  const seconds = Number(probe.stdout.trim())
  return seconds > 1e9 ? seconds * 1000 : null
}

/** Ask ffmpeg to finish the file; a capture that ignores the request is signaled. */
async function stopCapture(child) {
  if (child.exitCode !== null) return
  const exited = new Promise((r) => child.once('exit', r))
  child.stdin.write('q\n')
  const timer = setTimeout(() => child.kill('SIGINT'), 10_000)
  await exited
  clearTimeout(timer)
}

function stopProcess(child, signal) {
  if (child.exitCode !== null) return Promise.resolve()
  const exited = new Promise((r) => child.once('exit', r))
  child.kill(signal)
  return exited
}

// ---------------------------------------------------------------------------
// The terminal recording's clock
// ---------------------------------------------------------------------------

/**
 * VHS writes one PNG per captured frame into a temp directory and encodes
 * them at a fixed rate, so a frame it could not capture in time is simply
 * missing and the video runs ahead of the wall clock: by a few percent
 * when the loop keeps up, by more while a `Wait` polls the page every
 * 10 ms or the machine is busy booting the example. The driver counts the
 * frames at every tape command against the wall clock, and assembly maps
 * the video onto the wall clock piecewise between those anchors.
 */
function findVhsFramesDir(since) {
  const root = tmpdir()
  let found = null
  for (const name of readdirSync(root)) {
    if (!/^vhs\d+$/.test(name)) continue
    try {
      const { birthtimeMs } = statSync(join(root, name))
      if (birthtimeMs >= since - 1_000 && (!found || birthtimeMs > found.birthtimeMs)) {
        found = { dir: join(root, name), birthtimeMs }
      }
    } catch {
      // removed between the listing and the stat
    }
  }
  return found ? found.dir : null
}

function countFrames(dir) {
  try {
    return readdirSync(dir).filter((name) => name.startsWith('frame-text-')).length
  } catch {
    return 0
  }
}

/**
 * The tape's `Set Framerate`: VHS stamps every captured frame 1/framerate
 * apart whatever rate it actually achieved, so frames / framerate is the
 * video time of a frame. VHS's default is 50.
 */
function tapeFramerate(tape) {
  const match = /^Set Framerate (\d+)/m.exec(readFileSync(tape, 'utf8'))
  return match ? Number(match[1]) : 50
}

/**
 * A setpts expression that maps the terminal video's time onto wall-clock
 * seconds since the terminal recording started, piecewise linear between
 * the anchors; null when the take recorded no anchors.
 */
function terminalClock(timeline, fps) {
  const points = (timeline.anchors ?? []).map((a) => ({
    t: a.frames / fps,
    w: (a.at - timeline.terminalStartedAt) / 1000,
  }))
  if (points.length < 2) return null
  const last = points[points.length - 1]
  let expr = `${last.w.toFixed(3)}+(T-${last.t.toFixed(3)})`
  for (let i = points.length - 2; i >= 0; i -= 1) {
    const from = points[i]
    const to = points[i + 1]
    const slope = to.t > from.t ? (to.w - from.w) / (to.t - from.t) : 1
    expr = `if(lt(T,${to.t.toFixed(3)}),${from.w.toFixed(3)}+(T-${from.t.toFixed(3)})*${slope.toFixed(4)},${expr})`
  }
  return `setpts='(${expr})/TB'`
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

const escapeHtml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * Render each caption to a transparent PNG with a headless Chrome: a
 * boxed line of 30px Helvetica, wrapped inside `maxWidth`. The driver
 * cannot ask ffmpeg to draw text (the Homebrew bottle has no text filter),
 * and Chrome is already a prerequisite. One Chrome serves every caption.
 */
async function renderCaptions(captions) {
  const port = await freePort()
  const profile = mkdtempSync(join(tmpdir(), 'helio-demo-caption-'))
  const chrome = spawn(
    CHROME,
    [
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${String(port)}`,
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-scrollbars',
      '--window-size=2400,400',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )
  const sizes = {}
  let page
  try {
    page = await Dashboard.connect(port)
    await page.send('Emulation.setDefaultBackgroundColorOverride', {
      color: { r: 0, g: 0, b: 0, a: 0 },
    })
    for (const { text, maxWidth, file } of captions) {
      const html = `<!doctype html><html><body style="margin:0;background:transparent"><div id="caption" style="display:inline-block;max-width:${String(maxWidth)}px;font:30px Helvetica,sans-serif;line-height:1.3;color:#fff;background:rgba(0,0,0,0.55);padding:14px 20px;border-radius:6px">${escapeHtml(text)}</div></body></html>`
      await page.send('Page.navigate', {
        url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
      })
      await page.waitFor(`document.getElementById('caption') !== null`, 'the caption')
      const rect = JSON.parse(
        await page.evaluate(
          `JSON.stringify(document.getElementById('caption').getBoundingClientRect())`,
        ),
      )
      const { data } = await page.send('Page.captureScreenshot', {
        format: 'png',
        clip: {
          x: rect.x,
          y: rect.y,
          width: Math.ceil(rect.width),
          height: Math.ceil(rect.height),
          scale: 1,
        },
      })
      writeFileSync(file, Buffer.from(data, 'base64'))
      sizes[file] = { width: Math.ceil(rect.width), height: Math.ceil(rect.height) }
    }
  } finally {
    if (page) page.close()
    await stopProcess(chrome, 'SIGTERM')
    rmSync(profile, { recursive: true, force: true })
  }
  return sizes
}

/** An overlay of input `index` centered, `bottom` px above the frame's edge. */
function overlay(index, bottom, enable) {
  const base = `[${String(index)}:v]overlay=(W-w)/2:H-h-${String(bottom)}`
  return enable ? `${base}:enable='gte(t,${enable})'` : base
}

/** Space between the panes' edge and a caption, and between two captions. */
const CAPTION_GAP = 16
const CAPTION_STACK_GAP = 12

/** A black band below the panes, tall enough for the captions it carries. */
function band(...heights) {
  const total =
    CAPTION_GAP * 2 +
    heights.reduce((sum, h) => sum + h, 0) +
    CAPTION_STACK_GAP * (heights.length - 1)
  return total + (total % 2)
}

/**
 * Both panes resampled to a constant 30 fps, trimmed so the terminal's
 * `date -u` line and the dashboard agree, stacked side by side, captioned
 * on a band below the panes so no caption covers a card, written as an
 * mp4 and a palette GIF. The timeline file records the trims used, so a
 * re-run with --assemble can adjust them without a retake.
 */
async function assemble(name, recording, timeline) {
  const terminal = join(OUT_DIR, `${name}-terminal.mp4`)
  const dashboard = join(OUT_DIR, `${name}-dashboard.mov`)
  const captionFile = join(OUT_DIR, `${name}-caption.png`)
  const gifCaptionFile = join(OUT_DIR, `${name}-caption-gif.png`)
  const restartFile = join(OUT_DIR, `${name}-caption-restart.png`)
  const paneWidths = PANE_HEIGHT * (1000 / 800 + WINDOW.width / WINDOW.height)
  const captions = [
    { text: recording.caption, maxWidth: Math.floor(paneWidths * 0.9), file: captionFile },
    { text: recording.caption, maxWidth: recording.gifWidth - 40, file: gifCaptionFile },
  ]
  const restartAt =
    recording.restartCaption && timeline.cues.restart
      ? Math.max(
          0,
          (timeline.cues.restart - timeline.terminalStartedAt) / 1000 - timeline.trimTerminal,
        )
      : null
  if (restartAt !== null) {
    captions.push({ text: recording.restartCaption, maxWidth: paneWidths, file: restartFile })
  }
  const sizes = await renderCaptions(captions)

  const mainHeight = sizes[captionFile].height
  const stackHeights = restartAt !== null ? [mainHeight, sizes[restartFile].height] : [mainHeight]
  const framerate = tapeFramerate(join(DEMO_DIR, recording.tape))
  const clock = terminalClock(timeline, framerate)
  // The cut ends with the terminal recording; the dashboard capture runs on
  // into the driver's own teardown.
  const lastAnchor = timeline.anchors[timeline.anchors.length - 1]
  const cutLength = lastAnchor
    ? (lastAnchor.at - timeline.terminalStartedAt) / 1000 - timeline.trimTerminal
    : 300
  if (clock) {
    const first = timeline.anchors[0]
    const last = timeline.anchors[timeline.anchors.length - 1]
    console.log(
      `terminal clock: ${((last.frames - first.frames) / framerate).toFixed(2)} s of video over ${((last.at - first.at) / 1000).toFixed(2)} s of wall clock, re-timed through ${String(timeline.anchors.length)} anchors`,
    )
  }
  // The dashboard capture carries wall-clock stamps; rebase, then trim.
  const dashboardTrim = `setpts=PTS-STARTPTS,trim=start=${timeline.trimDashboard.toFixed(2)}:duration=${cutLength.toFixed(2)},setpts=PTS-STARTPTS`
  const terminalChain = [
    clock,
    'fps=30',
    `trim=start=${timeline.trimTerminal.toFixed(2)}`,
    'setpts=PTS-STARTPTS',
    `scale=-2:${String(PANE_HEIGHT)}`,
  ]
    .filter(Boolean)
    .join(',')
  const filters = [
    `[0:v]${terminalChain}[t]`,
    `[1:v]${dashboardTrim},fps=30,scale=-2:${String(PANE_HEIGHT)}[d]`,
    `[t][d]hstack=inputs=2:shortest=1,pad=iw:ih+${String(band(...stackHeights))}:0:0:black[s]`,
  ]
  const inputs = ['-i', captionFile]
  if (restartAt !== null) {
    inputs.push('-i', restartFile)
    filters.push(
      `[s]${overlay(2, CAPTION_GAP)}[c]`,
      `[c]${overlay(3, CAPTION_GAP + mainHeight + CAPTION_STACK_GAP, restartAt.toFixed(2))}[v]`,
    )
  } else {
    filters.push(`[s]${overlay(2, CAPTION_GAP)}[v]`)
  }
  const mp4 = join(OUT_DIR, `${name}.mp4`)
  ffmpeg([
    '-i',
    terminal,
    '-i',
    dashboard,
    ...inputs,
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
      '-i',
      dashboard,
      '-i',
      gifCaptionFile,
      '-filter_complex',
      `[0:v]${dashboardTrim},fps=12,scale=${String(recording.gifWidth)}:-1:flags=lanczos,pad=iw:ih+${String(band(sizes[gifCaptionFile].height))}:0:0:black[d];[d]${overlay(1, CAPTION_GAP)},${palette}`,
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
  selfTest()
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
    terminalStartedAt: 0,
    captureStartedAt: 0,
    anchors: [],
    window: null,
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
    if (capture) await stopCapture(capture.child)
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
    await dash.setWindowBounds(WINDOW)
    await sleep(500)
    const bounds = await dash.windowBounds()
    const scale = await dash.evaluate('window.devicePixelRatio')
    const viewport = JSON.parse(await dash.evaluate('JSON.stringify({ innerWidth, innerHeight })'))
    const display = JSON.parse(
      await dash.evaluate('JSON.stringify({ width: screen.width, height: screen.height })'),
    )
    timeline.window = { bounds, scale, viewport, display }
    if (bounds.left + bounds.width > display.width || bounds.top + bounds.height > display.height) {
      throw new Error(
        `the ${String(WINDOW.width)}x${String(WINDOW.height)} app window at ${String(WINDOW.left)},${String(WINDOW.top)} does not fit the ${String(display.width)}x${String(display.height)} display`,
      )
    }
    if (
      bounds.width !== WINDOW.width ||
      bounds.height !== WINDOW.height ||
      viewport.innerWidth !== WINDOW.width ||
      viewport.innerHeight > WINDOW.height
    ) {
      throw new Error(
        `the app window is ${JSON.stringify(bounds)} with a ${JSON.stringify(viewport)} viewport, not the ${String(WINDOW.width)}x${String(WINDOW.height)} the capture expects`,
      )
    }

    // Make the app window the active one with a click on its title bar, then
    // park the real pointer below the window, outside the capture, so the
    // take opens without a pointer and the first cue brings it in.
    moveTo({ x: bounds.left + bounds.width / 2, y: bounds.top + 14 }, 300)
    click()
    const park = { x: bounds.left + bounds.width - 80, y: bounds.top + bounds.height + 60 }
    moveTo(park, 400)
    const pointer = pointerPosition()
    const inside =
      pointer.x >= bounds.left &&
      pointer.x <= bounds.left + bounds.width &&
      pointer.y >= bounds.top &&
      pointer.y <= bounds.top + bounds.height
    if (inside) {
      throw new Error(`the pointer is still over the window at ${JSON.stringify(pointer)}`)
    }
    timeline.window.pointerParkedAt = pointer

    capture = startCapture(bounds, scale, join(OUT_DIR, `${name}-dashboard.mov`))
    timeline.captureStartedAt = await capture.started
    await sleep(1_000)

    stopWatching = watchCues(
      {
        approve: async () => {
          timeline.approveScroll = await dash.approvePending({ readMs: READ_MS })
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
      stdio: ['inherit', 'pipe', 'inherit'],
      env: process.env,
    })
    // VHS echoes each tape command as it runs it; the terminal recording
    // begins with the first command after the Set lines, not at the spawn.
    // VHS echoes each tape command as it runs it. Every echo is an anchor
    // (wall clock against VHS's frame count), and a sampler keeps the last
    // moment the count grew, which is where the recording ended.
    let framesDir = null
    let pending = ''
    let lastGrowth = null
    const anchor = (mark) => {
      framesDir ??= findVhsFramesDir(timeline.vhsStartedAt)
      if (!framesDir) return
      const frames = countFrames(framesDir)
      timeline.anchors.push({ mark, at: Date.now(), frames })
      if (!lastGrowth || frames > lastGrowth.frames) lastGrowth = { at: Date.now(), frames }
    }
    const sampler = setInterval(() => {
      if (!framesDir) return
      const frames = countFrames(framesDir)
      if (!lastGrowth || frames > lastGrowth.frames) lastGrowth = { at: Date.now(), frames }
    }, 200)
    vhs.stdout.on('data', (chunk) => {
      const text = String(chunk)
      process.stdout.write(text)
      pending += text
      const lines = pending.split('\n')
      pending = lines.pop()
      for (const line of lines) {
        const command =
          /^(Type|Enter|Sleep|Wait|Hide|Show|Ctrl|Backspace|Tab|Space|Up|Down|Left|Right|PageUp|PageDown|Escape|Copy|Paste|Screenshot)\b/.exec(
            line,
          )
        if (!command) continue
        if (timeline.terminalStartedAt === 0) timeline.terminalStartedAt = Date.now()
        anchor(command[1])
      }
    })
    vhs.once('exit', () => {
      clearInterval(sampler)
      if (lastGrowth) timeline.anchors.push({ mark: 'end', ...lastGrowth })
    })
    const code = await new Promise((r) => vhs.once('exit', r))
    if (code !== 0) throw new Error(`vhs exited ${String(code)}`)
  } finally {
    await cleanup()
  }
  if (timeline.failedCues.length > 0) {
    throw new Error(`the take is not usable: cue ${timeline.failedCues.join(', ')} failed`)
  }
  if (timeline.anchors.length < 2) {
    throw new Error(
      "the take is not usable: VHS's frame directory was not found, so the terminal pane cannot be re-timed to the wall clock",
    )
  }
  if (timeline.terminalStartedAt === 0) timeline.terminalStartedAt = timeline.vhsStartedAt
  // The progress-block estimate lags by the encoder's latency; the file's
  // own start_time is exact.
  timeline.captureStartedAt =
    captureStart(join(OUT_DIR, `${name}-dashboard.mov`)) ?? timeline.captureStartedAt

  timeline.trimTerminal = options.trimTerminal ?? 0
  timeline.trimDashboard =
    options.trimDashboard ??
    Math.max(0, (timeline.terminalStartedAt - timeline.captureStartedAt) / 1000)
  writeFileSync(join(OUT_DIR, `${name}-timeline.json`), JSON.stringify(timeline, null, 2) + '\n')
  await assemble(name, recording, timeline)
}

async function reassemble(name, recording, options) {
  const file = join(OUT_DIR, `${name}-timeline.json`)
  if (!existsSync(file)) {
    console.error(`${file} is missing: record first`)
    process.exit(1)
  }
  const timeline = JSON.parse(readFileSync(file, 'utf8'))
  if (options.trimTerminal !== undefined) timeline.trimTerminal = options.trimTerminal
  if (options.trimDashboard !== undefined) timeline.trimDashboard = options.trimDashboard
  writeFileSync(file, JSON.stringify(timeline, null, 2) + '\n')
  await assemble(name, recording, timeline)
}

const { name, recording, options } = parseArgs(process.argv.slice(2))
loadEnv()
if (options.assemble) await reassemble(name, recording, options)
else await record(name, recording, options)
