import { isCliFailure } from "../errors/failures.js"
import type { MessengerAdapter } from "../ports/messenger.js"
import type { EventSink } from "../runs/events.js"

export interface SessionOptions {
  /** Close the connection after this long without a call. */
  idleMs?: number
  /** Connect again after this long, whatever the traffic, so a long agent session never reads a stale snapshot. */
  maxAgeMs?: number
  now?: () => number
}

/** The caller's mistake, not the connection's — nothing about the socket is in doubt after these. */
const HARMLESS = new Set(["validation_error", "not_found", "permission_error", "confirmation_required", "rate_limited"])

/** Opens a connection whose run events go to `events`, and says how to close it and what it opened. */
export type Open = (events: EventSink) => Promise<{ adapter: MessengerAdapter; close: () => Promise<void> }>

/** One call, recorded as its own run under `name`. */
export type Run = <T>(name: string, body: (events: EventSink) => Promise<T>) => Promise<T>

interface Held {
  adapter: MessengerAdapter
  close: () => Promise<void>
  openedAt: number
}

/**
 * **One connection for the whole agent session, and never for long** — max-cli's `MaxSession`
 * (its `NEED-152`), over any messenger.
 *
 * A command connects once and exits. Here the process outlives the call, so the connection is kept
 * between calls — and dropped after `idleMs` of quiet, after `maxAgeMs` whatever the traffic, and
 * after any failure that may have been the connection's.
 *
 * Calls run **one at a time**. A client may send read-only calls in parallel, and one connection is
 * not the place to find out whether the messenger minds.
 */
export class MessengerSession {
  readonly #open: Open
  readonly #run: Run
  readonly #idleMs: number
  readonly #maxAgeMs: number
  readonly #now: () => number
  #held: Held | undefined
  #idle: NodeJS.Timeout | undefined
  #queue: Promise<unknown> = Promise.resolve()
  #events: EventSink = () => {}
  #closed = false

  constructor(open: Open, run: Run, { idleMs = 120_000, maxAgeMs = 300_000, now = Date.now }: SessionOptions = {}) {
    this.#open = open
    this.#run = run
    this.#idleMs = idleMs
    this.#maxAgeMs = maxAgeMs
    this.#now = now
  }

  use<T>(name: string, body: (adapter: MessengerAdapter, release: () => Promise<void>) => Promise<T>): Promise<T> {
    const turn = this.#queue.then(() => this.#call(name, body))
    this.#queue = turn.catch(() => {})
    return turn
  }

  async close(): Promise<void> {
    this.#closed = true
    await this.#queue
    await this.#release()
  }

  async #call<T>(
    name: string,
    body: (adapter: MessengerAdapter, release: () => Promise<void>) => Promise<T>,
  ): Promise<T> {
    if (this.#closed) throw new Error("the MCP server is shutting down")
    clearTimeout(this.#idle)

    try {
      return await this.#run(name, async (events) => {
        this.#events = events
        return body(await this.#hold(), () => this.#release())
      })
    } catch (error) {
      if (!(isCliFailure(error) && HARMLESS.has(error.code))) await this.#release()
      throw error
    } finally {
      this.#events = () => {}
      if (this.#held) {
        this.#idle = setTimeout(() => void this.#release(), this.#idleMs)
        this.#idle.unref()
      }
    }
  }

  async #hold(): Promise<MessengerAdapter> {
    if (this.#held && this.#now() - this.#held.openedAt >= this.#maxAgeMs) await this.#release()
    if (this.#held) return this.#held.adapter
    const { adapter, close } = await this.#open((event) => this.#events(event))
    this.#held = { adapter, close, openedAt: this.#now() }
    return adapter
  }

  async #release(): Promise<void> {
    clearTimeout(this.#idle)
    const held = this.#held
    this.#held = undefined
    await held?.close()
  }
}
