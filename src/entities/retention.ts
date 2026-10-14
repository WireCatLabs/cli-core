import * as v from "valibot"
import { milliseconds, selection } from "./counter-reading.js"
import { count, reference, text, time } from "./fields.js"

export const retentionCohort = v.strictObject({
  /** The first day of the joining day or week. */
  cohort: text,
  stays: count,
  checkpoints: v.array(
    v.strictObject({
      age_ms: milliseconds,
      eligible: count,
      observable: count,
      present: count,
      absent: count,
      unknown: count,
      pending: count,
      rate: v.nullable(v.number()),
    }),
  ),
  activity: v.strictObject({ observed: count, no_observed: count, pending: count, archive_covered: count }),
  early_departure: v.strictObject({ observed: count, not_observed: count, unknown: count, pending: count }),
  selection,
})

/** Who of those who joined a chat in a period is still there at each checkpoint, by joining cohort. */
export const retention = v.strictObject({
  chat_ref: reference,
  cutoff: time,
  since: time,
  until: time,
  checkpoints_ms: v.array(milliseconds),
  within_ms: milliseconds,
  by: v.picklist(["day", "week"]),
  timezone: text,
  /** Cohorts found; `rows` holds the first `--limit` of them. */
  total: count,
  unknown_join: count,
  eligible_stays: count,
  quality: v.strictObject({
    membership: text,
    tolerance_ms: milliseconds,
    archive: v.nullable(
      v.strictObject({
        state: text,
        up_to_date: v.nullable(v.boolean()),
        gaps: v.boolean(),
        reaches_start: v.boolean(),
        fetched_at: v.nullable(time),
      }),
    ),
    continuous_survival: v.boolean(),
    group_silent_rate: v.nullable(v.number()),
  }),
  rows: v.array(retentionCohort),
})
