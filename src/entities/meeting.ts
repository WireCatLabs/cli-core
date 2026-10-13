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
  startedAt: v.nullable(time),
  endedAt: v.nullable(time),
  durationMs: v.nullable(count),
  timezone: v.optional(v.nullable(text)),
  participantsCount: v.nullable(count),
  createdAt: time,
  updatedAt: time,
})
