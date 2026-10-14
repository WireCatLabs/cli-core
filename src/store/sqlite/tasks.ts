import { createHash } from "node:crypto"
import { CliError } from "@wirecat/cli-base"
import {
  matches,
  TASK_KINDS,
  TASK_ORIGINS,
  TASK_STATES,
  TASK_VERDICTS,
  type Task,
  type TaskFilter,
  type TaskStore,
} from "../../tasks/index.js"
import type { CacheDatabase, SqlValue } from "../driver.js"
import { actorOfOrigin, originOfActor } from "./actors.js"
import { folded } from "./folded.js"
import { linkKind } from "./link-kinds.js"
import type { StoreContext } from "./open.js"
import type { Where } from "./query-filter.js"
import { taskRowOf, thingOf } from "./things.js"
import { write } from "./transaction.js"
import { recordTaskEvent, type WorkTasks, workTasksOver } from "./work-tasks.js"

export { taskIdOf, taskRowOf } from "./things.js"

/** `TaskStore` for `src/tasks/`, plus a way from its task ids to the store's rows. */
export interface StoreTaskStore extends TaskStore, WorkTasks {
  /** What the task package calls a task — its id, or a key like `IN1A2B3C4D-3` — as the row's `tasks.id`. */
  rowOf(id: string): number | undefined
  /** One account's tasks a list query keeps, oldest first, each with its title and last change. */
  query(
    account: string,
    where: Where | undefined,
    window: { limit: number; offset: number },
  ): Promise<{ task: Task; title: string; updatedAt: Date }[]>
}

const COLUMNS =
  "t.id AS row_id, t.package_id, t.source_locator, t.source_kind, t.source_group, t.type, t.status, t.close_reason, t.source, t.created_at, t.due_at, t.closed_at, " +
  "t.closed_by_type, t.closed_by_id, p.name AS account"

/** One inbox project per task account (`telegram:100`): derived from the account text alone, no `-` in it. */
export const inboxKey = (account: string): string =>
  `IN${createHash("sha256").update(account).digest("hex").slice(0, 8).toUpperCase()}`

/** An inbox made before its messenger saved the account learns it here, not only on its next task. */
export const linkInbox = (database: CacheDatabase, account: string, accountId: number): void => {
  database
    .prepare("UPDATE projects SET account_id = ? WHERE key = ? AND account_id IS NULL")
    .run(accountId, inboxKey(account))
}

/** The task account (`provider:account`) a task row belongs to: its inbox project's name. */
export const taskAccountOf = (database: CacheDatabase, rowId: number): string | undefined => {
  const row = database
    .prepare("SELECT p.key, p.name FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = ?")
    .get(rowId)
  // Only an inbox project speaks for an account: a project the owner named `telegram:500` does not.
  return row && String(row.key) === inboxKey(String(row.name)) ? String(row.name) : undefined
}

