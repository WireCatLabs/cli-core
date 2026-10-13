import * as v from "valibot"
import { count, id, reference, text, time } from "./fields.js"

export const meeting = v.strictObject({
  ref: reference,
  id,
  provider: text,
  account: text,
  title: v.nullable(text),
  description: v.optional(v.nullable(text)),
  location: v.optional(v.nullable(text)),
  /** The link that joins it. */
  url: v.nullable(text),
  started_at: v.nullable(time),
  ended_at: v.nullable(time),
  duration_ms: v.nullable(count),
  timezone: v.optional(v.nullable(text)),
  participants_count: v.nullable(count),
  created_at: time,
  updated_at: time,
})
