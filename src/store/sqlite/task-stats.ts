import type { SqlValue } from "../driver.js"
import type { StoreContext } from "./open.js"
import type { Where } from "./query-filter.js"
import { BOARD_SCOPE } from "./task-board.js"

/** One account's tasks (its inbox), or the owner's project tasks across every project. */
export type TaskStatScope = { account: string } | { board: true }

export interface TaskStatRow {
  group: string | null
  sourceKind: string | null
  projectId: number
  state: string
  createdAt: number
  closedAt: number | null
}

export type TaskStatNames = "chat" | "meeting" | "project"

export interface TaskStats {
  /** One narrow row per live task in the scope that `where` keeps, oldest first. */
  statRows(scope: TaskStatScope, where: Where | undefined): Promise<TaskStatRow[]>
  /** Titles by id, read once: chats by external id within `account`, meetings and projects by their store id. */
  statNames(kind: TaskStatNames, ids: readonly string[], account?: string): Promise<Map<string, string>>
}

const ACCOUNT_SCOPE = "t.package_id IS NOT NULL AND t.deleted_at IS NULL AND t.project_id = ?"

/** Every statement `stats tasks show` runs, for the query-plan test. */
export const TASK_STATS_SQL = {
  rows: (board: boolean, filter: string) =>
    "SELECT t.source_group, t.source_kind, t.project_id, t.status, t.created_at, t.closed_at FROM tasks t " +
    `WHERE ${board ? BOARD_SCOPE : ACCOUNT_SCOPE}${filter} ORDER BY t.created_at, t.id`,
  chat:
    "SELECT c.external_id AS id, c.title AS name FROM chats c JOIN accounts a ON a.id = c.account_id " +
    "WHERE a.provider = ? AND a.external_id = ? AND c.external_id IN (SELECT value FROM json_each(?))",
  meeting: "SELECT CAST(id AS TEXT) AS id, title AS name FROM meetings WHERE id IN (SELECT value FROM json_each(?))",
  project: "SELECT CAST(id AS TEXT) AS id, name FROM projects WHERE id IN (SELECT value FROM json_each(?))",
} as const

/** `inbox` finds an account's inbox project without making one. */
export const taskStatsOver = (
  { database }: StoreContext,
  inbox: (account: string) => number | undefined,
): TaskStats => ({
  statRows: async (scope, where) => {
    const filter = where === undefined ? "" : ` AND (${where.sql})`
    const board = !("account" in scope)
    const project = board ? undefined : inbox(scope.account)
    if (!board && project === undefined) return []
    return database
      .prepare(TASK_STATS_SQL.rows(board, filter))
      .all(...(project === undefined ? [] : [project]), ...(where?.params ?? []))
      .map((row) => ({
        group: row.source_group == null ? null : String(row.source_group),
        sourceKind: row.source_kind == null ? null : String(row.source_kind),
        projectId: Number(row.project_id),
        state: String(row.status),
        createdAt: Number(row.created_at),
        closedAt: row.closed_at == null ? null : Number(row.closed_at),
      }))
  },
  statNames: async (kind, ids, account) => {
    if (ids.length === 0) return new Map()
    let params: SqlValue[] = [JSON.stringify(ids.map(Number))]
    if (kind === "chat") {
      if (account === undefined) return new Map()
      const at = account.indexOf(":")
      params = [account.slice(0, at), account.slice(at + 1), JSON.stringify(ids)]
    }
    const rows = database.prepare(TASK_STATS_SQL[kind]).all(...params)
    return new Map(rows.filter((row) => row.name != null).map((row) => [String(row.id), String(row.name)]))
  },
})
