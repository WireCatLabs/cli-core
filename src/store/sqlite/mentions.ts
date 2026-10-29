import { CliError } from "@wirecat/cli-base"
import { defineQuery, type QueryAst } from "@wirecat/cli-base/query"
import { type Decider, MENTION_KINDS, type MentionKind, siteOf } from "../../domain/mentions.js"
import { findNames, nameIndex } from "../../domain/person-names.js"
import { createStemmer } from "../../search/stem.js"
import type { CacheDatabase, SqlValue } from "../driver.js"
import { mentionText } from "./lucene-fields.js"
import {
  knownPeople,
  participants,
  SOURCE_TYPES,
  SOURCES,
  type SourceType,
  sourceOf,
  telegramLink,
  writer,
} from "./mention-drain.js"
import type { StoreContext } from "./open.js"
import { linkIdentityToPerson, personByUid } from "./person-links.js"
import { valueMatch } from "./phone-countries.js"
import { placeOf } from "./place-key.js"
import { type ColumnMap, queryFilter } from "./query-filter.js"
import { writeBatch } from "./transaction.js"

/** A stored mention of a message's text, with what `mentions list` and `show` need to point at it. */
export interface StoredMention {
  id: number
  kind: MentionKind
  value: string
  domain: string | null
  confidence: number
  status: MentionStatus
  /** Which text of the message: `text`, a file's `file_text`, a voice note's `transcript`, or a shared card's `contact`. */
  field: string
  /** Who linked or dismissed it: `owner`, an agent by name, `rules` for a value that already had an owner. */
  author: string | null
  /** What it names once linked: `identity:12`, `document:7`, `person:3`. */
  target: string | null
  /** The message it was found in: its chat's and its own id in the messenger. */
  chatId: string
  messageId: string
  sentAt: string
  /** When the rules first found it here; a rebuild keeps it. `mentions list --new` starts after the last one shown. */
  foundAt: string
  /** What was written, read back from the message: never copied into the mention. */
  written: string
}

export const MENTION_STATUSES = ["found", "linked", "dismissed"] as const
export type MentionStatus = (typeof MENTION_STATUSES)[number]

/** The fields of `mentions list`; a bare word is a `value`. */
export const MENTION_QUERY = defineQuery({
  entity: "mention",
  backend: "sql",
  fields: [
    { name: "kind", type: "enum", values: [...MENTION_KINDS], operators: ["term"], example: "kind:phone" },
    { name: "status", type: "enum", values: [...MENTION_STATUSES], operators: ["term"], example: "status:found" },
    {
      name: "domain",
      type: "kw",
      operators: ["term", "phrase"],
      example: "domain:google.com",
      relation: "the site of a link or an address; docs.google.com means google.com",
    },
    {
      name: "value",
      type: "kw",
      operators: ["term", "phrase"],
      example: 'value:"8 900 000-00-01"',
      relation: "the value in the form it is stored: a phone as +7…, a lower-case address, a link without tracking",
    },
  ],
})

export const columnsOf = (database: CacheDatabase): ColumnMap => ({
  kind: { type: "enum", sql: "mn.kind" },
  status: { type: "enum", sql: "mn.status" },
  domain: { where: (node) => ({ sql: "mn.domain = ?", params: [siteOf(node.value.toLowerCase())] }) },
  value: { where: (node) => valueMatch(database, node.value) },
})

export interface MentionsState {
  /** Messages written or edited since their mentions were found. */
  pending: number
  /** When `mentions rebuild` last read every stored message; `null` before the first. */
  rebuiltAt: string | null
}

export interface MentionsRebuild {
  messages: number
  /** Files and voice notes of messages whose text was read. */
  attachments: number
  documents: number
  notes: number
  emails: number
  mentions: number
}

const REBUILD_BATCH = 1000
const REBUILT_AT = "mentionsRebuiltAt"

/**
 * Finds the mentions of every stored message and attachment text again, in short write transactions. Decisions
 * stay: a linked or dismissed mention's status moves to the new row with the same kind and value. `kinds` redoes
 * only those.
 */
