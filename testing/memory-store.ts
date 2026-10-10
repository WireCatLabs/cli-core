import { TASK_VERDICTS, type Task } from "../model.js"
import { matches, type TaskStore } from "../store.js"

/** Copies on the way in and out, so a caller mutating a task it holds cannot change the store. */
export function memoryTaskStore(initial: Task[] = []): TaskStore {
  const tasks = new Map(initial.map((task) => [task.id, { ...task }]))
  return {
    get: async (id) => copy(tasks.get(id)),
    findBySource: async (account, source) =>
      [...tasks.values()]
        .filter((task) => task.account === account && task.source === source)
        .map((task) => ({ ...task })),
    insert: async (task) => {
      if (tasks.has(task.id)) throw new Error(`task ${task.id} already exists`)
      tasks.set(task.id, { ...task })
    },
    update: async (task) => {
      if (!tasks.has(task.id)) throw new Error(`no task ${task.id}`)
      tasks.set(task.id, { ...task })
    },
    list: async (filter) => [...tasks.values()].filter((task) => matches(task, filter)).map((task) => ({ ...task })),
    answer: async (id) => {
      if (!tasks.has(id)) throw new Error(`no task ${id}`)
    },
    judge: async (id, verdict) => {
      if (!tasks.has(id)) throw new Error(`no task ${id}`)
      if (verdict !== null && !TASK_VERDICTS.includes(verdict)) throw new Error(`no verdict ${verdict}`)
    },
  }
}

function copy(task: Task | undefined): Task | undefined {
  return task && { ...task }
}
