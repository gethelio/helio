/**
 * Move the real mouse pointer and click with it, so the recording shows a
 * hand on the dashboard rather than buttons that press themselves.
 *
 * Runs short JavaScript-for-Automation scripts through macOS's own
 * `osascript`, which can post mouse events through the Core Graphics
 * bridge: no package dependency. Posting events needs Accessibility
 * permission for the terminal that runs the driver (System Settings,
 * Privacy & Security, Accessibility); `selfTest` says so when it is
 * missing. Coordinates are screen points with the origin at the top-left
 * of the main display, as Chrome reports its window bounds.
 */

import { spawnSync } from 'node:child_process'

const EVENT = { leftDown: 1, leftUp: 2, moved: 5, scroll: 22 }
const HID_TAP = 0
const SCROLL_PIXELS = 0

function jxa(script) {
  const result = spawnSync('osascript', ['-l', 'JavaScript', '-e', script], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`osascript failed: ${result.stderr.trim()}`)
  return result.stdout.trim()
}

const point = ({ x, y }) => `$.CGPointMake(${String(Math.round(x))}, ${String(Math.round(y))})`

/** Where the pointer is now. */
export function pointerPosition() {
  return JSON.parse(
    jxa(
      `ObjC.import('CoreGraphics'); const p = $.CGEventGetLocation($.CGEventCreate(null)); JSON.stringify({ x: p.x, y: p.y })`,
    ),
  )
}

/**
 * Glide the pointer to `to` over `ms` milliseconds with an ease-in-out
 * curve, posting a move event every frame so the screen shows it.
 */
export function moveTo(to, ms = 700) {
  const from = pointerPosition()
  const steps = Math.max(1, Math.round(ms / 16))
  jxa(`ObjC.import('CoreGraphics');
    const from = ${point(from)}, to = ${point(to)}, steps = ${String(steps)};
    for (let i = 1; i <= steps; i++) {
      const t = i / steps, e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const p = $.CGPointMake(from.x + (to.x - from.x) * e, from.y + (to.y - from.y) * e);
      $.CGEventPost(${String(HID_TAP)}, $.CGEventCreateMouseEvent(null, ${String(EVENT.moved)}, p, 0));
      delay(0.016);
    }`)
}

/** Press and release the left button where the pointer is. */
export function click() {
  const at = pointerPosition()
  jxa(`ObjC.import('CoreGraphics');
    const p = ${point(at)};
    $.CGEventPost(${String(HID_TAP)}, $.CGEventCreateMouseEvent(null, ${String(EVENT.leftDown)}, p, 0));
    delay(0.08);
    $.CGEventPost(${String(HID_TAP)}, $.CGEventCreateMouseEvent(null, ${String(EVENT.leftUp)}, p, 0));`)
}

/** Scroll the content under the pointer by `pixels` (positive scrolls down), in small ticks. */
export function scroll(pixels, ms = 500) {
  const ticks = Math.max(1, Math.round(ms / 25))
  const perTick = Math.round(pixels / ticks)
  jxa(`ObjC.import('CoreGraphics');
    for (let i = 0; i < ${String(ticks)}; i++) {
      $.CGEventPost(${String(HID_TAP)}, $.CGEventCreateScrollWheelEvent2(null, ${String(SCROLL_PIXELS)}, 1, ${String(-perTick)}, 0, 0));
      delay(0.025);
    }`)
}

/**
 * Prove that posted events reach the screen: nudge the pointer by one
 * point and read it back. A pointer that did not move means macOS dropped
 * the event, which it does without Accessibility permission.
 */
export function selfTest() {
  // Three tries: a hand on the mouse during one of them is not a missing
  // permission.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = pointerPosition()
    const target = { x: before.x + 2, y: before.y + 2 }
    moveTo(target, 32)
    const after = pointerPosition()
    if (
      Math.round(after.x) === Math.round(target.x) &&
      Math.round(after.y) === Math.round(target.y)
    ) {
      return
    }
  }
  throw new Error(
    'mouse events are not reaching the screen: grant Accessibility to the terminal running this script (System Settings, Privacy & Security, Accessibility), leave the mouse alone, and run again',
  )
}
