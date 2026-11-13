import * as v from "valibot"
import { DOCUMENT_KINDS } from "../store/sqlite/document-listing.js"
import { MEETING_ROW_KINDS } from "../store/sqlite/meeting-listing.js"
import { count, id, reference, text, time, untrusted } from "./fields.js"

/** The account a document or a meeting came from, as `provider:account` names it and as a person reads it. */
const source = v.strictObject({
  provider: text,
  account: text,
  /** `provider:account`: what a list's `source:` term takes. */
  source: text,
  label: text,
})

const person = v.strictObject({ ref: reference, name: v.nullable(text), kind: text })

/** One document of any account: a Drive file, a notes folder's file, an added source, an import's document. */
export const documentEntry = v.strictObject({
  ref: reference,
  id,
  title: v.nullable(text),
  file_name: v.nullable(text),
  kind: v.picklist(DOCUMENT_KINDS),
  mime: v.nullable(text),
  size: v.nullable(count),
  source,
  /** The folder it is in, inside its account; `null` at the top or where the source keeps no folders. */
  folder: v.nullable(text),
  path: v.nullable(text),
  /** Where it opens: its page at the source. */
  url: v.nullable(text),
  /** Where it opens on this computer: a notes folder's file or the copy kept of an added file. */
  local_path: v.nullable(text),
  /** When its source last changed it. */
  source_modified_at: v.nullable(time),
  /** When the store last wrote its copy. */
  stored_at: time,
  has_text: v.boolean(),
  untrusted,
})

const linked = v.strictObject({ ref: reference, title: v.nullable(text), at: v.nullable(time), role: v.nullable(text) })

/** One document with a part of its text, its tags, the people it names and the meetings it belongs to. */
export const documentEntryDetails = v.strictObject({
  ...documentEntry.entries,
  text: v.nullable(text),
  /** Where `text` starts in the whole text, in characters. */
  text_offset: count,
  /** The whole text's length, in characters. */
  text_length: count,
  /** More text follows `text`: read it with a larger offset. */
  has_more: v.boolean(),
  extraction: v.nullable(text),
  extraction_error: v.nullable(text),
  language: v.nullable(text),
  tags: v.array(text),
  people: v.array(person),
  meetings: v.array(linked),
  events: v.array(linked),
})

/** One account holding documents, with its folders and how many documents each holds. */
export const documentSource = v.strictObject({
  ...source.entries,
  name: v.nullable(text),
  count,
  /** Documents at the top of the account, in no folder. */
  loose: count,
  /** Every folder down to the depth asked, parents before children; `count` takes in the folders under it. */
  folders: v.array(v.strictObject({ path: text, name: text, depth: count, count })),
})

/** The person the store links a name or address to, as `meetings participants` gives it. */
const personLink = v.strictObject({ ref: reference, name: v.nullable(text) })

const participant = v.strictObject({
  name: v.nullable(text),
  email: v.nullable(text),
  person: v.nullable(personLink),
  organizer: v.boolean(),
})

/** One real meeting, call or calendar event: a calendar's event and its Zoom or Meet record are one row. */
export const meetingEntry = v.strictObject({
  /** `event:<id>` when a calendar or a meeting service's record made an event of it, else `meeting:<account>/<id>`. */
  ref: reference,
  kind: v.picklist(MEETING_ROW_KINDS),
  title: v.nullable(text),
  started_at: v.nullable(time),
  ended_at: v.nullable(time),
  duration_ms: v.nullable(count),
  all_day: v.boolean(),
  /** The zone its calendar or meeting service gave it, which may differ from the computer's. */
  timezone: v.nullable(text),
  status: v.nullable(text),
  /** The link that joins it: a calendar copy's, else its first meeting's. */
  url: v.nullable(text),
  /** Every distinct join link, with the source that gave it, so each opens in its own app. */
  links: v.array(v.strictObject({ source: text, url: text })),
  sources: v.array(
    v.strictObject({
      ...source.entries,
      via: v.picklist(["calendar", "meeting"]),
      calendar: v.nullable(text),
      ref: reference,
    }),
  ),
  /** The meeting records on this row, `meeting:<account>/<id>`. */
  meetings: v.array(reference),
  participants: v.array(participant),
  participants_count: count,
  has_recording: v.boolean(),
  has_transcript: v.boolean(),
  has_summary: v.boolean(),
  documents: v.array(v.strictObject({ ref: reference, title: v.nullable(text), role: v.nullable(text) })),
  /** Findings waiting for the owner (`meetings actions`) that cite one of its meetings. */
  pending_findings: count,
  untrusted,
})

/** One meeting row with its transcript lines, summaries, findings batches and the calendar's text. */
export const meetingEntryDetails = v.strictObject({
  ...meetingEntry.entries,
  description: v.nullable(text),
  location: v.nullable(text),
  summaries: v.array(
    v.strictObject({
      meeting: reference,
      source: text,
      title: v.nullable(text),
      overview: v.nullable(text),
      sections: v.array(v.strictObject({ label: text, text })),
      next_steps: v.array(text),
      url: v.nullable(text),
    }),
  ),
  transcript: v.nullable(
    v.strictObject({
      meeting: reference,
      source: text,
      language: v.nullable(text),
      /** Lines from this position, as `--offset` asked. */
      offset: count,
      total: count,
      has_more: v.boolean(),
      lines: v.array(
        v.strictObject({
          position: count,
          offset_ms: count,
          end_ms: count,
          speaker: v.nullable(text),
          person: v.nullable(personLink),
          text,
        }),
      ),
    }),
  ),
  /** `findings` cite the row's meetings; `pending` of them wait for the owner's decision. */
  findings: v.array(
    v.strictObject({ id, status: v.picklist(["proposed", "reviewed"]), findings: count, pending: count }),
  ),
})

/**
 * The listings' answers by entity name. Not in `ENTITIES`: that registry's inferred type is at the compiler's size
 * limit, so a CLI registers these as its own (memo's `entityFields`).
 */
export const LISTING_ENTITIES = {
  document_entry: documentEntry,
  document_entry_details: documentEntryDetails,
  document_source: documentSource,
  meeting_entry: meetingEntry,
  meeting_entry_details: meetingEntryDetails,
} as const
