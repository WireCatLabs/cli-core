export const TASK_KINDS = ["question", "request", "mention", "promise"] as const
export const TASK_STATES = ["open", "done", "dismissed"] as const
export const TASK_ORIGINS = ["rule", "agent", "owner"] as const

export type TaskKind = (typeof TASK_KINDS)[number]
export type TaskState = (typeof TASK_STATES)[number]
export type TaskOrigin = (typeof TASK_ORIGINS)[number]
export type ClosedState = Exclude<TaskState, "open">

/**
 * A task points at what it is about and never holds its text: `source` is a locator the host
 * resolves (`msg:…` for a message), so a deleted message leaves nothing behind here.
 */
export interface Task {
  id: string
  source: string
  sourceKind: string
  account: string
  group: string
  kind: TaskKind
  state: TaskState
  reason?: string
  origin: TaskOrigin
  createdAt: Date
  dueAt?: Date
  closedAt?: Date
  closedBy?: TaskOrigin
}

export class TaskError extends Error {
  constructor(
    readonly code: "not_found" | "closed",
    message: string,
  ) {
    super(message)
    this.name = "TaskError"
  }
}

export function closeTask(task: Task, state: ClosedState, by: TaskOrigin, at: Date, reason?: string): Task {
  if (task.state !== "open") throw new TaskError("closed", `task ${task.id} is already ${task.state}`)
  return { ...task, state, closedAt: at, closedBy: by, ...(reason === undefined ? {} : { reason }) }
}
