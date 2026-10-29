import {
  findMentions,
  MENTION_KINDS,
  MENTION_VERSIONS,
  type MentionKind,
  oneTrackedLinkPerSite,
  telegramTarget,
} from "../../domain/mentions.js"
import { findNames, findUnknownNames, type KnownPerson, nameIndex } from "../../domain/person-names.js"
import { createStemmer } from "../../search/stem.js"
import type { CacheDatabase } from "../driver.js"
import { mentionField, mentionText } from "./lucene-fields.js"
import { storePhoneCountries } from "./phone-countries.js"
import { placeOf } from "./place-key.js"

/** Mentions a store write finds before it commits: an older binary may have queued thousands. */
export const DRAIN_ON_WRITE = 500
const METHOD = "rules"

type Decision = { status: unknown; target_type: unknown; target_id: unknown; author: unknown }

/** The stored chat or Telegram account a `t.me` link names, as a rules decision; nothing for any other link. */
export const telegramLink = (database: CacheDatabase) => {
  const chat = database.prepare(
    "SELECT 'linked' AS status, 'chat' AS target_type, id AS target_id, 'rules' AS author FROM chats " +
      "WHERE (? IS NOT NULL AND lower(username) = lower(?)) OR external_id = ? ORDER BY id LIMIT 1",
  )
  const account = database.prepare(
    "SELECT 'linked' AS status, 'identity' AS target_type, id AS target_id, 'rules' AS author FROM identities " +
      "WHERE provider = 'telegram' AND lower(username) = lower(?) ORDER BY id LIMIT 1",
  )
  return (value: string): Decision | undefined => {
    const target = telegramTarget(value)
    if (!target) return undefined
    const username = "username" in target ? target.username : null
    return (chat.get(username, username, "chatId" in target ? target.chatId : null) ??
      (username ? account.get(username) : undefined)) as Decision | undefined
  }
}

/**
 * What a new mention starts as when nothing was decided where it was written: dismissed if its value was
 * dismissed anywhere, linked when the value already has an original — an identity a person or an organization owns for a phone
 * or an address, the stored document for a document id, the place for a confirmed address.
 */
const originalOf = (database: CacheDatabase) => {
  const dismissed = database.prepare(
    "SELECT status, NULL AS target_type, NULL AS target_id, author FROM mentions " +
      "WHERE kind = ? AND value = ? AND status = 'dismissed' LIMIT 1",
  )
  const identity = database.prepare(
    "SELECT 'linked' AS status, 'identity' AS target_type, i.id AS target_id, 'rules' AS author FROM identities i " +
      "WHERE i.provider = ? AND i.external_id = ? AND (EXISTS (SELECT 1 FROM identity_links l WHERE l.identity_id = i.id) " +
      "OR EXISTS (SELECT 1 FROM organization_identities o WHERE o.identity_id = i.id))",
  )
  const telegram = telegramLink(database)
  const document = database.prepare(
    "SELECT 'linked' AS status, 'document' AS target_type, id AS target_id, 'rules' AS author FROM documents " +
      "WHERE json_extract(front_matter, '$.fileId') = ? AND deleted_at IS NULL ORDER BY id LIMIT 1",
  )
  const place = placeOf(database)
  const byKind: Partial<Record<MentionKind, (value: string) => unknown>> = {
    phone: (value) => identity.get("phone", value),
    email: (value) => identity.get("email", value),
    document: (value) => document.get(value),
    url: telegram,
    place: (value) => {
      const id = place(value)
      return id === undefined ? undefined : { status: "linked", target_type: "place", target_id: id, author: "rules" }
    },
  }
  return (kind: MentionKind, value: string): Decision | undefined =>
    (dismissed.get(kind, value) ?? byKind[kind]?.(value)) as Decision | undefined
}

/**
 * People whose names are looked for: not the owner, and only people met in a messenger, a meeting or a confirmed
 * phone. Thousands of persons can exist only as an e-mail sender, and their names look mostly like companies and
 * mailing lists. An account's own identity is the owner's, even when the store has not linked it yet. The owner's
 * own name for a contact is that person's name too, and each word of it a name alone.
 */
