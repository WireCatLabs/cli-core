import * as v from "valibot"
import { count, reference, text, time } from "./fields.js"

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
  /** The writer's `person:` reference, where the store has one. */
  sender_ref: v.optional(v.nullable(reference)),
  found_by: v.optional(v.array(v.picklist(["title", "words", "meaning"]))),
  /** How far into the meeting the passage is. */
  offset_ms: v.optional(v.nullable(count)),
  /** A meeting passage's place: its transcript, chat or summary. */
  scope: v.optional(v.picklist(["transcript", "chat", "summary"])),
  /** A meeting passage's stored line, so two passages of one meeting stay apart; `search meetings` gives the same. */
  id: v.optional(v.pipe(v.string(), v.minLength(1))),
  /** An event hit's fields that whoever sent the invitation wrote: an agent reads them as data. */
  untrusted: v.optional(v.array(text)),
})
