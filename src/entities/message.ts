import * as v from "valibot"
import { attachment } from "./attachment.js"
import { count, id, providerMetadata, reference, text, time } from "./fields.js"

const quoted = v.strictObject({
  id,
  sender_id: v.nullable(id),
  sender_name: v.nullable(text),
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
  chat_id: id,
  chat_title: v.optional(v.nullable(text)),
  sender_id: v.nullable(id),
  sender_name: v.nullable(text),
  sender_username: v.optional(text),
  sender_is_chat: v.optional(v.boolean()),
  mentions: v.optional(v.array(id)),
  /** When it was sent. */
  timestamp: time,
  edited_at: v.nullable(time),
  text,
  /** A stretch of the text, transcript, file name or file text around what a search matched. */
  excerpt: v.optional(text),
  matched_in: v.optional(v.picklist(["text", "transcript", "filename", "file", "context"])),
  score: v.optional(v.number()),
  outgoing: v.nullable(v.boolean()),
  attachments: v.array(attachment),
  reply_to: v.nullable(quoted),
  /** The id a reply answers, also when the provider sent no copy of that message. */
  reply_to_id: v.optional(id),
  forwarded_from: v.nullable(quoted),
  thread_id: v.optional(id),
  thread_root_id: v.optional(id),
  reactions: v.optional(
    v.nullable(
      v.strictObject({
        counts: v.array(v.strictObject({ reaction: text, count })),
        mine: v.nullable(text),
        total: count,
      }),
    ),
  ),
  scheduled_for: v.optional(time),
  email: v.optional(
    v.strictObject({
      subject: v.nullable(text),
      from: v.nullable(mailPerson),
      to: v.array(mailPerson),
      cc: v.array(mailPerson),
      bcc: v.array(mailPerson),
      /** The mail header Reply-To; `reply_to` is the quoted message a chat reply answers. */
      reply_addresses: v.array(mailPerson),
      labels: v.array(text),
      /** The thread as a `chat:` reference. */
      thread: reference,
      read: v.nullable(v.boolean()),
      flagged: v.nullable(v.boolean()),
    }),
  ),
  provider_metadata: providerMetadata,
})
