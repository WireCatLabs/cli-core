import { CliError } from "@wirecat/cli-base"
import { TASK_KINDS, TASK_STATES, type TaskState, type TaskVerdict } from "../../tasks/index.js"
import type { CacheDatabase, SqlValue } from "../driver.js"
import type { Actor } from "./actors.js"
import { folded } from "./folded.js"
import { type Author, authorActor } from "./memories.js"
import { requiredThing } from "./notes.js"
import type { StoreContext } from "./open.js"
import { type TaskRelationsStore, taskRelationsStoreOver } from "./task-relations.js"
import { taskIdOf, taskRowOf } from "./things.js"
import { write } from "./transaction.js"

/** What the store writes itself; the task package finds only `TASK_KINDS`, in messages. */
export const WORK_TASK_TYPES = ["bug", "feature", "chore"] as const
export const TASK_TYPES = [...WORK_TASK_TYPES, ...TASK_KINDS] as const
export const TASK_ROLES = ["assignee", "reviewer", "watcher"] as const
export const TASK_EVENT_KINDS = [
  "created",
  "status",
  "assigned",
  "unassigned",
  "due",
  "priority",
  "moved",
  "linked",
  "unlinked",
] as const

export type WorkTaskType = (typeof WORK_TASK_TYPES)[number]
export type TaskType = (typeof TASK_TYPES)[number]
export type TaskRole = (typeof TASK_ROLES)[number]

export interface TaskFields {
  title?: string
  description?: string | null
  /** 0 urgent … 4 low. */
  priority?: number | null
  /** A task reference (`task:<id>`) or id in the same project; `null` makes it top-level. */
  parent?: string | null
  dueAt?: Date | null
  /** When an agent should look at the task again; unlike a reminder, it never reaches the owner. */
  nextCheckAt?: Date | null
  status?: TaskState
  reason?: string | null
}

export interface NewWorkTask extends Omit<TaskFields, "status" | "reason"> {
  /** `project:<id>` or the project's key. */
  project: string
  title: string
  type: WorkTaskType
}

export interface TaskAssignment {
  /** `person:<id>`. */
  to: string
  role: TaskRole
}

export interface TaskDetails {
  /** What `get`, `rowOf` and `task:` take: the task package's id, or the key for a task made here. */
  id: string
  ref: string
  key: string
  project: string
  title: string
  description: string | null
  type: TaskType
  status: TaskState
  priority: number | null
  parent: string | null
  /** What a task found in a message points at; null for a task made here. */
  source: string | null
  dueAt: string | null
  nextCheckAt: string | null
  closedAt: string | null
  reason: string | null
  verdict: TaskVerdict | null
  assignments: TaskAssignment[]
  createdAt: string
  updatedAt: string
}

export interface TaskEvent {
  kind: (typeof TASK_EVENT_KINDS)[number]
  actor: Actor | null
  changes: Record<string, [unknown, unknown]> | null
  at: string
}

/** Tasks beyond the package's four message kinds, and the fields the package does not know, on any task. */
export interface WorkTasks extends TaskRelationsStore {
  create(input: NewWorkTask, by: Author): Promise<TaskDetails>
  edit(id: string, fields: TaskFields, by: Author): Promise<TaskDetails>
  assign(id: string, assignment: TaskAssignment, by: Author): Promise<TaskDetails>
  unassign(id: string, assignment: TaskAssignment, by: Author): Promise<TaskDetails>
  details(id: string): Promise<TaskDetails>
  find(filter: {
    project?: string
    type?: TaskType
    status?: TaskState
    /** `person:<id>`, in any role. */
    assignee?: string
    limit?: number
  }): Promise<TaskDetails[]>
  events(id: string): Promise<TaskEvent[]>
}

type Row = Record<string, unknown>
const iso = (value: unknown) => (value == null ? null : new Date(Number(value)).toISOString())

