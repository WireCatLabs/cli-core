import { SENDER_BOT_PREFIX } from "../../domain/person-kinds.js"
import type { MailType } from "../../mail/mail-types.js"
import type { CacheDatabase, SqlValue } from "../driver.js"
import { typeWhere } from "./email-types.js"
import { LIST_ID } from "./sender-signals.js"
import { read } from "./transaction.js"

/** Where an unsubscribe goes, as the newest mail of a subscription that names one gave it. @experimental */
export interface UnsubscribeTarget {
  /** The https target of List-Unsubscribe. */
  https: string | null
  /** The mailto target of List-Unsubscribe. */
  mailto: string | null
  /**
   * RFC 8058 one-click: the mail also carries `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, and its From
   * domain signed both fields, so a POST to `https` unsubscribes without opening a page.
   */
  oneClick: boolean
  /** The mail the target was read from. */
  emailId: number
}

/** One list, or one sender of broadcast mail with no List-Id: a row of Subscriptions. @experimental */
export interface MailSubscription {
  /** `list:<List-Id>`, else the sender: `bot:<id>`, `person:<id>` or `address:<address>`. */
  key: string
  listId: string | null
  /** The display name on its newest email, else its address. */
  name: string | null
  /** Who sent its newest email: `bot:<id>`, `person:<id>`, or `null` when the address is linked to neither. */
  sender: string | null
  /** The From address of its newest email, lower case. */
  address: string | null
  /** Its broadcast emails the filter takes in. */
  emails: number
  newest: { id: number; externalId: string; subject: string | null; at: number | null }
  /** `null` when none of its emails names a target its sender's DKIM signature vouches for. */
  unsubscribe: UnsubscribeTarget | null
}

/** @experimental */
export interface MailSubscriptionFilter {
  /** Only mail of these accounts; every account when left out. */
  accountIds?: readonly number[]
  since?: number
  /** Exclusive. */
  until?: number
  /** Only emails of these types: the promotions of a shop, without its receipts. */
  types?: readonly MailType[]
  limit?: number
  offset?: number
}

/** @experimental */
export interface MailSubscriptionList {
  items: MailSubscription[]
  total: number
  hasMore: boolean
}

const LIMIT = 100

const HTTPS = "json_extract(e.headers, '$.\"list-unsubscribe-https\"')"
const MAILTO = "json_extract(e.headers, '$.\"list-unsubscribe-mailto\"')"

const KEY =
  `CASE WHEN ${LIST_ID} IS NOT NULL THEN 'list:' || ${LIST_ID} ` +
  `WHEN b.bot_id IS NOT NULL THEN '${SENDER_BOT_PREFIX}' || b.bot_id ` +
  "WHEN l.person_id IS NOT NULL THEN 'person:' || l.person_id " +
  "ELSE 'address:' || lower(e.from_address) END"

const SENDERS =
  "FROM emails e LEFT JOIN sender_bot_identities b ON b.identity_id = e.from_identity_id " +
  "LEFT JOIN identity_links l ON l.identity_id = e.from_identity_id AND b.bot_id IS NULL"

/** The bare `id` is the row of `max(at)`, SQLite's rule for a bare column beside a single max(). */
const groupsSql = (where: string) =>
  `SELECT key, count(*) AS emails, max(at) AS last, id AS newest, count(*) OVER () AS total FROM ` +
  `(SELECT e.id, coalesce(e.received_at, e.sent_at) AS at, ${KEY} AS key ${SENDERS} WHERE ${where}) ` +
  "GROUP BY key ORDER BY last DESC, key LIMIT ? OFFSET ?"

const EMAILS =
  `SELECT e.id, e.external_id, e.subject, lower(e.from_address) AS address, e.from_name, ${LIST_ID} AS list, ` +
  `coalesce(e.received_at, e.sent_at) AS at, ${HTTPS} AS https, ${MAILTO} AS mailto, e.from_identity_id, ` +
  "json_extract(e.headers, '$.\"list-unsubscribe-post\"') IS 1 AS post, b.bot_id, l.person_id " +
  `${SENDERS} WHERE e.id IN (SELECT value FROM json_each(?))`

/**
 * Where a group's mail comes from, through an index: its List-Id, or its sender's identities and no List-Id. A target
 * belongs to the list or the sender, so any of its mail in these accounts may name it, whatever its type or date. The
 * `+` keeps SQLite off `emails_by_list_id` for "no List-Id", which holds most of the mail: 10 ms a group, not 0.05.
 */
const SOURCES = {
  list: `${LIST_ID} = ?`,
  bot: `e.from_identity_id IN (SELECT identity_id FROM sender_bot_identities WHERE bot_id = ?) AND +${LIST_ID} IS NULL`,
  person: `e.from_identity_id IN (SELECT identity_id FROM identity_links WHERE person_id = ?) AND +${LIST_ID} IS NULL`,
  address: `e.from_identity_id = ? AND +${LIST_ID} IS NULL`,
} as const

