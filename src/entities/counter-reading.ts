import * as v from "valibot"
import { text, time } from "./fields.js"

export const milliseconds = v.pipe(v.number(), v.minValue(0))

/** A message's counter as last observed: views, reactions or comments; `value` null when never seen. */
export const counterReading = v.strictObject({
  counter: v.picklist(["views", "reactions", "comments"]),
  value: v.nullable(v.number()),
  observed_at: v.nullable(time),
  source: v.nullable(text),
  age_ms: v.nullable(milliseconds),
  freshness: v.picklist(["fresh", "stale", "unknown"]),
})

/** A resolved selection from a report row: passed back unchanged through `--selection`. */
export const selection = v.record(v.string(), v.unknown())