export const recordTaskEvent = (
  database: CacheDatabase,
  task: number,
  actor: Actor | null,
  kind: TaskEvent["kind"],
  changes: TaskEvent["changes"],
  at: number,
): void => {
  database
    .prepare(
      "INSERT INTO task_events (task_id, actor_type, actor_id, kind, changes, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(task, actor?.type ?? null, actor?.id ?? null, kind, changes === null ? null : JSON.stringify(changes), at)
}

const textOf = (value: string, what: string, max: number): string => {
  const text = value.trim()
  if (!text || text.length > max) throw new CliError("validation_error", `${what} takes 1–${max} characters`)
  return text
}

const priorityOf = (value: number | null): number | null => {
  if (value !== null && !(Number.isInteger(value) && value >= 0 && value <= 4))
    throw new CliError("validation_error", "a priority is 0 (urgent) to 4 (low)")
  return value
}

export const workTasksOver = (context: StoreContext): WorkTasks => {
  const { database, now } = context
  const required = (id: string): number => {
    const bare = id.startsWith("task:") ? id.slice("task:".length) : id
    const row = taskRowOf(database, bare)
    if (row === undefined) throw new CliError("not_found", `no task ${id}`)
    return row
  }
  const projectOf = (reference: string): number => {
    if (reference.startsWith("project:")) {
      const thing = requiredThing(database, reference, "the project")
      if (thing.type !== "project") throw new CliError("validation_error", `${reference} is not a project`)
      return thing.id
    }
    const found = database
      .prepare("SELECT id FROM projects WHERE key = ? AND deleted_at IS NULL")
      .get(reference.trim().toUpperCase())
    if (!found) throw new CliError("not_found", `no project ${reference}`)
    return Number(found.id)
  }
  const personOf = (reference: string): number => {
    const thing = requiredThing(database, reference, "the person")
    if (thing.type !== "person") throw new CliError("validation_error", `${reference} is not a person`)
    return thing.id
  }
  const parentOf = (task: number | undefined, project: number, reference: string): number => {
    const parent = required(reference)
    const row = database.prepare("SELECT project_id FROM tasks WHERE id = ?").get(parent) as Row
    if (Number(row.project_id) !== project)
      throw new CliError("validation_error", "a subtask's parent is in the same project")
    for (let at: number | null = parent; at !== null; ) {
      if (at === task) throw new CliError("validation_error", "a task cannot be its own ancestor")
      const up = database.prepare("SELECT parent_id FROM tasks WHERE id = ?").get(at) as Row
      at = up.parent_id == null ? null : Number(up.parent_id)
    }
    return parent
  }
  const detailsOf = (row: Row): TaskDetails => {
    const id = Number(row.id)
    const reference = (taskRow: number) => `task:${taskIdOf(database, taskRow)}`
    return {
      id: String(row.package_id ?? row.key),
      ref: reference(id),
      key: String(row.key),
      project: `project:${row.project_id}`,
      title: String(row.title),
      description: row.description == null ? null : String(row.description),
      type: row.type as TaskType,
      status: row.status as TaskState,
      priority: row.priority == null ? null : Number(row.priority),
      parent: row.parent_id == null ? null : reference(Number(row.parent_id)),
      source: row.source_locator == null ? null : String(row.source_locator),
      dueAt: iso(row.due_at),
      nextCheckAt: iso(row.next_check_at),
      closedAt: iso(row.closed_at),
      reason: row.close_reason == null ? null : String(row.close_reason),
      verdict: row.verdict == null ? null : (row.verdict as TaskVerdict),
      assignments: database
        .prepare(
          "SELECT assignee_id, role FROM task_assignments WHERE task_id = ? AND assignee_type = 'person' ORDER BY id",
        )
        .all(id)
        .map((assigned) => ({ to: `person:${assigned.assignee_id}`, role: assigned.role as TaskRole })),
      createdAt: iso(row.created_at) as string,
      updatedAt: iso(row.updated_at) as string,
    }
  }
  const rowById = (id: number) => database.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Row
  const details = (id: number) => detailsOf(rowById(id))

  const edit = (task: number, fields: TaskFields, actor: Actor) => {
    const before = rowById(task)
    const at = now()
    const set: string[] = []
    const values: SqlValue[] = []
    const change = (column: string, value: SqlValue, event?: TaskEvent["kind"]) => {
      if ((before[column] ?? null) === value) return
      set.push(`${column} = ?`)
      values.push(value)
      if (event) recordTaskEvent(database, task, actor, event, { [column]: [before[column] ?? null, value] }, at)
    }
    if (fields.title !== undefined) {
      const title = textOf(fields.title, "a task's title", 300)
      change("title", title)
      change("title_folded", folded(title))
    }
    if (fields.description !== undefined)
      change("description", fields.description === null ? null : textOf(fields.description, "a description", 20000))
    if (fields.priority !== undefined) change("priority", priorityOf(fields.priority), "priority")
    if (fields.parent !== undefined)
      change("parent_id", fields.parent === null ? null : parentOf(task, Number(before.project_id), fields.parent))
    if (fields.dueAt !== undefined) change("due_at", fields.dueAt === null ? null : fields.dueAt.getTime(), "due")
    // Moved on every look, so no event: the history would be mostly check-ins.
    if (fields.nextCheckAt !== undefined)
      change("next_check_at", fields.nextCheckAt === null ? null : fields.nextCheckAt.getTime())
    if (fields.status !== undefined) {
      if (!TASK_STATES.includes(fields.status))
        throw new CliError("validation_error", `a task's status is one of ${TASK_STATES.join(", ")}`)
      const closed = fields.status !== "open"
      if (before.status !== fields.status) {
        change("status", fields.status, "status")
        change("closed_at", closed ? at : null)
        change("closed_by_type", closed ? actor.type : null)
        change("closed_by_id", closed ? actor.id : null)
      }
    }
    if (fields.reason !== undefined) {
      const reason = fields.reason === null ? null : textOf(fields.reason, "a reason", 500)
      change("close_reason", reason)
      change("close_reason_folded", folded(reason))
    }
    if (set.length === 0) return
    database.prepare(`UPDATE tasks SET ${set.join(", ")}, updated_at = ? WHERE id = ?`).run(...values, at, task)
  }

  return {
    ...taskRelationsStoreOver(context, (task, actor, kind, changes, at) =>
      recordTaskEvent(database, task, actor, kind, changes, at),
    ),
    create: async (input, by) => {
      if (!WORK_TASK_TYPES.includes(input.type))
        throw new CliError("validation_error", `a task made here is one of ${WORK_TASK_TYPES.join(", ")}`)
      const made = write(database, () => {
        const project = projectOf(input.project)
        const { actor } = authorActor(context, by)
        const at = now()
        const counted = database
          .prepare(
            "UPDATE projects SET tasks_count = tasks_count + 1, updated_at = ? WHERE id = ? RETURNING key, tasks_count",
          )
          .get(at, project) as Row
        const number = Number(counted.tasks_count)
        if (!Number.isSafeInteger(number) || number < 1)
          throw new CliError("configuration_error", "the project task counter exceeds the safe numbering range")
        const id = Number(
          database
            .prepare(
              "INSERT INTO tasks (project_id, number, key, title, title_folded, type, status, author_type, author_id, source, " +
                "created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?) RETURNING id",
            )
            .get(
              project,
              number,
              `${String(counted.key)}-${number}`,
              textOf(input.title, "a task's title", 300),
              folded(textOf(input.title, "a task's title", 300)),
              input.type,
              actor.type,
              actor.id,
              by === "owner" ? "owner" : "agent",
              at,
              at,
            )?.id,
        )
        recordTaskEvent(database, id, actor, "created", null, at)
        const { title: _title, project: _project, type: _type, ...fields } = input
        edit(id, fields, actor)
        return id
      })
      return details(made)
    },
    edit: async (id, fields, by) => {
      const task = required(id)
      write(database, () => edit(task, fields, authorActor(context, by).actor))
      return details(task)
    },
    assign: async (id, { to, role }, by) => {
      if (!TASK_ROLES.includes(role))
        throw new CliError("validation_error", `a role is one of ${TASK_ROLES.join(", ")}`)
      const task = required(id)
      write(database, () => {
        const person = personOf(to)
        const held = database
          .prepare(
            "SELECT 1 FROM task_assignments WHERE task_id = ? AND assignee_type = 'person' AND assignee_id = ? AND role = ?",
          )
          .get(task, person, role)
        if (held) return
        const at = now()
        database
          .prepare(
            "INSERT INTO task_assignments (task_id, assignee_type, assignee_id, role, created_at, updated_at) VALUES (?, 'person', ?, ?, ?, ?)",
          )
          .run(task, person, role, at, at)
        const changes = { [role]: [null, `person:${person}`] as [unknown, unknown] }
        recordTaskEvent(database, task, authorActor(context, by).actor, "assigned", changes, at)
      })
      return details(task)
    },
    unassign: async (id, { to, role }, by) => {
      const task = required(id)
      write(database, () => {
        const person = personOf(to)
        const removed = database
          .prepare(
            "DELETE FROM task_assignments WHERE task_id = ? AND assignee_type = 'person' AND assignee_id = ? AND role = ?",
          )
          .run(task, person, role).changes
        if (removed === 0) return
        const changes = { [role]: [`person:${person}`, null] as [unknown, unknown] }
        recordTaskEvent(database, task, authorActor(context, by).actor, "unassigned", changes, now())
      })
      return details(task)
    },
    details: async (id) => details(required(id)),
    find: async ({ project, type, status, assignee, limit = 100 }) => {
      if (type !== undefined && !TASK_TYPES.includes(type))
        throw new CliError("validation_error", `a task's type is one of ${TASK_TYPES.join(", ")}`)
      const projectId = project === undefined ? null : projectOf(project)
      const person = assignee === undefined ? null : personOf(assignee)
      return database
        .prepare(
          "SELECT * FROM tasks t WHERE deleted_at IS NULL AND (? IS NULL OR project_id = ?) AND (? IS NULL OR type = ?) " +
            "AND (? IS NULL OR status = ?) AND (? IS NULL OR EXISTS (SELECT 1 FROM task_assignments a " +
            "WHERE a.task_id = t.id AND a.assignee_type = 'person' AND a.assignee_id = ?)) " +
            "ORDER BY coalesce(priority, 5), created_at, id LIMIT ?",
        )
        .all(
          projectId,
          projectId,
          type ?? null,
          type ?? null,
          status ?? null,
          status ?? null,
          person,
          person,
          Math.min(Math.max(limit, 1), 500),
        )
        .map(detailsOf)
    },
    events: async (id) =>
      database
        .prepare(
          "SELECT actor_type, actor_id, kind, changes, created_at FROM task_events WHERE task_id = ? ORDER BY id",
        )
        .all(required(id))
        .map((row) => ({
          kind: row.kind as TaskEvent["kind"],
          actor: row.actor_type == null ? null : { type: row.actor_type as Actor["type"], id: Number(row.actor_id) },
          changes: row.changes == null ? null : JSON.parse(String(row.changes)),
          at: iso(row.created_at) as string,
        })),
  }
}
