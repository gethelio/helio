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

const EVALUATE_TIMEOUT_MS = 15_000
const POLL_MS = 150

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

  /** The app window's screen rectangle, for screencapture -R. */
  async windowBounds() {
    const { bounds } = await this.send('Browser.getWindowForTarget', { targetId: this.targetId })
    return bounds
  }

  bringToFront() {
    return this.send('Page.bringToFront')
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

  /** Follow the sidebar link to `path` without a page reload. */
  async go(path) {
    const link = JSON.stringify(`a[href="${path}"]`)
    await this.waitFor(`!!document.querySelector(${link})`, `the ${path} link`)
    await this.evaluate(`(document.querySelector(${link}).click(), true)`)
    await this.waitFor(`location.pathname === ${JSON.stringify(path)}`, `the ${path} page`)
  }

  /**
   * On the Approvals page: expand the one pending ticket, hold it on screen
   * long enough to read, then click its Approve button and wait for the
   * ticket to leave the pending list.
   */
  async approvePending({ readMs }) {
    await this.go('/approvals')
    const row = `[...document.querySelectorAll('main button')].find((b) => b.className.includes('w-full') && b.querySelector('svg'))`
    await this.waitFor(`!!${row}`, 'the pending ticket')
    await this.evaluate(`(${row}.click(), true)`)
    const approve = `[...document.querySelectorAll('main button')].find((b) => b.textContent.trim() === 'Approve')`
    await this.waitFor(`!!${approve}`, 'the Approve button')
    await sleep(readMs)
    await this.evaluate(`(${approve}.click(), true)`)
    await this.waitFor(`!${approve}`, 'the ticket to resolve')
  }

  /** On the Budgets page: open the first pot's Recent events panel. */
  async expandRecentEvents() {
    const button = `[...document.querySelectorAll('main button')].find((b) => b.textContent.trim() === 'Recent events')`
    await this.waitFor(`!!${button}`, 'the Recent events button')
    await this.evaluate(`(${button}.click(), true)`)
    await this.waitFor(
      `[...document.querySelectorAll('main button')].some((b) => b.textContent.trim() === 'Hide recent events')`,
      'the events panel',
    )
  }

  close() {
    this.socket.close()
  }
}
