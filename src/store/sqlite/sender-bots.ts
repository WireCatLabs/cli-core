import { CliError } from "@wirecat/cli-base"
import { displayName } from "../../domain/display-names.js"
import { SENDER_BOT_PREFIX } from "../../domain/person-kinds.js"
import type { CacheDatabase, SqlValue } from "../driver.js"
import { fold } from "../normalize.js"
import type { IdentityRef, PersonRecord } from "../types.js"
import { groupByDomain, releaseDomainHolds } from "./domain-organizations.js"
import { currentPerson } from "./merged-persons.js"
import type { StoreContext } from "./open.js"
import { isOwner, mergePerson, move, recordOf, renameAfterLeaving } from "./person-links.js"
import { SMALL_GROUP_MEMBERS } from "./person-ties.js"
import { LIST_ID, type Reach, type SenderSignal, senderSignalsOf, sentMailOf } from "./sender-signals.js"
import { read, write } from "./transaction.js"

export type BotAuthor = "rules" | "owner"

/** @experimental */
export interface BotIdentity {
  provider: string
  id: string
  name: string | null
  username: string | null
}

/** A program that writes to the owner, apart from people: it has no ties, no tasks and no merge review. @experimental */
export interface SenderBot {
  /** `sender-bot:<id>`. */
  bot: string
  /** The owner's name for it; `displayName` falls back to its identities'. */
  name: string | null
  displayName: string | null
  /** The organization it sends for (`organization:<id>`), from its mail domain or the owner. */
  organization: string | null
  /** `owner` when the owner moved it: no rule gives it back to a person. */
  author: BotAuthor
  /** The kind signals that sorted it, or the owner's words. */
  reason: string | null
  identities: BotIdentity[]
  /** Messages and mail it sent, every account together. */
  messagesFrom: number
  lastContact: string | null
  reach: Reach | null
  signals: SenderSignal[]
}

/** One move of an identity between a person and a bot. @experimental */
export interface BotMove {
  identity: IdentityRef
  /** `person:<uid>` or `sender-bot:<id>`; `null` for none. */
  from: string | null
  to: string | null
  author: BotAuthor
  reason: string | null
  at: string
}

/** @experimental */
export interface SenderBotDetails extends SenderBot {
  /** Every move to or from this bot, oldest first. */
  moves: BotMove[]
}

/** @experimental */
export interface BotListOptions {
  /** Part of a name, address or username, at least 3 characters. */
  query?: string
  /** `organization:<id>`: the bots that send for it. */
  organization?: string
  limit: number
  offset?: number
}

/** @experimental */
export interface BotList {
  items: SenderBot[]
  hasMore: boolean
  total: number
}

interface Log {
  author: BotAuthor
  reason: string | null
  at: number
}

interface Side {
  person?: number
  bot?: number
}

const MIN_QUERY = 3
const HOLDS = "EXISTS (SELECT 1 FROM sender_bot_identities h WHERE h.bot_id = b.id)"
const SHOWN =
  "coalesce(b.name, (SELECT coalesce(i.name, i.username, i.external_id) FROM sender_bot_identities s " +
  "JOIN identities i ON i.id = s.identity_id WHERE s.bot_id = b.id ORDER BY i.name IS NULL, i.id LIMIT 1))"

const refOf = (side: Side): string | null =>
  side.person !== undefined
    ? `person:${side.person}`
    : side.bot !== undefined
      ? `${SENDER_BOT_PREFIX}${side.bot}`
      : null

const holderOf = (database: CacheDatabase, identity: number): Side => {
  const linked = database.prepare("SELECT person_id FROM identity_links WHERE identity_id = ?").get(identity)
  if (linked !== undefined) return { person: Number(linked.person_id) }
  const held = database.prepare("SELECT bot_id FROM sender_bot_identities WHERE identity_id = ?").get(identity)
  return held === undefined ? {} : { bot: Number(held.bot_id) }
}

const identitiesOf = (database: CacheDatabase, person: number): number[] =>
  database
    .prepare("SELECT identity_id FROM identity_links WHERE person_id = ? ORDER BY identity_id")
    .all(person)
    .map((row) => Number(row.identity_id))

