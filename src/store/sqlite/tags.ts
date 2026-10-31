import { CliError } from "@wirecat/cli-base"
import { formatLocator } from "../../domain/locator.js"
import type { Id } from "../../domain/models.js"
import type { TagType } from "../../domain/tags.js"
import { normalizeVocabularyName } from "../../domain/vocabulary.js"
import type { CacheDatabase, SqlValue } from "../driver.js"
import type { AccountKey } from "../types.js"
import type { Actor } from "./actors.js"
import type { EntityType } from "./entity-types.js"
import type { StoreContext } from "./open.js"
import type { Where } from "./query-filter.js"
import { guardTagCreation, type TagCreationOptions } from "./tag-creation.js"
import { tagMemberIds } from "./tag-resolution.js"
import { inboxKey, taskAccountOf } from "./task-keys.js"
import { emailOf, emailThreadOf, type Thing, taskRowOf } from "./things.js"
import { toIso } from "./values.js"

/** What a messenger tag labels: a chat or a message of the account, or a person of its messenger. */
export type TagTarget =
  | { type: "chat"; chatId: Id }
  | { type: "contact"; personId: Id }
  | { type: "message"; chatId: Id; messageId: Id }

/** A task of the account; apart from `TagTarget`, so code that narrows a messenger target keeps compiling. */
export type TaskTagTarget = { type: "task"; taskId: string }
export type AnyTagTarget = TagTarget | TaskTagTarget

export interface StoredTag {
  tag: string
  type: TagType
  chatId?: Id
  chatTitle?: string | null
  personId?: Id
  name?: string | null
  messageId?: Id
  locator?: string
  /** The task's id, as `task:` takes it. */
  taskId?: string
  sources?: ("manual" | "auto")[]
  createdAt: string
}

export interface TagFilter {
  source?: "manual" | "auto"
  tag?: string
  type?: TagType
  /** A list query's condition over `tag`, `tag_type`, `created_at`, `source` and `auto` (1 when a rule claims it). */
  where?: Where
  window?: { limit: number; offset: number }
}

export const TAG_KINDS = ["tag", "topic"] as const
export type TagKind = (typeof TAG_KINDS)[number]

/**
 * Where a tagging came from. `owner` is the owner's own (the old `manual`), `file` what a note file states,
 * `auto` what the keyword rules claimed for a chat, `agent` what an agent added.
 */
export type TaggingSource = "owner" | "file" | "auto" | "agent"

/** A messenger tag target's polymorphic type: a contact is an `identity` row. */
const TAGGABLE: Record<TagType, EntityType> = { chat: "chat", contact: "identity", message: "message", task: "task" }
const TAG_TYPE: Record<string, TagType> = {
  chat: "chat",
  identity: "contact",
  message: "message",
  email_thread: "chat",
  email: "message",
  task: "task",
}

export const targetThing = ({ database }: StoreContext, key: AccountKey, target: TagTarget | TaskTagTarget): Thing => {
  if (target.type === "task") {
    const row = taskRowOf(database, target.taskId)
    if (row === undefined || taskAccountOf(database, row) !== `${key.provider}:${key.account}`)
      throw new CliError("not_found", `no task ${target.taskId} for this account — tasks list shows the ids`)
    return { type: "task", id: row }
  }
  const mail =
    key.provider !== "email" || target.type === "contact"
      ? undefined
      : target.type === "chat"
        ? emailThreadOf(database, key.account, target.chatId)
        : emailOf(database, key.account, target.chatId, target.messageId)
  if (mail) return mail
  const found =
    target.type === "contact"
      ? database
          .prepare("SELECT id FROM identities WHERE provider=? AND external_id=?")
          .get(key.provider, target.personId)
      : target.type === "chat"
        ? database
            .prepare(
              "SELECT c.id FROM chats c JOIN accounts a ON a.id=c.account_id WHERE a.provider=? AND a.external_id=? AND c.external_id=?",
            )
            .get(key.provider, key.account, target.chatId)
        : database
            .prepare(
              "SELECT m.id FROM messages m JOIN chats c ON c.id=m.chat_id JOIN accounts a ON a.id=c.account_id " +
                "WHERE a.provider=? AND a.external_id=? AND c.external_id=? AND m.external_id=? AND m.deleted_at IS NULL",
            )
            .get(key.provider, key.account, target.chatId, target.messageId)
  if (found === undefined) {
    const what =
      target.type === "contact"
        ? `person ${target.personId}`
        : target.type === "chat"
          ? `chat ${target.chatId}`
          : `message ${target.messageId} in chat ${target.chatId}`
    throw new CliError("not_found", `the local store holds no ${what}`)
  }
  return { type: TAGGABLE[target.type], id: Number(found.id) }
}

