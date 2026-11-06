import { CliError } from "@wirecat/cli-base"
import {
  DEAL_KINDS,
  DEAL_ROLES,
  DEAL_STATUSES,
  type DealKind,
  type DealRole,
  type DealStatus,
  dealLine,
  STAGE_OUTCOMES,
  type StageOutcome,
} from "../../domain/deals.js"
import { currencyOf, formatDecimal, minorUnits, scaleOf } from "../../domain/money.js"
import { fold } from "../normalize.js"
import type { AccountKey } from "../types.js"
import { type ProposedByFilter, proposedBySql } from "./actors.js"
import { isoDate, oneOf, type Party, refuse, reviewedRowsOver, text } from "./finance.js"
import { linkKind } from "./link-kinds.js"
import { type Author, authorActor, authorOf, evidenceOf, linkEvidence, projectId, projectOf } from "./memories.js"
import { requiredThing } from "./notes.js"
import type { StoreContext } from "./open.js"
import { write } from "./transaction.js"

export interface PipelineStage {
  name: string
  position: number
  outcome: StageOutcome
  externalId: string | null
  /** Open deals or leads standing in it now. */
  open: number
}

export interface Pipeline {
  id: string
  ref: string
  name: string
  kind: DealKind
  /** The CRM account it was copied from; `null` for the owner's or an agent's own. */
  account: { provider: string; account: string } | null
  externalId: string | null
  stages: PipelineStage[]
  createdAt: string
}

export interface FunnelStage extends PipelineStage {
  /** Rows that got this far: entered this stage or a later one that is not lost, or were won. */
  reached: number
  /** `reached` of the next stage that is not lost over this stage's, 0–1; `null` for the last or an empty one. */
  conversion: number | null
}

/** A pipeline with its funnel, counted from `pipeline_stage_changes`. */
export interface PipelineReport extends Omit<Pipeline, "stages"> {
  stages: FunnelStage[]
  totals: { items: number; open: number; won: number; lost: number; winRate: number | null }
  /** `YYYY-MM-DD`: only rows made since that day are counted; `null` for all. */
  since: string | null
}

export interface DealPerson extends Party {
  role: DealRole
}

export interface Deal {
  id: string
  ref: string
  kind: DealKind
  title: string
  /** One line with stage, amount and status, as a list prints it. */
  summary: string
  pipeline: string
  pipelineName: string
  stage: string
  status: DealStatus
  organization: Party | null
  /** Both `null` when no amount is expected yet. */
  currency: string | null
  amount: string | null
  /** `YYYY-MM-DD`: the day it is expected to close. */
  closeDate: string | null
  /** `YYYY-MM-DD`: the day it was won or lost. */
  closedDate: string | null
  /** Why it was won or lost, as given when closing it. */
  closedReason: string | null
  rank: number | null
  /** A lead's deal, once it became one. */
  deal: string | null
  account: { provider: string; account: string } | null
  externalId: string | null
  people: DealPerson[]
  author: { type: "person" | "bot"; id: string; name: string | null; kind: "agent" | "rule" | null }
  model: string | null
  source: string
  reason: string | null
  evidence: string[]
  project: string | null
  projectName: string | null
  createdAt: string
  updatedAt: string
}

export interface DealInput {
  /** Who writes it; the owner and an agent write alike, and only the author is kept. */
  by: Author
  /** `deal` when left out. */
  kind?: DealKind
  title: string
  /**
   * A stage's name, in `pipeline` when given, else in the only pipeline of the kind that has it. A lead may leave it
   * out when there is one lead pipeline: it starts in that pipeline's first stage.
   */
  stage?: string
  /** `pipeline:<id>`, or a name only one pipeline of the kind has. */
  pipeline?: string
  organization?: string
  /** A decimal string in `currency`; give both or neither. */
  amount?: string
  currency?: string
  closeDate?: string
  people?: { person: string; role: DealRole }[]
  project?: string
  /** Where an agent's row came from, such as `agent`; the owner's is always `owner`. */
  source?: string
  reason?: string
  evidence?: string[]
}

export interface DealFilter {
  /** `deal` when left out. */
  kind?: DealKind
  status?: DealStatus
  /** A stage's name, in any letter case. */
  stage?: string
  /** `pipeline:<id>`, or a name only one pipeline of the kind has. */
  pipeline?: string
  project?: string
  organization?: string
  proposedBy?: ProposedByFilter
  /** 1–500, 100 by default; newest written first. */
  limit?: number
}