const botIdentitiesOf = (database: CacheDatabase, bot: number): number[] =>
  database
    .prepare("SELECT identity_id FROM sender_bot_identities WHERE bot_id = ? ORDER BY identity_id")
    .all(bot)
    .map((row) => Number(row.identity_id))

const logMove = (database: CacheDatabase, identity: number, from: Side, to: Side, { author, reason, at }: Log) =>
  database
    .prepare(
      "INSERT INTO sender_bot_moves (identity_id, from_person_id, from_bot_id, to_person_id, to_bot_id, author, " +
        "reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(identity, from.person ?? null, from.bot ?? null, to.person ?? null, to.bot ?? null, author, reason, at)

/** `person_id` only keeps builds before version 75 from reading the bot as a person: a negative one names none. */
const createBot = (database: CacheDatabase, { author, reason, at }: Log, name: string | null = null): number =>
  Number(
    database
      .prepare(
        "INSERT INTO sender_bots (person_id, name, author, reason, created_at, updated_at) " +
          "VALUES ((SELECT min(0, coalesce(min(person_id), 0)) - 1 FROM sender_bots), ?, ?, ?, ?, ?) RETURNING id",
      )
      .get(name, author, reason, at, at)?.id,
  )

/** A person every identity left for a bot is stored as a merge's emptied person is: no list shows them. */
const retireEmptied = (database: CacheDatabase, people: Iterable<number>) => {
  const retire = database.prepare(
    "UPDATE persons SET kind = 'merged' WHERE id = ? AND NOT EXISTS (SELECT 1 FROM identity_links WHERE person_id = ?)",
  )
  for (const person of people) retire.run(person, person)
}

/**
 * Moves identities to a bot, off a person or another bot, each move logged. Answers the people each left, and which
 * identities. The caller holds the write lock.
 */
const intoBot = (database: CacheDatabase, identities: readonly number[], bot: number, log: Log) => {
  const left = new Map<number, number[]>()
  for (const identity of identities) {
    const from = holderOf(database, identity)
    if (from.bot === bot) continue
    if (from.person !== undefined) {
      database.prepare("DELETE FROM identity_links WHERE identity_id = ?").run(identity)
      left.set(from.person, [...(left.get(from.person) ?? []), identity])
    }
    if (from.bot !== undefined)
      database.prepare("UPDATE sender_bot_identities SET bot_id = ? WHERE identity_id = ?").run(bot, identity)
    else
      database
        .prepare("INSERT INTO sender_bot_identities (identity_id, bot_id, created_at) VALUES (?, ?, ?)")
        .run(identity, bot, log.at)
    logMove(database, identity, from, { bot }, log)
  }
  retireEmptied(database, left.keys())
  return left
}

/** The person an identity last left for a bot, as that person is now; `undefined` when it came from none. */
const originOf = (database: CacheDatabase, identity: number): number | undefined => {
  const row = database
    .prepare(
      "SELECT m.from_person_id FROM sender_bot_moves m JOIN persons p ON p.id = m.from_person_id " +
        "WHERE m.identity_id = ? AND m.to_bot_id IS NOT NULL ORDER BY m.id DESC LIMIT 1",
    )
    .get(identity)
  return row === undefined ? undefined : currentPerson(database, Number(row.from_person_id))
}

const newPerson = (database: CacheDatabase, identity: number, at: number): number =>
  Number(
    database
      .prepare(
        "INSERT INTO persons (name, created_at, updated_at) VALUES ((SELECT name FROM identities WHERE id = ?), ?, ?) " +
          "RETURNING id",
      )
      .get(identity, at, at)?.id,
  )

/**
 * Gives a bot's identities to a person: `to`, else the person each came from, else a person row of its own. The bot
 * goes with its last identity. Answers the person each went to. The caller holds the write lock.
 */
const outOfBot = (database: CacheDatabase, identities: readonly number[], to: number | undefined, log: Log) => {
  const by = log.author === "owner" ? "owner" : "rules"
  const went = new Map<number, number>()
  for (const identity of identities) {
    const from = holderOf(database, identity)
    if (from.bot === undefined) continue
    database.prepare("DELETE FROM sender_bot_identities WHERE identity_id = ?").run(identity)
    const target = to ?? originOf(database, identity) ?? newPerson(database, identity, log.at)
    database
      .prepare(
        "INSERT INTO identity_links (identity_id, person_id, method, confidence, created_at, author, updated_at) " +
          "VALUES (?, ?, 'bot', 1, ?, ?, ?)",
      )
      .run(identity, target, log.at, by, log.at)
    database
      .prepare(
        "INSERT INTO identity_link_events (identity_id, from_person_id, to_person_id, method, created_at, author) " +
          "VALUES (?, NULL, ?, 'bot', ?, ?)",
      )
      .run(identity, target, log.at, by)
    logMove(database, identity, from, { person: target }, log)
    went.set(identity, target)
  }
  return went
}

/**
 * The source re-keyed `from` onto `to`, both stored: a bot holding `from` takes `to` from its person, since one
 * account is one program. The person it leaves is hidden as `intoBot` hides one. The caller holds the write lock.
 */
export const rekeyIntoBot = (database: CacheDatabase, from: number, to: number, at: number): void => {
  const bot = holderOf(database, from).bot
  if (bot === undefined || holderOf(database, to).bot !== undefined) return
  intoBot(database, [to], bot, { author: "rules", reason: "the source re-keyed the identity", at })
}

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

/** A person every identity left for a bot is no one's assignee: the bot has no tasks. */
export const refuseBotAssignee = (database: CacheDatabase, person: number): void => {
  const bot = database
    .prepare(
      "SELECT m.to_bot_id FROM sender_bot_moves m WHERE m.from_person_id = ? AND m.to_bot_id IS NOT NULL " +
        "AND NOT EXISTS (SELECT 1 FROM identity_links WHERE person_id = ?) ORDER BY m.id DESC LIMIT 1",
    )
    .get(person, person)
  if (bot !== undefined)
    throw new CliError(
      "validation_error",
      `person:${person} moved to ${SENDER_BOT_PREFIX}${bot.to_bot_id}, which is no one's assignee`,
      { reason: "sender-bot.assignee" },
    )
}

/** A rule's move of a whole person to a new bot; answers the bot. The caller holds the write lock. */
export const ruleToBot = (database: CacheDatabase, person: number, reason: string, at: number): number => {
  const log = { author: "rules" as const, reason, at }
  const bot = createBot(database, log)
  intoBot(database, identitiesOf(database, person), bot, log)
  return bot
}

/** The reason of a bot that only sent a newsletter: a mail written to the owner alone gives it back to a person. */
export const NEWSLETTER_ONLY = "newsletter-only"

/** Mail from the identity `s` that no list sent, to the owner and at most a small group. */
const ONE_TO_ONE =
  "EXISTS (SELECT 1 FROM emails e WHERE e.from_identity_id = s.identity_id AND e.outgoing IS NOT 1 " +
  `AND e.deleted_at IS NULL AND ${LIST_ID} IS NULL AND json_extract(e.headers, '$."list-unsubscribe"') IS NOT 1 ` +
  "AND json_extract(e.headers, '$.\"list-unsubscribe-post\"') IS NOT 1 " +
  "AND json_extract(e.headers, '$.\"feedback-id\"') IS NOT 1 " +
  "AND json_extract(e.headers, '$.precedence') IS NOT 'bulk' AND json_extract(e.headers, '$.precedence') IS NOT 'junk' " +
  "AND NOT EXISTS (SELECT 1 FROM email_mailboxes m " +
  "JOIN mailboxes x ON x.id = m.mailbox_id WHERE m.email_id = e.id AND x.kind = 'bulk') " +
  "AND (SELECT count(*) FROM email_recipients r WHERE r.email_id = e.id AND r.role IN ('to', 'cc')) " +
  `BETWEEN 1 AND ${SMALL_GROUP_MEMBERS})`

/**
 * A rule's bot the owner wrote to, or a newsletter's that wrote to the owner alone, by mail or in a private chat both wrote in, goes back to the people its identities
 * came from; a messenger's own bot flag holds anyway. The caller holds the write lock.
 */
export const ruleBotsBack = (database: CacheDatabase, at: number): void => {
  const back = database
    .prepare(
      "SELECT b.id, b.reason FROM sender_bots b WHERE b.author = 'rules' AND NOT EXISTS (SELECT 1 FROM " +
        "sender_bot_identities s JOIN identities i ON i.id = s.identity_id WHERE s.bot_id = b.id AND i.bot = 1) " +
        "AND EXISTS (SELECT 1 FROM sender_bot_identities s WHERE s.bot_id = b.id AND (" +
        "EXISTS (SELECT 1 FROM email_recipients r JOIN emails e ON e.id = r.email_id WHERE r.identity_id = s.identity_id " +
        "AND e.outgoing = 1 AND e.deleted_at IS NULL AND e.draft IS NOT 1) OR " +
        "EXISTS (SELECT 1 FROM messages m JOIN chats c ON c.id = m.chat_id WHERE m.sender_identity_id = s.identity_id " +
        "AND m.outgoing IS NOT 1 AND c.kind = 'dialog' AND EXISTS (SELECT 1 FROM messages o WHERE o.chat_id = c.id " +
        `AND o.outgoing = 1)) OR (b.reason = '${NEWSLETTER_ONLY}' AND ${ONE_TO_ONE})))`,
    )
    .all()
  for (const row of back) {
    const reason = row.reason === NEWSLETTER_ONLY ? "a 1-to-1 mail or the owner wrote to it" : "the owner wrote to it"
    outOfBot(database, botIdentitiesOf(database, Number(row.id)), undefined, { author: "rules", reason, at })
  }
}

/** Whether a build before version 75 sorted a bot onto a person row since the last kept list. */
export const hasLegacyBots = (database: CacheDatabase): boolean =>
  database.prepare("SELECT 1 FROM sender_bots WHERE person_id > 0 LIMIT 1").get() !== undefined

/**
 * A bot a build before version 75 sorted after the upgrade holds its person row's identities there: they move to the
 * bot, as the upgrade moved the others. The caller holds the write lock.
 */
export const settleLegacyBots = (database: CacheDatabase, at: number): void => {
  const legacy = database.prepare("SELECT id, person_id, author, reason FROM sender_bots WHERE person_id > 0").all()
  for (const row of legacy) {
    const bot = Number(row.id)
    const identities = identitiesOf(database, Number(row.person_id))
    database
      .prepare(
        "UPDATE sender_bots SET person_id = (SELECT min(0, coalesce(min(person_id), 0)) - 1 FROM sender_bots) WHERE id = ?",
      )
      .run(bot)
    const log = { author: row.author as BotAuthor, reason: "sorted by a build before store version 75", at }
    intoBot(database, identities, bot, log)
    if (identities.length === 0) database.prepare("DELETE FROM sender_bots WHERE id = ?").run(bot)
  }
}

const botIdOf = (database: CacheDatabase, ref: string): number => {
  const id = ref.startsWith(SENDER_BOT_PREFIX) ? ref.slice(SENDER_BOT_PREFIX.length) : ""
  const row = /^[1-9]\d*$/.test(id)
    ? database.prepare("SELECT id FROM sender_bots WHERE id = ?").get(Number(id))
    : undefined
  if (row === undefined)
    throw new CliError("not_found", `no ${ref} in the store`, { reason: "sender-bot.not-found", reference: ref })
  return Number(row.id)
}

const personIdOf = (database: CacheDatabase, ref: string): number => {
  const uid = ref.startsWith("person:") ? ref.slice("person:".length) : ""
  const found = /^[1-9]\d*$/.test(uid) ? database.prepare("SELECT id FROM persons WHERE id = ?").get(uid) : undefined
  if (found === undefined) throw new CliError("not_found", `no ${ref} in the store`, { reference: ref })
  return currentPerson(database, Number(found.id))
}

const identityIdOf = (database: CacheDatabase, { provider, id }: IdentityRef): number => {
  const row = database.prepare("SELECT id FROM identities WHERE provider = ? AND external_id = ?").get(provider, id)
  if (row === undefined) throw new CliError("not_found", `no ${provider} identity ${id} in the store`)
  return Number(row.id)
}

/** What a move names: a person's identities, a bot's, or one identity. */
const subjectOf = (database: CacheDatabase, subject: string | IdentityRef) => {
  if (typeof subject !== "string") return { identities: [identityIdOf(database, subject)] }
  if (subject.startsWith(SENDER_BOT_PREFIX)) {
    const bot = botIdOf(database, subject)
    return { bot, identities: botIdentitiesOf(database, bot) }
  }
  const person = personIdOf(database, subject)
  const identities = identitiesOf(database, person)
  const took = identities.length === 0 ? botThatTook(database, person) : undefined
  return took === undefined ? { person, identities } : { bot: took, identities: botIdentitiesOf(database, took) }
}

/** The bot that took every identity of a person, so their `person:` ref still names it. */
const botThatTook = (database: CacheDatabase, person: number): number | undefined => {
  const row = database
    .prepare(
      "SELECT s.bot_id FROM sender_bot_moves m JOIN sender_bot_identities s ON s.identity_id = m.identity_id " +
        "WHERE m.from_person_id = ? AND m.to_bot_id IS NOT NULL ORDER BY m.id DESC LIMIT 1",
    )
    .get(person)
  return row === undefined ? undefined : Number(row.bot_id)
}

const botsOf = (database: CacheDatabase, ids: readonly number[]): SenderBot[] => {
  if (ids.length === 0) return []
  const json = JSON.stringify(ids)
  const rows = new Map(
    database
      .prepare(
        "SELECT id, name, organization_id, author, reason FROM sender_bots WHERE id IN (SELECT value FROM json_each(?))",
      )
      .all(json)
      .map((row) => [Number(row.id), row]),
  )
  const identities = new Map<number, (BotIdentity & { phone: string | null })[]>()
  for (const row of database
    .prepare(
      "SELECT s.bot_id, i.provider, i.external_id, i.name, i.username, i.phone FROM sender_bot_identities s " +
        "JOIN identities i ON i.id = s.identity_id WHERE s.bot_id IN (SELECT value FROM json_each(?)) ORDER BY i.id",
    )
    .all(json)) {
    const held = identities.get(Number(row.bot_id)) ?? []
    held.push({
      provider: String(row.provider),
      id: String(row.external_id),
      name: row.name == null ? null : String(row.name),
      username: row.username == null ? null : String(row.username),
      phone: row.phone == null ? null : String(row.phone),
    })
    identities.set(Number(row.bot_id), held)
  }
  const counts = new Map<number, { n: number; at: number | null }>()
  for (const row of database
    .prepare(
      "SELECT s.bot_id AS bot, count(*) AS n, max(m.sent_at) AS at FROM sender_bot_identities s " +
        "JOIN messages m ON m.sender_identity_id = s.identity_id WHERE s.bot_id IN (SELECT value FROM json_each(?)) " +
        "AND m.deleted_at IS NULL AND m.outgoing IS NOT 1 GROUP BY 1 UNION ALL " +
        "SELECT s.bot_id, count(*), max(coalesce(e.sent_at, e.received_at)) FROM sender_bot_identities s " +
        "JOIN emails e ON e.from_identity_id = s.identity_id WHERE s.bot_id IN (SELECT value FROM json_each(?)) " +
        "AND e.deleted_at IS NULL AND e.outgoing IS NOT 1 GROUP BY 1",
    )
    .all(json, json)) {
    const was = counts.get(Number(row.bot)) ?? { n: 0, at: null }
    const at = row.at == null ? was.at : Math.max(Number(row.at), was.at ?? 0)
    counts.set(Number(row.bot), { n: was.n + Number(row.n), at })
  }
  const sent = sentMailOf(database, ids, "bot")
  return ids.flatMap((id) => {
    const row = rows.get(id)
    if (row === undefined) return []
    const held = identities.get(id) ?? []
    const first = held.find((one) => one.name !== null) ?? held[0]
    const emails = held.flatMap((one) => (one.provider === "email" ? [one.id] : []))
    const name = row.name == null ? null : String(row.name)
    const counted = counts.get(id)
    return [
      {
        bot: `${SENDER_BOT_PREFIX}${id}`,
        name,
        displayName: displayName(name, {
          name: first?.name ?? null,
          username: first?.username ?? null,
          phone: first?.phone ?? null,
          email: emails[0] ?? null,
        }),
        organization: row.organization_id == null ? null : `organization:${Number(row.organization_id)}`,
        author: row.author as BotAuthor,
        reason: row.reason == null ? null : String(row.reason),
        identities: held.map(({ phone: _, ...one }) => one),
        messagesFrom: counted?.n ?? 0,
        lastContact: counted?.at == null ? null : new Date(counted.at).toISOString(),
        ...senderSignalsOf(sent.get(id) ?? [], { addresses: emails, ownerWrote: false, chatted: false }),
      },
    ]
  })
}

const movesOf = (database: CacheDatabase, bot: number): BotMove[] =>
  database
    .prepare(
      "SELECT m.*, i.provider, i.external_id FROM sender_bot_moves m JOIN identities i ON i.id = m.identity_id " +
        "WHERE m.from_bot_id = ? OR m.to_bot_id = ? ORDER BY m.id",
    )
    .all(bot, bot)
    .map((row) => ({
      identity: { provider: String(row.provider), id: String(row.external_id) },
      from: refOf({
        ...(row.from_person_id == null ? {} : { person: Number(row.from_person_id) }),
        ...(row.from_bot_id == null ? {} : { bot: Number(row.from_bot_id) }),
      }),
      to: refOf({
        ...(row.to_person_id == null ? {} : { person: Number(row.to_person_id) }),
        ...(row.to_bot_id == null ? {} : { bot: Number(row.to_bot_id) }),
      }),
      author: row.author as BotAuthor,
      reason: row.reason == null ? null : String(row.reason),
      at: new Date(Number(row.created_at)).toISOString(),
    }))

const detailsOf = (database: CacheDatabase, bot: number): SenderBotDetails => {
  const [found] = botsOf(database, [bot])
  if (found === undefined)
    throw new CliError("not_found", `no ${SENDER_BOT_PREFIX}${bot} in the store`, { reason: "sender-bot.not-found" })
  return { ...found, moves: movesOf(database, bot) }
}

/** The sender bots, by name; a bot a build before version 75 sorted shows once a list has settled it. */
export const listBots = (database: CacheDatabase, options: BotListOptions): BotList => {
  const { limit, offset = 0 } = options
  const where = [HOLDS]
  const params: SqlValue[] = []
  if (options.query !== undefined) {
    const text = options.query.trim()
    if (text.length < MIN_QUERY)
      throw new CliError(
        "validation_error",
        `a bots search takes at least ${MIN_QUERY} characters, got "${options.query}"`,
        { reason: "query.short-text" },
      )
    const like = (form: string) => `%${form.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    where.push(
      "(b.name LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM sender_bot_identities s JOIN identities i ON " +
        "i.id = s.identity_id WHERE s.bot_id = b.id AND (i.name_folded LIKE ? ESCAPE '\\' " +
        "OR i.external_id LIKE ? ESCAPE '\\' OR i.username LIKE ? ESCAPE '\\')))",
    )
    params.push(like(text), like(fold(text)), like(text), like(text))
  }
  if (options.organization !== undefined) {
    const id = options.organization.startsWith("organization:")
      ? options.organization.slice("organization:".length)
      : ""
    if (!/^[1-9]\d*$/.test(id))
      throw new CliError("validation_error", `an organization is organization:<id>, got "${options.organization}"`)
    where.push("b.organization_id = ?")
    params.push(Number(id))
  }
  return read(database, () => {
    const filter = where.join(" AND ")
    const total = Number(database.prepare(`SELECT count(*) AS n FROM sender_bots b WHERE ${filter}`).get(...params)?.n)
    const ids = database
      .prepare(`SELECT b.id FROM sender_bots b WHERE ${filter} ORDER BY ${SHOWN} COLLATE NOCASE, b.id LIMIT ? OFFSET ?`)
      .all(...params, limit, offset)
      .map((row) => Number(row.id))
    return { items: botsOf(database, ids), hasMore: total > offset + limit, total }
  })
}

/** One sender bot with its identities and every move to or from it. */
export const showBot = (database: CacheDatabase, ref: string): SenderBotDetails =>
  read(database, () => detailsOf(database, botIdOf(database, ref)))

/**
 * The owner's word that a person, a bot or one identity is a program, for its whole history: its messages stay where
 * they are, and no rule gives it back. `bot` joins it to a stored bot; else a bot that already holds it keeps it, or a
 * new one takes it. A person every identity left is hidden, and a move back gives their uid back.
 */
export const moveToBot = (
  context: StoreContext,
  subject: string | IdentityRef,
  options: { bot?: string; name?: string; reason?: string } = {},
): SenderBotDetails => {
  const { database } = context
  return write(database, () => {
    const at = context.now()
    settleLegacyBots(database, at)
    const log = { author: "owner" as const, reason: options.reason ?? null, at }
    const chosen = subjectOf(database, subject)
    const people = new Set(chosen.identities.flatMap((one) => holderOf(database, one).person ?? []))
    if ([...people].some((person) => isOwner(context, person)))
      throw new CliError("validation_error", "the owner's own person is never a bot", { reason: "sender-bot.owner" })
    if (chosen.identities.length === 0)
      throw new CliError("validation_error", `${String(subject)} holds no identity to move`, {
        reason: "sender-bot.empty",
      })
    const held = new Set(chosen.identities.flatMap((one) => holderOf(database, one).bot ?? []))
    const target =
      options.bot !== undefined
        ? botIdOf(database, options.bot)
        : (chosen.bot ?? (held.size === 1 && people.size === 0 ? [...held][0] : undefined))
    const bot = target ?? createBot(database, log, options.name ?? null)
    database
      .prepare("UPDATE sender_bots SET author = 'owner', name = coalesce(?, name), updated_at = ? WHERE id = ?")
      .run(options.name ?? null, at, bot)
    const left = intoBot(database, chosen.identities, bot, log)
    for (const [person, gone] of left)
      if (identitiesOf(database, person).length > 0) renameAfterLeaving(context, person, gone)
    groupByDomain(database, [{ id: bot, displayName: options.name ?? null, holds: true, bot: true }], at)
    return detailsOf(database, bot)
  })
}

/**
 * The owner's word that a bot, a person or one identity is a person, for its whole history; no rule makes it a bot
 * again. `person` takes it; else each identity goes back to the person it came from, or a person of its own. Said of a
 * person, it keeps them one. Answers the person the first identity is on.
 */
export const moveToPerson = (
  context: StoreContext,
  subject: string | IdentityRef,
  options: { person?: string; reason?: string } = {},
): PersonRecord => {
  const { database } = context
  return write(database, () => {
    const at = context.now()
    settleLegacyBots(database, at)
    const log = { author: "owner" as const, reason: options.reason ?? null, at }
    const chosen = subjectOf(database, subject)
    const target = options.person === undefined ? undefined : personIdOf(database, options.person)
    if (chosen.identities.length === 0)
      throw new CliError("validation_error", `${String(subject)} holds no identity to move`, {
        reason: "sender-bot.empty",
      })
    if (chosen.person !== undefined && target !== undefined && target !== chosen.person) {
      for (const identity of chosen.identities)
        logMove(database, identity, { person: chosen.person }, { person: target }, log)
      mergePerson(context, chosen.person, target, { method: "manual", by: "owner" })
      return recordOf(context, target)
    }
    const went = outOfBot(database, chosen.identities, target, log)
    for (const identity of chosen.identities) {
      if (went.has(identity)) continue
      const person = holderOf(database, identity).person
      if (person === undefined) continue
      const to = target ?? person
      if (to !== person) {
        move(context, identity, person, to, { method: "manual", by: "owner" })
        renameAfterLeaving(context, person, [identity])
      }
      logMove(database, identity, { person }, { person: to }, log)
      went.set(identity, to)
    }
    releaseDomainHolds(database, chosen.identities)
    const first = went.get(chosen.identities[0] as number)
    return recordOf(context, first ?? target ?? (chosen.person as number))
  })
}
