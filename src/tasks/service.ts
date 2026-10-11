import { type ClosedState, closeTask, type Task, TaskError, type TaskKind, type TaskOrigin } from "./model.js"
import type { TaskFilter, TaskStore } from "./store.js"

export interface NewTask {
  source: string
  sourceKind: string
  account: string
  group: string
  kind: TaskKind
  origin: TaskOrigin
  dueAt?: Date
}

export interface CloseOptions {
  as: ClosedState
  by: TaskOrigin
  reason?: string
}

export interface GroupStats {
  group: string
  open: number
  oldestOpenAt?: Date
  medianCloseMs?: number
}

export interface TaskServiceOptions {
  store: TaskStore
  now?: () => Date
  newId?: () => string
}

export function createTaskService({
  store,
  now = () => new Date(),
  newId = () => crypto.randomUUID(),
}: TaskServiceOptions) {
  async function find(id: string): Promise<Task> {
    const task = await store.get(id)
    if (!task) throw new TaskError("not_found", `no task ${id}`)
    return task
  }

  return {
    /**
     * A rule never makes a second task from a source it has seen, whatever that task's state, so a
     * dismissed one stays dismissed. A person or an agent may add a task of another kind to it.
     */
    async add(input: NewTask): Promise<{ task: Task; created: boolean }> {
      const existing = await store.findBySource(input.account, input.source)
      const same = input.origin === "rule" ? existing[0] : existing.find((task) => task.kind === input.kind)
      if (same) return { task: same, created: false }
      const task: Task = { ...input, id: newId(), state: "open", createdAt: now() }
      await store.insert(task)
      return { task, created: true }
    },

    async close(id: string, { as, by, reason }: CloseOptions): Promise<Task> {
      const task = closeTask(await find(id), as, by, now(), reason)
      await store.update(task)
      return task
    },

    list: (filter: TaskFilter = {}): Promise<Task[]> => store.list(filter),

    async stats(filter: Pick<TaskFilter, "account" | "kind"> = {}): Promise<GroupStats[]> {
      const byGroup = new Map<string, Task[]>()
      for (const task of await store.list(filter)) byGroup.set(task.group, [...(byGroup.get(task.group) ?? []), task])
      return [...byGroup].map(([group, tasks]) => {
        const open = tasks.filter((task) => task.state === "open")
        const closeMs = tasks.flatMap((task) =>
          task.closedAt ? [task.closedAt.getTime() - task.createdAt.getTime()] : [],
        )
        const oldestOpenAt = open.map((task) => task.createdAt).sort((a, b) => a.getTime() - b.getTime())[0]
        return {
          group,
          open: open.length,
          ...(oldestOpenAt ? { oldestOpenAt } : {}),
          ...(closeMs.length > 0 ? { medianCloseMs: median(closeMs) } : {}),
        }
      })
    },
  }
}

export type TaskService = ReturnType<typeof createTaskService>

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  const upper = sorted[middle] ?? 0
  return sorted.length % 2 === 1 ? upper : ((sorted[middle - 1] ?? 0) + upper) / 2
}