export const rebuildMentions = (
  database: CacheDatabase,
  {
    now,
    kinds,
    onBatch,
  }: { now: number; kinds?: readonly MentionKind[]; onBatch?: (done: number, total: number) => void },
): MentionsRebuild => {
  const total = SOURCE_TYPES.reduce((sum, type) => sum + Number(database.prepare(SOURCES[type].count).get()?.n), 0)
  const read: Record<SourceType, number> = { message: 0, attachment: 0, document: 0, note: 0, email: 0 }
  let mentions = 0
  for (const type of SOURCE_TYPES) {
    const batch = database.prepare(SOURCES[type].page)
    let after = 0
    for (;;) {
      const rows = batch.all(after, REBUILD_BATCH)
      if (rows.length === 0) break
      writeBatch(database, () => {
        const found = writer(database, now, kinds)
        const dequeue = database.prepare("DELETE FROM mention_pending WHERE source_type = ? AND source_id = ?")
        for (const row of rows) {
          mentions += found(type, Number(row.id), sourceOf(row))
          if (!kinds) dequeue.run(type, Number(row.id))
        }
      })
      read[type] += rows.length
      after = Number(rows.at(-1)?.id)
      onBatch?.(
        Object.values(read).reduce((sum, one) => sum + one, 0),
        total,
      )
    }
  }
  if (!kinds) {
    database
      .prepare(
        "INSERT INTO store_settings (key, value, at) VALUES (?, ?, ?) " +
          "ON CONFLICT (key) DO UPDATE SET value = excluded.value, at = excluded.at",
      )
      .run(REBUILT_AT, JSON.stringify(new Date(now).toISOString()), now)
  }
  return {
    messages: read.message,
    attachments: read.attachment,
    documents: read.document,
    notes: read.note,
    emails: read.email,
    mentions,
  }
}

export const mentionsState = (database: CacheDatabase): MentionsState => {
  const pending = Number(database.prepare("SELECT count(*) AS n FROM mention_pending").get()?.n)
  const row = database.prepare("SELECT value FROM store_settings WHERE key = ?").get(REBUILT_AT)
  return { pending, rebuiltAt: row ? (JSON.parse(String(row.value)) as string) : null }
}

// A mention in a file or a voice note belongs to that attachment's message, and is listed with it.
const SELECT =
  "SELECT mn.id, mn.kind, mn.value, mn.domain, mn.confidence, mn.status, mn.author, mn.source_field, " +
  "mn.target_type, mn.target_id, mn.created_at, " +
  "mn.start_offset, mn.end_offset, CASE WHEN mn.source_type = 'attachment' THEN " +
  mentionText("att") +
  " ELSE m.text END AS text, " +
  "m.external_id AS message_id, m.sent_at, m.chat_id AS chat_pk, c.external_id AS chat_id FROM mentions mn " +
  "LEFT JOIN attachments att ON mn.source_type = 'attachment' AND att.id = mn.source_id AND att.attachable_type = 'message' " +
  "JOIN messages m ON mn.source_type IN ('message', 'attachment') " +
  "AND m.id = CASE WHEN mn.source_type = 'attachment' THEN att.attachable_id ELSE mn.source_id END " +
  "AND m.deleted_at IS NULL JOIN chats c ON c.id = m.chat_id "

const stored = (row: Record<string, unknown>): StoredMention => ({
  id: Number(row.id),
  kind: String(row.kind) as MentionKind,
  value: String(row.value),
  domain: row.domain == null ? null : String(row.domain),
  confidence: Number(row.confidence),
  status: String(row.status) as MentionStatus,
  author: row.author == null ? null : String(row.author),
  target: row.target_id == null ? null : `${String(row.target_type)}:${Number(row.target_id)}`,
  field: String(row.source_field),
  chatId: String(row.chat_id),
  messageId: String(row.message_id),
  sentAt: new Date(Number(row.sent_at)).toISOString(),
  foundAt: new Date(Number(row.created_at)).toISOString(),
  written: String(row.text).slice(Number(row.start_offset), Number(row.end_offset)),
})

