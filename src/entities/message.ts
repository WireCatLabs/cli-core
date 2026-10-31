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
  sender_is_me: v.boolean(),
  mentions: v.optional(v.array(id)),
  /** When it was sent. */
  timestamp: time,
  edited_at: v.nullable(time),
  text,
  /** What a voice message says, once heard. */
  transcript: v.optional(text),
  /** In a window of messages around one, the one asked for. */
  anchor: v.optional(v.boolean()),
  /** A stretch of the text, transcript, file name or file text around what a search matched. */
  excerpt: v.optional(text),
  /** `picture`: the picture search lane found it by what the picture shows; it follows the text hits. */
  matched_in: v.optional(v.picklist(["text", "transcript", "filename", "file", "context", "picture"])),
  score: v.optional(v.number()),
  /**
   * `corrected`: a query word matched only a spelling speech recognition garbled in a voice note's transcript,
   * listed in `corrections`. `words` and `beginnings`: what a discovery search matched.
   */
  match: v.optional(v.picklist(["words", "beginnings", "corrected"])),
  corrections: v.optional(v.array(v.strictObject({ from: text, to: v.array(text) }))),
  /** Where a search found it: the local archive, the messenger's server, or both. */
  found_in: v.optional(v.picklist(["archive", "server", "both"])),
  /** A discovery search's partial match: how much of the question it covers, and which words it lacks. */
  discovery: v.optional(
    v.strictObject({
      coverage: v.number(),
      matched_terms: v.array(text),
      missing_terms: v.array(text),
      parent: v.optional(reference),
      /** Present when meaning was searched too: which of the two lists found it. */
      found_by: v.optional(v.array(v.picklist(["words", "meaning"]))),
      /** Present when the reranker read it: its own score, higher is better. It ordered the first hits with `score`. */
      reranker_score: v.optional(v.number()),
    }),
  ),
  /** The messages around a search hit, or its thread, oldest first; the hit itself is among them. */
  context: v.optional(
    v.array(v.strictObject({ ref: reference, timestamp: time, sender_name: v.nullable(text), text })),
  ),
  /**
   * A discovery hit's later messages, from any chat the search reads, that share a rare word with it, latest first:
   * one may change or cancel what the hit says.
   */
  follow_ups: v.optional(
    v.array(
      v.strictObject({
        ref: reference,
        chat_title: v.nullable(text),
        timestamp: time,
        sender_name: v.nullable(text),
        text,
      }),
    ),
  ),
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
  /** The owner starred it; only where the messenger has stars, and only when set. */
  starred: v.optional(v.literal(true)),
  /** The owner's own message in a one-to-one chat: `delivered`, or `read` once opened; absent when no receipt came. */
  delivery: v.optional(v.picklist(["delivered", "read"])),
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
      /** How much the sender's mail looks like spam, a scam or a robot (memo's score), and why; absent when unscored. */
      sender_score: v.optional(
        v.strictObject({ score: v.number(), signals: v.array(text), demoted: v.optional(v.literal(true)) }),
      ),
    }),
  ),
  provider_metadata: providerMetadata,
})