export const taskStoreOver = (context: StoreContext): StoreTaskStore => {
  const { database, now } = context
  const inbox = (account: string, create: boolean): number | undefined => {
    const key = inboxKey(account)
    const found = database.prepare("SELECT id FROM projects WHERE key = ?").get(key)
    if (!create) return found ? Number(found.id) : undefined
    const [provider, external] = [account.slice(0, account.indexOf(":")), account.slice(account.indexOf(":") + 1)]
    const owning = database
      .prepare("SELECT id FROM accounts WHERE provider = ? AND external_id = ?")
      .get(provider, external)
    const accountId = owning ? Number(owning.id) : null
    // A task can arrive before its messenger saved the account; the project learns it on a later task.
    if (found) {
      if (accountId !== null)
        database
          .prepare("UPDATE projects SET account_id = ? WHERE id = ? AND account_id IS NULL")
          .run(accountId, Number(found.id))
      return Number(found.id)
    }
    const at = now()
    return Number(
      database
        .prepare(
          "INSERT INTO projects (key, name, description, type, account_id, scope, tasks_count, status, created_at, updated_at) " +
            "VALUES (?, ?, ?, 'personal', ?, 'personal', 0, 'active', ?, ?) RETURNING id",
        )
        .get(key, account, `What waits on the owner in ${account}`, accountId, at, at)?.id,
    )
  }
  // A task made here has no package id and may be a type the package does not know; the package never sees it.
  const select = (where: string) =>
    database.prepare(
      `SELECT ${COLUMNS} FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.package_id IS NOT NULL AND ${where}`,
    )
  const toTask = (row: Record<string, unknown>): Task => {
    const task: Task = {
      id: String(row.package_id),
      source: String(row.source_locator),
      sourceKind: String(row.source_kind),
      account: String(row.account),
      group: String(row.source_group),
      kind: oneOf(TASK_KINDS, row.type, "kind"),
      state: oneOf(TASK_STATES, row.status, "state"),
      origin: oneOf(TASK_ORIGINS, row.source, "origin"),
      createdAt: new Date(Number(row.created_at)),
    }
    if (row.close_reason !== null) task.reason = String(row.close_reason)
    if (row.due_at !== null) task.dueAt = new Date(Number(row.due_at))
    if (row.closed_at !== null) task.closedAt = new Date(Number(row.closed_at))
    const closedBy = originOfActor(database, row.closed_by_type, row.closed_by_id)
    if (closedBy) task.closedBy = closedBy
    return task
  }
  const required = (id: string) => {
    const row = taskRowOf(database, id)
    if (row === undefined) throw new CliError("not_found", `no task ${id}`)
    return row
  }

  return {
    ...workTasksOver(context),
    rowOf: (id) => taskRowOf(database, id),
    query: async (account, where, { limit, offset }) => {
      const project = inbox(account, false)
      if (project === undefined) return []
      return database
        .prepare(
          `SELECT ${COLUMNS}, t.title, t.updated_at FROM tasks t JOIN projects p ON p.id = t.project_id ` +
            `WHERE t.package_id IS NOT NULL AND t.deleted_at IS NULL AND t.project_id = ? AND ${where?.sql ?? "1"} ` +
            "ORDER BY t.created_at, t.id LIMIT ? OFFSET ?",
        )
        .all(project, ...(where?.params ?? []), limit, offset)
        .map((row) => ({ task: toTask(row), title: String(row.title), updatedAt: new Date(Number(row.updated_at)) }))
    },
    get: async (id) => {
      const row = taskRowOf(database, id)
      if (row === undefined) return undefined
      const found = select("t.id = ?").get(row)
      return found && toTask(found)
    },
    findBySource: async (account, source) => {
      const project = inbox(account, false)
      if (project === undefined) return []
      return select("t.project_id = ? AND t.source_locator = ? ORDER BY t.created_at, t.id")
        .all(project, source)
        .map(toTask)
    },
    insert: async (task) => {
      write(database, () => {
        const project = inbox(task.account, true) as number
        const counted = database
          .prepare(
            "UPDATE projects SET tasks_count = tasks_count + 1, updated_at = ? WHERE id = ? RETURNING key, tasks_count",
          )
          .get(now(), project)
        const number = Number(counted?.tasks_count)
        const author = actorOfOrigin(database, task.origin)
        const closedBy = task.closedBy ? actorOfOrigin(database, task.closedBy) : undefined
        const made = database
          .prepare(
            "INSERT INTO tasks (project_id, number, key, title, type, status, due_at, closed_at, closed_by_type, closed_by_id, " +
              "close_reason, author_type, author_id, source, package_id, source_locator, source_kind, source_group, created_at, updated_at, " +
              "title_folded, close_reason_folded) " +
              "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
          )
          .get(
            project,
            number,
            `${String(counted?.key)}-${number}`,
            `${task.kind} — ${task.source}`,
            task.kind,
            task.state,
            time(task.dueAt),
            time(task.closedAt),
            closedBy?.type ?? null,
            closedBy?.id ?? null,
            task.reason ?? null,
            author.type,
            author.id,
            task.origin,
            task.id,
            task.source,
            task.sourceKind,
            task.group,
            task.createdAt.getTime(),
            now(),
            folded(`${task.kind} — ${task.source}`),
            folded(task.reason),
          )
        recordTaskEvent(database, Number(made?.id), author, "created", null, task.createdAt.getTime())
      })
    },
    update: async (task) => {
      const row = taskRowOf(database, task.id)
      if (row === undefined) throw new CliError("not_found", `no task ${task.id}`)
      const closedBy = task.closedBy ? actorOfOrigin(database, task.closedBy) : undefined
      write(database, () => {
        const before = database.prepare("SELECT status, due_at FROM tasks WHERE id = ?").get(row) as Record<
          string,
          unknown
        >
        const at = now()
        database
          .prepare(
            "UPDATE tasks SET status = ?, close_reason = ?, close_reason_folded = ?, due_at = ?, closed_at = ?, " +
              "closed_by_type = ?, closed_by_id = ?, updated_at = ? WHERE id = ?",
          )
          .run(
            task.state,
            task.reason ?? null,
            folded(task.reason),
            time(task.dueAt),
            time(task.closedAt),
            closedBy?.type ?? null,
            closedBy?.id ?? null,
            at,
            row,
          )
        if (before.status !== task.state)
          recordTaskEvent(database, row, closedBy ?? null, "status", { status: [before.status, task.state] }, at)
        if ((before.due_at ?? null) !== time(task.dueAt))
          recordTaskEvent(database, row, null, "due", { due_at: [before.due_at ?? null, time(task.dueAt)] }, at)
      })
    },
    list: async (filter) => listTasks(filter, select, toTask, inbox),
    answer: async (id, { resolution, by }) => {
      const text = resolution.trim()
      if (!text || text.length > 2000) throw new CliError("validation_error", "an answer takes 1–2000 characters")
      const row = required(id)
      const at = now()
      write(database, () => {
        database.prepare("UPDATE tasks SET resolution = ?, updated_at = ? WHERE id = ?").run(text, at, row)
        if (!by) return
        database
          .prepare(`DELETE FROM links WHERE from_type = 'task' AND from_id = ? AND kind = ${linkKind("answered-by")}`)
          .run(row)
        // A message the store has not saved yet keeps its locator as the written target.
        const thing = thingOf(database, by)
        database
          .prepare(
            "INSERT INTO links (from_type, from_id, to_type, to_id, kind, source, target_text, confirmed, created_at, author, updated_at) " +
              `VALUES ('task', ?, ?, ?, ${linkKind("answered-by")}, 'owner', ?, 1, ?, 'rule', ?)`,
          )
          .run(row, thing?.type ?? null, thing?.id ?? null, thing ? null : by.slice(0, 500), at, at)
      })
    },
    judge: async (id, verdict) => {
      if (verdict !== null && !TASK_VERDICTS.includes(verdict))
        throw new CliError("validation_error", `a verdict is one of ${TASK_VERDICTS.join(", ")}`)
      database.prepare("UPDATE tasks SET verdict = ?, updated_at = ? WHERE id = ?").run(verdict, now(), required(id))
    },
  }
}

