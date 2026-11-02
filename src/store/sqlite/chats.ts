import { CliError } from "@wirecat/cli-base"
import type { ChannelTagMatch } from "../../domain/channel-tags.js"
import type { Chat, ChatUpdate, Id, Member, Page, ProviderMetadata } from "../../domain/models.js"
import type { AccountKey, StoredChatFilter } from "../types.js"
import { and, eq, inArray, or, sql } from "./drizzle/core.js"
import { folded } from "./folded.js"
import { withoutHistory } from "./history-skips.js"
import { identityPk } from "./identities.js"
import type { Orm, StoreContext } from "./open.js"
import { bound, type ColumnMap } from "./query-filter.js"
import {
  chatEventPeople,
  chatEvents,
  chatMembers,
  chats,
  chunks,
  fetchLeases,
  identities,
  involvements,
  memberCounts,
  memberObservationMembers,
  memberObservations,
  memberStays,
  messageReactions,
  messageRevisions,
  messages,
  messageTranscripts,
  pollVotes,
  syncRanges,
} from "./schema.js"
import { ensureTag } from "./tags.js"
import { parsed, present, toIso, toMs } from "./values.js"
import { dropUnusedVectors } from "./vector-index.js"

/** The chat's own id, when the store key is a chat of this account. */
export const chatOf = ({ orm }: StoreContext, accountKey: number, chatKey: number): Id | undefined =>
  orm
    .select({ id: chats.externalId })
    .from(chats)
    .where(and(eq(chats.id, chatKey), eq(chats.accountId, accountKey)))
    .get()?.id

export const findChatPk = ({ orm }: StoreContext, accountKey: number, chatId: Id): number | undefined =>
  orm
    .select({ pk: chats.id })
    .from(chats)
    .where(and(eq(chats.accountId, accountKey), eq(chats.externalId, chatId)))
    .get()?.pk

/** A chat known only from its messages, until the chat list names it. */
export const chatPkFor = (context: StoreContext, accountKey: number, chatId: Id): number =>
  findChatPk(context, accountKey, chatId) ??
  Number(
    context.orm
      .insert(chats)
      .values({
        accountId: accountKey,
        externalId: chatId,
        kind: "unknown",
        createdAt: context.now(),
        updatedAt: context.now(),
      })
      .returning({ pk: chats.id })
      .get()?.pk,
  )

/** The store write a `chat_revisions` row names; a writer that sets none is recorded as NULL. */
export type ChatRevisionSource = "chats" | "delta" | "left" | "rejoin" | "rekey" | "merge" | "send" | "details"

/**
 * Runs `body` with `source` as what the `chat_revisions` trigger records, inside the caller's transaction. The row is
 * gone again before the commit, so an older build's write in a later transaction records no source rather than this
 * one; a nested call puts the outer source back.
 */
export const revisedBy = <T>({ database, now }: StoreContext, source: ChatRevisionSource, body: () => T): T => {
  const outer = database.prepare("SELECT source, at FROM chat_revision_source WHERE id = 1").get()
  const set = database.prepare("INSERT OR REPLACE INTO chat_revision_source (id, source, at) VALUES (1, ?, ?)")
  set.run(source, now())
  try {
    return body()
  } finally {
    if (outer) set.run(String(outer.source), Number(outer.at))
    else database.prepare("DELETE FROM chat_revision_source").run()
  }
}

/**
 * The id the chat once stored as `chatId` has now, from its newest re-key in this account; `undefined` while a chat is
 * stored under `chatId` itself, or none ever was.
 */
export const renamedChatId = ({ database }: StoreContext, accountKey: number, chatId: Id): Id | undefined => {
  const row = database
    .prepare(
      `SELECT c.external_id AS id FROM chat_revisions r JOIN chats c ON c.id = r.chat_id
        WHERE r.account_id = ? AND r.field = 'external_id' AND r.old_value = ? AND c.account_id = r.account_id
          AND NOT EXISTS (SELECT 1 FROM chats WHERE account_id = ? AND external_id = ?)
        ORDER BY r.created_at DESC, r.id DESC LIMIT 1`,
    )
    .get(accountKey, chatId, accountKey, chatId)
  return row ? String(row.id) : undefined
}

interface ChatPrivacy {
  searchable: number
  scope: string | null
}

