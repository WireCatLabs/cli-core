import type { DealKind } from "../../domain/deals.js"
import { formatDecimal, type Money, scaleOf } from "../../domain/money.js"
import { type CopyViewer, viewerSql } from "./copy-viewer.js"
import type { StoreContext } from "./open.js"

export interface StageAmount extends Money {
  items: number
}

export interface StageAmounts {
  /** Every deal or lead standing in it now, with an amount or without. */
  items: number
  /** One per currency, never converted; an item with no amount adds none. */
  amounts: StageAmount[]
}

const TABLES = { deal: "deals", lead: "leads" } as const

/** What stands in each stage of `stageIds`, in that order, of the rows made in the window (epoch ms, inclusive). */
export const stageAmountsOf = (
  { database }: StoreContext,
  kind: DealKind,
  stageIds: number[],
  { since, until }: { since: number | null; until: number | null },
  viewer?: CopyViewer,
): StageAmounts[] => {
  const seen = viewerSql("d", viewer)
  const rows = database
    .prepare(
      "SELECT stage_id, currency, count(*) AS items, coalesce(sum(amount), 0) AS units " +
        `FROM ${TABLES[kind]} d WHERE stage_id IN (${stageIds.map(() => "?").join(", ") || "NULL"}) ` +
        `AND deleted_at IS NULL AND (? IS NULL OR created_at >= ?) AND (? IS NULL OR created_at <= ?) AND ${seen.sql} ` +
        "GROUP BY stage_id, currency ORDER BY currency",
    )
    .all(...stageIds, since, since, until, until, ...seen.params)
  return stageIds.map((stage) => {
    const within = rows.filter((row) => Number(row.stage_id) === stage)
    return {
      items: within.reduce((all, row) => all + Number(row.items), 0),
      amounts: within
        .filter((row) => row.currency != null)
        .map((row) => ({
          amount: formatDecimal(BigInt(row.units as number | bigint), scaleOf(String(row.currency))),
          currency: String(row.currency),
          items: Number(row.items),
        })),
    }
  })
}
