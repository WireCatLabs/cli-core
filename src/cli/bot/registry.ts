import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { resolvePaths, writeSecurely } from "@wirecat/cli-base"
import type { Chat } from "../../domain/models.js"
import type { AppIdentity } from "../../ports/app.js"

export interface SeenChat extends Chat {
  firstSeenAt: string
  lastSeenAt: string
}

/** Everything this machine keeps about its bots: seen chats, recipients, the send journal. */
export const botsDirectory = (app: AppIdentity, env: NodeJS.ProcessEnv = process.env): string =>
  join(resolvePaths({ appName: app.appName, prefix: app.envPrefix, env }).state, "bots")

/** One bot's files. The names are what max-cli has always used: a moved path would lose a recipient list, and with it the limit. */
export const botFiles = (app: AppIdentity, profile: string, env: NodeJS.ProcessEnv = process.env) => {
  const directory = botsDirectory(app, env)
  return {
    registry: join(directory, `${profile}.json`),
    recipients: join(directory, "recipients", `${profile}.json`),
    journal: join(directory, "sends", `${profile}.jsonl`),
    updates: join(directory, "updates", `${profile}.json`),
    presses: join(directory, "presses", `${profile}.json`),
    checks: join(directory, "checks", `${profile}.json`),
  }
}

/**
 * The chats this bot has seen, because neither MAX's nor Telegram's Bot API has a call that lists them.
 *
 * State, not cache: the messenger cannot give it back, so clearing a cache must not take it. Titles
 * are in it, hence 0600.
 */
export class ChatRegistry {
  readonly #path: string

  constructor(app: AppIdentity, profile: string, env: NodeJS.ProcessEnv = process.env) {
    this.#path = botFiles(app, profile, env).registry
  }

  list(): SeenChat[] {
    const { chats } = this.#read()
    return Array.isArray(chats) ? chats : []
  }

  /** The bot's own user id, once any command has learned it — the key its messages are stored under. */
  botId(): string | undefined {
    const { botId } = this.#read()
    return typeof botId === "string" ? botId : undefined
  }

  rememberBot(id: string): void {
    const file = this.#read()
    if (file.botId !== id) this.#write({ ...file, botId: id })
  }

  /** Makes this bot known to `bot list` before it has seen any chat. */
  touch(): void {
    if (!existsSync(this.#path)) writeSecurely(this.#path, `${JSON.stringify({ chats: [] }, null, 2)}\n`, 0o600)
  }

  /** Newer facts win; a chat seen only as an id keeps the title it had. */
  observe(chats: readonly (Partial<Chat> & { id: string })[], now: Date = new Date()): void {
    if (chats.length === 0) return
    const byId = new Map(this.list().map((chat) => [chat.id, chat]))
    const at = now.toISOString()
    for (const chat of chats) {
      const known = byId.get(chat.id)
      const defined = Object.fromEntries(
        Object.entries(chat).filter(([, value]) => value !== undefined && value !== null),
      )
      byId.set(chat.id, {
        title: null,
        kind: "unknown",
        unreadCount: null,
        lastMessageAt: null,
        participantsCount: null,
        ...known,
        ...defined,
        id: chat.id,
        firstSeenAt: known?.firstSeenAt ?? at,
        lastSeenAt: at,
      })
    }
    this.#write({ ...this.#read(), chats: [...byId.values()] })
  }

  #read(): { chats?: SeenChat[]; botId?: unknown } {
    if (!existsSync(this.#path)) return {}
    try {
      const parsed = JSON.parse(readFileSync(this.#path, "utf8"))
      return parsed && typeof parsed === "object" ? parsed : {}
    } catch {
      return {}
    }
  }

  #write(file: object): void {
    writeSecurely(this.#path, `${JSON.stringify(file, null, 2)}\n`, 0o600)
  }
}

/** Every profile that has ever kept a registry — the bots this machine has used. */
export const registryProfiles = (app: AppIdentity, env: NodeJS.ProcessEnv = process.env): string[] => {
  const directory = botsDirectory(app, env)
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .map((name) => name.slice(0, -".json".length))
}
