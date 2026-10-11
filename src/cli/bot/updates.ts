import { existsSync, readFileSync } from "node:fs"
import { writeSecurely } from "@wirecat/cli-base"
import type { BotPress } from "./port.js"

/**
 * Where the bot's next poll starts. State, not cache: a poll with it confirms everything before it
 * to the messenger for every reader of this bot, so losing it prints a batch twice and never loses
 * one. `{ "marker": … }`, the shape max-cli has always written.
 */
export class UpdatesCursor {
  readonly #path: string

  constructor(path: string) {
    this.#path = path
  }

  read(): string | undefined {
    if (!existsSync(this.#path)) return undefined
    try {
      const { marker } = JSON.parse(readFileSync(this.#path, "utf8")) as { marker?: unknown }
      return typeof marker === "string" ? marker : undefined
    } catch {
      return undefined
    }
  }

  write(marker: string): void {
    writeSecurely(this.#path, `${JSON.stringify({ marker })}\n`, 0o600)
  }
}

interface KeptPress extends BotPress {
  callbackId: string
  at: string
}

const KEPT_PRESSES = 500
const PRESS_LIFETIME_MS = 24 * 60 * 60 * 1000

/** The buttons `bot watch` saw pressed, so `bot callbacks answer --text` can find the message later. */
export class PressLog {
  readonly #path: string

  constructor(path: string) {
    this.#path = path
  }

  #read(): KeptPress[] {
    if (!existsSync(this.#path)) return []
    try {
      const { presses } = JSON.parse(readFileSync(this.#path, "utf8")) as { presses?: KeptPress[] }
      return Array.isArray(presses) ? presses : []
    } catch {
      return []
    }
  }

  find(callbackId: string): BotPress | undefined {
    const found = this.#read().find((press) => press.callbackId === callbackId)
    return found ? { chatId: found.chatId, messageId: found.messageId } : undefined
  }

  /** The same press twice is kept once: a batch the copy refused comes again. */
  add(presses: readonly (BotPress & { callbackId: string })[], now = new Date()): void {
    if (presses.length === 0) return
    const fresh = this.#read().filter(
      (press) =>
        now.getTime() - Date.parse(press.at) < PRESS_LIFETIME_MS &&
        !presses.some((one) => one.callbackId === press.callbackId),
    )
    const added = presses.map((press) => ({ ...press, at: now.toISOString() }))
    writeSecurely(this.#path, `${JSON.stringify({ presses: [...fresh, ...added].slice(-KEPT_PRESSES) })}\n`, 0o600)
  }
}