/** One account's mentions that match the query, newest message first. `limit` absent is every row. */
export const listMentions = (
  database: CacheDatabase,
  accountPk: number,
  query: QueryAst | undefined,
  { limit, offset, foundAfter }: { limit?: number; offset: number; foundAfter?: number },
): { items: StoredMention[]; hasMore: boolean } => {
  const where = ["m.account_id = ?"]
  const params: SqlValue[] = [accountPk]
  if (foundAfter !== undefined) {
    where.push("mn.created_at > ?")
    params.push(foundAfter)
  }
  if (query) {
    const compiled = queryFilter(query, columnsOf(database))
    if (compiled.sql) {
      where.push(`(${compiled.sql})`)
      params.push(...compiled.params)
    }
  }
  const rows = database
    .prepare(
      `${SELECT}WHERE ${where.join(" AND ")} ORDER BY m.sent_at DESC, m.id DESC, mn.start_offset, mn.id LIMIT ? OFFSET ?`,
    )
    .all(...params, limit === undefined ? -1 : limit + 1, offset)
  const items = rows.map(stored)
  if (limit === undefined || items.length <= limit) return { items, hasMore: false }
  return { items: items.slice(0, limit), hasMore: true }
}

/** One mention of the account, with the text around it and how many other places hold the same value. */
export const showMention = (
  database: CacheDatabase,
  accountPk: number,
  id: number,
  around = 80,
): (StoredMention & { before: string; after: string; sameValue: number; candidates: string[] }) | undefined => {
  const row = database.prepare(`${SELECT}WHERE mn.id = ? AND m.account_id = ?`).get(id, accountPk)
  if (!row) return undefined
  const text = String(row.text)
  const start = Number(row.start_offset)
  const end = Number(row.end_offset)
  const sameValue = Number(
    database
      .prepare("SELECT count(*) AS n FROM mentions WHERE kind = ? AND value = ? AND id <> ?")
      .get(String(row.kind), String(row.value), id)?.n,
  )
  const mention = stored(row)
  return {
    ...mention,
    before: text.slice(Math.max(0, start - around), start),
    after: text.slice(end, end + around),
    sameValue,
    candidates: candidatesOf(database, mention, Number(row.chat_pk)),
  }
}

/**
 * Whom a value may belong to. A name: every known person it matches, the ones who wrote in its chat first. A phone
 * or an address: the people whose received mail carries it, most letters first — mostly a signature, so offered,
 * never linked by rule.
 */
export const candidatesOf = (
  database: CacheDatabase,
  { kind, value, written }: { kind: MentionKind; value: string; written: string },
  chat: number | null,
): string[] => {
  if (kind === "phone" || kind === "email")
    return database
      .prepare(
        "SELECT l.person_id AS person FROM mentions mn JOIN emails e ON e.id = mn.source_id AND e.deleted_at IS NULL " +
          "AND coalesce(e.outgoing, 0) = 0 JOIN identity_links l ON l.identity_id = e.from_identity_id " +
          "JOIN persons p ON p.id = l.person_id AND p.owner = 0 WHERE mn.source_type = 'email' AND mn.kind = ? " +
          "AND mn.value = ? GROUP BY l.person_id ORDER BY count(DISTINCT e.id) DESC, l.person_id LIMIT 5",
      )
      .all(kind, value)
      .map((row) => `person:${Number(row.person)}`)
  if (kind !== "person-name") return []
  const here = chat === null ? new Set<number>() : participants(database)(chat)
  return (findNames(written, nameIndex(knownPeople(database), createStemmer()))[0]?.people ?? [])
    .map((person) => ({ person, here: here.has(person) }))
    .sort((a, b) => Number(b.here) - Number(a.here) || a.person - b.person)
    .map(({ person }) => `person:${person}`)
}

export interface MentionDecision {
  kind: MentionKind
  value: string
  status: MentionStatus
  /** What it now names, `identity:12` or `document:7`; `null` when dismissed. */
  target: string | null
  /** Every stored mention of this value that now carries the decision. */
  mentions: number
}

