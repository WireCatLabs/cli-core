import { CliError } from "@wirecat/cli-base"
import type { Attachment, ChatKind, Id, Message, Page, WindowedMessage } from "../../domain/models.js"
import type { ChatActivity, ChatStats, SenderChatStats } from "../types.js"
import { and, asc, desc, eq, gt, gte, inArray, isNull, lte, or, type SQL, sql } from "./drizzle/core.js"
import type { StoreContext } from "./open.js"
import type { ColumnMap, Where } from "./query-filter.js"
import { attachments, chats, identities, messageRevisions, messages } from "./schema.js"
import { deliveryOf, parsed, present, toIso, toMs } from "./values.js"

/**
 * One flat row for every read, aliased where tables share a column name, so the same mapper serves
 * a plain select and a subquery (`find` per chat).
 */
export const MESSAGE_FIELDS = {
  pk: messages.id,
  nativeId: messages.externalId,
  chatNativeId: sql<string>`${chats.externalId}`.as("chat_native_id"),
  senderNativeId: sql<string | null>`${identities.externalId}`.as("sender_native_id"),
  senderChatNativeId: messages.senderChatExternalId,
  senderName: messages.senderName,
  sentAt: messages.sentAt,
  editedAt: messages.editedAt,
  text: messages.text,
  outgoing: messages.outgoing,
  replyTo: messages.replyTo,
  replyToNativeId: messages.replyToExternalId,
  forward: messages.forward,
  threadNativeId: messages.threadExternalId,
  reactions: messages.reactions,
  providerMetadata: messages.metadata,
  mentions: messages.mentions,
  starred: messages.starred,
  delivery: messages.delivery,
}

export interface MessageRow {
  pk: number
  nativeId: string
  chatNativeId: string
  senderNativeId: string | null
  senderChatNativeId: string | null
  senderName: string | null
  sentAt: number
  editedAt: number | null
  text: string
  outgoing: number | null
  replyTo: string | null
  replyToNativeId: string | null
  forward: string | null
  threadNativeId: string | null
  reactions: string | null
  providerMetadata: string | null
  mentions: string | null
  starred: number | null
  delivery: number | null
}

export const selectMessages = ({ orm }: StoreContext) =>
  orm
    .select(MESSAGE_FIELDS)
    .from(messages)
    .innerJoin(chats, eq(chats.id, messages.chatId))
    .leftJoin(identities, eq(identities.id, messages.senderIdentityId))

export const newestFirst = [desc(messages.sentAt), desc(messages.id)]

export const before = (sentAt: number, pk: number) => sql`(${messages.sentAt}, ${messages.id}) < (${sentAt}, ${pk})`

const after = (sentAt: number, pk: number) => sql`(${messages.sentAt}, ${messages.id}) > (${sentAt}, ${pk})`

const live = (chatKey: number, ...conditions: (SQL | undefined)[]) =>
  and(eq(messages.chatId, chatKey), isNull(messages.deletedAt), ...conditions)

export const toMessages = ({ orm }: StoreContext, rows: MessageRow[]): Message[] => {
  const byMessage = new Map<number, Attachment[]>()
  if (rows.length > 0) {
    const found = orm
      .select()
      .from(attachments)
      .where(
        and(
          eq(attachments.attachableType, "message"),
          inArray(
            attachments.attachableId,
            rows.map((row) => row.pk),
          ),
        ),
      )
      .orderBy(attachments.attachableId, attachments.position)
      .all()
    for (const row of found)
      byMessage.set(row.attachableId, [...(byMessage.get(row.attachableId) ?? []), toAttachment(row)])
  }
  return rows.map((row) => toMessage(row, byMessage.get(row.pk) ?? []))
}

export const countMessages = ({ orm }: StoreContext, chatKey: number, since: string | undefined): number =>
  Number(
    orm
      .select({ n: sql<number>`count(*)` })
      .from(messages)
      .where(live(chatKey, since === undefined ? undefined : gte(messages.sentAt, toMs(since) as number)))
      .get()?.n,
  )

