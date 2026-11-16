import { zonedMoment } from "@wirecat/cli-base/query"
import type { DealKind, StageOutcome } from "../../domain/deals.js"
import { dayIn } from "../../domain/moment.js"
import { formatDecimal, scaleOf } from "../../domain/money.js"
import type { CacheDatabase } from "../driver.js"
import { type CopyViewer, viewerSql } from "./copy-viewer.js"
import { stageEntriesOf } from "./crm-stage-entries.js"
import type { StoreContext } from "./open.js"
import { refuse } from "./reviewed.js"
import { type StageAmount, type StageAmounts, stageAmountsOf } from "./stage-amounts.js"

const TABLES = { deal: "deals", lead: "leads" } as const
const DAY = 86_400_000
const LOST_REASONS = 10

/** A column between the bounds, each inclusive; no bound, no condition. */
export const bounded = (
  column: string,
  bounds: { since?: number | string; until?: number | string } | undefined,
): { sql: string; params: (number | string)[] }[] => [
  ...(bounds?.since === undefined ? [] : [{ sql: `${column} >= ?`, params: [bounds.since] }]),
  ...(bounds?.until === undefined ? [] : [{ sql: `${column} <= ?`, params: [bounds.until] }]),
]

/** A window's bound, a `YYYY-MM-DD` day in `zone` (its start, or its end for `end`) or an ISO time, as epoch ms. */
export const boundOf = (value: string | undefined, what: string, zone: string, end = false): number | null => {
  if (value === undefined) return null
  const typed = value.trim()
  try {
    return zonedMoment(typed, zone, { start: 0, end: typed.length }, { end })
  } catch {
    return refuse(`${what} is a YYYY-MM-DD day or an ISO time, not ${value}`, "deal.field")
  }
}

/** A stage the CRM removed stays in a pipeline only while a row stands in it (BUG-7). */
export const SHOWN_STAGE =
  "(s.deleted_at IS NULL OR EXISTS (SELECT 1 FROM deals d WHERE d.stage_id = s.id AND d.deleted_at IS NULL) " +
  "OR EXISTS (SELECT 1 FROM leads l WHERE l.stage_id = s.id AND l.deleted_at IS NULL))"

/** Each stage of these pipelines that is shown, with how many open deals and leads the viewer may read stand in it. */
export const openPerStage = (database: CacheDatabase, pipelineIds: number[], viewer?: CopyViewer) => {
  const deals = viewerSql("d", viewer)
  const leads = viewerSql("l", viewer)
  return database
    .prepare(
      `SELECT s.*, (SELECT count(*) FROM deals d WHERE d.stage_id = s.id AND d.status = 'open' AND d.deleted_at IS NULL AND ${deals.sql}) + ` +
        `(SELECT count(*) FROM leads l WHERE l.stage_id = s.id AND l.status = 'open' AND l.deleted_at IS NULL AND ${leads.sql}) AS open ` +
        `FROM pipeline_stages s WHERE s.pipeline_id IN (${pipelineIds.map(() => "?").join(", ") || "NULL"}) ` +
        `AND ${SHOWN_STAGE} ORDER BY s.pipeline_id, s.position, s.id`,
    )
    .all(...deals.params, ...leads.params, ...pipelineIds)
}

/** Epoch ms bounds, both inclusive; `null` is open. */
export interface PeriodWindow {
  since: number | null
  until: number | null
}

export interface FunnelCounts extends StageAmounts {
  /** Rows of the cohort that got this far: entered this stage or a later one that is not lost, or were won. */
  reached: number
  /** `reached` of the next stage that is not lost over this stage's, 0–1; `null` for the last or an empty one. */
  conversion: number | null
  /** The median days a cohort row stayed in the stage before it entered another; `null` when none left it. */
  medianDays: number | null
}

export interface PipelinePeriod {
  stages: FunnelCounts[]
  /** The cohort: rows made in the window. */
  totals: { items: number; open: number; won: number; lost: number; winRate: number | null }
  /** Rows closed on a day in the window, in the owner's zone. */
  closed: { won: number; lost: number; winRate: number | null; wonAmounts: StageAmount[] }
  /** Days from made to won, for rows won in the window: the CRM's entry into the won stage, else the closed day. */
  cycle: { medianDays: number | null; items: number }
  /** The cohort by its CRM assignee. */
  owners: {
    assignee: string | null
    name: string | null
    open: number
    won: number
    lost: number
    winRate: number | null
  }[]
  /** Why rows closed lost in the window were lost, the most common first. */
  lostReasons: { reason: string; items: number }[]
  /** Rows whose stages came from the CRM's own history, and from the copy's diffs between syncs. */
  history: { exact: number; copy: number }
}