/**
 * The owner's word on a chat must not loosen because another row joins it: hidden wins, and when the two chats sit
 * on different sides of the owner's life, the personal side wins, since a work chat reaches work views and meeting
 * preparation a personal one does not. Scopes compare as every reader applies them, the row's or else the account's.
 * A scope either row pinned stays pinned, so a later change to the account's default cannot loosen the chat.
 */
export const stricterPrivacy = (
  { database }: StoreContext,
  accountKey: number,
  kept: ChatPrivacy,
  other: ChatPrivacy,
): ChatPrivacy => {
  const account = database.prepare("SELECT scope FROM accounts WHERE id = ?").get(accountKey)
  const effective = ({ scope }: ChatPrivacy) => scope ?? (typeof account?.scope === "string" ? account.scope : null)
  return {
    searchable: Math.min(kept.searchable, other.searchable),
    scope:
      kept.scope === null && other.scope === null
        ? null
        : effective(kept) === effective(other)
          ? effective(kept)
          : "personal",
  }
}

/**
 * The row a send to `typed` lands in when the messenger answered `chatId`. A new row takes the typed row's title,
 * kind and privacy; an existing one takes the stricter privacy of the two. Neither ever becomes more visible.
 */
export const answeredChatPk = (context: StoreContext, accountKey: number, chatId: Id, typed: Id): number => {
  const { orm, now } = context
  const like =
    typed === chatId
      ? undefined
      : orm
          .select({ kind: chats.kind, title: chats.title, searchable: chats.searchable, scope: chats.scope })
          .from(chats)
          .where(and(eq(chats.accountId, accountKey), eq(chats.externalId, typed)))
          .get()
  if (like === undefined) return chatPkFor(context, accountKey, chatId)
  const found = orm
    .select({ pk: chats.id, searchable: chats.searchable, scope: chats.scope })
    .from(chats)
    .where(and(eq(chats.accountId, accountKey), eq(chats.externalId, chatId)))
    .get()
  if (found !== undefined) {
    const strict = stricterPrivacy(context, accountKey, found, like)
    if (strict.searchable !== found.searchable || strict.scope !== found.scope)
      revisedBy(context, "send", () =>
        orm
          .update(chats)
          .set({ ...strict, updatedAt: now() })
          .where(eq(chats.id, found.pk))
          .run(),
      )
    return found.pk
  }
  return Number(
    orm
      .insert(chats)
      .values({
        accountId: accountKey,
        externalId: chatId,
        ...like,
        titleFolded: folded(like.title),
        createdAt: now(),
        updatedAt: now(),
      })
      .returning({ pk: chats.id })
      .get()?.pk,
  )
}

export const upsertChat = (context: StoreContext, accountKey: number, chat: ChatUpdate): void => {
  const { orm, now } = context
  const parent = chat.parentChatId == null ? null : chatPkFor(context, accountKey, chat.parentChatId)
  const stored = orm
    .select({ metadata: chats.metadata })
    .from(chats)
    .where(and(eq(chats.accountId, accountKey), eq(chats.externalId, chat.id)))
    .get()
  orm
    .insert(chats)
    .values({
      accountId: accountKey,
      externalId: chat.id,
      kind: chat.kind,
      parentChatId: parent,
      scope: chat.scope ?? null,
      title: chat.title ?? null,
      titleFolded: folded(chat.title),
      unreadCount: chat.unreadCount ?? null,
      lastMessageAt: toMs(chat.lastMessageAt),
      participantsCount: chat.participantsCount ?? null,
      metadata: mergedMetadata(stored?.metadata ?? null, chat.providerMetadata),
      membershipState: chat.membershipState === "member" ? null : (chat.membershipState ?? null),
      ...stateOf(chat, now()),
      createdAt: now(),
      updatedAt: now(),
    })
    .onConflictDoUpdate({
      target: [chats.accountId, chats.externalId],
      set: {
        kind: sql`excluded.kind`,
        ...(chat.parentChatId === undefined ? {} : { parentChatId: sql`excluded.parent_chat_id` }),
        scope: sql`coalesce(excluded.scope, ${chats.scope})`,
        ...(chat.title === undefined ? {} : { title: sql`excluded.title`, titleFolded: sql`excluded.title_folded` }),
        ...(chat.unreadCount === undefined
          ? {}
          : { unreadCount: sql`excluded.unread_count`, unreadCountedAt: sql`excluded.unread_counted_at` }),
        ...(chat.lastMessageAt === undefined ? {} : { lastMessageAt: sql`excluded.last_message_at` }),
        ...(chat.participantsCount === undefined ? {} : { participantsCount: sql`excluded.participants_count` }),
        metadata: sql`excluded.metadata`,
        ...membershipSet(chat.membershipState),
        ...(chat.muted === undefined ? {} : { muted: sql`excluded.muted`, mutedUntil: sql`excluded.muted_until` }),
        ...(chat.archived === undefined ? {} : { archived: sql`excluded.archived` }),
        ...(chat.markedUnread === undefined ? {} : { markedUnread: sql`excluded.marked_unread` }),
        updatedAt: sql`excluded.updated_at`,
      },
    })
    .run()
}

