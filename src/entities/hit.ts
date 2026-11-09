import * as v from "valibot"
import { BUSINESS_KINDS } from "../domain/business.js"
import { hitFile } from "./attachment.js"
import { count, reference, text, time, untrusted } from "./fields.js"

/**
 * One result of `search all`: a message, a mail, a note, a calendar event, a meeting passage, a deal, a lead, or an
 * invoice, payment, order, contract, subscription, product or wallet.
 */
export const hit = v.strictObject({
  kind: v.picklist(["message", "mail", "note", "document", "event", "meeting", "deal", "lead", ...BUSINESS_KINDS]),
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
  /** A meeting hit's place: its title, transcript, chat or summary. */
  scope: v.optional(v.picklist(["title", "transcript", "chat", "summary"])),
  /** A meeting transcript hit's cue, which `meetings passage` opens with the lines around it. */
  cue_ref: v.optional(reference),
  /** A meeting transcript hit's transcript language (`ru`, `en`…), `null` when unknown. */
  language: v.optional(v.nullable(text)),
  /** A meeting transcript hit's line, from 1, of `lines_total` lines in its transcript. */
  line: v.optional(v.pipe(count, v.minValue(1))),
  lines_total: v.optional(count),
  /** `corrected`: a meeting hit found only through a spelling speech recognition may have garbled. */
  match: v.optional(v.picklist(["corrected"])),
  /** For a `corrected` hit, the stored words each such query word matched. */
  corrections: v.optional(v.array(v.strictObject({ from: text, to: v.array(text) }))),
  /** A meeting passage's stored line, so two passages of one meeting stay apart; `search meetings` gives the same. */
  id: v.optional(v.pipe(v.string(), v.minLength(1))),
  /** A business hit's: `proposed` waits for the owner; a product or a wallet has no review and is `confirmed`. */
  review: v.optional(v.picklist(["proposed", "confirmed"])),
  /** A business hit's record in the import that made it; absent for one the owner or an agent wrote. */
  source_record: v.optional(v.strictObject({ provider: text, account: text, external_id: text })),
  /** A message's files; absent when it has none. */
  attachments: v.optional(v.array(hitFile)),
  /** Absent on a note hit: the owner wrote it. */
  untrusted,
})
