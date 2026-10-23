import * as v from "valibot"
import { reference, text, time } from "./fields.js"

const side = v.strictObject({ ref: reference, key: text, title: text, status: text })

export const taskPair = v.strictObject({
  task: v.nullable(side),
  source: v.nullable(reference),
  other: side,
  score: v.number(),
  band: v.picklist(["likely", "maybe", "different"]),
  levels: v.strictObject({
    text: v.picklist(["high", "middle", "low"]),
    person: v.picklist(["same", "different", "unknown"]),
    amount: v.picklist(["equal", "different", "missing"]),
    category: v.picklist(["same", "different", "unknown"]),
    due: v.picklist(["near", "far", "missing"]),
    reply: v.picklist(["yes", "no"]),
    time: v.picklist(["near", "weeks", "far"]),
  }),
  reasons: v.array(text),
  decision: v.picklist(["review", "unsure", "merged", "rejected", "unmerged", "attached", "new"]),
  decided_at: v.nullable(time),
  created_at: time,
})