const share = (part: number, whole: number) => (whole === 0 ? null : Math.round((part / whole) * 1000) / 1000)

const median = (values: number[]): number | null => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  const value =
    sorted.length % 2 ? (sorted[middle] as number) : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
  return Math.round((value / DAY) * 10) / 10
}

const rate = (won: number, lost: number) => share(won, won + lost)

interface Item {
  id: number
  status: string
  stageId: number
  createdAt: number
  closedDate: string | null
  assignee: string | null
  reason: string | null
  currency: string | null
  amount: number | bigint | null
}

const itemsOf = (database: CacheDatabase, kind: DealKind, pipelineId: number, viewer?: CopyViewer): Item[] => {
  const seen = viewerSql("d", viewer)
  return database
    .prepare(
      "SELECT d.id, d.status, d.stage_id, d.created_at, d.closed_date, d.currency, d.amount, " +
        "json_extract(d.metadata, '$.assignee') AS assignee, json_extract(d.metadata, '$.closed_reason') AS reason " +
        `FROM ${TABLES[kind]} d JOIN pipeline_stages s ON s.id = d.stage_id WHERE s.pipeline_id = ? AND d.deleted_at IS NULL AND ${seen.sql}`,
    )
    .all(pipelineId, ...seen.params)
    .map((row) => ({
      id: Number(row.id),
      status: String(row.status),
      stageId: Number(row.stage_id),
      createdAt: Number(row.created_at),
      closedDate: row.closed_date == null ? null : String(row.closed_date),
      assignee: row.assignee == null ? null : String(row.assignee),
      reason: row.reason == null ? null : String(row.reason),
      currency: row.currency == null ? null : String(row.currency),
      amount: (row.amount as number | bigint | null) ?? null,
    }))
}

/** The CRM user's name as its identity holds it; its ids are `<account>/user/<id>`. */
const userName = (database: CacheDatabase, provider: string | null, assignee: string | null) => {
  if (provider === null || assignee === null) return null
  const row = database
    .prepare(
      "SELECT coalesce(p.name, i.name) AS name FROM identities i LEFT JOIN identity_links l ON l.identity_id = i.id " +
        "LEFT JOIN persons p ON p.id = l.person_id WHERE i.provider = ? AND i.external_id = ?",
    )
    .get(provider, assignee)
  return row?.name == null ? null : String(row.name)
}

/**
 * One pipeline's funnel and outcomes over a window: the funnel counts the cohort made in it, `closed`, `cycle` and
 * `lostReasons` the rows closed in it. Each row's stages come from the CRM's history where it has one, else the copy's.
 */