export const knownPeople = (database: CacheDatabase): KnownPerson[] => {
  const own = "EXISTS (SELECT 1 FROM accounts a WHERE a.provider = i.provider AND a.external_id = i.external_id)"
  const rows = database
    .prepare(
      "WITH met AS (SELECT DISTINCT l.person_id AS id FROM identity_links l JOIN identities i ON i.id = l.identity_id " +
        `JOIN persons p ON p.id = l.person_id WHERE p.owner = 0 AND i.provider <> 'email' AND coalesce(i.bot, 0) = 0 ` +
        `AND NOT ${own}) ` +
        "SELECT p.id, p.name, 0 AS alias FROM persons p JOIN met ON met.id = p.id WHERE p.name IS NOT NULL " +
        "UNION SELECT l.person_id, i.name, 0 FROM identity_links l JOIN identities i ON i.id = l.identity_id " +
        `JOIN met ON met.id = l.person_id WHERE i.name IS NOT NULL AND i.provider <> 'email' AND NOT ${own} ` +
        "UNION SELECT a.aliasable_id, a.name, 1 FROM aliases a JOIN persons p ON p.id = a.aliasable_id " +
        "WHERE a.aliasable_type = 'person' AND p.owner = 0 " +
        "UNION SELECT l.person_id, a.name, 1 FROM aliases a JOIN identity_links l ON l.identity_id = a.aliasable_id " +
        "JOIN met ON met.id = l.person_id WHERE a.aliasable_type = 'identity'",
    )
    .all()
  const people = new Map<number, KnownPerson>()
  for (const row of rows) {
    const id = Number(row.id)
    const person = people.get(id) ?? { id, names: [], aliases: [] }
    ;(Number(row.alias) ? (person.aliases as string[]) : person.names).push(String(row.name))
    people.set(id, person)
  }
  return [...people.values()]
}

/** Who wrote in a chat, as people: a name alone is linked by rule only to someone the chat already holds. */
export const participants = (database: CacheDatabase) => {
  const query = database.prepare(
    "SELECT DISTINCT l.person_id FROM messages m JOIN identity_links l ON l.identity_id = m.sender_identity_id " +
      "WHERE m.chat_id = ?",
  )
  const cached = new Map<number, Set<number>>()
  return (chat: number): Set<number> => {
    const known = cached.get(chat) ?? new Set(query.all(chat).map((row) => Number(row.person_id)))
    cached.set(chat, known)
    return known
  }
}

/** Where mentions are read from: a message's own text, its files and voice notes, documents, notes and mail. */
export const SOURCES = {
  message: {
    count: "SELECT count(*) AS n FROM messages WHERE deleted_at IS NULL",
    page: "SELECT id, text, 'text' AS field, chat_id FROM messages WHERE id > ? AND deleted_at IS NULL ORDER BY id LIMIT ?",
    one: "SELECT text, 'text' AS field, chat_id FROM messages WHERE id = ? AND deleted_at IS NULL",
  },
  attachment: {
    count:
      "SELECT count(*) AS n FROM attachments a JOIN messages m ON m.id = a.attachable_id " +
      `WHERE a.attachable_type = 'message' AND coalesce(${mentionText("a")}, '') <> '' AND m.deleted_at IS NULL`,
    page:
      `SELECT a.id, ${mentionText("a")} AS text, ${mentionField("a")} AS field, ` +
      "m.chat_id FROM attachments a JOIN messages m ON m.id = a.attachable_id WHERE a.id > ? AND a.attachable_type = 'message' " +
      `AND coalesce(${mentionText("a")}, '') <> '' AND m.deleted_at IS NULL ORDER BY a.id LIMIT ?`,
    one:
      `SELECT ${mentionText("a")} AS text, ${mentionField("a")} AS field, ` +
      "m.chat_id FROM attachments a JOIN messages m ON m.id = a.attachable_id WHERE a.id = ? AND a.attachable_type = 'message' " +
      `AND ${mentionText("a")} IS NOT NULL AND m.deleted_at IS NULL`,
  },
  // Texts outside a chat: no one wrote them in a chat, so a name in them is never linked by rule.
  document: {
    count: "SELECT count(*) AS n FROM documents WHERE deleted_at IS NULL AND coalesce(body, '') <> ''",
    page:
      "SELECT id, body AS text, 'text' AS field, NULL AS chat_id FROM documents WHERE id > ? AND deleted_at IS NULL " +
      "AND coalesce(body, '') <> '' ORDER BY id LIMIT ?",
    one: "SELECT body AS text, 'text' AS field, NULL AS chat_id FROM documents WHERE id = ? AND deleted_at IS NULL",
  },
  note: {
    count: "SELECT count(*) AS n FROM notes WHERE deleted_at IS NULL AND coalesce(body, '') <> ''",
    page:
      "SELECT id, body AS text, 'text' AS field, NULL AS chat_id FROM notes WHERE id > ? AND deleted_at IS NULL " +
      "AND coalesce(body, '') <> '' ORDER BY id LIMIT ?",
    one: "SELECT body AS text, 'text' AS field, NULL AS chat_id FROM notes WHERE id = ? AND deleted_at IS NULL",
  },
  email: {
    count: "SELECT count(*) AS n FROM emails WHERE deleted_at IS NULL AND coalesce(body_text, '') <> ''",
    page:
      "SELECT id, body_text AS text, 'text' AS field, NULL AS chat_id FROM emails WHERE id > ? AND deleted_at IS NULL " +
      "AND coalesce(body_text, '') <> '' ORDER BY id LIMIT ?",
    one: "SELECT body_text AS text, 'text' AS field, NULL AS chat_id FROM emails WHERE id = ? AND deleted_at IS NULL",
  },
} as const
export type SourceType = keyof typeof SOURCES
export const SOURCE_TYPES = Object.keys(SOURCES) as SourceType[]

