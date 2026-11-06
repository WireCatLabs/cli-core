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
import { FINANCE_REVIEWS, type FinanceReview } from "../../domain/finance.js"
import { currencyOf, formatDecimal, minorUnits, scaleOf } from "../../domain/money.js"
import { assertMayDecide, type Decider, deciderAuthor } from "../decisions.js"
import { fold } from "../normalize.js"
import { type ProposedByFilter, proposedBySql, proposerOf } from "./actors.js"
import { isoDate, oneOf, type Party, type Reviewed, refuse, reviewedRowsOver, text, type Written } from "./finance.js"
import { linkKind } from "./link-kinds.js"
import { type Author, authorActor, projectId } from "./memories.js"
import { requiredThing } from "./notes.js"
import type { StoreContext } from "./open.js"
import { write } from "./transaction.js"

export interface PipelineStage {
  name: string
  position: number
  /** What reaching it means: a CRM marks the stages that win or lose a deal. */
  outcome: StageOutcome
  /** Its id in the pipeline's CRM; `null` for the owner's own. */
  externalId: string | null
  /** Open deals standing in it, the owner's and agents' not rejected. */
  open: number
}

export interface Pipeline {
  name: string
  kind: DealKind
  /** The CRM account it was copied from; `null` for the owner's own. */
  account: { provider: string; account: string } | null
  externalId: string | null
  stages: PipelineStage[]
  createdAt: string
}

export interface DealPerson extends Party {
  role: DealRole
}

export interface Deal extends Reviewed {
  id: string
  /** `deal:<id>` or `lead:<id>`, as its kind is. */
  ref: string
  kind: DealKind
  title: string
  /** One line with stage, amount and status, as a list or the review inbox prints it. */
  summary: string
  pipeline: string
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
  /** Why it was won or lost, as the owner said when closing it. */
  closedReason: string | null
  people: DealPerson[]
  /** Its order in its stage's column on a board, lowest first; `null` sorts last. */
  rank: number | null
}

export interface DealInput extends Written {
  /** `deal` when left out; the stage is looked for in pipelines of this kind. */
  kind?: DealKind
  title: string
  /** A stage's name; `pipeline` names its pipeline when more than one has a stage of that name. */
  stage: string
  pipeline?: string
  organization?: string
  /** A decimal string in `currency`; give both or neither. */
  amount?: string
  currency?: string
  closeDate?: string
  people?: { person: string; role: DealRole }[]
}

export interface DealFilter {
  /** `deal` when left out. */
  kind?: DealKind
  status?: DealStatus
  /** A stage's or pipeline's name, in any letter case. */
  stage?: string
  pipeline?: string
  project?: string
  organization?: string
  review?: FinanceReview
  proposedBy?: ProposedByFilter
  /** 1–500, 100 by default; newest written first. */
  limit?: number
}

/**
 * The owner's sales pipelines and the deals in them. The owner's deal is confirmed at once; an agent's waits as
 * proposed for him, and only he decides it. Only the owner makes a pipeline, moves a deal or closes it.
 */
export interface DealsStore {
  /** A pipeline of the owner's own, of deals unless `kind` says leads; a stage's outcome is `open` when left out. */
  addPipeline(input: {
    name: string
    kind?: DealKind
    stages: (string | { name: string; outcome?: StageOutcome })[]
    by: Author
  }): Promise<Pipeline>
  pipelines(): Promise<Pipeline[]>
  add(input: DealInput): Promise<Deal>
  get(reference: string): Promise<Deal>
  list(filter?: DealFilter): Promise<Deal[]>
  /** To another stage of the deal's own pipeline. */
  move(reference: string, input: { stage: string; by: Author }): Promise<Deal>
  /** `date` is the day it closed, today when left out. */
  close(
    reference: string,
    input: { status: Exclude<DealStatus, "open">; date?: string; reason?: string; by: Author },
  ): Promise<Deal>
  confirm(reference: string, by: Decider, reason?: string): Promise<Deal>
  reject(reference: string, by: Decider, reason?: string): Promise<Deal>
}

type Row = Record<string, unknown>

