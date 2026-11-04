import { CliError } from "@wirecat/cli-base"
import { type QueryAst, type QueryNode, walkQuery } from "@wirecat/cli-base/query"
import { parseMeetingReference } from "../meetings/index.js"
import { type TaskStatRow, withoutField } from "../store/index.js"
import type { AccountKey, MessageStore } from "../store/store.js"
import { type ColumnMap, queryFilter, type Where } from "../store/store.js"
import { isClosedState, type TaskKind } from "../tasks/index.js"
import { taskAccount } from "./task-rules.js"

export const TASK_STATS_BY = ["chat", "meeting", "project"] as const
export type TaskStatsBy = (typeof TASK_STATS_BY)[number]

/** The query field that sets the period; `closed` counts read the same range on the close time. */
export const PERIOD_FIELD = "created"

export interface TaskStatsRequest {
  by?: TaskStatsBy
  query?: QueryAst
  timezone?: string
  /** A stored chat id: only that chat's tasks. */
  group?: string
  kind?: TaskKind
}

export interface TaskStatsGroup {
  /** The stored chat id, `meeting:<account>/<meeting>`, or the project's store id. */
  group: string
  name: string | null
  open: number
  created: number
  closed: number
  oldestOpenAt?: Date
  medianCloseMs?: number
  meanOpenAgeMs?: number
}

export interface TaskStats {
  by: TaskStatsBy
  open: number
  created: number
  closed: number
  medianCloseMs?: number
  meanOpenAgeMs?: number
  rows: TaskStatsGroup[]
}

/** Only as a required term at the top: inside OR or NOT it would no longer say which tasks the period covers. */
const refuseNestedPeriod = (node: QueryNode, top = true): void => {
  if (node.kind === "predicate") return
  const optional = node.clauses.some(({ occur }) => occur === "should")
  for (const { occur, node: inner } of node.clauses) {
    if (!walkQuery(inner).some(({ field }) => field === PERIOD_FIELD)) continue
    if (!top || optional || occur !== "must")
      throw new CliError(
        "validation_error",
        `${PERIOD_FIELD}: sets the period of stats tasks show: give it as a required term, not inside OR or NOT`,
      )
    refuseNestedPeriod(inner, top)
  }
}

const renamed = (node: QueryNode, from: string, to: string): QueryNode =>
  node.kind === "predicate"
    ? node.field === from
      ? { ...node, field: to }
      : node
    : { ...node, clauses: node.clauses.map((clause) => ({ ...clause, node: renamed(clause.node, from, to) })) }

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  const upper = sorted[middle] ?? 0
  return sorted.length % 2 === 1 ? upper : ((sorted[middle - 1] ?? 0) + upper) / 2
}

const mean = (values: number[]): number => Math.round(values.reduce((sum, one) => sum + one, 0) / values.length)

const spread = (open: TaskStatRow[], closeMs: number[], now: number) => ({
  ...(closeMs.length > 0 ? { medianCloseMs: median(closeMs) } : {}),
  ...(open.length > 0 ? { meanOpenAgeMs: mean(open.map(({ createdAt }) => now - createdAt)) } : {}),
})

const and = (parts: Where[]): Where | undefined =>
  parts.length === 0
    ? undefined
    : { sql: parts.map(({ sql }) => `(${sql})`).join(" AND "), params: parts.flatMap(({ params }) => params) }

/**
 * `stats tasks show`: `open` is open now, `created` the tasks opened in the period, `closed` those closed in it; the
 * other terms of the query narrow all three. `columns` reads the task query's fields on the row `t`.
 */
export const taskStatsOf = async (
  store: MessageStore,
  account: AccountKey,
  { by = "chat", query, timezone, group, kind }: TaskStatsRequest,
  columns: ColumnMap,
  now = Date.now(),
): Promise<TaskStats> => {
  if (query) refuseNestedPeriod(query.root)
  const time = (sql: string) => ({ type: "time", sql }) as const
  const read = { ...columns, [PERIOD_FIELD]: time("t.created_at"), closed: time("t.closed_at") }
  const fixed: Where[] = [
    ...(group === undefined ? [] : [{ sql: "t.source_group = ?", params: [group] }]),
    ...(kind === undefined ? [] : [{ sql: "t.type = ?", params: [kind] }]),
    ...(by === "meeting" ? [{ sql: "t.source_kind = 'meeting'", params: [] }] : []),
  ]
  const options = { command: "stats tasks show", now, ...(timezone === undefined ? {} : { zone: timezone }) }
  const where = (ast: QueryAst | undefined, more: Where[] = []) =>
    and([...fixed, ...more, ...(ast ? [queryFilter(ast, read, options)] : [])])
  const scope = by === "project" ? ({ board: true } as const) : { account: taskAccount(account) }
  const all = await store.tasks.statRows(scope, where(withoutField(query, PERIOD_FIELD)))
  const created = await store.tasks.statRows(scope, where(query))
  const closed = await store.tasks.statRows(
    scope,
    where(query && { ...query, root: renamed(query.root, PERIOD_FIELD, "closed") }, [
      { sql: "t.closed_at IS NOT NULL", params: [] },
    ]),
  )

  const keyOf = (row: TaskStatRow) => (by === "project" ? String(row.projectId) : (row.group ?? ""))
  const groups = new Map<string, { open: TaskStatRow[]; created: number; closeMs: number[] }>()
  const slot = (row: TaskStatRow) => {
    const key = keyOf(row)
    const found = groups.get(key) ?? { open: [], created: 0, closeMs: [] }
    groups.set(key, found)
    return found
  }
  for (const row of all) if (!isClosedState(row.state)) slot(row).open.push(row)
  for (const row of created) slot(row).created++
  for (const row of closed) slot(row).closeMs.push((row.closedAt ?? row.createdAt) - row.createdAt)

  const kept = [...groups].filter(([, one]) => one.open.length + one.created + one.closeMs.length > 0)
  const ids = kept.map(([key]) => key)
  const names =
    by === "chat"
      ? await store.tasks.statNames("chat", ids, taskAccount(account))
      : by === "project"
        ? await store.tasks.statNames("project", ids)
        : await meetingNames(store, ids)
  const rows = kept.map(([key, one]) => ({
    group: key,
    name: names.get(key) ?? null,
    open: one.open.length,
    created: one.created,
    closed: one.closeMs.length,
    ...(one.open[0] ? { oldestOpenAt: new Date(one.open[0].createdAt) } : {}),
    ...spread(one.open, one.closeMs, now),
  }))
  const open = kept.flatMap(([, one]) => one.open)
  const closeMs = kept.flatMap(([, one]) => one.closeMs)
  return {
    by,
    open: open.length,
    created: created.length,
    closed: closeMs.length,
    ...spread(open, closeMs, now),
    rows,
  }
}

const meetingIdOf = (group: string): string | undefined => {
  try {
    return String(parseMeetingReference(group).meetingId)
  } catch {
    return undefined
  }
}

/** A meeting task's group is `meeting:<account>/<meeting>`; its title is the meeting's, by the meeting's store id. */
const meetingNames = async (store: MessageStore, groups: readonly string[]) => {
  const meetingOf = new Map(
    groups.flatMap((group) => {
      const id = meetingIdOf(group)
      return id === undefined ? [] : [[group, id] as const]
    }),
  )
  const titles = await store.tasks.statNames("meeting", [...new Set(meetingOf.values())])
  return new Map(
    [...meetingOf].flatMap(([group, id]) => {
      const title = titles.get(id)
      return title === undefined ? [] : [[group, title] as const]
    }),
  )
}