/**
 * What changed in a chat after `at`, a time on this machine's clock: messages first saved or edited
 * since, oldest first, and the ids deleted since. Send time cannot answer it — an edit made today to
 * a message from last year was sent last year. A change to reactions alone leaves no time, so it is
 * not here.
 */
export const changesSince = (
  context: StoreContext,
  chatKey: number,
  at: number,
): { messages: Message[]; deleted: Id[] } => {
  const edited = context.orm
    .select({ pk: messageRevisions.messageId })
    .from(messageRevisions)
    .where(gt(messageRevisions.createdAt, at))
  const rows = selectMessages(context)
    .where(live(chatKey, or(gt(messages.createdAt, at), inArray(messages.id, edited))))
    .orderBy(asc(messages.sentAt), asc(messages.id))
    .all()
  const deleted = context.orm
    .select({ id: messages.externalId })
    .from(messages)
    .where(and(eq(messages.chatId, chatKey), gt(messages.deletedAt, at)))
    .orderBy(asc(messages.deletedAt), asc(messages.id))
    .all()
  return { messages: toMessages(context, rows), deleted: deleted.map((row) => row.id) }
}

export const messagesWindow = (
  context: StoreContext,
  chatKey: number,
  { at, before: earlier, after: later }: { at: string; before: number; after: number },
): Message[] => {
  const moment = toMs(at) as number
  const older = selectMessages(context)
    .where(live(chatKey, lte(messages.sentAt, moment)))
    .orderBy(...newestFirst)
    .limit(earlier)
    .all()
  const newer = selectMessages(context)
    .where(live(chatKey, gt(messages.sentAt, moment)))
    .orderBy(asc(messages.sentAt), asc(messages.id))
    .limit(later)
    .all()
  return toMessages(context, [...older.reverse(), ...newer])
}

export const messagePage = (
  context: StoreContext,
  chatKey: number,
  {
    limit,
    before: anchorId,
    since,
    threadId,
    outgoing,
    starred,
  }: { limit: number; before?: Id; since?: string; threadId?: Id; outgoing?: boolean; starred?: boolean },
): Page<Message> => {
  const anchor =
    anchorId === undefined
      ? undefined
      : context.orm
          .select({ sentAt: messages.sentAt, pk: messages.id })
          .from(messages)
          .where(and(eq(messages.chatId, chatKey), eq(messages.externalId, anchorId)))
          .get()
  if (anchorId !== undefined && !anchor) {
    throw new CliError("not_found", `message ${anchorId} is not in the local copy of this chat`)
  }
  const rows = selectMessages(context)
    .where(
      live(
        chatKey,
        anchor ? before(anchor.sentAt, anchor.pk) : undefined,
        since === undefined ? undefined : gte(messages.sentAt, toMs(since) as number),
        threadId === undefined ? undefined : eq(messages.threadExternalId, threadId),
        outgoing === undefined
          ? undefined
          : outgoing
            ? eq(messages.outgoing, 1)
            : or(eq(messages.outgoing, 0), isNull(messages.outgoing)),
        starred === undefined
          ? undefined
          : starred
            ? sql`${messages.starred} = 1`
            : or(eq(messages.starred, 0), isNull(messages.starred)),
      ),
    )
    .orderBy(...newestFirst)
    .limit(limit + 1)
    .all()
  return { items: toMessages(context, rows.slice(0, limit)).reverse(), hasMore: rows.length > limit }
}

