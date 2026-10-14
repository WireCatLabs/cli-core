import * as v from "valibot"
import { counterReading, milliseconds, selection } from "./counter-reading.js"
import { count, id, reference, text, time } from "./fields.js"

/** A question, an answerer, a newcomer's stay or a post; a report fills only the fields it computes. */
export const adminRow = v.strictObject({
  ref: reference,
  /** What `stats * evidence` takes: a person id, a stay or a message locator. */
  id,
  status: v.picklist(["observed", "no-observed-answer", "partial", "unknown"]),
  chat_ref: v.optional(reference),
  person_ref: v.optional(reference),
  identity_known: v.optional(v.boolean()),
  questions: v.optional(count),
  answered: v.optional(count),
  median_ms: v.optional(v.nullable(milliseconds)),
  p90_ms: v.optional(v.nullable(milliseconds)),
  age_ms: v.optional(milliseconds),
  joined_at: v.optional(time),
  window_end: v.optional(time),
  pending: v.optional(v.boolean()),
  views: v.optional(count),
  observed_replies: v.optional(count),
  comment_snapshot: v.optional(v.nullable(count)),
  counters: v.optional(v.array(counterReading)),
  selection,
})

/** One administrator report over stored history: unanswered questions, responses, newcomers or discussion. */
export const adminReport = v.strictObject({
  report: v.picklist(["unanswered", "responses", "newcomers", "discussion"]),
  cutoff: time,
  /** Rows the report found; `rows` holds the first `--limit` of them. */
  total: count,
  summary: v.strictObject({
    questions: count,
    answered: count,
    no_observed_answer: count,
    excluded_future: count,
    unknown_join: count,
    missing_views: count,
  }),
  quality: v.strictObject({
    graph: v.strictObject({
      unknown_links: count,
      unknown_authors: count,
      missing_parents: count,
      cycles: count,
      complete: v.boolean(),
    }),
    archives: v.array(v.strictObject({ chat_ref: reference, state: text, fetched_at: v.nullable(time) })),
    archives_total: count,
    membership: text,
    counter_freshness: text,
    answerer_roles: text,
  }),
  rows: v.array(adminRow),
})
