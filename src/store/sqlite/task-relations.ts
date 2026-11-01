import { CliError } from "@wirecat/cli-base"
import { isClosedState } from "../../tasks/index.js"
import type { CacheDatabase } from "../driver.js"
import type { Actor } from "./actors.js"
import { type Author, authorActor } from "./memories.js"
import type { StoreContext } from "./open.js"
import { taskIdOf, taskRowOf } from "./things.js"
import { read, write } from "./transaction.js"

export const TASK_RELATION_KINDS = [
  "blocked-by",
  "follow-up-of",
  "related-to",
  "duplicate-of",
  "discovered-from",
] as const
export type TaskRelationKind = (typeof TASK_RELATION_KINDS)[number]
export interface TaskRelation {
  id: string
  from: string
  to: string
  kind: TaskRelationKind
}
export interface TaskRelationsStore {
  linkTask(
    from: string,
    to: string,
    kind: TaskRelationKind,
    by: Author,
  ): Promise<{ relation: TaskRelation; changed: boolean }>
  unlinkTask(from: string, to: string, kind: TaskRelationKind, by: Author): Promise<{ changed: boolean }>
  taskRelations(task: string): Promise<TaskRelation[]>
  taskReadiness(
    task: string,
  ): Promise<{ ready: boolean; blockers: { task: string; state: "open" | "dismissed" | "unavailable" }[] }>
  readyTasks(
    project: string,
    options?: { limit?: number },
  ): Promise<{ items: { id: string; key: string; title: string }[]; hasMore: boolean }>
}

const kindOf = (kind: TaskRelationKind) => {
  if (!TASK_RELATION_KINDS.includes(kind))
    throw new CliError("validation_error", `choose ${TASK_RELATION_KINDS.join(", ")}`)
}
const liveTask = (database: CacheDatabase, rowId: number) => {
  const row = database
    .prepare(
      "SELECT t.id,t.status FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=? AND t.deleted_at IS NULL AND p.deleted_at IS NULL AND p.account_id IS NULL",
    )
    .get(rowId)
  if (!row) throw new CliError("not_found", "the owner project task is unavailable")
  return row
}
/** A message task's inbox has an account, so the owner-project check refuses it; one job seen twice is either kind. */
const anyLiveTask = (database: CacheDatabase, rowId: number) => {
  const row = database
    .prepare(
      "SELECT t.id,t.status,t.project_id FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=? AND t.deleted_at IS NULL AND p.deleted_at IS NULL",
    )
    .get(rowId)
  if (!row) throw new CliError("not_found", "the task is unavailable")
  return row
}
/** A duplicate and a follow-up join message tasks too: a job seen twice, a job that came back. */
const liveFor = (database: CacheDatabase, rowId: number, kind?: TaskRelationKind) =>
  kind === "duplicate-of" || kind === "follow-up-of" || kind === undefined
    ? anyLiveTask(database, rowId)
    : liveTask(database, rowId)

/** Validation and the edge insert must see the same write-locked snapshot. */
export const validateTaskRelation = (database: CacheDatabase, from: number, to: number, kind: TaskRelationKind) => {
  kindOf(kind)
  const a = liveFor(database, from, kind)
  const b = liveFor(database, to, kind)
  if (from === to) throw new CliError("validation_error", "a task cannot link to itself")
  if (kind === "duplicate-of" && a.project_id !== b.project_id)
    throw new CliError("validation_error", "a duplicate is in the same project or account as the task it duplicates")
  if (kind === "related-to") return
  const reached = database
    .prepare(
      "WITH RECURSIVE reached(id) AS (SELECT ? UNION SELECT l.to_id FROM links l JOIN reached r ON l.from_id=r.id WHERE l.from_type='task' AND l.to_type='task' AND l.kind=? AND l.anchor IS NULL LIMIT 10001) SELECT id FROM reached",
    )
    .all(to, kind)
  if (reached.length > 10000) throw new CliError("validation_error", "task dependency traversal exceeds 10000 nodes")
  if (reached.some((row) => Number(row.id) === from))
    throw new CliError("validation_error", "this task relationship would create a cycle", {
      reason: "task.dependency-cycle",
    })
}

