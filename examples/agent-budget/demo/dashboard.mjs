/**
 * Drive the dashboard window that record.mjs launched.
 *
 * Speaks the Chrome DevTools Protocol over Node's global WebSocket, so the
 * recording pipeline adds no package dependency. The driver fills the
 * dashboard secret into the login form (a password field, so the fill
 * stays masked on screen), moves between pages through the sidebar's own
 * links, expands the one pending ticket and clicks its Approve button, and
 * opens a pot's Recent events panel. Every click is the page's own
 * control, so the page supplies its own CSRF header and the recording shows
 * what a human would see.
 */

import { click, moveTo, scroll } from './pointer.mjs'

const EVALUATE_TIMEOUT_MS = 15_000
const POLL_MS = 150
const GLIDE_MS = 700

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** One page target of a Chrome started with --remote-debugging-port. */
export class Dashboard {
  /** @param {WebSocket} socket @param {string} targetId */
  constructor(socket, targetId) {
    this.socket = socket
    this.targetId = targetId
    this.nextId = 1
    this.pending = new Map()
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data))
      if (message.id === undefined) return
      const waiter = this.pending.get(message.id)
      if (!waiter) return
      this.pending.delete(message.id)
      if (message.error) waiter.reject(new Error(message.error.message))
      else waiter.resolve(message.result)
    })
  }

  /**
   * Attach to the first page target of the Chrome listening on `port`.
   * Polls the /json listing until the app window has loaded its page.
   */
  static async connect(port) {
    const deadline = Date.now() + EVALUATE_TIMEOUT_MS
    for (;;) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json`)
        const targets = await res.json()
        const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
        if (page) {
          const socket = new WebSocket(page.webSocketDebuggerUrl)
          await new Promise((resolve, reject) => {
            socket.addEventListener('open', resolve, { once: true })
            socket.addEventListener('error', () => reject(new Error('CDP socket failed')), {
              once: true,
            })
          })
          const dashboard = new Dashboard(socket, page.id)
          await dashboard.send('Runtime.enable')
          await dashboard.send('Page.enable')
          return dashboard
        }
      } catch {
        // Chrome is still starting
      }
      if (Date.now() > deadline) throw new Error(`no page target on port ${String(port)}`)
      await sleep(POLL_MS)
    }
  }

  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  /** Evaluate an expression in the page and return its value. */
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? 'page script threw')
    }
    return result.result.value
  }

  /** Poll an expression until it is truthy. */
  async waitFor(expression, label) {
    const deadline = Date.now() + EVALUATE_TIMEOUT_MS
    for (;;) {
      if (await this.evaluate(expression)) return
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
      await sleep(POLL_MS)
    }
  }

  /** The app window's screen rectangle, in points, for the screen capture's crop. */
  async windowBounds() {
    const { bounds } = await this.send('Browser.getWindowForTarget', { targetId: this.targetId })
    return bounds
  }

  /**
   * Put the app window where the recording expects it. Chrome does not
   * always honor --window-size for a fresh profile (it sometimes opens the
   * window at the screen's full height), and a window taller than the
   * capture loses its bottom edge.
   */
  async setWindowBounds({ left, top, width, height }) {
    const { windowId } = await this.send('Browser.getWindowForTarget', { targetId: this.targetId })
    await this.send('Browser.setWindowBounds', {
      windowId,
      bounds: { left, top, width, height, windowState: 'normal' },
    })
  }

  bringToFront() {
    return this.send('Page.bringToFront')
  }

  /**
   * The screen point at the center of the element `expr` evaluates to:
   * its page rectangle, offset by the window's placement and the height of
   * the window's own title bar.
   */
  async screenPoint(expr, label) {
    await this.waitFor(`!!${expr}`, label)
    const rect = JSON.parse(
      await this.evaluate(`JSON.stringify((${expr}).getBoundingClientRect())`),
    )
    const { bounds } = await this.send('Browser.getWindowForTarget', { targetId: this.targetId })
    const { innerHeight } = JSON.parse(await this.evaluate('JSON.stringify({ innerHeight })'))
    return {
      x: bounds.left + rect.x + rect.width / 2,
      y: bounds.top + (bounds.height - innerHeight) + rect.y + rect.height / 2,
    }
  }

  /** Glide the real pointer onto an element and click it. */
  async pointAndClick(expr, label) {
    moveTo(await this.screenPoint(expr, label), GLIDE_MS)
    await sleep(150)
    click()
  }

  /**
   * Scroll the element under the pointer to its end with the wheel, and
   * report how far it moved so the timeline shows the wheel reached it.
   */
  async wheelToEnd(expr, label) {
    moveTo(await this.screenPoint(expr, label), GLIDE_MS)
    const extent = JSON.parse(
      await this.evaluate(
        `(() => { const e = ${expr}; return JSON.stringify({ before: e.scrollTop, max: e.scrollHeight - e.clientHeight }) })()`,
      ),
    )
    if (extent.max > 0) scroll(extent.max + 40)
    await sleep(300)
    const after = await this.evaluate(`(${expr}).scrollTop`)
    return { ...extent, after }
  }

  /**
   * Fill the secret into the login form and submit it. The value is set
   * through the native setter and an input event so React sees the change.
   */
  async login(secret) {
    await this.waitFor(`!!document.querySelector('#dashboard-secret')`, 'the login form')
    await this.evaluate(`(() => {
      const input = document.querySelector('#dashboard-secret')
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      set.call(input, ${JSON.stringify(secret)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.form.requestSubmit()
      return true
    })()`)
    await this.waitFor(`!document.querySelector('#dashboard-secret')`, 'the login to complete')
  }

  /** Click the sidebar link to `path` with the real pointer. */
  async go(path) {
    const link = `document.querySelector(${JSON.stringify(`a[href="${path}"]`)})`
    await this.pointAndClick(link, `the ${path} link`)
    await this.waitFor(`location.pathname === ${JSON.stringify(path)}`, `the ${path} page`)
  }

  /**
   * On the Approvals page: click the one pending ticket open, hold it on
   * screen long enough to read, wheel through the arguments and down to
   * the Approve button, click it, and wait for the ticket to leave the
   * pending list. Every step is the real pointer on the page's own
   * controls; the waits confirm each click landed.
   */
  async approvePending({ readMs }) {
    await this.go('/approvals')
    const row = `[...document.querySelectorAll('main button')].find((b) => b.className.includes('w-full') && b.querySelector('svg'))`
    await this.pointAndClick(row, 'the pending ticket')
    const approve = `[...document.querySelectorAll('main button')].find((b) => b.textContent.trim() === 'Approve')`
    await this.waitFor(`!!${approve}`, 'the Approve button')
    // Read with the pointer out of the way, in the empty sidebar below its
    // last link, so the card is unobstructed on screen.
    const aside = await this.screenPoint(
      `document.querySelector('a[href="/analytics"]')`,
      'the sidebar',
    )
    moveTo({ x: aside.x, y: aside.y + 140 }, GLIDE_MS)
    await sleep(readMs / 2)
    const input = await this.wheelToEnd(`document.querySelector('main pre')`, 'the Input box')
    await sleep(readMs / 2)
    const list = await this.wheelToEnd(
      `${approve}.closest('main .overflow-y-auto')`,
      'the pending list',
    )
    await this.pointAndClick(approve, 'the Approve button')
    await this.waitFor(`!${approve}`, 'the ticket to resolve')
    return { input, list }
  }

  /** On the Budgets page: click the first pot's Recent events open. */
  async expandRecentEvents() {
    const button = `[...document.querySelectorAll('main button')].find((b) => b.textContent.trim() === 'Recent events')`
    await this.pointAndClick(button, 'the Recent events button')
    await this.waitFor(
      `[...document.querySelectorAll('main button')].some((b) => b.textContent.trim() === 'Hide recent events')`,
      'the events panel',
    )
  }

  close() {
    this.socket.close()
  }
}