export const around = (
  context: StoreContext,
  chatKey: number | undefined,
  messageId: Id,
  { before: earlier, after: later }: { before: number; after: number },
): WindowedMessage[] => {
  const anchor =
    chatKey === undefined
      ? undefined
      : selectMessages(context)
          .where(live(chatKey, eq(messages.externalId, messageId)))
          .get()
  if (chatKey === undefined || !anchor) {
    throw new CliError("not_found", `message ${messageId} is not in the local copy of this chat`)
  }
  const side = (older: boolean, count: number) =>
    count === 0
      ? []
      : selectMessages(context)
          .where(live(chatKey, older ? before(anchor.sentAt, anchor.pk) : after(anchor.sentAt, anchor.pk)))
          .orderBy(...(older ? newestFirst : [asc(messages.sentAt), asc(messages.id)]))
          .limit(count)
          .all()
  const rows = [...side(true, earlier).reverse(), anchor, ...side(false, later)]
  return toMessages(context, rows).map((message, index) =>
    rows[index]?.pk === anchor.pk ? { ...message, anchor: true } : message,
  )
}

export const message = (
  context: StoreContext,
  accountKey: number,
  messageId: Id,
  chatId: Id | undefined,
): Message | undefined => {
  const rows = selectMessages(context)
    .where(
      and(
        eq(messages.accountId, accountKey),
        eq(messages.externalId, messageId),
        isNull(messages.deletedAt),
        chatId === undefined ? undefined : eq(chats.externalId, chatId),
      ),
    )
    .limit(2)
    .all()
  if (rows.length > 1) {
    throw new CliError("validation_error", `message ${messageId} is in more than one chat — name the chat`)
  }
  return toMessages(context, rows)[0]
}

export const chatStats = ({ orm }: StoreContext, accountKey: number, chatId: Id | undefined): ChatStats[] => {
  const newest = sql<number | null>`max(${messages.sentAt})`
  return orm
    .select({
      chatId: chats.externalId,
      title: chats.title,
      kind: chats.kind,
      messages: sql<number>`count(${messages.id})`,
      oldest: sql<number | null>`min(${messages.sentAt})`,
      newest,
      stored: sql<number | null>`max(${messages.createdAt})`,
    })
    .from(chats)
    .innerJoin(messages, and(eq(messages.chatId, chats.id), isNull(messages.deletedAt)))
    .where(and(eq(chats.accountId, accountKey), chatId === undefined ? undefined : eq(chats.externalId, chatId)))
    .groupBy(chats.id)
    .orderBy(desc(newest))
    .all()
    .map((row) => ({
      chatId: row.chatId,
      title: row.title,
      kind: row.kind as ChatKind,
      messages: Number(row.messages),
      oldestAt: toIso(row.oldest),
      newestAt: toIso(row.newest),
      lastStoredAt: toIso(row.stored),
    }))
}

/** One sender's stored messages per chat — count, first and last — in one grouped read. */
export const senderStats = (
  { orm }: StoreContext,
  accountKey: number,
  provider: string,
  senderId: Id,
): SenderChatStats[] => {
  const newest = sql<number | null>`max(${messages.sentAt})`
  return orm
    .select({
      chatId: chats.externalId,
      title: chats.title,
      kind: chats.kind,
      messages: sql<number>`count(${messages.id})`,
      oldest: sql<number | null>`min(${messages.sentAt})`,
      newest,
    })
    .from(messages)
    .innerJoin(chats, eq(chats.id, messages.chatId))
    .innerJoin(identities, eq(identities.id, messages.senderIdentityId))
    .where(
      and(
        eq(chats.accountId, accountKey),
        isNull(messages.deletedAt),
        eq(identities.provider, provider),
        eq(identities.externalId, senderId),
      ),
    )
    .groupBy(chats.id)
    .orderBy(desc(newest))
    .all()
    .map((row) => ({
      chatId: row.chatId,
      title: row.title,
      kind: row.kind as ChatKind,
      messages: Number(row.messages),
      firstAt: toIso(row.oldest),
      lastAt: toIso(row.newest),
    }))
}