export interface DealSearch {
  /** Words of the title, each in any letter case; a word may be a phrase. */
  words: string[]
  /** A title holding any of the words matches, those holding more first; otherwise every word is needed. */
  anyWord?: boolean
  /** Only the copies of these CRM accounts; absent, every account's and the owner's own. */
  accounts?: AccountKey[]
  /** 1–500, 100 by default. */
  limit?: number
}

export interface PipelineInput {
  name: string
  /** `deal` when left out. */
  kind?: DealKind
  /** In order; a bare name is an open stage. */
  stages: (string | { name: string; outcome?: StageOutcome })[]
  by: Author
}

/**
 * Sales pipelines and the deals and leads in them. The owner and his agents write alike: nothing waits for review,
 * and memo's permission settings are where writes are limited. Every stage a row enters is kept, by triggers, so a
 * pipeline's report counts conversion between stages.
 */
export interface DealsStore {
  addPipeline(input: PipelineInput): Promise<Pipeline>
  pipelines(filter?: { kind?: DealKind }): Promise<Pipeline[]>
  /** One pipeline by `pipeline:<id>` or a name only one pipeline has, with its funnel. */
  pipeline(reference: string, options?: { kind?: DealKind; since?: string }): Promise<PipelineReport>
  add(input: DealInput): Promise<Deal>
  /** `deal:<id>` or `lead:<id>`; a bare id is a deal. */
  get(reference: string): Promise<Deal>
  list(filter?: DealFilter): Promise<Deal[]>
  /** Deals and leads together, by the words of their title: the most words matched first, then the latest changed. */
  find(search: DealSearch): Promise<Deal[]>
  /** To another stage of its own pipeline; a stage whose outcome is won or lost closes it, an open one reopens it. */
  move(reference: string, input: { stage: string; by: Author }): Promise<Deal>
  /** Won or lost, on `date` (today when left out); it moves to its pipeline's stage of that outcome when there is one. */
  close(
    reference: string,
    input: { status: Exclude<DealStatus, "open">; date?: string; reason?: string; by: Author },
  ): Promise<Deal>
}

type Row = Record<string, unknown>

const TABLES = { deal: "deals", lead: "leads" } as const

const itemsSql = (kind: DealKind) =>
  "SELECT d.*, s.name AS stage_name, s.pipeline_id, p.name AS pipeline_name, b.name AS author_name, " +
  "b.kind AS author_kind, a.provider AS account_provider, a.external_id AS account_external_id " +
  `FROM ${TABLES[kind]} d JOIN pipeline_stages s ON s.id = d.stage_id JOIN pipelines p ON p.id = s.pipeline_id ` +
  "LEFT JOIN bots b ON d.author_type = 'bot' AND b.id = d.author_id LEFT JOIN accounts a ON a.id = d.account_id"

const MAX_STAGES = 30
const MAX_PEOPLE = 20

const iso = (value: unknown) => new Date(Number(value)).toISOString()

const jsonField = (metadata: unknown, key: string): string | null => {
  if (metadata == null) return null
  try {
    const value = (JSON.parse(String(metadata)) as Record<string, unknown>)[key]
    return typeof value === "string" ? value : null
  } catch {
    return null
  }
}

const accountOf = (provider: unknown, external: unknown) =>
  provider == null ? null : { provider: String(provider), account: String(external) }

