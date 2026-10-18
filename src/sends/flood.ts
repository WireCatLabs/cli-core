import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { resolvePaths } from "@wirecat/cli-base"
import type { AppIdentity } from "../ports/app.js"

/** "The messenger said: do not ask for this again before `until`." */
export interface FloodDeadline {
  /** The adapter call it was said about, as a run event names it: `history`, `send`. */
  operation: string
  /** Only when the call named a chat by id — never a typed name, which can be a title. */
  chatId?: string
  until: string
  providerError?: string
}

/** The account was told to stop writing — frozen, limited for spam, or banned. Reads still work. */
export interface SendBlock {
  state: "frozen" | "limited" | "banned"
  since: string
  /** `null`: no end is known, and the hold lasts until `flood clear` or a `doctor --online` that finds the account well. */
  until: string | null
  hint: string
}

export interface FloodState {
  deadlines: FloodDeadline[]
  sendBlock?: SendBlock
}

/** A process that hits more distinct waits than this is misbehaving anyway; the soonest are dropped. */
const MOST_DEADLINES = 50
/**
 * How long a hold lasts when the messenger gave no end. A spam limit (`limited`) never says when it
 * ends, so an hour: at most one refused write an hour, and each new refusal sets the hour again. A
 * frozen account's refusal carries no date either; a day, until `doctor --online` reads the real one.
 */
export const LIMITED_HOLD_MS = 60 * 60 * 1000
export const FROZEN_HOLD_MS = 24 * 60 * 60 * 1000

/** "until 2026-…", or "until lifted" for a hold with no known end. */
export const holdEnd = (block: Pick<SendBlock, "until">, show: (iso: string) => string = (iso) => iso): string =>
  block.until === null ? "until lifted" : `until ${show(block.until)}`

/** `<state dir>/flood/<profile>.json`, beside `sends/`. */
export const floodPathFor = (app: AppIdentity, profile: string, env: NodeJS.ProcessEnv = process.env): string =>
  join(resolvePaths({ appName: app.appName, prefix: app.envPrefix, env }).state, "flood", `${profile}.json`)

/**
 * What a messenger asked one profile to wait for, kept across processes so the next command fails
 * fast instead of asking again — asking during a wait is how a short wait becomes a long one. No
 * lock: two processes writing at once lose one entry, which costs one more refusal, not a send.
 */
export class FloodMemory {
  constructor(
    readonly path: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** What is still in force; anything expired is left out. */
  read(): FloodState {
    const now = this.now()
    let raw: Partial<FloodState>
    try {
      raw = JSON.parse(readFileSync(this.path, "utf8")) as Partial<FloodState>
    } catch {
      return { deadlines: [] }
    }
    const alive = (until: unknown) => typeof until === "string" && Date.parse(until) > now
    const deadlines = Array.isArray(raw.deadlines)
      ? raw.deadlines.filter((one) => typeof one?.operation === "string" && alive(one.until))
      : []
    const block = raw.sendBlock
    const held = block && (block.until === null || alive(block.until))
    return { deadlines, ...(held ? { sendBlock: block } : {}) }
  }

  /** The deadline this call is still under: one for its chat, or one for the call in every chat. */
  owed(operation: string, chatId?: string): FloodDeadline | undefined {
    return this.read()
      .deadlines.filter((one) => one.operation === operation && (one.chatId === undefined || one.chatId === chatId))
      .sort((a, b) => b.until.localeCompare(a.until))[0]
  }

  remember(deadline: Omit<FloodDeadline, "until"> & { waitMs: number }): FloodDeadline {
    const { waitMs, ...rest } = deadline
    const kept: FloodDeadline = { ...rest, until: new Date(this.now() + waitMs).toISOString() }
    const state = this.read()
    const others = state.deadlines.filter((one) => one.operation !== kept.operation || one.chatId !== kept.chatId)
    const deadlines = [...others, kept].sort((a, b) => b.until.localeCompare(a.until)).slice(0, MOST_DEADLINES)
    this.#write({ ...state, deadlines })
    return kept
  }

  sendBlock(): SendBlock | undefined {
    return this.read().sendBlock
  }

  /** A ban the messenger gave no end for holds until lifted; a spam limit or a freeze without one, for a while. */
  block(block: Omit<SendBlock, "since" | "until"> & { until?: string }): SendBlock {
    const now = this.now()
    const holdMs = { limited: LIMITED_HOLD_MS, frozen: FROZEN_HOLD_MS, banned: undefined }[block.state]
    const kept: SendBlock = {
      ...block,
      since: new Date(now).toISOString(),
      until: block.until ?? (holdMs === undefined ? null : new Date(now + holdMs).toISOString()),
    }
    this.#write({ ...this.read(), sendBlock: kept })
    return kept
  }

  /** Lifts only a block of this state: an account found not frozen may still be limited for spam. */
  unblock(state: SendBlock["state"]): void {
    const { sendBlock, ...rest } = this.read()
    if (sendBlock?.state === state) this.#write(rest)
  }

  /** Forgets every wait and lifts the hold, and answers with what was still in force. */
  clear(): FloodState {
    const cleared = this.read()
    this.#write({ deadlines: [] })
    return cleared
  }

  #write(state: FloodState): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 })
    renameSync(temporary, this.path)
  }
}
