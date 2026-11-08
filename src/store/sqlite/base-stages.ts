import { CliError } from "@wirecat/cli-base"
import { DEAL_KINDS, type DealKind, STAGE_OUTCOMES, type StageOutcome } from "../../domain/deals.js"
import type { CacheDatabase } from "../driver.js"
import { fold } from "../normalize.js"
import type { AccountKey } from "../types.js"
import { dealOperationsOver } from "./deals.js"
import type { StoreContext } from "./open.js"
import { oneOf, refuse, text } from "./reviewed.js"
import { write } from "./transaction.js"

/** What a base set holds the first time it is used; the owner edits it from there. */
export const DEFAULT_BASE_STAGES: Record<DealKind, readonly { name: string; outcome: StageOutcome }[]> = {
  lead: [
    { name: "New", outcome: "open" },
    { name: "Contacted", outcome: "open" },
    { name: "Qualified", outcome: "open" },
    { name: "Converted", outcome: "won" },
    { name: "Rejected", outcome: "lost" },
  ],
  deal: [
    { name: "New", outcome: "open" },
    { name: "Qualification", outcome: "open" },
    { name: "Proposal", outcome: "open" },
    { name: "Negotiation", outcome: "open" },
    { name: "Won", outcome: "won" },
    { name: "Lost", outcome: "lost" },
  ],
}

const BASE_NAME = "Base stages"
const MAX_BASE_STAGES = 30

export const baseSettingKey = (kind: DealKind) => `stages.base.${kind}`

export interface StageName {
  /** `stage:<id>`: a stage of any pipeline, as these commands name it. */
  ref: string
  name: string
}

/** One column of a base set: the open deals or leads whose stage maps to it, and how many stages do. */
export interface BaseColumn extends StageName {
  position: number
  outcome: StageOutcome
  open: number
  /** Stages of other pipelines confirmed onto it. */
  mapped: number
}

export interface BaseSet {
  kind: DealKind
  /** The owner's own pipeline that holds the set. */
  pipeline: string
  stages: BaseColumn[]
  /** What no column holds yet: open rows whose stage is unmapped or only suggested, and those stages. */
  unsorted: { open: number; stages: number }
}

/** A stage of a pipeline outside the base set, and the base stage it maps to. */
export interface StageMapping extends StageName {
  position: number
  outcome: StageOutcome
  kind: DealKind
  pipeline: string
  pipelineName: string
  account: AccountKey | null
  /** Suggested or confirmed; `null` until the base set exists or when nothing fits. */
  baseStage: StageName | null
  confirmed: boolean
  open: number
}

export interface BaseScope {
  /** Only these CRM accounts' pipelines, with the owner's own; absent, every one. */
  accounts?: readonly AccountKey[]
}

export interface MappingFilter extends BaseScope {
  kind?: DealKind
  /** `pipeline:<id>`, or a name only one pipeline has. */
  pipeline?: string
  unconfirmed?: boolean
}

/** The base set of each kind, the mapping of every other pipeline's stages onto it, and moves by base stage. */
export interface BaseStagesStore {
  /** The set with its board counts; the first use makes the default set and suggests every stage's mapping. */
  show(kind: DealKind, scope?: BaseScope): Promise<BaseSet>
  /** Open stages go before the first won or lost one unless `position` says where. */
  add(kind: DealKind, input: { name: string; outcome?: StageOutcome; position?: number }): Promise<BaseSet>
  rename(kind: DealKind, stage: string, name: string): Promise<BaseSet>
  move(kind: DealKind, stage: string, position: number): Promise<BaseSet>
  /** Refused for the last stage of its outcome and for one the owner's own rows stand or stood in. */
  remove(kind: DealKind, stage: string): Promise<BaseSet>
  mappings(filter?: MappingFilter): Promise<StageMapping[]>
  /** Maps `stage:<id>` onto a base stage of its kind, confirmed. */
  map(stage: string, base: string, scope?: BaseScope): Promise<StageMapping>
  /** Confirms every suggestion of one pipeline, or of all of them in scope; answers how many. */
  confirm(target: { pipeline: string } | { all: true; kind?: DealKind }, scope?: BaseScope): Promise<number>
  /**
   * The stage of the row's own pipeline confirmed onto `base`. Refused with `stage.choice-required` and the candidates
   * when several are, and with `stage.unmapped` when none is.
   */
  resolve(
    item: string,
    base: string,
  ): Promise<{ stage: StageName & { externalId: string | null; outcome: StageOutcome } }>
}

