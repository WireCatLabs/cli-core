import { TASK_KINDS } from "../tasks/index.js"

export { FACT_TYPES } from "../meetings/index.js"
export const FACT_STATUSES = ["proposed", "accepted", "superseded", "reversed", "rejected"] as const

export const MEMORY_KINDS = ["summary", "digest", "preference"] as const
export const MEMORY_STATUSES = ["proposed", "confirmed", "stale", "superseded"] as const
export const MEMORY_SCOPES = ["personal", "work"] as const

/** What the store writes itself; the task package finds only `TASK_KINDS`, in messages. */
export const WORK_TASK_TYPES = ["bug", "feature", "chore"] as const
export const TASK_TYPES = [...WORK_TASK_TYPES, ...TASK_KINDS] as const
