import { renderPretty } from "@wirecat/cli-base"
import type { Body } from "../../cli/envelope.js"
import { formatDecimal, groupDigits, parseDecimal, scaleOf } from "../../domain/money.js"
import type { StageAmount } from "../../store/sqlite/stage-amounts.js"

interface ShownStage {
  name: string
  outcome: string
  items: number
  amounts: StageAmount[]
  reached: number
  conversion: number | null
}

interface ShownPipeline {
  ref: string
  name: string
  kind: string
  stages: ShownStage[]
  totals: { items: number; open: number; won: number; lost: number; win_rate: number | null }
}

const sumOf = (amounts: Omit<StageAmount, "items">[]) =>
  amounts.map(({ amount, currency }) => `${groupDigits(amount)} ${currency}`).join(", ") || "—"

const percent = (share: number | null) => (share === null ? "—" : `${Math.round(share * 100)}%`)

const openStages = (stages: ShownStage[]) => {
  const sums = new Map<string, bigint>()
  let items = 0
  for (const stage of stages.filter((one) => one.outcome === "open")) {
    items += stage.items
    for (const { amount, currency } of stage.amounts)
      sums.set(currency, (sums.get(currency) ?? 0n) + (parseDecimal(amount, scaleOf(currency)) ?? 0n))
  }
  const amounts = [...sums].map(([currency, units]) => ({
    amount: formatDecimal(units, scaleOf(currency)),
    currency,
  }))
  return `in open stages: ${items} · ${sumOf(amounts)}`
}

/** `pipelines show` at a terminal: the board as a table, then what the open stages hold and how the closed ended. */
export const pipelineView = (body: Body, color: boolean): string => {
  const pipeline = (body as { item: ShownPipeline }).item
  const rows = pipeline.stages.map((stage) => ({
    stage: stage.name,
    outcome: stage.outcome,
    [`${pipeline.kind}s`]: stage.items,
    sum: sumOf(stage.amounts),
    reached: stage.reached,
    "went on": percent(stage.conversion),
  }))
  const { won, lost, win_rate } = pipeline.totals
  return [
    `${pipeline.name} (${pipeline.ref})`,
    renderPretty(rows, { color }),
    `${openStages(pipeline.stages)}\nwon: ${won} · lost: ${lost} · win rate ${percent(win_rate)}`,
  ].join("\n\n")
}