type Row = Record<string, unknown>

const ITEM_TABLES = { deal: "deals", lead: "leads" } as const

const stageRef = (id: unknown) => `stage:${id}`

const storedPipeline = (value: unknown): number | undefined => {
  if (typeof value !== "string") return undefined
  const match = /^"pipeline:(\d+)"$/.exec(value)
  return match ? Number(match[1]) : undefined
}

/** The set's pipeline, while the setting names an own, live pipeline of the kind. */
const basePipelineOf = (database: CacheDatabase, kind: DealKind): number | undefined => {
  const id = storedPipeline(
    database.prepare("SELECT value FROM store_settings WHERE key = ?").get(baseSettingKey(kind))?.value,
  )
  if (id === undefined) return undefined
  const row = database
    .prepare("SELECT 1 FROM pipelines WHERE id = ? AND kind = ? AND account_id IS NULL AND deleted_at IS NULL")
    .get(id, kind)
  return row ? id : undefined
}

/** `(p.account_id IS NULL OR …)`: the owner's own pipelines pass, as a group lock lets them. */
const scopeSql = (scope: BaseScope | undefined, alias = "p") => {
  const accounts = scope?.accounts
  if (accounts === undefined) return { sql: "1", params: [] as string[] }
  if (accounts.length === 0) return { sql: `${alias}.account_id IS NULL`, params: [] as string[] }
  return {
    sql:
      `(${alias}.account_id IS NULL OR ${alias}.account_id IN (SELECT id FROM accounts WHERE ` +
      `${accounts.map(() => "(provider = ? AND external_id = ?)").join(" OR ")}))`,
    params: accounts.flatMap(({ provider, account }) => [provider, account]),
  }
}

const baseStagesOf = (database: CacheDatabase, pipeline: number): Row[] =>
  database.prepare("SELECT * FROM pipeline_stages WHERE pipeline_id = ? ORDER BY position, id").all(pipeline)