const toAttachment = (row: typeof attachments.$inferSelect): Attachment =>
  ({
    kind: row.kind,
    ...present({
      url: row.url,
      width: row.width,
      height: row.height,
      title: row.title,
      name: row.name,
      size: row.size,
      mime: row.mime,
      duration: row.duration,
      providerRef: parsed(row.providerRef),
      contact: parsed(row.contact),
    }),
  }) as Attachment

const toMessage = (row: MessageRow, attachments: Attachment[]): Message => {
  const senderChat = row.senderChatNativeId
  return {
    id: row.nativeId,
    chatId: row.chatNativeId,
    senderId: senderChat ?? row.senderNativeId ?? null,
    senderName: row.senderName,
    ...(senderChat ? { senderIsChat: true } : {}),
    timestamp: toIso(row.sentAt) as string,
    editedAt: toIso(row.editedAt),
    text: row.text,
    outgoing: row.outgoing === null ? null : row.outgoing === 1,
    attachments,
    replyTo: parsed(row.replyTo) ?? null,
    ...present({ replyToId: row.replyToNativeId }),
    forwardedFrom: parsed(row.forward) ?? null,
    ...present({ threadId: row.threadNativeId }),
    reactions: parsed(row.reactions) ?? null,
    ...present({ providerMetadata: parsed(row.providerMetadata), mentions: parsed(row.mentions) }),
    ...(row.starred === 1 ? { starred: true } : {}),
    ...present({ delivery: deliveryOf(row.delivery) }),
  } as Message
}

/**
 * Each chat that spoke since `since` (ms): its newest message — by the chat list or by what is stored,
 * whichever is later — and, when that message is stored, which it is and whether the owner sent it;
 * never the text. A dialog has no title, so it takes the name its other side last wrote under.
 * `storedAt` is when the store last saved any message of the account.
 */
/** `tasks agenda` fields over `chatActivity`'s chats. */
export const AGENDA_COLUMNS = { chat_kind: { type: "enum", sql: "c.kind" } } as const satisfies ColumnMap

export const chatActivity = (
  { database }: StoreContext,
  accountKey: number,
  since: number,
  where?: Where,
): { chats: ChatActivity[]; storedAt: string | null } => ({
  chats: database
    .prepare(
      "SELECT c.external_id AS chat, c.kind, c.last_message_at AS listed, m.external_id AS message, m.sent_at, m.outgoing, " +
        "coalesce(c.title, (SELECT sender_name FROM messages WHERE chat_id = c.id AND outgoing = 0 AND deleted_at IS NULL " +
        "ORDER BY sent_at DESC LIMIT 1)) AS title " +
        "FROM chats c LEFT JOIN messages m ON m.id = (SELECT id FROM messages WHERE chat_id = c.id AND deleted_at IS NULL " +
        "ORDER BY sent_at DESC, id DESC LIMIT 1) " +
        "WHERE c.account_id = ? AND max(coalesce(m.sent_at, 0), coalesce(c.last_message_at, 0)) >= ?" +
        (where ? ` AND (${where.sql})` : ""),
    )
    .all(accountKey, since, ...(where?.params ?? []))
    .map((row) => {
      const sent = row.sent_at == null ? null : Number(row.sent_at)
      const listed = row.listed == null ? null : Number(row.listed)
      const stored = sent !== null && (listed === null || sent >= listed)
      return {
        chatId: String(row.chat),
        title: row.title == null ? null : String(row.title),
        kind: String(row.kind) as ChatKind,
        lastMessageAt: toIso(Math.max(sent ?? 0, listed ?? 0)) as string,
        lastMessageId: stored ? String(row.message) : null,
        lastFromOwner: stored && row.outgoing != null ? Number(row.outgoing) === 1 : null,
      }
    })
    .sort((a, b) => Date.parse(b.lastMessageAt) - Date.parse(a.lastMessageAt)),
  storedAt: toIso(
    Number(database.prepare("SELECT max(created_at) AS at FROM messages WHERE account_id = ?").get(accountKey)?.at) ||
      null,
  ),
})