const bit = (value: boolean | undefined): number | null => (value === undefined ? null : value ? 1 : 0)

/**
 * The count is taken as of the chat's newest message where the update names it, else as of now: a message the store
 * saves later and sent after that point is one the count does not hold yet.
 */
const stateOf = (chat: ChatUpdate, at: number) => ({
  unreadCountedAt: chat.unreadCount === undefined ? null : (toMs(chat.lastMessageAt) ?? at),
  muted: bit(chat.muted),
  mutedUntil: chat.muted === true ? toMs(chat.mutedUntil) : null,
  archived: bit(chat.archived),
  markedUnread: bit(chat.markedUnread),
})

const membershipSet = (state: ChatUpdate["membershipState"]) => {
  if (state === undefined) return {}
  if (state === "member") return { membershipState: sql`nullif(${chats.membershipState}, 'left')` }
  return { membershipState: sql`excluded.membership_state` }
}

const mergedMetadata = (stored: string | null, incoming: ProviderMetadata | undefined): string | null => {
  if (incoming === undefined) return stored
  const merged = Object.entries({ ...metadataObject(stored), ...incoming }).filter(([, value]) => value !== null)
  return merged.length === 0 ? null : JSON.stringify(Object.fromEntries(merged))
}

// Stored metadata that is not an object has no keys to keep.
const metadataObject = (stored: string | null): ProviderMetadata => {
  try {
    const value: unknown = stored === null ? null : JSON.parse(stored)
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as ProviderMetadata) : {}
  } catch {
    return {}
  }
}

/** Replaces who is in the chat, whole. */
export const writeMembers = (
  context: StoreContext,
  key: AccountKey,
  accountKey: number,
  chatId: Id,
  memberIds: Id[],
): void => {
  const chatKey = chatPkFor(context, accountKey, chatId)
  context.orm.delete(chatMembers).where(eq(chatMembers.chatId, chatKey)).run()
  for (const id of new Set(memberIds)) {
    context.orm
      .insert(chatMembers)
      .values({
        chatId: chatKey,
        identityId: identityPk(context, accountKey, key.provider, id, null),
        createdAt: context.now(),
      })
      .run()
  }
}

export const members = ({ orm }: StoreContext, chatKey: number): Member[] =>
  orm
    .select({ id: identities.externalId, name: identities.name, username: identities.username })
    .from(chatMembers)
    .innerJoin(identities, eq(identities.id, chatMembers.identityId))
    .where(eq(chatMembers.chatId, chatKey))
    .orderBy(sql`${identities.name} IS NULL`, identities.name, identities.externalId)
    .all()

const byRecency = [sql`${chats.lastMessageAt} DESC NULLS LAST`, chats.id]

const notLeft = sql`${chats.membershipState} IS NOT 'left'`

const named = (present: Id[]) => sql`${chats.externalId} IN (SELECT value FROM json_each(${JSON.stringify(present)}))`

/** Takes the left mark off the chats `present` names; any other state is kept. Answers how many. */
export const rejoin = ({ orm }: StoreContext, accountKey: number, present: Id[]): number =>
  orm
    .update(chats)
    .set({ membershipState: null })
    .where(and(eq(chats.accountId, accountKey), eq(chats.membershipState, "left"), named(present)))
    .returning({ pk: chats.id })
    .all().length

/**
 * Marks this account's chats that `present` does not name, and rejoins those it names. Only ever given a complete
 * list. Answers how many it marked.
 */
export const markLeft = (context: StoreContext, accountKey: number, present: Id[]): number => {
  revisedBy(context, "rejoin", () => rejoin(context, accountKey, present))
  return context.orm
    .update(chats)
    .set({ membershipState: "left" })
    .where(and(eq(chats.accountId, accountKey), notLeft, sql`NOT (${named(present)})`))
    .returning({ pk: chats.id })
    .all().length
}