/**
 * Suggests a base stage for every unconfirmed live stage of `pipelines` (every CRM pipeline of the kind when absent): won and lost by outcome; an open one by its relative place among its pipeline's open stages, and when that
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
      .prepare("SELECT id FROM pipelines WHERE kind = ? AND account_id IS NOT NULL AND deleted_at IS NULL")
      .all(kind)
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

export const baseStagesOver = (context: StoreContext) => {
  const { database, now } = context
  const deals = dealOperationsOver(context)
  const kindOf = (kind: unknown): DealKind => oneOf(kind, DEAL_KINDS, "a kind")

  const freeName = (kind: DealKind) => {
    const taken = new Set(
      database
        .prepare("SELECT name_folded FROM pipelines WHERE kind = ? AND account_id IS NULL")
        .all(kind)
        .map((row) => String(row.name_folded)),
    )
    let name = BASE_NAME
    for (let suffix = 2; taken.has(fold(name)); suffix += 1) name = `${BASE_NAME} ${suffix}`
    return name
  }

  /**
   * The owner's only own pipeline of the kind, when it has every outcome: the store's own `Leads` is the lead set, so
   * a second own pipeline does not make a lead's first stage or a stage's name ambiguous.
   */
  const adoptable = (kind: DealKind): number | undefined => {
    const own = database
      .prepare("SELECT id FROM pipelines WHERE kind = ? AND account_id IS NULL AND deleted_at IS NULL")
      .all(kind)
    if (own.length !== 1) return undefined
    const id = Number(own[0]?.id)
    const outcomes = new Set(baseStagesOf(database, id).map((stage) => stage.outcome))
    return STAGE_OUTCOMES.every((outcome) => outcomes.has(outcome)) ? id : undefined
  }

  /** The set's pipeline, adopted or made with the defaults on first use; each base stage maps to itself, confirmed. */
  const ensure = (kind: DealKind): number => {
    const held = basePipelineOf(database, kind)
    if (held !== undefined) return held
    return write(database, () => {
      const at = now()
      let id = adoptable(kind)
      if (id === undefined) {
        const name = freeName(kind)
        id = Number(
          database
            .prepare(
              "INSERT INTO pipelines (kind, name, name_folded, created_at, updated_at) VALUES (?, ?, ?, ?, ?) RETURNING id",
            )
            .get(kind, name, fold(name), at, at)?.id,
        )
        for (const [index, stage] of DEFAULT_BASE_STAGES[kind].entries())
          insertStage(id, stage.name, stage.outcome, index + 1, at)
      } else
        database
          .prepare("UPDATE pipeline_stages SET base_stage_id = id, base_confirmed = 1 WHERE pipeline_id = ?")
          .run(id)
      database
        .prepare("INSERT OR REPLACE INTO store_settings (key, value, at) VALUES (?, ?, ?)")
        .run(baseSettingKey(kind), JSON.stringify(`pipeline:${id}`), at)
      suggestBaseStages(database, kind)
      return id
    })
  }

  const insertStage = (pipeline: number, name: string, outcome: StageOutcome, position: number, at: number) => {
    const id = Number(
      database
        .prepare(
          "INSERT INTO pipeline_stages (pipeline_id, name, name_folded, position, outcome, base_confirmed, created_at, " +
            "updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?) RETURNING id",
        )
        .get(pipeline, name, fold(name), position, outcome, at, at)?.id,
    )
    database.prepare("UPDATE pipeline_stages SET base_stage_id = id WHERE id = ?").run(id)
    return id
  }

  /** A base stage by `stage:<id>` or by its name, in any letter case. */
  const baseStageRow = (pipeline: number, given: string): Row => {
    const named = given.trim()
    const byRef = /^stage:(\d+)$/.exec(named)
    const row = byRef
      ? database
          .prepare("SELECT * FROM pipeline_stages WHERE id = ? AND pipeline_id = ?")
          .get(Number(byRef[1]), pipeline)
      : database
          .prepare("SELECT * FROM pipeline_stages WHERE pipeline_id = ? AND name_folded = ?")
          .get(pipeline, fold(named))
    if (!row)
      throw new CliError("not_found", `no base stage ${named}: ${stageNames(pipeline)}`, { reason: "stage.not-found" })
    return row
  }
  const stageNames = (pipeline: number) =>
    baseStagesOf(database, pipeline)
      .map((stage) => `${stage.name} (${stageRef(stage.id)})`)
      .join(", ")

  const nameOf = (value: unknown) =>
    text(value, "a stage's name", 80, "stage.base-field") ?? refuse("a stage needs a name", "stage.base-field")

  const unique = (pipeline: number, name: string, except?: number) => {
    const held = database
      .prepare("SELECT id FROM pipeline_stages WHERE pipeline_id = ? AND name_folded = ?")
      .get(pipeline, fold(name))
    if (held && Number(held.id) !== except) refuse(`the base set already has a stage named ${name}`, "stage.base-field")
  }

  /** Writes positions 1… in the given order, then suggests again: a moved column moves what lands on it. */
  const reorder = (kind: DealKind, ids: readonly number[]) => {
    const at = now()
    const set = database.prepare("UPDATE pipeline_stages SET position = ?, updated_at = ? WHERE id = ?")
    for (const [index, id] of ids.entries()) set.run(index + 1, at, id)
    suggestBaseStages(database, kind)
  }

  const positionOf = (value: unknown, most: number) => {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > most)
      return refuse(`a position is 1–${most}`, "stage.base-field")
    return value
  }

  const show = (kind: DealKind, scope?: BaseScope): BaseSet => {
    const pipeline = ensure(kindOf(kind))
    const { sql, params } = scopeSql(scope)
    const table = ITEM_TABLES[kind]
    const counted = database
      .prepare(
        "SELECT CASE WHEN s.base_confirmed = 1 THEN s.base_stage_id END AS base, " +
          `count(DISTINCT d.id) AS open FROM ${table} d JOIN pipeline_stages s ON s.id = d.stage_id ` +
          `JOIN pipelines p ON p.id = s.pipeline_id WHERE d.status = 'open' AND d.deleted_at IS NULL AND ${sql} ` +
          "GROUP BY base",
      )
      .all(...params)
    const mapped = database
      .prepare(
        "SELECT CASE WHEN s.base_confirmed = 1 THEN s.base_stage_id END AS base, count(*) AS stages " +
          "FROM pipeline_stages s JOIN pipelines p ON p.id = s.pipeline_id WHERE p.kind = ? AND p.account_id IS NOT NULL " +
          `AND s.deleted_at IS NULL AND p.deleted_at IS NULL AND ${sql} GROUP BY base`,
      )
      .all(kind, ...params)
    const countOf = (rows: Row[], base: unknown, field: string) =>
      Number(rows.find((row) => (row.base ?? null) === (base ?? null))?.[field] ?? 0)
    return {
      kind,
      pipeline: `pipeline:${pipeline}`,
      stages: baseStagesOf(database, pipeline).map((stage) => ({
        ref: stageRef(stage.id),
        name: String(stage.name),
        position: Number(stage.position),
        outcome: stage.outcome as StageOutcome,
        open: countOf(counted, stage.id, "open"),
        mapped: countOf(mapped, stage.id, "stages"),
      })),
      unsorted: { open: countOf(counted, null, "open"), stages: countOf(mapped, null, "stages") },
    }
  }

  const mappingSql =
    "SELECT s.*, p.name AS pipeline_name, p.kind, a.provider AS account_provider, a.external_id AS account_external_id, " +
    "b.id AS base_id, b.name AS base_name, (SELECT count(*) FROM deals d WHERE d.stage_id = s.id AND " +
    "d.status = 'open' AND d.deleted_at IS NULL) + (SELECT count(*) FROM leads l WHERE l.stage_id = s.id AND " +
    "l.status = 'open' AND l.deleted_at IS NULL) AS open FROM pipeline_stages s JOIN pipelines p ON p.id = s.pipeline_id " +
    "LEFT JOIN accounts a ON a.id = p.account_id LEFT JOIN pipeline_stages b ON b.id = s.base_stage_id"

  const mappingOf = (row: Row): StageMapping => ({
    ref: stageRef(row.id),
    name: String(row.name),
    position: Number(row.position),
    outcome: row.outcome as StageOutcome,
    kind: row.kind as DealKind,
    pipeline: `pipeline:${row.pipeline_id}`,
    pipelineName: String(row.pipeline_name),
    account:
      row.account_provider == null
        ? null
        : { provider: String(row.account_provider), account: String(row.account_external_id) },
    baseStage: row.base_id == null ? null : { ref: stageRef(row.base_id), name: String(row.base_name) },
    confirmed: Number(row.base_confirmed) === 1,
    open: Number(row.open),
  })

  /** Live stages of CRM pipelines in scope: what the owner maps. */
  const mappableRows = (filter: MappingFilter, extra = "1", extraParams: number[] = []): Row[] => {
    const kinds = filter.kind === undefined ? DEAL_KINDS : [kindOf(filter.kind)]
    const pipeline =
      filter.pipeline === undefined
        ? null
        : Number(deals.pipeline(filter.pipeline, filter.kind === undefined ? {} : { kind: filter.kind }).id)
    const { sql, params } = scopeSql(filter)
    return database
      .prepare(
        `${mappingSql} WHERE p.kind IN (${kinds.map(() => "?").join(", ")}) ` +
          "AND p.account_id IS NOT NULL AND s.deleted_at IS NULL AND p.deleted_at IS NULL " +
          `AND (? IS NULL OR p.id = ?) AND (? = 0 OR s.base_confirmed = 0) AND ${sql} AND ${extra} ` +
          "ORDER BY p.kind, p.name_folded, p.id, s.position, s.id",
      )
      .all(...kinds, pipeline, pipeline, filter.unconfirmed ? 1 : 0, ...params, ...extraParams)
  }

  return {
    show,
    add: (kind: DealKind, input: { name: string; outcome?: StageOutcome; position?: number }): BaseSet => {
      const chosen = kindOf(kind)
      const name = nameOf(input.name)
      const outcome = input.outcome === undefined ? "open" : oneOf(input.outcome, STAGE_OUTCOMES, "a stage's outcome")
      write(database, () => {
        const pipeline = ensure(chosen)
        unique(pipeline, name)
        const ids = baseStagesOf(database, pipeline).map((stage) => ({ id: Number(stage.id), outcome: stage.outcome }))
        if (ids.length >= MAX_BASE_STAGES)
          refuse(`a base set has at most ${MAX_BASE_STAGES} stages`, "stage.base-field")
        const firstEnd = ids.findIndex((stage) => stage.outcome !== "open")
        const index =
          input.position === undefined
            ? outcome === "open" && firstEnd !== -1
              ? firstEnd
              : ids.length
            : positionOf(input.position, ids.length + 1) - 1
        const id = insertStage(pipeline, name, outcome, ids.length + 1, now())
        const order = ids.map((stage) => stage.id)
        order.splice(index, 0, id)
        reorder(chosen, order)
      })
      return show(chosen)
    },
    rename: (kind: DealKind, stage: string, name: string): BaseSet => {
      const chosen = kindOf(kind)
      const named = nameOf(name)
      write(database, () => {
        const pipeline = ensure(chosen)
        const row = baseStageRow(pipeline, stage)
        unique(pipeline, named, Number(row.id))
        database
          .prepare("UPDATE pipeline_stages SET name = ?, name_folded = ?, updated_at = ? WHERE id = ?")
          .run(named, fold(named), now(), Number(row.id))
      })
      return show(chosen)
    },
    move: (kind: DealKind, stage: string, position: number): BaseSet => {
      const chosen = kindOf(kind)
      write(database, () => {
        const pipeline = ensure(chosen)
        const id = Number(baseStageRow(pipeline, stage).id)
        const order = baseStagesOf(database, pipeline)
          .map((one) => Number(one.id))
          .filter((one) => one !== id)
        order.splice(positionOf(position, order.length + 1) - 1, 0, id)
        reorder(chosen, order)
      })
      return show(chosen)
    },
    remove: (kind: DealKind, stage: string): BaseSet => {
      const chosen = kindOf(kind)
      write(database, () => {
        const pipeline = ensure(chosen)
        const row = baseStageRow(pipeline, stage)
        const id = Number(row.id)
        const same = baseStagesOf(database, pipeline).filter((one) => one.outcome === row.outcome)
        if (same.length === 1)
          refuse(`${row.name} is the base set's only ${row.outcome} stage; add another first`, "stage.base-outcome")
        const used = database
          .prepare(
            `SELECT (SELECT count(*) FROM ${ITEM_TABLES[chosen]} WHERE stage_id = ?) + ` +
              "(SELECT count(*) FROM pipeline_stage_changes WHERE from_stage_id = ? OR to_stage_id = ?) AS n",
          )
          .get(id, id, id)
        if (Number(used?.n) > 0)
          refuse(`the owner's own ${chosen}s stand or stood in ${row.name}; it stays`, "stage.base-in-use")
        database
          .prepare("UPDATE pipeline_stages SET base_stage_id = NULL, base_confirmed = 0 WHERE base_stage_id = ?")
          .run(id)
        database.prepare("DELETE FROM pipeline_stages WHERE id = ?").run(id)
        reorder(
          chosen,
          baseStagesOf(database, pipeline).map((one) => Number(one.id)),
        )
      })
      return show(chosen)
    },
    mappings: (filter: MappingFilter = {}): StageMapping[] => mappableRows(filter).map(mappingOf),
    map: (stage: string, base: string, scope?: BaseScope): StageMapping => {
      const id = /^stage:(\d+)$/.exec(stage.trim())?.[1]
      if (id === undefined)
        refuse(`a stage is named by its stage:<id> reference, as stages map list shows it; not ${stage}`, "stage.ref")
      const kindRow = database
        .prepare("SELECT p.kind FROM pipeline_stages s JOIN pipelines p ON p.id = s.pipeline_id WHERE s.id = ?")
        .get(Number(id))
      if (!kindRow) throw new CliError("not_found", `no stage ${stage}`, { reason: "stage.not-found" })
      const kind = kindRow.kind as DealKind
      return write(database, () => {
        const pipeline = ensure(kind)
        const row = mappableRows({ ...scope, kind }, "s.id = ?", [Number(id)])[0]
        if (!row)
          throw new CliError(
            "not_found",
            `${stage} is not a stage to map: a base stage, a deleted one or out of scope`,
            {
              reason: "stage.not-found",
            },
          )
        const target = baseStageRow(pipeline, base)
        database
          .prepare("UPDATE pipeline_stages SET base_stage_id = ?, base_confirmed = 1, updated_at = ? WHERE id = ?")
          .run(Number(target.id), now(), Number(id))
        return mappingOf(mappableRows({ kind }, "s.id = ?", [Number(id)])[0] as Row)
      })
    },
    confirm: (target: { pipeline: string } | { all: true; kind?: DealKind }, scope?: BaseScope): number =>
      write(database, () => {
        const filter: MappingFilter =
          "pipeline" in target
            ? { ...scope, pipeline: target.pipeline, unconfirmed: true }
            : { ...scope, ...(target.kind === undefined ? {} : { kind: target.kind }), unconfirmed: true }
        for (const kind of filter.kind === undefined ? DEAL_KINDS : [filter.kind]) ensure(kind)
        const rows = mappableRows(filter).filter((row) => row.base_id != null)
        const set = database.prepare("UPDATE pipeline_stages SET base_confirmed = 1, updated_at = ? WHERE id = ?")
        const at = now()
        for (const row of rows) set.run(at, Number(row.id))
        return rows.length
      }),
    resolve: (item: string, base: string) => {
      const found = deals.get(item)
      const pipeline = Number(found.pipeline.slice("pipeline:".length))
      const target = baseStageRow(ensure(found.kind), base)
      const candidates = database
        .prepare(
          "SELECT * FROM pipeline_stages WHERE pipeline_id = ? AND base_confirmed = 1 AND base_stage_id = ? " +
            "AND deleted_at IS NULL ORDER BY position, id",
        )
        .all(pipeline, Number(target.id))
        .map((row) => ({
          ref: stageRef(row.id),
          name: String(row.name),
          externalId: row.external_id == null ? null : String(row.external_id),
          outcome: row.outcome as StageOutcome,
        }))
      if (candidates.length === 1) return { stage: candidates[0] as (typeof candidates)[number] }
      if (candidates.length > 1)
        throw new CliError(
          "validation_error",
          `more than one stage of ${found.pipelineName} maps to ${target.name}: ` +
            `${candidates.map(({ name, ref }) => `${name} (${ref})`).join(", ")}; move to one of them by name`,
          {
            reason: "stage.choice-required",
            candidates: candidates.map(({ ref, name, externalId, outcome }) => ({
              ref,
              name,
              external_id: externalId,
              outcome,
            })),
          },
        )
      throw new CliError(
        "validation_error",
        `no stage of ${found.pipelineName} (${found.pipeline}) is mapped to ${target.name}; map one with ` +
          `\`stages map set <stage:id> ${stageRef(target.id)}\` (the stages: \`stages map list --pipeline ${found.pipeline}\`)`,
        { reason: "stage.unmapped" },
      )
    },
  }
}

export const baseStagesStoreOver = (context: StoreContext): BaseStagesStore => {
  const operations = baseStagesOver(context)
  return {
    show: async (kind, scope) => operations.show(kind, scope),
    add: async (kind, input) => operations.add(kind, input),
    rename: async (kind, stage, name) => operations.rename(kind, stage, name),
    move: async (kind, stage, position) => operations.move(kind, stage, position),
    remove: async (kind, stage) => operations.remove(kind, stage),
    mappings: async (filter) => operations.mappings(filter),
    map: async (stage, base, scope) => operations.map(stage, base, scope),
    confirm: async (target, scope) => operations.confirm(target, scope),
    resolve: async (item, base) => operations.resolve(item, base),
  }
}
