import { validCounter } from "../../domain/counters.js"
import type {
  Attachment,
  ChatKind,
  Delivery,
  Id,
  Message,
  PersonReaction,
  PollVote,
  Provider,
  Reactions,
} from "../../domain/models.js"
import type { CacheDatabase, CacheStatement } from "../driver.js"
import { NORMALIZER_VERSION, normalize } from "../normalize.js"
import type { AccountKey, DeletionScope } from "../types.js"
import { findChatPk } from "./chats.js"
import { applyCounterObservations } from "./counters.js"
import { and, eq, isNull, type Placeholder, sql } from "./drizzle/core.js"
import { folded } from "./folded.js"
import { identityPk } from "./identities.js"
import type { Orm, StoreContext } from "./open.js"
import { attachments, chats, messageRevisions, messages, messageTranscripts } from "./schema.js"
import { intoVoiceAttachment } from "./transcripts.js"
import { DELIVERY, json, parsed, toMs } from "./values.js"
import { purgeVectorsOf } from "./vectors.js"

const FIELDS = [
  "threadExternalId",
  "senderIdentityId",
  "senderChatExternalId",
  "senderName",
  "sentAt",
  "editedAt",
  "replyToExternalId",
  "replyTo",
  "forward",
  "outgoing",
  "reactions",
  "metadata",
  "mentions",
  "normalizedText",
  "normalizerVersion",
] as const

type Fields = Record<(typeof FIELDS)[number], string | number | null>

const ATTACHMENT_FIELDS = [
  "kind",
  "mime",
  "name",
  "title",
  "url",
  "size",
  "width",
  "height",
  "duration",
  "providerRef",
  "nameFolded",
  "contact",
] as const

const placeholders = <const T extends string>(names: readonly T[]) =>
  Object.fromEntries(names.map((name) => [name, sql.placeholder(name)])) as Record<T, Placeholder<T>>

const prepare = (orm: Orm) => ({
  find: orm
    .select({
      pk: messages.id,
      text: messages.text,
      sentAt: messages.sentAt,
      editedAt: messages.editedAt,
      deletedAt: messages.deletedAt,
      providerMetadata: messages.metadata,
    })
    .from(messages)
    .where(and(eq(messages.chatId, sql.placeholder("chatId")), eq(messages.externalId, sql.placeholder("externalId"))))
    .prepare(),
  insert: orm
    .insert(messages)
    .values(placeholders(["chatId", "accountId", "externalId", "text", "createdAt", "source", "updatedAt", ...FIELDS]))
    .returning({ pk: messages.id })
    .prepare(),
  // A copy that knows less — no reactions asked for, no quote sent, no sender — never erases what we had.
  update: orm
    .update(messages)
    .set(
      Object.fromEntries(
        FIELDS.map((name) => [name, sql`coalesce(${sql.placeholder(name)}, ${messages[name]})`]),
      ) as Record<(typeof FIELDS)[number], ReturnType<typeof sql>>,
    )
    .where(eq(messages.id, sql.placeholder("pk")))
    .prepare(),
  // Upserted by position, never replaced: a later fetch must not lose where the bytes were saved.
  attachment: orm
    .insert(attachments)
    .values({
      attachableType: "message",
      ...placeholders(["attachableId", "position", "createdAt", "updatedAt", ...ATTACHMENT_FIELDS]),
    })
    .onConflictDoUpdate({
      target: [attachments.attachableType, attachments.attachableId, attachments.position],
      // A later copy without the keys — an edit event, a second push — must not erase the ones that fetch the file.
      set: Object.fromEntries(
        ATTACHMENT_FIELDS.map((name) => {
          const column = attachments[name].name
          return [
            name,
            sql.raw(
              name === "providerRef" || name === "contact"
                ? `coalesce(excluded.${column}, ${column})`
                : `excluded.${column}`,
            ),
          ]
        }),
      ) as Record<(typeof ATTACHMENT_FIELDS)[number], ReturnType<typeof sql.raw>>,
    })
    .prepare(),
})

// Built once per store: they run for every message saved, and building a Drizzle query costs more than running it.
const prepared = new WeakMap<Orm, ReturnType<typeof prepare>>()
const statementsOf = (orm: Orm) => {
  const statements = prepared.get(orm) ?? prepare(orm)
  prepared.set(orm, statements)
  return statements
}

