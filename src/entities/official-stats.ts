import * as v from "valibot"
import { count, id, reference, text, time } from "./fields.js"

const versus = v.strictObject({ current: v.number(), previous: v.number() })
const person = { person_ref: reference, name: v.nullable(text) }
const graph = v.strictObject({
  kind: text,
  x: v.strictObject({ type: v.picklist(["date", "time", "number"]), values: v.array(v.union([text, v.number()])) }),
  series: v.array(v.strictObject({ key: text, name: text, kind: text, values: v.array(v.number()) })),
  stacked: v.optional(v.boolean()),
  percentage: v.optional(v.boolean()),
})

/** What the messenger itself computed for a group or channel the owner administers; it picks the period. */
export const officialStats = v.strictObject({
  chat_id: id,
  title: text,
  kind: v.picklist(["group", "channel"]),
  since: time,
  until: time,
  totals: v.record(v.string(), versus),
  top: v.optional(
    v.strictObject({
      posters: v.array(v.strictObject({ ...person, messages: count, average_chars: v.number() })),
      admins: v.array(v.strictObject({ ...person, deleted: count, removed: count, banned: count })),
      inviters: v.array(v.strictObject({ ...person, invited: count })),
    }),
  ),
  notifications: v.optional(v.strictObject({ enabled: count, total: count })),
  recent_posts: v.optional(
    v.array(
      v.strictObject({
        kind: v.picklist(["message", "story"]),
        id,
        views: count,
        forwards: count,
        reactions: count,
      }),
    ),
  ),
  /** A graph the messenger did not give is `{ error }`; the others still answer. */
  graphs: v.record(v.string(), v.union([graph, v.strictObject({ error: text })])),
})
