import * as v from "valibot"
import { count, id, reference, time } from "./fields.js"
import { message } from "./message.js"
import { conversationLink } from "./message-read.js"

export const messageThread = v.strictObject({
  ref: reference,
  chat: id,
  message: id,
  mode: v.picklist(["thread", "time"]),
  fallback: v.optional(v.picklist(["not_built", "not_stored", "not_linked"])),
  items: v.array(message),
  links: v.array(v.strictObject({ ...conversationLink.entries, message_id: id })),
  chain: v.array(id),
  stale: v.boolean(),
  built_at: v.nullable(time),
  stopped: v.array(v.picklist(["hops", "messages", "bytes", "time", "links", "cycle", "aborted", "thread"])),
  bounds: v.strictObject({ max_hops: count, max_messages: count, max_bytes: count, within_ms: count }),
})

/** Time windows answer with message items; --thread answers with one bounded graph report. */
export const messageContext = v.union([message, messageThread])
