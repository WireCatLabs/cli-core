import * as v from "valibot"
import { hitFile } from "./attachment.js"
import { count, reference, text, time, untrusted } from "./fields.js"

/** One result of `search all`: a message, a mail, a note, a calendar event or a meeting passage, best first. */
export const hit = v.strictObject({
  kind: v.picklist(["message", "mail", "note", "document", "event", "meeting"]),
  ref: reference,
  provider: text,
  url: v.optional(text),
  /** The account it was found in; a note's folder id, or `internal` for a note written in memo. */
  account: text,
  /** The chat, the mail thread's subject, the note's, the event's or the meeting's title. */
  title: v.nullable(text),
  /** Null for a meeting whose start is unknown. */
  timestamp: v.nullable(time),
  excerpt: text,
  sender_name: v.optional(v.nullable(text)),
  /** A message's or a mail's: whether the owner wrote it. */
  sender_is_me: v.optional(v.boolean()),
  /** The writer's `person:` reference, where the store has one. */
  sender_ref: v.optional(v.nullable(reference)),
  found_by: v.optional(v.array(v.picklist(["title", "words", "meaning"]))),
  /** How far into the meeting the passage is. */
  offset_ms: v.optional(v.nullable(count)),
  /** A meeting passage's place: its transcript, chat or summary. */
  scope: v.optional(v.picklist(["transcript", "chat", "summary"])),
  /** A meeting transcript hit's cue, which `meetings passage` opens with the lines around it. */
  cue_ref: v.optional(reference),
  /** A meeting passage's stored line, so two passages of one meeting stay apart; `search meetings` gives the same. */
  id: v.optional(v.pipe(v.string(), v.minLength(1))),
  /** A message's files; absent when it has none. */
  attachments: v.optional(v.array(hitFile)),
  /** Absent on a note hit: the owner wrote it. */
  untrusted,
})
