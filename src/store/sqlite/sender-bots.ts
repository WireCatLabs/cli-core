import { CliError } from "@wirecat/cli-base"
import type { CacheDatabase } from "../driver.js"
import type { IdentityRef, PersonRecord } from "../types.js"
import { releaseDomainHolds } from "./domain-organizations.js"
import { currentPerson } from "./merged-persons.js"
import type { StoreContext } from "./open.js"
import { isOwner, mergePerson, move, recordOf, renameAfterLeaving, required, unlinkIdentity } from "./person-links.js"
import { write } from "./transaction.js"

export const SENDER_BOT_PREFIX = "sender-bot:"

export type BotAuthor = "rules" | "owner"

/** A sender bot as the people list reads it, keyed by the person row whose identities are the bot's. */
export interface HeldBot {
  id: number
  author: BotAuthor
  name: string | null
}

export interface SenderBot {
  bot: string
  /** The person row whose identities are the bot's: its handle in `people list` and `people show`. */
  person: string
  name: string | null
  author: BotAuthor
  reason: string | null
}

export const senderBotsOf = (database: CacheDatabase): Map<number, HeldBot> =>
  new Map(
    database
      .prepare("SELECT id, person_id, author, name FROM sender_bots")
      .all()
      .map((row) => [
        Number(row.person_id),
        { id: Number(row.id), author: row.author as BotAuthor, name: row.name == null ? null : String(row.name) },
      ]),
  )

/** People holding an identity the owner last moved to a person, or kept as one: no rule makes them a bot. */
export const ownerPeopleOf = (database: CacheDatabase): Set<number> =>
  new Set(
    database
      .prepare(
        "SELECT DISTINCT l.person_id AS person FROM sender_bot_moves m JOIN identity_links l ON l.identity_id = m.identity_id " +
          "WHERE m.author = 'owner' AND m.to_bot_id IS NULL " +
          "AND m.id = (SELECT max(id) FROM sender_bot_moves WHERE identity_id = m.identity_id)",
      )
      .all()
      .map((row) => Number(row.person)),
  )

export const refuseBotAssignee = (database: CacheDatabase, person: number): void => {
  if (database.prepare("SELECT 1 FROM sender_bots WHERE person_id = ?").get(person) !== undefined)
    throw new CliError("validation_error", `person:${person} is a sender bot, which is no one's assignee`, {
      reason: "sender-bot.assignee",
    })
}

const identitiesOf = (database: CacheDatabase, person: number): number[] =>
  database
    .prepare("SELECT identity_id FROM identity_links WHERE person_id = ? ORDER BY identity_id")
    .all(person)
    .map((row) => Number(row.identity_id))

interface Side {
  person?: number
  bot?: number
}

