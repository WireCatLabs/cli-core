import { CliError } from "@wirecat/cli-base"
import type * as v from "valibot"
import { formatLocator, parseLocator } from "../../domain/locator.js"
import {
  type Attachment,
  type MailPerson,
  type Message,
  type MessageHit,
  type QuotedMessage,
  senderIsMe,
} from "../../domain/models.js"
import type { message as messageSchema } from "../../entities/message.js"
import type { MessengerAdapter } from "../../ports/messenger.js"
import type { AccountKey } from "../../store/store.js"
import type { Messenger, MessengerContext } from "./context.js"

export type MessageItem = v.InferOutput<typeof messageSchema>

/** What a read hands over: a message, sometimes found by a search, heard, or the anchor of a window. */
export type ReadMessage = Message &
  Partial<Pick<MessageHit, "chatTitle" | "email" | "excerpt">> & {
    locator?: string
    transcript?: string
    anchor?: boolean
  }

const defined = <T extends object>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter(([, one]) => one !== undefined)) as T

const attachmentItem = (attachment: Attachment) =>
  defined({
    kind: attachment.kind,
    url: attachment.url,
    name: attachment.name,
    title: attachment.title,
    mime: attachment.mime,
    size: attachment.size,
    width: attachment.width,
    height: attachment.height,
    duration: attachment.duration,
    contact:
      attachment.contact &&
      defined({
        name: attachment.contact.name,
        first_name: attachment.contact.firstName,
        last_name: attachment.contact.lastName,
        phone: attachment.contact.phone,
        user_id: attachment.contact.userId,
      }),
    buttons: attachment.buttons,
  })

const quotedItem = (quoted: QuotedMessage | null) =>
  quoted === null
    ? null
    : {
        id: quoted.id,
        sender_id: quoted.senderId,
        sender_name: quoted.senderName,
        timestamp: quoted.timestamp,
        text: quoted.text,
        attachments: quoted.attachments.map(attachmentItem),
        outgoing: quoted.outgoing,
      }

const mailPerson = ({ name, address, ref }: MailPerson) => ({ name, address, ref })

/**
 * A message as every command answers it. The ref is the message's locator: the one a store hit carries, else
 * built from the account that read it. What only the adapter needs (`providerRef`) stays behind.
 */
export const messageItem = (message: ReadMessage, reader: AccountKey): MessageItem => {
  const { provider, account } = message.locator === undefined ? reader : parseLocator(message.locator)
  return defined({
    ref: message.locator ?? formatLocator({ provider, account, chat: message.chatId, message: message.id }),
    id: message.id,
    provider,
    account,
    chat_id: message.chatId,
    chat_title: message.chatTitle,
    sender_id: message.senderId,
    sender_name: message.senderName,
    sender_username: message.senderUsername,
    sender_is_chat: message.senderIsChat,
    sender_is_me: senderIsMe(message, account),
    mentions: message.mentions,
    timestamp: message.timestamp,
    edited_at: message.editedAt,
    text: message.text,
    transcript: message.transcript,
    anchor: message.anchor === true ? true : undefined,
    excerpt: message.excerpt,
    outgoing: message.outgoing,
    attachments: message.attachments.map(attachmentItem),
    reply_to: quotedItem(message.replyTo),
    reply_to_id: message.replyToId,
    forwarded_from: quotedItem(message.forwardedFrom),
    thread_id: message.threadId,
    thread_root_id: message.threadRootId,
    reactions: message.reactions,
    scheduled_for: message.scheduledFor,
    starred: message.starred === true ? true : undefined,
    delivery: message.delivery,
    email:
      message.email === undefined
        ? undefined
        : {
            subject: message.email.subject,
            from: message.email.from === null ? null : mailPerson(message.email.from),
            to: message.email.to.map(mailPerson),
            cc: message.email.cc.map(mailPerson),
            bcc: message.email.bcc.map(mailPerson),
            reply_addresses: message.email.replyTo.map(mailPerson),
            labels: message.email.labels,
            thread: message.email.thread,
            read: message.email.read,
            flagged: message.email.flagged,
            sender_score: message.email.senderScore,
          },
    provider_metadata: message.providerMetadata,
  }) as MessageItem
}

export const messageItems = (messages: readonly ReadMessage[], account: AccountKey): MessageItem[] =>
  messages.map((message) => messageItem(message, account))

/** The account a connection reads as, which names each message's locator. */
export const selfOf = (messenger: Pick<Messenger, "provider">, adapter: MessengerAdapter): AccountKey => {
  const self = adapter.self()
  if (self === null) throw new CliError("authentication_error", "the connection does not know whose account it is")
  return { provider: messenger.provider, account: self }
}

/** How a person sees messages in this profile's terminal. */
export const viewOf = (context: MessengerContext, messenger: Messenger) => ({
  color: context.color,
  verbosity: context.settings.detail,
  senderColors: context.settings.senderColors,
  profile: context.profile,
  provider: messenger.provider,
  locale: messenger.app.locale,
})
