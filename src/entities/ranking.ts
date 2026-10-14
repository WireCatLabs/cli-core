import * as v from "valibot"
import { counterReading, selection } from "./counter-reading.js"
import { count, id, reference, text } from "./fields.js"

const figures = v.record(v.string(), v.number())
const freshness = v.picklist(["fresh", "stale", "partial", "unknown"])

export const rankingRow = v.strictObject({
  rank: count,
  /** The message's locator, or the author's `contact:` reference. */
  ref: reference,
  /** The message or person id, as `stats * evidence` takes it. */
  id,
  chat_ref: v.optional(reference),
  name: v.nullable(text),
  /** A message's kind (`posts`, `comments`); null for authors. */
  kind: v.nullable(text),
  value: v.number(),
  components: v.record(v.string(), v.nullable(v.number())),
  messages: count,
  known_reactions: count,
  unknown_reactions: count,
  score: v.nullable(v.strictObject({ score: v.number(), normalized: figures, contributions: figures })),
  quality: v.strictObject({
    reactions: v.picklist(["known", "partial", "unknown"]),
    graph: v.picklist(["complete", "partial", "not_used"]),
    counter_freshness: freshness,
  }),
  counters: v.optional(v.array(counterReading)),
  selection,
})

/** Stored messages or their human authors, ranked by a measure or a score; `rows` best first. */
export const ranking = v.strictObject({
  target: v.picklist(["messages", "contacts"]),
  measure: text,
  order: v.picklist(["ascending", "descending"]),
  preset: v.nullable(text),
  weights: v.nullable(figures),
  min_messages: count,
  message_kind: text,
  /** Messages the query selected. */
  total: count,
  population: count,
  eligible: count,
  excluded: v.strictObject({ minimum: count, missing: count, unknown_sender: count, unknown_kind: count }),
  maxima: figures,
  counter_freshness: freshness,
  expanded_discussion_chats: v.optional(v.array(text)),
  rows: v.array(rankingRow),
})
