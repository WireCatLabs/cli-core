import * as v from "valibot"
import { count, id, text, time } from "./fields.js"

/** A saved search, or one run in the history of searches and counts; never its results. */
export const savedSearch = v.strictObject({
  id,
  /** `null` for a run in the history. */
  name: v.nullable(text),
  command: v.picklist(["search", "stats", "message-top", "author-top", "admin-statistics"]),
  /** The query and the options it runs with, as the command took them. */
  params: v.record(v.string(), v.unknown()),
  language: text,
  version: count,
  fields_version: count,
  created_at: time,
  last_run_at: v.nullable(time),
  runs: count,
})