export interface TagRow {
  id: number
  name: string
  kind: TagKind
}

export const tagNamed = (database: CacheDatabase, name: string): TagRow | undefined => {
  const row = database
    .prepare(
      "SELECT r.canonical_id AS id,r.name,r.kind FROM canonical_tags t JOIN resolved_tags r ON r.id=t.id WHERE t.name=?",
    )
    .get(name)
  return row ? { id: Number(row.id), name: String(row.name), kind: row.kind as TagKind } : undefined
}

/** An explicit alias reuses its target; similarity never chooses a canonical label. */
export const canonicalTagNamed = (database: CacheDatabase, name: string): TagRow | undefined => {
  const normalized = normalizeVocabularyName(name)
  // createTag stores the name as given, so "Projects/Acme" must be found again by its folded form.
  const foldedNamed = (): TagRow | undefined => {
    const rows = database
      .prepare(
        "SELECT r.canonical_id AS id,r.name,r.kind,t.name AS original_name FROM canonical_tags t JOIN resolved_tags r ON r.id=t.id WHERE lower(t.name)=lower(?) LIMIT 4097",
      )
      .all(normalized)
      .filter((row) => normalizeVocabularyName(String(row.original_name)) === normalized)
    const unique = [...new Map(rows.map((row) => [Number(row.id), row])).values()]
    if (unique.length > 1) throw new CliError("configuration_error", "the label name has conflicting canonical targets")
    const row = unique[0]
    return row ? { id: Number(row.id), name: String(row.name), kind: row.kind as TagKind } : undefined
  }
  const direct = tagNamed(database, normalized) ?? foldedNamed()
  const aliases = database
    .prepare(
      "SELECT DISTINCT t.canonical_id AS id,t.name,t.kind FROM aliases a JOIN resolved_tags t ON t.id=a.aliasable_id " +
        "WHERE a.aliasable_type='tag' AND a.account_id IS NULL AND a.name_folded=? LIMIT 2",
    )
    .all(normalized)
  if (aliases.length > 1 || (direct && aliases.some((row) => Number(row.id) !== direct.id)))
    throw new CliError("configuration_error", "the label name has conflicting canonical targets")
  const row = aliases[0]
  return direct ?? (row ? { id: Number(row.id), name: String(row.name), kind: row.kind as TagKind } : undefined)
}

/**
 * A new tag or topic. A name is one or the other, never both, so a clash names what holds it; only the
 * owner makes a topic — an agent's topic is a proposed action the owner approves.
 */
