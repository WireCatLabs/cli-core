import type { TaskStore } from "../../tasks/index.js"
import type { WorkTasks } from "../sqlite/work-tasks.js"

/** `TaskStore` for `src/tasks/`, plus a way from its task ids to the store's rows. */
export interface StoreTaskStore extends TaskStore, WorkTasks {
  /** What the task package calls a task — its id, or a key like `IN1A2B3C4D-3` — as the row's `tasks.id`. */
  rowOf(id: string): number | undefined
}
