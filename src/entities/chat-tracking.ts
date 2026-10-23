import * as v from "valibot"
import { count, id, text, time } from "./fields.js"

const memberCount = v.strictObject({
  day: v.pipe(text, v.isoDate()),
  participants: v.nullable(count),
  listed: count,
  complete: v.boolean(),
})

export const trackedChat = v.strictObject({
  chat_id: id,
  title: v.nullable(text),
  tracked_at: time,
  last_count: v.nullable(memberCount),
})

export const trackedChatHistory = v.strictObject({
  chat_id: id,
  tracked_at: v.nullable(time),
  counts: v.array(memberCount),
})

export const chatTracking = v.strictObject({
  chat_id: id,
  tracked: v.boolean(),
})
