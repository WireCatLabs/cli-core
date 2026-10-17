import { validCounter } from "../../domain/counters.js"
import type { Attachment, ChatKind, Id, Message, Reactions } from "../../domain/models.js"
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
import { json, parsed, toMs } from "./values.js"
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
] as const

const placeholders = <const T extends string>(names: readonly T[]) =>
  Object.fromEntries(names.map((name) => [name, sql.placeholder(name)])) as Record<T, Placeholder<T>>

const prepare = (orm: Orm) => ({
  find: orm
    .select({
      pk: messages.id,
      text: messages.text,
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
            sql.raw(name === "providerRef" ? `coalesce(excluded.${column}, ${column})` : `excluded.${column}`),
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
): void => {
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
  if (found?.deletedAt != null && !revived) return
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
    if (found.providerMetadata) {
      try {
        const previous = JSON.parse(found.providerMetadata) as Record<string, unknown>
        const incoming = JSON.parse(String(fields.metadata ?? "{}")) as Record<string, unknown>
        if (previous && incoming && !Array.isArray(previous) && !Array.isArray(incoming)) {
          for (const field of ["views", "comments"])
            if (!validCounter(incoming[field]) && validCounter(previous[field])) incoming[field] = previous[field]
          fields.metadata = JSON.stringify(incoming)
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

  if (message.counterObservations) applyCounterObservations(context, pk, message.counterObservations)

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
    })
  })
  if (Number(heardFirst) > 0) intoVoiceAttachment(context, pk)
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
  purgeVectorsOf(context, pk)
  orm
    .delete(messageTranscripts)
    .where(and(eq(messageTranscripts.chatId, row.chatId), eq(messageTranscripts.messageExternalId, row.externalId)))
    .run()
  return 1
}

/** Whether the message is held at all. */
export const saveReactions = ({ orm }: StoreContext, chatKey: number, messageId: Id, reactions: Reactions): boolean =>
  orm
    .update(messages)
    .set({ reactions: JSON.stringify(reactions) })
    .where(and(eq(messages.chatId, chatKey), eq(messages.externalId, messageId), isNull(messages.deletedAt)))
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