const logMoves = (
  database: CacheDatabase,
  identities: readonly number[],
  from: Side,
  to: Side,
  { author, reason, at }: { author: BotAuthor; reason: string | null; at: number },
) => {
  const row = database.prepare(
    "INSERT INTO sender_bot_moves (identity_id, from_person_id, from_bot_id, to_person_id, to_bot_id, author, reason, " +
      "created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
  for (const identity of identities)
    row.run(identity, from.person ?? null, from.bot ?? null, to.person ?? null, to.bot ?? null, author, reason, at)
}

const createBot = (
  database: CacheDatabase,
  person: number,
  { author, reason, at, name = null }: { author: BotAuthor; reason: string | null; at: number; name?: string | null },
): number =>
  Number(
    database
      .prepare(
        "INSERT INTO sender_bots (person_id, name, author, reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) " +
          "RETURNING id",
      )
      .get(person, name, author, reason, at, at)?.id,
  )

/** A rule's move of a whole person to a bot, or of a rule's bot back to a person; the caller holds the write lock. */
export const ruleMove = (
  database: CacheDatabase,
  person: number,
  to: "bot" | "person",
  reason: string,
  at: number,
): void => {
  const identities = identitiesOf(database, person)
  const options = { author: "rules" as const, reason, at }
  if (to === "bot") {
    const bot = createBot(database, person, options)
    logMoves(database, identities, { person }, { bot }, options)
    return
  }
  const held = database.prepare("SELECT id FROM sender_bots WHERE person_id = ? AND author = 'rules'").get(person)
  if (held === undefined) return
  database.prepare("DELETE FROM sender_bots WHERE id = ?").run(Number(held.id))
  logMoves(database, identities, { bot: Number(held.id) }, { person }, options)
}

const botRow = (database: CacheDatabase, ref: string) => {
  const id = ref.startsWith(SENDER_BOT_PREFIX) ? ref.slice(SENDER_BOT_PREFIX.length) : ""
  const row = /^[1-9]\d*$/.test(id)
    ? database.prepare("SELECT id, person_id FROM sender_bots WHERE id = ?").get(Number(id))
    : undefined
  if (row === undefined)
    throw new CliError("not_found", `no ${ref} in the store`, { reason: "sender-bot.not-found", reference: ref })
  return { id: Number(row.id), person: Number(row.person_id) }
}

const botOfPerson = (database: CacheDatabase, person: number): number | undefined => {
  const row = database.prepare("SELECT id FROM sender_bots WHERE person_id = ?").get(person)
  return row === undefined ? undefined : Number(row.id)
}

const personRow = (database: CacheDatabase, ref: string): number => {
  const uid = ref.startsWith("person:") ? ref.slice("person:".length) : ""
  const found = /^[1-9]\d*$/.test(uid) ? database.prepare("SELECT id FROM persons WHERE id = ?").get(uid) : undefined
  if (found === undefined) throw new CliError("not_found", `no ${ref} in the store`, { reference: ref })
  return currentPerson(database, Number(found.id))
}

/** What a move names: a whole person or bot, or one identity and the person it sits on. */
const subjectOf = (context: StoreContext, subject: string | IdentityRef) => {
  const { database } = context
  if (typeof subject !== "string") {
    const found = required(context, subject)
    const alone = identitiesOf(database, found.personPk).length === 1
    return alone ? { person: found.personPk } : { person: found.personPk, identity: found.pk, ref: subject }
  }
  if (subject.startsWith(SENDER_BOT_PREFIX)) return { person: botRow(database, subject).person }
  return { person: personRow(database, subject) }
}

const senderBotOf = (database: CacheDatabase, id: number): SenderBot => {
  const row = database.prepare("SELECT person_id, name, author, reason FROM sender_bots WHERE id = ?").get(id)
  return {
    bot: `${SENDER_BOT_PREFIX}${id}`,
    person: `person:${Number(row?.person_id)}`,
    name: row?.name == null ? null : String(row.name),
    author: row?.author as BotAuthor,
    reason: row?.reason == null ? null : String(row.reason),
  }
}

/**
 * The owner's word that a person, or one of their identities, is a program, for its whole history: its messages stay
 * where they are, and no rule moves it back. `bot` joins it to a bot already stored; one identity of a person with
 * others gets a person row of its own first.
 */
export const moveToBot = (
  context: StoreContext,
  subject: string | IdentityRef,
  options: { bot?: string; name?: string; reason?: string } = {},
): SenderBot => {
  const { database } = context
  return write(database, () => {
    const at = context.now()
    const log = { author: "owner" as const, reason: options.reason ?? null, at }
    const chosen = subjectOf(context, subject)
    if (isOwner(context, chosen.person))
      throw new CliError("validation_error", "the owner's own person is never a bot", { reason: "sender-bot.owner" })
    const target = options.bot === undefined ? undefined : botRow(database, options.bot)
    const from = { person: chosen.person, bot: botOfPerson(database, chosen.person) }
    const claim = (bot: number) =>
      database
        .prepare("UPDATE sender_bots SET author = 'owner', name = coalesce(?, name), updated_at = ? WHERE id = ?")
        .run(options.name ?? null, at, bot)
    if (target !== undefined && target.person !== chosen.person) {
      const moving = chosen.identity === undefined ? identitiesOf(database, chosen.person) : [chosen.identity]
      if (chosen.identity === undefined) {
        mergePerson(context, chosen.person, target.person, { method: "bot", by: "owner" })
        if (from.bot !== undefined) database.prepare("DELETE FROM sender_bots WHERE id = ?").run(from.bot)
      } else {
        move(context, chosen.identity, chosen.person, target.person, { method: "bot", by: "owner" })
        renameAfterLeaving(context, chosen.person, [chosen.identity])
      }
      claim(target.id)
      logMoves(database, moving, from, { bot: target.id }, log)
      return senderBotOf(database, target.id)
    }
    if (chosen.identity !== undefined && chosen.ref !== undefined) {
      const alone = Number(unlinkIdentity(context, chosen.ref, { method: "unlink", by: "owner" }).uid)
      const bot = createBot(database, alone, { ...log, name: options.name ?? null })
      logMoves(database, [chosen.identity], from, { bot }, log)
      return senderBotOf(database, bot)
    }
    const held = from.bot ?? createBot(database, chosen.person, { ...log, name: options.name ?? null })
    if (from.bot !== undefined) claim(held)
    logMoves(database, identitiesOf(database, chosen.person), from, { bot: held }, log)
    return senderBotOf(database, held)
  })
}

/**
 * The owner's word that a bot, a person or one identity is a person, for its whole history; no rule makes it a bot
 * again. `person` joins it to that person; one identity of a bot with others gets a person row of its own.
 */
export const moveToPerson = (
  context: StoreContext,
  subject: string | IdentityRef,
  options: { person?: string; reason?: string } = {},
): PersonRecord => {
  const { database } = context
  return write(database, () => {
    const at = context.now()
    const log = { author: "owner" as const, reason: options.reason ?? null, at }
    const chosen = subjectOf(context, subject)
    const bot = botOfPerson(database, chosen.person)
    const from = { person: chosen.person, bot }
    const target = options.person === undefined ? undefined : personRow(database, options.person)
    if (target !== undefined && botOfPerson(database, target) !== undefined)
      throw new CliError("validation_error", `${options.person} is a bot; name a person`, {
        reason: "sender-bot.not-a-person",
        reference: options.person,
      })
    if (target !== undefined && target !== chosen.person) {
      const moving = chosen.identity === undefined ? identitiesOf(database, chosen.person) : [chosen.identity]
      if (chosen.identity === undefined) mergePerson(context, chosen.person, target, { method: "manual", by: "owner" })
      else {
        move(context, chosen.identity, chosen.person, target, { method: "manual", by: "owner" })
        renameAfterLeaving(context, chosen.person, [chosen.identity])
      }
      if (bot !== undefined && identitiesOf(database, chosen.person).length === 0)
        database.prepare("DELETE FROM sender_bots WHERE id = ?").run(bot)
      releaseDomainHolds(database, moving)
      logMoves(database, moving, from, { person: target }, log)
      return recordOf(context, target)
    }
    if (chosen.identity !== undefined && chosen.ref !== undefined && bot !== undefined) {
      const alone = Number(unlinkIdentity(context, chosen.ref, { method: "unlink", by: "owner" }).uid)
      releaseDomainHolds(database, [chosen.identity])
      logMoves(database, [chosen.identity], from, { person: alone }, log)
      return recordOf(context, alone)
    }
    if (bot !== undefined) database.prepare("DELETE FROM sender_bots WHERE id = ?").run(bot)
    const moving = chosen.identity === undefined ? identitiesOf(database, chosen.person) : [chosen.identity]
    releaseDomainHolds(database, moving)
    logMoves(database, moving, from, { person: chosen.person }, log)
    return recordOf(context, chosen.person)
  })
}
