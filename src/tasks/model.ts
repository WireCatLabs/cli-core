import { CliError } from "@wirecat/cli-base"
export const TASK_KINDS = ["question", "request", "mention", "promise"] as const
/** `todo` and `in_progress` are steps of a project task's work; a task from a message is only ever open or closed. */
export const TASK_STATES = ["open", "todo", "in_progress", "done", "dismissed"] as const
export const CLOSED_STATES = ["done", "dismissed"] as const
export const TASK_ORIGINS = ["rule", "agent", "owner"] as const
export const TASK_VERDICTS = ["useful", "not_useful"] as const

export type TaskKind = (typeof TASK_KINDS)[number]
export type TaskState = (typeof TASK_STATES)[number]
export type TaskOrigin = (typeof TASK_ORIGINS)[number]
export type TaskVerdict = (typeof TASK_VERDICTS)[number]
export type ClosedState = (typeof CLOSED_STATES)[number]

export const isClosedState = (state: string): state is ClosedState =>
  (CLOSED_STATES as readonly string[]).includes(state)

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
  /** The readable key the host gave it (`Q-15`); the host sets it on insert, so a new task has none yet. */
  key?: string
  /** One name from the host's category list; a host without one leaves it unset. */
  category?: string
  /** Who works on it now, until `claimedUntil`; a lapsed claim holds nothing. */
  claimedBy?: string
  claimedUntil?: Date
}

export function closeTask(task: Task, state: ClosedState, by: TaskOrigin, at: Date, reason?: string): Task {
  if (isClosedState(task.state))
    throw new CliError("validation_error", `task ${task.id} is already ${task.state}`, { reason: "task.closed" })
  const { claimedBy: _by, claimedUntil: _until, ...unclaimed } = task
  return { ...unclaimed, state, closedAt: at, closedBy: by, ...(reason === undefined ? {} : { reason }) }
}
