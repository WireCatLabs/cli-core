import { evaluate, type QueryAst, type QueryRegistry, queryFieldsOf } from "@wirecat/cli-base/query"
import { job } from "../entities/job.js"
import { jobItem, listJobs } from "./backfill-jobs.js"

/** The job folder is the list's own source: every file is read whole, so it answers each field. */
export const JOBS_QUERY = {
  entity: "job",
  backend: "native",
  fields: queryFieldsOf(job, {
    native: Object.keys(job.entries),
    examples: { state: "state:failed", started_at: "started_at>=7d", chat: "chat:7", fetched: "fetched>0" },
  }),
} as const satisfies QueryRegistry

/** One profile's jobs as `store jobs list` answers them, newest first; the query is checked as each file is read. */
export const jobItems = (dir: string, profile: string, query?: QueryAst) =>
  listJobs(dir)
    .filter((one) => one.profile === profile)
    .map(jobItem)
    .filter((item) => query === undefined || evaluate(query, JOBS_QUERY.fields, item))
