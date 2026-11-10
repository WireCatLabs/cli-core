import { CliError } from "@wirecat/cli-base"
import { type QueryAst, type QueryNode, walkQuery } from "@wirecat/cli-base/query"
import { parseMeetingReference } from "../meetings/index.js"
import { type TaskStatRow, type TaskStatScope, withoutField } from "../store/index.js"
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
  /** The group's account, when the answer reads several. */
  account?: AccountKey
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
  /** Every account read, when the answer reads several. */
  accounts?: AccountKey[]
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
 * other terms of the query narrow all three. `columns` reads the task query's fields on the row `t`. Given several
 * accounts it reads each one's tasks and counts them together; every row then names its account.
 */
export const taskStatsOf = async (
  store: MessageStore,
  accounts: AccountKey | readonly AccountKey[],
  { by = "chat", query, timezone, group, kind }: TaskStatsRequest,
  columns: ColumnMap,
  now = Date.now(),
): Promise<TaskStats> => {
  if (query) refuseNestedPeriod(query.root)
  const several = Array.isArray(accounts)
  const list: readonly AccountKey[] = several
    ? [...new Map(accounts.map((one) => [taskAccount(one), one])).values()]
    : [accounts as AccountKey]
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
  // Project tasks belong to no account: one board read, whatever the accounts.
  const scopes: { account?: AccountKey; scope: TaskStatScope }[] =
    by === "project"
      ? [{ scope: { board: true } }]
      : list.map((one) => ({ account: one, scope: { account: taskAccount(one) } }))
  type Tagged = TaskStatRow & { account?: AccountKey }
  const rowsOf = async (filter: Where | undefined): Promise<Tagged[]> =>
    (
      await Promise.all(
        scopes.map(async ({ account, scope }) =>
          (await store.tasks.statRows(scope, filter)).map((row) => (account ? { ...row, account } : row)),
        ),
      )
    ).flat()
  const all = await rowsOf(where(withoutField(query, PERIOD_FIELD)))
  const created = await rowsOf(where(query))
  const closed = await rowsOf(
    where(query && { ...query, root: renamed(query.root, PERIOD_FIELD, "closed") }, [
      { sql: "t.closed_at IS NOT NULL", params: [] },
    ]),
  )

  // Chat ids repeat across accounts, so a row is one account's chat.
  const keyOf = (row: Tagged) =>
    by === "project" ? String(row.projectId) : `${row.account ? taskAccount(row.account) : ""}\t${row.group ?? ""}`
  const groups = new Map<
    string,
    { group: string; account?: AccountKey; first: number; open: TaskStatRow[]; created: number; closeMs: number[] }
  >()
  const slot = (row: Tagged) => {
    const key = keyOf(row)
    const found = groups.get(key) ?? {
      group: by === "project" ? String(row.projectId) : (row.group ?? ""),
      ...(row.account ? { account: row.account } : {}),
      first: row.createdAt,
      open: [],
      created: 0,
      closeMs: [],
    }
    found.first = Math.min(found.first, row.createdAt)
    groups.set(key, found)
    return found
  }
  for (const row of all) if (!isClosedState(row.state)) slot(row).open.push(row)
  for (const row of created) slot(row).created++
  for (const row of closed) slot(row).closeMs.push((row.closedAt ?? row.createdAt) - row.createdAt)

  const kept = [...groups.values()].filter((one) => one.open.length + one.created + one.closeMs.length > 0)
  // Each account's rows come oldest first; across accounts the groups are put back in that order.
  if (several) kept.sort((a, b) => a.first - b.first)
  const nameOf = await namesOf(store, by, kept)
  const rows = kept.map((one) => ({
    group: one.group,
    ...(several && one.account ? { account: one.account } : {}),
    name: nameOf(one) ?? null,
    open: one.open.length,
    created: one.created,
    closed: one.closeMs.length,
    ...(one.open[0] ? { oldestOpenAt: new Date(one.open[0].createdAt) } : {}),
    ...spread(one.open, one.closeMs, now),
  }))
  const open = kept.flatMap((one) => one.open)
  const closeMs = kept.flatMap((one) => one.closeMs)
  return {
    by,
    ...(several ? { accounts: [...list] } : {}),
    open: open.length,
    created: created.length,
    closed: closeMs.length,
    ...spread(open, closeMs, now),
    rows,
  }
}

/** Each group's title: chats within their own account, meetings and projects by their store id. */
const namesOf = async (
  store: MessageStore,
  by: TaskStatsBy,
  groups: readonly { group: string; account?: AccountKey }[],
): Promise<(one: { group: string; account?: AccountKey }) => string | undefined> => {
  if (by === "project") {
    const names = await store.tasks.statNames(
      "project",
      groups.map(({ group }) => group),
    )
    return ({ group }) => names.get(group)
  }
  if (by === "meeting") {
    const names = await meetingNames(
      store,
      groups.map(({ group }) => group),
    )
    return ({ group }) => names.get(group)
  }
  const byAccount = new Map<string, Map<string, string>>()
  for (const account of new Set(groups.flatMap(({ account }) => (account ? [taskAccount(account)] : []))))
    byAccount.set(
      account,
      await store.tasks.statNames(
        "chat",
        groups.filter((one) => one.account && taskAccount(one.account) === account).map(({ group }) => group),
        account,
      ),
    )
  return ({ group, account }) => (account ? byAccount.get(taskAccount(account))?.get(group) : undefined)
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
