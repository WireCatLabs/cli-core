import * as v from "valibot"
import { count, id, text, time, untrusted } from "./fields.js"

/** A topic of a forum group; its messages carry this id as their thread. */
export const topic = v.strictObject({
  id,
  title: text,
  closed: v.boolean(),
  pinned: v.boolean(),
  /** The General topic only, where the messenger says. */
  hidden: v.optional(v.boolean()),
  unread_count: v.nullable(count),
  last_message_at: v.nullable(time),
  created_at: v.nullable(time),
  untrusted,
})
