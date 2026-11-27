import type { Sector } from "../../domain/organization-sectors.js"
import { SENDER_BOT_PREFIX } from "../../domain/person-kinds.js"
import { listIdOf } from "../../mail/headers.js"
import { MAIL_TYPES, type MailType, type MailTypeOf, mailTypeOf, schemaTypesOf } from "../../mail/mail-types.js"
import { sortRuleFor } from "../../mail/sort-rules.js"
import { type CacheDatabase, isQueryOnly } from "../driver.js"
import { typeRulesOf } from "./mail-sorting.js"
import { NEWSLETTER_ONLY } from "./sender-bots.js"
import { LIST_ID, LIST_SENDERS, REACHES, type Reach, senderKey } from "./sender-signals.js"
import { read, writeBatch } from "./transaction.js"

/** Bump when what decides a mail type changes in code: every stored one is worked out again on the next read. */
const TYPE_RULES = "1"
const RULES_KEY = "mail.type_rules"
/**
 * Working out 5,000 types takes about 40 ms; the commit's sync to disk costs more, so fewer and larger batches finish
 * sooner and still hold the lock well inside another writer's 5 s wait.
 */
const BATCH = 5_000

const INPUTS =
  "SELECT e.id, e.from_address, e.subject, e.headers, e.body_html, e.outgoing, " +
  "coalesce(e.received_at, e.sent_at) AS at, " +
  `${LIST_ID} AS list, ` +
  "CASE WHEN json_extract(e.metadata, '$.rule') IS NOT NULL THEN NULL ELSE " +
  "(SELECT count(*) FROM email_recipients r WHERE r.email_id = e.id AND r.role IN ('to', 'cc')) END AS recipients, " +
  "(SELECT json_group_array(lower(a.mime)) FROM attachments a " +
  "WHERE a.attachable_type = 'email' AND a.attachable_id = e.id AND a.mime IS NOT NULL) AS parts, " +
  "e.outgoing IS 1 OR EXISTS (SELECT 1 FROM email_recipients r JOIN emails o ON o.id = r.email_id " +
  "WHERE r.identity_id = e.from_identity_id AND o.outgoing = 1) AS owner_wrote, " +
  "EXISTS (SELECT 1 FROM sender_bot_identities b JOIN sender_bots s ON s.id = b.bot_id " +
  `WHERE b.identity_id = e.from_identity_id AND s.reason IS NOT '${NEWSLETTER_ONLY}') AS bot, ` +
  "(SELECT json_extract(g.metadata, '$.sector') FROM organization_identities oi " +
  "JOIN organizations g ON g.id = oi.organization_id " +
  "WHERE oi.identity_id = e.from_identity_id AND g.deleted_at IS NULL ORDER BY g.id LIMIT 1) AS sector " +
  "FROM emails e WHERE e.id IN (SELECT value FROM json_each(?))"

