import * as v from "valibot"
import { chat } from "./chat.js"
import { linkedPerson } from "./contact-activity.js"
import { count, id, reference, text, time } from "./fields.js"
import { message } from "./message.js"

const contextPerson = v.strictObject({ ...linkedPerson.entries, provider: text, id })
const contextMessage = v.strictObject({
  locator: reference,
  provider: text,
  account: id,
  chat_id: id,
  chat_title: v.nullable(text),
  id,
  timestamp: time,
  sender_id: v.nullable(id),
  sender_name: v.nullable(text),
  outgoing: v.nullable(v.boolean()),
  text,
})
const sharedChat = v.strictObject({
  provider: text,
  account: id,
  chat_id: id,
  title: v.nullable(text),
  kind: chat.entries.kind,
  last_message_at: v.nullable(time),
})
const contextEvent = v.strictObject({
  ref: reference,
  title: v.nullable(text),
  starts_at: v.nullable(time),
  ends_at: v.nullable(time),
  all_day: v.boolean(),
  location: v.nullable(text),
  status: v.nullable(text),
})
const context = v.strictObject({
  person: contextPerson,
  shared: v.array(sharedChat),
  last: v.strictObject({
    from_them: v.nullable(contextMessage),
    from_me: v.nullable(contextMessage),
    from_them_anywhere: v.nullable(contextMessage),
  }),
  recent: v.strictObject({ direct: v.array(contextMessage), groups: v.array(contextMessage) }),
  mentions: v.array(contextMessage),
  /** Calendar events they are invited to, one occurrence per series. */
  events: v.optional(v.strictObject({ upcoming: v.array(contextEvent), recent: v.array(contextEvent) })),
  limits: v.strictObject({ messages: count, bytes: count }),
  complete: v.boolean(),
  not_read: v.array(
    v.strictObject({
      provider: text,
      account: id,
      chat_id: id,
      title: v.nullable(text),
      reason: v.picklist(["not_fetched", "partial"]),
    }),
  ),
})

const shortMessage = v.strictObject({ at: time, text, transcript: v.optional(text) })
const identifiedMessage = v.strictObject({
  ...shortMessage.entries,
  id,
  locator: reference,
  sender_id: v.nullable(id),
  reply_to: v.nullable(id),
})
const counterObservation = v.strictObject({
  value: v.number(),
  observed_at: time,
  source: v.picklist(["remote_fetch", "remote_update"]),
  reactions: v.optional(message.entries.reactions.wrapped.wrapped),
})
const { reply_addresses: mailReplyTo, ...mailFields } = message.entries.email.wrapped.entries
const fullMessage = v.strictObject({
  ...v.pick(message, [
    "id",
    "chat_id",
    "chat_title",
    "excerpt",
    "sender_id",
    "sender_name",
    "sender_username",
    "mentions",
    "sender_is_chat",
    "timestamp",
    "edited_at",
    "text",
    "outgoing",
    "attachments",
    "reply_to",
    "reply_to_id",
    "forwarded_from",
    "thread_id",
    "thread_root_id",
    "scheduled_for",
    "provider_metadata",
    "delivery",
  ]).entries,
  reactions: v.nullable(message.entries.reactions.wrapped.wrapped),
  starred: v.optional(v.boolean()),
  email: v.optional(v.strictObject({ ...mailFields, reply_to: mailReplyTo })),
  counter_observations: v.optional(
    v.partial(
      v.strictObject({
        views: counterObservation,
        reactions: counterObservation,
        comments: counterObservation,
      }),
    ),
  ),
  ...shortMessage.entries,
  locator: reference,
})
export const contactMessages = v.strictObject({
  person: v.strictObject({ uid: id, provider: text, id, name: v.nullable(text) }),
  chats: v.array(
    v.strictObject({
      chat: v.pick(chat, ["id", "title", "kind"]),
      messages: v.array(v.union([shortMessage, identifiedMessage, fullMessage])),
      complete: v.boolean(),
      more: v.boolean(),
    }),
  ),
  limits: v.strictObject({ messages: count }),
})

/** --chat returns selected message windows; without it the result is the cross-account context. */
export const contactContext = v.union([context, contactMessages])

const coverage = v.strictObject({
  included: count,
  has_more: v.boolean(),
  cut_by: v.nullable(v.picklist(["limit", "bytes"])),
})
const meetingCue = v.strictObject({
  reference,
  fingerprint: text,
  transcript_id: count,
  content_hash: v.nullable(text),
  position: count,
  start_ms: count,
  end_ms: count,
  speaker_participant_id: v.nullable(count),
  speaker_name: v.nullable(text),
  text,
  revision: v.picklist(["current", "superseded"]),
})
export const contactPreparation = v.strictObject({
  ...context.entries,
  prepare: v.strictObject({
    waiting: v.array(
      v.strictObject({
        provider: text,
        account: id,
        chat_id: id,
        title: v.nullable(text),
        message: contextMessage,
        partial: v.boolean(),
      }),
    ),
    tasks: v.array(
      v.strictObject({
        ref: reference,
        title: text,
        role: text,
        due_at: v.nullable(time),
        project: reference,
        source: v.nullable(reference),
        created_at: time,
      }),
    ),
    facts: v.array(
      v.strictObject({
        ref: reference,
        type: text,
        statement: text,
        subject: v.nullable(reference),
        project: v.nullable(reference),
        updated_at: time,
      }),
    ),
    notes: v.array(
      v.strictObject({ ref: reference, title: v.nullable(text), text, revision: count, updated_at: time }),
    ),
    meetings: v.array(
      v.strictObject({
        reference,
        cues: v.array(meetingCue),
        cue_coverage: v.strictObject({ included: count, omitted: v.nullable(count), has_more: v.boolean() }),
      }),
    ),
    limits: v.strictObject({ items: count, bytes: count }),
    coverage: v.strictObject({
      waiting: v.strictObject({
        ...coverage.entries,
        rule: v.literal("their message is the newest the store holds in a one-to-one chat"),
      }),
      tasks: v.strictObject({
        ...coverage.entries,
        selection: v.literal("open, assigned to them in any role"),
        accounts: v.array(text),
      }),
      facts: v.strictObject({
        ...coverage.entries,
        selection: v.literal("accepted, about them or a project they are a member of"),
      }),
      notes: v.strictObject({
        ...coverage.entries,
        selection: v.literal("written by you, about them"),
        withheld: v.optional(v.literal("contacts.notes.list")),
      }),
      meetings: v.strictObject({
        ...coverage.entries,
        read: v.literal("every account of the store that saw them"),
        accounts: v.array(text),
        pending: count,
      }),
    }),
  }),
})
