import type { DealKind, StageOutcome } from "../../domain/deals.js"
import type { CacheDatabase } from "../driver.js"

type Row = Record<string, unknown>

export const baseSettingKey = (kind: DealKind) => `stages.base.${kind}`

const storedPipeline = (value: unknown): number | undefined => {
  if (typeof value !== "string") return undefined
  const match = /^"pipeline:(\d+)"$/.exec(value)
  return match ? Number(match[1]) : undefined
}

/** The set's pipeline, while the setting names an own, live pipeline of the kind. */
export const basePipelineOf = (database: CacheDatabase, kind: DealKind): number | undefined => {
  const id = storedPipeline(
    database.prepare("SELECT value FROM store_settings WHERE key = ?").get(baseSettingKey(kind))?.value,
  )
  if (id === undefined) return undefined
  const row = database
    .prepare("SELECT 1 FROM pipelines WHERE id = ? AND kind = ? AND account_id IS NULL AND deleted_at IS NULL")
    .get(id, kind)
  return row ? id : undefined
}

export const baseStagesOf = (database: CacheDatabase, pipeline: number): Row[] =>
  database.prepare("SELECT * FROM pipeline_stages WHERE pipeline_id = ? ORDER BY position, id").all(pipeline)

/**
 * Suggests a base stage for every unconfirmed live stage of `pipelines` (every pipeline of the kind but the set's when absent): won and lost by outcome; an open one by its relative place among its pipeline's open stages, and when that
 * falls between two base stages, the one of the same name, else the nearer. Does nothing before the set exists.
 */
export const suggestBaseStages = (database: CacheDatabase, kind: DealKind, pipelines?: readonly number[]): void => {
  const base = basePipelineOf(database, kind)
  if (base === undefined) return
  const stages = baseStagesOf(database, base)
  const byOutcome = (outcome: StageOutcome) => stages.filter((stage) => stage.outcome === outcome)
  const open = byOutcome("open")
  const ends = { won: byOutcome("won")[0], lost: byOutcome("lost")[0] }
  const ids =
    pipelines ??
    database
      .prepare("SELECT id FROM pipelines WHERE kind = ? AND id <> ? AND deleted_at IS NULL")
      .all(kind, base)
      .map((row) => Number(row.id))
  const update = database.prepare(
    "UPDATE pipeline_stages SET base_stage_id = ? WHERE id = ? AND base_confirmed = 0 AND base_stage_id IS NOT ?",
  )
  for (const pipeline of ids) {
    if (pipeline === base) continue
    const own = database
      .prepare("SELECT * FROM pipeline_stages WHERE pipeline_id = ? AND deleted_at IS NULL ORDER BY position, id")
      .all(pipeline)
    const ownOpen = own.filter((stage) => stage.outcome === "open")
    for (const stage of own) {
      let chosen: Row | undefined
      if (stage.outcome === "open" && open.length > 0) {
        const at = ownOpen.indexOf(stage)
        const place = ownOpen.length === 1 ? 0 : (at / (ownOpen.length - 1)) * (open.length - 1)
        const [below, above] = [open[Math.floor(place)], open[Math.ceil(place)]] as [Row, Row]
        chosen =
          below === above
            ? below
            : ([below, above].find((one) => one.name_folded === stage.name_folded) ??
              (place - Math.floor(place) < 0.5 ? below : above))
      } else if (stage.outcome !== "open") chosen = ends[stage.outcome as "won" | "lost"]
      const target = chosen === undefined ? null : Number(chosen.id)
      update.run(target, Number(stage.id), target)
    }
  }
}
