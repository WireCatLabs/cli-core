import * as v from "valibot"
import { count, text, time } from "./fields.js"

const milliseconds = v.nullable(v.pipe(v.number(), v.minValue(0)))
const figures = { replies: count, median_ms: milliseconds, p90_ms: milliseconds, mean_ms: milliseconds }

/** How long replies took in one-to-one chats: the owner's (`me`) or the other side's (`others`). */
export const responseTimes = v.strictObject({
  who: v.picklist(["me", "others"]),
  ...figures,
  buckets: v.strictObject({ under_5m: count, under_1h: count, under_1d: count, over_1d: count }),
  /** One row per calendar day of the reply; empty with `--by total`. */
  rows: v.array(v.strictObject({ key: text, ...figures })),
})

/** Chats whose newest message asks the owner something, and how much waits there. */
export const waitingChats = v.strictObject({
  chats: count,
  messages: count,
  oldest_at: v.nullable(time),
  by_kind: v.strictObject({ private: count, group: count }),
})
