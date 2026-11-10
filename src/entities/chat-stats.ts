import * as v from "valibot"
import { count, reference, text, time } from "./fields.js"

const optionalCount = v.optional(count)
const minutes = v.nullable(v.number())

/**
 * A chat's numbers for a period, counted from the stored messages; joins and leaves asked of the messenger, or read
 * from the store where it holds the messenger's history.
 */
export const chatStats = v.strictObject({
  chat: reference,
  since: time,
  until: time,
  /** The store holds the chat whole and the messenger read every join and leave; otherwise lower bounds. */
  complete: v.boolean(),
  completeness: v.strictObject({
    state: v.picklist(["complete", "partial", "unknown"]),
    up_to_date: v.nullable(v.boolean()),
    gaps: v.boolean(),
    reaches_start: v.boolean(),
    fetched_at: v.nullable(time),
  }),
  messages: count,
  senders: count,
  replies: count,
  threads: count,
  reactions: count,
  views: optionalCount,
  forwards: optionalCount,
  comments: optionalCount,
  top_posts: v.array(
    v.strictObject({
      ref: reference,
      timestamp: time,
      reactions: count,
      views: optionalCount,
      forwards: optionalCount,
      comments: optionalCount,
    }),
  ),
  questions: v.strictObject({
    asked: count,
    answered: count,
    median_minutes_to_answer: minutes,
    answered_by: v.picklist(["owner", "owner-and-admins"]),
  }),
  member_counts: v.optional(
    v.array(v.strictObject({ day: text, participants: v.nullable(count), listed: count, complete: v.boolean() })),
  ),
  /** Absent where joins and leaves were not asked, or not recorded for the chat yet (then `missing` says so). */
  members: v.optional(
    v.strictObject({
      joined: count,
      left: count,
      net: v.number(),
      wrote: count,
      median_minutes_to_first_message: minutes,
      /** The messenger stopped reading its history before `since`: the counts are lower bounds. */
      more: v.boolean(),
    }),
  ),
  series: v.optional(
    v.array(v.strictObject({ key: text, messages: count, senders: count, joined: optionalCount, left: optionalCount })),
  ),
})

const ms = v.nullable(v.pipe(v.number(), v.minValue(0)))

/**
 * Open and closed tasks, one row per chat, meeting or project. `open` is open now; `created` and `closed` count the
 * tasks opened and closed in the query's period, every task without one.
 */
export const taskStats = v.strictObject({
  /** Every account counted, `provider:account`, when the answer reads several (memo without `--source`). */
  accounts: v.optional(v.array(text)),
  /** Open tasks across every row. */
  open: count,
  created: count,
  closed: count,
  median_close_ms: ms,
  mean_open_age_ms: ms,
  rows: v.array(
    v.strictObject({
      /** Rows of `--by chat` only. */
      chat: v.optional(reference),
      /** The chat reference, `meeting:<account>/<meeting>` or `project:<id>`. */
      key: text,
      name: v.nullable(text),
      open: count,
      created: count,
      closed: count,
      oldest_open_at: v.nullable(time),
      median_close_ms: ms,
      mean_open_age_ms: ms,
    }),
  ),
})