export const createTag = (
  context: StoreContext,
  name: string,
  kind: TagKind,
  by: "owner" | "agent",
  options: TagCreationOptions = {},
): TagRow => {
  const { database, now } = context
  if (!TAG_KINDS.includes(kind))
    throw new CliError("validation_error", `a tag's kind is one of ${TAG_KINDS.join(", ")}`)
  if (kind === "topic" && by !== "owner")
    throw new CliError("permission_error", "only the owner creates a topic — propose it for the owner to approve", {
      reason: "topic.owner-only",
    })
  const held = canonicalTagNamed(database, name)
  if (held)
    throw new CliError(
      "validation_error",
      held.kind === kind ? `the ${kind} "${name}" exists` : `"${name}" is a ${held.kind}; one name is never both`,
      { reason: held.kind === kind ? "tag_exists" : "tag_name_clash" },
    )
  guardTagCreation(context, name, kind, by, options)
  const at = now()
  database
    .prepare("INSERT INTO canonical_tags (name, kind, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run(name, kind, at, at)
  return tagNamed(database, name) as TagRow
}

/** The tag of that name, made as a plain tag when no tag or topic holds the name yet. */
export const ensureTag = (context: StoreContext, name: string): TagRow => {
  return canonicalTagNamed(context.database, name) ?? createTag(context, name, "tag", "owner")
}

/** The tags it did not have before, in the order given; a tag the owner adds becomes the owner's. */
/** A task's tag change is part of its history, and of its revision. */
const taskTagsChanged = (
  context: StoreContext,
  thing: Thing,
  changes: { added?: string[]; removed?: string[] },
  author?: Actor,
) => {
  if (thing.type !== "task" || [...(changes.added ?? []), ...(changes.removed ?? [])].length === 0) return
  const at = context.now()
  context.database.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(at, thing.id)
  context.database
    .prepare(
      "INSERT INTO task_events (task_id, actor_type, actor_id, kind, changes, created_at) VALUES (?, ?, ?, 'tags', ?, ?)",
    )
    .run(
      thing.id,
      author?.type ?? null,
      author?.id ?? null,
      JSON.stringify({ tags: [changes.removed ?? [], changes.added ?? []] }),
      at,
    )
}

export const addTags = (
  context: StoreContext,
  thing: Thing,
  tags: string[],
  source: TaggingSource = "owner",
  author?: Actor,
): string[] => {
  const { database, now } = context
  const insert = database.prepare(
    "INSERT INTO taggings (tag_id, taggable_type, taggable_id, main, source, author_type, author_id, created_at, updated_at) " +
      "VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?) ON CONFLICT (tag_id, taggable_type, taggable_id) DO NOTHING",
  )
  const claim = database.prepare(
    "UPDATE taggings SET source = 'owner', updated_at = ? WHERE tag_id = ? AND taggable_type = ? AND taggable_id = ? AND source <> 'owner'",
  )
  const at = now()
  const fresh = tags.filter((name) => {
    const tag = ensureTag(context, name)
    const held = database
      .prepare(
        "SELECT source,author_type,author_id FROM taggings WHERE tag_id IN (SELECT ? UNION ALL SELECT source_id FROM tag_redirects WHERE survivor_id=?) AND taggable_type=? AND taggable_id=?",
      )
      .all(tag.id, tag.id, thing.type, thing.id)
    if (
      held.some(
        (row) =>
          row.source === source && row.author_type === (author?.type ?? null) && row.author_id === (author?.id ?? null),
      )
    )
      return false
    const added =
      insert.run(tag.id, thing.type, thing.id, source, author?.type ?? null, author?.id ?? null, at, at).changes > 0
    if (!added && source === "owner") claim.run(at, tag.id, thing.type, thing.id)
    return added && held.length === 0
  })
  taskTagsChanged(context, thing, { added: fresh }, author)
  return fresh
}

/** An explicit removal withdraws the effective label, restricted to the requested origin when supplied. */
export const removeTags = (
  context: StoreContext,
  thing: Thing,
  tags: string[],
  source?: "manual" | "auto",
): string[] => {
  const { database } = context
  const remove = database.prepare("DELETE FROM taggings WHERE tag_id=? AND taggable_type=? AND taggable_id=?")
  const removed = tags.filter((name) => {
    const tag = canonicalTagNamed(database, name)
    if (!tag) return false
    let changed = false
    for (const id of tagMemberIds(database, tag.id)) {
      const held = database
        .prepare("SELECT source FROM taggings WHERE tag_id=? AND taggable_type=? AND taggable_id=?")
        .get(id, thing.type, thing.id)
      const automatic =
        thing.type === "chat" &&
        database
          .prepare("SELECT 1 AS held FROM canonical_auto_tag_claims WHERE chat_id=? AND tag_id=?")
          .get(thing.id, id)
      if (source === "manual") {
        if (held?.source !== "owner") continue
        if (automatic)
          database
            .prepare("UPDATE taggings SET source='auto' WHERE tag_id=? AND taggable_type=? AND taggable_id=?")
            .run(id, thing.type, thing.id)
        else remove.run(id, thing.type, thing.id)
        changed = true
        continue
      }
      if (automatic) {
        database.prepare("DELETE FROM canonical_auto_tag_claims WHERE chat_id=? AND tag_id=?").run(thing.id, id)
        changed = true
      }
      if (source === "auto") {
        if (held?.source === "auto") changed = remove.run(id, thing.type, thing.id).changes > 0 || changed
      } else changed = remove.run(id, thing.type, thing.id).changes > 0 || changed
    }
    return changed
  })
  taskTagsChanged(context, thing, { removed })
  return removed
}

export interface Label {
  tag: string
  /** `file` when only a note's file states it; the owner's own label otherwise. */
  origin: "file" | "owner"
}

/** A thing's tags by name, with whether only a file states each. */
/** A tagging of something still there: a deleted document keeps its tags but is not counted or listed by them. */
export const liveTagging = (alias: string): string =>
  `NOT (${alias}.taggable_type = 'document' AND EXISTS (SELECT 1 FROM documents dt WHERE dt.id = ${alias}.taggable_id AND dt.deleted_at IS NOT NULL))`

export const labelsOf = (database: CacheDatabase, thing: Thing, tag?: string): Label[] =>
  database
    .prepare(
      `SELECT t.name,CASE WHEN min(g.source)='file' AND max(g.source)='file' THEN 'file' ELSE 'owner' END AS source FROM taggings g JOIN resolved_tags t ON t.id=g.tag_id WHERE g.taggable_type=? AND g.taggable_id=?${tag === undefined ? "" : " AND t.name = ?"} GROUP BY t.canonical_id ORDER BY t.name`,
    )
    .all(thing.type, thing.id, ...(tag === undefined ? [] : [tag]))
    .map((row) => ({ tag: String(row.name), origin: row.source === "file" ? "file" : "owner" }))

/**
 * Marks one topic as the thing's main one, or clears it with `null`: the topic is tagged on it if it was
 * not, and any other main topic stops being main.
 */
export const setMainTopic = (context: StoreContext, thing: Thing, topic: string | null): void => {
  const { database, now } = context
  const at = now()
  database
    .prepare("UPDATE taggings SET main = 0, updated_at = ? WHERE taggable_type = ? AND taggable_id = ? AND main = 1")
    .run(at, thing.type, thing.id)
  if (topic === null) return
  const tag = tagNamed(database, topic)
  if (tag?.kind !== "topic")
    throw new CliError("validation_error", `"${topic}" is not a topic; only a topic can be a thing's main one`)
  addTags(context, thing, [topic])
  database
    .prepare("UPDATE taggings SET main = 1, updated_at = ? WHERE tag_id = ? AND taggable_type = ? AND taggable_id = ?")
    .run(at, tag.id, thing.type, thing.id)
}

export const tagsOf = ({ database }: StoreContext, key: AccountKey, filter: TagFilter): StoredTag[] => {
  const selectedTag = filter.tag === undefined ? undefined : (canonicalTagNamed(database, filter.tag)?.id ?? -1)
  const tagged =
    selectedTag === undefined ? "" : " AND t.canonical_id=(SELECT canonical_id FROM resolved_tags WHERE id=?)"
  const parts: { type: TagType; sql: string; params: SqlValue[] }[] = [
    {
      type: "chat",
      sql:
        "SELECT t.name AS tag, g.taggable_type AS type, g.created_at, c.external_id AS chat_id, c.title AS chat_title, c.title_folded AS name_folded, " +
        "NULL AS person_id, NULL AS name, NULL AS message_id, g.source, g.taggable_id AS target_id, t.canonical_id AS tag_id, NULL AS task_id " +
        "FROM taggings g JOIN resolved_tags t ON t.id=g.tag_id JOIN chats c ON c.id=g.taggable_id " +
        "JOIN accounts a ON a.id=c.account_id WHERE g.taggable_type='chat' AND a.provider=? AND a.external_id=?",
      params: [key.provider, key.account],
    },
    {
      type: "contact",
      sql:
        "SELECT t.name AS tag, g.taggable_type AS type, g.created_at, NULL AS chat_id, NULL AS chat_title, i.name_folded AS name_folded, " +
        "i.external_id AS person_id, i.name AS name, NULL AS message_id, g.source, g.taggable_id AS target_id, t.canonical_id AS tag_id, NULL AS task_id " +
        "FROM taggings g JOIN resolved_tags t ON t.id=g.tag_id JOIN identities i ON i.id=g.taggable_id " +
        "WHERE g.taggable_type='identity' AND i.provider=?",
      params: [key.provider],
    },
    {
      type: "message",
      sql:
        "SELECT t.name AS tag, g.taggable_type AS type, g.created_at, c.external_id AS chat_id, c.title AS chat_title, c.title_folded AS name_folded, " +
        "NULL AS person_id, NULL AS name, m.external_id AS message_id, g.source, g.taggable_id AS target_id, t.canonical_id AS tag_id, NULL AS task_id " +
        "FROM taggings g JOIN resolved_tags t ON t.id=g.tag_id JOIN messages m ON m.id=g.taggable_id JOIN chats c ON c.id=m.chat_id " +
        "JOIN accounts a ON a.id=c.account_id WHERE g.taggable_type='message' AND a.provider=? AND a.external_id=?",
      params: [key.provider, key.account],
    },
    {
      type: "chat",
      sql:
        "SELECT t.name AS tag, g.taggable_type AS type, g.created_at, th.external_id AS chat_id, th.subject AS chat_title, th.subject_folded AS name_folded, " +
        "NULL AS person_id, NULL AS name, NULL AS message_id, g.source, g.taggable_id AS target_id, t.canonical_id AS tag_id, NULL AS task_id " +
        "FROM taggings g JOIN resolved_tags t ON t.id=g.tag_id JOIN email_threads th ON th.id=g.taggable_id " +
        "JOIN accounts a ON a.id=th.account_id WHERE g.taggable_type='email_thread' AND a.provider=? AND a.external_id=?",
      params: [key.provider, key.account],
    },
    {
      type: "message",
      sql:
        "SELECT t.name AS tag, g.taggable_type AS type, g.created_at, th.external_id AS chat_id, th.subject AS chat_title, th.subject_folded AS name_folded, " +
        "NULL AS person_id, NULL AS name, e.external_id AS message_id, g.source, g.taggable_id AS target_id, t.canonical_id AS tag_id, NULL AS task_id " +
        "FROM taggings g JOIN resolved_tags t ON t.id=g.tag_id JOIN emails e ON e.id=g.taggable_id " +
        "JOIN email_threads th ON th.id=e.email_thread_id JOIN accounts a ON a.id=e.account_id " +
        "WHERE g.taggable_type='email' AND e.deleted_at IS NULL AND a.provider=? AND a.external_id=?",
      params: [key.provider, key.account],
    },
    {
      type: "task",
      sql:
        "SELECT t.name AS tag, g.taggable_type AS type, g.created_at, NULL AS chat_id, k.title AS chat_title, k.title_folded AS name_folded, " +
        "NULL AS person_id, NULL AS name, NULL AS message_id, g.source, g.taggable_id AS target_id, t.canonical_id AS tag_id, " +
        "COALESCE(k.package_id, k.key) AS task_id " +
        "FROM taggings g JOIN resolved_tags t ON t.id=g.tag_id JOIN tasks k ON k.id=g.taggable_id JOIN projects p ON p.id=k.project_id " +
        "WHERE g.taggable_type='task' AND k.deleted_at IS NULL AND p.key=?",
      params: [inboxKey(`${key.provider}:${key.account}`)],
    },
  ]
  const chosen = parts.filter(({ type }) => filter.type === undefined || filter.type === type)
  const union = chosen.map(({ sql }) => sql + tagged).join(" UNION ALL ")
  const where = [
    ...(filter.where ? [filter.where] : []),
    ...(filter.source === undefined
      ? []
      : [{ sql: filter.source === "auto" ? "x.auto = 1" : "(x.auto = 0 OR x.source = 'owner')", params: [] }]),
  ]
  const rows = database
    .prepare(
      "SELECT * FROM (SELECT tag,type,min(created_at) AS created_at,chat_id,chat_title,person_id,name,name_folded,message_id,CASE WHEN max(source='owner') THEN 'owner' ELSE min(source) END AS source,target_id,tag_id,task_id,tag_type,max(auto) AS auto FROM (SELECT u.*, CASE u.type WHEN 'identity' THEN 'contact' WHEN 'email_thread' THEN 'chat' " +
        "WHEN 'email' THEN 'message' ELSE u.type END AS tag_type, (u.type = 'chat' AND EXISTS (SELECT 1 FROM " +
        `canonical_auto_tag_claims ac JOIN resolved_tags rt ON rt.id=ac.tag_id WHERE ac.chat_id = u.target_id AND rt.canonical_id = u.tag_id)) AS auto FROM (${union}) u) GROUP BY tag,type,target_id) x ` +
        `WHERE ${where.length === 0 ? "1" : where.map(({ sql }) => `(${sql})`).join(" AND ")} ` +
        "ORDER BY x.tag, x.type, x.created_at, x.chat_id, x.person_id, x.message_id" +
        (filter.window ? " LIMIT ? OFFSET ?" : ""),
    )
    .all(
      ...chosen.flatMap(({ params }) => (selectedTag === undefined ? params : [...params, selectedTag])),
      ...where.flatMap(({ params }) => params),
      ...(filter.window ? [filter.window.limit, filter.window.offset] : []),
    )
  const result = rows.map((row): StoredTag => {
    const type = TAG_TYPE[String(row.type)] as TagType
    const chatId = row.chat_id == null ? undefined : String(row.chat_id)
    const messageId = row.message_id == null ? undefined : String(row.message_id)
    const automatic = Number(row.auto) === 1
    return {
      ...(automatic
        ? { sources: (row.source === "owner" ? ["manual", "auto"] : ["auto"]) as ("manual" | "auto")[] }
        : {}),
      tag: String(row.tag),
      type,
      ...(type === "contact"
        ? { personId: String(row.person_id), name: row.name == null ? null : String(row.name) }
        : { chatId, chatTitle: row.chat_title == null ? null : String(row.chat_title) }),
      ...(type === "task" ? { taskId: String(row.task_id) } : {}),
      ...(type === "message" && chatId !== undefined && messageId !== undefined
        ? { messageId, locator: formatLocator({ ...key, chat: chatId, message: messageId }) }
        : {}),
      createdAt: toIso(Number(row.created_at)) as string,
    }
  })
  return result
}