export const pipelinePeriod = (
  context: StoreContext,
  pipeline: { id: string; kind: DealKind; account: { provider: string } | null },
  window: PeriodWindow,
  zone: string,
  viewer?: CopyViewer,
): PipelinePeriod => {
  const { database } = context
  const { kind } = pipeline
  const pipelineId = Number(pipeline.id)
  const made = (at: number) =>
    (window.since === null || at >= window.since) && (window.until === null || at <= window.until)
  const days = {
    since: window.since === null ? null : dayIn(window.since, zone),
    until: window.until === null ? null : dayIn(window.until, zone),
  }
  const closedIn = (day: string | null) =>
    day !== null && (days.since === null || day >= days.since) && (days.until === null || day <= days.until)
  const all = itemsOf(database, kind, pipelineId, viewer)
  const cohort = all.filter((item) => made(item.createdAt))
  const stages = database
    .prepare(
      `SELECT s.id, s.position, s.outcome FROM pipeline_stages s WHERE s.pipeline_id = ? AND ${SHOWN_STAGE} ` +
        "ORDER BY s.position, s.id",
    )
    .all(pipelineId)
    .map((row) => ({ id: Number(row.id), outcome: row.outcome as StageOutcome }))
  const order = new Map(stages.map((stage, at) => [stage.id, at]))
  const lostStage = new Set(stages.filter((stage) => stage.outcome === "lost").map(({ id }) => id))
  const wonStage = new Set(stages.filter((stage) => stage.outcome === "won").map(({ id }) => id))
  const entries = new Map<number, ReturnType<typeof stageEntriesOf>>()
  for (const entry of stageEntriesOf(database, kind, { pipeline: pipelineId })) {
    const own = entries.get(entry.itemId) ?? []
    own.push(entry)
    entries.set(entry.itemId, own)
  }

  const furthest = cohort.map((item) => {
    if (item.status === "won") return Number.POSITIVE_INFINITY
    const reached = [...(entries.get(item.id) ?? []).map(({ toStageId }) => toStageId), item.stageId]
      .filter((stage) => !lostStage.has(stage))
      .map((stage) => order.get(stage) ?? -1)
    // A row first seen closed has no entries: it got at least as far as the first stage.
    return reached.reduce((far, at) => Math.max(far, at), 0)
  })
  const lost = cohort.filter((item) => item.status === "lost").length
  const won = cohort.filter((item) => item.status === "won").length
  const reachedAt = (at: number) =>
    lostStage.has(stages[at]?.id as number) ? lost : furthest.filter((far) => far >= at).length
  const stays = new Map<number, number[]>()
  for (const item of cohort) {
    const own = entries.get(item.id) ?? []
    own.slice(0, -1).forEach((entry, at) => {
      const next = own[at + 1] as (typeof own)[number]
      const days = stays.get(entry.toStageId) ?? []
      days.push(next.at - entry.at)
      stays.set(entry.toStageId, days)
    })
  }
  const standing = stageAmountsOf(
    context,
    kind,
    stages.map(({ id }) => id),
    window,
    viewer,
  )
  const funnel = stages.map((stage, at) => {
    const reached = reachedAt(at)
    const next = stages.findIndex((one, after) => after > at && !lostStage.has(one.id))
    const conversion = lostStage.has(stage.id) || next === -1 ? null : share(reachedAt(next), reached)
    return { reached, conversion, medianDays: median(stays.get(stage.id) ?? []), ...(standing[at] as StageAmounts) }
  })

  const closedWon = all.filter((item) => item.status === "won" && closedIn(item.closedDate))
  const closedLost = all.filter((item) => item.status === "lost" && closedIn(item.closedDate))
  const sums = new Map<string, { units: bigint; items: number }>()
  for (const item of closedWon)
    if (item.currency !== null) {
      const held = sums.get(item.currency) ?? { units: 0n, items: 0 }
      sums.set(item.currency, { units: held.units + BigInt(item.amount ?? 0), items: held.items + 1 })
    }
  const wonAt = (item: Item) =>
    (entries.get(item.id) ?? []).filter((entry) => entry.exact && wonStage.has(entry.toStageId)).at(-1)?.at ??
    (item.closedDate === null ? null : Date.parse(`${item.closedDate}T00:00:00Z`))
  const cycles = closedWon.flatMap((item) => {
    const at = wonAt(item)
    return at === null ? [] : [Math.max(0, at - item.createdAt)]
  })
  const owners = new Map<string | null, Item[]>()
  for (const item of cohort) {
    const own = owners.get(item.assignee) ?? []
    own.push(item)
    owners.set(item.assignee, own)
  }
  const reasons = new Map<string, number>()
  for (const item of closedLost) if (item.reason) reasons.set(item.reason, (reasons.get(item.reason) ?? 0) + 1)
  const exact = cohort.filter((item) => entries.get(item.id)?.[0]?.exact === true).length

  return {
    stages: funnel,
    totals: { items: cohort.length, open: cohort.length - won - lost, won, lost, winRate: rate(won, lost) },
    closed: {
      won: closedWon.length,
      lost: closedLost.length,
      winRate: rate(closedWon.length, closedLost.length),
      wonAmounts: [...sums]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([currency, { units, items }]) => ({
          amount: formatDecimal(units, scaleOf(currency)),
          currency,
          items,
        })),
    },
    cycle: { medianDays: median(cycles), items: cycles.length },
    owners: [...owners].map(([assignee, items]) => {
      const ownWon = items.filter((item) => item.status === "won").length
      const ownLost = items.filter((item) => item.status === "lost").length
      return {
        assignee,
        name: userName(database, pipeline.account?.provider ?? null, assignee),
        open: items.length - ownWon - ownLost,
        won: ownWon,
        lost: ownLost,
        winRate: rate(ownWon, ownLost),
      }
    }),
    lostReasons: [...reasons]
      .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
      .slice(0, LOST_REASONS)
      .map(([reason, items]) => ({ reason, items })),
    history: { exact, copy: cohort.length - exact },
  }
}