const refOf = (ref: Attachment["providerRef"]): string | null =>
  ref === undefined || ref === null || Object.keys(ref).length === 0 ? null : JSON.stringify(ref)

const fieldsOf = (message: Message, sender: number | null): Fields => ({
  threadExternalId: message.threadId ?? message.threadRootId ?? null,
  senderIdentityId: sender,
  senderChatExternalId: message.senderIsChat ? message.senderId : null,
  senderName: message.senderName,
  sentAt: toMs(message.timestamp) ?? 0,
  editedAt: toMs(message.editedAt),
  replyToExternalId: message.replyToId ?? message.replyTo?.id ?? null,
  replyTo: json(message.replyTo ?? undefined),
  forward: json(message.forwardedFrom ?? undefined),
  outgoing: message.outgoing === null ? null : Number(message.outgoing),
  reactions: json(message.reactions ?? undefined),
  metadata: json(message.providerMetadata),
  mentions: message.mentions?.length ? JSON.stringify(message.mentions) : null,
  normalizedText: normalize(message.text),
  normalizerVersion: NORMALIZER_VERSION,
})

export const upsertMessage = (
  context: StoreContext,
  key: AccountKey,
  accountKey: number,
  chatKey: number,
  message: Message,
  via: string,
  seenAt?: number,
): boolean => {
  const { orm, now } = context
  const statements = statementsOf(orm)
  const sender =
    message.senderId === null || message.senderIsChat
      ? null
      : identityPk(
          context,
          accountKey,
          key.provider,
          message.senderId,
          message.senderName,
          message.senderUsername === undefined ? {} : { username: message.senderUsername },
        )
  const fields = fieldsOf(message, sender)

  const found = statements.find.get({ chatId: chatKey, externalId: message.id })
  const revived = found?.deletedAt != null && seenAt !== undefined && found.deletedAt < seenAt
  // A deleted message leaves no text behind, and a sync that still carries it does not bring it back.
  if (found?.deletedAt != null && !revived) return false
  let pk: number
  if (!found) {
    pk = Number(
      statements.insert.get({
        chatId: chatKey,
        accountId: accountKey,
        externalId: message.id,
        text: message.text,
        createdAt: now(),
        source: via,
        updatedAt: now(),
        ...fields,
      })?.pk,
    )
  } else {
    pk = found.pk
    const edit = message.editedAt !== null
    // An edit event may carry only the new text, stamped with the edit's time: a send time never moves later,
    // and an edit that counts no reactions has not seen them.
    if (edit) {
      const incoming = Number(fields.sentAt)
      if (found.sentAt > 0 && (incoming <= 0 || found.sentAt < incoming)) fields.sentAt = found.sentAt
      if (message.reactions && message.reactions.total === 0 && message.reactions.counts.length === 0)
        fields.reactions = null
    }
    if (found.providerMetadata) {
      try {
        const previous = JSON.parse(found.providerMetadata) as Record<string, unknown>
        const incoming = JSON.parse(String(fields.metadata ?? "{}")) as Record<string, unknown>
        if (previous && incoming && !Array.isArray(previous) && !Array.isArray(incoming)) {
          for (const field of ["views", "comments"])
            if (!validCounter(incoming[field]) && validCounter(previous[field])) incoming[field] = previous[field]
          fields.metadata = JSON.stringify(edit ? { ...previous, ...incoming } : incoming)
        }
      } catch {
        /* Malformed old metadata remains untrusted. */
      }
    }
    statements.update.run({ ...fields, pk })
    // A tombstone emptied the text: there is no earlier version to keep.
    if (found.text !== message.text && !revived) {
      orm
        .insert(messageRevisions)
        .values({ messageId: pk, text: found.text, editedAt: found.editedAt, createdAt: now() })
        .run()
      orm.update(messages).set({ text: message.text }).where(eq(messages.id, pk)).run()
      purgeVectorsOf(context, pk)
    }
    if (revived) orm.update(messages).set({ deletedAt: null, text: message.text }).where(eq(messages.id, pk)).run()
  }

  const derived = derivedReactions(context, chatKey, message.id)
  if (derived)
    orm
      .update(messages)
      .set({ reactions: JSON.stringify(derived) })
      .where(eq(messages.id, pk))
      .run()
  if (message.counterObservations) applyCounterObservations(context, pk, message.counterObservations)
  if (message.starred !== undefined)
    orm
      .update(messages)
      .set({ starred: message.starred ? 1 : 0 })
      .where(eq(messages.id, pk))
      .run()
  if (message.delivery !== undefined)
    orm
      .update(messages)
      .set({ delivery: raised(message.delivery) })
      .where(and(eq(messages.id, pk), eq(messages.outgoing, 1)))
      .run()

  const root = message.threadRootId ?? message.threadId
  if (root !== undefined) {
    context.database
      .prepare(
        "UPDATE messages SET thread_root_id=(SELECT id FROM messages WHERE chat_id=? AND external_id=?) WHERE id=?",
      )
      .run(chatKey, root, pk)
  }
  context.database
    .prepare("UPDATE messages SET thread_root_id=? WHERE chat_id=? AND thread_external_id=? AND thread_root_id IS NULL")
    .run(pk, chatKey, message.id)
  const heardFirst = context.database
    .prepare(
      "UPDATE message_transcripts SET message_id=? WHERE chat_id=? AND message_external_id=? AND message_id IS NULL",
    )
    .run(pk, chatKey, message.id).changes
  message.attachments.forEach((attachment, position) => {
    statements.attachment.run({
      attachableId: pk,
      createdAt: now(),
      updatedAt: now(),
      position,
      kind: attachment.kind,
      mime: attachment.mime ?? null,
      name: attachment.name ?? null,
      nameFolded: folded(attachment.name),
      title: attachment.title ?? null,
      url: attachment.url ?? null,
      size: attachment.size ?? null,
      width: attachment.width ?? null,
      height: attachment.height ?? null,
      duration: attachment.duration ?? null,
      providerRef: refOf(attachment.providerRef),
      contact: attachment.contact ? JSON.stringify(attachment.contact) : null,
    })
  })
  if (Number(heardFirst) > 0) intoVoiceAttachment(context, pk)
  return !found
}

