import * as v from "valibot"
import { JOB_STATES } from "../services/backfill-jobs.js"
import { count, id, text, time } from "./fields.js"

const problem = v.strictObject({ code: text, message: text })

/** A background `messages sync`, started with `--background`. */
export const job = v.strictObject({
  id,
  /** The chat as the sync was given it. */
  chat: text,
  state: v.picklist(JOB_STATES),
  pid: count,
  started_at: time,
  finished_at: v.optional(time),
  /** Messages fetched so far, or in all once it finished. */
  fetched: count,
  /** The `--limit` the sync was started with: how many messages it may fetch. */
  message_limit: v.optional(count),
  page_size: v.optional(count),
  last: v.optional(count),
  /** Whether the sync reached its window; set once it finished. */
  complete: v.optional(v.boolean()),
  /** Why a partial job stopped short; `store jobs retry` resumes it. */
  issue: v.optional(problem),
  error: v.optional(problem),
})