const DEALS =
  "SELECT d.*, s.name AS stage_name, s.pipeline_id, p.name AS pipeline_name, b.name AS author_name, " +
  "b.kind AS author_kind FROM opportunities d JOIN pipeline_stages s ON s.id = d.stage_id " +
  "JOIN pipelines p ON p.id = s.pipeline_id LEFT JOIN bots b ON d.author_type = 'bot' AND b.id = d.author_id"

const MAX_STAGES = 20
const MAX_PEOPLE = 20

const ownerOnly = (by: Author, what: string) => {
  if (by !== "owner") refuse(`only the owner ${what}`, "deal.owner-only", "permission_error")
}

type DealOperations = {
  [K in keyof DealsStore]: DealsStore[K] extends (...args: infer A) => Promise<infer R> ? (...args: A) => R : never
}

export const dealOperationsOver = (context: StoreContext): DealOperations => {
  const { database, now } = context
  const { partyOf, partyThing, reviewedOf, written, keepEvidence, keepDecision } = reviewedRowsOver(context)

  const closedReasonOf = (metadata: unknown): string | null => {
    if (metadata == null) return null
    try {
      const { closed_reason } = JSON.parse(String(metadata)) as { closed_reason?: unknown }
      return typeof closed_reason === "string" ? closed_reason : null
    } catch {
      return null
    }
  }

  const peopleOf = (kind: DealKind, id: number): DealPerson[] =>
    database
      .prepare(
        `SELECT to_id, role FROM links WHERE from_type = ? AND from_id = ? AND kind = ${linkKind("related-to")} ` +
          "AND to_type = 'person' AND to_id IS NOT NULL ORDER BY id",
      )
      .all(kind, id)
      .map((row) => ({ ...(partyOf("person", row.to_id) as Party), role: row.role as DealRole }))

  const dealOf = (row: Row): Deal => {
    const kind = row.kind as DealKind
    const currency = row.currency == null ? null : String(row.currency)
    const amount = row.amount == null || currency === null ? null : Number(row.amount)
    const fields = {
      id: Number(row.id),
      title: String(row.title),
      stage: String(row.stage_name),
      amount,
      currency,
      status: row.status as DealStatus,
      review: row.review as FinanceReview,
    }
    return {
      id: String(row.id),
      ref: `${kind}:${row.id}`,
      kind,
      title: fields.title,
      summary: dealLine(fields),
      pipeline: String(row.pipeline_name),
      stage: fields.stage,
      status: fields.status,
      organization: partyOf(row.organization_id == null ? null : "organization", row.organization_id),
      currency,
      amount: amount === null || currency === null ? null : formatDecimal(amount, scaleOf(currency)),
      closeDate: row.close_date == null ? null : String(row.close_date),
      closedDate: row.closed_date == null ? null : String(row.closed_date),
      closedReason: closedReasonOf(row.metadata),
      people: peopleOf(kind, fields.id),
      rank: row.rank == null ? null : Number(row.rank),
      ...reviewedOf(row, kind),
    }
  }

  const rowOf = (reference: string): Row => {
    const thing = requiredThing(database, reference.includes(":") ? reference : `deal:${reference}`, "the deal")
    if (thing.type !== "deal" && thing.type !== "lead") return refuse(`${reference} is not a deal`, "deal.ref")
    return database.prepare(`${DEALS} WHERE d.id = ?`).get(thing.id) as Row
  }

  /** CRM accounts may each have a pipeline of the owner's name, so a name that is not unique is refused, never picked. */
  const pipelineNamed = (name: string, kind: DealKind): number => {
    const found = database
      .prepare("SELECT id FROM pipelines WHERE name_folded = ? AND kind = ?")
      .all(fold(name.trim()), kind)
    if (found.length === 0)
      throw new CliError("not_found", `no pipeline named ${name}`, { reason: "pipeline.not-found" })
    if (found.length > 1) return refuse(`more than one pipeline is named ${name}`, "pipeline.ambiguous")
    return Number(found[0]?.id)
  }

  /** A stage by name, in one pipeline when it is named, else in the only pipeline of the kind that has one. */
  const stageNamed = (stage: string, pipeline: string | number | undefined, kind: DealKind): number => {
    const within = typeof pipeline === "string" ? pipelineNamed(pipeline, kind) : (pipeline ?? null)
    const rows = database
      .prepare(
        "SELECT s.id FROM pipeline_stages s JOIN pipelines p ON p.id = s.pipeline_id WHERE s.name_folded = ? " +
          "AND p.kind = ? AND (? IS NULL OR s.pipeline_id = ?)",
      )
      .all(fold(stage.trim()), kind, within, within)
    if (rows.length === 0)
      return refuse(`no stage named ${stage}${within === null ? "" : " in that pipeline"}`, "deal.stage")
    if (rows.length > 1)
      return refuse(`more than one pipeline has a stage named ${stage}; name the pipeline`, "deal.stage")
    return Number(rows[0]?.id)
  }

  const pipelinesOf = (id?: number): Pipeline[] => {
    const only = id ?? null
    const stages = database
      .prepare(
        "SELECT s.pipeline_id, s.name, s.position, s.outcome, s.external_id, (SELECT count(*) FROM opportunities d " +
          "WHERE d.stage_id = s.id AND d.status = 'open' AND d.review <> 'rejected' AND d.deleted_at IS NULL) AS open " +
          "FROM pipeline_stages s WHERE ? IS NULL OR s.pipeline_id = ? ORDER BY s.pipeline_id, s.position, s.id",
      )
      .all(only, only)
    return database
      .prepare(
        "SELECT p.id, p.name, p.kind, p.external_id, p.created_at, a.provider, a.external_id AS account " +
          "FROM pipelines p LEFT JOIN accounts a ON a.id = p.account_id WHERE ? IS NULL OR p.id = ? " +
          "ORDER BY p.account_id IS NOT NULL, p.name_folded, p.id",
      )
      .all(only, only)
      .map((pipeline) => ({
        name: String(pipeline.name),
        kind: pipeline.kind as DealKind,
        account:
          pipeline.provider == null ? null : { provider: String(pipeline.provider), account: String(pipeline.account) },
        externalId: pipeline.external_id == null ? null : String(pipeline.external_id),
        stages: stages
          .filter((stage) => stage.pipeline_id === pipeline.id)
          .map((stage) => ({
            name: String(stage.name),
            position: Number(stage.position),
            outcome: stage.outcome as StageOutcome,
            externalId: stage.external_id == null ? null : String(stage.external_id),
            open: Number(stage.open),
          })),
        createdAt: new Date(Number(pipeline.created_at)).toISOString(),
      }))
  }

  const stillOpen = (row: Row, what: string) => {
    if (row.status !== "open" || row.review === "rejected" || row.deleted_at != null)
      refuse(
        `${String(row.kind)}:${row.id} is ${row.deleted_at != null ? "deleted" : row.review === "rejected" ? "rejected" : String(row.status)}; it no longer ${what}`,
        "deal.closed",
      )
  }

  const decide = (reference: string, by: Decider, reason: string | undefined, confirm: boolean): Deal => {
    const row = rowOf(reference)
    const ref = `${String(row.kind)}:${row.id}`
    assertMayDecide(
      { id: ref, proposedBy: proposerOf(database, row.author_type, row.author_id), ownerOnly: true },
      by,
      context.decisions,
    )
    if (row.review !== "proposed") refuse(`${ref} is already ${String(row.review)}`, "proposal.wrong-state")
    write(database, () => {
      if (confirm) {
        const { actor } = authorActor(context, deciderAuthor(by))
        database
          .prepare(
            "UPDATE opportunities SET review = 'confirmed', confirmed_by_type = ?, confirmed_by_id = ?, updated_at = ? " +
              "WHERE id = ?",
          )
          .run(actor.type, actor.id, now(), Number(row.id))
      } else
        database
          .prepare("UPDATE opportunities SET review = 'rejected', updated_at = ? WHERE id = ?")
          .run(now(), Number(row.id))
      keepDecision("opportunities", Number(row.id), by, reason)
    })
    return dealOf(rowOf(ref))
  }

  return {
    addPipeline: ({ name, kind = "deal", stages, by }) => {
      ownerOnly(by, "makes a pipeline")
      const named = text(name, "a pipeline's name", 80) ?? refuse("a pipeline needs a name", "pipeline.field")
      const holds = oneOf(kind, DEAL_KINDS, "a pipeline's kind")
      if (!Array.isArray(stages) || stages.length === 0 || stages.length > MAX_STAGES)
        refuse(`a pipeline has 1–${MAX_STAGES} stages`, "pipeline.field")
      const kept = stages.map((stage) => {
        const one = typeof stage === "string" ? { name: stage } : stage
        return {
          name: text(one.name, "a stage's name", 80) as string,
          outcome: oneOf(one.outcome ?? "open", STAGE_OUTCOMES, "a stage's outcome"),
        }
      })
      if (new Set(kept.map((stage) => fold(stage.name))).size !== kept.length)
        refuse("each stage is named once", "pipeline.field")
      const id = write(database, () => {
        if (
          database
            .prepare("SELECT 1 FROM pipelines WHERE name_folded = ? AND kind = ? AND account_id IS NULL")
            .get(fold(named), holds)
        )
          refuse(`a pipeline named ${named} is already stored`, "pipeline.duplicate")
        const at = now()
        const made = Number(
          database
            .prepare(
              "INSERT INTO pipelines (kind, name, name_folded, created_at, updated_at) VALUES (?, ?, ?, ?, ?) RETURNING id",
            )
            .get(holds, named, fold(named), at, at)?.id,
        )
        const insert = database.prepare(
          "INSERT INTO pipeline_stages (pipeline_id, name, name_folded, position, outcome, created_at, updated_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        kept.forEach((stage, at_) => {
          insert.run(made, stage.name, fold(stage.name), at_ + 1, stage.outcome, at, at)
        })
        return made
      })
      return pipelinesOf(id)[0] as Pipeline
    },
    pipelines: () => pipelinesOf(),
    add: (input) => {
      const title = text(input.title, "a deal's title", 200) ?? refuse("a deal needs a title", "deal.field")
      const stageText = text(input.stage, "a stage's name", 80) ?? refuse("a deal starts in a stage", "deal.field")
      if ((input.amount === undefined) !== (input.currency === undefined))
        refuse("a deal's amount and currency come together", "deal.field")
      const currency = input.currency === undefined ? null : currencyOf(input.currency)
      const amount = currency === null ? null : minorUnits(input.amount as string, currency, "a deal's amount")
      if (amount !== null && amount < 0) refuse("a deal's amount is 0 or more", "money.amount")
      const closeDate = isoDate(input.closeDate, "a deal's close date")
      const people = input.people ?? []
      if (people.length > MAX_PEOPLE) refuse(`a deal names at most ${MAX_PEOPLE} people`, "deal.field")
      const kind = oneOf(input.kind ?? "deal", DEAL_KINDS, "a deal's kind")
      const id = write(database, () => {
        const stage = stageNamed(stageText, input.pipeline, kind)
        const organization = partyThing(input.organization, "the organization")
        if (organization !== undefined && organization.type !== "organization")
          refuse(`the organization is an organization: reference, not ${input.organization}`, "deal.field")
        const persons = people.map(({ person, role }) => {
          const thing = requiredThing(database, person, "the person")
          if (thing.type !== "person") return refuse(`${person} is not a person`, "deal.field")
          return { id: thing.id, role: oneOf(role, DEAL_ROLES, "a person's role on a deal") }
        })
        const by = written(input)
        const at = now()
        const made = Number(
          database
            .prepare(
              "INSERT INTO opportunities (kind, title, organization_id, project_id, stage_id, status, currency, amount, " +
                "close_date, review, author_type, author_id, model, confirmed_by_type, confirmed_by_id, source, metadata, " +
                "created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
            )
            .get(
              kind,
              title,
              organization?.id ?? null,
              by.project,
              stage,
              currency,
              amount,
              closeDate,
              by.review,
              by.actor.type,
              by.actor.id,
              by.model,
              by.confirmedType,
              by.confirmedId,
              by.source,
              by.metadata,
              at,
              at,
            )?.id,
        )
        const link = database.prepare(
          "INSERT INTO links (from_type, from_id, to_type, to_id, kind, role, source, confirmed, created_at, author, " +
            `updated_at) VALUES (?, ?, 'person', ?, ${linkKind("related-to")}, ?, ?, 1, ?, ?, ?)`,
        )
        for (const person of persons)
          link.run(
            kind,
            made,
            person.id,
            person.role,
            by.owner ? "owner" : "suggested",
            at,
            by.owner ? "owner" : "agent",
            at,
          )
        keepEvidence(kind, made, by)
        return made
      })
      return dealOf(rowOf(`${kind}:${id}`))
    },
    get: (reference) => dealOf(rowOf(reference)),
    list: (filter = {}) => {
      const kind = oneOf(filter.kind ?? "deal", DEAL_KINDS, "a deal's kind")
      const project = filter.project === undefined ? null : projectId(database, filter.project)
      const organization = partyThing(filter.organization, "the organization")
      const by = proposedBySql("d.author_type", "d.author_id", filter.proposedBy)
      const status = filter.status === undefined ? null : oneOf(filter.status, DEAL_STATUSES, "a deal's status")
      const review = filter.review === undefined ? null : oneOf(filter.review, FINANCE_REVIEWS, "a review")
      const stage = filter.stage === undefined ? null : fold(filter.stage.trim())
      const pipeline = filter.pipeline === undefined ? null : fold(filter.pipeline.trim())
      const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500)
      return database
        .prepare(
          `${DEALS} WHERE d.deleted_at IS NULL AND d.kind = ? AND (? IS NULL OR d.status = ?) AND (? IS NULL OR d.review = ?) ` +
            "AND (? IS NULL OR d.project_id = ?) AND (? IS NULL OR s.name_folded = ?) AND (? IS NULL OR p.name_folded = ?) " +
            `AND (? IS NULL OR d.organization_id = ?) AND ${by.sql} ORDER BY d.created_at DESC, d.id DESC LIMIT ?`,
        )
        .all(
          kind,
          status,
          status,
          review,
          review,
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
        .map(dealOf)
    },
    move: (reference, { stage, by }) => {
      ownerOnly(by, "moves a deal")
      const row = rowOf(reference)
      stillOpen(row, "moves")
      const next = stageNamed(text(stage, "a stage's name", 80) ?? "", Number(row.pipeline_id), row.kind as DealKind)
      write(database, () => {
        database
          .prepare("UPDATE opportunities SET stage_id = ?, updated_at = ? WHERE id = ?")
          .run(next, now(), Number(row.id))
      })
      return dealOf(rowOf(`${String(row.kind)}:${row.id}`))
    },
    close: (reference, { status, date, reason, by }) => {
      ownerOnly(by, "closes a deal")
      const outcome = oneOf(status, ["won", "lost"] as const, "a closed deal's status")
      const day = isoDate(date, "the day a deal closed") ?? new Date(now()).toISOString().slice(0, 10)
      const why = text(reason, "why a deal closed", 2000)
      const row = rowOf(reference)
      stillOpen(row, "closes")
      write(database, () => {
        database
          .prepare(
            "UPDATE opportunities SET status = ?, closed_date = ?, updated_at = ?, metadata = CASE WHEN ? IS NULL " +
              "THEN metadata ELSE json_set(coalesce(metadata, '{}'), '$.closed_reason', ?) END WHERE id = ?",
          )
          .run(outcome, day, now(), why, why, Number(row.id))
      })
      return dealOf(rowOf(`${String(row.kind)}:${row.id}`))
    },
    confirm: (reference, by, reason) => decide(reference, by, reason, true),
    reject: (reference, by, reason) => decide(reference, by, reason, false),
  }
}

export const dealsStoreOver = (context: StoreContext): DealsStore => {
  const operations = dealOperationsOver(context)
  return {
    addPipeline: async (input) => operations.addPipeline(input),
    pipelines: async () => operations.pipelines(),
    add: async (input) => operations.add(input),
    get: async (reference) => operations.get(reference),
    list: async (filter) => operations.list(filter),
    move: async (reference, input) => operations.move(reference, input),
    close: async (reference, input) => operations.close(reference, input),
    confirm: async (reference, by, reason) => operations.confirm(reference, by, reason),
    reject: async (reference, by, reason) => operations.reject(reference, by, reason),
  }
}