/**
 * One more unread for a message from someone else that the store first saw now, sent after the messenger's count was
 * taken. A chat the messenger never gave a count for is left alone: the store would count its whole history.
 */
export const countUnread = ({ database }: StoreContext, chatKey: number, message: Message): void => {
  if (message.outgoing || message.editedAt !== null) return
  database
    .prepare(
      `UPDATE chats SET unread_count = unread_count + 1
         WHERE id = ? AND unread_count IS NOT NULL AND unread_counted_at IS NOT NULL AND unread_counted_at < ?`,
    )
    .run(chatKey, Date.parse(message.timestamp))
}

/**
 * The owner's ruling (NEED-393 A): a deleted message keeps its row, so a later sync cannot bring it
 * back, and leaves no text — not in the row, the search copy, the edit history, a transcript or a vector.
 */
export const tombstone = (context: StoreContext, pk: number): number => {
  const { orm, now } = context
  const row = orm
    .update(messages)
    .set({ deletedAt: now(), text: "", normalizedText: null })
    .where(and(eq(messages.id, pk), isNull(messages.deletedAt)))
    .returning({ chatId: messages.chatId, externalId: messages.externalId })
    .get()
  if (!row) return 0
  context.database
    .prepare(
      "UPDATE attachments SET extraction=NULL, extractor=NULL, extraction_error=NULL, content_sha256=NULL, extracted_at=NULL, updated_at=? WHERE attachable_type='message' AND attachable_id=?",
    )
    .run(now(), pk)
  orm.delete(messageRevisions).where(eq(messageRevisions.messageId, pk)).run()
  context.database
    .prepare("DELETE FROM poll_votes WHERE chat_id=? AND message_external_id=?")
    .run(row.chatId, row.externalId)
  context.database
    .prepare("DELETE FROM message_reactions WHERE chat_id=? AND message_external_id=?")
    .run(row.chatId, row.externalId)
  purgeVectorsOf(context, pk)
  orm
    .delete(messageTranscripts)
    .where(and(eq(messageTranscripts.chatId, row.chatId), eq(messageTranscripts.messageExternalId, row.externalId)))
    .run()
  return 1
}

/** Whether the message is held at all. Where people's own reactions are held, the totals come from them instead. */
export const saveReactions = (context: StoreContext, chatKey: number, messageId: Id, reactions: Reactions): boolean =>
  context.orm
    .update(messages)
    .set({ reactions: JSON.stringify(derivedReactions(context, chatKey, messageId) ?? reactions) })
    .where(and(eq(messages.chatId, chatKey), eq(messages.externalId, messageId), isNull(messages.deletedAt)))
    .returning({ pk: messages.id })
    .all().length > 0