/** A mention found and allowed to its caller; `chat` is `null` for a text outside a chat. */
export interface LocatedMention {
  id: number
  kind: MentionKind
  value: string
  chat: number | null
  /** What was written there: an address becomes a place under it. */
  written?: string
}

export const mentionOfAccount = (database: CacheDatabase, accountPk: number, id: number): LocatedMention => {
  const row = database.prepare(`${SELECT}WHERE mn.id = ? AND m.account_id = ?`).get(id, accountPk)
  if (!row) throw new CliError("not_found", `no mention ${id} in this account`)
  return {
    id,
    kind: String(row.kind) as MentionKind,
    value: String(row.value),
    chat: Number(row.chat_pk),
    written: String(row.text).slice(Number(row.start_offset), Number(row.end_offset)),
  }
}

/**
 * A phone, an address, a link or a document is decided once for its value, everywhere it is written. A name is
 * decided where it is written: «Ольга» in two chats can be two people.
 */
const decide = (
  database: CacheDatabase,
  { id, kind, value, chat }: LocatedMention,
  status: MentionStatus,
  target: { type: string; id: number } | null,
  { by, inChat }: Decider,
  now: number,
): MentionDecision => {
  const set = "UPDATE mentions SET status = ?, target_type = ?, target_id = ?, author = ?, updated_at = ? "
  const decision = [status, target?.type ?? null, target?.id ?? null, by, now] as const
  // The same name in one chat, still undecided or decided only by the rules: what someone decided stays.
  const sameChat =
    "WHERE id = ? OR id IN (SELECT mn.id FROM mentions mn LEFT JOIN attachments att ON mn.source_type = 'attachment' " +
    "AND att.id = mn.source_id AND att.attachable_type = 'message' JOIN messages m ON mn.source_type IN ('message', " +
    "'attachment') AND m.id = CASE WHEN " +
    "mn.source_type = 'attachment' THEN att.attachable_id ELSE mn.source_id END WHERE m.chat_id = ? " +
    "AND mn.kind = 'person-name' AND mn.value = ? AND (mn.status = 'found' OR mn.author = 'rules'))"
  if (inChat && chat === null)
    throw new CliError("validation_error", "--all-in-chat decides a name in a chat; this one is not in a chat")
  const changed = (
    kind !== "person-name"
      ? database.prepare(`${set}WHERE kind = ? AND value = ?`).run(...decision, kind, value)
      : inChat
        ? database.prepare(`${set}${sameChat}`).run(...decision, id, chat, value)
        : database.prepare(`${set}WHERE id = ?`).run(...decision, id)
  ).changes
  return { kind, value, status, target: target ? `${target.type}:${target.id}` : null, mentions: Number(changed) }
}

/**
 * Says what a value is, for every place it is written. A phone or an address gets an identity of its own
 * (`provider` = the kind, the value as its id) owned by a person (`identity_links`) or an organization
 * (`organization_identities`); moving it to another person later is
 * that identity's link, not the mentions. A document id names the stored document.
 */
