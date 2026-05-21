import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { PendingRequests } from '../mcp/pending-requests.js'
import type {
  McpForwarder,
  McpRequest,
  McpResponse,
  ForwardResult,
  JsonRpcResponse,
} from '../mcp/types.js'

const DEFAULT_MAX_RETRIES = 3
const DEFAULT_RETRY_DELAY_MS = 1000
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const KILL_TIMEOUT_MS = 5000

/** Options for constructing a StdioForwarder. */
export interface StdioForwarderOptions {
  /** The command to spawn (e.g. "node", "python"). */
  command: string
  /** Arguments to pass to the command. */
  args?: string[]
  /** Maximum number of auto-restart attempts on crash. */
  maxRetries?: number
  /** Delay in milliseconds between restart attempts. */
  retryDelayMs?: number
  /** Timeout in milliseconds for individual requests. */
  requestTimeoutMs?: number
}

/**
 * Forward MCP requests to an upstream server via stdio.
 *
 * Spawns a child process and communicates using newline-delimited
 * JSON-RPC on stdin/stdout.
 */
export class StdioForwarder implements McpForwarder {
  private readonly command: string
  private readonly args: string[]
  private readonly maxRetries: number
  private readonly retryDelayMs: number
  private readonly pending: PendingRequests

  private child: ChildProcess | null = null
  private buffer = ''
  private retryCount = 0
  private dead = false
  private closing = false

  constructor(options: StdioForwarderOptions) {
    this.command = options.command
    this.args = options.args ?? []
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
    this.pending = new PendingRequests(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)
  }

  /** Spawn the child process and set up event handlers. */
  start(): Promise<void> {
    this.buffer = ''
    return new Promise<void>((resolve, reject) => {
      const child = spawn(this.command, this.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      this.child = child

      child.stdout.on('data', (chunk: Buffer) => {
        this.onData(chunk.toString('utf-8'))
      })

      child.on('spawn', () => {
        this.retryCount = 0
        resolve()
      })

      child.on('error', (err: Error) => {
        reject(err)
      })

      child.on('close', () => {
        this.child = null
        if (!this.closing) {
          this.onUnexpectedExit()
        }
      })
    })
  }

  async forward(request: McpRequest): Promise<ForwardResult> {
    if (this.dead) {
      throw new Error('stdio forwarder is dead (max retries exceeded)')
    }
    const stdin = this.child?.stdin
    if (!stdin) {
      throw new Error('stdio forwarder not started')
    }

    // Build clean JSON-RPC body (strip MCP-level fields)
    const body: Record<string, unknown> = {
      jsonrpc: request.jsonrpc,
      method: request.method,
    }
    if (request.id !== undefined) body['id'] = request.id
    if (request.params !== undefined) body['params'] = request.params

    const line = JSON.stringify(body) + '\n'

    // Notifications (missing id) — fire and forget
    if (request.id === undefined) {
      const start = performance.now()
      stdin.write(line)
      const durationMs = performance.now() - start
      const response: McpResponse = {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: { jsonrpc: '2.0' },
      }
      return { response, durationMs }
    }

    const start = performance.now()
    const responsePromise = this.pending.add(request.id)
    stdin.write(line)

    const jsonRpcResponse = await responsePromise
    const durationMs = performance.now() - start

    const response: McpResponse = {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: jsonRpcResponse,
    }
    return { response, durationMs }
  }

  /** Gracefully close the child process. */
  close(): Promise<void> {
    this.closing = true
    this.pending.rejectAll(new Error('forwarder closing'))

    const child = this.child
    if (!child) {
      return Promise.resolve()
    }

    return new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        child.kill('SIGKILL')
      }, KILL_TIMEOUT_MS)
      killTimer.unref()

      child.on('close', () => {
        clearTimeout(killTimer)
        this.child = null
        resolve()
      })

      child.kill('SIGTERM')
    })
  }

  /** Handle incoming data from child stdout, buffering partial lines. */
  private onData(chunk: string): void {
    this.buffer += chunk
    const lines = this.buffer.split('\n')
    // Keep the last element — it's either an incomplete line or an empty string
    this.buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (line.trim().length === 0) continue
      this.onLine(line)
    }
  }

  /** Process a complete line from stdout. */
  private onLine(line: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      // Non-JSON output from child — ignore
      return
    }

    if (parsed === null || typeof parsed !== 'object') return

    const obj = parsed as Record<string, unknown>
    const id = obj['id']
    if (id === undefined) {
      // Notification from server — discard
      return
    }

    if (typeof id === 'string' || typeof id === 'number' || id === null) {
      this.pending.resolve(id, parsed as JsonRpcResponse)
    }
  }

  /** Handle unexpected child process exit (crash). */
  private onUnexpectedExit(): void {
    this.retryCount++
    if (this.retryCount <= this.maxRetries) {
      setTimeout(() => {
        if (!this.closing) {
          this.start().catch(() => {
            this.dead = true
            this.pending.rejectAll(new Error('stdio forwarder restart failed'))
          })
        }
      }, this.retryDelayMs)
    } else {
      this.dead = true
      // eslint-disable-next-line no-console -- operational error logging
      console.error(`[helio] Stdio forwarder: max retries (${String(this.maxRetries)}) exceeded`)
      this.pending.rejectAll(new Error('stdio forwarder is dead (max retries exceeded)'))
    }
  }
}