/** Answers whether the message is held; a deleted one keeps no star. */
export const saveStar = ({ orm }: StoreContext, chatKey: number, messageId: Id, starred: boolean): boolean =>
  orm
    .update(messages)
    .set({ starred: starred ? 1 : 0 })
    .where(and(eq(messages.chatId, chatKey), eq(messages.externalId, messageId), isNull(messages.deletedAt)))
    .returning({ pk: messages.id })
    .all().length > 0

const raised = (delivery: Delivery) => sql`max(coalesce(delivery, 0), ${DELIVERY[delivery]})`

/** Answers whether the owner's own message is held. A receipt is for a message the owner sent, so another's keeps none. */
export const saveDelivery = ({ orm }: StoreContext, chatKey: number, messageId: Id, delivery: Delivery): boolean =>
  orm
    .update(messages)
    .set({ delivery: raised(delivery) })
    .where(
      and(
        eq(messages.chatId, chatKey),
        eq(messages.externalId, messageId),
        eq(messages.outgoing, 1),
        isNull(messages.deletedAt),
      ),
    )
    .returning({ pk: messages.id })
    .all().length > 0

export const markDeleted = (
  context: StoreContext,
  accountKey: number,
  messageIds: Id[],
  chatId: Id | undefined,
  among?: DeletionScope,
): number => {
  const { orm } = context
  const chatKey = chatId === undefined ? undefined : findChatPk(context, accountKey, chatId)
  let changed = 0
  for (const messageId of messageIds) {
    const live = and(eq(messages.accountId, accountKey), eq(messages.externalId, messageId), isNull(messages.deletedAt))
    if (chatId !== undefined) {
      const found =
        chatKey === undefined
          ? undefined
          : orm
              .select({ pk: messages.id })
              .from(messages)
              .where(and(live, eq(messages.chatId, chatKey)))
              .get()
      if (found) changed += tombstone(context, found.pk)
      continue
    }
    if (!among) continue
    // Two candidates left means the id is ambiguous, and a missed tombstone is better than a wrong one.
    const candidates = orm
      .select({ pk: messages.id, id: chats.externalId, kind: chats.kind, providerMetadata: chats.metadata })
      .from(messages)
      .innerJoin(chats, eq(chats.id, messages.chatId))
      .where(live)
      .all()
      .filter(({ id, kind, providerMetadata }) =>
        among({ id, kind: kind as ChatKind, providerMetadata: parsed(providerMetadata) }),
      )
    if (candidates.length === 1 && candidates[0]) changed += tombstone(context, candidates[0].pk)
  }
  return changed
}

const voteStatements = new WeakMap<CacheDatabase, { gone: CacheStatement; upsert: CacheStatement }>()
const voteStatementsOf = (database: CacheDatabase) => {
  const held = voteStatements.get(database)
  if (held) return held
  const statements = {
    gone: database.prepare("SELECT 1 FROM messages WHERE chat_id=? AND external_id=? AND deleted_at IS NOT NULL"),
    upsert: database.prepare(
      `INSERT INTO poll_votes (chat_id, message_external_id, identity_id, answers, voted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (chat_id, message_external_id, identity_id) DO UPDATE SET
         answers = excluded.answers, voted_at = excluded.voted_at, updated_at = excluded.updated_at
       WHERE excluded.voted_at >= poll_votes.voted_at`,
    ),
  }
  voteStatements.set(database, statements)
  return statements
}

/** A vote older than the one held for that voter is dropped, and so is any vote in a deleted poll. */
export const saveVote = (
  context: StoreContext,
  accountKey: number,
  provider: Provider,
  chatKey: number,
  messageId: Id,
  { person, answers, votedAt }: PollVote,
): void => {
  const { database, now } = context
  const statements = voteStatementsOf(database)
  if (statements.gone.get(chatKey, messageId)) return
  const voter = identityPk(
    context,
    accountKey,
    provider,
    person.id,
    person.name,
    person.username ? { username: person.username } : {},
  )
  statements.upsert.run(chatKey, messageId, voter, JSON.stringify(answers), toMs(votedAt) ?? now(), now(), now())
}

