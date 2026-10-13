import * as v from "valibot"
import { attachment } from "./attachment.js"
import { count, id, providerMetadata, reference, text, time } from "./fields.js"

const quoted = v.strictObject({
  id,
  senderId: v.nullable(id),
  senderName: v.nullable(text),
  timestamp: v.nullable(time),
  text,
  attachments: v.array(attachment),
  outgoing: v.nullable(v.boolean()),
})

const mailPerson = v.strictObject({ name: v.nullable(text), address: text, ref: v.nullable(reference) })

export const message = v.strictObject({
  /** The message's locator. */
  ref: reference,
  id,
  provider: v.optional(text),
  account: v.optional(text),
  chatId: id,
  chatTitle: v.optional(v.nullable(text)),
  senderId: v.nullable(id),
  senderName: v.nullable(text),
  senderUsername: v.optional(text),
  senderIsChat: v.optional(v.boolean()),
  mentions: v.optional(v.array(id)),
  /** When it was sent. */
  timestamp: time,
  editedAt: v.nullable(time),
  text,
  /** A stretch of the text, transcript, file name or file text around what a search matched. */
  excerpt: v.optional(text),
  matchedIn: v.optional(v.picklist(["text", "transcript", "filename", "file"])),
  score: v.optional(v.number()),
  outgoing: v.nullable(v.boolean()),
  attachments: v.array(attachment),
  replyTo: v.nullable(quoted),
  /** The id a reply answers, also when the provider sent no copy of that message. */
  replyToId: v.optional(id),
  forwardedFrom: v.nullable(quoted),
  threadId: v.optional(id),
  threadRootId: v.optional(id),
  reactions: v.optional(
    v.nullable(
      v.strictObject({
        counts: v.array(v.strictObject({ reaction: text, count })),
        mine: v.nullable(text),
        total: count,
      }),
    ),
  ),
  scheduledFor: v.optional(time),
  email: v.optional(
    v.strictObject({
      subject: v.nullable(text),
      from: v.nullable(mailPerson),
      to: v.array(mailPerson),
      cc: v.array(mailPerson),
      bcc: v.array(mailPerson),
      replyTo: v.array(mailPerson),
      labels: v.array(text),
      /** The thread as a `chat:` reference. */
      thread: reference,
      read: v.nullable(v.boolean()),
      flagged: v.nullable(v.boolean()),
    }),
  ),
  providerMetadata,
})
