import type { Task, TaskKind, TaskState, TaskVerdict } from "./model.js"

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
  findBySource(account: string, source: string): Promise<Task[]>
  insert(task: Task): Promise<void>
  update(task: Task): Promise<void>
  list(filter: TaskFilter): Promise<Task[]>
  /** A question's answer: its text, and the locator it came from when there is one. */
  answer(id: string, input: { resolution: string; by?: string }): Promise<void>
  /** The owner's judgement of a task a rule or an agent raised; `null` takes it back. */
  judge(id: string, verdict: TaskVerdict | null): Promise<void>
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
