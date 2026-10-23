import * as v from "valibot"
import { count, reference, text, time } from "./fields.js"

const kind = v.picklist(["phone", "email", "url", "document", "person-name", "place"])
const status = v.picklist(["found", "linked", "dismissed"])

/** Mention and place IDs retain the numeric identifiers returned by the local store. */
export const mention = v.strictObject({
  id: count,
  kind,
  value: text,
  domain: v.nullable(text),
  confidence: v.number(),
  status,
  field: text,
  author: v.nullable(text),
  target: v.nullable(reference),
  sent_at: time,
  found_at: time,
  written: text,
  locator: reference,
})
export const mentionDetails = v.strictObject({
  ...mention.entries,
  before: text,
  after: text,
  same_value: count,
  candidates: v.array(reference),
})
export const mentionDomain = v.strictObject({ domain: text, links: count, chats: count, first_at: time, last_at: time })
export const place = v.strictObject({ id: count, address: text, mentions: count })
export const mentionDecision = v.strictObject({
  kind,
  value: text,
  status,
  target: v.nullable(reference),
  mentions: count,
})
export const mentionRebuild = v.strictObject({
  messages: count,
  attachments: count,
  documents: count,
  notes: count,
  emails: count,
  mentions: count,
})
