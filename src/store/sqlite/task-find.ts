import type { TaskState } from "../../tasks/index.js"
import type { Where } from "./query-filter.js"
import type { TaskType } from "./work-tasks.js"

/** What `tasks.find` narrows by. */
export interface TaskFind {
  project?: string
  type?: TaskType
  status?: TaskState
  /** `person:<id>`, in any role. */
  assignee?: string
  /** A compiled list query over `tasks t`. */
  where?: Where
  limit?: number
  offset?: number
}