/** A chat marked left: its id, its title, and how many messages it holds. */
export interface LeftChat {
  id: Id
  title: string | null
  messages: number
}

/** The chats marked left, the ones holding the most messages first, and how many messages they hold. */
export const leftChats = (
  { orm }: StoreContext,
  accountKey: number,
): { pks: number[]; chats: LeftChat[]; messages: number } => {
  const found = orm
    .select({ pk: chats.id, id: chats.externalId, title: chats.title })
    .from(chats)
    .where(and(eq(chats.accountId, accountKey), eq(chats.membershipState, "left")))
    .all()
  const pks = found.map(({ pk }) => pk)
  const counts = new Map(
    pks.length === 0
      ? []
      : orm
          .select({ pk: messages.chatId, n: sql<number>`count(*)` })
          .from(messages)
          .where(inArray(messages.chatId, pks))
          .groupBy(messages.chatId)
          .all()
          .map(({ pk, n }) => [pk, Number(n)]),
  )
  const left = found
    .map(({ pk, id, title }) => ({ id, title, messages: counts.get(pk) ?? 0 }))
    .sort((a, b) => b.messages - a.messages || a.id.localeCompare(b.id))
  return { pks, chats: left, messages: left.reduce((sum, chat) => sum + chat.messages, 0) }
}

/** These chats and everything under them, children before parents: the foreign keys are enforced. */
export const purgeChats = ({ orm, database }: StoreContext, pks: number[]): void => {
  if (pks.length === 0) return
  const messagesOf = orm.select({ pk: messages.id }).from(messages).where(inArray(messages.chatId, pks))
  const chatPks = sql`(SELECT value FROM json_each(${JSON.stringify(pks)}))`
  const released = orm
    .delete(chunks)
    .where(
      sql`(${chunks.chunkableType}='conversation' AND ${chunks.chunkableId} IN (SELECT id FROM conversations WHERE chat_id IN ${chatPks}))
        OR (${chunks.chunkableType}='message' AND ${chunks.chunkableId} IN (SELECT id FROM messages WHERE chat_id IN ${chatPks}))
        OR (${chunks.chunkableType}='image' AND ${chunks.chunkableId} IN (SELECT a.id FROM attachments a
          JOIN messages m ON a.attachable_type = 'message' AND m.id = a.attachable_id WHERE m.chat_id IN ${chatPks}))`,
    )
    .returning({ hash: chunks.contentHash })
    .all()
  orm
    .delete(involvements)
    .where(
      sql`(${involvements.subjectType}='chat' AND ${involvements.subjectId} IN (SELECT value FROM json_each(${JSON.stringify(pks)}))) OR (${involvements.subjectType}='message' AND ${involvements.subjectId} IN (${messagesOf}))`,
    )
    .run()
  orm.delete(messageTranscripts).where(inArray(messageTranscripts.chatId, pks)).run()
  orm.delete(pollVotes).where(inArray(pollVotes.chatId, pks)).run()
  orm.delete(messageReactions).where(inArray(messageReactions.chatId, pks)).run()
  orm
    .delete(chatEventPeople)
    .where(
      inArray(
        chatEventPeople.chatEventId,
        orm.select({ id: chatEvents.id }).from(chatEvents).where(inArray(chatEvents.chatId, pks)),
      ),
    )
    .run()
  orm.delete(chatEvents).where(inArray(chatEvents.chatId, pks)).run()
  orm.delete(fetchLeases).where(inArray(fetchLeases.chatId, pks)).run()
  orm.delete(chatMembers).where(inArray(chatMembers.chatId, pks)).run()
  const observationsOf = orm
    .select({ id: memberObservations.id })
    .from(memberObservations)
    .where(inArray(memberObservations.chatId, pks))
  orm
    .delete(memberObservationMembers)
    .where(inArray(memberObservationMembers.memberObservationId, observationsOf))
    .run()
  orm.delete(memberObservations).where(inArray(memberObservations.chatId, pks)).run()
  orm.delete(memberStays).where(inArray(memberStays.chatId, pks)).run()
  orm.delete(memberCounts).where(inArray(memberCounts.chatId, pks)).run()
  orm.delete(syncRanges).where(inArray(syncRanges.chatId, pks)).run()
  orm.delete(messageRevisions).where(inArray(messageRevisions.messageId, messagesOf)).run()
  orm.delete(messages).where(inArray(messages.chatId, pks)).run()
  orm.delete(chats).where(inArray(chats.id, pks)).run()
  dropUnusedVectors(
    database,
    released.map(({ hash }) => hash),
  )
}