export const pollVotes = ({ database }: StoreContext, chatKey: number, messageId: Id): PollVote[] =>
  (
    database
      .prepare(
        `SELECT i.external_id AS id, i.name, i.username, v.answers, v.voted_at AS votedAt
         FROM poll_votes v JOIN identities i ON i.id = v.identity_id
         WHERE v.chat_id = ? AND v.message_external_id = ?
         ORDER BY v.voted_at DESC, v.id DESC`,
      )
      .all(chatKey, messageId) as {
      id: string
      name: string | null
      username: string | null
      answers: string
      votedAt: number
    }[]
  ).map(({ id, name, username, answers, votedAt }) => ({
    person: { id, name, username },
    answers: JSON.parse(answers) as Id[],
    votedAt: new Date(votedAt).toISOString(),
  }))

const reactionStatements = new WeakMap<
  CacheDatabase,
  { gone: CacheStatement; upsert: CacheStatement; held: CacheStatement; total: CacheStatement }
>()
const reactionStatementsOf = (database: CacheDatabase) => {
  const held = reactionStatements.get(database)
  if (held) return held
  const statements = {
    gone: database.prepare("SELECT 1 FROM messages WHERE chat_id=? AND external_id=? AND deleted_at IS NOT NULL"),
    upsert: database.prepare(
      `INSERT INTO message_reactions
         (chat_id, message_external_id, identity_id, own, reaction, reacted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (chat_id, message_external_id, identity_id) DO UPDATE SET
         own = excluded.own, reaction = excluded.reaction, reacted_at = excluded.reacted_at,
         updated_at = excluded.updated_at
       WHERE excluded.reacted_at >= message_reactions.reacted_at`,
    ),
    held: database.prepare(
      "SELECT reaction, own, reacted_at AS reactedAt FROM message_reactions WHERE chat_id=? AND message_external_id=?",
    ),
    total: database.prepare("UPDATE messages SET reactions=? WHERE chat_id=? AND external_id=? AND deleted_at IS NULL"),
  }
  reactionStatements.set(database, statements)
  return statements
}

/**
 * The totals of the people's reactions the store holds for a message, or `undefined` when it holds none: then the
 * messenger's own totals stand. A taken-back reaction still counts as held, so all of them taken back is zero.
 */
export const derivedReactions = ({ database }: StoreContext, chatKey: number, messageId: Id): Reactions | undefined => {
  const rows = reactionStatementsOf(database).held.all(chatKey, messageId) as {
    reaction: string | null
    own: number
    reactedAt: number
  }[]
  if (rows.length === 0) return undefined
  const counts = new Map<string, { count: number; first: number }>()
  let mine: { reaction: string; at: number } | null = null
  for (const { reaction, own, reactedAt } of rows) {
    if (reaction === null) continue
    const held = counts.get(reaction)
    counts.set(reaction, { count: (held?.count ?? 0) + 1, first: Math.min(held?.first ?? reactedAt, reactedAt) })
    if (own === 1 && (mine === null || reactedAt > mine.at)) mine = { reaction, at: reactedAt }
  }
  const sorted = [...counts].sort(([, a], [, b]) => b.count - a.count || a.first - b.first)
  return {
    counts: sorted.map(([reaction, { count }]) => ({ reaction, count })),
    mine: mine?.reaction ?? null,
    total: sorted.reduce((sum, [, { count }]) => sum + count, 0),
  }
}

/** A reaction older than the one held for that person is dropped, and so is any reaction to a deleted message. */
export const saveReaction = (
  context: StoreContext,
  accountKey: number,
  provider: Provider,
  chatKey: number,
  messageId: Id,
  { person, own, reaction, reactedAt }: PersonReaction,
): void => {
  const { database, now } = context
  const statements = reactionStatementsOf(database)
  if (statements.gone.get(chatKey, messageId)) return
  const reactor = identityPk(
    context,
    accountKey,
    provider,
    person.id,
    person.name,
    person.username ? { username: person.username } : {},
  )
  const at = toMs(reactedAt) ?? now()
  statements.upsert.run(chatKey, messageId, reactor, own ? 1 : 0, reaction, at, now(), now())
  writeDerivedReactions(context, chatKey, messageId)
}

export const writeDerivedReactions = (context: StoreContext, chatKey: number, messageId: Id): void => {
  const derived = derivedReactions(context, chatKey, messageId)
  if (derived) reactionStatementsOf(context.database).total.run(JSON.stringify(derived), chatKey, messageId)
}