export const dealOperationsOver = (context: StoreContext) => {
  const { database, now } = context
  const { partyOf, partyThing } = reviewedRowsOver(context)
  const today = () => new Date(now()).toISOString().slice(0, 10)

  const peopleOf = (kind: DealKind, id: number): DealPerson[] =>
    database
      .prepare(
        `SELECT to_id, role FROM links WHERE from_type = ? AND from_id = ? AND kind = ${linkKind("related-to")} ` +
          "AND to_type = 'person' AND to_id IS NOT NULL ORDER BY id",
      )
      .all(kind, id)
      .map((row) => ({ ...(partyOf("person", row.to_id) as Party), role: row.role as DealRole }))

  const itemOf =
    (kind: DealKind) =>
    (row: Row): Deal => {
      const currency = row.currency == null ? null : String(row.currency)
      const amount = row.amount == null || currency === null ? null : Number(row.amount)
      const fields = {
        id: Number(row.id),
        title: String(row.title),
        stage: String(row.stage_name),
        amount,
        currency,
        status: row.status as DealStatus,
      }
      return {
        id: String(row.id),
        ref: `${kind}:${row.id}`,
        kind,
        title: fields.title,
        summary: dealLine(fields),
        pipeline: `pipeline:${row.pipeline_id}`,
        pipelineName: String(row.pipeline_name),
        stage: fields.stage,
        status: fields.status,
        organization: partyOf(row.organization_id == null ? null : "organization", row.organization_id),
        currency,
        amount: amount === null || currency === null ? null : formatDecimal(amount, scaleOf(currency)),
        closeDate: row.close_date == null ? null : String(row.close_date),
        closedDate: row.closed_date == null ? null : String(row.closed_date),
        closedReason: jsonField(row.metadata, "closed_reason"),
        rank: row.rank == null ? null : Number(row.rank),
        deal: row.deal_id == null ? null : `deal:${row.deal_id}`,
        account: accountOf(row.account_provider, row.account_external_id),
        externalId: row.external_id == null ? null : String(row.external_id),
        people: peopleOf(kind, fields.id),
        author: authorOf(row),
        model: row.model == null ? null : String(row.model),
        source: String(row.source),
        reason: jsonField(row.metadata, "reason"),
        evidence: evidenceOf(context, { type: kind, id: fields.id }),
        ...projectOf(database, row),
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
      }
    }

  const rowOf = (reference: string): { kind: DealKind; row: Row } => {
    const thing = requiredThing(database, reference.includes(":") ? reference : `deal:${reference}`, "the deal")
    if (thing.type !== "deal" && thing.type !== "lead")
      return refuse(`${reference} is not a deal or a lead`, "deal.ref")
    return { kind: thing.type, row: database.prepare(`${itemsSql(thing.type)} WHERE d.id = ?`).get(thing.id) as Row }
  }
  const read = (reference: string) => {
    const { kind, row } = rowOf(reference)
    return itemOf(kind)(row)
  }

  const kindOf = (kind: unknown): DealKind => (kind === undefined ? "deal" : oneOf(kind, DEAL_KINDS, "a kind"))

  const pipelineRows = (kind: DealKind | undefined) =>
    database
      .prepare(
        "SELECT p.*, a.provider AS account_provider, a.external_id AS account_external_id FROM pipelines p " +
          "LEFT JOIN accounts a ON a.id = p.account_id WHERE (? IS NULL OR p.kind = ?) ORDER BY p.name_folded, p.id",
      )
      .all(kind ?? null, kind ?? null)

  const label = (row: Row) =>
    `pipeline:${row.id} (${row.name}${row.account_provider == null ? "" : `, ${row.account_provider}:${row.account_external_id}`})`

  /** A pipeline by `pipeline:<id>`, or by a name only one pipeline of the kind has; never a guess. */
  const pipelineRow = (reference: string, kind: DealKind | undefined): Row => {
    const named = reference.trim()
    if (/^pipeline:\d+$/.test(named)) {
      const row = pipelineRows(kind).find((one) => `pipeline:${one.id}` === named)
      if (!row) throw new CliError("not_found", `no ${kind ?? ""} pipeline ${named}`, { reason: "pipeline.not-found" })
      return row
    }
    const rows = pipelineRows(kind).filter((one) => one.name_folded === fold(named))
    if (rows.length === 0)
      throw new CliError("not_found", `no ${kind === undefined ? "" : `${kind} `}pipeline named ${named}`, {
        reason: "pipeline.not-found",
      })
    if (rows.length > 1)
      return refuse(
        `more than one pipeline is named ${named}: ${rows.map(label).join(", ")}; name one by its reference`,
        "pipeline.ambiguous",
      )
    return rows[0] as Row
  }

  const stagesOf = (pipelineIds: number[]) =>
    database
      .prepare(
        "SELECT s.*, (SELECT count(*) FROM deals d WHERE d.stage_id = s.id AND d.status = 'open' AND d.deleted_at IS NULL) + " +
          "(SELECT count(*) FROM leads l WHERE l.stage_id = s.id AND l.status = 'open' AND l.deleted_at IS NULL) AS open " +
          `FROM pipeline_stages s WHERE s.pipeline_id IN (${pipelineIds.map(() => "?").join(", ") || "NULL"}) ` +
          "ORDER BY s.pipeline_id, s.position, s.id",
      )
      .all(...pipelineIds)

  const pipelinesOf = (rows: Row[]): Pipeline[] => {
    const stages = stagesOf(rows.map((row) => Number(row.id)))
    return rows.map((row) => ({
      id: String(row.id),
      ref: `pipeline:${row.id}`,
      name: String(row.name),
      kind: row.kind as DealKind,
      account: accountOf(row.account_provider, row.account_external_id),
      externalId: row.external_id == null ? null : String(row.external_id),
      stages: stages
        .filter((stage) => stage.pipeline_id === row.id)
        .map((stage) => ({
          name: String(stage.name),
          position: Number(stage.position),
          outcome: stage.outcome as StageOutcome,
          externalId: stage.external_id == null ? null : String(stage.external_id),
          open: Number(stage.open),
        })),
      createdAt: iso(row.created_at),
    }))
  }

  /** A stage by name in one pipeline, or in the only pipeline of the kind that has one of that name. */
  const stageRow = (stage: string, kind: DealKind, pipeline: number | undefined): Row => {
    const rows = database
      .prepare(
        "SELECT s.*, p.name AS pipeline_name FROM pipeline_stages s JOIN pipelines p ON p.id = s.pipeline_id " +
          "WHERE s.name_folded = ? AND p.kind = ? AND (? IS NULL OR p.id = ?) ORDER BY p.id",
      )
      .all(fold(stage.trim()), kind, pipeline ?? null, pipeline ?? null)
    if (rows.length === 0)
      return refuse(
        `no stage named ${stage} in ${pipeline === undefined ? `a ${kind} pipeline` : "that pipeline"}`,
        "deal.stage",
      )
    if (rows.length > 1)
      return refuse(
        `more than one pipeline has a stage named ${stage}: ${rows.map((row) => `pipeline:${row.pipeline_id} (${row.pipeline_name})`).join(", ")}; name the pipeline`,
        "deal.stage",
      )
    return rows[0] as Row
  }

  const firstStage = (kind: DealKind, pipeline: number | undefined): Row => {
    const pipelines = pipeline === undefined ? pipelineRows(kind) : [{ id: pipeline }]
    if (pipelines.length !== 1)
      return refuse(
        `name the stage: ${pipelines.length === 0 ? `no ${kind} pipeline is stored` : `more than one ${kind} pipeline is stored`}`,
        "deal.stage",
      )
    const row = database
      .prepare("SELECT * FROM pipeline_stages WHERE pipeline_id = ? ORDER BY position, id LIMIT 1")
      .get(Number(pipelines[0]?.id))
    return row ?? refuse("the pipeline has no stages", "deal.stage")
  }

  const funnelOf = (pipeline: Pipeline, since: string | null): PipelineReport => {
    const kind = pipeline.kind
    const cutoff = since === null ? null : Date.parse(`${since}T00:00:00Z`)
    const items = database
      .prepare(
        `SELECT d.id, d.status, d.stage_id FROM ${TABLES[kind]} d JOIN pipeline_stages s ON s.id = d.stage_id ` +
          "WHERE s.pipeline_id = ? AND d.deleted_at IS NULL AND (? IS NULL OR d.created_at >= ?)",
      )
      .all(Number(pipeline.id), cutoff, cutoff)
    const stages = database
      .prepare("SELECT id, position, outcome FROM pipeline_stages WHERE pipeline_id = ? ORDER BY position, id")
      .all(Number(pipeline.id))
    const order = new Map(stages.map((stage, at) => [Number(stage.id), at]))
    const lostStage = new Set(stages.filter((stage) => stage.outcome === "lost").map((stage) => Number(stage.id)))
    const entered = new Map<number, number[]>()
    for (const change of database
      .prepare("SELECT item_id, to_stage_id FROM pipeline_stage_changes WHERE item_type = ? AND pipeline_id = ?")
      .all(kind, Number(pipeline.id))) {
      const list = entered.get(Number(change.item_id)) ?? []
      list.push(Number(change.to_stage_id))
      entered.set(Number(change.item_id), list)
    }
    const furthest = items.map((item) => {
      if (item.status === "won") return Number.POSITIVE_INFINITY
      const reached = [...(entered.get(Number(item.id)) ?? []), Number(item.stage_id)]
        .filter((stage) => !lostStage.has(stage))
        .map((stage) => order.get(stage) ?? -1)
      return Math.max(-1, ...reached)
    })
    const lost = items.filter((item) => item.status === "lost").length
    const reachedAt = (at: number) =>
      lostStage.has(Number(stages[at]?.id)) ? lost : furthest.filter((far) => far >= at).length
    const funnel = pipeline.stages.map((stage, at) => {
      const reached = reachedAt(at)
      const next = stages.findIndex((one, after) => after > at && !lostStage.has(Number(one.id)))
      const conversion =
        lostStage.has(Number(stages[at]?.id)) || next === -1 || reached === 0
          ? null
          : Math.round((reachedAt(next) / reached) * 1000) / 1000
      return { ...stage, reached, conversion }
    })
    const won = items.filter((item) => item.status === "won").length
    return {
      ...pipeline,
      stages: funnel,
      totals: {
        items: items.length,
        open: items.length - won - lost,
        won,
        lost,
        winRate: won + lost === 0 ? null : Math.round((won / (won + lost)) * 1000) / 1000,
      },
      since,
    }
  }

  /** Sets the stage and, from its outcome, the status; a stage that ends the row closes it today. */
  const setStage = (kind: DealKind, id: number, stage: Row, status: DealStatus, date: string | null) => {
    database
      .prepare(`UPDATE ${TABLES[kind]} SET stage_id = ?, status = ?, closed_date = ?, updated_at = ? WHERE id = ?`)
      .run(Number(stage.id), status, status === "open" ? null : date, now(), id)
  }

  const notDeleted = (row: Row, kind: DealKind, what: string) => {
    if (row.deleted_at != null) refuse(`${kind}:${row.id} is deleted; it no longer ${what}`, "deal.closed")
  }

  return {
    addPipeline: ({ name, kind, stages, by }: PipelineInput): Pipeline => {
      const pipelineKind = kindOf(kind)
      const named = text(name, "a pipeline's name", 80) ?? refuse("a pipeline needs a name", "pipeline.field")
      if (!Array.isArray(stages) || stages.length === 0 || stages.length > MAX_STAGES)
        refuse(`a pipeline has 1–${MAX_STAGES} stages`, "pipeline.field")
      const kept = stages.map((stage) => {
        const one = typeof stage === "string" ? { name: stage } : stage
        return {
          name: text(one.name, "a stage's name", 80) as string,
          outcome: one.outcome === undefined ? "open" : oneOf(one.outcome, STAGE_OUTCOMES, "a stage's outcome"),
        }
      })
      if (new Set(kept.map((stage) => fold(stage.name))).size !== kept.length)
        refuse("each stage is named once", "pipeline.field")
      authorActor(context, by)
      const id = write(database, () => {
        if (
          database
            .prepare("SELECT 1 FROM pipelines WHERE name_folded = ? AND kind = ? AND account_id IS NULL")
            .get(fold(named), pipelineKind)
        )
          refuse(`a ${pipelineKind} pipeline named ${named} is already stored`, "pipeline.duplicate")
        const at = now()
        const made = Number(
          database
            .prepare(
              "INSERT INTO pipelines (kind, name, name_folded, created_at, updated_at) VALUES (?, ?, ?, ?, ?) RETURNING id",
            )
            .get(pipelineKind, named, fold(named), at, at)?.id,
        )
        const insert = database.prepare(
          "INSERT INTO pipeline_stages (pipeline_id, name, name_folded, position, outcome, created_at, updated_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        kept.forEach((stage, index) => {
          insert.run(made, stage.name, fold(stage.name), index + 1, stage.outcome, at, at)
        })
        return made
      })
      return pipelinesOf(pipelineRows(pipelineKind).filter((row) => Number(row.id) === id))[0] as Pipeline
    },
    pipelines: (filter: { kind?: DealKind } = {}): Pipeline[] =>
      pipelinesOf(pipelineRows(filter.kind === undefined ? undefined : kindOf(filter.kind))),
    pipeline: (reference: string, options: { kind?: DealKind; since?: string } = {}): PipelineReport => {
      const kind = options.kind === undefined ? undefined : kindOf(options.kind)
      const since = isoDate(options.since, "the first day counted")
      return funnelOf(pipelinesOf([pipelineRow(reference, kind)])[0] as Pipeline, since)
    },
    add: (input: DealInput): Deal => {
      const kind = kindOf(input.kind)
      const title = text(input.title, `a ${kind}'s title`, 200) ?? refuse(`a ${kind} needs a title`, "deal.field")
      if ((input.amount === undefined) !== (input.currency === undefined))
        refuse("an amount and its currency come together", "deal.field")
      const currency = input.currency === undefined ? null : currencyOf(input.currency)
      const amount = currency === null ? null : minorUnits(input.amount as string, currency, "an amount")
      if (amount !== null && amount < 0) refuse("an amount is 0 or more", "money.amount")
      const closeDate = isoDate(input.closeDate, "an expected close day")
      const people = input.people ?? []
      if (people.length > MAX_PEOPLE) refuse(`at most ${MAX_PEOPLE} people`, "deal.field")
      const owner = input.by === "owner"
      const source = owner ? "owner" : (text(input.source, "a source", 80) ?? "agent")
      const reason = text(input.reason, "a reason", 2000)
      const evidence = input.evidence ?? []
      if (!Array.isArray(evidence) || evidence.length > 8) refuse("evidence is at most 8 references", "deal.field")
      const id = write(database, () => {
        const pipeline = input.pipeline === undefined ? undefined : Number(pipelineRow(input.pipeline, kind).id)
        const stageText = text(input.stage, "a stage's name", 80)
        const stage =
          stageText === null
            ? kind === "lead"
              ? firstStage(kind, pipeline)
              : refuse("a deal starts in a stage", "deal.field")
            : stageRow(stageText, kind, pipeline)
        const status: DealStatus = (stage.outcome as StageOutcome) ?? "open"
        const organization = partyThing(input.organization, "the organization")
        if (organization !== undefined && organization.type !== "organization")
          refuse(`the organization is an organization: reference, not ${input.organization}`, "deal.field")
        const persons = people.map(({ person, role }) => {
          const thing = requiredThing(database, person, "the person")
          if (thing.type !== "person") return refuse(`${person} is not a person`, "deal.field")
          return { id: thing.id, role: oneOf(role, DEAL_ROLES, "a person's role") }
        })
        const { actor, model } = authorActor(context, input.by)
        const at = now()
        const made = Number(
          database
            .prepare(
              `INSERT INTO ${TABLES[kind]} (title, organization_id, project_id, stage_id, status, currency, amount, ` +
                "close_date, closed_date, author_type, author_id, model, source, metadata, created_at, updated_at) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
            )
            .get(
              title,
              organization?.id ?? null,
              input.project === undefined ? null : projectId(database, input.project),
              Number(stage.id),
              status,
              currency,
              amount,
              closeDate,
              status === "open" ? null : today(),
              actor.type,
              actor.id,
              model,
              source,
              reason === null ? null : JSON.stringify({ reason }),
              at,
              at,
            )?.id,
        )
        const link = database.prepare(
          "INSERT INTO links (from_type, from_id, to_type, to_id, kind, role, source, confirmed, created_at, author, " +
            `updated_at) VALUES (?, ?, 'person', ?, ${linkKind("related-to")}, ?, ?, 1, ?, ?, ?)`,
        )
        for (const person of persons)
          link.run(kind, made, person.id, person.role, owner ? "owner" : "suggested", at, owner ? "owner" : "agent", at)
        if (evidence.length) linkEvidence(context, { type: kind, id: made }, evidence, owner ? "owner" : "agent")
        return made
      })
      return read(`${kind}:${id}`)
    },
    get: (reference: string): Deal => read(reference),
    list: (filter: DealFilter = {}): Deal[] => {
      const kind = kindOf(filter.kind)
      const project = filter.project === undefined ? null : projectId(database, filter.project)
      const organization = partyThing(filter.organization, "the organization")
      const by = proposedBySql("d.author_type", "d.author_id", filter.proposedBy)
      const status = filter.status === undefined ? null : oneOf(filter.status, DEAL_STATUSES, "a status")
      const stage = filter.stage === undefined ? null : fold(filter.stage.trim())
      const pipeline = filter.pipeline === undefined ? null : Number(pipelineRow(filter.pipeline, kind).id)
      const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500)
      return database
        .prepare(
          `${itemsSql(kind)} WHERE d.deleted_at IS NULL AND (? IS NULL OR d.status = ?) ` +
            "AND (? IS NULL OR d.project_id = ?) AND (? IS NULL OR s.name_folded = ?) AND (? IS NULL OR p.id = ?) " +
            `AND (? IS NULL OR d.organization_id = ?) AND ${by.sql} ORDER BY d.created_at DESC, d.id DESC LIMIT ?`,
        )
        .all(
          status,
          status,
          project,
          project,
          stage,
          stage,
          pipeline,
          pipeline,
          organization?.id ?? null,
          organization?.id ?? null,
          ...by.params,
          limit,
        )
        .map(itemOf(kind))
    },
    find: ({ words, anyWord, accounts, limit }: DealSearch): Deal[] => {
      const wanted = [...new Set(words.map((word) => fold(word).trim()).filter(Boolean))]
      if (!wanted.length) return []
      const most = Math.min(Math.max(limit ?? 100, 1), 500)
      const within = accounts?.map(({ provider, account }) => `${provider}\u0000${account}`)
      // Titles are short and a CRM holds thousands, not millions: folding them here is cheaper than a word index.
      const found = DEAL_KINDS.flatMap((kind) =>
        database
          .prepare(
            `SELECT d.id, d.title, d.updated_at, a.provider, a.external_id AS account FROM ${TABLES[kind]} d ` +
              "LEFT JOIN accounts a ON a.id = d.account_id WHERE d.deleted_at IS NULL",
          )
          .all()
          .filter((row) => within === undefined || within.includes(`${row.provider}\u0000${row.account}`))
          .map((row) => {
            const title = fold(String(row.title))
            return { kind, row, score: wanted.filter((word) => title.includes(word)).length }
          })
          .filter(({ score }) => (anyWord ? score > 0 : score === wanted.length)),
      )
      return found
        .sort(
          (a, b) =>
            b.score - a.score ||
            Number(b.row.updated_at) - Number(a.row.updated_at) ||
            Number(b.row.id) - Number(a.row.id),
        )
        .slice(0, most)
        .map(({ kind, row }) => read(`${kind}:${row.id}`))
    },
    move: (reference: string, { stage, by }: { stage: string; by: Author }): Deal => {
      authorActor(context, by)
      const { kind, row } = rowOf(reference)
      notDeleted(row, kind, "moves")
      const next = stageRow(text(stage, "a stage's name", 80) ?? "", kind, Number(row.pipeline_id))
      write(database, () => setStage(kind, Number(row.id), next, next.outcome as DealStatus, today()))
      return read(`${kind}:${row.id}`)
    },
    close: (
      reference: string,
      { status, date, reason, by }: { status: Exclude<DealStatus, "open">; date?: string; reason?: string; by: Author },
    ): Deal => {
      authorActor(context, by)
      const outcome = oneOf(status, ["won", "lost"] as const, "a closed status")
      const day = isoDate(date, "the day it closed") ?? today()
      const why = text(reason, "why it closed", 2000)
      const { kind, row } = rowOf(reference)
      notDeleted(row, kind, "closes")
      const stage =
        database
          .prepare("SELECT * FROM pipeline_stages WHERE pipeline_id = ? AND outcome = ? ORDER BY position, id LIMIT 1")
          .get(Number(row.pipeline_id), outcome) ?? ({ id: row.stage_id } as Row)
      write(database, () => {
        setStage(kind, Number(row.id), stage, outcome, day)
        if (why !== null)
          database
            .prepare(
              `UPDATE ${TABLES[kind]} SET metadata = json_set(coalesce(metadata, '{}'), '$.closed_reason', ?) WHERE id = ?`,
            )
            .run(why, Number(row.id))
      })
      return read(`${kind}:${row.id}`)
    },
  }
}

export const dealsStoreOver = (context: StoreContext): DealsStore => {
  const operations = dealOperationsOver(context)
  return {
    addPipeline: async (input) => operations.addPipeline(input),
    pipelines: async (filter) => operations.pipelines(filter),
    pipeline: async (reference, options) => operations.pipeline(reference, options),
    add: async (input) => operations.add(input),
    get: async (reference) => operations.get(reference),
    list: async (filter) => operations.list(filter),
    find: async (search) => operations.find(search),
    move: async (reference, input) => operations.move(reference, input),
    close: async (reference, input) => operations.close(reference, input),
  }
}