const sourceOf = (newest: Record<string, unknown>): [keyof typeof SOURCES, SqlValue] | undefined =>
  typeof newest.list === "string"
    ? ["list", newest.list]
    : newest.bot_id != null
      ? ["bot", Number(newest.bot_id)]
      : newest.person_id != null
        ? ["person", Number(newest.person_id)]
        : newest.from_identity_id != null
          ? ["address", Number(newest.from_identity_id)]
          : undefined

const str = (value: unknown): string | null => (typeof value === "string" ? value : null)

/**
 * Broadcast mail grouped by List-Id, else by its sender, newest group first, grouped, counted and paged in SQL. Each
 * group carries its newest email and the unsubscribe target of its newest email that names one.
 */
export const mailSubscriptions = (database: CacheDatabase, filter: MailSubscriptionFilter): MailSubscriptionList => {
  const limit = filter.limit ?? LIMIT
  const offset = filter.offset ?? 0
  const typed = typeWhere(database, { reaches: ["broadcast"], ...(filter.types ? { types: filter.types } : {}) })
  const where = ["e.deleted_at IS NULL", "e.outgoing IS NOT 1", "e.from_address IS NOT NULL", ...typed.sql]
  const params: SqlValue[] = [...typed.params]
  const add = (sql: string, value: number | undefined) => {
    if (value === undefined) return
    where.push(sql)
    params.push(value)
  }
  if (filter.accountIds !== undefined) {
    where.push("e.account_id IN (SELECT value FROM json_each(?))")
    params.push(JSON.stringify(filter.accountIds))
  }
  add("coalesce(e.received_at, e.sent_at) >= ?", filter.since)
  add("coalesce(e.received_at, e.sent_at) < ?", filter.until)
  return read(database, () => {
    const groups = database.prepare(groupsSql(where.join(" AND "))).all(...params, limit, offset)
    const total =
      groups.length > 0
        ? Number(groups[0]?.total)
        : offset === 0
          ? 0
          : Number(
              database
                .prepare(`SELECT count(DISTINCT ${KEY}) AS n ${SENDERS} WHERE ${where.join(" AND ")}`)
                .get(...params)?.n,
            )
    const emailsOf = (ids: number[]) =>
      new Map(
        database
          .prepare(EMAILS)
          .all(JSON.stringify(ids))
          .map((row) => [Number(row.id), row]),
      )
    const newestOf = emailsOf(groups.map((group) => Number(group.newest)))
    const accounts = filter.accountIds === undefined ? "" : " AND e.account_id IN (SELECT value FROM json_each(?))"
    const targetSql = (source: string) =>
      `SELECT e.id FROM emails e WHERE ${source} AND e.deleted_at IS NULL AND e.outgoing IS NOT 1${accounts} ` +
      `AND (${HTTPS} IS NOT NULL OR ${MAILTO} IS NOT NULL) ORDER BY coalesce(e.received_at, e.sent_at) DESC, e.id DESC LIMIT 1`
    const statements = new Map<string, ReturnType<CacheDatabase["prepare"]>>()
    const targetIdOf = (newest: Record<string, unknown> | undefined): number | undefined => {
      const source = newest === undefined ? undefined : sourceOf(newest)
      if (source === undefined) return undefined
      const [kind, value] = source
      const statement = statements.get(kind) ?? database.prepare(targetSql(SOURCES[kind]))
      statements.set(kind, statement)
      const found = statement.get(
        value,
        ...(filter.accountIds === undefined ? [] : [JSON.stringify(filter.accountIds)]),
      )
      return found === undefined ? undefined : Number(found.id)
    }
    const targets = groups.map((group) => targetIdOf(newestOf.get(Number(group.newest))))
    const targetOf = emailsOf(targets.filter((id) => id !== undefined))
    const items = groups.map((group, at): MailSubscription => {
      const newest = newestOf.get(Number(group.newest)) ?? {}
      const targetId = targets[at]
      const target = targetId === undefined ? undefined : targetOf.get(targetId)
      const https = str(target?.https)
      return {
        key: String(group.key),
        listId: str(newest.list),
        name: str(newest.from_name) ?? str(newest.address),
        sender:
          newest.bot_id != null
            ? `${SENDER_BOT_PREFIX}${newest.bot_id}`
            : newest.person_id != null
              ? `person:${newest.person_id}`
              : null,
        address: str(newest.address),
        emails: Number(group.emails),
        newest: {
          id: Number(group.newest),
          externalId: String(newest.external_id),
          subject: str(newest.subject),
          at: newest.at == null ? null : Number(newest.at),
        },
        unsubscribe:
          target === undefined
            ? null
            : {
                https,
                mailto: str(target.mailto),
                oneClick: https !== null && Number(target.post) === 1,
                emailId: Number(target.id),
              },
      }
    })
    return { items, total, hasMore: total > offset + groups.length }
  })
}

/** @experimental */
export interface MailSubscriptionStore {
  /**
   * Subscriptions: broadcast mail grouped by List-Id, else by sender, newest first, each with its mail count, newest
   * email and unsubscribe target. Nothing is unsubscribed.
   */
  subscriptions(filter?: MailSubscriptionFilter): Promise<MailSubscriptionList>
}

export const mailSubscriptionStore = (database: CacheDatabase): MailSubscriptionStore => ({
  subscriptions: async (filter = {}) => mailSubscriptions(database, filter),
})