type Source = { text: string; field: string; chat: number }

export const writer = (database: CacheDatabase, now: number, kinds: readonly MentionKind[] | undefined) => {
  // Only the kinds this build finds: a later build's kinds stay when this one reads the text again.
  const scope = kinds ?? MENTION_KINDS
  const only = ` AND kind IN (${scope.map(() => "?").join(", ")})`
  const existing = database.prepare(
    "SELECT kind, value, start_offset, status, target_type, target_id, author, created_at FROM mentions " +
      `WHERE source_type = ? AND source_id = ?${only}`,
  )
  // A decision on a number written without `+` was keyed on its old value; once `phone_countries` reads it as
  // +34…, its identity moves to the new value with it.
  const rekey = database.prepare(
    "UPDATE identities SET external_id = ? WHERE id = ? AND provider = 'phone' AND external_id = ? " +
      "AND NOT EXISTS (SELECT 1 FROM identities WHERE provider = 'phone' AND external_id = ?)",
  )
  // A place confirmed while its value was the street alone takes the city its address names, once read again.
  const rekeyPlace = database.prepare(
    "UPDATE places SET folded = ? WHERE id = ? AND folded = ? AND NOT EXISTS (SELECT 1 FROM places WHERE folded = ?)",
  )
  const remove = database.prepare(`DELETE FROM mentions WHERE source_type = ? AND source_id = ?${only}`)
  const insert = database.prepare(
    "INSERT OR IGNORE INTO mentions (kind, source_type, source_id, source_field, start_offset, end_offset, value, " +
      "domain, method, version, confidence, status, target_type, target_id, author, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
  const original = originalOf(database)
  const phoneCountries = storePhoneCountries(database)
  const names = !kinds || kinds.includes("person-name") ? nameIndex(knownPeople(database), createStemmer()) : undefined
  const chatPeople = participants(database)
  const found = (source: Source) => {
    const ruled = findMentions(source.text, { phoneCountries }).map((one) => ({
      ...one,
      decision: undefined as Decision | undefined,
    }))
    const known = names ? knownNames(source, names) : []
    // Known names first: the table keeps one name per place, and an unknown one must not take a known one's place.
    const unknown = names
      ? findUnknownNames(source.text, names.stem, [...ruled, ...known]).map(({ people: _, ...one }) => ({
          ...one,
          kind: "person-name" as const,
          domain: null,
          // A name is decided where it is written: a dismissed «Вера» elsewhere says nothing about this one.
          decision: { status: "found", target_type: null, target_id: null, author: null } as Decision,
        }))
      : []
    return [...ruled, ...known, ...unknown]
  }
  const knownNames = (source: Source, index: NonNullable<typeof names>) =>
    findNames(source.text, index).map(({ people, ...one }) => {
      // One person can be a row per messenger until merged, so a name often fits several: the one who wrote
      // in this chat settles it, if only one did.
      const here = people.filter((one) => chatPeople(source.chat).has(one))
      const [person] = here
      const settled = here.length === 1 && person !== undefined
      return {
        ...one,
        kind: "person-name" as const,
        domain: null,
        decision: settled
          ? { status: "linked", target_type: "person", target_id: person, author: METHOD }
          : { status: "found", target_type: null, target_id: null, author: null },
      }
    })
  return (type: SourceType, pk: number, source: Source | null): number => {
    const rows = existing.all(type, pk, ...scope)
    const decided = rows.filter((row) => row.status !== "found" && row.author !== METHOD)
    const kept = new Map<string, (typeof decided)[number]>(decided.map((row) => [`${row.kind}\u0000${row.value}`, row]))
    const keptHere = new Map<string, (typeof decided)[number]>(
      decided.map((row) => [`${row.kind}\u0000${row.start_offset}`, row]),
    )
    // A row found again keeps when it was first found, so a rebuild does not make it new for `mentions list --new`.
    const firstFound = new Map(rows.map((row) => [`${row.kind}\u0000${row.start_offset}`, Number(row.created_at)]))
    remove.run(type, pk, ...scope)
    if (source === null) return 0
    let written = 0
    const all = found(source)
    for (const one of type === "email" ? oneTrackedLinkPerSite(all) : all) {
      if (kinds && !kinds.includes(one.kind)) continue
      const here = `${one.kind}\u0000${one.start}`
      const moved =
        (one.kind === "phone" || one.kind === "place") && !kept.has(`${one.kind}\u0000${one.value}`)
          ? keptHere.get(here)
          : undefined
      if (moved?.target_type === "identity")
        rekey.run(one.value, Number(moved.target_id), String(moved.value), one.value)
      if (moved?.target_type === "place")
        rekeyPlace.run(one.value, Number(moved.target_id), String(moved.value), one.value)
      const decision =
        kept.get(`${one.kind}\u0000${one.value}`) ?? moved ?? one.decision ?? original(one.kind, one.value)
      written += Number(
        insert.run(
          one.kind,
          type,
          pk,
          source.field,
          one.start,
          one.end,
          one.value,
          one.domain,
          METHOD,
          MENTION_VERSIONS[one.kind],
          one.confidence,
          decision ? String(decision.status) : "found",
          decision?.target_type == null ? null : String(decision.target_type),
          decision?.target_id == null ? null : Number(decision.target_id),
          decision?.author == null ? null : String(decision.author),
          firstFound.get(here) ?? now,
          now,
        ).changes,
      )
    }
    return written
  }
}

export const sourceOf = (row: Record<string, unknown> | undefined): Source | null =>
  row ? { text: String(row.text), field: String(row.field), chat: Number(row.chat_id) } : null

/** Finds the mentions of the texts a store write queued, inside that write's transaction. */
export const drainMentions = (database: CacheDatabase, now: number, limit = DRAIN_ON_WRITE): number => {
  const queued = database
    .prepare("SELECT source_type, source_id FROM mention_pending ORDER BY source_type, source_id LIMIT ?")
    .all(limit)
    .map((row) => ({ type: String(row.source_type), pk: Number(row.source_id) }))
  if (queued.length === 0) return 0
  const write = writer(database, now, undefined)
  const read = Object.fromEntries(SOURCE_TYPES.map((type) => [type, database.prepare(SOURCES[type].one)]))
  const dequeue = database.prepare("DELETE FROM mention_pending WHERE source_type = ? AND source_id = ?")
  for (const { type, pk } of queued) {
    const known = SOURCE_TYPES.find((one) => one === type)
    if (known) write(known, pk, sourceOf(read[known]?.get(pk)))
    dequeue.run(type, pk)
  }
  return queued.length
}
