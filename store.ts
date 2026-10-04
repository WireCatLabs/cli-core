import type { Task, TaskKind, TaskState } from "./model.js"

export interface TaskFilter {
  account?: string
  state?: TaskState
  group?: string
  kind?: TaskKind
  createdBefore?: Date
}

/** What a host implements to keep tasks — in its own file, never inside a message store. */
export interface TaskStore {
  get(id: string): Promise<Task | undefined>
  findBySource(account: string, source: string): Promise<Task | undefined>
  insert(task: Task): Promise<void>
  update(task: Task): Promise<void>
  list(filter: TaskFilter): Promise<Task[]>
}

export function matches(task: Task, filter: TaskFilter): boolean {
  return (
    (filter.account === undefined || task.account === filter.account) &&
    (filter.state === undefined || task.state === filter.state) &&
    (filter.group === undefined || task.group === filter.group) &&
    (filter.kind === undefined || task.kind === filter.kind) &&
    (filter.createdBefore === undefined || task.createdAt < filter.createdBefore)
  )
}