export const chatsWith = ({ orm, now }: StoreContext, accountKey: number, key: AccountKey, memberId: Id): Chat[] => {
  const rows = orm
    .select({ chat: chats })
    .from(chats)
    .where(
      and(
        eq(chats.accountId, accountKey),
        notLeft,
        or(
          inArray(
            chats.id,
            orm
              .select({ pk: chatMembers.chatId })
              .from(chatMembers)
              .innerJoin(identities, eq(identities.id, chatMembers.identityId))
              .where(and(eq(identities.provider, key.provider), eq(identities.externalId, memberId))),
          ),
          // Some providers name a private dialog by its partner's id without recording members.
          and(
            eq(chats.kind, "dialog"),
            eq(chats.externalId, memberId),
            sql`NOT EXISTS (SELECT 1 FROM ${chatMembers} WHERE ${chatMembers.chatId} = ${chats.id})`,
          ),
        ),
      ),
    )
    .orderBy(...byRecency)
    .all()
    .map(({ chat }) => chat)
  return toChats(orm, rows, now())
}

const chatsWhere = (accountKey: number, { where, includeLeft }: StoredChatFilter) =>
  and(
    eq(chats.accountId, accountKey),
    includeLeft ? undefined : notLeft,
    where === undefined ? undefined : bound(where),
  )

/**
 * How the store answers a chat list's query. `title:` goes through the trigram index, so it matches part of a
 * title, three characters or more, whatever the case.
 */
export const CHAT_COLUMNS = {
  id: { type: "kw", sql: "chats.external_id" },
  title: {
    where: (node) =>
      node.operator === "wildcard" && node.value === "*"
        ? { sql: "chats.title IS NOT NULL AND chats.title <> ''", params: [] }
        : {
            sql: "chats.id IN (SELECT rowid FROM chats_fts WHERE chats_fts MATCH ?)",
            params: [`"${titlePart(node.value).replaceAll('"', '""')}"`],
          },
  },
  kind: { type: "enum", sql: "chats.kind" },
  unread_count: { type: "num", sql: "chats.unread_count" },
  last_message_at: { type: "time", sql: "chats.last_message_at" },
  participants_count: { type: "num", sql: "chats.participants_count" },
} as const satisfies ColumnMap

export const TRACKED_CHAT_COLUMNS = { chat_id: CHAT_COLUMNS.id, title: CHAT_COLUMNS.title } as const satisfies ColumnMap

/** `title:*book*` and `title:book` ask the same: the title holds "book". */
export const titlePart = (value: string): string => value.replace(/^\*+|\*+$/g, "").trim()

export const listChats = (
  { orm, now }: StoreContext,
  accountKey: number,
  { limit, offset = 0, ...filter }: { limit?: number; offset?: number } & StoredChatFilter,
): Page<Chat> => {
  const rows = orm
    .select()
    .from(chats)
    .where(chatsWhere(accountKey, filter))
    .orderBy(...byRecency)
    .limit(limit === undefined ? -1 : limit + 1)
    .offset(offset)
    .all()
  return { items: toChats(orm, rows.slice(0, limit), now()), hasMore: limit !== undefined && rows.length > limit }
}

export const countChats = ({ orm }: StoreContext, accountKey: number, filter: StoredChatFilter): number =>
  Number(orm.select({ n: sql<number>`count(*)` }).from(chats).where(chatsWhere(accountKey, filter)).get()?.n)

const toChats = (orm: Orm, rows: (typeof chats.$inferSelect)[], at: number): Chat[] => {
  const ids = [...new Set(rows.flatMap((row) => (row.parentChatId === null ? [] : [row.parentChatId])))]
  const parents = new Map(
    ids.length === 0
      ? []
      : orm
          .select({ pk: chats.id, externalId: chats.externalId })
          .from(chats)
          .where(inArray(chats.id, ids))
          .all()
          .map((row) => [row.pk, row.externalId]),
  )
  return rows.map((row) => toChat(row, at, row.parentChatId === null ? undefined : parents.get(row.parentChatId)))
}

const flag = (stored: number | null): boolean | undefined => (stored === null ? undefined : stored === 1)