const listTasks = (
  filter: TaskFilter,
  select: (where: string) => ReturnType<CacheDatabase["prepare"]>,
  toTask: (row: Record<string, unknown>) => Task,
  inbox: (account: string, create: boolean) => number | undefined,
): Task[] => {
  const where: string[] = ["t.deleted_at IS NULL"]
  const values: SqlValue[] = []
  if (filter.account !== undefined) {
    const project = inbox(filter.account, false)
    if (project === undefined) return []
    where.push("t.project_id = ?")
    values.push(project)
  }
  if (filter.state !== undefined) {
    where.push("t.status = ?")
    values.push(filter.state)
  }
  if (filter.kind !== undefined) {
    where.push("t.type = ?")
    values.push(filter.kind)
  }
  if (filter.group !== undefined) {
    where.push("t.source_group = ?")
    values.push(filter.group)
  }
  if (filter.createdBefore) {
    where.push("t.created_at < ?")
    values.push(filter.createdBefore.getTime())
  }
  // matches() again: the SQL narrows, the package's own filter stays the definition.
  return select(`${where.join(" AND ")} ORDER BY t.created_at, t.id`)
    .all(...values)
    .map(toTask)
    .filter((task) => matches(task, filter))
}

const time = (date: Date | undefined): number | null => (date ? date.getTime() : null)

const oneOf = <T extends string>(values: readonly T[], value: unknown, column: string): T => {
  if (typeof value === "string" && (values as readonly string[]).includes(value)) return value as T
  throw new CliError("configuration_error", `the store holds a task with an unknown ${column} "${String(value)}"`)
}