export const taskRelationsStoreOver = (
  context: StoreContext,
  record: (
    task: number,
    actor: Actor,
    kind: "linked" | "unlinked",
    changes: Record<string, [unknown, unknown]>,
    at: number,
  ) => void,
): TaskRelationsStore => {
  const { database, now } = context
  const required = (reference: string, kind?: TaskRelationKind) => {
    if (typeof reference !== "string" || !reference.trim())
      throw new CliError("validation_error", "a task reference is required")
    const rowId = taskRowOf(database, reference.startsWith("task:") ? reference.slice(5) : reference)
    if (rowId === undefined) throw new CliError("not_found", "the task is unavailable")
    liveFor(database, rowId, kind)
    return rowId
  }
  const ref = (rowId: number) => {
    const found = taskIdOf(database, rowId)
    if (found === undefined) throw new CliError("not_found", "a task relationship points at an unavailable record")
    return `task:${found}`
  }
  const pair = (from: string, to: string, kind: TaskRelationKind) => {
    kindOf(kind)
    const a = required(from, kind)
    const b = required(to, kind)
    return kind === "related-to" && a > b ? ([b, a] as const) : ([a, b] as const)
  }
  const relationOf = (row: Record<string, unknown>): TaskRelation => ({
    id: String(row.id),
    from: ref(Number(row.from_id)),
    to: ref(Number(row.to_id)),
    kind: row.kind as TaskRelationKind,
  })
  const lookup = (from: number, to: number, kind: TaskRelationKind) =>
    database
      .prepare(
        "SELECT id,from_id,to_id,kind FROM links WHERE from_type='task' AND to_type='task' AND kind=? AND anchor IS NULL AND ((from_id=? AND to_id=?) OR (?='related-to' AND from_id=? AND to_id=?)) ORDER BY id LIMIT 1",
      )
      .get(kind, from, to, kind, to, from)
  return {
    linkTask: async (from, to, kind, by) =>
      write(database, () => {
        if (by !== "owner")
          throw new CliError("permission_error", "an agent proposes task relationships; only the owner applies them")
        const [a, b] = pair(from, to, kind)
        validateTaskRelation(database, a, b, kind)
        const held = lookup(a, b, kind)
        if (held) return { relation: relationOf(held), changed: false }
        const at = now()
        database
          .prepare(
            "INSERT INTO links (from_type,from_id,to_type,to_id,kind,source,confirmed,author,created_at,updated_at) VALUES ('task',?,'task',? ,?,'owner',1,'owner',?,?)",
          )
          .run(a, b, kind, at, at)
        record(a, authorActor(context, "owner").actor, "linked", { relation: [null, { kind, to: ref(b) }] }, at)
        return { relation: relationOf(lookup(a, b, kind) as Record<string, unknown>), changed: true }
      }),
    unlinkTask: async (from, to, kind, by) =>
      write(database, () => {
        if (by !== "owner")
          throw new CliError("permission_error", "an agent proposes task relationships; only the owner applies them")
        const [a, b] = pair(from, to, kind)
        const changed =
          database
            .prepare(
              "DELETE FROM links WHERE from_type='task' AND to_type='task' AND kind=? AND anchor IS NULL AND ((from_id=? AND to_id=?) OR (?='related-to' AND from_id=? AND to_id=?))",
            )
            .run(kind, a, b, kind, b, a).changes > 0
        if (changed)
          record(a, authorActor(context, "owner").actor, "unlinked", { relation: [{ kind, to: ref(b) }, null] }, now())
        return { changed }
      }),
    taskRelations: async (task) =>
      read(database, () => {
        const rowId = required(task)
        const rows = database
          .prepare(
            "SELECT id,from_id,to_id,kind FROM links WHERE from_type='task' AND to_type='task' AND (from_id=? OR to_id=?) AND kind IN ('blocked-by','follow-up-of','related-to','duplicate-of') AND anchor IS NULL ORDER BY id LIMIT 501",
          )
          .all(rowId, rowId)
        if (rows.length > 500)
          throw new CliError("validation_error", "task relationships exceed the 500-edge read budget")
        return rows.map(relationOf)
      }),
    taskReadiness: async (task) =>
      read(database, () => {
        const rowId = required(task, "blocked-by")
        const rows = database
          .prepare(
            "SELECT l.to_id,t.status,t.deleted_at,p.deleted_at AS project_deleted FROM links l LEFT JOIN tasks t ON t.id=l.to_id LEFT JOIN projects p ON p.id=t.project_id WHERE l.from_type='task' AND l.to_type='task' AND l.kind='blocked-by' AND l.from_id=? AND l.confirmed=1 AND l.anchor IS NULL AND (t.id IS NULL OR t.deleted_at IS NOT NULL OR p.deleted_at IS NOT NULL OR t.status!='done') ORDER BY l.id LIMIT 101",
          )
          .all(rowId)
        if (rows.length > 100) throw new CliError("validation_error", "task blockers exceed the 100-edge read budget")
        const blockers = rows.map((row) => ({
          task: ref(Number(row.to_id)),
          state:
            row.status == null || row.deleted_at != null || row.project_deleted != null
              ? ("unavailable" as const)
              : row.status === "dismissed"
                ? ("dismissed" as const)
                : ("open" as const),
        }))
        return { ready: !isClosedState(String(liveTask(database, rowId).status)) && blockers.length === 0, blockers }
      }),
    readyTasks: async (project, options = {}) =>
      read(database, () => {
        const limit = options.limit ?? 50
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
          throw new CliError("validation_error", "ready tasks take 1–500 rows")
        const row = project.startsWith("project:")
          ? database
              .prepare("SELECT id FROM projects WHERE id=? AND account_id IS NULL AND deleted_at IS NULL")
              .get(project.slice(8))
          : database
              .prepare("SELECT id FROM projects WHERE key=? AND account_id IS NULL AND deleted_at IS NULL")
              .get(project.trim().toUpperCase())
        if (!row) throw new CliError("not_found", "the owner project is unavailable")
        const rows = database
          .prepare(
            "SELECT coalesce(t.package_id,t.key) AS id,t.key,substr(t.title,1,300) AS title FROM tasks t WHERE t.project_id=? AND t.status NOT IN ('done','dismissed') AND t.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM links l LEFT JOIN tasks b ON b.id=l.to_id LEFT JOIN projects p ON p.id=b.project_id WHERE l.from_type='task' AND l.to_type='task' AND l.kind='blocked-by' AND l.from_id=t.id AND l.confirmed=1 AND l.anchor IS NULL AND (b.id IS NULL OR b.deleted_at IS NOT NULL OR p.deleted_at IS NOT NULL OR b.status!='done')) ORDER BY t.priority_score IS NULL,t.priority_score DESC,t.number,t.id LIMIT ?",
          )
          .all(Number(row.id), limit + 1)
        return {
          items: rows
            .slice(0, limit)
            .map((value) => ({ id: String(value.id), key: String(value.key), title: String(value.title ?? "") })),
          hasMore: rows.length > limit,
        }
      }),
  }
}