const toChat = (row: typeof chats.$inferSelect, at: number, parentId?: Id): Chat => ({
  id: row.externalId,
  title: row.title,
  kind: row.kind as Chat["kind"],
  unreadCount: row.unreadCount,
  lastMessageAt: toIso(row.lastMessageAt),
  participantsCount: row.participantsCount,
  ...present({
    scope: row.scope as Chat["scope"] | null,
    parentChatId: parentId ?? null,
    membershipState: row.membershipState,
    providerMetadata: withoutHistory(parsed(row.metadata)),
  }),
  ...muteOf(row, at),
  ...present({ archived: flag(row.archived), markedUnread: flag(row.markedUnread) }),
})

// A mute is read against the clock, so one that ran out needs no write to end.
const muteOf = ({ muted, mutedUntil }: typeof chats.$inferSelect, at: number): Pick<Chat, "muted" | "mutedUntil"> => {
  if (muted === null) return {}
  if (muted !== 1 || (mutedUntil !== null && mutedUntil <= at)) return { muted: false }
  return mutedUntil === null ? { muted: true } : { muted: true, mutedUntil: toIso(mutedUntil) }
}

export interface ChatMetadata {
  chatId: string
  title: string | null
  username: string | null
  description: string | null
  fetchedAt: string
}

const metadataChatPk = ({ database }: StoreContext, key: AccountKey, chatId: string) => {
  const row = database
    .prepare(
      "SELECT c.id FROM chats c JOIN accounts a ON a.id=c.account_id WHERE a.provider=? AND a.external_id=? AND c.external_id=?",
    )
    .get(key.provider, key.account, chatId)
  if (!row) throw new CliError("not_found", "no stored chat with that id in this account")
  return Number(row.id)
}

export const metadata = (context: StoreContext, key: AccountKey, chatId: string): ChatMetadata | undefined => {
  const row = context.database
    .prepare("SELECT * FROM chats WHERE id=? AND details_fetched_at IS NOT NULL")
    .get(metadataChatPk(context, key, chatId))
  return row
    ? {
        chatId,
        title: row.title == null ? null : String(row.title),
        username: row.username == null ? null : String(row.username),
        description: row.description == null ? null : String(row.description),
        fetchedAt: toIso(Number(row.details_fetched_at)) as string,
      }
    : undefined
}

export const saveMetadata = (context: StoreContext, key: AccountKey, entry: Omit<ChatMetadata, "fetchedAt">) => {
  revisedBy(context, "details", () =>
    context.database
      .prepare(
        "UPDATE chats SET title=?, title_folded=?, username=?, description=?, details_fetched_at=?, updated_at=? WHERE id=?",
      )
      .run(
        entry.title,
        folded(entry.title),
        entry.username,
        entry.description,
        context.now(),
        context.now(),
        metadataChatPk(context, key, entry.chatId),
      ),
  )
  return metadata(context, key, entry.chatId) as ChatMetadata
}

/** Called inside the store's transaction: claims and effective search tags change together. */
export const replaceAutoTags = (
  context: StoreContext,
  key: AccountKey,
  chatId: string,
  algorithm: string,
  matches: ChannelTagMatch[],
) => {
  const pk = metadataChatPk(context, key, chatId)
  const db = context.database
  db.prepare("DELETE FROM taggings WHERE taggable_type='chat' AND taggable_id=? AND source='auto'").run(pk)
  db.prepare("DELETE FROM canonical_auto_tag_claims WHERE chat_id=?").run(pk)
  const claims = new Map<number, { score: number; fields: string[] }>()
  for (const match of matches) {
    const tagId = ensureTag(context, match.tag).id
    const held = claims.get(tagId)
    claims.set(tagId, {
      score: Math.max(held?.score ?? match.score, match.score),
      fields: [...new Set([...(held?.fields ?? []), ...match.fields])],
    })
  }
  for (const [tagId, match] of claims) {
    db.prepare(
      "INSERT INTO canonical_auto_tag_claims (chat_id, tag_id, algorithm, score, fields, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(pk, tagId, algorithm, match.score, JSON.stringify(match.fields), context.now(), context.now())
    db.prepare(
      "INSERT INTO taggings (tag_id, taggable_type, taggable_id, source, created_at, updated_at) VALUES (?, 'chat', ?, 'auto', ?, ?) ON CONFLICT DO NOTHING",
    ).run(tagId, pk, context.now(), context.now())
  }
}
