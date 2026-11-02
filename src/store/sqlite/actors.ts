import { CliError } from "@wirecat/cli-base"
import type { Proposer } from "../decisions.js"
import type { CacheDatabase } from "../driver.js"

/** Who made or owns something: the store's polymorphic actor pair. */
export interface Actor {
  type: "person" | "bot"
  id: number
}

/** How the task package names who acted; each maps to one stable actor row. */
export type Origin = "owner" | "agent" | "rule"

export const BOT_KINDS = ["agent", "rule", "script", "integration"] as const

/** The owner's person row, which the initial migration seeds. */
export const ownerPerson = (database: CacheDatabase): Actor => {
  const found = database.prepare("SELECT id FROM persons WHERE owner = 1 ORDER BY id LIMIT 1").get()
  if (!found) throw new CliError("configuration_error", "the store has no owner person")
  return { type: "person", id: Number(found.id) }
}

/** A bot by its unique handle, registered on first use. */
export const botNamed = (
  database: CacheDatabase,
  name: string,
  now: number,
  kind: (typeof BOT_KINDS)[number] = "agent",
): Actor => {
  const handle = name.trim()
  if (!handle || handle.length > 100) throw new CliError("validation_error", "a bot's name takes 1–100 characters")
  if (!BOT_KINDS.includes(kind))
    throw new CliError("validation_error", `a bot's kind is one of ${BOT_KINDS.join(", ")}`)
  const found = database.prepare("SELECT id FROM bots WHERE name = ?").get(handle)
  if (found) return { type: "bot", id: Number(found.id) }
  const made = database
    .prepare("INSERT INTO bots (name, kind, created_at, updated_at) VALUES (?, ?, ?, ?) RETURNING id")
    .get(handle, kind, now, now)
  return { type: "bot", id: Number(made?.id) }
}

/**
 * The task package's origins as actors: the owner is the owner's person, a rule and an unnamed agent are
 * the seeded bots `rule` and `agent`.
 */
export const actorOfOrigin = (database: CacheDatabase, origin: Origin): Actor => {
  if (origin === "owner") return ownerPerson(database)
  const found = database.prepare("SELECT id FROM bots WHERE name = ?").get(origin)
  if (!found) throw new CliError("configuration_error", `the store has no bot ${origin}`)
  return { type: "bot", id: Number(found.id) }
}

export const originOfActor = (database: CacheDatabase, type: unknown, id: unknown): Origin | undefined => {
  if (type == null || id == null) return undefined
  if (type === "person") return "owner"
  return database.prepare("SELECT name FROM bots WHERE id = ?").get(Number(id))?.name === "rule" ? "rule" : "agent"
}

/** Who proposed a stored row, from its actor pair; the seeded bot `rule` and a bot of kind `rule` are rules. */
export const proposerOf = (database: CacheDatabase, type: unknown, id: unknown): Proposer => {
  if (type === "person" && id != null) return { type: "person", id: String(id) }
  if (type !== "bot" || id == null) return { type: "unknown" }
  const bot = database.prepare("SELECT name, kind FROM bots WHERE id = ?").get(Number(id))
  if (!bot) return { type: "unknown" }
  const name = String(bot.name)
  return { type: "bot", id: String(id), name, kind: bot.kind === "rule" || name === "rule" ? "rule" : "agent" }
}

/** Who proposed an unconfirmed link, from the `agent:<bot>` or `rule:<id>` its provenance starts with. */
export const proposerOfProvenance = (database: CacheDatabase, provenance: string | null): Proposer => {
  const [, kind, name] = /^(agent|rule):([^\s;]+)/.exec(provenance ?? "") ?? []
  if (!kind || !name) return { type: "unknown" }
  if (kind === "rule") return { type: "bot", id: "", name: `rule:${name}`, kind: "rule" }
  const bot = database.prepare("SELECT id FROM bots WHERE name = ?").get(name)
  return { type: "bot", id: bot ? String(bot.id) : "", name, kind: "agent" }
}