export const confirmMention = (
  context: StoreContext,
  mention: LocatedMention,
  owner: { person: number } | { organization: number } | undefined,
  by: Decider,
): MentionDecision => {
  const { database } = context
  const now = context.now()
  if (mention.kind === "phone" || mention.kind === "email") {
    if (owner === undefined)
      throw new CliError(
        "validation_error",
        `a ${mention.kind} is confirmed to its owner — person:<uid> or organization:<id>`,
      )
    database
      .prepare(
        "INSERT INTO identities (provider, external_id, created_at, updated_at) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT (provider, external_id) DO NOTHING",
      )
      .run(mention.kind, mention.value, now, now)
    const identity = Number(
      database
        .prepare("SELECT id FROM identities WHERE provider = ? AND external_id = ?")
        .get(mention.kind, mention.value)?.id,
    )
    if ("person" in owner) linkIdentityToPerson(context, identity, owner.person, { method: "mention", by: by.by })
    else
      database
        .prepare(
          "INSERT INTO organization_identities (identity_id, organization_id, method, author, created_at, updated_at) " +
            "VALUES (?, ?, 'mention', ?, ?, ?) ON CONFLICT (identity_id, organization_id) DO NOTHING",
        )
        .run(identity, owner.organization, by.by, now, now)
    return decide(database, mention, "linked", { type: "identity", id: identity }, by, now)
  }
  if (mention.kind === "document") {
    const document = database
      .prepare(
        "SELECT id FROM documents WHERE json_extract(front_matter, '$.fileId') = ? AND deleted_at IS NULL " +
          "ORDER BY id LIMIT 1",
      )
      .get(mention.value)
    if (!document)
      throw new CliError("not_found", "that document is not in the store yet — sync it from Drive, then confirm")
    return decide(database, mention, "linked", { type: "document", id: Number(document.id) }, by, now)
  }
  if (mention.kind === "place") {
    if (owner !== undefined)
      throw new CliError(
        "validation_error",
        "an address is confirmed as a place of its own, with no person or organization",
      )
    const known = placeOf(database)(mention.value)
    const place =
      known ??
      Number(
        database
          .prepare(
            "INSERT INTO places (address, folded, author, created_at, updated_at) VALUES (?, ?, ?, ?, ?) RETURNING id",
          )
          .get(mention.written ?? mention.value, mention.value, by.by, now, now)?.id,
      )
    return decide(database, mention, "linked", { type: "place", id: place }, by, now)
  }
  if (mention.kind === "person-name") {
    if (owner === undefined || !("person" in owner))
      throw new CliError("validation_error", "a name is confirmed to the person it means — person:<uid>")
    return decide(database, mention, "linked", { type: "person", id: owner.person }, by, now)
  }
  const named = mention.kind === "url" ? telegramLink(database)(mention.value) : undefined
  if (named)
    return decide(
      database,
      mention,
      "linked",
      { type: String(named.target_type), id: Number(named.target_id) },
      by,
      now,
    )
  throw new CliError(
    "validation_error",
    "a link is linked only to a stored Telegram chat or account it names (t.me/…); reject it if it is not worth keeping",
  )
}

/** Not a real mention, or not worth keeping: every place the value is written, now and on later syncs. */
export const rejectMention = (context: StoreContext, mention: LocatedMention, by: Decider): MentionDecision =>
  decide(context.database, mention, "dismissed", null, by, context.now())

/** `person:<uid>` or `organization:<id>`, checked against the store. */
export const mentionOwner = (
  context: StoreContext,
  ref: string | undefined,
): { person: number } | { organization: number } | undefined => {
  if (ref === undefined) return undefined
  const [type, uid = ""] = ref.split(":")
  if (type === "person") {
    const person = personByUid(context, uid)
    if (!person) throw new CliError("not_found", `no ${ref} in the store`)
    return { person: Number(person.uid) }
  }
  const found = context.database
    .prepare("SELECT id FROM organizations WHERE id = ? AND deleted_at IS NULL")
    .get(Number(uid) || 0)
  if (!found) throw new CliError("not_found", `no ${ref} in the store`)
  return { organization: Number(found.id) }
}

/** A confirmed address and how many mentions, in every account, name it. */
export interface StoredPlace {
  id: number
  address: string
  mentions: number
}

export const listPlaces = (
  database: CacheDatabase,
  { limit, offset }: { limit?: number; offset: number },
): { items: StoredPlace[]; hasMore: boolean } => {
  const rows = database
    .prepare(
      "SELECT p.id, p.address, count(mn.id) AS mentions FROM places p LEFT JOIN mentions mn ON mn.target_type = 'place' " +
        "AND mn.target_id = p.id GROUP BY p.id ORDER BY mentions DESC, p.id LIMIT ? OFFSET ?",
    )
    .all(limit === undefined ? -1 : limit + 1, offset)
    .map((row) => ({ id: Number(row.id), address: String(row.address), mentions: Number(row.mentions) }))
  const hasMore = limit !== undefined && rows.length > limit
  return { items: hasMore ? rows.slice(0, limit) : rows, hasMore }
}