const parsed = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "string") return {}
  try {
    const found: unknown = JSON.parse(value)
    return found !== null && typeof found === "object" && !Array.isArray(found)
      ? (found as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/** The type, reach and signal of each of these emails, worked out from the store; nothing is written. */
/**
 * `senders` carries each List-Id's sender count from batch to batch: a newsletter's every issue would read all its
 * issues again.
 */
export const typesOf = (
  database: CacheDatabase,
  ids: readonly number[],
  senders = new Map<string, number>(),
): Map<number, MailTypeOf> => {
  const found = new Map<number, MailTypeOf>()
  if (ids.length === 0) return found
  const rows = database.prepare(INPUTS).all(JSON.stringify(ids))
  const rules = typeRulesOf(database)
  const lists = [
    ...new Set(rows.flatMap((row) => (typeof row.list === "string" && !senders.has(row.list) ? [row.list] : []))),
  ]
  if (lists.length > 0) {
    const held = new Map<string, Set<string>>(lists.map((list) => [list, new Set<string>()]))
    for (const row of database.prepare(LIST_SENDERS).all(JSON.stringify(lists)))
      held.get(String(row.list))?.add(senderKey(String(row.address)))
    for (const [list, addresses] of held) senders.set(list, addresses.size)
  }
  for (const row of rows) {
    const headers = parsed(row.headers)
    const from = typeof row.from_address === "string" ? row.from_address.toLowerCase() : null
    const typed = mailTypeOf({
      from,
      subject: typeof row.subject === "string" ? row.subject : null,
      headers: typeof row.list === "string" ? { ...headers, "list-id": row.list } : headers,
      recipients: row.recipients == null ? null : Number(row.recipients),
      parts: JSON.parse(String(row.parts ?? "[]")) as string[],
      schemaTypes: [
        ...new Set([
          ...schemaTypesOf(typeof row.body_html === "string" ? row.body_html : null),
          ...(Array.isArray(headers["schema-types"]) ? headers["schema-types"].map(String) : []),
        ]),
      ],
      listSenders: typeof row.list === "string" ? (senders.get(row.list) ?? 0) : 0,
      ownerWrote: Number(row.owner_wrote) === 1,
      bot: Number(row.bot) === 1,
      sector: typeof row.sector === "string" ? (row.sector as Sector) : null,
    })
    const rule =
      Number(row.outgoing) === 1
        ? undefined
        : sortRuleFor(rules, {
            id: Number(row.id),
            from,
            subject: typeof row.subject === "string" ? row.subject : null,
            list: typeof row.list === "string" ? (listIdOf(row.list) ?? null) : null,
            at: row.at == null ? null : Number(row.at),
          })
    found.set(
      Number(row.id),
      rule?.mailType == null ? typed : { ...typed, type: rule.mailType, signal: `rule:${rule.id}` },
    )
  }
  return found
}

const rulesOf = (database: CacheDatabase): string | undefined => {
  const row = database.prepare("SELECT value FROM store_settings WHERE key = ?").get(RULES_KEY)
  return row === undefined ? undefined : String(row.value)
}

const anyLeft = (database: CacheDatabase): boolean =>
  database.prepare("SELECT 1 FROM emails WHERE mail_type IS NULL LIMIT 1").get() !== undefined

const UNCHECKED = "SELECT id FROM emails WHERE mail_type IS NOT NULL AND sort_checked IS NULL"

/** A type a build before version 77 kept, while a sorting rule exists that it never read. */
const anyUnchecked = (database: CacheDatabase): boolean =>
  typeRulesOf(database).size > 0 && database.prepare(`${UNCHECKED} LIMIT 1`).get() !== undefined

/** Whether every email's stored type is current. */
export const typesCurrent = (database: CacheDatabase): boolean =>
  rulesOf(database) === TYPE_RULES && !anyLeft(database) && !anyUnchecked(database)

/**
 * Works out and keeps the type of every email whose stored one the triggers cleared, or every email after the rules
 * changed, a batch per write so another process never waits long for the lock. A query-only open keeps nothing.
 * Answers whether every stored type is current.
 */
export const storeMailTypes = (database: CacheDatabase, until: () => boolean = () => false): boolean => {
  if (isQueryOnly(database)) return typesCurrent(database)
  if (rulesOf(database) !== TYPE_RULES)
    writeBatch(database, () => {
      if (rulesOf(database) === TYPE_RULES) return
      database
        .prepare("UPDATE emails SET mail_type = NULL, reach = NULL, type_signal = NULL WHERE mail_type IS NOT NULL")
        .run()
      database
        .prepare(
          "INSERT INTO store_settings (key, value, at) VALUES (?, ?, ?) " +
            "ON CONFLICT (key) DO UPDATE SET value = excluded.value, at = excluded.at",
        )
        .run(RULES_KEY, TYPE_RULES, Date.now())
    })
  if (anyUnchecked(database)) {
    const clear = database.prepare(
      `UPDATE emails SET mail_type = NULL, reach = NULL, type_signal = NULL WHERE id IN (${UNCHECKED} LIMIT ?)`,
    )
    while (writeBatch(database, () => clear.run(BATCH).changes) === BATCH);
  }
  const keep = database.prepare(
    "UPDATE emails SET mail_type = ?, reach = ?, type_signal = ?, sort_checked = 1 WHERE id = ?",
  )
  const senders = new Map<string, number>()
  for (;;) {
    if (until()) return false
    const more = writeBatch(database, () => {
      const ids = database
        .prepare("SELECT id FROM emails WHERE mail_type IS NULL LIMIT ?")
        .all(BATCH)
        .map((row) => Number(row.id))
      for (const [id, { type, reach, signal }] of typesOf(database, ids, senders)) keep.run(type, reach, signal, id)
      return ids.length === BATCH
    })
    if (!more) return true
  }
}

/** How many emails whose type was cleared before this save one save also types: the rest fill as mail syncs. */
const BACKLOG_ON_SAVE = 500

/**
 * Types the mail of these threads inside the save's own write, plus a little of what is untyped from before: a
 * read-only open cannot keep types, so a store typed only by its first search made that search work out every email
 * (1.5–1.8 s of a 2 s limit on 100,000, cli-testing performance/mail/types). Skipped while a rules change waits to
 * clear the stored types: those are typed again in batches by the next filtered read.
 */
export const typeSavedMail = (database: CacheDatabase, threadIds: readonly number[]): void => {
  if (rulesOf(database) !== TYPE_RULES) {
    if (database.prepare("SELECT 1 FROM emails WHERE mail_type IS NOT NULL LIMIT 1").get() !== undefined) return
    database
      .prepare(
        "INSERT INTO store_settings (key, value, at) VALUES (?, ?, ?) " +
          "ON CONFLICT (key) DO UPDATE SET value = excluded.value, at = excluded.at",
      )
      .run(RULES_KEY, TYPE_RULES, Date.now())
  }
  const ids = (sql: string, param: string | number) =>
    database
      .prepare(sql)
      .all(param)
      .map((row) => Number(row.id))
  const untyped = new Set([
    ...ids(
      "SELECT id FROM emails WHERE email_thread_id IN (SELECT value FROM json_each(?)) AND mail_type IS NULL",
      JSON.stringify(threadIds),
    ),
    ...ids("SELECT id FROM emails WHERE mail_type IS NULL LIMIT ?", BACKLOG_ON_SAVE),
  ])
  const keep = database.prepare(
    "UPDATE emails SET mail_type = ?, reach = ?, type_signal = ?, sort_checked = 1 WHERE id = ?",
  )
  for (const [id, { type, reach, signal }] of typesOf(database, [...untyped])) keep.run(type, reach, signal, id)
}

/** Each email's stored type, or for one the store has not typed yet, the type worked out for this read. */
export const withTypes = <T extends { id: number; mailType: MailType | null }>(
  database: CacheDatabase,
  emails: T[],
): T[] => {
  const missing = emails.filter((email) => email.mailType === null).map((email) => email.id)
  if (missing.length === 0) return emails
  const found = read(database, () => typesOf(database, missing))
  return emails.map((email) => {
    const typed = found.get(email.id)
    return typed === undefined
      ? email
      : { ...email, mailType: typed.type, reach: typed.reach, typeSignal: typed.signal }
  })
}

/** Which emails a filter by type and reach keeps. @experimental */
export interface TypeFilter {
  types?: readonly MailType[]
  reaches?: readonly Reach[]
}

const passes = (filter: TypeFilter, type: string, reach: string) =>
  (filter.types === undefined || (filter.types as readonly string[]).includes(type)) &&
  (filter.reaches === undefined || (filter.reaches as readonly string[]).includes(reach))

/**
 * The SQL of a filter by type and reach over `e`. Types are worked out and kept first; a query-only open that finds
 * some not worked out works those out in memory, so a filtered list is never short.
 */
export const typeWhere = (database: CacheDatabase, filter: TypeFilter): { sql: string[]; params: string[] } =>
  filter.types === undefined && filter.reaches === undefined
    ? { sql: [], params: [] }
    : typeCondition(database, filter, storeMailTypes(database))

/**
 * What one connection last worked out for the mail not typed yet, while nothing has changed the store: a search runs
 * this filter for its page and again for its total, and an MCP server's read-only open searches many times.
 */
const worked = new WeakMap<CacheDatabase, { version: string; types: Map<number, MailTypeOf> }>()

/** `data_version` moves when another connection commits, `total_changes()` when this one writes. */
const versionOf = (database: CacheDatabase): string =>
  `${Object.values(database.prepare("PRAGMA data_version").get() ?? {})[0]}:` +
  `${Object.values(database.prepare("SELECT total_changes()").get() ?? {})[0]}`

const untypedOf = (database: CacheDatabase, check: () => void): Map<number, MailTypeOf> => {
  const version = versionOf(database)
  const known = worked.get(database)
  if (known?.version === version) return known.types
  const ids = database
    .prepare("SELECT id FROM emails WHERE mail_type IS NULL")
    .all()
    .map((row) => Number(row.id))
  const types = new Map<number, MailTypeOf>()
  const senders = new Map<string, number>()
  for (let at = 0; at < ids.length; at += BATCH) {
    check()
    for (const [id, typed] of typesOf(database, ids.slice(at, at + BATCH), senders)) types.set(id, typed)
  }
  worked.set(database, { version, types })
  return types
}

/**
 * The same filter, without writing: inside a read, the mail not typed yet is worked out in memory. `check` runs
 * between batches, so a search's time limit still stops it.
 */
export const typeCondition = (
  database: CacheDatabase,
  filter: TypeFilter,
  current = typesCurrent(database),
  check: () => void = () => {},
): { sql: string[]; params: string[] } => {
  if (filter.types === undefined && filter.reaches === undefined) return { sql: [], params: [] }
  const stored = [
    ...(filter.types === undefined ? [] : ["e.mail_type IN (SELECT value FROM json_each(?))"]),
    ...(filter.reaches === undefined ? [] : ["e.reach IN (SELECT value FROM json_each(?))"]),
  ].join(" AND ")
  const params = [
    ...(filter.types === undefined ? [] : [JSON.stringify(filter.types)]),
    ...(filter.reaches === undefined ? [] : [JSON.stringify(filter.reaches)]),
  ]
  if (current) return { sql: [stored], params }
  const pending = read(database, () => {
    const kept: number[] = []
    for (const [id, typed] of untypedOf(database, check)) if (passes(filter, typed.type, typed.reach)) kept.push(id)
    return kept
  })
  return {
    sql: [`((${stored}) OR e.id IN (SELECT value FROM json_each(?)))`],
    params: [...params, JSON.stringify(pending)],
  }
}

/** One sender's mail, counted by type and reach: a shop's receipts and its sales side by side. @experimental */
export interface SenderMailTypes {
  /** `person:<id>`, `bot:<id>`, or `null` when the store links the address to neither. */
  ref: string | null
  /** The addresses it sent from, lower case. */
  addresses: string[]
  /** The display name on its newest email. */
  name: string | null
  /** Its live emails the filter's account and time take in. */
  emails: number
  types: Partial<Record<MailType, number>>
  reaches: Partial<Record<Reach, number>>
  /** Its newest email, ms. */
  lastAt: number | null
}

/** Which senders `mailSenders` lists: those with at least one email of these types and reaches. @experimental */
export interface SenderTypesFilter extends TypeFilter {
  accountId?: number
  since?: number
  until?: number
  limit?: number
  offset?: number
}

const SENDER_ROWS =
  "SELECT e.id, lower(e.from_address) AS address, e.from_name AS name, e.mail_type, e.reach, " +
  "coalesce(e.received_at, e.sent_at) AS at, b.bot_id, l.person_id " +
  "FROM emails e LEFT JOIN sender_bot_identities b ON b.identity_id = e.from_identity_id " +
  "LEFT JOIN identity_links l ON l.identity_id = e.from_identity_id AND b.bot_id IS NULL " +
  "WHERE e.deleted_at IS NULL AND e.outgoing IS NOT 1 AND e.from_address IS NOT NULL"

interface Tally extends SenderMailTypes {
  matched: boolean
}

/**
 * Every sender of incoming mail with its mail counted by type and reach, most mail first. A sender is listed when
 * any of its emails passes `types` and `reaches`, and its counts cover all its mail: Subscriptions shows a shop by
 * its sales and still says it also sends receipts.
 */
export const mailSenders = (
  database: CacheDatabase,
  filter: SenderTypesFilter,
): { items: SenderMailTypes[]; total: number } => {
  const complete = storeMailTypes(database)
  const where: string[] = []
  const params: number[] = []
  const add = (sql: string, value: number | undefined) => {
    if (value === undefined) return
    where.push(sql)
    params.push(value)
  }
  add("e.account_id = ?", filter.accountId)
  add("coalesce(e.received_at, e.sent_at) >= ?", filter.since)
  add("coalesce(e.received_at, e.sent_at) < ?", filter.until)
  const rows = read(database, () => {
    const all = database.prepare([SENDER_ROWS, ...where].join(" AND ")).all(...params)
    if (complete) return all
    const missing = all.filter((row) => row.mail_type == null).map((row) => Number(row.id))
    const found = new Map<number, MailTypeOf>()
    const senders = new Map<string, number>()
    for (let at = 0; at < missing.length; at += BATCH)
      for (const [id, typed] of typesOf(database, missing.slice(at, at + BATCH), senders)) found.set(id, typed)
    return all.map((row) => {
      const typed = found.get(Number(row.id))
      return typed === undefined ? row : { ...row, mail_type: typed.type, reach: typed.reach }
    })
  })
  const tallies = new Map<string, Tally>()
  for (const row of rows) {
    const address = String(row.address)
    const ref =
      row.bot_id != null
        ? `${SENDER_BOT_PREFIX}${row.bot_id}`
        : row.person_id != null
          ? `person:${row.person_id}`
          : null
    const key = ref ?? `address:${address}`
    const at = row.at == null ? null : Number(row.at)
    const tally = tallies.get(key) ?? {
      ref,
      addresses: [],
      name: null,
      emails: 0,
      types: {},
      reaches: {},
      lastAt: null,
      matched: false,
    }
    const type = String(row.mail_type) as MailType
    const reach = String(row.reach) as Reach
    if (!tally.addresses.includes(address)) tally.addresses.push(address)
    if (at !== null && (tally.lastAt === null || at >= tally.lastAt)) {
      tally.lastAt = at
      tally.name = typeof row.name === "string" ? row.name : tally.name
    }
    tally.emails += 1
    tally.types[type] = (tally.types[type] ?? 0) + 1
    tally.reaches[reach] = (tally.reaches[reach] ?? 0) + 1
    if (passes(filter, type, reach)) tally.matched = true
    tallies.set(key, tally)
  }
  const listed = [...tallies.values()]
    .filter((tally) => tally.matched)
    .sort((a, b) => b.emails - a.emails || (b.lastAt ?? 0) - (a.lastAt ?? 0))
    .map(({ matched: _, ...tally }) => ({
      ...tally,
      addresses: tally.addresses.sort(),
      types: ordered(tally.types, MAIL_TYPES),
      reaches: ordered(tally.reaches, REACHES),
    }))
  const offset = filter.offset ?? 0
  return {
    items: listed.slice(offset, filter.limit === undefined ? undefined : offset + filter.limit),
    total: listed.length,
  }
}

const ordered = <K extends string>(counts: Partial<Record<K, number>>, order: readonly K[]) =>
  Object.fromEntries(order.flatMap((key) => (counts[key] === undefined ? [] : [[key, counts[key]]]))) as Partial<
    Record<K, number>
  >

/** @experimental */
export interface MailTypeStore {
  /**
   * Indexes and types every email still waiting for it, a short write at a time, until `until` answers true. Mail sync
   * calls it once it has saved, so the first search, also on a read-only open, finds the work done.
   */
  catchUp(until?: () => boolean): Promise<void>
  /**
   * Senders of incoming mail with their mail counted by type and reach, most mail first; a sender is listed when any of
   * its emails passes `types` and `reaches`.
   */
  mailSenders(filter?: SenderTypesFilter): Promise<{ items: SenderMailTypes[]; total: number }>
}

export const mailTypeStore = (database: CacheDatabase): Omit<MailTypeStore, "catchUp"> => ({
  mailSenders: async (filter = {}) => mailSenders(database, filter),
})
